import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionInfo } from './bridge-types'
import {
  applySessionRemoved,
  applySessionStarted,
  dedupeSessions,
  historyToggleLabel,
  initialSelection,
  isHistorySession,
  isLongStale,
  listSessions,
  mostRecentActive,
  parseSessionRemoved,
  STALE_HISTORY_MS,
  touchActivity,
} from './session-list'
import { sessionToShow } from './session-filter'

const NOW = Date.parse('2026-11-21T10:00:00Z')
const MIN = 60_000

type Extra = Partial<SessionInfo>
const S = (id: string, status: 'active' | 'completed', last: number, extra: Extra = {}): SessionInfo =>
  ({ id, label: id, status, startTime: 0, lastActivityTime: last, ...extra })
const cloud = (id: string, last: number, stale: boolean, extra: Extra = {}): SessionInfo =>
  S(id, 'active', last, { origin: 'cloud', sourceId: `src-${id}`, ...(stale ? { stale: true } : {}), ...extra })

// ─── Item 7: history ─────────────────────────────────────────────────────────

test('stale > 10 minutes is measured as silence since lastActivityTime, only for a stale session', () => {
  assert.equal(STALE_HISTORY_MS, 10 * MIN)
  assert.equal(isLongStale(cloud('a', NOW - 10 * MIN, true), NOW), true, 'exactly 10 minutes counts')
  assert.equal(isLongStale(cloud('a', NOW - 10 * MIN + 1, true), NOW), false)
  assert.equal(isLongStale(cloud('a', NOW - 60 * MIN, false), NOW), false, 'a live session is never long stale')
  assert.equal(isLongStale(S('local', 'active', NOW - 60 * MIN), NOW), false, 'a quiet local session is not stale')
})

test('history = completed, or stale for 10 minutes', () => {
  assert.equal(isHistorySession(S('done', 'completed', NOW), NOW), true)
  assert.equal(isHistorySession(cloud('dead', NOW - 11 * MIN, true), NOW), true)
  assert.equal(isHistorySession(cloud('blip', NOW - 2 * MIN, true), NOW), false, 'a short disconnect stays listed')
  assert.equal(isHistorySession(S('live', 'active', NOW - 30 * MIN), NOW), false)
})

test('default list hides history; the toggle shows it; counts follow', () => {
  const all = [S('live', 'active', NOW), S('done', 'completed', NOW - MIN), cloud('dead', NOW - 20 * MIN, true), cloud('blip', NOW - MIN, true)]
  const off = listSessions(all, { showHistory: false, now: NOW, selectedId: 'live' })
  assert.deepEqual(off.listed.map((s) => s.id), ['live', 'blip'])
  assert.equal(off.historyCount, 2)
  assert.equal(off.hiddenCount, 2)
  const on = listSessions(all, { showHistory: true, now: NOW, selectedId: 'live' })
  assert.deepEqual(on.listed.map((s) => s.id), ['live', 'done', 'dead', 'blip'], 'order kept')
  assert.equal(on.hiddenCount, 0)
})

test('the selected session never vanishes from under the user, history or not', () => {
  const all = [S('live', 'active', NOW), cloud('dead', NOW - 20 * MIN, true)]
  const r = listSessions(all, { showHistory: false, now: NOW, selectedId: 'dead' })
  assert.deepEqual(r.listed.map((s) => s.id), ['live', 'dead'])
  assert.equal(r.hiddenCount, 0)
  assert.equal(r.historyCount, 1)
  // so the project-sync rule keeps it selected instead of jumping away
  assert.equal(sessionToShow(r.listed, 'dead'), 'dead')
  // once something else is selected it drops out of the default list
  assert.deepEqual(listSessions(all, { showHistory: false, now: NOW, selectedId: 'live' }).listed.map((s) => s.id), ['live'])
})

test('AC1: S1 drops out of the default list once its container is silent for 10 minutes, and is in the history', () => {
  const s1 = cloud('S1', NOW, false)
  const s2 = cloud('S2', NOW, false)
  const later = NOW + 10 * MIN
  // S1's container died at NOW: the hub marks it stale, S2 keeps reporting and is selected
  const list = [{ ...s1, stale: true }, { ...s2, lastActivityTime: later }]
  const r = listSessions(list, { showHistory: false, now: later, selectedId: 'S2' })
  assert.deepEqual(r.listed.map((s) => s.id), ['S2'])
  assert.deepEqual(listSessions(list, { showHistory: true, now: later, selectedId: 'S2' }).listed.map((s) => s.id), ['S1', 'S2'])
})

test('toggle label in Indonesian with the number it would reveal', () => {
  assert.equal(historyToggleLabel(false, 3), 'Tampilkan riwayat (3)')
  assert.equal(historyToggleLabel(false, 0), 'Tampilkan riwayat')
  assert.equal(historyToggleLabel(true, 3), 'Sembunyikan riwayat')
})

test('events of a stale session (a replay) do not move its clock; live ones do, throttled', () => {
  const list = [cloud('dead', NOW - 20 * MIN, true), S('live', 'active', NOW - MIN)]
  assert.equal(touchActivity(list, 'dead', NOW), list, 'stale: unchanged, same array')
  const touched = touchActivity(list, 'live', NOW)
  assert.equal(touched.find((s) => s.id === 'live')!.lastActivityTime, NOW)
  assert.equal(touchActivity(touched, 'live', NOW + 1000), touched, 'within 5 s: unchanged')
  assert.equal(touchActivity(list, 'unknown', NOW), list)
})

// ─── Item 6: session-removed ─────────────────────────────────────────────────

test('session-removed parses only a well-formed message', () => {
  assert.equal(parseSessionRemoved({ type: 'session-removed', sessionId: 'abc' }), 'abc')
  assert.equal(parseSessionRemoved({ type: 'session-removed', sessionId: '' }), null)
  assert.equal(parseSessionRemoved({ type: 'session-removed', sessionId: 4 }), null)
  assert.equal(parseSessionRemoved({ type: 'session-ended', sessionId: 'abc' }), null)
  assert.equal(parseSessionRemoved(null), null)
})

test('removing an unselected session drops it and keeps the selection', () => {
  const list = [S('a', 'active', NOW), cloud('old', NOW - 20 * MIN, true)]
  const r = applySessionRemoved(list, 'old', 'a', NOW)
  assert.deepEqual(r.sessions.map((s) => s.id), ['a'])
  assert.equal(r.selectedId, 'a')
  assert.equal(r.selectionChanged, false)
})

test('removing the selected session moves to the most recent active one, live before stale', () => {
  const list = [
    S('done', 'completed', NOW),
    cloud('staleRecent', NOW - MIN, true),
    S('liveOlder', 'active', NOW - 5 * MIN),
    S('liveNewer', 'active', NOW - 2 * MIN),
    cloud('gone', NOW - 30 * MIN, true),
  ]
  const r = applySessionRemoved(list, 'gone', 'gone', NOW)
  assert.equal(r.selectionChanged, true)
  assert.equal(r.selectedId, 'liveNewer')
  assert.ok(!r.sessions.some((s) => s.id === 'gone'))
  // only a briefly stale one left: it is still active, so it is taken
  assert.equal(applySessionRemoved([cloud('blip', NOW - MIN, true), cloud('x', NOW, false)], 'x', 'x', NOW).selectedId, 'blip')
})

test('removing the selected session with no active one left: no selection (the empty state)', () => {
  const list = [S('done', 'completed', NOW), cloud('dead', NOW - 20 * MIN, true), cloud('x', NOW, false)]
  const r = applySessionRemoved(list, 'x', 'x', NOW)
  assert.equal(r.selectedId, null)
  assert.equal(r.selectionChanged, true)
  assert.equal(mostRecentActive([], NOW), null)
})

test('removing an unknown id changes nothing (same array)', () => {
  const list = [S('a', 'active', NOW)]
  const r = applySessionRemoved(list, 'zzz', 'a', NOW)
  assert.equal(r.sessions, list)
  assert.equal(r.selectionChanged, false)
})

// ─── Item 8: no jump to a stale or known session, no doubles ────────────────

const ctx = (selectedId: string | null, known: string[] = []) => ({ selectedId, known: new Set(known), now: NOW })

test('a new live session is added and selected (unchanged behaviour)', () => {
  const r = applySessionStarted([S('a', 'active', NOW - MIN)], S('b', 'active', NOW), ctx('a', ['a']))
  assert.deepEqual(r.sessions.map((s) => s.id), ['a', 'b'])
  assert.equal(r.select, true)
})

test('a session that arrives stale is added but never selected (AC6)', () => {
  const r = applySessionStarted([S('a', 'active', NOW)], cloud('old', NOW - 30 * MIN, true), ctx('a', ['a']))
  assert.deepEqual(r.sessions.map((s) => s.id), ['a', 'old'])
  assert.equal(r.select, false)
})

test('a replayed session-started for a known session is not doubled and does not move the view (AC6)', () => {
  const list = [S('a', 'active', NOW), cloud('c', NOW - MIN, false)]
  const r = applySessionStarted(list, cloud('c', NOW, false, { label: 'Proyek X' }), ctx('a', ['a', 'c']))
  assert.equal(r.sessions.length, 2)
  assert.equal(r.sessions.find((s) => s.id === 'c')!.label, 'c', 'label comes from session-updated, not from here')
  assert.equal(r.select, false)
  // replaying it five times still gives one entry
  let sessions = list
  for (let i = 0; i < 5; i++) sessions = applySessionStarted(sessions, cloud('c', NOW, false), ctx('a', ['a', 'c'])).sessions
  assert.equal(sessions.filter((s) => s.id === 'c').length, 1)
})

test('a known id the new session-list left out comes back without moving the view (hub restart)', () => {
  const r = applySessionStarted([S('a', 'active', NOW)], cloud('c', NOW, false), ctx('a', ['a', 'c']))
  assert.deepEqual(r.sessions.map((s) => s.id), ['a', 'c'])
  assert.equal(r.select, false)
})

test('a local session resuming from completed still takes the view (AC7, resume after inactivity)', () => {
  const list = [S('a', 'active', NOW), S('local', 'completed', NOW - 20 * MIN)]
  const r = applySessionStarted(list, S('local', 'active', NOW), ctx('a', ['a', 'local']))
  assert.equal(r.select, true)
  const local = r.sessions.find((s) => s.id === 'local')!
  assert.equal(local.status, 'active')
  assert.equal(local.lastActivityTime, NOW)
})

test('a cloud session resuming from completed does not take the view; its stale flag follows the message', () => {
  const list = [S('a', 'active', NOW), cloud('c', NOW - 20 * MIN, true, { status: 'completed' })]
  const r = applySessionStarted(list, cloud('c', NOW, false), ctx('a', ['a', 'c']))
  assert.equal(r.select, false)
  const c = r.sessions.find((s) => s.id === 'c')!
  assert.equal(c.status, 'active')
  assert.equal(c.stale, undefined)
})

test('a stale session-started for a known session keeps its last activity time (it did nothing new)', () => {
  const list = [cloud('c', NOW - 20 * MIN, true)]
  const r = applySessionStarted(list, cloud('c', NOW, true), ctx(null, ['c']))
  assert.equal(r.sessions[0].lastActivityTime, NOW - 20 * MIN)
  assert.equal(r.select, false)
})

test('the already-selected session is never re-selected (would freeze event delivery)', () => {
  const r = applySessionStarted([S('local', 'completed', NOW - MIN)], S('local', 'active', NOW), ctx('local', ['local']))
  assert.equal(r.select, false)
})

test('a session-list never doubles an id', () => {
  const list = dedupeSessions([S('a', 'active', 1), S('b', 'active', 2), S('a', 'completed', 3)])
  assert.deepEqual(list.map((s) => `${s.id}:${s.status}`), ['a:completed', 'b:active'])
})

test('first selection from a list: most recent active live session, never a stale cloud one (AC6)', () => {
  assert.equal(initialSelection([cloud('old', NOW, true), S('live', 'active', NOW - 5 * MIN)], NOW), 'live')
  assert.equal(initialSelection([cloud('dead', NOW - 30 * MIN, true), S('done', 'completed', NOW - 50 * MIN)], NOW), 'done',
    'a finished local session is still shown as before')
  assert.equal(initialSelection([cloud('dead', NOW - 30 * MIN, true)], NOW), null)
  assert.equal(initialSelection([], NOW), null)
})
