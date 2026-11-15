/**
 * HTTP layer for the team monitor: Host checks, remote-mode login, the
 * `/api/team/*` endpoints, and a fallback to the upstream handler (graph SSE
 * on /events and the static UI).
 */
import type * as http from 'http'
import * as net from 'net'
import { isLoopbackHost } from '../../../extension/src/request-guard'
import { LogLimiter } from '../../../scripts/log-limit'
import { AnswerError, parseAnswerBody, writeAnswer } from './answers'
import { ChatError, MAX_MESSAGE_BODY_BYTES, MessageLimiter, parseMessageBody, writeInboxMessage } from './chat'
import {
  MAX_OFFBOARD_BODY_BYTES, OffboardError, OffboardStore, SESSION_ID_RE,
  offboardAgent, offboardFinished, parseOffboardAllBody, parseOffboardBody,
} from './offboard'
import type { GraphView } from '../../../scripts/graph-agents'
import { LoginLimiter, SESSION_COOKIE, SESSION_TTL_MS, SessionStore, parseCookies, sessionKey, tokenMatches } from './auth'
import { AUTO_OFFBOARD_DEFAULT_MINUTES, hasState, ProjectEntry } from './config'
import { isAllowedRemoteHost, RemoteConfig } from './remote'
import { PWA_PUBLIC_PATHS } from '../static'
import { TeamSnapshot, TeamStateWatcher } from './state-watcher'
import type { StatusOptions } from './heartbeat'
import { coordinatorFromState, titleFromState, type WatchedProject } from '../../../scripts/session-projects'

export const MAX_ANSWER_BODY_BYTES = 16 * 1024
const MAX_LOGIN_BODY_BYTES = 4 * 1024
const SSE_KEEPALIVE_MS = 25_000

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

// ─── Projects and watchers ──────────────────────────────────────────────────

/**
 * One entry of `GET /api/team/projects`. Cloud projects (hub intake, `--ingest`) also carry `origin: "cloud"`,
 * their `sourceId` and `stale` (true while the source has sent nothing for 60 s); local projects omit all three.
 */
export interface TeamProjectInfo {
  id: string
  name: string
  hasState: boolean
  origin?: 'cloud'
  sourceId?: string
  stale?: boolean
}

export class TeamService {
  private watchers = new Map<string, TeamStateWatcher>()
  private sseClients = new Set<http.ServerResponse>()
  private disposers: Array<() => void> = []
  /** Offboarded agents (set by setupTeam); null = offboarding endpoints answer 503. */
  offboard: OffboardStore | null = null
  /** The relay's view of the graph, attached once the relay runs (server.ts); null = offboarding answers 503. */
  graph: GraphView | null = null
  /** Minutes after finishing before the server offboards a sub-agent (config.json `autoOffboardMinutes`; spec
   *  ui-cleanup item 6). Set by setupTeam; also returned by `GET /api/team/offboarded`. */
  autoOffboardMinutes: number = AUTO_OFFBOARD_DEFAULT_MINUTES
  /** Chat messages accepted per minute, across all projects (spec-chat: 429 above 20). */
  messageLimiter = new MessageLimiter()
  /** Hub intake: source of each cloud project (project id -> sourceId). */
  private cloud = new Map<string, string>()
  /** Hub intake: is a source stale (set by the IngestService). */
  cloudStale: (sourceId: string) => boolean = () => false

  constructor(
    readonly projects: ProjectEntry[],
    private readonly watcherOpts: { debounceMs?: number; pollMs?: number; log?: (msg: string) => void; heartbeat?: StatusOptions } = {},
  ) {
    for (const p of projects) {
      const w = new TeamStateWatcher({ projectId: p.id, projectPath: p.path, ...watcherOpts })
      w.start()
      this.watchers.set(p.id, w)
    }
  }

  watcher(id: string): TeamStateWatcher | undefined {
    return this.watchers.get(id)
  }

  /**
   * Register a cloud project at runtime (hub intake): its mirror folder is watched like any project, but it is
   * never written to config.json and the graph does not look for its sessions on disk. The `.watcher` heartbeat
   * comes from another machine, so its pid is not checked here (its age still is).
   */
  addCloudProject(entry: ProjectEntry, sourceId: string): TeamStateWatcher {
    const existing = this.watchers.get(entry.id)
    if (existing) return existing
    const w = new TeamStateWatcher({
      projectId: entry.id, projectPath: entry.path, ...this.watcherOpts,
      heartbeat: { ...this.watcherOpts.heartbeat, pidAlive: () => true },
    })
    w.start()
    this.watchers.set(entry.id, w)
    this.projects.push({ ...entry })
    this.cloud.set(entry.id, sourceId)
    return w
  }

  /** Rename a cloud project (the source reported another name). */
  renameCloudProject(id: string, name: string): void {
    if (!this.cloud.has(id)) return
    const i = this.projects.findIndex((p) => p.id === id)
    if (i >= 0) this.projects[i] = { ...this.projects[i], name }
  }

  /** Unregister a cloud project (the hub evicted its source): its watcher stops and it leaves the list. */
  removeCloudProject(id: string): void {
    if (!this.cloud.has(id)) return
    this.watchers.get(id)?.dispose()
    this.watchers.delete(id)
    this.cloud.delete(id)
    const i = this.projects.findIndex((p) => p.id === id)
    if (i >= 0) this.projects.splice(i, 1)
  }

  isCloudProject(id: string): boolean {
    return this.cloud.has(id)
  }

  list(): TeamProjectInfo[] {
    return this.projects.map((p) => {
      const base = { id: p.id, name: p.name, hasState: hasState(p.path) }
      const sourceId = this.cloud.get(p.id)
      return sourceId === undefined ? base : { ...base, origin: 'cloud' as const, sourceId, stale: this.cloudStale(sourceId) }
    })
  }

  /** The projects the graph follows, with each one's current `meta.title` (spec graph-theme items 3-4). Cloud
   *  projects are left out: their sessions come through the intake, not from ~/.claude/projects. */
  graphProjects(): WatchedProject[] {
    return this.projects.filter((p) => !this.cloud.has(p.id)).map((p) => ({
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
  /** How often sessions.json is checked for a change by another process (`logout-all`); when it changed, the
   *  streams of sessions that are no longer valid close at once (default 500 ms). */
  sessionCheckMs?: number
  /** Server-side log for error details (default console.error). */
  log?: (msg: string) => void
  /** Hub intake (`--ingest`); null or absent = every /api/ingest/* route answers 404. */
  ingest?: IngestHandler | null
  /** Cloud mode in a container (team/index.ts `acceptsAnyHost`): any Host for GET/HEAD; state-changing requests
   *  still need a loopback Host. Never set with `remote`. */
  anyHost?: boolean
  /** `--public-ui` (with remote, bind loopback, behind Funnel): the login limiter keys on publicClientKey and every
   *  login (failed, refused by the limiter, successful, refused for lack of a client address) is logged through a
   *  LogLimiter. Routes and checks are those of remote mode, except that the local-request exception is off: every
   *  request needs a session, whatever its Host or headers, except /login, /logout, the ingest routes and
   *  HEALTH_PATH. */
  publicUi?: boolean
}

/** What the request handler needs from the hub intake (implemented by IngestService in ingest.ts). `route` is one of
 *  INGEST_ROUTES, or null for any other path under /api/ingest (refused). */
export interface IngestHandler {
  handle(req: http.IncomingMessage, res: http.ServerResponse, route: string | null, query: URLSearchParams): Promise<void>
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

/** Headers a proxy adds (any one of them, even empty, marks a request as relayed); also every `Tailscale-*` header. */
export const FORWARD_HEADERS: readonly string[] = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via']

/** The request carries evidence of a proxy: one of FORWARD_HEADERS or any header whose name starts with `tailscale-`. */
export function hasForwardingEvidence(req: http.IncomingMessage): boolean {
  return Object.keys(req.headers).some((h) => {
    const name = h.toLowerCase()
    return FORWARD_HEADERS.includes(name) || name.startsWith('tailscale-')
  })
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * A request typed on this machine: loopback socket, loopback Host, and not
 * relayed by a proxy (`tailscale serve` connects from loopback but adds
 * X-Forwarded-* headers and keeps the MagicDNS Host). Any forwarding evidence
 * (hasForwardingEvidence) makes a request non-local. With `--public-ui` this
 * exception is not used at all (createRequestHandler).
 */
export function isLocalRequest(req: http.IncomingMessage): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  if (!isLoopbackHost(req.headers.host)) return false
  return !hasForwardingEvidence(req)
}

/** Unauthenticated health route for `doctor` and `service status`: answers only HEALTH_BODY, in every mode. */
export const HEALTH_PATH = '/healthz'
export const HEALTH_BODY = '{"ok":true}'

/** Default mode (no --remote): fixed answer to a request that came through a proxy (P-03). */
export const FORWARDED_REFUSED = 'Forbidden: this monitor runs without --remote and answers only requests made on this machine, not through a proxy.'

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

export function sendJSON(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra })
  res.end(JSON.stringify(body))
}

export function sendError(res: http.ServerResponse, status: number, error: string, extra: Record<string, string> = {}): void {
  sendJSON(res, status, { ok: false, error }, extra)
}

/** The body is larger than the limit (counted while reading, also without a Content-Length). */
export class BodyError extends Error {}

export function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
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
export function closeAfter(res: http.ServerResponse): void {
  res.setHeader('Connection', 'close')
}

export function mediaType(req: http.IncomingMessage): string {
  return String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
}

// ─── Handler ────────────────────────────────────────────────────────────────

/** The three ingest routes, matched exactly on the raw request path. */
export const INGEST_ROUTES: ReadonlySet<string> = new Set(['/api/ingest/v1/events', '/api/ingest/v1/state', '/api/ingest/v1/outbox'])

/** Path and query of the request target exactly as sent (origin form, or the path of an absolute-form target). */
function rawTarget(url: string | undefined): { path: string; query: string } {
  let target = url || '/'
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(target)
  if (abs) target = abs[1] || '/'
  const q = target.indexOf('?')
  const hash = target.indexOf('#')
  const pathEnd = q >= 0 ? q : hash >= 0 ? hash : target.length
  return { path: target.slice(0, pathEnd), query: q >= 0 ? target.slice(q + 1, hash > q ? hash : undefined) : '' }
}

/** `p` looks like it is about /api/ingest: case-insensitively, also once percent-decoded and with backslashes
 *  read as slashes (so no spelling of it can reach the UI routing). */
function looksLikeIngest(p: string): boolean {
  const under = (s: string) => /^\/api\/ingest($|[/%.;])/.test(s.toLowerCase().replace(/\\/g, '/'))
  if (under(p)) return true
  let decoded = p
  try { decoded = decodeURIComponent(p) } catch { /* malformed escapes: judged on the raw path */ }
  return under(decoded)
}

/**
 * Ingest routing, decided on the raw request path (never on a normalised one, so dot segments or encoded slashes
 * cannot move a request out of /api/ingest into the UI or team routes). Null: not an ingest request. Otherwise
 * `route` is one of INGEST_ROUTES, or null for anything else under /api/ingest (refused with 400).
 */
export function ingestTarget(url: string | undefined): { route: string | null; query: URLSearchParams } | null {
  const raw = rawTarget(url)
  if (!looksLikeIngest(raw.path)) return null
  return { route: INGEST_ROUTES.has(raw.path) ? raw.path : null, query: new URLSearchParams(raw.query) }
}

/** A `.` or `..` segment, an encoded dot, slash or backslash, or a backslash. */
function hasTraversal(p: string): boolean {
  if (/%2e|%2f|%5c|\\/i.test(p)) return true
  return p.split('/').some((seg) => seg === '.' || seg === '..')
}

/**
 * With `--ingest` (hub intake on, ingest routes reachable from the internet), every request target is judged on its
 * raw path (as sent; the query string removed; the path of an absolute-form target) before any handler sees it:
 * - `ingest`: the raw path is exactly one of INGEST_ROUTES;
 * - `refuse` (400): any other path that starts with `/api/ingest` case-insensitively (also sibling names such as
 *   `/api/ingestX/...`, `/api/ingest-x`, `/api/ingest:`), or once percent-decoded; or a path anywhere with a dot
 *   segment, an encoded dot, slash or backslash, or a backslash (also once percent-decoded, so double encoding is
 *   refused too);
 * - `other`: everything else, handled as without `--ingest`.
 */
export function judgeTarget(url: string | undefined):
  | { kind: 'ingest'; route: string; query: URLSearchParams }
  | { kind: 'refuse'; ingestLike: boolean }
  | { kind: 'other' } {
  let target = url || '/'
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(target)
  if (abs) target = abs[1] || '/'
  const q = target.indexOf('?')
  const raw = q >= 0 ? target.slice(0, q) : target
  if (INGEST_ROUTES.has(raw)) return { kind: 'ingest', route: raw, query: new URLSearchParams(q >= 0 ? target.slice(q + 1) : '') }
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { /* malformed escapes: judged on the raw path */ }
  const ingestLike = [raw, decoded].some((p) => p.toLowerCase().startsWith('/api/ingest'))
  if (ingestLike || hasTraversal(raw) || hasTraversal(decoded)) return { kind: 'refuse', ingestLike }
  return { kind: 'other' }
}

/** Safe read requests: in cloud mode the only ones accepted with a foreign Host (no GET route changes state). */
function isSafeRead(req: http.IncomingMessage): boolean {
  return req.method === 'GET' || req.method === 'HEAD'
}

export function createRequestHandler(opts: HandlerOptions): Handler {
  const { team, remote, fallback } = opts
  const log = opts.log ?? console.error
  const streams = new SessionStreams()
  const login: LoginPolicy = opts.publicUi && remote
    ? { key: publicClientKey, log: new LogLimiter(log) }
    : { key: clientKey, log: null }
  if (remote) {
    const sweepNow = () => streams.sweep((k) => remote.sessions.isValidKey(k))
    const sweep = setInterval(sweepNow, opts.sessionSweepMs ?? 60_000)
    sweep.unref?.()
    // sessions.json changed under us (`logout-all`, a removed or garbled file): close dropped sessions' streams now,
    // not at the next sweep (P-05). One stat per tick; the sweep runs only after a change.
    const check = setInterval(() => { if (remote.sessions.refresh()) sweepNow() }, opts.sessionCheckMs ?? 500)
    check.unref?.()
    team.onDispose(() => { clearInterval(sweep); clearInterval(check) })
  }

  return (req, res) => {
    // Hub intake (`--ingest`): answered before the Host check and the login, because Funnel traffic carries the
    // public host name. Every ingest request needs the ingest token instead (ingest.ts). Decided on the raw request
    // target only (judgeTarget): the three exact routes go to the intake; anything else that looks like
    // /api/ingest, or any path with dot segments or encoded dots, slashes or backslashes, is refused with 400
    // before any other handler sees it. Without --ingest: /api/ingest paths 404, everything else as before.
    if (opts.ingest) {
      const verdict = judgeTarget(req.url)
      if (verdict.kind === 'ingest') return void opts.ingest.handle(req, res, verdict.route, verdict.query)
      if (verdict.kind === 'refuse') {
        closeAfter(res)
        return sendError(res, 400, verdict.ingestLike ? 'not an ingest route' : 'bad request path')
      }
    } else if (ingestTarget(req.url) !== null) {
      return sendError(res, 404, 'not found')
    }

    // Cloud mode (preview pane): a foreign Host only for safe reads; every state-changing request still needs a
    // loopback Host, so the preview is view-only and a DNS-rebound page cannot write.
    const hostOk = remote
      ? isAllowedRemoteHost(req.headers.host, remote.config)
      : (isLoopbackHost(req.headers.host) || (opts.anyHost === true && isSafeRead(req)))
    if (!hostOk) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }

    // Default mode (no --remote, not cloud mode) serves only this machine: a request that came through a proxy
    // (tailscale serve/Funnel, or anything else that adds forwarding headers) is refused, whatever its Host (P-03).
    // A browser or curl on this machine sends none of these headers.
    if (!remote && opts.anyHost !== true && hasForwardingEvidence(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
      res.end(FORWARDED_REFUSED)
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

    // Health route for doctor / service status, in every mode and without a session: a fixed body, nothing else.
    if (pathname === HEALTH_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method not allowed', { Allow: 'GET, HEAD' })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS })
      res.end(req.method === 'HEAD' ? undefined : HEALTH_BODY)
      return
    }

    if (remote) {
      if (pathname === '/login') return void handleLogin(req, res, remote, login)
      if (pathname === '/logout') return void handleLogout(req, res, remote, streams)
      // Installable app: manifest and icons are fetched without the cookie; fixed content, GET only (static.ts).
      if (req.method === 'GET' && PWA_PUBLIC_PATHS.has(req.url ?? '')) return fallback(req, res)
      // The local-request exception (no login on this machine) is off with --public-ui (P-01).
      if (opts.publicUi === true || !isLocalRequest(req)) {
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

    // A path that only normalises into /api/ingest (e.g. `/x/../api/ingest/...`) is not an ingest request either.
    if (pathname === '/api/ingest' || pathname.startsWith('/api/ingest/')) return sendError(res, 404, 'not found')
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
  sendJSON(res, 200, { offboarded: team.offboard ? team.offboard.list(filter) : [], autoOffboardMinutes: team.autoOffboardMinutes })
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

/** The 8 16-bit groups of an IPv6 address (with `::` and a trailing dotted IPv4 expanded), or null. */
function ipv6Groups(ip: string): number[] | null {
  if (net.isIP(ip) !== 6) return null
  let s = ip.toLowerCase()
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (v4) {
    const o = v4[2].split('.').map(Number)
    s = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null
}

/**
 * One client address as the login limiter counts it: an IPv4 address as is (also when sent IPv4-mapped), an IPv6
 * address by its /64 prefix (one subscriber usually holds a whole /64, so rotating addresses inside it gains
 * nothing). A port or brackets around it are removed. Anything that is not an IP address: null.
 */
export function limiterAddress(value: string): string | null {
  let v = value.trim()
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v)
  if (bracket) v = bracket[1]
  else if (/^[\d.]+:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'))
  v = v.replace(/%.*$/, '') // zone id
  if (net.isIP(v) === 4) return v
  const g = ipv6Groups(v)
  if (!g) return null
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}

/**
 * Key for the login limiter with `--public-ui` (behind Tailscale Funnel; Addendum G).
 *
 * Trusted: ONLY the last entry of `X-Forwarded-For`, and only on a loopback socket. Funnel's proxy (tailscaled, on
 * this machine) connects over loopback and sets X-Forwarded-For to the address of the client it accepted; a header
 * of that name sent by the client is dropped or comes before it (if a proxy appends instead), so the last entry is
 * always the one this machine's proxy wrote. `Forwarded`, `X-Real-IP`, `Tailscale-*` and every earlier
 * X-Forwarded-For entry are client data and never read here. The address is normalised by limiterAddress (IPv6 by
 * /64). A loopback socket with no X-Forwarded-For, or a last entry that is not an IP address: null, "no usable
 * client address" (P-04): the login is refused before the token is checked and counted under no key, so there is no
 * shared bucket anyone could fill. A non-loopback socket (not possible with --bind loopback): the socket address,
 * normalised.
 */
export function publicClientKey(req: http.IncomingMessage): string | null {
  const addr = req.socket.remoteAddress ?? 'unknown'
  if (!isLoopbackAddress(addr)) return `ip:${limiterAddress(addr) ?? addr}`
  const fwd = req.headers['x-forwarded-for']
  if (fwd === undefined) return null
  const last = String(fwd).split(',').map((s) => s.trim()).filter(Boolean).pop()
  const a = last ? limiterAddress(last) : null
  return a ? `fwd:${a}` : null
}

/** With --public-ui, the fixed page text of a login without a usable client address (400). */
export const NO_CLIENT_ADDRESS_MESSAGE = 'Masuk tidak bisa lewat alamat ini: buka URL Funnel atau tailnet (https://&lt;mesin&gt;.&lt;tailnet&gt;.ts.net/login), bukan http://127.0.0.1.'

/** How logins are counted and logged: remote mode as before, or `--public-ui`. */
interface LoginPolicy {
  /** The limiter key; null = no usable client address (only with --public-ui): refused, never counted. */
  key: (req: http.IncomingMessage) => string | null
  /** Login log (only with --public-ui): one line per login and client per minute, never the token. */
  log: LogLimiter | null
}

function cookie(value: string, maxAgeS: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`
}

async function handleLogin(req: http.IncomingMessage, res: http.ServerResponse, remote: RemoteAccess, policy: LoginPolicy): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.writeHead(200, PAGE_HEADERS)
    res.end(req.method === 'HEAD' ? undefined : loginPage(null))
    return
  }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, POST' }); res.end(); return }

  if (!isSameOriginRequest(req)) { closeAfter(res); return sendError(res, 403, 'cross-origin request refused') }

  const client = policy.key(req)
  if (client === null) {
    // --public-ui and no usable client address: refused before the token is read, not counted under any key.
    policy.log?.line('login-no-address', 'no-address', '[login] refused a login without a usable client address (X-Forwarded-For missing or its last entry not an IP; not counted). Log in through the Funnel or tailnet URL, not http://127.0.0.1.')
    closeAfter(res)
    res.writeHead(400, PAGE_HEADERS)
    res.end(loginPage(NO_CLIENT_ADDRESS_MESSAGE))
    return
  }
  const wait = remote.limiter.retryAfter(client)
  if (wait > 0) {
    policy.log?.line('login-limited', client, `[login] refused for ${client}: too many failed logins, retry in ${wait} s`)
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
    // Never the token or any part of it: only the counted client and what is left before the limit.
    const left = remote.limiter.triesLeft(client)
    policy.log?.line('login-failed', client, `[login] failed login from ${client} (wrong or missing token; ${left} tr${left === 1 ? 'y' : 'ies'} left before the limit)`)
    res.writeHead(401, PAGE_HEADERS)
    res.end(loginPage('Token salah.'))
    return
  }

  remote.limiter.succeed(client)
  policy.log?.line('login-ok', client, `[login] successful login from ${client}`)
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
