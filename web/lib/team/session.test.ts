import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  hasTeamData,
  newBubbleKeys,
  nextThemePref,
  panelView,
  parseThemePref,
  pickProject,
  reconnectDelay,
  resolveTheme,
} from './session'
import { relativeTime } from './labels'

const P = (id: string, hasState: boolean) => ({ id, name: id, hasState })

test('pickProject keeps the saved choice, else the first with data, else the first', () => {
  const list = [P('a', false), P('b', true), P('c', true)]
  assert.equal(pickProject(list, 'c')?.id, 'c')
  assert.equal(pickProject(list, 'gone')?.id, 'b')
  assert.equal(pickProject(list, null)?.id, 'b')
  assert.equal(pickProject([P('a', false)], null)?.id, 'a')
  assert.equal(pickProject([], 'a'), null)
})

test('panelView: loading, no projects, no data yet, ready', () => {
  assert.equal(panelView(false, [], false), 'loading')
  assert.equal(panelView(true, [], false), 'no-projects')
  assert.equal(panelView(true, [P('a', false)], false), 'no-data')
  assert.equal(panelView(true, [P('a', true)], true), 'ready')
})

test('hasTeamData is false for null, empty and all-empty sections', () => {
  assert.equal(hasTeamData(null), false)
  assert.equal(hasTeamData({}), false)
  assert.equal(hasTeamData({ meta: {}, tasks: {} }), false)
  assert.equal(hasTeamData({ meta: { title: 'X' } }), true)
  assert.equal(hasTeamData({ tasks: { t1: { title: 'a' } } }), true)
})

test('theme preference defaults to light and cycles system, light, dark', () => {
  assert.equal(parseThemePref(null), 'light')
  assert.equal(parseThemePref('banana'), 'light')
  assert.equal(parseThemePref('dark'), 'dark')
  assert.equal(nextThemePref('system'), 'light')
  assert.equal(nextThemePref('light'), 'dark')
  assert.equal(nextThemePref('dark'), 'system')
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('light', true), 'light')
})

test('reconnect delay doubles and stops at 15 seconds', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(reconnectDelay), [1000, 2000, 4000, 8000, 15000, 15000, 15000])
  assert.equal(reconnectDelay(-3), 1000)
})

test('nothing slides in on first paint; only unseen task+status pairs do afterwards', () => {
  assert.equal(newBubbleKeys(null, ['a:running']).size, 0)
  const next = newBubbleKeys(new Set(['a:running']), ['a:running', 'a:review', 'b:running'])
  assert.deepEqual([...next].sort(), ['a:review', 'b:running'])
})

test('relative time in Indonesian', () => {
  const now = new Date(2026, 10, 13, 12, 0, 0).getTime()
  const at = (ms: number) => new Date(now - ms).toISOString()
  assert.equal(relativeTime(at(20_000), now), 'baru saja')
  assert.equal(relativeTime(at(5 * 60_000), now), '5 mnt lalu')
  assert.equal(relativeTime(at(3 * 3_600_000), now), '3 jam lalu')
  assert.equal(relativeTime(new Date(2026, 10, 10, 9, 0).toISOString(), now), '10 Nov')
  assert.equal(relativeTime('bukan tanggal', now), '')
  assert.equal(relativeTime(undefined, now), '')
})
