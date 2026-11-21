// Session list rules of the graph's tabs (spec 0.9.8 items 6-8). Pure: no DOM, the caller passes `now`.
//
// History (item 7). A session is history when it is `completed`, or when it is a cloud session marked `stale` whose
// last activity is 10 minutes or more ago. The client has no "stale since" time: `stale` is a boolean and the hub
// sets it after 60 s without news from the container. So the client measures the silence instead, from
// `lastActivityTime` (the hub's time of the last message from that session, or this page's time of the last live
// event it received, see touchActivity). Silence >= 10 min means the container stopped reporting at least 9 minutes
// ago, and the hub retires such a source at the same 10 minutes (CLOUD_RETIRE_AFTER_MS), so both agree to within the
// one minute the hub waits before setting `stale`. Events replayed for a stale session do not move the clock.
// The browser's clock is compared with the hub's timestamp from session-list; both are NTP-synced in practice.
//
// History is hidden from the tabs by default; "Tampilkan riwayat" shows it. The selected session is always listed,
// so a session the owner is looking at never disappears from under them: it drops out once another one is selected.

import type { SessionInfo } from './bridge-types'
import { withCloudUpdate } from './cloud-origin'
import { sessionToShow } from './session-filter'

/** Silence after which a stale cloud session counts as history. Same value as the hub's retire time. */
export const STALE_HISTORY_MS = 10 * 60_000
/** lastActivityTime is bumped at most this often per session while events stream in. */
export const ACTIVITY_THROTTLE_MS = 5_000

export const SHOW_HISTORY_LABEL = 'Tampilkan riwayat'
export const HIDE_HISTORY_LABEL = 'Sembunyikan riwayat'
export const HISTORY_HINT = 'Sesi yang sudah selesai, atau sesi cloud yang lebih dari 10 menit nggak ngirim kabar.'

/** Label of the history toggle: "Tampilkan riwayat (3)" while hidden, "Sembunyikan riwayat" while shown. */
export function historyToggleLabel(showHistory: boolean, historyCount: number): string {
  if (showHistory) return HIDE_HISTORY_LABEL
  return historyCount > 0 ? `${SHOW_HISTORY_LABEL} (${historyCount})` : SHOW_HISTORY_LABEL
}

/** Stale cloud session silent for 10 minutes or more. */
export function isLongStale(s: Pick<SessionInfo, 'stale' | 'lastActivityTime'>, now: number): boolean {
  return s.stale === true && now - s.lastActivityTime >= STALE_HISTORY_MS
}

/** Completed, or stale for long: hidden from the default list. */
export function isHistorySession(s: Pick<SessionInfo, 'status' | 'stale' | 'lastActivityTime'>, now: number): boolean {
  return s.status === 'completed' || isLongStale(s, now)
}

export interface ListedSessions {
  /** Tabs to draw, in the given order. */
  listed: SessionInfo[]
  /** History sessions among the input (the selected one included). */
  historyCount: number
  /** History sessions not drawn because the toggle is off (the selected one is always drawn). */
  hiddenCount: number
}

/** The tabs: everything with the toggle on; otherwise the non-history sessions plus the selected one. */
export function listSessions(
  sessions: readonly SessionInfo[],
  opts: { showHistory: boolean; now: number; selectedId: string | null },
): ListedSessions {
  const listed: SessionInfo[] = []
  let historyCount = 0
  let hiddenCount = 0
  for (const s of sessions) {
    const history = isHistorySession(s, opts.now)
    if (history) historyCount++
    if (!history || opts.showHistory || s.id === opts.selectedId) listed.push(s)
    else hiddenCount++
  }
  return { listed, historyCount, hiddenCount }
}

/**
 * The "Tampilkan riwayat" toggle is offered whenever the shown project has at least one history session (QA F1),
 * also when the selected history session is the only one drawn (nothing hidden) or no session is listed at all.
 */
export function historyToggleVisible(historyTotal: number, canToggle: boolean): boolean {
  return canToggle && historyTotal > 0
}

/** The tab row is drawn when there is a choice to make: two or more listed sessions, or history to toggle. */
export function showSessionTabRow(listedCount: number, historyTotal: number, canToggle: boolean): boolean {
  return listedCount > 1 || historyToggleVisible(historyTotal, canToggle)
}

/** The dot in front of a session tab (QA F6). */
export interface SessionDot {
  /** Hollow ring: a disconnected cloud session (not live right now, no green, no pulse). */
  hollow: boolean
  /** Filled green "live" dot. */
  green: boolean
  /** Pulsing: unseen activity in a session that is not shown. */
  pulse: boolean
}

/**
 * Dot rule. A disconnected (stale) cloud session: hollow. An active session: green, and pulsing while it has unseen
 * activity and is not the shown one (unchanged). A `completed` session (an ended one, e.g. under history) is never
 * green and never pulses, whatever its unseen activity: it does not look live.
 */
export function sessionDot(s: { status: SessionInfo['status']; stale: boolean; hasActivity: boolean; isSelected: boolean }): SessionDot {
  if (s.stale) return { hollow: true, green: false, pulse: false }
  if (s.status === 'completed') return { hollow: false, green: false, pulse: false }
  return { hollow: false, green: s.status === 'active' || s.hasActivity, pulse: s.hasActivity && !s.isSelected }
}

/** Live (not stale) before stale, then most recent activity first. */
function byLiveThenRecent(a: SessionInfo, b: SessionInfo): number {
  const al = a.stale === true ? 0 : 1
  const bl = b.stale === true ? 0 : 1
  if (al !== bl) return bl - al
  return b.lastActivityTime - a.lastActivityTime
}

/**
 * The most recent active session to move to (after the selected one was removed): status `active` and not history,
 * a live one before a stale one, then the most recent. Null when there is none: no selection, the empty state.
 */
export function mostRecentActive(sessions: readonly SessionInfo[], now: number, excludeId?: string): string | null {
  const pool = sessions.filter((s) => s.id !== excludeId && s.status === 'active' && !isLongStale(s, now))
  if (pool.length === 0) return null
  return [...pool].sort(byLiveThenRecent)[0].id
}

/**
 * First selection from a session-list (page load): the most recent active session, a live one before a briefly stale
 * one (mostRecentActive); with none, the most recent session that is not stale (a finished local session stays
 * viewable as before). A cloud session stale for 10 minutes or more is never picked (AC6); a briefly stale one only
 * when no live session exists (the tabs would show it anyway, lib/session-filter.ts). Null when nothing qualifies.
 */
export function initialSelection(sessions: readonly SessionInfo[], now: number): string | null {
  const active = mostRecentActive(sessions, now)
  if (active) return active
  const pool = sessions.filter((s) => s.stale !== true)
  if (pool.length === 0) return null
  return [...pool].sort((a, b) => b.lastActivityTime - a.lastActivityTime)[0].id
}

/** One entry per id (the later entry wins, at the place of the first): a replayed list never doubles a tab. */
export function dedupeSessions(sessions: readonly SessionInfo[]): SessionInfo[] {
  const at = new Map<string, number>()
  const out: SessionInfo[] = []
  for (const s of sessions) {
    if (!s || typeof s.id !== 'string') continue
    const i = at.get(s.id)
    if (i === undefined) {
      at.set(s.id, out.length)
      out.push(s)
    } else {
      out[i] = s
    }
  }
  return out
}

export interface StartedResult {
  sessions: SessionInfo[]
  /** Move the view to this session. */
  select: boolean
}

/**
 * A `session-started` message (item 8).
 * - Unknown id: added. Selected only when it is not stale and this page never saw the id before.
 * - Id in the list: updated in place (marked active, cloud fields from the message), never doubled. The view moves
 *   to it only for a local session coming back from `completed` (resume after inactivity, unchanged behaviour).
 *   A replay (hub restart, 409 epoch, forwarder re-sending) or a cloud session never moves the view.
 * - Known id that is no longer in the list (the hub's new session-list left it out): added back, not selected.
 * The already-selected session is never "selected" again (that would re-arm the switch and freeze delivery).
 * A stale message does not move lastActivityTime: the session has not done anything new.
 */
export function applySessionStarted(
  sessions: readonly SessionInfo[],
  incoming: SessionInfo,
  ctx: { selectedId: string | null; known: ReadonlySet<string>; now: number },
): StartedResult {
  const stale = incoming.stale === true
  const existing = sessions.find((s) => s.id === incoming.id)
  if (existing) {
    const resumedLocal = existing.status === 'completed' && existing.origin !== 'cloud' && incoming.origin !== 'cloud' && !stale
    const next = sessions.map((s) => s.id === incoming.id
      ? withCloudUpdate({ ...s, status: 'active' as const, lastActivityTime: stale ? s.lastActivityTime : ctx.now }, incoming)
      : s)
    return { sessions: next, select: resumedLocal && incoming.id !== ctx.selectedId }
  }
  const select = !stale && !ctx.known.has(incoming.id) && incoming.id !== ctx.selectedId
  return { sessions: [...sessions, incoming], select }
}

/**
 * The session to show instead of `replaced` (removed, closed or ended while selected; QA F3): the most recent active
 * session (mostRecentActive) among the sessions of the SAME project as `replaced`, never one of another project.
 * Same project means the same `projectId`; a session without a project is replaced only by another one without a
 * project. Null when that project has no other active session: no selection, the project's empty state.
 */
export function replacementInProject(
  sessions: readonly SessionInfo[],
  replaced: Pick<SessionInfo, 'id' | 'projectId'>,
  now: number,
): string | null {
  const project = replaced.projectId || undefined
  const sameProject = sessions.filter((s) => (s.projectId || undefined) === project)
  return mostRecentActive(sameProject, now, replaced.id)
}

/**
 * Selection fix for the shown project (index.tsx): the current one when it is listed, else the project's most recent
 * listed one (sessionToShow). With nothing listed, a selected session that is not one of the project's sessions
 * (another project's, or one no longer in the list) is dropped: null, the empty state; the graph never shows another
 * project's session (QA F3). `undefined`: nothing to change.
 */
export function selectionForProject(
  listed: SessionInfo[],
  visible: readonly SessionInfo[],
  selectedId: string | null,
): string | null | undefined {
  const next = sessionToShow(listed, selectedId)
  if (next) return next !== selectedId ? next : undefined
  if (selectedId && !visible.some((s) => s.id === selectedId)) return null
  return undefined
}

/**
 * What the graph does when the selection changes (index.tsx layout effect): 'clear' when a session was shown and
 * now none is (removed with no replacement in its project, reset): the simulation restarts empty, nothing of the
 * gone session stays drawn. 'switch' to another session; 'none' when nothing changed.
 */
export function graphChange(prevId: string | null, nextId: string | null): 'clear' | 'switch' | 'none' {
  if (nextId === null) return prevId !== null ? 'clear' : 'none'
  return nextId !== prevId ? 'switch' : 'none'
}

export interface RemovedResult {
  sessions: SessionInfo[]
  /** The selection after the removal (unchanged unless the removed session was selected). */
  selectedId: string | null
  selectionChanged: boolean
}

/**
 * A `session-removed` message (item 6): drop the session; if it was selected, move to the most recent active one of
 * the same project (replacementInProject), else to no selection (the empty state).
 */
export function applySessionRemoved(
  sessions: readonly SessionInfo[],
  sessionId: string,
  selectedId: string | null,
  now: number,
): RemovedResult {
  const kept = sessions.filter((s) => s.id !== sessionId)
  const list = kept.length === sessions.length ? (sessions as SessionInfo[]) : kept
  if (selectedId !== sessionId) return { sessions: list, selectedId, selectionChanged: false }
  const removed = sessions.find((s) => s.id === sessionId)
  const next = removed ? replacementInProject(kept, removed, now) : null
  return { sessions: list, selectedId: next, selectionChanged: true }
}

export interface EndedResult {
  sessions: SessionInfo[]
  /** Move the view to this session (null: keep the selection). */
  moveTo: string | null
}

/**
 * A `session-ended` message: the session turns `completed`, so it is history (hidden by default, listed with the
 * toggle on). If it is the shown CLOUD session (retired because a newer container of the repo went live, QA F1), the
 * view moves to the most recent active session of the same project, so the ended one leaves the default list. With
 * none in that project, or for a local session (AC7: a finished local session stays viewable), the view stays.
 */
export function applySessionEnded(
  sessions: readonly SessionInfo[],
  sessionId: string,
  selectedId: string | null,
  now: number,
): EndedResult {
  const ended = sessions.find((s) => s.id === sessionId)
  if (!ended) return { sessions: sessions as SessionInfo[], moveTo: null }
  const next = sessions.map((s) => (s.id === sessionId ? { ...s, status: 'completed' as const } : s))
  if (selectedId !== sessionId || ended.origin !== 'cloud') return { sessions: next, moveTo: null }
  return { sessions: next, moveTo: replacementInProject(next, ended, now) }
}

/**
 * An event arrived for a session: keep its lastActivityTime roughly current (once per 5 s). Not for a stale session:
 * those events are a replay of old ones, and moving the clock would keep a dead container out of the history.
 * Returns the same array when nothing changes.
 */
export function touchActivity(sessions: SessionInfo[], sessionId: string, now: number): SessionInfo[] {
  const s = sessions.find((x) => x.id === sessionId)
  if (!s || s.stale === true || now - s.lastActivityTime < ACTIVITY_THROTTLE_MS) return sessions
  return sessions.map((x) => (x.id === sessionId ? { ...x, lastActivityTime: now } : x))
}

/** `{type: 'session-removed', sessionId}` from an untrusted message; null for anything else. */
export function parseSessionRemoved(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.type !== 'session-removed' || typeof d.sessionId !== 'string' || d.sessionId === '') return null
  return d.sessionId
}
