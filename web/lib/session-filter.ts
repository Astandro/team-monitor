import type { SessionInfo } from './bridge-types'

/** Sessions to list for the project chosen in the team panel. No project chosen: all. Sessions that carry no
 *  project (start-folder fallback, Codex) are always listed. */
export function sessionsForProject(sessions: SessionInfo[], projectId: string | null | undefined): SessionInfo[] {
  if (!projectId) return sessions
  return sessions.filter((s) => !s.projectId || s.projectId === projectId)
}

/** Which session to show: the current one when it is listed, else the most recent active listed one (a live one before
 *  a stale cloud one), else the most recent listed one; null when nothing is listed or nothing needs to change. */
export function sessionToShow(listed: SessionInfo[], selectedId: string | null): string | null {
  if (listed.length === 0) return null
  if (selectedId && listed.some((s) => s.id === selectedId)) return selectedId
  const rank = (s: SessionInfo) => (s.status === 'active' ? (s.stale === true ? 1 : 2) : 0)
  const sorted = [...listed].sort((a, b) => {
    const aActive = rank(a)
    const bActive = rank(b)
    if (aActive !== bActive) return bActive - aActive
    return b.lastActivityTime - a.lastActivityTime
  })
  return sorted[0].id
}
