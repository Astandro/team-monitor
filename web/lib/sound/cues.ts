// Every sound the monitor can make, and which graph event plays which one.
// Pure module: no Web Audio here, so the mapping is unit tested (cues.test.ts).

export type SoundCue =
  // graph (agent-flow events)
  | 'agent_spawn'
  | 'agent_complete'
  | 'tool_start'
  | 'tool_complete'
  | 'tool_error'
  | 'handoff'
  | 'session_start'
  /** an instance left the team (the server or the owner offboarded it) */
  | 'agent_offboarded'
  // team panel (state.json changes)
  | 'decision_open'
  | 'decision_answered'
  | 'task_start'
  | 'task_review'
  | 'task_done'
  | 'task_blocked'
  | 'stage_done'

/** Most important first: when several cues fire at once they play in this order. */
export const CUE_PRIORITY: readonly SoundCue[] = [
  'decision_open',
  'task_blocked',
  'tool_error',
  'stage_done',
  'decision_answered',
  'task_done',
  'task_review',
  'task_start',
  'session_start',
  'agent_complete',
  'agent_offboarded',
  'agent_spawn',
  'handoff',
  'tool_complete',
  'tool_start',
]

/** Transition kinds produced by detectStateChanges (components/agent-visualizer/canvas). */
export type GraphTransitionKind = 'agent_spawn' | 'agent_complete' | 'tool_start' | 'tool_complete' | 'tool_error'

const GRAPH_CUES: Record<GraphTransitionKind, SoundCue> = {
  agent_spawn: 'agent_spawn',
  agent_complete: 'agent_complete',
  tool_start: 'tool_start',
  tool_complete: 'tool_complete',
  tool_error: 'tool_error',
}

export function cueForGraphTransition(kind: GraphTransitionKind): SoundCue {
  return GRAPH_CUES[kind]
}

/** Particle kinds that mean work is handed between agents (subagent dispatch and its return). */
export function isHandoffParticle(type: string): boolean {
  return type === 'dispatch' || type === 'return' || type === 'message'
}

/** Unique cues, most important first. */
export function orderCues(cues: Iterable<SoundCue>): SoundCue[] {
  const set = new Set(cues)
  return CUE_PRIORITY.filter((c) => set.has(c))
}
