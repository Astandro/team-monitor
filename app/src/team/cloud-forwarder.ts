/**
 * Cloud forwarder (spec cloud section B): runs in a Claude Code cloud container next to the container's own
 * monitor and keeps the hub (the owner's local monitor with `--ingest`) up to date.
 *
 * - Events: reads the container monitor's `/events` (SSE) and posts its messages to `POST /api/ingest/v1/events`,
 *   one request at a time, in order (flush every 1 s or at 100 queued items). `session-list` becomes one
 *   `session-started` per session. Unsent items are capped (oldest dropped, one log line).
 * - State: puts `.agent-team/state.json` and `.watcher` (`PUT /api/ingest/v1/state`) whenever either changes.
 * - Outbox: long-polls `GET /api/ingest/v1/outbox` and writes the answer and inbox files it returns atomically into
 *   `<project>/.agent-team/answers|inbox/`, so `wait-answer` in the container sees them as if written locally.
 *
 * No duplicate events on the hub (the hub appends, it does not dedupe):
 * - `seq` is `max(last used + 1, Date.now())` and the last used value is persisted, so a restarted forwarder never
 *   reuses a lower value. A request that failed in transit is retried with the same seq and body; the hub answers a
 *   repeat with `duplicate: true`, which counts as acknowledged.
 * - Live `agent-event`s are always new. An `agent-event-batch` is only ever the replay the monitor sends to a new
 *   `/events` client, so its events are matched against what the hub already acknowledged: a short hash of each
 *   acknowledged event is persisted per session (the last 6000 per session, more than the monitor's 5000-event
 *   replay buffer) together with what is queued or in flight; replayed events found there are skipped (as a
 *   multiset, so equal events are counted, not collapsed).
 * - The monitor regenerates its events with new times when it restarts, so hashes cannot match across a monitor
 *   restart. The monitor instance (pid and start time from `<home>/cloud/monitor.json`) is stored with the hashes;
 *   when it changed, the replay of a session the hub already has is recorded as acknowledged and not sent (the
 *   hub keeps its earlier copy; events of that session between the last acknowledged post and the monitor restart
 *   may be missing on the hub). Replays of sessions the hub has not seen are sent in full.
 *
 * Hub restart: every hub response carries the hub's epoch (random per hub start); events posts name the epoch the
 * forwarder knows. When the hub's epoch changes (a 409 on a post, or any response with another epoch), the
 * forwarder forgets what that hub acknowledged, drops its queue and reconnects to `/events`: the session list and the
 * replay are then sent again, so running and idle sessions reappear on the hub with label, prompt and history.
 *
 * The token: `Authorization: Bearer <TEAM_MONITOR_INGEST_TOKEN>`, or a placeholder that the cloud platform's proxy
 * replaces with the environment's network secret for the hub host. The source key (`<home>/cloud/source-key`,
 * 32 random bytes as hex, 0600, made at the first start) goes in `X-Team-Monitor-Source-Key` on every request: the
 * hub binds it to this sourceId, so another holder of the token cannot read or write this source. Neither is logged.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { loadOrCreateToken } from './auth'
import { INBOX_FILE_RE, MAX_INBOX_FILE_BYTES } from './chat'
import { agentTeamDir } from './config'
import { HEARTBEAT_FILE } from './heartbeat'
import { hubRequest, HubResponse } from './hub-client'
import { EPOCH_HEADER, jsonTooDeep, MAX_EVENT_BYTES, MAX_JSON_DEPTH, SOURCE_KEY_HEADER } from './ingest'
import { SESSION_ID_RE } from './offboard'
import { writeFileAtomic } from './service'
import { ANSWER_FILE_RE, MAX_ANSWER_FILE_BYTES, MAX_STATE_BYTES } from './state-watcher'

/** Sent when TEAM_MONITOR_INGEST_TOKEN is not set: the cloud platform's proxy swaps it for the network secret. */
export const PLACEHOLDER_TOKEN = 'team-monitor-network-secret'
export const ACKED_FILE = 'forwarder-acked.json'
export const STATUS_FILE = 'forwarder-status.json'
export const MONITOR_FILE = 'monitor.json'
export const SOURCE_KEY_FILE = 'source-key'
export const CLOUD_DIR = 'cloud'
const EPOCH_RE = /^[0-9a-f]{1,64}$/
/** Hashes kept per session: more than the monitor's replay buffer (5000 events). */
export const MAX_HASHES_PER_SESSION = 6000
export const MAX_ACKED_SESSIONS = 20
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/
/** Below the hub's 512 KB, 500 messages and 5000 batched events per request. */
const MAX_BODY_BYTES = 448 * 1024
const MAX_REQUEST_MESSAGES = 400
const MAX_REQUEST_EVENTS = 4000
const LIFECYCLE = new Set(['session-started', 'session-updated', 'session-ended', 'agents-offboarded'])
/** In an events body an event is nested in 4 levels (body, messages, batch message, events); the whole body must stay
 *  within the hub's MAX_JSON_DEPTH. */
const MAX_EVENT_DEPTH = MAX_JSON_DEPTH - 4

export function cloudDir(home: string): string {
  return path.join(home, CLOUD_DIR)
}

/** Create `<home>/cloud` (0700). */
export function ensureCloudDir(home: string): string {
  const dir = cloudDir(home)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function eventHash(event: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 16)
}

/** Identity of the running container monitor (`<home>/cloud/monitor.json`, written by `cloud start`). */
export function readMonitorInstance(home: string): string {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(cloudDir(home), MONITOR_FILE), 'utf-8')) as { pid?: unknown; startedAt?: unknown }
    if (typeof m.pid === 'number' && typeof m.startedAt === 'string') return `${m.pid}@${m.startedAt}`
  } catch { /* not started by cloud start */ }
  return 'unknown'
}

// ─── Acknowledged events (persisted) ───────────────────────────────────────

interface AckedSession { at: number; h: string[] }

export class AckStore {
  lastSeq = 0
  instance: string | null = null
  /** The hub epoch the acknowledged hashes belong to (null: not known yet). */
  hubEpoch: string | null = null
  private sessions = new Map<string, AckedSession>()
  private counts = new Map<string, Map<string, number>>()

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { lastSeq?: unknown; instance?: unknown; hubEpoch?: unknown; sessions?: unknown }
      if (typeof raw.lastSeq === 'number' && Number.isSafeInteger(raw.lastSeq) && raw.lastSeq >= 0) this.lastSeq = raw.lastSeq
      if (typeof raw.instance === 'string') this.instance = raw.instance
      if (typeof raw.hubEpoch === 'string' && EPOCH_RE.test(raw.hubEpoch)) this.hubEpoch = raw.hubEpoch
      if (raw.sessions && typeof raw.sessions === 'object') {
        for (const [sid, v] of Object.entries(raw.sessions as Record<string, unknown>)) {
          const s = v as { at?: unknown; h?: unknown }
          if (!SESSION_ID_RE.test(sid) || !Array.isArray(s?.h)) continue
          this.sessions.set(sid, { at: typeof s.at === 'number' ? s.at : 0, h: s.h.filter((x): x is string => typeof x === 'string') })
        }
      }
    } catch { /* first start or unreadable: start empty */ }
  }

  has(sid: string): boolean { return this.sessions.has(sid) }
  sessionIds(): string[] { return [...this.sessions.keys()] }

  /** How often each hash was acknowledged for `sid`. */
  countsOf(sid: string): Map<string, number> {
    let c = this.counts.get(sid)
    if (!c) {
      c = new Map()
      for (const h of this.sessions.get(sid)?.h ?? []) c.set(h, (c.get(h) ?? 0) + 1)
      this.counts.set(sid, c)
    }
    return c
  }

  add(sid: string, hashes: string[], now: number): void {
    if (!hashes.length) return
    let s = this.sessions.get(sid)
    if (!s) {
      s = { at: now, h: [] }
      this.sessions.set(sid, s)
      if (this.sessions.size > MAX_ACKED_SESSIONS) {
        const oldest = [...this.sessions.entries()].filter(([k]) => k !== sid).sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) { this.sessions.delete(oldest[0]); this.counts.delete(oldest[0]) }
      }
    }
    s.at = now
    s.h.push(...hashes)
    if (s.h.length > MAX_HASHES_PER_SESSION) s.h.splice(0, s.h.length - MAX_HASHES_PER_SESSION)
    this.counts.delete(sid)
  }

  /** The hub lost what it had (it restarted): nothing counts as acknowledged any more. */
  clearSessions(): void {
    this.sessions.clear()
    this.counts.clear()
  }

  save(): void {
    const sessions: Record<string, AckedSession> = {}
    for (const [k, v] of this.sessions) sessions[k] = v
    writeFileAtomic(this.file, JSON.stringify({ version: 1, lastSeq: this.lastSeq, instance: this.instance, hubEpoch: this.hubEpoch, sessions }), 0o600)
  }
}

// ─── Forwarder ──────────────────────────────────────────────────────────────

type EventItem = { kind: 'event'; sid: string; hash: string; event: Record<string, unknown>; bytes: number }
type MsgItem = { kind: 'msg'; msg: Record<string, unknown>; bytes: number }
type Item = EventItem | MsgItem

interface InFlight { seq: number; items: Item[]; body: string }

export interface ForwarderOptions {
  /** Team home of the container monitor; the forwarder's files live in `<home>/cloud/`. */
  home: string
  projectPath: string
  project: { id: string; name: string }
  monitorPort: number
  /** Hub base URL (`https://<host>`); the ingest routes are below it. */
  hubUrl: string
  sourceId: string
  env?: NodeJS.ProcessEnv
  log?: (msg: string) => void
  now?: () => number
  flushMs?: number
  flushCount?: number
  maxQueue?: number
  backoffMinMs?: number
  backoffMaxMs?: number
  statePollMs?: number
  outboxWaitS?: number
  reconnectMs?: number
  /** Extra CA for the hub (tests). */
  ca?: string | Buffer
  monitorInstance?: () => string
  /** The source key (tests); default: `<home>/cloud/source-key`, created at the first start. */
  sourceKey?: string
}

/** This source's key: `<home>/cloud/source-key` (64 hex, 0600), created with 32 random bytes when missing. */
export function loadSourceKey(home: string): string {
  return loadOrCreateToken(ensureCloudDir(home), SOURCE_KEY_FILE).token
}

export interface ForwarderStatus {
  pid: number
  hub: string
  sourceId: string
  projectId: string
  lastPostAt: string | null
  lastStateAt: string | null
  lastOutboxAt: string | null
  lastError: string | null
  queued: number
  dropped: number
  /** Messages the hub accepted but ignored (`ignored` in its replies), and events refused locally as too large. */
  ignoredByHub: number
  refused: number
  /** The hub restarted this many times while this forwarder ran (sessions and history were sent again). */
  hubRestarts: number
  updatedAt: string
}

export class Forwarder {
  private readonly env: NodeJS.ProcessEnv
  private readonly log: (msg: string) => void
  private readonly now: () => number
  private readonly flushMs: number
  private readonly flushCount: number
  private readonly maxQueue: number
  private readonly backoffMin: number
  private readonly backoffMax: number
  private readonly statePollMs: number
  private readonly outboxWaitS: number
  private readonly reconnectMs: number
  private readonly hubBase: string
  private readonly acked: AckStore
  private readonly statusFile: string
  private readonly teamDir: string
  private readonly monitorInstance: () => string
  private readonly sourceKey: string

  private stopped = true
  /** Bumped when the hub restarted: results of requests and `/events` messages from before are discarded. */
  private syncGen = 0
  private lastIgnoredLog = 0
  private queue: Item[] = []
  private inFlight: InFlight | null = null
  /** Events queued or in flight, per session and hash (so a second replay does not queue them again). */
  private pending = new Map<string, Map<string, number>>()
  private posting = false
  private retryAt = 0
  private backoff: number
  private retryTimer: NodeJS.Timeout | null = null
  private timers: NodeJS.Timeout[] = []
  private sse: http.ClientRequest | null = null
  private sseRetry = 0
  private outboxAbort: AbortController | null = null
  private outboxLoop: Promise<void> | null = null
  private postLoop: Promise<void> | null = null
  private stateBusy: Promise<void> | null = null
  private lastStateKey: string | null = null
  private stateRetryAt = 0
  private stateBackoff: number
  private cursor: string | null = null
  private lastErrorLogged = new Map<string, string>()
  private lastDropLog = 0
  private statusDirty = true

  readonly stats = { posted: 0, postedEvents: 0, skippedReplay: 0, dropped: 0, refused: 0, filesWritten: 0, statePuts: 0, ignoredByHub: 0, hubRestarts: 0, outboxPolls: 0 }
  lastPostAt: number | null = null
  lastStateAt: number | null = null
  lastOutboxAt: number | null = null
  lastError: string | null = null

  constructor(private readonly opts: ForwarderOptions) {
    this.env = opts.env ?? process.env
    this.log = opts.log ?? ((m) => console.log(`${new Date().toISOString()} ${m}`))
    this.now = opts.now ?? Date.now
    this.flushMs = opts.flushMs ?? 1000
    this.flushCount = opts.flushCount ?? 100
    this.maxQueue = opts.maxQueue ?? 5000
    this.backoffMin = opts.backoffMinMs ?? 1000
    this.backoffMax = opts.backoffMaxMs ?? 30_000
    this.backoff = this.backoffMin
    this.stateBackoff = this.backoffMin
    this.statePollMs = opts.statePollMs ?? 1000
    this.outboxWaitS = opts.outboxWaitS ?? 25
    this.reconnectMs = opts.reconnectMs ?? 1000
    this.hubBase = opts.hubUrl.replace(/\/+$/, '')
    const dir = ensureCloudDir(opts.home)
    this.acked = new AckStore(path.join(dir, ACKED_FILE))
    this.statusFile = path.join(dir, STATUS_FILE)
    this.teamDir = agentTeamDir(opts.projectPath)
    this.monitorInstance = opts.monitorInstance ?? (() => readMonitorInstance(opts.home))
    this.sourceKey = opts.sourceKey ?? loadSourceKey(opts.home)
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.connectEvents()
    this.timers.push(setInterval(() => this.kick(), this.flushMs))
    this.timers.push(setInterval(() => this.stateTick(), this.statePollMs))
    this.timers.push(setInterval(() => this.writeStatus(), 1000))
    this.stateTick()
    this.outboxLoop = this.runOutbox()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const t of this.timers.splice(0)) clearInterval(t)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.sse?.destroy()
    this.sse = null
    this.outboxAbort?.abort()
    await Promise.allSettled([this.outboxLoop, this.postLoop, this.stateBusy])
    this.statusDirty = true
    this.writeStatus()
  }

  get queued(): number { return this.queue.length + (this.inFlight?.items.length ?? 0) }

  private headers(json: boolean): Record<string, string> {
    const token = this.env.TEAM_MONITOR_INGEST_TOKEN?.trim() || PLACEHOLDER_TOKEN
    return {
      Authorization: `Bearer ${token}`, [SOURCE_KEY_HEADER]: this.sourceKey, Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }
  }

  private request(method: string, route: string, body?: string, timeoutMs = 30_000, signal?: AbortSignal, extra: Record<string, string> = {}): Promise<HubResponse> {
    return hubRequest({
      method, url: `${this.hubBase}/api/ingest${route}`, headers: { ...this.headers(body !== undefined), ...extra }, body, timeoutMs,
      env: this.env, ca: this.opts.ca, signal,
    })
  }

  /**
   * Read the hub's epoch from a response. The first one is remembered; another one means the hub restarted and lost
   * its sessions: resync. True when this response came from a restarted hub (its result is then not used).
   */
  private noteEpoch(res: HubResponse): boolean {
    const raw = res.headers[EPOCH_HEADER]
    const epoch = typeof raw === 'string' ? raw.trim() : ''
    if (!EPOCH_RE.test(epoch)) return false
    if (this.acked.hubEpoch === epoch) return false
    if (this.acked.hubEpoch === null) {
      this.acked.hubEpoch = epoch
      this.saveAcked()
      return false
    }
    this.resync(epoch)
    return true
  }

  /**
   * The hub restarted: forget what the old hub acknowledged, drop the queue and what is in flight, and reconnect to
   * the monitor's `/events`: its session list and replay (all buffered history) then go to the hub again, in order.
   * The state is sent again as well.
   */
  private resync(epoch: string): void {
    this.syncGen++
    this.stats.hubRestarts++
    this.log(`[forwarder] the hub restarted: sending the sessions and their history again`)
    this.acked.hubEpoch = epoch
    this.acked.clearSessions()
    this.saveAcked()
    this.queue = []
    this.inFlight = null
    this.pending.clear()
    this.retryAt = 0
    this.backoff = this.backoffMin
    this.lastStateKey = null
    this.stateRetryAt = 0
    this.statusDirty = true
    // The 'close' handler of the current connection reconnects (after reconnectMs) and gets a fresh replay.
    this.sse?.destroy()
  }

  /** One log line per distinct problem of each loop (events, state, outbox); cleared by that loop's next success. */
  private noteError(where: string, msg: string): void {
    const line = `${where}: ${msg}`
    this.lastError = line
    this.statusDirty = true
    if (this.lastErrorLogged.get(where) !== msg) {
      this.lastErrorLogged.set(where, msg)
      this.log(`[forwarder] ${line}`)
    }
  }

  private noteOk(where: string): void {
    if (this.lastErrorLogged.delete(where)) this.log(`[forwarder] ${where}: hub reachable again`)
    if (!this.lastErrorLogged.size) this.lastError = null
    this.statusDirty = true
  }

  // ─── Monitor events (SSE) ────────────────────────────────────────────────

  private connectEvents(): void {
    if (this.stopped) return
    let done = false
    const again = () => {
      if (done) return
      done = true
      this.sse = null
      if (this.stopped) return
      this.sseRetry = Math.min(this.sseRetry ? this.sseRetry * 2 : this.reconnectMs, 5000)
      const t = setTimeout(() => this.connectEvents(), this.sseRetry)
      t.unref?.()
    }
    const port = this.opts.monitorPort
    const req = http.get({
      host: '127.0.0.1', port, path: '/events', agent: false,
      headers: { Host: `127.0.0.1:${port}`, Accept: 'text/event-stream' },
    })
    this.sse = req
    req.on('error', again)
    req.on('response', (res) => {
      if (res.statusCode !== 200) { res.resume(); again(); return }
      this.sseRetry = 0
      const replay = this.beginReplay()
      const gen = this.syncGen
      let buf = ''
      res.setEncoding('utf-8')
      res.on('data', (chunk: string) => {
        if (gen !== this.syncGen) return // a resync dropped this connection; the next one replays everything
        buf += chunk
        let i: number
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '')
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
          if (!data) continue
          let msg: unknown
          try { msg = JSON.parse(data) } catch { continue }
          if (msg && typeof msg === 'object' && !Array.isArray(msg)) this.onMonitorMessage(msg as Record<string, unknown>, replay)
        }
      })
      res.on('end', again)
      res.on('close', again)
      res.on('error', again)
    })
  }

  /** Called once per `/events` connection: decides how this connection's replay is matched. */
  private beginReplay(): { instanceChanged: boolean; known: Set<string> } {
    const instance = this.monitorInstance()
    const known = new Set(this.acked.sessionIds())
    const instanceChanged = this.acked.instance !== null && this.acked.instance !== instance && known.size > 0
    if (this.acked.instance !== instance) {
      this.acked.instance = instance
      this.saveAcked()
    }
    return { instanceChanged, known }
  }

  private onMonitorMessage(m: Record<string, unknown>, replay: { instanceChanged: boolean; known: Set<string> }): void {
    const type = m.type
    if (type === 'session-list') {
      if (!Array.isArray(m.sessions)) return
      for (const s of m.sessions) {
        if (s && typeof s === 'object' && validSid((s as { id?: unknown }).id)) this.enqueueMsg({ type: 'session-started', session: s })
      }
    } else if (typeof type === 'string' && LIFECYCLE.has(type)) {
      const sid = type === 'session-started' ? (m.session as { id?: unknown } | undefined)?.id : m.sessionId
      if (validSid(sid)) this.enqueueMsg(m)
    } else if (type === 'agent-event') {
      const ev = this.sendable(m.event)
      if (ev) this.enqueueEvent(ev, eventHash(ev))
    } else if (type === 'agent-event-batch') {
      if (!Array.isArray(m.events)) return
      this.onReplay(m.events, replay)
    }
  }

  /** A replay batch: skip what the hub already acknowledged (or what is already queued). */
  private onReplay(events: unknown[], replay: { instanceChanged: boolean; known: Set<string> }): void {
    const avail = new Map<string, Map<string, number>>()
    const skipWhole = new Map<string, string[]>()
    for (const raw of events) {
      const ev = this.sendable(raw)
      if (!ev) continue
      const sid = ev.sessionId as string
      const h = eventHash(ev)
      if (replay.instanceChanged && replay.known.has(sid)) {
        let list = skipWhole.get(sid)
        if (!list) { list = []; skipWhole.set(sid, list) }
        list.push(h)
        this.stats.skippedReplay++
        continue
      }
      let a = avail.get(sid)
      if (!a) {
        a = new Map(this.acked.countsOf(sid))
        for (const [k, n] of this.pending.get(sid) ?? []) a.set(k, (a.get(k) ?? 0) + n)
        avail.set(sid, a)
      }
      const n = a.get(h) ?? 0
      if (n > 0) { a.set(h, n - 1); this.stats.skippedReplay++; continue }
      this.enqueueEvent(ev, h)
    }
    if (skipWhole.size) {
      // The monitor restarted: its rebuilt history of a session the hub already has is taken as known.
      const now = this.now()
      for (const [sid, hashes] of skipWhole) this.acked.add(sid, hashes, now)
      this.saveAcked()
    }
  }

  /**
   * An event the hub accepts, or null: wrong shape, or larger / more deeply nested than the hub's limits (dropped here
   * with a log line, so one such event never costs the rest of its batch).
   */
  private sendable(v: unknown): Record<string, unknown> | null {
    const ev = validEvent(v)
    if (!ev) return null
    let text: string | null = null
    try { text = JSON.stringify(ev) } catch { /* not serialisable */ }
    if (text === null || Buffer.byteLength(text) > MAX_EVENT_BYTES || jsonTooDeep(text, MAX_EVENT_DEPTH)) {
      this.stats.refused++
      this.statusDirty = true
      this.log(`[forwarder] dropped one ${String(ev.type)} event: larger than ${MAX_EVENT_BYTES} bytes or nested too deeply for the hub`)
      return null
    }
    return ev
  }

  private enqueueMsg(msg: Record<string, unknown>): void {
    this.push({ kind: 'msg', msg, bytes: Buffer.byteLength(JSON.stringify(msg)) })
  }

  private enqueueEvent(event: Record<string, unknown>, hash: string): void {
    const sid = event.sessionId as string
    let p = this.pending.get(sid)
    if (!p) { p = new Map(); this.pending.set(sid, p) }
    p.set(hash, (p.get(hash) ?? 0) + 1)
    this.push({ kind: 'event', sid, hash, event, bytes: Buffer.byteLength(JSON.stringify(event)) })
  }

  private push(item: Item): void {
    this.queue.push(item)
    this.statusDirty = true
    if (this.queue.length > this.maxQueue) {
      const drop = this.queue.splice(0, this.queue.length - this.maxQueue)
      for (const it of drop) this.unpend(it)
      this.stats.dropped += drop.length
      const now = this.now()
      if (now - this.lastDropLog > 60_000) {
        this.lastDropLog = now
        this.log(`[forwarder] more than ${this.maxQueue} unsent messages: dropped the oldest (${this.stats.dropped} so far)`)
      }
    }
    if (this.queue.length >= this.flushCount) this.kick()
  }

  private unpend(it: Item): void {
    if (it.kind !== 'event') return
    const p = this.pending.get(it.sid)
    if (!p) return
    const n = (p.get(it.hash) ?? 0) - 1
    if (n > 0) p.set(it.hash, n)
    else p.delete(it.hash)
    if (!p.size) this.pending.delete(it.sid)
  }

  // ─── Posting ─────────────────────────────────────────────────────────────

  /** Start a post unless one is running, nothing waits, or a retry is due later. */
  private kick(): void {
    if (this.stopped || this.posting) return
    if (!this.inFlight && !this.queue.length) return
    const wait = this.retryAt - this.now()
    if (wait > 0) {
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.kick() }, wait)
        this.retryTimer.unref?.()
      }
      return
    }
    this.posting = true
    this.postLoop = this.postOnce().finally(() => {
      this.posting = false
      if (!this.stopped && (this.inFlight || this.queue.length >= this.flushCount)) this.kick()
    })
  }

  /** Take the next request's items off the queue: consecutive events become one `agent-event-batch`. */
  private build(): InFlight | null {
    const items: Item[] = []
    const messages: Array<Record<string, unknown>> = []
    let bytes = 512
    let events = 0
    let batch: Array<Record<string, unknown>> | null = null
    while (this.queue.length) {
      const it = this.queue[0]
      if (it.bytes > MAX_BODY_BYTES - 1024) {
        this.queue.shift()
        this.unpend(it)
        this.stats.refused++
        this.log(`[forwarder] dropped one ${it.kind === 'event' ? 'event' : 'message'} of ${it.bytes} bytes (too large for the hub)`)
        continue
      }
      const newMessage = it.kind === 'msg' || batch === null
      if (bytes + it.bytes + 64 > MAX_BODY_BYTES) break
      if (newMessage && messages.length >= MAX_REQUEST_MESSAGES) break
      if (it.kind === 'event' && events >= MAX_REQUEST_EVENTS) break
      this.queue.shift()
      items.push(it)
      bytes += it.bytes + 64
      if (it.kind === 'msg') {
        messages.push(it.msg)
        batch = null
      } else {
        events++
        if (batch === null) {
          batch = [it.event]
          messages.push({ type: 'agent-event-batch', events: batch })
        } else {
          batch.push(it.event)
        }
      }
    }
    if (!items.length) return null
    // Single events go as `agent-event`, like the monitor's own live messages.
    const shaped = messages.map((m) => (m.type === 'agent-event-batch' && (m.events as unknown[]).length === 1 ? { type: 'agent-event', event: (m.events as unknown[])[0] } : m))
    const seq = Math.max(this.acked.lastSeq + 1, this.now())
    const body = JSON.stringify({ sourceId: this.opts.sourceId, project: this.opts.project, seq, messages: shaped })
    return { seq, items, body }
  }

  private async postOnce(): Promise<void> {
    if (!this.inFlight) this.inFlight = this.build()
    const f = this.inFlight
    if (!f) return
    const gen = this.syncGen
    let res: HubResponse
    try {
      // The epoch we know: a restarted hub refuses the post (409) instead of applying it out of order.
      const extra: Record<string, string> = this.acked.hubEpoch ? { [EPOCH_HEADER]: this.acked.hubEpoch } : {}
      res = await this.request('POST', '/v1/events', f.body, 30_000, undefined, extra)
    } catch (e) {
      if (gen !== this.syncGen) return
      this.fail('posting events', (e as Error).message, null)
      return
    }
    if (gen !== this.syncGen) return // a resync dropped this request meanwhile
    if (this.noteEpoch(res)) return // the hub restarted: everything goes again from the replay
    if (res.status === 200) {
      this.settle(f)
      this.lastPostAt = this.now()
      this.stats.posted++
      this.stats.postedEvents += f.items.filter((i) => i.kind === 'event').length
      this.backoff = this.backoffMin
      this.retryAt = 0
      this.noteOk('posting events')
      this.noteIgnored(res)
    } else if (res.status === 400 || res.status === 413) {
      // The hub will refuse this body every time: drop it (and do not send it again from a replay).
      this.settle(f)
      this.stats.refused += f.items.length
      this.log(`[forwarder] hub refused ${f.items.length} message(s) (HTTP ${res.status}: ${hubError(res)}); dropped`)
    } else {
      this.fail('posting events', `HTTP ${res.status}${hubError(res) ? ` (${hubError(res)})` : ''}`, res)
    }
  }

  /** The in-flight request is done with: its events count as acknowledged, seq moves on. */
  private settle(f: InFlight): void {
    const now = this.now()
    const bySid = new Map<string, string[]>()
    for (const it of f.items) {
      this.unpend(it)
      if (it.kind !== 'event') continue
      let l = bySid.get(it.sid)
      if (!l) { l = []; bySid.set(it.sid, l) }
      l.push(it.hash)
    }
    for (const [sid, hashes] of bySid) this.acked.add(sid, hashes, now)
    this.acked.lastSeq = Math.max(this.acked.lastSeq, f.seq)
    this.inFlight = null
    this.saveAcked()
    this.statusDirty = true
  }

  /** The hub accepted the post but ignored some messages (sessions it does not let this source write): counted in
   *  the status file and logged (at most once a minute). */
  private noteIgnored(res: HubResponse): void {
    let ignored = 0
    try { ignored = Number((JSON.parse(res.body) as { ignored?: unknown }).ignored) || 0 } catch { /* no body */ }
    if (ignored <= 0) return
    this.stats.ignoredByHub += ignored
    this.statusDirty = true
    const now = this.now()
    if (now - this.lastIgnoredLog >= 60_000) {
      this.lastIgnoredLog = now
      this.log(`[forwarder] the hub ignored ${ignored} message(s) (${this.stats.ignoredByHub} so far): sessions it does not take from this source`)
    }
  }

  private fail(where: string, msg: string, res: HubResponse | null): void {
    let wait = this.backoff
    const retryAfter = Number(res?.headers['retry-after'])
    if ((res?.status === 429 || res?.status === 503) && Number.isFinite(retryAfter) && retryAfter > 0) wait = Math.max(wait, Math.min(retryAfter * 1000, this.backoffMax))
    this.retryAt = this.now() + wait
    this.backoff = Math.min(this.backoff * 2, this.backoffMax)
    this.noteError(where, msg)
  }

  private saveAcked(): void {
    try { this.acked.save() } catch (e) { this.noteError('saving acknowledged events', (e as Error).message) }
  }

  // ─── State ───────────────────────────────────────────────────────────────

  private stateTick(): void {
    if (this.stopped || this.stateBusy || this.now() < this.stateRetryAt) return
    const stateRaw = readSmall(path.join(this.teamDir, 'state.json'), MAX_STATE_BYTES)
    const watcherRaw = readSmall(path.join(this.teamDir, HEARTBEAT_FILE), 4096)
    const key = `${stateRaw ?? ''}\u0000${watcherRaw ?? ''}`
    if (key === this.lastStateKey) return
    let state: unknown = null
    if (stateRaw !== null) {
      try { state = JSON.parse(stateRaw) } catch { return /* being written by hand: next tick */ }
      if (!state || typeof state !== 'object' || Array.isArray(state)) return
    }
    let watcher: unknown = null
    if (watcherRaw !== null) {
      try { watcher = JSON.parse(watcherRaw) } catch { watcher = null }
    }
    const body = JSON.stringify({ sourceId: this.opts.sourceId, project: this.opts.project, state, watcher })
    this.stateBusy = (async () => {
      try {
        const res = await this.request('PUT', '/v1/state', body)
        if (this.noteEpoch(res)) return // resync: the state goes again on the next tick
        if (res.status === 200) {
          this.lastStateKey = key
          this.lastStateAt = this.now()
          this.stats.statePuts++
          this.stateBackoff = this.backoffMin
          this.noteOk('sending state')
        } else if (res.status === 400 || res.status === 413) {
          this.lastStateKey = key
          this.log(`[forwarder] hub refused the team state (HTTP ${res.status}: ${hubError(res)}); sent again when it changes`)
        } else {
          this.stateRetryAt = this.now() + this.stateBackoff
          this.stateBackoff = Math.min(this.stateBackoff * 2, this.backoffMax)
          this.noteError('sending state', `HTTP ${res.status}${hubError(res) ? ` (${hubError(res)})` : ''}`)
        }
      } catch (e) {
        this.stateRetryAt = this.now() + this.stateBackoff
        this.stateBackoff = Math.min(this.stateBackoff * 2, this.backoffMax)
        this.noteError('sending state', (e as Error).message)
      } finally {
        this.stateBusy = null
      }
    })()
  }

  // ─── Outbox ──────────────────────────────────────────────────────────────

  private async runOutbox(): Promise<void> {
    let backoff = this.backoffMin
    while (!this.stopped) {
      const ac = new AbortController()
      this.outboxAbort = ac
      let ok = false
      let quickEmpty = false
      let retryAfterMs = 0
      const t0 = Date.now()
      try {
        const q = new URLSearchParams({ sourceId: this.opts.sourceId, wait: String(this.outboxWaitS) })
        if (this.cursor) q.set('after', this.cursor)
        this.stats.outboxPolls++
        const res = await this.request('GET', `/v1/outbox?${q}`, undefined, (this.outboxWaitS + 15) * 1000, ac.signal)
        this.noteEpoch(res) // a restarted hub: resync (the outbox itself is read as usual; cursors restart there)
        if (res.status === 200) {
          const body = JSON.parse(res.body) as { cursor?: unknown; files?: unknown }
          const files = Array.isArray(body.files) ? body.files : []
          for (const f of files) this.writeOutboxFile(f)
          if (typeof body.cursor === 'string') this.cursor = body.cursor
          this.lastOutboxAt = this.now()
          ok = true
          // An empty reply that did not wait is never followed by an immediate new poll.
          quickEmpty = files.length === 0 && this.outboxWaitS > 0 && Date.now() - t0 < 1000
          this.noteOk('reading the outbox')
        } else if (res.status === 400 && this.cursor) {
          this.cursor = null // a cursor the hub no longer takes: start over (files are written only when changed)
          ok = true
        } else {
          const ra = Number(res.headers['retry-after'])
          if ((res.status === 503 || res.status === 429) && Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, this.backoffMax)
          this.noteError('reading the outbox', `HTTP ${res.status}${hubError(res) ? ` (${hubError(res)})` : ''}`)
        }
      } catch (e) {
        if (this.stopped) break
        this.noteError('reading the outbox', (e as Error).message)
      }
      if (ok) {
        backoff = this.backoffMin
        if (quickEmpty) await this.sleep(this.backoffMin)
        continue
      }
      await this.sleep(Math.max(backoff, retryAfterMs))
      backoff = Math.min(backoff * 2, this.backoffMax)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      this.outboxAbort?.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
  }

  /** Write one outbox file into the project, if its name and size are what the hub may send and it changed. */
  private writeOutboxFile(f: unknown): void {
    if (!f || typeof f !== 'object') return
    const { path: rel, content } = f as { path?: unknown; content?: unknown }
    if (typeof rel !== 'string' || typeof content !== 'string') return
    const m = /^(answers|inbox)\/([^/]+)$/.exec(rel)
    if (!m) return
    const [, dirName, name] = m
    const okName = dirName === 'answers' ? ANSWER_FILE_RE.test(name) : INBOX_FILE_RE.test(name)
    const cap = dirName === 'answers' ? MAX_ANSWER_FILE_BYTES : MAX_INBOX_FILE_BYTES
    if (!okName || Buffer.byteLength(content) > cap) {
      this.log(`[forwarder] ignored an outbox file with an unexpected name or size`)
      return
    }
    try {
      const dir = path.join(this.teamDir, dirName)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const st = fs.lstatSync(dir)
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dirName}/ is not a plain folder`)
      const file = path.join(dir, name)
      if (readSmall(file, cap) === content) return
      writeFileAtomic(file, content, 0o600)
      this.stats.filesWritten++
    } catch (e) {
      this.noteError('writing an outbox file', (e as Error).message)
    }
  }

  // ─── Status file ─────────────────────────────────────────────────────────

  status(): ForwarderStatus {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString())
    return {
      pid: process.pid, hub: hubOrigin(this.opts.hubUrl), sourceId: this.opts.sourceId, projectId: this.opts.project.id,
      lastPostAt: iso(this.lastPostAt), lastStateAt: iso(this.lastStateAt), lastOutboxAt: iso(this.lastOutboxAt),
      lastError: this.lastError, queued: this.queued, dropped: this.stats.dropped,
      ignoredByHub: this.stats.ignoredByHub, refused: this.stats.refused, hubRestarts: this.stats.hubRestarts,
      updatedAt: new Date(this.now()).toISOString(),
    }
  }

  private writeStatus(): void {
    if (!this.statusDirty) return
    this.statusDirty = false
    try { writeFileAtomic(this.statusFile, JSON.stringify(this.status()) + '\n', 0o600) } catch { /* next time */ }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function validSid(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID_RE.test(v)
}

/** An event the hub accepts (its shape check), or null. */
function validEvent(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const e = v as Record<string, unknown>
  if (!validSid(e.sessionId)) return null
  if (typeof e.type !== 'string' || !EVENT_TYPE_RE.test(e.type)) return null
  if (typeof e.time !== 'number' || !Number.isFinite(e.time)) return null
  if (!e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) return null
  return e
}

function hubError(res: HubResponse): string {
  try {
    const e = (JSON.parse(res.body) as { error?: unknown }).error
    return typeof e === 'string' ? e.replace(/[\x00-\x1f]+/g, ' ').slice(0, 200) : ''
  } catch {
    return ''
  }
}

/** `scheme://host[:port]` of the hub URL (no user info, path or query), for status lines. */
export function hubOrigin(url: string): string {
  try { return new URL(url).origin } catch { return '(invalid URL)' }
}

/** A small regular file's text, or null (missing, not a file, larger than `cap`). */
function readSmall(file: string, cap: number): string | null {
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.size > cap) return null
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}
