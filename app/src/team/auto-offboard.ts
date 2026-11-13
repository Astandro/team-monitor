/**
 * Auto offboarding (owner request 13 Nov, spec ui-cleanup item 6): a finished sub-agent that nobody offboarded by
 * hand is offboarded by the server `autoOffboardMinutes` (config.json, default 60) after it finished, recorded with
 * `reason: "auto"`.
 *
 * Runs in the server, so it holds with no browser open, across page reloads and across restarts:
 * - `start()` sweeps at once. After a restart the relay has already rebuilt every sub-agent of the watched sessions
 *   with its transcript's last write as `finishedAt`, so agents whose deadline passed while the server was down are
 *   offboarded before the first page load (catch-up).
 * - Then one timer runs to the next deadline (at most `MAX_SWEEP_GAP_MS` away), and the relay pokes it whenever a
 *   sub-agent spawns or completes (a newly attached session, a finish, a resume).
 * - An agent that runs again is `running` and is skipped; its next completion sets a new `finishedAt`, so its clock
 *   starts again.
 * Offboarding goes through the same store and the same `agents-offboarded` stream message as the Offboard button.
 */
import type { AutoOffboardGraph, GraphAgent } from '../../../scripts/graph-agents'
import { OffboardRecord, OffboardStore, recordFor } from './offboard'

/** Longest wait between two sweeps, also the retry delay after a failed save. */
export const MAX_SWEEP_GAP_MS = 60_000

export interface AutoOffboardClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: AutoOffboardClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
}

/** Epoch ms when an agent is due for auto offboarding, or null when it never is (Orchestrator, running, no time). */
export function autoOffboardDue(agent: GraphAgent, intervalMs: number): number | null {
  if (agent.isMain || agent.status !== 'finished') return null
  if (typeof agent.finishedAt !== 'number' || !Number.isFinite(agent.finishedAt)) return null
  return agent.finishedAt + intervalMs
}

export class AutoOffboarder {
  readonly intervalMs: number
  private readonly clock: AutoOffboardClock
  private readonly log: (msg: string) => void
  private timer: unknown = null
  private unsubscribe: (() => void) | null = null
  private running = false
  /** Earliest deadline still ahead after the last sweep (Infinity: none). */
  private nextDue = Infinity

  constructor(
    private readonly store: OffboardStore,
    private readonly graph: AutoOffboardGraph,
    minutes: number,
    opts: { clock?: AutoOffboardClock; log?: (msg: string) => void } = {},
  ) {
    this.intervalMs = minutes * 60_000
    this.clock = opts.clock ?? systemClock
    this.log = opts.log ?? console.warn
  }

  /** Catch-up sweep now, then keep sweeping at each deadline. Returns what the catch-up offboarded. */
  start(): OffboardRecord[] {
    if (this.running) return []
    this.running = true
    this.unsubscribe = this.graph.onAgentsChanged(() => this.schedule(0))
    return this.tick()
  }

  stop(): void {
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  /** Offboard every sub-agent whose deadline has come; returns the new records (none when the save failed). */
  sweep(): OffboardRecord[] {
    const now = this.clock.now()
    const at = new Date(now).toISOString()
    const records: OffboardRecord[] = []
    let next = Infinity
    for (const session of this.graph.sessions()) {
      const agents = this.graph.agents(session)
      if (!agents) continue
      let project: string | null | undefined
      for (const a of agents) {
        const due = autoOffboardDue(a, this.intervalMs)
        if (due === null || this.store.isOffboarded(session, a.name)) continue
        if (due > now) { next = Math.min(next, due); continue }
        if (project === undefined) project = this.graph.sessionProject(session)
        records.push(recordFor(session, project, a, at, 'auto'))
      }
    }
    this.nextDue = next
    if (!records.length) return []
    try {
      this.store.add(records)
    } catch (e) {
      const detail = (e as { detail?: string }).detail ?? (e as Error).message
      this.log(`[team] auto offboard could not save ${records.length} agent(s), retrying: ${detail}`)
      return []
    }
    const bySession = new Map<string, string[]>()
    for (const r of records) bySession.set(r.session, [...(bySession.get(r.session) ?? []), r.agent])
    for (const [session, names] of bySession) this.graph.announceOffboarded(session, names)
    return records
  }

  private tick(): OffboardRecord[] {
    this.timer = null
    let records: OffboardRecord[] = []
    try { records = this.sweep() } catch (e) { this.log(`[team] auto offboard sweep failed: ${(e as Error).message}`) }
    this.schedule()
    return records
  }

  /** Next sweep in `delay` ms, else at the next deadline (at most MAX_SWEEP_GAP_MS away). */
  private schedule(delay?: number): void {
    if (!this.running) return
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    const wait = delay ?? Math.min(Math.max(this.nextDue - this.clock.now(), 0), MAX_SWEEP_GAP_MS)
    this.timer = this.clock.setTimeout(() => this.tick(), wait)
  }
}
