import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionInfo } from './bridge-types'
import {
  applySessionEnded,
  applySessionRemoved,
  applySessionStarted,
  cacheOnLeave,
  type CachedGraph,
  dedupeSessions,
  graphChange,
  historyToggleLabel,
  historyToggleVisible,
  initialSelection,
  isHistorySession,
  isLongStale,
  listSessions,
  mostRecentActive,
  parseSessionRemoved,
  replacementInProject,
  selectionForProject,
  sessionDot,
  showSessionTabRow,
  STALE_HISTORY_MS,
  touchActivity,
} from './session-list'
import { sessionsForProject, sessionToShow } from './session-filter'

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

// ─── QA F3: the replacement stays inside the project ────────────────────────

test('F3: the replacement is the most recent active session of the SAME project only', () => {
  const list = [
    S('nuNewest', 'active', NOW, { projectId: 'nu' }),
    S('muOld', 'active', NOW - 9 * MIN, { projectId: 'mu' }),
    cloud('muBlip', NOW - MIN, true, { projectId: 'mu' }),
    S('muLive', 'active', NOW - 5 * MIN, { projectId: 'mu' }),
    S('muDone', 'completed', NOW, { projectId: 'mu' }),
    cloud('mu1', NOW - 30 * MIN, true, { projectId: 'mu' }),
  ]
  assert.equal(replacementInProject(list, { id: 'mu1', projectId: 'mu' }, NOW), 'muLive', 'live before stale, then newest')
  assert.equal(replacementInProject(list.filter((s) => s.id !== 'muLive' && s.id !== 'muOld'), { id: 'mu1', projectId: 'mu' }, NOW), 'muBlip')
  // nothing else active in mu: null, even though nu has a newer live session
  assert.equal(replacementInProject([list[0], list[4], list[5]], { id: 'mu1', projectId: 'mu' }, NOW), null)
  // a session without a project is replaced only by another one without a project
  assert.equal(replacementInProject([list[0], S('free', 'active', NOW - MIN)], { id: 'x' }, NOW), 'free')
  assert.equal(replacementInProject([list[0]], { id: 'x' }, NOW), null)
})

test('F3: removing the last session of project mu never selects a session of another project', () => {
  const list = [S('other', 'active', NOW, { projectId: 'nu' }), cloud('mu1', NOW - 2 * MIN, true, { projectId: 'mu' })]
  const r = applySessionRemoved(list, 'mu1', 'mu1', NOW)
  assert.equal(r.selectionChanged, true)
  assert.equal(r.selectedId, null)
  assert.deepEqual(r.sessions.map((s) => s.id), ['other'])
  // the graph is cleared: a shown session followed by no selection restarts the simulation empty
  assert.equal(graphChange('mu1', r.selectedId), 'clear')
  // and the project view keeps no selection (the other project's session is not listed in mu)
  const visible = sessionsForProject(r.sessions, 'mu')
  const { listed } = listSessions(visible, { showHistory: false, now: NOW, selectedId: null })
  assert.equal(selectionForProject(listed, visible, null), undefined)
})

test('F3: removing the selected session with another one left in its project moves there', () => {
  const list = [
    S('other', 'active', NOW, { projectId: 'nu' }),
    S('mu2', 'active', NOW - 3 * MIN, { projectId: 'mu' }),
    cloud('mu1', NOW - 2 * MIN, true, { projectId: 'mu' }),
  ]
  const r = applySessionRemoved(list, 'mu1', 'mu1', NOW)
  assert.equal(r.selectedId, 'mu2')
  assert.equal(graphChange('mu1', 'mu2'), 'switch')
})

test('F3: a selected session of another project is dropped when the shown project lists nothing', () => {
  const sessions = [S('other', 'active', NOW, { projectId: 'nu' })]
  const visible = sessionsForProject(sessions, 'mu')
  assert.equal(selectionForProject([], visible, 'other'), null)
  // a listed session of the project is taken instead (unchanged rule)
  const mu = [S('mu2', 'active', NOW, { projectId: 'mu' })]
  assert.equal(selectionForProject(mu, mu, 'other'), 'mu2')
  assert.equal(selectionForProject(mu, mu, 'mu2'), undefined)
  // a selected history session of the project stays (it is listed while selected)
  const done = [S('muDone', 'completed', NOW, { projectId: 'mu' })]
  const l = listSessions(done, { showHistory: false, now: NOW, selectedId: 'muDone' }).listed
  assert.equal(selectionForProject(l, done, 'muDone'), undefined)
})

test('graph change on a selection change: clear, switch or nothing', () => {
  assert.equal(graphChange('a', null), 'clear')
  assert.equal(graphChange(null, null), 'none')
  assert.equal(graphChange(null, 'a'), 'switch')
  assert.equal(graphChange('a', 'b'), 'switch')
  assert.equal(graphChange('a', 'a'), 'none')
})

// ─── QA F1: a retired (completed) session is reachable under "Tampilkan riwayat" ─

test('F1: the toggle is offered whenever the project has a history session, with zero or one tab listed', () => {
  assert.equal(historyToggleVisible(1, true), true)
  assert.equal(historyToggleVisible(0, true), false)
  assert.equal(historyToggleVisible(3, false), false, 'no handler: no toggle')
  assert.equal(showSessionTabRow(1, 1, true), true, 'one tab plus history: the row shows')
  assert.equal(showSessionTabRow(0, 1, true), true, 'nothing listed, only history: the row shows the toggle')
  assert.equal(showSessionTabRow(1, 0, true), false, 'one tab, no history: no row (unchanged)')
  assert.equal(showSessionTabRow(2, 0, true), true)
})

test('F1: fresh page load, S1 retired arrives completed in session-list: hidden by default, listed with the toggle', () => {
  const list = [
    cloud('S1', NOW - 12 * MIN, true, { status: 'completed', projectId: 'alpha' }),
    cloud('S2', NOW, false, { projectId: 'alpha' }),
  ]
  const sel = initialSelection(list, NOW)
  assert.equal(sel, 'S2')
  const off = listSessions(list, { showHistory: false, now: NOW, selectedId: sel })
  assert.deepEqual(off.listed.map((s) => s.id), ['S2'])
  assert.equal(off.historyCount, 1)
  assert.equal(showSessionTabRow(off.listed.length, off.historyCount, true), true, 'QA saw no row here')
  assert.equal(historyToggleLabel(false, off.hiddenCount), 'Tampilkan riwayat (1)')
  const on = listSessions(list, { showHistory: true, now: NOW, selectedId: sel })
  assert.deepEqual(on.listed.map((s) => s.id), ['S1', 'S2'])
})

test('F1: S1 selected while the page is open turns completed (session-ended): the view moves to S2 of the same project', () => {
  const list = [
    S('nuNewer', 'active', NOW, { projectId: 'nu' }),
    cloud('S1', NOW - 2 * MIN, true, { projectId: 'alpha' }),
    cloud('S2', NOW - MIN, false, { projectId: 'alpha' }),
  ]
  const r = applySessionEnded(list, 'S1', 'S1', NOW)
  assert.equal(r.sessions.find((s) => s.id === 'S1')!.status, 'completed')
  assert.equal(r.moveTo, 'S2', 'same project, not the newer session of nu')
  const alpha = sessionsForProject(r.sessions, 'alpha')
  const off = listSessions(alpha, { showHistory: false, now: NOW, selectedId: r.moveTo })
  assert.deepEqual(off.listed.map((s) => s.id), ['S2'], 'S1 left the default list')
  assert.equal(showSessionTabRow(off.listed.length, off.historyCount, true), true)
  assert.deepEqual(listSessions(alpha, { showHistory: true, now: NOW, selectedId: r.moveTo }).listed.map((s) => s.id), ['S1', 'S2'])
})

test('F1: session-ended of an unselected session, of the only session, or of a local one keeps the view', () => {
  const list = [cloud('S1', NOW - 2 * MIN, true, { projectId: 'alpha' }), cloud('S2', NOW, false, { projectId: 'alpha' })]
  const unselected = applySessionEnded(list, 'S1', 'S2', NOW)
  assert.equal(unselected.moveTo, null)
  assert.equal(unselected.sessions.find((s) => s.id === 'S1')!.status, 'completed')
  // only S1 in the project: the view stays on it (listed while selected), the toggle is still offered
  const alone = applySessionEnded([list[0]], 'S1', 'S1', NOW)
  assert.equal(alone.moveTo, null)
  const l = listSessions(alone.sessions, { showHistory: false, now: NOW, selectedId: 'S1' })
  assert.deepEqual(l.listed.map((s) => s.id), ['S1'])
  assert.equal(showSessionTabRow(l.listed.length, l.historyCount, true), true)
  // a local session that ends stays shown (AC7)
  const local = applySessionEnded([S('loc', 'active', NOW), S('loc2', 'active', NOW)], 'loc', 'loc', NOW)
  assert.equal(local.moveTo, null)
  // unknown id: nothing changes
  assert.equal(applySessionEnded(list, 'zzz', 'S2', NOW).sessions, list)
})

// ─── QA F6: the tab dot ──────────────────────────────────────────────────────

test('F6: a completed session never has the green live dot, whatever its unseen activity', () => {
  for (const hasActivity of [false, true]) {
    for (const isSelected of [false, true]) {
      assert.deepEqual(sessionDot({ status: 'completed', stale: false, hasActivity, isSelected }), { hollow: false, green: false, pulse: false })
    }
  }
})

test('F6: active and stale dots unchanged', () => {
  assert.deepEqual(sessionDot({ status: 'active', stale: false, hasActivity: false, isSelected: true }), { hollow: false, green: true, pulse: false })
  assert.deepEqual(sessionDot({ status: 'active', stale: false, hasActivity: true, isSelected: false }), { hollow: false, green: true, pulse: true })
  assert.deepEqual(sessionDot({ status: 'active', stale: false, hasActivity: true, isSelected: true }), { hollow: false, green: true, pulse: false })
  assert.deepEqual(sessionDot({ status: 'active', stale: true, hasActivity: true, isSelected: false }), { hollow: true, green: false, pulse: false })
  assert.deepEqual(sessionDot({ status: 'completed', stale: true, hasActivity: true, isSelected: false }), { hollow: true, green: false, pulse: false })
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
  assert.equal(initialSelection([cloud('blip', NOW - MIN, true)], NOW), 'blip', 'briefly stale and nothing live: shown')
  assert.equal(initialSelection([], NOW), null)
})

// ─── QA N1: page opened a few seconds after a project's only session started ─
//
// A model of the page with the same rules index.tsx and the bridge use: the selection fix for the panel's project
// (selectionForProject), the graph change (graphChange), and the snapshot cache (cacheOnLeave). `drawn` is what the
// simulation shows; `pending` is what was flushed to it and not yet taken by an animation frame (`frame`).

interface PageModel {
  sessions: SessionInfo[]
  buffers: Map<string, string[]>
  selected: string | null
  prev: string | null
  drawn: string[]
  pending: string[]
  undrawn: string | null
  cache: Map<string, CachedGraph<string[]>>
}

const page = (sessions: SessionInfo[]): PageModel => ({
  sessions,
  buffers: new Map(sessions.map((s) => [s.id, [`${s.id}:orchestrator`, `${s.id}:sub-agent`]])),
  selected: null, prev: null, drawn: [], pending: [], undrawn: null, cache: new Map(),
})

/** bridge.selectSession / auto-select, then the index.tsx layout effect in the same commit. */
function select(p: PageModel, id: string | null): void {
  p.pending = []
  p.selected = id
  const change = graphChange(p.prev, p.selected)
  if (change === 'clear') {
    p.cache.clear(); p.prev = null; p.undrawn = null; p.drawn = []
    return
  }
  if (change !== 'switch' || !p.selected) return
  if (p.prev !== null) {
    const entry = cacheOnLeave([...p.drawn], p.buffers.get(p.prev)?.length ?? 0, p.undrawn === p.prev)
    if (entry) p.cache.set(p.prev, entry)
    else p.cache.delete(p.prev)
  }
  const buf = p.buffers.get(p.selected) ?? []
  const cached = p.cache.get(p.selected)
  p.drawn = cached ? [...cached.snapshot] : []
  p.pending = buf.slice(cached ? cached.eventCount : 0)
  p.undrawn = p.pending.length > 0 ? p.selected : null
  p.prev = p.selected
}

/** The index.tsx effect that keeps the view inside the panel's project. */
function panelProject(p: PageModel, projectId: string | null, now: number): void {
  const visible = sessionsForProject(p.sessions, projectId)
  const { listed } = listSessions(visible, { showHistory: false, now, selectedId: p.selected })
  const next = selectionForProject(listed, visible, p.selected)
  if (next !== undefined) select(p, next)
}

/** An animation frame takes the flushed events. */
function frame(p: PageModel): void {
  p.drawn.push(...p.pending)
  p.pending = []
  p.undrawn = null
}

const SEC = 1000
// zeta's only session started 3 s ago; alpha (the panel's default: first project with a state) has a session that went
// stale 9 min 53 s ago: still listed, not history yet.
const zetaOnly = () => cloud('zeta1', NOW - 3 * SEC, false, { projectId: 'cloud-zeta' })
const alphaBlip = () => cloud('alpha1', NOW - 9 * MIN - 53 * SEC, true, { projectId: 'cloud-alpha' })

test('N1: page opened 3 s after the only session started, panel on another project first, then zeta picked: the session is drawn', () => {
  const p = page([alphaBlip(), zetaOnly()])
  // session-list + replay: the newest active session of any project is auto-selected and flushed
  select(p, initialSelection(p.sessions, NOW))
  assert.equal(p.selected, 'zeta1')
  // same React commit, before any animation frame: the panel's project (alpha) moves the view to alpha's session
  panelProject(p, 'cloud-alpha', NOW)
  assert.equal(p.selected, 'alpha1')
  frame(p)
  // the owner picks zeta in the team panel
  panelProject(p, 'cloud-zeta', NOW + 4 * SEC)
  frame(p)
  assert.equal(p.selected, 'zeta1')
  assert.deepEqual(p.drawn, ['zeta1:orchestrator', 'zeta1:sub-agent'], 'not the empty state "Menunggu sesi agent"')
})

test('N1: leaving a session whose flushed events were not drawn yet forgets its snapshot; a drawn one is kept', () => {
  assert.equal(cacheOnLeave(['x'], 2, true), null)
  assert.deepEqual(cacheOnLeave(['x', 'y'], 2, false), { snapshot: ['x', 'y'], eventCount: 2 })
})

test('N1: page opened 35 s after the start (alpha now history, F3 clears the graph), or with a frame before the move: shown once', () => {
  // 35 s later alpha1 is silent for over 10 minutes: alpha lists nothing, the selection is dropped (F3), graph cleared
  const late = page([alphaBlip(), cloud('zeta1', NOW + 32 * SEC - 35 * SEC, false, { projectId: 'cloud-zeta' })])
  select(late, initialSelection(late.sessions, NOW + 32 * SEC))
  panelProject(late, 'cloud-alpha', NOW + 32 * SEC)
  assert.equal(late.selected, null, 'nothing of zeta is shown under alpha (F3)')
  assert.deepEqual(late.drawn, [])
  panelProject(late, 'cloud-zeta', NOW + 36 * SEC)
  frame(late)
  assert.deepEqual(late.drawn, ['zeta1:orchestrator', 'zeta1:sub-agent'])

  // a frame drew zeta before the panel moved away: its snapshot is kept, coming back draws only what came after
  const p = page([alphaBlip(), zetaOnly()])
  select(p, initialSelection(p.sessions, NOW))
  frame(p)
  panelProject(p, 'cloud-alpha', NOW)
  frame(p)
  p.buffers.get('zeta1')!.push('zeta1:tool')
  panelProject(p, 'cloud-zeta', NOW + 4 * SEC)
  frame(p)
  assert.deepEqual(p.drawn, ['zeta1:orchestrator', 'zeta1:sub-agent', 'zeta1:tool'], 'nothing drawn twice (item 8)')
})

test('N1: zeta open and empty, then its session starts or its project becomes known: shown without a reload', () => {
  // the page is on zeta with nothing to show
  const p = page([alphaBlip()])
  panelProject(p, 'cloud-zeta', NOW)
  assert.equal(p.selected, null)
  // a new live session starts: added and selected (item 8 allows it: never seen, not stale)
  const started = applySessionStarted(p.sessions, zetaOnly(), ctx(p.selected, p.sessions.map((s) => s.id)))
  assert.equal(started.select, true)
  p.sessions = started.sessions
  p.buffers.set('zeta1', ['zeta1:orchestrator', 'zeta1:sub-agent'])
  select(p, 'zeta1')
  panelProject(p, 'cloud-zeta', NOW)
  frame(p)
  assert.deepEqual(p.drawn, ['zeta1:orchestrator', 'zeta1:sub-agent'])

  // a session listed under another project id moves to zeta (session-updated): the zeta view picks it up
  const q = page([alphaBlip(), cloud('zeta1', NOW - 3 * SEC, false, { projectId: 'cloud-elsewhere' })])
  panelProject(q, 'cloud-zeta', NOW)
  assert.equal(q.selected, null)
  q.sessions = q.sessions.map((s) => (s.id === 'zeta1' ? { ...s, projectId: 'cloud-zeta' } : s))
  panelProject(q, 'cloud-zeta', NOW)
  frame(q)
  assert.equal(q.selected, 'zeta1')
  assert.deepEqual(q.drawn, ['zeta1:orchestrator', 'zeta1:sub-agent'])
})

test('N1 neighbours: F3 and item 8 still hold around the fix', () => {
  const p = page([alphaBlip(), zetaOnly()])
  select(p, initialSelection(p.sessions, NOW))
  panelProject(p, 'cloud-alpha', NOW)
  panelProject(p, 'cloud-zeta', NOW)
  frame(p)
  // F3: switching the panel to a project with no session empties the graph; nothing of zeta stays drawn
  panelProject(p, 'cloud-nu', NOW)
  assert.equal(p.selected, null)
  assert.deepEqual(p.drawn, [])
  // item 8: a replayed session-started for a known session, or a stale new one, never moves the view
  panelProject(p, 'cloud-alpha', NOW)
  assert.equal(p.selected, 'alpha1')
  assert.equal(applySessionStarted(p.sessions, zetaOnly(), ctx(p.selected, ['alpha1', 'zeta1'])).select, false)
  assert.equal(applySessionStarted(p.sessions, cloud('old', NOW - 20 * MIN, true), ctx(p.selected, ['alpha1', 'zeta1'])).select, false)
  // removing zeta's only session while it is shown: the empty state, never alpha's session (F3)
  panelProject(p, 'cloud-zeta', NOW)
  frame(p)
  const removed = applySessionRemoved(p.sessions, 'zeta1', p.selected, NOW)
  assert.equal(removed.selectedId, null)
  p.sessions = removed.sessions
  p.buffers.delete('zeta1')
  select(p, removed.selectedId)
  assert.deepEqual(p.drawn, [])
})
