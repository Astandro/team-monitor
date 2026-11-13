/**
 * HTTP layer for the team monitor: Host checks, remote-mode login, the
 * `/api/team/*` endpoints, and a fallback to the upstream handler (graph SSE
 * on /events and the static UI).
 */
import type * as http from 'http'
import { isLoopbackHost } from '../../../extension/src/request-guard'
import { AnswerError, parseAnswerBody, writeAnswer } from './answers'
import { ChatError, MAX_MESSAGE_BODY_BYTES, MessageLimiter, parseMessageBody, writeInboxMessage } from './chat'
import {
  MAX_OFFBOARD_BODY_BYTES, OffboardError, OffboardStore, SESSION_ID_RE,
  offboardAgent, offboardFinished, parseOffboardAllBody, parseOffboardBody,
} from './offboard'
import type { GraphView } from '../../../scripts/graph-agents'
import { LoginLimiter, SESSION_COOKIE, SESSION_TTL_MS, SessionStore, parseCookies, sessionKey, tokenMatches } from './auth'
import { hasState, ProjectEntry } from './config'
import { isAllowedRemoteHost, RemoteConfig } from './remote'
import { TeamSnapshot, TeamStateWatcher } from './state-watcher'
import type { StatusOptions } from './heartbeat'
import { coordinatorFromState, titleFromState, type WatchedProject } from '../../../scripts/session-projects'

export const MAX_ANSWER_BODY_BYTES = 16 * 1024
const MAX_LOGIN_BODY_BYTES = 4 * 1024
const SSE_KEEPALIVE_MS = 25_000

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

// ─── Projects and watchers ──────────────────────────────────────────────────

export class TeamService {
  private watchers = new Map<string, TeamStateWatcher>()
  private sseClients = new Set<http.ServerResponse>()
  private disposers: Array<() => void> = []
  /** Offboarded agents (set by setupTeam); null = offboarding endpoints answer 503. */
  offboard: OffboardStore | null = null
  /** The relay's view of the graph, attached once the relay runs (server.ts); null = offboarding answers 503. */
  graph: GraphView | null = null
  /** Chat messages accepted per minute, across all projects (spec-chat: 429 above 20). */
  messageLimiter = new MessageLimiter()

  constructor(
    readonly projects: ProjectEntry[],
    opts: { debounceMs?: number; pollMs?: number; log?: (msg: string) => void; heartbeat?: StatusOptions } = {},
  ) {
    for (const p of projects) {
      const w = new TeamStateWatcher({ projectId: p.id, projectPath: p.path, ...opts })
      w.start()
      this.watchers.set(p.id, w)
    }
  }

  watcher(id: string): TeamStateWatcher | undefined {
    return this.watchers.get(id)
  }

  list() {
    return this.projects.map((p) => ({ id: p.id, name: p.name, hasState: hasState(p.path) }))
  }

  /** The projects the graph follows, with each one's current `meta.title` (spec graph-theme items 3-4). */
  graphProjects(): WatchedProject[] {
    return this.projects.map((p) => ({
      id: p.id, name: p.name, path: p.path,
      title: titleFromState(this.watchers.get(p.id)?.rawState()),
      coordinator: coordinatorFromState(this.watchers.get(p.id)?.rawState()),
    }))
  }

  trackSSE(res: http.ServerResponse): () => void {
    this.sseClients.add(res)
    return () => { this.sseClients.delete(res) }
  }

  onDispose(fn: () => void): void {
    this.disposers.push(fn)
  }

  dispose(): void {
    for (const fn of this.disposers.splice(0)) { try { fn() } catch { /* keep going */ } }
    for (const w of this.watchers.values()) w.dispose()
    for (const res of this.sseClients) { try { res.end() } catch { /* closed */ } }
    this.sseClients.clear()
  }
}

// ─── Access control ─────────────────────────────────────────────────────────

export interface RemoteAccess {
  config: RemoteConfig
  token: string
  sessions: SessionStore
  limiter: LoginLimiter
}

export interface HandlerOptions {
  team: TeamService
  /** null = default mode: loopback Host only, no login (upstream behaviour). */
  remote: RemoteAccess | null
  fallback: Handler
  /** How often open responses of expired sessions are closed (default 60 s). */
  sessionSweepMs?: number
  /** Server-side log for error details (default console.error). */
  log?: (msg: string) => void
}

/**
 * Open responses per session (keyed by the session's hash), so logout and
 * expiry can close that session's SSE streams (`/events`, `/api/team/events`).
 */
export class SessionStreams {
  private byKey = new Map<string, Set<http.ServerResponse>>()

  add(key: string, res: http.ServerResponse): void {
    let set = this.byKey.get(key)
    if (!set) { set = new Set(); this.byKey.set(key, set) }
    set.add(res)
    res.on('close', () => {
      set!.delete(res)
      if (set!.size === 0 && this.byKey.get(key) === set) this.byKey.delete(key)
    })
  }

  closeKey(key: string): void {
    const set = this.byKey.get(key)
    if (!set) return
    this.byKey.delete(key)
    for (const res of set) { try { res.end() } catch { /* closed */ } ; res.socket?.destroy() }
  }

  /** Close the streams of every session that is no longer valid. */
  sweep(isValidKey: (key: string) => boolean): void {
    for (const key of [...this.byKey.keys()]) if (!isValidKey(key)) this.closeKey(key)
  }

  count(): number {
    let n = 0
    for (const s of this.byKey.values()) n += s.size
    return n
  }
}

const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login']

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * A request typed on this machine: loopback socket, loopback Host, and not
 * relayed by a proxy (`tailscale serve` connects from loopback but adds
 * X-Forwarded-* headers and keeps the MagicDNS Host).
 */
export function isLocalRequest(req: http.IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  if (!isLoopbackHost(req.headers.host)) return false
  return !FORWARD_HEADERS.some((h) => req.headers[h] !== undefined)
}

/** True when the browser reached us over https (directly or via a loopback proxy). */
export function isHttpsRequest(req: http.IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true
  const proto = req.headers['x-forwarded-proto']
  return isLoopbackAddress(req.socket.remoteAddress) && typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https'
}

export function ownOrigin(req: http.IncomingMessage): string {
  return `${isHttpsRequest(req) ? 'https' : 'http'}://${String(req.headers.host ?? '').toLowerCase()}`
}

/** Origin and Sec-Fetch-Site checks for state-changing requests. */
export function isSameOriginRequest(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin !== undefined && origin.toLowerCase() !== ownOrigin(req)) return false
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin') return false
  return true
}

function sessionId(req: http.IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE]
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
}

function sendJSON(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra })
  res.end(JSON.stringify(body))
}

function sendError(res: http.ServerResponse, status: number, error: string, extra: Record<string, string> = {}): void {
  sendJSON(res, status, { ok: false, error }, extra)
}

class BodyError extends Error {}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) { reject(new BodyError('body too large')); return }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > limit) { done = true; reject(new BodyError('body too large')); return }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf-8')) } })
    req.on('error', (e) => { if (!done) { done = true; reject(e) } })
  })
}

/** After an early reply, drop the rest of the upload without keeping the socket. */
function closeAfter(res: http.ServerResponse): void {
  res.setHeader('Connection', 'close')
}

function mediaType(req: http.IncomingMessage): string {
  return String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
}

// ─── Handler ────────────────────────────────────────────────────────────────

export function createRequestHandler(opts: HandlerOptions): Handler {
  const { team, remote, fallback } = opts
  const log = opts.log ?? console.error
  const streams = new SessionStreams()
  if (remote) {
    const sweep = setInterval(() => streams.sweep((k) => remote.sessions.isValidKey(k)), opts.sessionSweepMs ?? 60_000)
    sweep.unref?.()
    team.onDispose(() => clearInterval(sweep))
  }

  return (req, res) => {
    const hostOk = remote ? isAllowedRemoteHost(req.headers.host, remote.config) : isLoopbackHost(req.headers.host)
    if (!hostOk) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }

    let pathname: string
    let query: URLSearchParams
    try {
      const u = new URL(req.url || '/', 'http://localhost')
      pathname = u.pathname
      query = u.searchParams
    } catch {
      res.writeHead(400)
      res.end('Bad request')
      return
    }

    if (remote) {
      if (pathname === '/login') return void handleLogin(req, res, remote)
      if (pathname === '/logout') return void handleLogout(req, res, remote, streams)
      if (!isLocalRequest(req)) {
        const sid = sessionId(req)
        if (!remote.sessions.isValid(sid)) {
          const wantsHtml = (req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept ?? '').includes('text/html')
          if (wantsHtml) {
            res.writeHead(302, { Location: '/login', ...SECURITY_HEADERS })
            res.end()
          } else {
            sendError(res, 401, 'login required')
          }
          return
        }
        // Tracked until the response closes, so logout/expiry can end open streams.
        streams.add(sessionKey(sid!), res)
      }
    }

    if (pathname.startsWith('/api/team/')) return void handleTeamApi(req, res, pathname, query, team, log)
    fallback(req, res)
  }
}

async function handleTeamApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams,
  team: TeamService,
  log: (msg: string) => void,
): Promise<void> {
  const route = pathname.slice('/api/team/'.length)

  if (route === 'answer') {
    if (req.method !== 'POST') return sendError(res, 405, 'method not allowed', { Allow: 'POST' })
    return handleAnswer(req, res, team, log)
  }

  if (route === 'message') {
    if (req.method !== 'POST') return sendError(res, 405, 'method not allowed', { Allow: 'POST' })
    return handleMessage(req, res, team, log)
  }

  if (route === 'offboard' || route === 'offboard-all') {
    if (req.method !== 'POST') return sendError(res, 405, 'method not allowed', { Allow: 'POST' })
    return handleOffboard(req, res, team, route === 'offboard-all', log)
  }

  if (req.method !== 'GET') return sendError(res, 405, 'method not allowed', { Allow: 'GET' })

  if (route === 'projects') return sendJSON(res, 200, { projects: team.list() })
  if (route === 'offboarded') return handleOffboardedList(res, query, team)

  if (route === 'state' || route === 'events') {
    const id = query.get('project') ?? ''
    const w = team.watcher(id)
    if (!w) return sendError(res, 404, 'unknown project')
    if (route === 'state') return sendJSON(res, 200, w.snapshot())
    return streamTeamEvents(req, res, w, team)
  }

  sendError(res, 404, 'not found')
}

function streamTeamEvents(req: http.IncomingMessage, res: http.ServerResponse, w: TeamStateWatcher, team: TeamService): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  })
  const send = (snap: TeamSnapshot) => {
    res.write(`data: ${JSON.stringify({
      type: 'team_state', project: snap.project, state: snap.state, error: snap.error, updatedAt: snap.updatedAt,
      chat: snap.chat, watcher: snap.watcher,
    })}\n\n`)
  }
  send(w.snapshot())
  const unsubscribe = w.onChange(send)
  const untrack = team.trackSSE(res)
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), SSE_KEEPALIVE_MS)
  keepalive.unref?.()
  const close = () => { clearInterval(keepalive); unsubscribe(); untrack() }
  req.on('close', close)
  res.on('close', close)
}

/**
 * Checks shared by every state-changing team request (answers, chat messages, offboarding): `X-Team-Monitor: 1`, same origin,
 * JSON media type, size limit, valid JSON. Replies and returns null on failure.
 */
async function readWriteRequest(req: http.IncomingMessage, res: http.ServerResponse, limit: number): Promise<{ body: unknown } | null> {
  if (req.headers['x-team-monitor'] !== '1') { closeAfter(res); sendError(res, 403, 'missing X-Team-Monitor header'); return null }
  if (!isSameOriginRequest(req)) { closeAfter(res); sendError(res, 403, 'cross-origin request refused'); return null }
  if (mediaType(req) !== 'application/json') { closeAfter(res); sendError(res, 400, 'Content-Type must be application/json'); return null }

  let text: string
  try {
    text = await readBody(req, limit)
  } catch {
    closeAfter(res)
    sendError(res, 400, `body larger than ${limit} bytes`)
    return null
  }

  try { return { body: JSON.parse(text) } } catch { sendError(res, 400, 'body is not valid JSON'); return null }
}

async function handleAnswer(req: http.IncomingMessage, res: http.ServerResponse, team: TeamService, log: (msg: string) => void): Promise<void> {
  const read = await readWriteRequest(req, res, MAX_ANSWER_BODY_BYTES)
  if (!read) return
  const body = read.body

  try {
    const input = parseAnswerBody(body)
    const w = team.watcher(input.project)
    if (!w) return sendError(res, 404, 'unknown project')
    w.refresh()
    const { answeredAt } = writeAnswer(w.rawState(), w.answersDir, input.id, input.answer)
    w.refresh()
    sendJSON(res, 200, { ok: true, answeredAt })
  } catch (e) {
    if (e instanceof AnswerError) {
      if (e.detail) log(`[team] answer refused (${e.status}): ${e.detail}`)
      return sendError(res, e.status, e.message)
    }
    log(`[team] answer failed: ${(e as Error)?.stack ?? String(e)}`)
    sendError(res, 500, 'internal error')
  }
}

// ─── Chat (spec-chat) ───────────────────────────────────────────────────────

async function handleMessage(req: http.IncomingMessage, res: http.ServerResponse, team: TeamService, log: (msg: string) => void): Promise<void> {
  const read = await readWriteRequest(req, res, MAX_MESSAGE_BODY_BYTES)
  if (!read) return
  try {
    const input = parseMessageBody(read.body)
    const w = team.watcher(input.project)
    if (!w) return sendError(res, 404, 'unknown project')
    const wait = team.messageLimiter.retryAfter()
    if (wait > 0) return sendError(res, 429, 'too many messages, try again shortly', { 'Retry-After': String(wait) })
    const { id, sentAt } = writeInboxMessage(w.inboxDir, input.text)
    team.messageLimiter.record()
    w.refresh()
    sendJSON(res, 200, { ok: true, id, sentAt })
  } catch (e) {
    if (e instanceof ChatError) {
      if (e.detail) log(`[team] message refused (${e.status}): ${e.detail}`)
      return sendError(res, e.status, e.message)
    }
    log(`[team] message failed: ${(e as Error)?.stack ?? String(e)}`)
    sendError(res, 500, 'internal error')
  }
}

// ─── Offboarding (spec offboard-names item 1) ───────────────────────────────

async function handleOffboard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  team: TeamService,
  all: boolean,
  log: (msg: string) => void,
): Promise<void> {
  const read = await readWriteRequest(req, res, MAX_OFFBOARD_BODY_BYTES)
  if (!read) return
  try {
    if (!team.offboard) throw new OffboardError(503, 'offboarding is not available')
    if (all) {
      const { session } = parseOffboardAllBody(read.body)
      const records = offboardFinished(team.offboard, team.graph, session)
      return sendJSON(res, 200, { ok: true, offboarded: records })
    }
    const input = parseOffboardBody(read.body)
    const { record, created } = offboardAgent(team.offboard, team.graph, input)
    sendJSON(res, 200, { ok: true, offboarded: [record], alreadyOffboarded: !created })
  } catch (e) {
    if (e instanceof OffboardError) {
      if (e.detail) log(`[team] offboard refused (${e.status}): ${e.detail}`)
      return sendError(res, e.status, e.message)
    }
    log(`[team] offboard failed: ${(e as Error)?.stack ?? String(e)}`)
    sendError(res, 500, 'internal error')
  }
}

function handleOffboardedList(res: http.ServerResponse, query: URLSearchParams, team: TeamService): void {
  const project = query.get('project')
  const session = query.get('session')
  if (project !== null && !team.watcher(project)) return sendError(res, 404, 'unknown project')
  if (session !== null && !SESSION_ID_RE.test(session)) return sendError(res, 400, 'session must be a session id')
  const filter = { ...(project !== null ? { project } : {}), ...(session !== null ? { session } : {}) }
  sendJSON(res, 200, { offboarded: team.offboard ? team.offboard.list(filter) : [] })
}

// ─── Login ──────────────────────────────────────────────────────────────────

function loginPage(message: string | null): string {
  const msg = message ? `<p class="err" role="alert">${message}</p>` : ''
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Masuk ke monitor tim</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f4ef; --fg: #1d1c1a; --line: #c9c4b8; --err: #a32020; }
  @media (prefers-color-scheme: dark) { :root { --bg: #151514; --fg: #ecebe7; --line: #4a4843; --err: #ff8a80; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; margin: 0 auto; padding: 3rem 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  label { display: block; margin-bottom: .5rem; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: .75rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
  button { margin-top: 1rem; width: 100%; font: inherit; padding: .75rem; border-radius: 6px; border: 0; background: var(--fg); color: var(--bg); }
  .err { color: var(--err); }
</style>
</head>
<body>
<main>
  <h1>Masuk ke monitor tim</h1>
  ${msg}
  <form method="post" action="/login">
    <label for="token">Token akses (ada di file token di folder ~/.team-monitor)</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Masuk</button>
  </form>
</main>
</body>
</html>`
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  // Not 'no-referrer': with it, browsers send `Origin: null` on the login form POST, which the same-origin check
  // refuses (seen on Chrome over tailscale serve). 'same-origin' still sends no referrer to other sites.
  'Referrer-Policy': 'same-origin',
  ...SECURITY_HEADERS,
}

/**
 * Key for the failed-login limit (review TM-S-06).
 *
 * - Direct connection (`--bind tailscale`): the socket address. The client
 *   cannot choose it.
 * - Through `tailscale serve` (loopback socket): the LAST X-Forwarded-For
 *   entry. A proxy adds the peer it saw at the end, so whether serve appends
 *   or overwrites, the last entry is the value serve set (the phone's tailnet
 *   IP); entries a client sends itself come before it. Only a process on this
 *   Mac can forge the last entry, and it can already reach the server without
 *   logging in.
 * - Loopback without the header: the socket address.
 */
export function clientKey(req: http.IncomingMessage): string {
  const addr = req.socket.remoteAddress ?? 'unknown'
  const fwd = req.headers['x-forwarded-for']
  if (isLoopbackAddress(addr) && typeof fwd === 'string') {
    const last = fwd.split(',').map((s) => s.trim()).filter(Boolean).pop()
    if (last) return `fwd:${last}`
  }
  return addr
}

function cookie(value: string, maxAgeS: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`
}

async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse, remote: RemoteAccess): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.writeHead(200, PAGE_HEADERS)
    res.end(req.method === 'HEAD' ? undefined : loginPage(null))
    return
  }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, POST' }); res.end(); return }

  if (!isSameOriginRequest(req)) { closeAfter(res); return sendError(res, 403, 'cross-origin request refused') }

  const client = clientKey(req)
  const wait = remote.limiter.retryAfter(client)
  if (wait > 0) {
    closeAfter(res)
    res.writeHead(429, { ...PAGE_HEADERS, 'Retry-After': String(wait) })
    res.end(loginPage('Terlalu banyak percobaan gagal. Coba lagi nanti.'))
    return
  }

  let token = ''
  try {
    const text = await readBody(req, MAX_LOGIN_BODY_BYTES)
    const type = mediaType(req)
    if (type === 'application/json') {
      const parsed = JSON.parse(text) as { token?: unknown }
      token = typeof parsed.token === 'string' ? parsed.token : ''
    } else if (type === 'application/x-www-form-urlencoded') {
      token = new URLSearchParams(text).get('token') ?? ''
    }
  } catch {
    closeAfter(res)
    res.writeHead(400, PAGE_HEADERS)
    res.end(loginPage('Permintaan tidak valid.'))
    return
  }

  if (!token || !tokenMatches(token.trim(), remote.token)) {
    remote.limiter.fail(client)
    res.writeHead(401, PAGE_HEADERS)
    res.end(loginPage('Token salah.'))
    return
  }

  remote.limiter.succeed(client)
  const id = remote.sessions.create()
  res.writeHead(303, {
    Location: '/',
    'Set-Cookie': cookie(id, Math.floor(SESSION_TTL_MS / 1000), isHttpsRequest(req)),
    ...SECURITY_HEADERS,
  })
  res.end()
}

function handleLogout(req: http.IncomingMessage, res: http.ServerResponse, remote: RemoteAccess, streams: SessionStreams): void {
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return }
  if (!isSameOriginRequest(req)) return sendError(res, 403, 'cross-origin request refused')
  const sid = sessionId(req)
  remote.sessions.destroy(sid)
  if (sid) streams.closeKey(sessionKey(sid))
  res.writeHead(303, { Location: '/login', 'Set-Cookie': cookie('', 0, isHttpsRequest(req)), ...SECURITY_HEADERS })
  res.end()
}
