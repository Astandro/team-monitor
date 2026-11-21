// state.json -> what the panel draws. Pure: no DOM, no clock (the caller passes `now`).
// Rule O2/O3: ids (task keys, agent ids, decision keys) never become display text, and no title is ever cut.
import { autoOffboardText } from '../disintegration'
import {
  avatarTone,
  normalizeTaskStatus,
  projectStatusLabel,
  taskStatusLabel,
  type AvatarTone,
} from './labels'
import { memberPhase } from './members'
import type { TaskStatus, TeamAgent, TeamApproval, TeamState } from './types'
import type { OffboardRecord } from './offboard'
import { isOffboardedMember, pickLeadId } from './lead'

export interface BuildOptions {
  now: number
  /** Answers just sent from this browser that the server has not echoed back yet (decision key -> text). */
  localAnswers?: Record<string, string>
  /** Fallback title when meta.title is empty. */
  projectName?: string
  /** The hub's offboard list of this project ("Selesai kontrak"): those members leave the tree (lead.ts). */
  offboarded?: readonly OffboardRecord[] | null
}

export interface MemberVM {
  id: string
  nick: string
  model: string
  role: string
  initial: string
  tone: AvatarTone
  /** The team lead: its bot avatar has the lead look (web/lib/bot-avatar.ts) */
  isLead: boolean
  /** A coordinator entry that is not the lead (lead.ts): drawn in the Disintegrating group, not under the lead. */
  retired: boolean
  working: boolean
  task: string
  /** 'offboarding': retired, breaking up over the hour after finishedAt (see members.ts). */
  phase: 'working' | 'idle' | 'offboarding'
  /** 0..1 through the offboarding hour; 0 otherwise. */
  progress: number
  /** "Keluar otomatis 15.05 (23 menit lagi)" while offboarding; empty otherwise. */
  leaving: string
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
  /** Who the bot avatar is drawn for (the member's nick; empty when nobody is named) */
  avatarName: string
  avatarLead: boolean
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

function buildMember(
  id: string,
  a: TeamAgent,
  tasks: Record<string, { title?: string }>,
  now: number,
  leadId: string | null,
): MemberVM {
  const nick = str(a.nick) || str(a.name) || 'Anggota tim'
  const name = str(a.name)
  const model = str(a.model)
  const phase = memberPhase(a, now)
  const working = phase.kind === 'working'
  const offboarding = phase.kind === 'offboarding'
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
    isLead: id === leadId,
    retired: a.desk === 'coordinator' && id !== leadId,
    working,
    task: working ? asTask || rawTask : '',
    phase: offboarding ? 'offboarding' : working ? 'working' : 'idle',
    progress: offboarding ? phase.progress : 0,
    leaving: !offboarding ? '' : phase.clock ? autoOffboardText(phase.clock, now) : 'Selesai, lagi keluar dari tim',
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
  // The tree shows the current team only: a member past finishedAt + 60 min is gone even if still in the file.
  const presentAgents = sortedAgents.filter(([, a]) => memberPhase(a, opts.now).kind !== 'gone')
  // Exactly one lead (AC5); other coordinator entries are retired (lead.ts)
  const leadId = pickLeadId(presentAgents, meta, opts.now)
  // Members the hub offboarded leave the tree, even when state.json still lists them (spec 0.9.8 item 9)
  const shownAgents = presentAgents.filter(([id, a]) => id === leadId || !isOffboardedMember(id, a, opts.offboarded))
  const leadEntry = leadId ? shownAgents.find(([id]) => id === leadId) : undefined
  const lead = leadEntry ? buildMember(leadEntry[0], leadEntry[1], taskMap, opts.now, leadId) : null
  const members = shownAgents
    .filter(([id]) => id !== leadId)
    .map(([id, a]) => buildMember(id, a, taskMap, opts.now, leadId))
  // Task rows still name whoever did them, gone or not.
  const byAgent = new Map(sortedAgents.map(([id, a]) => [id, buildMember(id, a, taskMap, opts.now, leadId)]))

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
      avatarName: who ? who.nick : '',
      avatarLead: who ? who.isLead : false,
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

  // `log` stays in state.json but is not shown: the graph covers it (spec-panel-compact item 5).

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
  }
}
