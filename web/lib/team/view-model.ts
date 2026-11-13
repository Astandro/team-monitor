// state.json -> what the panel draws. Pure: no DOM, no clock (the caller passes `now`).
// Rule O2/O3: ids (task keys, agent ids, decision keys) never become display text, and no title is ever cut.
import {
  avatarTone,
  normalizeTaskStatus,
  projectStatusLabel,
  relativeTime,
  taskStatusLabel,
  type AvatarTone,
} from './labels'
import type { TaskStatus, TeamAgent, TeamApproval, TeamState } from './types'

export interface BuildOptions {
  now: number
  /** Answers just sent from this browser that the server has not echoed back yet (decision key -> text). */
  localAnswers?: Record<string, string>
  /** Fallback title when meta.title is empty. */
  projectName?: string
}

export interface MemberVM {
  id: string
  nick: string
  model: string
  role: string
  initial: string
  tone: AvatarTone
  working: boolean
  task: string
}

export interface TaskVM {
  id: string
  title: string
  status: TaskStatus
  statusLabel: string
  note: string
  who: string
  tone: AvatarTone
  initial: string
}

export interface DecisionVM {
  /** Key used only to send the answer; never displayed. */
  id: string
  title: string
  question: string
  options: { label: string; recommended: boolean }[]
  recommendedBy: string
  open: boolean
  answer: string
}

export interface StageVM {
  id: string
  label: string
  sub: string
  status: 'todo' | 'active' | 'done'
  percent: number
  marker: string
}

export interface LogVM {
  id: string
  text: string
  time: string
}

export interface TeamVM {
  title: string
  statusText: string
  stagesDone: number
  stagesTotal: number
  tasksDone: number
  tasksTotal: number
  /** One entry per task in display order: 'd' done, 'r' running, 'v' review, '' anything else. */
  dots: ('d' | 'r' | 'v' | '')[]
  openDecisions: number
  lead: MemberVM | null
  members: MemberVM[]
  live: TaskVM[]
  queue: TaskVM[]
  decisions: DecisionVM[]
  stages: StageVM[]
  log: LogVM[]
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function entries<T>(map: Record<string, T> | undefined | null): [string, T][] {
  if (!map || typeof map !== 'object') return []
  return Object.entries(map).filter(([, v]) => v && typeof v === 'object')
}

function byOrderThenKey<T extends { order?: number }>(a: [string, T], b: [string, T]): number {
  const d = num(a[1].order) - num(b[1].order)
  if (d !== 0 && !Number.isNaN(d)) return d
  return a[0].localeCompare(b[0], undefined, { numeric: true })
}

function initialOf(nick: string): string {
  const ch = Array.from(nick.trim())[0]
  return ch ? ch.toUpperCase() : '?'
}

function buildMember(id: string, a: TeamAgent, tasks: Record<string, { title?: string }>): MemberVM {
  const nick = str(a.nick) || str(a.name) || 'Anggota tim'
  const name = str(a.name)
  const model = str(a.model)
  const working = a.status === 'working'
  // agent.task may be a free-text sentence or the key of a task: show the title, never the key.
  const rawTask = str(a.task)
  const asTask = rawTask && Object.prototype.hasOwnProperty.call(tasks, rawTask) ? str(tasks[rawTask]?.title) : ''
  return {
    id,
    nick,
    model,
    role: name,
    initial: initialOf(nick),
    tone: avatarTone(a.desk, a.model),
    working,
    task: working ? asTask || rawTask : '',
  }
}

export function buildDecisions(
  approvals: Record<string, TeamApproval> | undefined,
  recommendedBy: string,
  localAnswers: Record<string, string> = {},
): DecisionVM[] {
  const list = entries(approvals).sort(byOrderThenKey)
  const out: DecisionVM[] = list.map(([id, ap]) => {
    const local = str(localAnswers[id])
    const serverAnswer = str(ap.answer)
    const answered = ap.status === 'answered' || serverAnswer !== '' || local !== ''
    const recommended = str(ap.recommended)
    const options = (Array.isArray(ap.options) ? ap.options : [])
      .filter((o): o is string => typeof o === 'string' && o.trim() !== '')
      .map((o) => ({ label: o, recommended: recommended !== '' && o.trim() === recommended }))
    return {
      id,
      title: str(ap.title) || str(ap.question) || 'Keputusan',
      question: str(ap.title) ? str(ap.question) : '',
      options,
      recommendedBy,
      open: !answered,
      answer: serverAnswer || local,
    }
  })
  // open first; the sort above already put them in order, and Array#sort is stable.
  return out.sort((a, b) => Number(b.open) - Number(a.open))
}

export function buildTeamVM(state: TeamState | null | undefined, opts: BuildOptions): TeamVM {
  const s: TeamState = state && typeof state === 'object' ? state : {}
  const meta = s.meta ?? {}
  const stageEntries = entries(s.stages).sort(byOrderThenKey)
  const stageOrder = new Map(stageEntries.map(([id], i) => [id, i]))
  const agents = entries(s.agents)
  const taskMap = (s.tasks && typeof s.tasks === 'object' ? s.tasks : {}) as Record<string, { title?: string }>

  const sortedAgents = agents.slice().sort(byOrderThenKey)
  const leadEntry = sortedAgents.find(([, a]) => a.desk === 'coordinator')
  const lead = leadEntry ? buildMember(leadEntry[0], leadEntry[1], taskMap) : null
  const members = sortedAgents
    .filter(([id]) => !leadEntry || id !== leadEntry[0])
    .map(([id, a]) => buildMember(id, a, taskMap))
  const byAgent = new Map(sortedAgents.map(([id, a]) => [id, buildMember(id, a, taskMap)]))

  const taskEntries = entries(s.tasks).sort((a, b) => {
    const d = num(a[1].order) - num(b[1].order)
    if (d !== 0 && !Number.isNaN(d)) return d
    const sa = stageOrder.get(str(a[1].stage)) ?? Number.POSITIVE_INFINITY
    const sb = stageOrder.get(str(b[1].stage)) ?? Number.POSITIVE_INFINITY
    if (sa !== sb) return sa < sb ? -1 : 1
    return a[0].localeCompare(b[0], undefined, { numeric: true })
  })
  const tasks: TaskVM[] = taskEntries.map(([id, t]) => {
    const status = normalizeTaskStatus(t.status)
    const who = byAgent.get(str(t.agent))
    return {
      id,
      title: str(t.title) || 'Task tanpa judul',
      status,
      statusLabel: taskStatusLabel(status),
      note: str(t.note),
      who: who ? [who.nick, who.model].filter(Boolean).join(' · ') : '',
      tone: who ? who.tone : 'lead',
      initial: who ? who.initial : '·',
    }
  })
  const live = tasks.filter((t) => t.status === 'running' || t.status === 'review' || t.status === 'blocked')
  // waiting first, finished after; each group keeps the task order
  const queue = [...tasks.filter((t) => t.status === 'todo'), ...tasks.filter((t) => t.status === 'done')]

  const coordinatorNick = lead?.nick ?? ''
  const decisions = buildDecisions(
    s.approvals,
    coordinatorNick ? `Saran ${coordinatorNick}` : 'Saran koordinator',
    opts.localAnswers,
  )

  const stages: StageVM[] = stageEntries.map(([id, st], i) => {
    const status = st.status === 'done' ? 'done' : st.status === 'active' ? 'active' : 'todo'
    const p = typeof st.progress === 'number' && Number.isFinite(st.progress) ? st.progress : status === 'done' ? 1 : 0
    return {
      id,
      label: str(st.label) || `Tahap ${i + 1}`,
      sub: str(st.sub),
      status,
      percent: Math.round(Math.min(1, Math.max(0, p)) * 100),
      marker: status === 'done' ? '✓' : String(i + 1),
    }
  })

  const log: LogVM[] = entries(s.log)
    .map(([id, row]) => ({ id, text: str(row.text), t: Date.parse(str(row.t)), iso: row.t }))
    .filter((r) => r.text !== '')
    .sort((a, b) => (Number.isNaN(b.t) ? -Infinity : b.t) - (Number.isNaN(a.t) ? -Infinity : a.t))
    .slice(0, 20)
    .map((r) => ({ id: r.id, text: r.text, time: relativeTime(r.iso, opts.now) }))

  return {
    title: str(meta.title) || opts.projectName || 'Tim',
    statusText: str(meta.statusText) || projectStatusLabel(meta.status),
    stagesDone: stages.filter((x) => x.status === 'done').length,
    stagesTotal: stages.length,
    tasksDone: tasks.filter((t) => t.status === 'done').length,
    tasksTotal: tasks.length,
    dots: tasks.map((t) => (t.status === 'done' ? 'd' : t.status === 'running' ? 'r' : t.status === 'review' ? 'v' : '')),
    openDecisions: decisions.filter((d) => d.open).length,
    lead,
    members,
    live,
    queue,
    decisions,
    stages,
    log,
  }
}
