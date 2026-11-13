/**
 * Offboarded agents (owner decision D22, spec offboard-names item 1): a finished sub-agent can be "offboarded",
 * like a finished contract. It leaves the graph and is listed under "Selesai kontrak".
 *
 * Stored in `<team home>/offboarded.json` (0600, temp file + fsync + rename), keyed by session id and the agent's
 * node name on the graph. Transcripts are never touched; only this file is written.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { GraphAgent, GraphView, OffboardLookup } from '../../../scripts/graph-agents'

export const OFFBOARD_FILE = 'offboarded.json'
export const MAX_OFFBOARD_FILE_BYTES = 5 * 1024 * 1024
export const MAX_OFFBOARD_BODY_BYTES = 4 * 1024
/** Claude Code session ids are UUIDs; Codex ids are similar. Anything else is refused before any lookup. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
/** Same cap as a sub-agent node name (CHILD_NAME_MAX in extension/src/constants.ts). */
export const MAX_AGENT_NAME_CHARS = 200

export interface OffboardRecord {
  /** Claude Code session id. */
  session: string
  /** Node name on the graph (`agent_spawn.payload.name`; for sub-agents the full Agent description). */
  agent: string
  /** Registry id of the session's project, or null. */
  project: string | null
  /** Personal name ("Hiro"), else the node name. */
  name: string
  /** Role ("Frontend Engineer"), or null when the description did not name one. */
  role: string | null
  /** What it did: the task part of the description, else the spawn task, else null. */
  task: string | null
  /** ISO time the agent finished, or null when unknown. */
  finishedAt: string | null
  /** ISO time it was offboarded. */
  offboardedAt: string
  /** "manual": from the UI (Offboard button, offboard-all); "auto": by the server `autoOffboardMinutes` after it
   *  finished (spec ui-cleanup item 6). Records saved before this field existed read as "manual". */
  reason: OffboardReason
}

export type OffboardReason = 'manual' | 'auto'

export class OffboardError extends Error {
  /** `message` goes to the client (no paths); `detail` is for the server log only. */
  constructor(readonly status: 400 | 404 | 409 | 500 | 503, message: string, readonly detail?: string) {
    super(message)
  }
}

type StoredRecord = Omit<OffboardRecord, 'session' | 'agent'>

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

/** A stored entry; `reason` may be missing (files written before auto offboarding: read as "manual"). */
function validStored(v: unknown): v is Omit<StoredRecord, 'reason'> & { reason?: OffboardReason } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  return typeof r.name === 'string' && isNullableString(r.project) && isNullableString(r.role) && isNullableString(r.task)
    && isNullableString(r.finishedAt) && typeof r.offboardedAt === 'string'
    && (r.reason === undefined || r.reason === 'manual' || r.reason === 'auto')
}

export class OffboardStore implements OffboardLookup {
  readonly file: string
  private bySession = new Map<string, Map<string, OffboardRecord>>()
  /** The file on disk could not be read as a store; it is moved to `offboarded.json.bad` before the first save. */
  private keepBadFile = false

  constructor(readonly home: string, private readonly log: (msg: string) => void = console.warn) {
    this.file = path.join(home, OFFBOARD_FILE)
    this.load()
  }

  private load(): void {
    let st: fs.Stats
    try { st = fs.lstatSync(this.file) } catch { return }
    if (!st.isFile()) {
      this.log(`[team] ${this.file} is not a regular file; starting with no offboarded agents`)
      this.keepBadFile = true
      return
    }
    if (st.size > MAX_OFFBOARD_FILE_BYTES) {
      this.log(`[team] ${this.file} is larger than ${MAX_OFFBOARD_FILE_BYTES} bytes; starting with no offboarded agents`)
      this.keepBadFile = true
      return
    }
    let data: unknown
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf-8'))
    } catch {
      this.log(`[team] ${this.file} is not valid JSON; starting with no offboarded agents (kept as ${OFFBOARD_FILE}.bad on the next save)`)
      this.keepBadFile = true
      return
    }
    const sessions = data && typeof data === 'object' ? (data as { sessions?: unknown }).sessions : undefined
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
      this.log(`[team] ${this.file} has no "sessions" object; starting with no offboarded agents`)
      this.keepBadFile = true
      return
    }
    let skipped = 0
    for (const [sid, agents] of Object.entries(sessions as Record<string, unknown>)) {
      if (!SESSION_ID_RE.test(sid) || !agents || typeof agents !== 'object' || Array.isArray(agents)) { skipped++; continue }
      for (const [agent, rec] of Object.entries(agents as Record<string, unknown>)) {
        if (!agent || !validStored(rec)) { skipped++; continue }
        this.put({ session: sid, agent, ...pickStored({ ...rec, reason: rec.reason ?? 'manual' }) })
      }
    }
    if (skipped) this.log(`[team] ${this.file}: ${skipped} malformed entr${skipped === 1 ? 'y' : 'ies'} ignored`)
  }

  private put(rec: OffboardRecord): void {
    let m = this.bySession.get(rec.session)
    if (!m) { m = new Map(); this.bySession.set(rec.session, m) }
    m.set(rec.agent, rec)
  }

  isOffboarded(sessionId: string, agent: string): boolean {
    return this.bySession.get(sessionId)?.has(agent) ?? false
  }

  get(sessionId: string, agent: string): OffboardRecord | undefined {
    const r = this.bySession.get(sessionId)?.get(agent)
    return r ? { ...r } : undefined
  }

  /** Records, newest offboarding first, optionally only one project's or one session's. */
  list(filter: { project?: string; session?: string } = {}): OffboardRecord[] {
    const out: OffboardRecord[] = []
    for (const [sid, agents] of this.bySession) {
      if (filter.session !== undefined && sid !== filter.session) continue
      for (const r of agents.values()) {
        if (filter.project !== undefined && r.project !== filter.project) continue
        out.push({ ...r })
      }
    }
    return out.sort((a, b) => (a.offboardedAt < b.offboardedAt ? 1 : a.offboardedAt > b.offboardedAt ? -1 : 0))
  }

  /** Add records and save. All or nothing: when the file cannot be written, memory is left unchanged. */
  add(records: OffboardRecord[]): void {
    if (!records.length) return
    const next = new Map<string, Map<string, OffboardRecord>>()
    for (const [sid, agents] of this.bySession) next.set(sid, new Map(agents))
    for (const r of records) {
      let m = next.get(r.session)
      if (!m) { m = new Map(); next.set(r.session, m) }
      m.set(r.agent, { ...r })
    }
    this.save(next)
    this.bySession = next
  }

  private save(data: Map<string, Map<string, OffboardRecord>>): void {
    // Null-prototype objects: an agent named "__proto__" must stay a plain key.
    const sessions: Record<string, Record<string, StoredRecord>> = Object.create(null)
    for (const [sid, agents] of data) {
      const out: Record<string, StoredRecord> = Object.create(null)
      for (const [agent, r] of agents) out[agent] = pickStored(r)
      sessions[sid] = out
    }
    const text = JSON.stringify({ version: 1, sessions }, null, 2) + '\n'
    const tmp = path.join(this.home, `.${OFFBOARD_FILE}.${crypto.randomBytes(6).toString('hex')}.tmp`)
    let fd: number | null = null
    try {
      if (this.keepBadFile) {
        try { fs.renameSync(this.file, this.file + '.bad') } catch { /* gone already */ }
      }
      fd = fs.openSync(tmp, 'wx', 0o600)
      fs.writeSync(fd, text)
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = null
      fs.renameSync(tmp, this.file)
      this.keepBadFile = false
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd) } catch { /* ignore */ } }
      try { fs.unlinkSync(tmp) } catch { /* already gone */ }
      throw new OffboardError(500, 'cannot save offboarded agents', `could not write ${this.file}: ${(e as Error).message}`)
    }
    try {
      const dfd = fs.openSync(this.home, 'r')
      try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
    } catch { /* not supported everywhere; the rename is already atomic */ }
  }
}

function pickStored(r: StoredRecord): StoredRecord {
  return {
    project: r.project, name: r.name, role: r.role, task: r.task, finishedAt: r.finishedAt, offboardedAt: r.offboardedAt,
    reason: r.reason,
  }
}

// ─── Request bodies ─────────────────────────────────────────────────────────

export interface OffboardOneInput { session: string; agent: string }

function parseSession(body: unknown): { obj: Record<string, unknown>; session: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OffboardError(400, 'body must be a JSON object')
  const obj = body as Record<string, unknown>
  const session = obj.session
  if (typeof session !== 'string' || !SESSION_ID_RE.test(session)) throw new OffboardError(400, 'session must be a session id')
  return { obj, session }
}

/** `{"session": "<id>", "agent": "<node name>"}`. Throws OffboardError(400). */
export function parseOffboardBody(body: unknown): OffboardOneInput {
  const { obj, session } = parseSession(body)
  const agent = obj.agent
  if (typeof agent !== 'string' || !agent) throw new OffboardError(400, 'agent is required')
  if (agent.length > MAX_AGENT_NAME_CHARS) throw new OffboardError(400, `agent is longer than ${MAX_AGENT_NAME_CHARS} characters`)
  return { session, agent }
}

/** `{"session": "<id>"}`. Throws OffboardError(400). */
export function parseOffboardAllBody(body: unknown): { session: string } {
  return { session: parseSession(body).session }
}

// ─── Operations ─────────────────────────────────────────────────────────────

function iso(ms: number | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export function recordFor(
  session: string, project: string | null, a: GraphAgent, offboardedAt: string, reason: OffboardReason = 'manual',
): OffboardRecord {
  return {
    session,
    agent: a.name,
    project,
    name: a.displayName ?? a.name,
    role: a.role ?? null,
    task: a.task ?? null,
    finishedAt: iso(a.finishedAt),
    offboardedAt,
    reason,
  }
}

function sessionAgents(graph: GraphView | null, session: string): GraphAgent[] {
  if (!graph) throw new OffboardError(503, 'graph is not running')
  const agents = graph.agents(session)
  if (!agents) throw new OffboardError(404, 'unknown session')
  return agents
}

/**
 * Offboard one finished sub-agent. 404 unknown session or agent, 400 the Orchestrator, 409 still running.
 * Offboarding an agent twice returns the first record and writes nothing.
 */
export function offboardAgent(
  store: OffboardStore,
  graph: GraphView | null,
  input: OffboardOneInput,
  now: () => Date = () => new Date(),
): { record: OffboardRecord; created: boolean } {
  const agents = sessionAgents(graph, input.session)
  const agent = agents.find((a) => a.name === input.agent)
  if (!agent) throw new OffboardError(404, 'unknown agent')
  if (agent.isMain) throw new OffboardError(400, 'the Orchestrator cannot be offboarded')
  const existing = store.get(input.session, agent.name)
  if (existing) return { record: existing, created: false }
  if (agent.status === 'running') throw new OffboardError(409, 'agent is still running')
  const record = recordFor(input.session, graph!.sessionProject(input.session), agent, now().toISOString())
  store.add([record])
  graph!.announceOffboarded(input.session, [record.agent])
  return { record, created: true }
}

/** Offboard every finished sub-agent of a session that is not offboarded yet; returns the new records. */
export function offboardFinished(
  store: OffboardStore,
  graph: GraphView | null,
  session: string,
  now: () => Date = () => new Date(),
): OffboardRecord[] {
  const agents = sessionAgents(graph, session)
  const at = now().toISOString()
  const project = graph!.sessionProject(session)
  const records = agents
    .filter((a) => !a.isMain && a.status === 'finished' && !store.isOffboarded(session, a.name))
    .map((a) => recordFor(session, project, a, at))
  store.add(records)
  if (records.length) graph!.announceOffboarded(session, records.map((r) => r.agent))
  return records
}
