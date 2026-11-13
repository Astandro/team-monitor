// The selected session's coordinator, for the main node's label. The canvas draws from frame data, not React
// props, so the visualizer sets it here when the session or its coordinator changes (same pattern as the cost
// panel's top offset).
import { agentIdentity, type AgentIdentity, type CoordinatorInfo, type IdentitySource } from '@/lib/agent-identity'

let coordinator: CoordinatorInfo | null = null

export function setCanvasCoordinator(c: CoordinatorInfo | null): void {
  coordinator = c
}

export function canvasIdentity(agent: IdentitySource): AgentIdentity {
  return agentIdentity(agent, coordinator)
}
