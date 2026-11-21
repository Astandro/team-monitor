/**
 * Shared types for the VS Code bridge protocol.
 *
 * These types mirror extension/src/protocol.ts and are kept separate
 * to avoid cross-project imports. When updating these, also update
 * the canonical definitions in extension/src/protocol.ts.
 */

export interface AgentEvent {
  time: number
  type: string
  payload: Record<string, unknown>
  sessionId?: string
}

/**
 * Optional fields the standalone app's server adds for a session forwarded from a cloud container (origin, sourceId,
 * stale). Web-side only: the extension never sends them.
 */
import type { CloudFields } from './cloud-origin'

export interface SessionInfo extends CloudFields {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  /** Team project the session belongs to (standalone app with registered projects). */
  projectId?: string
  /** The session's first prompt, kept for the detail view; the label is the project title or folder name. */
  prompt?: string
  /** The session's coordinator instance (state.json meta.coordinator), shown on the main node. */
  coordinator?: { name: string; role: string }
}

/** `session-updated` message fields the UI keeps. */
export interface SessionUpdate extends CloudFields {
  sessionId: string
  label: string
  projectId?: string
  prompt?: string
  coordinator?: { name: string; role: string }
}

/**
 * `session-removed` (hub intake, spec 0.9.8 item 5/6, revised): a cloud session was evicted (capacity, or the 24 h
 * mirror expired); a retired one only ends and stays listed as completed. Never sent for a local session. The client
 * drops it from the list; if it was selected, the view moves to the most recent active session of the same project,
 * else to the empty state (web/lib/session-list.ts applySessionRemoved).
 */
export interface SessionRemovedMessage {
  type: 'session-removed'
  sessionId: string
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'watching'
