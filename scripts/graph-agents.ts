/**
 * What the relay knows about the agents on the graph, per session, and which of their events a viewer may see
 * (spec offboard-names item 1).
 *
 * The relay feeds every buffered event through `observe()`, so for each session it knows every agent node, whether
 * it is running or finished, when it finished, and the instance name parts from its spawn payload. The offboard
 * endpoint asks this registry (a running agent cannot be offboarded), and the graph stream uses `isVisible()`:
 * the events of an offboarded agent are never sent while it is not running, neither on replay (page load, server
 * restart) nor live. A running agent is always shown, even when it was offboarded earlier.
 */
import type { AgentEvent } from '../extension/src/protocol'

export type GraphAgentStatus = 'running' | 'finished'

export interface GraphAgent {
  /** Node name on the graph (for sub-agents the full Agent description); the key for offboarding. */
  name: string
  isMain: boolean
  status: GraphAgentStatus
  /** From the spawn payload, when the description had the "<Name> (<role>): <task>" form. */
  displayName?: string
  role?: string
  task?: string
  /** Epoch ms of the last spawn and of the last completion. */
  spawnedAt: number
  finishedAt?: number
}

export interface OffboardLookup {
  isOffboarded(sessionId: string, agent: string): boolean
}

export const NO_OFFBOARDING: OffboardLookup = { isOffboarded: () => false }

/** Agent names an event is about: `name` (spawn, complete, idle), `agent` (tools, messages, context, model,
 *  permission), `child` (dispatch, return). `parent` is not included: a parent's own events carry its name. */
export function eventAgentNames(event: AgentEvent): string[] {
  const p = event.payload ?? {}
  const out: string[] = []
  for (const key of ['name', 'agent', 'child'] as const) {
    const v = (p as Record<string, unknown>)[key]
    if (typeof v === 'string' && v) out.push(v)
  }
  return out
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

export class GraphAgents {
  private bySession = new Map<string, Map<string, GraphAgent>>()

  /** Update the registry from one event. `finishedAt` overrides the completion time (e.g. the transcript's mtime
   *  for a sub-agent rebuilt as finished after a restart). */
  observe(event: AgentEvent, now: number = Date.now(), finishedAt?: number): void {
    const sid = event.sessionId
    if (!sid) return
    const name = str(event.payload?.name)
    if (!name) return
    if (event.type === 'agent_spawn') {
      let agents = this.bySession.get(sid)
      if (!agents) { agents = new Map(); this.bySession.set(sid, agents) }
      const p = event.payload
      const prev = agents.get(name)
      agents.set(name, {
        name,
        isMain: p.isMain === true || prev?.isMain === true,
        status: 'running',
        displayName: str(p.displayName) ?? prev?.displayName,
        role: str(p.role) ?? prev?.role,
        task: str(p.task) ?? prev?.task,
        spawnedAt: now,
      })
    } else if (event.type === 'agent_complete') {
      const agent = this.bySession.get(sid)?.get(name)
      if (!agent) return
      agent.status = 'finished'
      agent.finishedAt = finishedAt ?? now
    }
  }

  /** Sub-agents of a session that are running now (for finishing them when the session ends). */
  runningSubagents(sessionId: string): string[] {
    const agents = this.bySession.get(sessionId)
    return agents ? [...agents.values()].filter((a) => !a.isMain && a.status === 'running').map((a) => a.name) : []
  }

  hasSession(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  agent(sessionId: string, name: string): GraphAgent | undefined {
    const a = this.bySession.get(sessionId)?.get(name)
    return a ? { ...a } : undefined
  }

  /** Every agent of the session in spawn order, or null when the session has none. */
  agents(sessionId: string): GraphAgent[] | null {
    const agents = this.bySession.get(sessionId)
    return agents ? [...agents.values()].map((a) => ({ ...a })) : null
  }

  /** Offboarded and not running (an agent the registry never saw counts as not running). */
  isHidden(sessionId: string, name: string, lookup: OffboardLookup): boolean {
    if (!lookup.isOffboarded(sessionId, name)) return false
    return this.bySession.get(sessionId)?.get(name)?.status !== 'running'
  }

  isVisible(event: AgentEvent, lookup: OffboardLookup): boolean {
    const sid = event.sessionId
    if (!sid) return true
    return !eventAgentNames(event).some((n) => this.isHidden(sid, n, lookup))
  }

  visibleEvents(events: readonly AgentEvent[], lookup: OffboardLookup): AgentEvent[] {
    return events.filter((e) => this.isVisible(e, lookup))
  }

  /**
   * Observe a live event and decide whether open streams get it. A spawn is judged after it is observed (an
   * offboarded agent that runs again shows up again). A completion is judged before, so open viewers still see a
   * running offboarded agent finish; `hide` then names the agents that just became hidden, for an
   * `agents-offboarded` message.
   */
  /**
   * A sub-agent's `agent_complete` with `finishedAt` (ISO) and, when auto offboarding is on, `autoOffboardAt` (ISO)
   * added to its payload (spec ui-cleanup item 6), so every viewer, also on replay, can draw the time left. Other
   * events, the Orchestrator's completion and completions of agents the registry never saw come back unchanged.
   * Call before `admit()`, with the same `finishedAt` that `admit()` gets.
   */
  annotateCompletion(event: AgentEvent, finishedAt: number, autoOffboardMs?: number): AgentEvent {
    if (event.type !== 'agent_complete' || !event.sessionId) return event
    const name = str(event.payload?.name)
    const agent = name ? this.bySession.get(event.sessionId)?.get(name) : undefined
    if (!agent || agent.isMain || !Number.isFinite(finishedAt)) return event
    const payload: Record<string, unknown> = { ...event.payload, finished: true, finishedAt: new Date(finishedAt).toISOString() }
    if (typeof autoOffboardMs === 'number' && autoOffboardMs > 0) payload.autoOffboardAt = new Date(finishedAt + autoOffboardMs).toISOString()
    return { ...event, payload }
  }

  admit(event: AgentEvent, lookup: OffboardLookup, now: number = Date.now(), finishedAt?: number): { send: boolean; hide: string[] } {
    const before = this.isVisible(event, lookup)
    this.observe(event, now, finishedAt)
    if (event.type !== 'agent_complete') return { send: this.isVisible(event, lookup), hide: [] }
    const sid = event.sessionId
    const name = str(event.payload?.name)
    const hide = before && sid && name && this.isHidden(sid, name, lookup) ? [name] : []
    return { send: before, hide }
  }
}

/** What the team API reads from the graph (implemented by the relay). */
export interface GraphView {
  /** Every agent of a watched Claude session, or null when the graph does not know the session. */
  agents(sessionId: string): GraphAgent[] | null
  /** Registry id of the session's project, or null when it has none (start-folder fallback, unknown session). */
  sessionProject(sessionId: string): string | null
  /** Tell open graph streams that these agents were offboarded (`agents-offboarded` message). */
  announceOffboarded(sessionId: string, agents: string[]): void
}

/** What the auto offboarder needs on top of `GraphView` (implemented by the relay; spec ui-cleanup item 6). */
export interface AutoOffboardGraph extends GraphView {
  /** Ids of the watched Claude sessions. */
  sessions(): string[]
  /** Called after a sub-agent spawned (became active again) or completed; returns a function that unsubscribes. */
  onAgentsChanged(listener: () => void): () => void
}
