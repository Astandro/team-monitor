// Who an agent on the graph is, for a reader: a personal name with the standard role under it
// ("Hiro · Frontend Engineer"), owner decisions D22/D23. Pure.
//
// Sources (server contract, handover daichi-offboard-names-server.md):
// - sub-agent spawn payload: `displayName` + `role` when the Agent description reads "<Name> (<role>): <task>";
// - main node: the session's `coordinator` ({name, role}) wins over the main spawn payload (which keeps the value
//   from spawn time); the role defaults to "Orchestrator".
// Anything missing falls back to the label the graph showed before.

import { agentDisplayName } from './readable-labels'

export const ORCHESTRATOR_ROLE = 'Orchestrator'

export interface CoordinatorInfo {
  name: string
  role: string
}

export interface AgentIdentity {
  name: string
  /** Empty when the agent has no known role. */
  role: string
}

/** The fields of an agent node this module reads. */
export interface IdentitySource {
  name: string
  isMain?: boolean
  displayName?: string
  role?: string
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Name parts carried by an `agent_spawn` payload (only the ones that are there). */
export function spawnIdentity(payload: Record<string, unknown>): { displayName?: string; role?: string } {
  const displayName = text(payload.displayName)
  const role = text(payload.role)
  return {
    ...(displayName ? { displayName } : {}),
    ...(displayName && role ? { role } : {}),
  }
}

/** `{name, role}` from a session's or a state.json's coordinator field; null when it has no name. */
export function parseCoordinator(raw: unknown): CoordinatorInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = text(o.name)
  if (!name) return null
  return { name, role: text(o.role) || ORCHESTRATOR_ROLE }
}

/** Name and role to show for a node. `coordinator` is the selected session's, used for the main node only. */
export function agentIdentity(agent: IdentitySource, coordinator?: CoordinatorInfo | null): AgentIdentity {
  if (agent.isMain) {
    const c = coordinator ?? parseCoordinator({ name: agent.displayName, role: agent.role })
    if (c) return { name: c.name, role: c.role || ORCHESTRATOR_ROLE }
    return { name: agentDisplayName(agent.name), role: '' }
  }
  const displayName = text(agent.displayName)
  if (displayName) return { name: displayName, role: text(agent.role) }
  return { name: agentDisplayName(agent.name), role: '' }
}

/** One line: "Hiro · Frontend Engineer", or just the name when there is no role. */
export function identityLine(id: AgentIdentity): string {
  return id.role ? `${id.name} · ${id.role}` : id.name
}
