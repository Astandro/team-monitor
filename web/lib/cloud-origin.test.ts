import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionInfo } from './bridge-types'
import type { TeamProject } from './team/types'
import {
  CLOUD_HINT,
  cloudFields,
  NO_MARKS,
  originHint,
  originMarks,
  originSuffix,
  sameProjects,
  STALE_HINT,
  withCloudUpdate,
} from './cloud-origin'

const local: SessionInfo = { id: 's1', label: 'Proyek lokal', status: 'active', startTime: 0, lastActivityTime: 0 }
const cloud: SessionInfo = { ...local, id: 'c1', label: 'Proyek cloud', origin: 'cloud', sourceId: 'box-1' }

test('local items carry no marks; cloud and stale are read from the optional fields', () => {
  assert.equal(originMarks(local), NO_MARKS)
  assert.equal(originMarks(null), NO_MARKS)
  assert.deepEqual(originMarks(cloud), { cloud: true, stale: false })
  assert.deepEqual(originMarks({ ...cloud, stale: true }), { cloud: true, stale: true })
  assert.deepEqual(originMarks({ ...cloud, stale: false }), { cloud: true, stale: false })
})

test('unknown or malformed values mark nothing', () => {
  assert.deepEqual(originMarks({ origin: 'remote' } as never), NO_MARKS)
  assert.deepEqual(originMarks({ origin: 'cloud', stale: 'yes' } as never), { cloud: true, stale: false })
})

test('cloudFields keeps only checked values and is empty for a local message', () => {
  assert.deepEqual(cloudFields({ sessionId: 's1', label: 'x' }), {})
  assert.deepEqual(cloudFields(null), {})
  assert.deepEqual(cloudFields({ origin: 'cloud', sourceId: 'box-1', stale: true }), {
    origin: 'cloud',
    sourceId: 'box-1',
    stale: true,
  })
  assert.deepEqual(cloudFields({ origin: 'other', sourceId: 7, stale: 'true' }), {})
  assert.deepEqual(cloudFields({ origin: 'cloud', sourceId: '', stale: false }), { origin: 'cloud' })
})

test('an update on a local session without cloud fields returns the same object', () => {
  assert.equal(withCloudUpdate(local, { sessionId: 's1', label: 'y' }), local)
})

test('stale is set by an update and cleared when a later one has it false or absent', () => {
  const stale = withCloudUpdate(cloud, { origin: 'cloud', sourceId: 'box-1', stale: true })
  assert.equal(stale.stale, true)
  assert.deepEqual(originMarks(stale), { cloud: true, stale: true })

  const backFalse = withCloudUpdate(stale, { origin: 'cloud', sourceId: 'box-1', stale: false })
  assert.equal('stale' in backFalse, false)
  assert.deepEqual(originMarks(backFalse), { cloud: true, stale: false })

  const backAbsent = withCloudUpdate(stale, { label: 'z' })
  assert.equal('stale' in backAbsent, false)
  // origin and sourceId stay when the update leaves them out
  assert.equal(backAbsent.origin, 'cloud')
  assert.equal(backAbsent.sourceId, 'box-1')
})

test('an update can turn a session into a cloud one', () => {
  const s = withCloudUpdate(local, { origin: 'cloud', sourceId: 'box-2' })
  assert.deepEqual(originMarks(s), { cloud: true, stale: false })
  assert.equal(s.sourceId, 'box-2')
  assert.equal(local.origin, undefined, 'input is not mutated')
})

test('switcher suffix and hint', () => {
  assert.equal(originSuffix(NO_MARKS), '')
  assert.equal(originSuffix({ cloud: true, stale: false }), ' · Cloud')
  assert.equal(originSuffix({ cloud: true, stale: true }), ' · Cloud · Terputus')
  assert.equal(originHint(NO_MARKS), '')
  assert.equal(originHint({ cloud: true, stale: false }), CLOUD_HINT)
  assert.equal(originHint({ cloud: true, stale: true }), STALE_HINT)
})

test('labels are Indonesian and stale never reads as an error', () => {
  assert.doesNotMatch(STALE_HINT, /error|gagal|rusak/i)
})

test('sameProjects: equal lists, and a change in stale, origin or name counts', () => {
  const a: TeamProject[] = [
    { id: 'p1', name: 'Lokal', hasState: true },
    { id: 'p2', name: 'Cloud', hasState: true, origin: 'cloud', sourceId: 'box-1' },
  ]
  const copy = a.map((p) => ({ ...p }))
  assert.equal(sameProjects(a, copy), true)
  assert.equal(sameProjects(a, [a[0], { ...a[1], stale: true }]), false)
  assert.equal(sameProjects([a[0], { ...a[1], stale: true }], [a[0], { ...a[1], stale: false }]), false)
  assert.equal(sameProjects(a, [a[0], { ...a[1], stale: false }]), true)
  assert.equal(sameProjects(a, [{ ...a[0], name: 'Lain' }, a[1]]), false)
  assert.equal(sameProjects(a, [a[1], a[0]]), false)
  assert.equal(sameProjects(a, a.slice(0, 1)), false)
})
