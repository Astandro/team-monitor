// Offboarding finished agents (D22): who may be offboarded, the requests, the graph clean-up and the
// "Selesai kontrak" rows. Pure apart from the injected fetch. Server contract: handover daichi-offboard-names-server.md.

import { isOk, postTeam, serverError, type PostFetch } from './post'
import { chatTime } from './chat'

/** Window event the graph fires when agents were offboarded, so the panel refreshes its list. */
export const OFFBOARDED_EVENT = 'tm-agents-offboarded'

/** Only a finished sub-agent can be offboarded: never the Orchestrator, never one that still runs. */
export function canOffboard(agent: { isMain?: boolean; state?: string } | null | undefined): boolean {
  return !!agent && !agent.isMain && agent.state === 'complete'
}

/** Node names of every finished sub-agent, in map order. */
export function finishedSubAgents(agents: Iterable<[string, { isMain?: boolean; state?: string }]>): string[] {
  const out: string[] = []
  for (const [id, a] of agents) if (canOffboard(a)) out.push(id)
  return out
}

interface EventLike {
  payload?: Record<string, unknown> | null
}

/** Same rule as the server's replay filter: an event belongs to an agent through payload.name, .agent or .child. */
export function eventTouches(ev: EventLike, names: ReadonlySet<string>): boolean {
  const p = ev.payload
  if (!p) return false
  for (const key of ['name', 'agent', 'child'] as const) {
    const v = p[key]
    if (typeof v === 'string' && names.has(v)) return true
  }
  return false
}

/** The buffered events without those of the offboarded agents (same array when nothing matches). */
export function dropOffboardedEvents<T extends EventLike>(events: T[], names: Iterable<string>): T[] {
  const set = new Set(names)
  if (set.size === 0) return events
  const kept = events.filter((e) => !eventTouches(e, set))
  return kept.length === events.length ? events : kept
}

/** `{sessionId, agents}` from an `agents-offboarded` stream message; null for anything else. */
export function parseOffboardedMessage(data: unknown): { sessionId: string; agents: string[] } | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.type !== 'agents-offboarded' || typeof d.sessionId !== 'string' || !Array.isArray(d.agents)) return null
  const agents = d.agents.filter((a): a is string => typeof a === 'string' && a !== '')
  return { sessionId: d.sessionId, agents }
}

export interface OffboardRecord {
  session?: string
  agent?: string
  project?: string | null
  name?: string
  role?: string | null
  task?: string | null
  finishedAt?: string | null
  offboardedAt?: string
}

export type OffboardResult =
  | { ok: true; agents: string[] }
  | { ok: false; kind: 'login' | 'error'; status: number; message: string }

export function mapOffboardError(status: number, detail: string): { kind: 'login' | 'error'; message: string } {
  switch (status) {
    case 401:
      return { kind: 'login', message: 'Sesi kamu habis. Masuk lagi dulu.' }
    case 403:
      return { kind: 'error', message: 'Server nolak permintaan ini. Muat ulang halaman lalu coba lagi.' }
    case 404:
      return { kind: 'error', message: 'Agent atau sesi ini sudah nggak ada di grafik server.' }
    case 409:
      return { kind: 'error', message: 'Agent ini masih jalan, jadi belum bisa di-offboard.' }
    case 400:
      if (/orchestrator/i.test(detail)) return { kind: 'error', message: 'Orchestrator nggak bisa di-offboard.' }
      return { kind: 'error', message: detail ? `Permintaan nggak diterima: ${detail}` : 'Permintaan nggak diterima.' }
    case 0:
      return { kind: 'error', message: 'Nggak bisa nyambung ke server. Coba lagi.' }
    default:
      return { kind: 'error', message: detail ? `Gagal offboard: ${detail}` : `Gagal offboard (kode ${status}).` }
  }
}

function recordAgents(body: Record<string, unknown>): string[] {
  const list = Array.isArray(body.offboarded) ? body.offboarded : []
  return list
    .map((r) => (r && typeof r === 'object' ? (r as OffboardRecord).agent : undefined))
    .filter((a): a is string => typeof a === 'string')
}

async function send(fetchFn: PostFetch, url: string, payload: unknown): Promise<OffboardResult> {
  const out = await postTeam(fetchFn, url, payload)
  if (isOk(out)) return { ok: true, agents: recordAgents(out.body) }
  return { ok: false, status: out.status, ...mapOffboardError(out.status, serverError(out.body)) }
}

export function offboardAgent(fetchFn: PostFetch, session: string, agent: string): Promise<OffboardResult> {
  return send(fetchFn, '/api/team/offboard', { session, agent })
}

export const NOTHING_TO_OFFBOARD = 'Belum ada yang bisa di-offboard: menurut server agent-agent ini masih jalan.'

/**
 * The button only shows when the graph sees finished agents, so an empty answer means the server still counts
 * them as running (for example a session that ended without their completion): said in plain text, not a silent no-op.
 */
export async function offboardAllFinished(fetchFn: PostFetch, session: string): Promise<OffboardResult> {
  const r = await send(fetchFn, '/api/team/offboard-all', { session })
  if (r.ok && r.agents.length === 0) return { ok: false, kind: 'error', status: 200, message: NOTHING_TO_OFFBOARD }
  return r
}

export interface OffboardRow {
  key: string
  name: string
  role: string
  task: string
  /** "Selesai 14.05 · Offboard 14.20" */
  when: string
}

/** "Selesai kontrak" rows, in server order (newest offboarded first). */
export function offboardRows(records: readonly OffboardRecord[] | null | undefined, now: number): OffboardRow[] {
  const rows: OffboardRow[] = []
  ;(Array.isArray(records) ? records : []).forEach((r, i) => {
    if (!r || typeof r !== 'object') return
    const name = (typeof r.name === 'string' && r.name.trim()) || (typeof r.agent === 'string' && r.agent.trim()) || 'Agent'
    const finished = chatTime(r.finishedAt, now)
    const off = chatTime(r.offboardedAt, now)
    const when = [finished && `Selesai ${finished}`, off && `Offboard ${off}`].filter(Boolean).join(' · ')
    rows.push({
      key: `${r.session ?? ''}:${r.agent ?? i}`,
      name,
      role: typeof r.role === 'string' ? r.role.trim() : '',
      task: typeof r.task === 'string' ? r.task.trim() : '',
      when,
    })
  })
  return rows
}
