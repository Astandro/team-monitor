// Small pure helpers for the live connection, project choice, theme and "new bubble" detection.
import type { TeamProject, TeamState } from './types'

/** state.json counts as "has data" once the coordinator wrote at least one section into it. */
export function hasTeamData(state: TeamState | null | undefined): boolean {
  if (!state || typeof state !== 'object') return false
  return Object.values(state).some((v) => v && typeof v === 'object' && Object.keys(v).length > 0)
}

export type ThemePref = 'system' | 'light' | 'dark'

export function parseThemePref(raw: unknown): ThemePref {
  return raw === 'system' || raw === 'dark' || raw === 'light' ? raw : 'light'
}

export function nextThemePref(p: ThemePref): ThemePref {
  return p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'
}

export function themeLabel(p: ThemePref): string {
  return p === 'system' ? 'Sistem' : p === 'light' ? 'Terang' : 'Gelap'
}

/** The panel header's theme icon button: the icon shows the current choice, the label also says what a tap does. */
export function themeButton(p: ThemePref): { icon: 'sun' | 'moon' | 'auto'; label: string } {
  const icon = p === 'light' ? 'sun' : p === 'dark' ? 'moon' : 'auto'
  return { icon, label: `Tema: ${themeLabel(p)}. Ketuk untuk ganti ke ${themeLabel(nextThemePref(p))}` }
}

export function resolveTheme(p: ThemePref, systemDark: boolean): 'light' | 'dark' {
  return p === 'system' ? (systemDark ? 'dark' : 'light') : p
}

/** Backoff for reconnecting the live stream: 1s, 2s, 4s ... capped at 15s. */
export function reconnectDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  return Math.min(1000 * 2 ** Math.min(n, 10), 15000)
}

/** Which project to show: the saved one if it still exists, else the first with data, else the first. */
export function pickProject(projects: TeamProject[], saved: string | null): TeamProject | null {
  if (projects.length === 0) return null
  const keep = saved ? projects.find((p) => p.id === saved) : undefined
  return keep ?? projects.find((p) => p.hasState) ?? projects[0]
}

/** 'loading' = project list not here yet; 'connecting' = project chosen, its first state not here yet. */
export type PanelView = 'loading' | 'connecting' | 'no-projects' | 'no-data' | 'ready'

export function panelView(
  projectsLoaded: boolean,
  projects: TeamProject[],
  hasStateForSelected: boolean,
  payloadReceived: boolean,
): PanelView {
  if (!projectsLoaded) return 'loading'
  if (projects.length === 0) return 'no-projects'
  // "no data" is only true once the server has answered; before that we simply do not know yet
  if (!payloadReceived) return 'connecting'
  return hasStateForSelected ? 'ready' : 'no-data'
}

/** Answers just sent from this browser, kept per project so a late reply never lands in another project. */
export type LocalAnswers = Record<string, Record<string, string>>

export function addLocalAnswer(all: LocalAnswers, project: string, decisionId: string, answer: string): LocalAnswers {
  return { ...all, [project]: { ...(all[project] ?? {}), [decisionId]: answer } }
}

const NO_ANSWERS: Record<string, string> = {}

export function localAnswersFor(all: LocalAnswers, project: string | null): Record<string, string> {
  return (project && all[project]) || NO_ANSWERS
}

/** Plain Indonesian for the few fixed error texts the server serves in `error`. No file names, no English. */
export function plainStateError(raw: string): string {
  const t = raw.toLowerCase()
  const reason = t.includes('not valid json')
    ? 'isinya bukan JSON yang valid'
    : t.includes('json object')
      ? 'isinya harus berupa objek JSON'
      : t.includes('larger than')
        ? 'ukurannya kebesaran'
        : t.includes('not a file')
          ? 'ternyata bukan berkas biasa'
          : t.includes('cannot be read')
            ? 'berkasnya nggak bisa dibuka'
            : ''
  return `Catatan tim lagi nggak bisa dibaca${reason ? ` (${reason})` : ''}. Yang tampil data terakhir yang valid.`
}

/**
 * Keys ("<task>:<status>") that appeared since the last render and should slide in.
 * The very first paint animates nothing.
 */
export function newBubbleKeys(seen: ReadonlySet<string> | null, current: string[]): Set<string> {
  if (seen === null) return new Set()
  return new Set(current.filter((k) => !seen.has(k)))
}
