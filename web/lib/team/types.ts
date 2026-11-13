// Data contract of <project>/.agent-team/state.json as served by /api/team/*.
// Everything is optional on purpose: the coordinator writes the file by hand and the panel must never crash on it.

export type TaskStatus = 'todo' | 'running' | 'review' | 'done' | 'blocked'

export interface TeamMeta {
  title?: string
  headline?: string
  status?: string
  statusText?: string
  stageLabel?: string
  budget?: string
  updatedAt?: string
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

export interface TeamProject {
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
}
