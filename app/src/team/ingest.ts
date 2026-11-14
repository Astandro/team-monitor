/**
 * Hub intake (`--ingest`): cloud containers ("sources") send their relay messages and team state to this monitor,
 * and fetch the owner's answers and chat messages back.
 *
 *   POST /api/ingest/v1/events   {sourceId, project:{id,name}, seq, messages:[...]}       max 512 KB, 500 messages
 *   PUT  /api/ingest/v1/state    {sourceId, project:{id,name}, state, watcher}           max 1 MB
 *   GET  /api/ingest/v1/outbox?sourceId=&after=<cursor>&wait=<0-25>                      long poll
 *
 * - Every request needs `Authorization: Bearer <ingest token>` (`<team home>/ingest-token`, 64 hex, 0600), also
 *   from loopback: Funnel traffic arrives over loopback. A wrong or missing token is 401 and counts against a
 *   per-client limiter (429 once it is exceeded). The login token and the session cookie do not open these routes.
 * - Every request also carries the source's own key (`X-Team-Monitor-Source-Key`, 64 hex, made by the forwarder at
 *   its first start). The first accepted request binds the key's sha256 to the sourceId (kept in the mirror's
 *   source.json, so it survives a restart); a later request for that sourceId with another or no key is 403 and
 *   changes nothing. So holding the shared token is not enough to read or write another source.
 * - Every authenticated response carries `X-Team-Monitor-Hub-Epoch` (random per hub start). An events post that
 *   names an older epoch in the same header is refused with 409: the forwarder then resends its sessions and history.
 * - Limits: JSON nesting 32 levels, one event 64 KB, buffered events 4 MB per cloud session, 16 MB per source and
 *   128 MB for all cloud sessions (scripts/relay.ts), 200 cloud sessions and 100 sources (ended / stale ones evicted,
 *   503 when not enough can be).
 * - Events go into the relay as cloud sessions (scripts/relay.ts): same buffer, replay, offboarding and auto
 *   offboarding as local sessions; session list entries and lifecycle messages carry origin/sourceId/stale.
 * - State is mirrored to `<team home>/remote/<sourceId>/.agent-team/` (atomic writes) and that folder is registered
 *   at runtime as project `cloud-<sourceId>`. Answers and chat messages written there by the existing endpoints are
 *   what the outbox returns.
 * - A source with no request for 60 s is stale; the next request makes it live again. At start, mirrors with no
 *   request for 24 hours are removed (also while running) and the others come back as stale projects.
 * - Everything received is untrusted data: size-capped while reading, shape-checked, and never used in a path
 *   except the validated sourceId (the answer and inbox names the outbox lists come from this machine's disk and
 *   are matched against their patterns).
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import type * as http from 'http'
import * as path from 'path'
import type { AgentEvent, CoordinatorInfo } from '../../../extension/src/protocol'
import type { CloudIntake, CloudMessage } from '../../../scripts/relay'
import { coordinatorFromState } from '../../../scripts/session-projects'
import { LogLimiter } from '../../../scripts/log-limit'
import { LoginLimiter, tokenMatches } from './auth'
import { INBOX_FILE_RE, MAX_INBOX_FILE_BYTES } from './chat'
import { HEARTBEAT_FILE, EndReason, HeartbeatRecord, writeHeartbeat } from './heartbeat'
import { BodyError, clientKey, closeAfter, IngestHandler, mediaType, readBody, sendError, sendJSON, TeamService } from './http'
import { MAX_AGENT_NAME_CHARS, OffboardError, SESSION_ID_RE, offboardAgent } from './offboard'
import { writeFileAtomic } from './service'
import { ANSWER_FILE_RE, MAX_ANSWER_FILE_BYTES, MAX_STATE_BYTES } from './state-watcher'

export const INGEST_TOKEN_FILE = 'ingest-token'
export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const MAX_EVENTS_BODY_BYTES = 512 * 1024
export const MAX_MESSAGES = 500
/** Events inside `agent-event-batch` messages, all batches of one request together. */
export const MAX_BATCH_EVENTS = 5000
export const MAX_STATE_BODY_BYTES = 1024 * 1024
export const STALE_AFTER_MS = 60_000
/** A source silent this long is removed with its mirror (at start and by the stale sweep). */
export const MIRROR_MAX_IDLE_MS = 24 * 60 * 60 * 1000
export const MAX_OUTBOX_WAIT_S = 25
/** Sources kept; at the cap the longest-stale source is evicted, and 503 when every source is live. */
export const MAX_SOURCES = 100
/** Files per outbox response; the cursor moves on by what was returned. */
export const MAX_OUTBOX_FILES = 200
/** Long polls held open at once; above it an outbox poll that would wait gets 503 with Retry-After. */
export const MAX_OUTBOX_WAITERS = 64
export const OUTBOX_BUSY_RETRY_S = 5
/** Nesting of any ingest JSON body (objects and arrays); deeper is refused with 400 before it is parsed. */
export const MAX_JSON_DEPTH = 32
/** One event as JSON; a batch with a larger event is refused with 400. */
export const MAX_EVENT_BYTES = 64 * 1024
/** Header with the source's own secret (64 hex), bound to its sourceId on the first accepted request. */
export const SOURCE_KEY_HEADER = 'x-team-monitor-source-key'
/** Response header on every authenticated ingest response: random per hub start. On an events post, the forwarder
 *  sends the epoch it knows in the same header; another epoch is refused with 409 (nothing applied). */
export const EPOCH_HEADER = 'x-team-monitor-hub-epoch'
const SOURCE_KEY_RE = /^[0-9a-f]{64}$/
const KEY_HASH_RE = /^[0-9a-f]{64}$/
const CAPACITY_RETRY_S = 30
const SOURCE_FILE = 'source.json'
const MAX_SOURCE_FILE_BYTES = 4096
const SOURCE_TOUCH_MS = 60_000
const MAX_LABEL_CHARS = 200
const MAX_PROMPT_CHARS = 2000
const MAX_NAME_CHARS = 120
const MAX_TIME_CHARS = 64
const MAX_OFFBOARDED_AGENTS = 200
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/
const CURSOR_RE = /^([0-9a-f]{8})-([0-9]{1,9})$/
const END_REASONS: ReadonlySet<string> = new Set(['message', 'answer', 'timeout', 'signal', 'error'])

export class IngestError extends Error {
  /** The source the request named, when known (the log limit counts per client and source). */
  source?: string
  /**
   * `message` goes to the client (no paths); `detail` is for the server log only, written through the log limit
   * (one line per `kind` and client/source per minute). `kind` is a fixed name; default `refused-<status>`.
   */
  constructor(
    readonly status: 400 | 403 | 404 | 405 | 409 | 413 | 500 | 503, message: string, readonly detail?: string, readonly retryAfterS?: number,
    readonly kind?: string,
  ) {
    super(message)
  }
}

/**
 * True when `text` (JSON) nests objects/arrays deeper than `max`. A plain scan of the text (strings skipped), so it
 * runs before JSON.parse and costs no recursion.
 */
export function jsonTooDeep(text: string, max: number = MAX_JSON_DEPTH): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (inString) {
      if (c === 0x5c) i++ // backslash: skip the escaped character
      else if (c === 0x22) inString = false
      continue
    }
    if (c === 0x22) inString = true
    else if (c === 0x7b || c === 0x5b) { if (++depth > max) return true }
    else if (c === 0x7d || c === 0x5d) depth--
  }
  return false
}

// ─── Body parsing (untrusted) ───────────────────────────────────────────────

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new IngestError(400, `${what} must be a JSON object`)
  return v as Record<string, unknown>
}

/** Control characters plus the Unicode line and paragraph separators (U+2028, U+2029). */
const LINE_BREAKING = new RegExp(`[\\x00-\\x1f\\x7f${String.fromCharCode(0x2028, 0x2029)}]+`, 'g')

/** One line of text: control characters become spaces, trimmed, capped. */
function line(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string') throw new IngestError(400, `${what} must be a string`)
  return v.replace(LINE_BREAKING, ' ').trim().slice(0, max)
}

/** Free text (line breaks and tabs kept, other control characters dropped), capped. Absent = undefined. */
function optText(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new IngestError(400, `${what} must be a string`)
  return v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max)
}

function sessionId(v: unknown, what: string): string {
  if (typeof v !== 'string' || !SESSION_ID_RE.test(v)) throw new IngestError(400, `${what} must be a session id`)
  return v
}

function coordinator(v: unknown): CoordinatorInfo | undefined {
  if (v === undefined || v === null) return undefined
  return coordinatorFromState({ meta: { coordinator: v } })
}

function time(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

export function parseSourceId(v: unknown): string {
  if (typeof v !== 'string' || !SOURCE_ID_RE.test(v)) throw new IngestError(400, 'sourceId must match ^[a-z0-9][a-z0-9-]{0,63}$')
  return v
}

export interface IngestProject { id: string; name: string }

export function parseProject(v: unknown): IngestProject {
  const p = obj(v, 'project')
  if (typeof p.id !== 'string' || !PROJECT_ID_RE.test(p.id)) throw new IngestError(400, 'project.id must match ^[a-z0-9][a-z0-9-]{0,63}$')
  const name = line(p.name, 'project.name', MAX_NAME_CHARS)
  if (!name) throw new IngestError(400, 'project.name is empty')
  return { id: p.id, name }
}

export function parseEvent(v: unknown, what: string): AgentEvent & { sessionId: string } {
  const e = obj(v, what)
  if (typeof e.type !== 'string' || !EVENT_TYPE_RE.test(e.type)) throw new IngestError(400, `${what}.type is not an event type`)
  if (typeof e.time !== 'number' || !Number.isFinite(e.time)) throw new IngestError(400, `${what}.time must be a number`)
  const payload = obj(e.payload, `${what}.payload`)
  // Any well-formed type is passed on (an unknown one is ignored by viewers), so it is not narrowed further here.
  const event = { time: e.time, type: e.type as AgentEvent['type'], payload, sessionId: sessionId(e.sessionId, `${what}.sessionId`) }
  let bytes = Infinity
  try { bytes = Buffer.byteLength(JSON.stringify(event)) } catch { /* not serialisable: refused below */ }
  if (bytes > MAX_EVENT_BYTES) throw new IngestError(400, `${what} is larger than ${MAX_EVENT_BYTES} bytes as JSON`)
  return event
}

/** What the events route applies: the relay's messages, plus `agents-offboarded` (handled by the offboard store). */
export type IngestMessage = CloudMessage | { type: 'agents-offboarded'; sessionId: string; agents: string[] }

export function parseMessage(v: unknown, i: number, now: number, budget: { events: number }): IngestMessage {
  const what = `messages[${i}]`
  const m = obj(v, what)
  switch (m.type) {
    case 'session-started': {
      const s = obj(m.session, `${what}.session`)
      const coord = coordinator(s.coordinator)
      const prompt = optText(s.prompt, `${what}.session.prompt`, MAX_PROMPT_CHARS)
      return {
        type: 'session-started',
        session: {
          id: sessionId(s.id, `${what}.session.id`),
          label: line(s.label, `${what}.session.label`, MAX_LABEL_CHARS),
          status: s.status === 'completed' ? 'completed' : 'active',
          startTime: time(s.startTime, now),
          lastActivityTime: time(s.lastActivityTime, now),
          ...(prompt !== undefined ? { prompt } : {}),
          ...(coord ? { coordinator: coord } : {}),
        },
      }
    }
    case 'session-updated': {
      const coord = coordinator(m.coordinator)
      const prompt = optText(m.prompt, `${what}.prompt`, MAX_PROMPT_CHARS)
      return {
        type: 'session-updated',
        sessionId: sessionId(m.sessionId, `${what}.sessionId`),
        label: line(m.label, `${what}.label`, MAX_LABEL_CHARS),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(coord ? { coordinator: coord } : {}),
      }
    }
    case 'session-ended':
      return { type: 'session-ended', sessionId: sessionId(m.sessionId, `${what}.sessionId`) }
    case 'agent-event':
      return { type: 'agent-event', event: parseEvent(m.event, `${what}.event`) }
    case 'agent-event-batch': {
      if (!Array.isArray(m.events)) throw new IngestError(400, `${what}.events must be an array`)
      budget.events -= m.events.length
      if (budget.events < 0) throw new IngestError(400, `more than ${MAX_BATCH_EVENTS} batched events in one request`)
      return { type: 'agent-event-batch', events: m.events.map((e, j) => parseEvent(e, `${what}.events[${j}]`)) }
    }
    case 'agents-offboarded': {
      if (!Array.isArray(m.agents) || m.agents.length > MAX_OFFBOARDED_AGENTS) {
        throw new IngestError(400, `${what}.agents must be an array of at most ${MAX_OFFBOARDED_AGENTS} names`)
      }
      const agents = m.agents.map((a, j) => {
        if (typeof a !== 'string' || !a || a.length > MAX_AGENT_NAME_CHARS) throw new IngestError(400, `${what}.agents[${j}] is not an agent name`)
        return a
      })
      return { type: 'agents-offboarded', sessionId: sessionId(m.sessionId, `${what}.sessionId`), agents }
    }
    default:
      throw new IngestError(400, `${what}.type is not one of session-started, session-updated, session-ended, agent-event, agent-event-batch, agents-offboarded`)
  }
}

export interface EventsInput { sourceId: string; project: IngestProject; seq: number; messages: IngestMessage[] }

export function parseEventsBody(body: unknown, now: number = Date.now()): EventsInput {
  const b = obj(body, 'body')
  const sourceId = parseSourceId(b.sourceId)
  const project = parseProject(b.project)
  if (typeof b.seq !== 'number' || !Number.isSafeInteger(b.seq) || b.seq < 0) throw new IngestError(400, 'seq must be a whole number >= 0')
  if (!Array.isArray(b.messages)) throw new IngestError(400, 'messages must be an array')
  if (b.messages.length > MAX_MESSAGES) throw new IngestError(400, `more than ${MAX_MESSAGES} messages`)
  const budget = { events: MAX_BATCH_EVENTS }
  const messages = b.messages.map((m, i) => parseMessage(m, i, now, budget))
  return { sourceId, project, seq: b.seq, messages }
}

export interface StateInput {
  sourceId: string
  project: IngestProject
  state: Record<string, unknown> | null
  watcher: HeartbeatRecord | null
}

function isoish(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > MAX_TIME_CHARS || !Number.isFinite(Date.parse(v))) throw new IngestError(400, `${what} must be an ISO time`)
  return v
}

export function parseWatcher(v: unknown): HeartbeatRecord | null {
  if (v === null) return null
  const w = obj(v, 'watcher')
  if (typeof w.pid !== 'number' || !Number.isSafeInteger(w.pid) || w.pid <= 0) throw new IngestError(400, 'watcher.pid must be a positive whole number')
  const rec: HeartbeatRecord = { pid: w.pid, startedAt: isoish(w.startedAt, 'watcher.startedAt'), beatAt: isoish(w.beatAt, 'watcher.beatAt') }
  if (w.endedAt !== undefined) rec.endedAt = isoish(w.endedAt, 'watcher.endedAt')
  if (w.reason !== undefined) {
    if (typeof w.reason !== 'string' || !END_REASONS.has(w.reason)) throw new IngestError(400, 'watcher.reason is not a known reason')
    rec.reason = w.reason as EndReason
  }
  return rec
}

export function parseStateBody(body: unknown): StateInput {
  const b = obj(body, 'body')
  const sourceId = parseSourceId(b.sourceId)
  const project = parseProject(b.project)
  if (!('state' in b) || !('watcher' in b)) throw new IngestError(400, 'state and watcher are required (null when absent)')
  const state = b.state === null ? null : obj(b.state, 'state')
  return { sourceId, project, state, watcher: parseWatcher(b.watcher) }
}

function bearer(header: string | undefined): string | null {
  if (typeof header !== 'string') return null
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)
  return m ? m[1] : null
}

// ─── Mirror folders ─────────────────────────────────────────────────────────

/** `base/name` for a validated source id, refused unless it is a direct child of `base` (defence in depth). */
export function mirrorPath(remoteDir: string, sourceId: string): string {
  parseSourceId(sourceId)
  const base = path.resolve(remoteDir)
  const target = path.resolve(base, sourceId)
  if (path.dirname(target) !== base) throw new IngestError(400, 'bad sourceId')
  return target
}

/** Create `dir` (0700) if missing; refuse a symlink or a file in its place. */
function ensurePlainDir(dir: string): void {
  try { fs.mkdirSync(dir, { mode: 0o700 }) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new IngestError(500, 'cannot create the mirror', `cannot create ${dir}: ${(e as Error).message}`, undefined, 'mirror')
  }
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new IngestError(500, 'cannot use the mirror', `${dir} is not a plain directory (symlink or file)`, undefined, 'mirror')
}

function unlinkFile(file: string): void {
  try {
    if (fs.lstatSync(file).isDirectory()) return
    fs.unlinkSync(file)
  } catch { /* not there */ }
}

/** A small regular file's text, or null (missing, symlink, too large). Never reads more than `cap` bytes. */
function readSmall(file: string, cap: number): string | null {
  let fd: number | null = null
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > cap) return null
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const buf = Buffer.alloc(cap + 1)
    let total = 0
    for (;;) {
      const n = fs.readSync(fd, buf, total, buf.length - total, null)
      if (n === 0) break
      total += n
      if (total > cap) return null
    }
    return buf.subarray(0, total).toString('utf-8')
  } catch {
    return null
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

/** `source.json` of a mirror. `keyHash`: sha256 (hex) of the source key bound to this sourceId (never the key). */
interface SourceFile { sourceId: string; name: string; projectId: string; lastSeenAt: string; keyHash?: string }

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex')
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

// ─── Service ────────────────────────────────────────────────────────────────

interface Source {
  id: string
  /** Hub registry id: `cloud-<sourceId>`. */
  projectId: string
  /** The project id the container reported (informational). */
  remoteProjectId: string
  name: string
  root: string
  teamDir: string
  lastSeq: number
  lastSeen: number
  stale: boolean
  /** sha256 of the source key bound to this sourceId; null until the first request with a key (old mirrors). */
  keyHash: string | null
  lastTouch: number
  /** The last `.watcher` record received, to tell a new heartbeat from a repeated one. */
  lastWatcherKey: string | null
  /** Outbox: every answer / inbox file seen, in the order first seen; a cursor is an index into it. */
  outbox: string[]
  outboxSeen: Set<string>
}

export interface OutboxFile { path: string; content: string }
export interface OutboxResult { cursor: string; files: OutboxFile[] }

export interface IngestOptions {
  /** Team home (`~/.team-monitor` or $TEAM_MONITOR_HOME); mirrors live in `<home>/remote/`. */
  home: string
  token: string
  team: TeamService
  limiter?: LoginLimiter
  now?: () => number
  log?: (msg: string) => void
  staleMs?: number
  /** How often stale sources are looked for (default 5 s). */
  sweepMs?: number
  mirrorMaxIdleMs?: number
  /** Long poll re-check interval (default 500 ms; the project watcher also wakes it). */
  outboxPollMs?: number
  /** Defaults MAX_SOURCES and MAX_OUTBOX_WAITERS; smaller values for tests. */
  maxSources?: number
  maxOutboxWaiters?: number
  /** Log limit interval (default one minute). */
  logIntervalMs?: number
}

export class IngestService implements IngestHandler {
  readonly remoteDir: string
  private readonly token: string
  private readonly team: TeamService
  private readonly limiter: LoginLimiter
  private readonly now: () => number
  private readonly log: (msg: string) => void
  private readonly staleMs: number
  private readonly sweepMs: number
  private readonly mirrorMaxIdleMs: number
  private readonly outboxPollMs: number
  private readonly maxSources: number
  private readonly maxWaiters: number
  /** Changes at every start: a cursor from before a restart reads as "from the beginning", and a forwarder that sees
   *  a new epoch (EPOCH_HEADER) sends its sessions and their history again. */
  readonly epoch = crypto.randomBytes(4).toString('hex')
  private relay: CloudIntake | null = null
  private sources = new Map<string, Source>()
  private sweepTimer: NodeJS.Timeout | null = null
  private waiters = new Set<() => void>()
  private disposed = false
  /** Every log line a request can cause goes through here: one per kind and client/source per minute (NEW-1). */
  private readonly limitedLog: LogLimiter

  constructor(opts: IngestOptions) {
    this.remoteDir = path.join(opts.home, 'remote')
    this.token = opts.token
    this.team = opts.team
    this.limiter = opts.limiter ?? new LoginLimiter()
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? console.warn
    this.limitedLog = new LogLimiter(this.log, { now: this.now, intervalMs: opts.logIntervalMs })
    this.staleMs = opts.staleMs ?? STALE_AFTER_MS
    this.sweepMs = opts.sweepMs ?? 5000
    this.mirrorMaxIdleMs = opts.mirrorMaxIdleMs ?? MIRROR_MAX_IDLE_MS
    this.outboxPollMs = opts.outboxPollMs ?? 500
    this.maxSources = opts.maxSources ?? MAX_SOURCES
    this.maxWaiters = opts.maxOutboxWaiters ?? MAX_OUTBOX_WAITERS
    this.team.cloudStale = (sourceId) => this.sources.get(sourceId)?.stale ?? true
  }

  /** The relay's cloud intake (server.ts, once the relay runs). Until then the events route answers 503. */
  attachRelay(relay: CloudIntake): void {
    this.relay = relay
    for (const s of this.sources.values()) if (s.stale) relay.setStale(s.id, true)
  }

  /**
   * Remove mirrors with no request for 24 hours (and the oldest beyond the source cap), register the others as stale
   * cloud projects with their bound source key, and start the stale sweep. Returns the source ids removed and
   * restored (restored in name order).
   */
  start(): { removed: string[]; restored: string[] } {
    const removed: string[] = []
    const restored: string[] = []
    let names: string[] = []
    try { names = fs.readdirSync(this.remoteDir) } catch { /* no mirrors yet */ }
    const now = this.now()
    const found: Array<{ name: string; dir: string; rec: SourceFile | null; lastSeen: number }> = []
    for (const name of names.sort()) {
      if (!SOURCE_ID_RE.test(name)) continue
      const dir = mirrorPath(this.remoteDir, name)
      let st: fs.Stats
      try { st = fs.lstatSync(dir) } catch { continue }
      if (!st.isDirectory() || st.isSymbolicLink()) continue
      const rec = this.readSourceFile(dir)
      const lastSeen = rec ? Date.parse(rec.lastSeenAt) : st.mtimeMs
      if (!Number.isFinite(lastSeen) || now - lastSeen > this.mirrorMaxIdleMs) {
        if (this.removeMirror(dir)) removed.push(name)
        continue
      }
      found.push({ name, dir, rec, lastSeen })
    }
    // The most recently seen first, up to the cap; older ones beyond it are removed.
    const keep = [...found].sort((a, b) => b.lastSeen - a.lastSeen)
    for (const f of keep.slice(this.maxSources)) if (this.removeMirror(f.dir)) removed.push(f.name)
    const kept = new Set(keep.slice(0, this.maxSources).map((f) => f.name))
    for (const f of found) {
      if (!kept.has(f.name)) continue
      try {
        this.register(f.name, { id: f.rec?.projectId ?? f.name, name: f.rec?.name ?? f.name }, true, f.lastSeen, f.rec?.keyHash ?? null)
        restored.push(f.name)
      } catch (e) {
        this.log(`[ingest] mirror ${f.name} not restored: ${(e as Error).message}`)
      }
    }
    removed.sort()
    if (!this.sweepTimer && this.sweepMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), this.sweepMs)
      this.sweepTimer.unref?.()
    }
    return { removed, restored }
  }

  dispose(): void {
    this.disposed = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const finish of [...this.waiters]) finish()
  }

  /** Mark sources with no request for `staleMs` as stale and tell the relay and the open streams; remove sources
   *  silent for longer than the mirror idle limit (24 hours) with their mirror. */
  sweep(): void {
    const now = this.now()
    let changed = false
    for (const s of [...this.sources.values()]) {
      if (now - s.lastSeen > this.mirrorMaxIdleMs) {
        this.evictSource(s, 'idle')
        changed = true
        continue
      }
      const stale = now - s.lastSeen > this.staleMs
      if (stale === s.stale) continue
      s.stale = stale
      this.relay?.setStale(s.id, stale)
      changed = true
    }
    if (changed) this.relay?.announceProjectsChanged()
  }

  /** Source ids known now, and whether each is stale (for tests and doctor-like output). */
  sourceStates(): Array<{ sourceId: string; projectId: string; stale: boolean; lastSeq: number }> {
    return [...this.sources.values()].map((s) => ({ sourceId: s.id, projectId: s.projectId, stale: s.stale, lastSeq: s.lastSeq }))
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────

  async handle(req: http.IncomingMessage, res: http.ServerResponse, route: string | null, query: URLSearchParams): Promise<void> {
    // Token first, on every route (also loopback): nothing about the routes is told without it.
    const client = clientKey(req)
    const given = bearer(req.headers.authorization)
    if (given === null || !tokenMatches(given, this.token)) {
      closeAfter(res)
      const wait = this.limiter.retryAfter(client)
      this.limitedLog.line('token', client, `[ingest] refused (${wait > 0 ? 429 : 401}): no or wrong ingest token from ${client}`)
      if (wait > 0) return sendError(res, 429, 'too many failed attempts, try again later', { 'Retry-After': String(wait) })
      this.limiter.fail(client)
      return sendError(res, 401, 'ingest token required', { 'WWW-Authenticate': 'Bearer' })
    }
    res.setHeader(EPOCH_HEADER, this.epoch)

    try {
      // Only the three exact routes (raw path, http.ts): dot segments, encoded characters or anything else: 400.
      if (route === null) { closeAfter(res); return sendError(res, 400, 'not an ingest route') }
      if (route === '/api/ingest/v1/events') {
        if (req.method !== 'POST') return sendError(res, 405, 'method not allowed', { Allow: 'POST' })
        return await this.handleEvents(req, res)
      }
      if (route === '/api/ingest/v1/state') {
        if (req.method !== 'PUT') return sendError(res, 405, 'method not allowed', { Allow: 'PUT' })
        return await this.handleState(req, res)
      }
      if (route === '/api/ingest/v1/outbox') {
        if (req.method !== 'GET') return sendError(res, 405, 'method not allowed', { Allow: 'GET' })
        return await this.handleOutbox(req, res, query)
      }
      sendError(res, 400, 'not an ingest route')
    } catch (e) {
      if (res.headersSent) return
      if (e instanceof IngestError) {
        if (e.detail) {
          const who = e.source ? `${client} ${e.source}` : client
          this.limitedLog.line(e.kind ?? `refused-${e.status}`, who, `[ingest] refused (${e.status}): ${e.detail} (client ${client})`)
        }
        if (e.status === 400 || e.status === 413 || e.status === 403) closeAfter(res)
        return sendError(res, e.status, e.message, e.retryAfterS ? { 'Retry-After': String(e.retryAfterS) } : {})
      }
      this.limitedLog.line('failed', client, `[ingest] failed: ${(e as Error)?.stack ?? String(e)}`)
      sendError(res, 500, 'internal error')
    }
  }

  private async readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
    if (mediaType(req) !== 'application/json') throw new IngestError(400, 'Content-Type must be application/json')
    let text: string
    try {
      text = await readBody(req, limit)
    } catch (e) {
      if (e instanceof BodyError) throw new IngestError(413, `body larger than ${limit} bytes`)
      throw new IngestError(400, 'body could not be read')
    }
    // Refused before parsing, so nothing nested deeper than MAX_JSON_DEPTH is ever parsed, buffered or serialised.
    if (jsonTooDeep(text)) throw new IngestError(400, `JSON nested deeper than ${MAX_JSON_DEPTH} levels`)
    try { return JSON.parse(text) } catch { throw new IngestError(400, 'body is not valid JSON') }
  }

  /**
   * The source key of a request for `sourceId`: 403 when it is missing or malformed, or when the sourceId is bound to
   * another key. Checks only (nothing is changed); returns the key's hash, bound by touch() on the first accepted
   * request.
   */
  private checkSourceKey(req: http.IncomingMessage, sourceId: string): string {
    const raw = req.headers[SOURCE_KEY_HEADER]
    const key = typeof raw === 'string' ? raw.trim() : ''
    if (!SOURCE_KEY_RE.test(key)) throw new IngestError(403, 'source key required (X-Team-Monitor-Source-Key: 64 hex)')
    const hash = hashKey(key)
    const bound = this.sources.get(sourceId)?.keyHash
    if (bound && !sameHash(bound, hash)) {
      const err = new IngestError(403, 'this sourceId belongs to another source key', `source key mismatch for ${sourceId}`, undefined, 'key-mismatch')
      err.source = sourceId
      throw err
    }
    return hash
  }

  /** Session ids a request would create on the graph (for the capacity check). */
  private static sessionIdsOf(messages: IngestMessage[]): string[] {
    const ids: string[] = []
    for (const m of messages) {
      if (m.type === 'session-started') ids.push(m.session.id)
      else if (m.type === 'session-updated') ids.push(m.sessionId)
      else if (m.type === 'agent-event') ids.push(m.event.sessionId)
      else if (m.type === 'agent-event-batch') for (const e of m.events) ids.push(e.sessionId)
    }
    return ids
  }

  private async handleEvents(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const input = parseEventsBody(await this.readJson(req, MAX_EVENTS_BODY_BYTES), this.now())
    const keyHash = this.checkSourceKey(req, input.sourceId)
    const relay = this.relay
    if (!relay) throw new IngestError(503, 'the graph is not running yet')
    // A forwarder that knew an earlier hub epoch must resend its sessions and history first (nothing applied).
    const known = req.headers[EPOCH_HEADER]
    if (typeof known === 'string' && known !== '' && known !== this.epoch) {
      throw new IngestError(409, 'the hub restarted: send the sessions and their history again')
    }
    const src = this.touch(input.sourceId, input.project, keyHash)
    if (input.seq <= src.lastSeq) return sendJSON(res, 200, { ok: true, seq: src.lastSeq, duplicate: true })
    // Room for new sessions (ended or stale ones are evicted); when everything is live, refused before seq moves on,
    // so the forwarder retries the same body later.
    if (!relay.makeRoom(IngestService.sessionIdsOf(input.messages))) {
      throw new IngestError(503, 'hub at capacity: every cloud session on it is live; retry later', `cloud session cap reached, events of ${src.id} not applied`, CAPACITY_RETRY_S, 'capacity-sessions')
    }
    src.lastSeq = input.seq
    let applied = 0
    let ignored = 0
    for (const m of input.messages) {
      const r = m.type === 'agents-offboarded' ? this.offboardRemote(src, m.sessionId, m.agents) : relay.apply(src.id, src.projectId, [m])
      applied += r.applied
      ignored += r.ignored
    }
    sendJSON(res, 200, { ok: true, seq: input.seq, applied, ignored })
  }

  /** The source offboarded these agents: record them in this monitor's store too (finished agents only). */
  private offboardRemote(src: Source, session: string, agents: string[]): { applied: number; ignored: number } {
    let applied = 0
    let ignored = 0
    for (const agent of agents) {
      if (!this.team.offboard || this.relay?.sourceOf(session) !== src.id) { ignored++; continue }
      try {
        offboardAgent(this.team.offboard, this.team.graph, { session, agent })
        applied++
      } catch (e) {
        if (!(e instanceof OffboardError)) throw e
        ignored++
      }
    }
    return { applied, ignored }
  }

  private async handleState(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const input = parseStateBody(await this.readJson(req, MAX_STATE_BODY_BYTES))
    const keyHash = this.checkSourceKey(req, input.sourceId)
    const src = this.touch(input.sourceId, input.project, keyHash)
    const stateFile = path.join(src.teamDir, 'state.json')
    if (input.state === null) {
      unlinkFile(stateFile)
    } else {
      const text = JSON.stringify(input.state)
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new IngestError(413, `state larger than ${MAX_STATE_BYTES} bytes`)
      try {
        writeFileAtomic(stateFile, text + '\n', 0o600)
      } catch (e) {
        throw new IngestError(500, 'cannot write state', `cannot write ${stateFile}: ${(e as Error).message}`, undefined, 'state-write')
      }
    }
    this.mirrorWatcher(src, input.watcher)
    this.team.watcher(src.projectId)?.refresh()
    sendJSON(res, 200, { ok: true })
  }

  /**
   * Mirror `.watcher`. Its times come from the container's clock and its pid is another machine's, so a new
   * heartbeat (one not received before) is stamped with this machine's time: the record then goes stale here
   * 30 s after the last heartbeat that arrived, like a local one.
   */
  private mirrorWatcher(src: Source, rec: HeartbeatRecord | null): void {
    const file = path.join(src.teamDir, HEARTBEAT_FILE)
    if (rec === null) {
      unlinkFile(file)
      src.lastWatcherKey = null
      return
    }
    const key = JSON.stringify(rec)
    if (key === src.lastWatcherKey) return
    src.lastWatcherKey = key
    const out: HeartbeatRecord = rec.endedAt === undefined ? { ...rec, beatAt: new Date(this.now()).toISOString() } : rec
    writeHeartbeat(src.teamDir, out)
  }

  private async handleOutbox(req: http.IncomingMessage, res: http.ServerResponse, query: URLSearchParams): Promise<void> {
    const sourceId = parseSourceId(query.get('sourceId') ?? '')
    // Only the source that owns the sourceId reads its answers and chat (an unknown source gets an empty list).
    this.checkSourceKey(req, sourceId)
    const after = query.get('after') ?? ''
    let index = 0
    if (after !== '') {
      const m = CURSOR_RE.exec(after)
      if (!m) throw new IngestError(400, 'after must be a cursor from a previous outbox reply')
      index = m[1] === this.epoch ? Number(m[2]) : 0
    }
    const waitRaw = query.get('wait') ?? '0'
    if (!/^[0-9]{1,2}$/.test(waitRaw) || Number(waitRaw) > MAX_OUTBOX_WAIT_S) throw new IngestError(400, `wait must be 0-${MAX_OUTBOX_WAIT_S}`)
    const waitMs = Number(waitRaw) * 1000

    const known = this.sources.get(sourceId)
    if (known) this.seen(known)
    let result = this.outboxFrom(sourceId, index)
    if (result.files.length === 0 && waitMs > 0 && !this.disposed) {
      // Too many polls held: say so (the forwarder backs off) instead of an empty reply it would repeat at once.
      if (this.waiters.size >= this.maxWaiters) {
        throw new IngestError(503, 'too many outbox polls open; retry later', `${this.maxWaiters} outbox long polls open (${sourceId})`, OUTBOX_BUSY_RETRY_S, 'outbox-busy')
      }
      result = await this.waitOutbox(res, sourceId, index, waitMs)
      const after = this.sources.get(sourceId)
      if (after) this.seen(after)
    }
    if (res.destroyed || res.writableEnded) return
    sendJSON(res, 200, result)
  }

  /** New answer and inbox files of a source after cursor index `index` (none for an unknown source). */
  outboxFrom(sourceId: string, index: number): OutboxResult {
    const src = this.sources.get(sourceId)
    if (!src) return { cursor: `${this.epoch}-0`, files: [] }
    this.scanOutbox(src)
    const start = Math.min(Math.max(0, index), src.outbox.length)
    const slice = src.outbox.slice(start, start + MAX_OUTBOX_FILES)
    const files: OutboxFile[] = []
    for (const rel of slice) {
      const isAnswer = rel.startsWith('answers/')
      const content = readSmall(path.join(src.teamDir, rel), isAnswer ? MAX_ANSWER_FILE_BYTES : MAX_INBOX_FILE_BYTES)
      if (content !== null) files.push({ path: rel, content })
    }
    return { cursor: `${this.epoch}-${start + slice.length}`, files }
  }

  private scanOutbox(src: Source): void {
    const add = (rel: string) => {
      if (src.outboxSeen.has(rel)) return
      src.outboxSeen.add(rel)
      src.outbox.push(rel)
    }
    let answers: string[] = []
    try { answers = fs.readdirSync(path.join(src.teamDir, 'answers')) } catch { /* none yet */ }
    const decision = (n: string) => Number(ANSWER_FILE_RE.exec(n)![1].slice(1))
    for (const n of answers.filter((n) => ANSWER_FILE_RE.test(n)).sort((a, b) => decision(a) - decision(b))) add(`answers/${n}`)
    let inbox: string[] = []
    try { inbox = fs.readdirSync(path.join(src.teamDir, 'inbox')) } catch { /* none yet */ }
    for (const n of inbox.filter((n) => INBOX_FILE_RE.test(n)).sort()) add(`inbox/${n}`)
  }

  private waitOutbox(res: http.ServerResponse, sourceId: string, index: number, waitMs: number): Promise<OutboxResult> {
    return new Promise((resolve) => {
      let done = false
      let unsubscribe: (() => void) | null = null
      const finish = () => {
        if (done) return
        done = true
        this.waiters.delete(finish)
        clearInterval(poll)
        clearTimeout(timeout)
        unsubscribe?.()
        res.off('close', finish)
        resolve(this.outboxFrom(sourceId, index))
      }
      const check = () => {
        const src = this.sources.get(sourceId)
        if (!src) return
        if (!unsubscribe) unsubscribe = this.team.watcher(src.projectId)?.onChange(() => check()) ?? null
        this.scanOutbox(src)
        if (src.outbox.length > index) finish()
      }
      this.waiters.add(finish)
      const poll = setInterval(check, this.outboxPollMs)
      const timeout = setTimeout(finish, waitMs)
      poll.unref?.()
      timeout.unref?.()
      res.on('close', finish)
      check()
    })
  }

  // ─── Sources ─────────────────────────────────────────────────────────────

  /**
   * The source of a request whose key passed checkSourceKey, registered on first sight (its key bound then, or on
   * its first keyed request for a mirror from before keys); marks it live.
   */
  private touch(sourceId: string, project: IngestProject, keyHash: string): Source {
    let src = this.sources.get(sourceId)
    let changed = false
    if (!src) {
      src = this.register(sourceId, project, false, this.now(), keyHash)
      changed = true
    } else if (src.keyHash === null) {
      src.keyHash = keyHash
      src.lastTouch = 0 // write source.json (with the bound key's hash) now
    }
    if (src.name !== project.name || src.remoteProjectId !== project.id) {
      src.name = project.name
      src.remoteProjectId = project.id
      this.team.renameCloudProject(src.projectId, project.name)
      src.lastTouch = 0 // rewrite source.json now
      changed = true
    }
    if (this.seen(src)) changed = true
    if (changed) this.relay?.announceProjectsChanged()
    return src
  }

  /** A request from this source arrived: live again, and source.json refreshed now and then. True if it was stale. */
  private seen(src: Source): boolean {
    const now = this.now()
    src.lastSeen = now
    if (now - src.lastTouch >= SOURCE_TOUCH_MS) this.writeSourceFile(src)
    if (!src.stale) return false
    src.stale = false
    this.relay?.setStale(src.id, false)
    this.relay?.announceProjectsChanged()
    return true
  }

  /** Remove a mirror folder (a plain directory under remoteDir only). True when it is gone. */
  private removeMirror(dir: string): boolean {
    try {
      const st = fs.lstatSync(dir)
      if (st.isSymbolicLink() || !st.isDirectory()) return false
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true
      this.limitedLog.line('mirror-remove', '', `[ingest] cannot remove the mirror ${dir}: ${(e as Error).message}`)
      return false
    }
  }

  /** Forget a source: its sessions and buffers, its project, its mirror folder (with its bound key). */
  private evictSource(src: Source, why: 'idle' | 'capacity'): void {
    this.sources.delete(src.id)
    this.relay?.forgetSource(src.id)
    this.team.removeCloudProject(src.projectId)
    this.removeMirror(src.root)
    this.limitedLog.line(`evict-${why}`, '', `[ingest] removed source ${src.id} (${why === 'idle' ? 'silent for more than 24 hours' : 'longest stale, room for a new source'})`)
  }

  private register(sourceId: string, project: IngestProject, stale: boolean, lastSeen: number, keyHash: string | null): Source {
    const projectId = `cloud-${sourceId}`
    if (this.team.watcher(projectId) && !this.team.isCloudProject(projectId)) {
      throw new IngestError(409, `a local project already has the id ${projectId}`)
    }
    if (this.sources.size >= this.maxSources) {
      // Evict the source that has been stale longest; never a live one.
      const victim = [...this.sources.values()].filter((s) => s.stale).sort((a, b) => a.lastSeen - b.lastSeen)[0]
      if (!victim) throw new IngestError(503, `hub at capacity: ${this.maxSources} sources, all live; retry later`, `source cap reached, ${sourceId} not registered`, CAPACITY_RETRY_S, 'capacity-sources')
      this.evictSource(victim, 'capacity')
    }
    ensurePlainDir(this.remoteDir)
    const root = mirrorPath(this.remoteDir, sourceId)
    ensurePlainDir(root)
    const teamDir = path.join(root, '.agent-team')
    ensurePlainDir(teamDir)
    const src: Source = {
      id: sourceId, projectId, remoteProjectId: project.id, name: project.name, root, teamDir,
      lastSeq: -1, lastSeen, stale, keyHash, lastTouch: stale ? lastSeen : 0, lastWatcherKey: null, outbox: [], outboxSeen: new Set(),
    }
    this.sources.set(sourceId, src)
    this.team.addCloudProject({ id: projectId, name: project.name, path: root }, sourceId)
    if (!stale) this.writeSourceFile(src)
    return src
  }

  private writeSourceFile(src: Source): void {
    const rec: SourceFile = {
      sourceId: src.id, name: src.name, projectId: src.remoteProjectId, lastSeenAt: new Date(src.lastSeen).toISOString(),
      ...(src.keyHash ? { keyHash: src.keyHash } : {}),
    }
    try {
      writeFileAtomic(path.join(src.root, SOURCE_FILE), JSON.stringify(rec) + '\n', 0o600)
      src.lastTouch = src.lastSeen
    } catch (e) {
      this.limitedLog.line('source-file', src.id, `[ingest] cannot write ${path.join(src.root, SOURCE_FILE)}: ${(e as Error).message}`)
    }
  }

  private readSourceFile(dir: string): SourceFile | null {
    const text = readSmall(path.join(dir, SOURCE_FILE), MAX_SOURCE_FILE_BYTES)
    if (text === null) return null
    try {
      const r = JSON.parse(text) as Partial<SourceFile>
      if (typeof r.lastSeenAt !== 'string' || !Number.isFinite(Date.parse(r.lastSeenAt))) return null
      const name = typeof r.name === 'string' ? line(r.name, 'name', MAX_NAME_CHARS) : ''
      const projectId = typeof r.projectId === 'string' && PROJECT_ID_RE.test(r.projectId) ? r.projectId : path.basename(dir)
      const keyHash = typeof r.keyHash === 'string' && KEY_HASH_RE.test(r.keyHash) ? r.keyHash : undefined
      return { sourceId: path.basename(dir), name: name || path.basename(dir), projectId, lastSeenAt: r.lastSeenAt, ...(keyHash ? { keyHash } : {}) }
    } catch {
      return null
    }
  }
}
