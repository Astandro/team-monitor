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

export interface SessionInfo {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  /** Team project the session belongs to (standalone app with registered projects). */
  projectId?: string
  /** The session's first prompt, kept for the detail view; the label is the project title or folder name. */
  prompt?: string
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'watching'
