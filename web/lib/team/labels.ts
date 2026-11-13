// Plain Indonesian labels for everything a viewer reads (owner request O2).
import type { TaskStatus } from './types'

export const OWNER_LABEL = 'Astandro · Owner'

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  running: 'Dikerjain',
  review: 'Di-review',
  blocked: 'Ketahan',
  todo: 'Antri',
  done: 'Selesai',
}

/** Unknown or missing statuses count as "todo" so a typo in state.json never hides a task. */
export function normalizeTaskStatus(raw: unknown): TaskStatus {
  return raw === 'running' || raw === 'review' || raw === 'blocked' || raw === 'done' ? raw : 'todo'
}

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS_LABEL[status]
}

const PROJECT_STATUS_LABEL: Record<string, string> = {
  running: 'Lagi jalan',
  paused: 'Dijeda',
  done: 'Selesai',
}

export function projectStatusLabel(raw: unknown): string {
  return typeof raw === 'string' && PROJECT_STATUS_LABEL[raw] ? PROJECT_STATUS_LABEL[raw] : ''
}

export type AvatarTone = 'opus' | 'sonnet' | 'lead'

export function avatarTone(desk: unknown, model: unknown): AvatarTone {
  if (desk === 'coordinator') return 'lead'
  return typeof model === 'string' && /sonnet/i.test(model) ? 'sonnet' : 'opus'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']

/** "baru saja" / "N mnt lalu" / "N jam lalu" / "13 Nov". Empty string for an unreadable date. */
export function relativeTime(iso: unknown, now: number): string {
  if (typeof iso !== 'string') return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const sec = Math.floor((now - t) / 1000)
  if (sec < 60) return 'baru saja'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} mnt lalu`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} jam lalu`
  const d = new Date(t)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}
