import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionInfo } from './bridge-types'
import { sessionsForProject, sessionToShow } from './session-filter'

const S = (id: string, projectId: string | undefined, status: 'active' | 'completed', last: number): SessionInfo =>
  ({ id, label: id, status, startTime: 0, lastActivityTime: last, ...(projectId ? { projectId } : {}) })

const all = [S('hub-old', 'hub', 'completed', 10), S('hub-now', 'hub', 'active', 5), S('tm', 'tm', 'active', 50), S('codex', undefined, 'active', 1)]

test('no project chosen: every session; a project chosen: its sessions plus those without a project', () => {
  assert.deepEqual(sessionsForProject(all, null).map((s) => s.id), ['hub-old', 'hub-now', 'tm', 'codex'])
  assert.deepEqual(sessionsForProject(all, 'hub').map((s) => s.id), ['hub-old', 'hub-now', 'codex'])
  assert.deepEqual(sessionsForProject(all, 'tm').map((s) => s.id), ['tm', 'codex'])
})

test('switching project moves the graph to that project\'s most recent active session', () => {
  const hub = sessionsForProject(all, 'hub')
  assert.equal(sessionToShow(hub, 'tm'), 'hub-now', 'active beats a more recent completed one, then most recent')
  assert.equal(sessionToShow(hub.filter((s) => s.id !== 'hub-now'), 'tm'), 'codex')
  assert.equal(sessionToShow(hub, 'hub-old'), 'hub-old', 'a listed session stays selected')
  assert.equal(sessionToShow([], 'tm'), null)
})
