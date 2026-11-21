// Data contract of <project>/.agent-team/state.json as served by /api/team/*.
// Everything is optional on purpose: the coordinator writes the file by hand and the panel must never crash on it.

import type { ChatEntry, WatcherInfo } from './chat'
import type { CloudFields } from '../cloud-origin'

export type TaskStatus = 'todo' | 'running' | 'review' | 'done' | 'blocked'

export interface TeamMeta {
  title?: string
  headline?: string
  status?: string
  statusText?: string
  stageLabel?: string
  budget?: string
  updatedAt?: string
  /** The coordinator instance of this project (D23): {name, role}. */
  coordinator?: { name?: string; role?: string }
}

export interface TeamStage {
  kind?: string
  label?: string
  sub?: string
  order?: number
  status?: string
  progress?: number
}

export interface TeamTask {
  title?: string
  stage?: string
  order?: number
  status?: string
  note?: string
  agent?: string
}

export interface TeamAgent {
  nick?: string
  name?: string
  model?: string
  desk?: string
  status?: string
  task?: string
  reportsTo?: string
  order?: number
  /** Set with status "offboarding": when the instance retired; it leaves the tree 60 minutes later. */
  finishedAt?: string
}

export interface TeamApproval {
  title?: string
  question?: string
  options?: string[]
  recommended?: string
  answer?: string
  status?: string
  askedAt?: string
  answeredAt?: string
  order?: number
  /**
   * Optional: the agent that asked (a key of `agents`, or its name or nick). While the decision is open its node on
   * the graph shows "Butuh jawaban owner"; without it the coordinator's node does (lib/owner-decision.ts).
   */
  agent?: string
}

export interface TeamLogRow {
  t?: string
  from?: string
  to?: string
  kind?: string
  who?: string
  text?: string
}

export interface TeamState {
  meta?: TeamMeta
  stages?: Record<string, TeamStage>
  tasks?: Record<string, TeamTask>
  agents?: Record<string, TeamAgent>
  approvals?: Record<string, TeamApproval>
  log?: Record<string, TeamLogRow>
}

export interface TeamProject extends CloudFields {
  id: string
  name: string
  hasState: boolean
}

export interface TeamStatePayload {
  type?: string
  project?: string
  state?: TeamState | null
  error?: string | null
  updatedAt?: string
  /** When the hub last wrote this project's state.json (ISO); null without a state file, absent from an older hub. */
  stateMtime?: string | null
  /** Chat thread, oldest first (spec-chat). Next to `state`, so it works when state.json is missing. */
  chat?: ChatEntry[]
  /** Is the coordinator's inbox watcher running. */
  watcher?: WatcherInfo
}
