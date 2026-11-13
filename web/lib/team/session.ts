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

export type PanelView = 'loading' | 'no-projects' | 'no-data' | 'ready'

export function panelView(
  projectsLoaded: boolean,
  projects: TeamProject[],
  hasStateForSelected: boolean,
): PanelView {
  if (!projectsLoaded) return 'loading'
  if (projects.length === 0) return 'no-projects'
  return hasStateForSelected ? 'ready' : 'no-data'
}

/**
 * Keys ("<task>:<status>") that appeared since the last render and should slide in.
 * The very first paint animates nothing.
 */
export function newBubbleKeys(seen: ReadonlySet<string> | null, current: string[]): Set<string> {
  if (seen === null) return new Set()
  return new Set(current.filter((k) => !seen.has(k)))
}
