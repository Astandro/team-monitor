/**
 * HTTP layer for the team monitor: Host checks, remote-mode login, the
 * `/api/team/*` endpoints, and a fallback to the upstream handler (graph SSE
 * on /events and the static UI).
 */
import type * as http from 'http'
import { isLoopbackHost } from '../../../extension/src/request-guard'
import { AnswerError, parseAnswerBody, writeAnswer } from './answers'
import { LoginLimiter, SESSION_COOKIE, SESSION_TTL_MS, SessionStore, parseCookies, tokenMatches } from './auth'
import { hasState, ProjectEntry } from './config'
import { isAllowedRemoteHost, RemoteConfig } from './remote'
import { TeamSnapshot, TeamStateWatcher } from './state-watcher'

export const MAX_ANSWER_BODY_BYTES = 16 * 1024
const MAX_LOGIN_BODY_BYTES = 4 * 1024
const SSE_KEEPALIVE_MS = 25_000

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

// ─── Projects and watchers ──────────────────────────────────────────────────

export class TeamService {
  private watchers = new Map<string, TeamStateWatcher>()
  private sseClients = new Set<http.ServerResponse>()

  constructor(readonly projects: ProjectEntry[], opts: { debounceMs?: number; pollMs?: number } = {}) {
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

  trackSSE(res: http.ServerResponse): () => void {
    this.sseClients.add(res)
    return () => { this.sseClients.delete(res) }
  }

  dispose(): void {
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
      if (pathname === '/logout') return void handleLogout(req, res, remote)
      if (!isLocalRequest(req) && !remote.sessions.isValid(sessionId(req))) {
        const wantsHtml = (req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept ?? '').includes('text/html')
        if (wantsHtml) {
          res.writeHead(302, { Location: '/login', ...SECURITY_HEADERS })
          res.end()
        } else {
          sendError(res, 401, 'login required')
        }
        return
      }
    }

    if (pathname.startsWith('/api/team/')) return void handleTeamApi(req, res, pathname, query, team)
    fallback(req, res)
  }
}

async function handleTeamApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  query: URLSearchParams,
  team: TeamService,
): Promise<void> {
  const route = pathname.slice('/api/team/'.length)

  if (route === 'answer') {
    if (req.method !== 'POST') return sendError(res, 405, 'method not allowed', { Allow: 'POST' })
    return handleAnswer(req, res, team)
  }

  if (req.method !== 'GET') return sendError(res, 405, 'method not allowed', { Allow: 'GET' })

  if (route === 'projects') return sendJSON(res, 200, { projects: team.list() })

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
    res.write(`data: ${JSON.stringify({ type: 'team_state', project: snap.project, state: snap.state, error: snap.error, updatedAt: snap.updatedAt })}\n\n`)
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

async function handleAnswer(req: http.IncomingMessage, res: http.ServerResponse, team: TeamService): Promise<void> {
  if (req.headers['x-team-monitor'] !== '1') { closeAfter(res); return sendError(res, 403, 'missing X-Team-Monitor header') }
  if (!isSameOriginRequest(req)) { closeAfter(res); return sendError(res, 403, 'cross-origin request refused') }
  if (mediaType(req) !== 'application/json') { closeAfter(res); return sendError(res, 400, 'Content-Type must be application/json') }

  let text: string
  try {
    text = await readBody(req, MAX_ANSWER_BODY_BYTES)
  } catch {
    closeAfter(res)
    return sendError(res, 400, `body larger than ${MAX_ANSWER_BODY_BYTES} bytes`)
  }

  let body: unknown
  try { body = JSON.parse(text) } catch { return sendError(res, 400, 'body is not valid JSON') }

  try {
    const input = parseAnswerBody(body)
    const w = team.watcher(input.project)
    if (!w) return sendError(res, 404, 'unknown project')
    w.refresh()
    const { answeredAt } = writeAnswer(w.rawState(), w.answersDir, input.id, input.answer)
    w.refresh()
    sendJSON(res, 200, { ok: true, answeredAt })
  } catch (e) {
    if (e instanceof AnswerError) return sendError(res, e.status, e.message)
    sendError(res, 500, 'internal error')
  }
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
  'Referrer-Policy': 'no-referrer',
  ...SECURITY_HEADERS,
}

function clientKey(req: http.IncomingMessage): string {
  const addr = req.socket.remoteAddress ?? 'unknown'
  const fwd = req.headers['x-forwarded-for']
  if (isLoopbackAddress(addr) && typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim()
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

function handleLogout(req: http.IncomingMessage, res: http.ServerResponse, remote: RemoteAccess): void {
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return }
  if (!isSameOriginRequest(req)) return sendError(res, 403, 'cross-origin request refused')
  remote.sessions.destroy(sessionId(req))
  res.writeHead(303, { Location: '/login', 'Set-Cookie': cookie('', 0, isHttpsRequest(req)), ...SECURITY_HEADERS })
  res.end()
}
