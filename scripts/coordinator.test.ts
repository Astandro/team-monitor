/**
 * The coordinator instance on the main node (spec offboard-names item 2): `meta.coordinator` in state.json.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { coordinatorFromState, mainSpawnPayload, sameCoordinator } from './session-projects'

test('coordinatorFromState reads name and role', () => {
  assert.deepEqual(coordinatorFromState({ meta: { coordinator: { name: 'Sora', role: 'Software Architect' } } }), {
    name: 'Sora', role: 'Software Architect',
  })
})

test('coordinatorFromState defaults the role to Orchestrator', () => {
  for (const role of [undefined, '', '   ', 42, null]) {
    assert.deepEqual(coordinatorFromState({ meta: { coordinator: { name: 'Sora', role } } }), { name: 'Sora', role: 'Orchestrator' }, String(role))
  }
})

test('coordinatorFromState trims and collapses spaces', () => {
  assert.deepEqual(coordinatorFromState({ meta: { coordinator: { name: '  Sora  ', role: ' Lead   Orchestrator ' } } }), {
    name: 'Sora', role: 'Lead Orchestrator',
  })
})

test('coordinatorFromState gives undefined without a usable name', () => {
  for (const state of [
    null, undefined, 'x', {}, { meta: null }, { meta: {} }, { meta: { coordinator: 'Sora' } }, { meta: { coordinator: ['Sora'] } },
    { meta: { coordinator: {} } }, { meta: { coordinator: { name: '' } } }, { meta: { coordinator: { name: '   ' } } },
    { meta: { coordinator: { name: 7 } } }, { meta: { coordinator: { name: 'S'.repeat(61) } } },
  ]) {
    assert.equal(coordinatorFromState(state), undefined, JSON.stringify(state))
  }
  assert.equal(coordinatorFromState({ meta: { coordinator: { name: 'S'.repeat(60) } } })?.name.length, 60)
})

test('coordinatorFromState caps a long role at 60 characters', () => {
  assert.equal(coordinatorFromState({ meta: { coordinator: { name: 'Sora', role: 'r'.repeat(80) } } })?.role.length, 60)
})

test('mainSpawnPayload carries the coordinator as displayName and role', () => {
  assert.deepEqual(mainSpawnPayload('orchestrator', 'Proyek', 'claude-opus-5-5', { name: 'Sora', role: 'Orchestrator' }), {
    name: 'orchestrator', isMain: true, task: 'Proyek', model: 'claude-opus-5-5',
    coordinator: { name: 'Sora', role: 'Orchestrator' }, displayName: 'Sora', role: 'Orchestrator',
  })
})

test('mainSpawnPayload without a coordinator is the old payload', () => {
  assert.deepEqual(mainSpawnPayload('orchestrator', 'Proyek', null, undefined), { name: 'orchestrator', isMain: true, task: 'Proyek' })
})

test('sameCoordinator compares name and role', () => {
  assert.equal(sameCoordinator(undefined, undefined), true)
  assert.equal(sameCoordinator({ name: 'Sora', role: 'Orchestrator' }, { name: 'Sora', role: 'Orchestrator' }), true)
  assert.equal(sameCoordinator({ name: 'Sora', role: 'Orchestrator' }, { name: 'Haru', role: 'Orchestrator' }), false)
  assert.equal(sameCoordinator({ name: 'Sora', role: 'Orchestrator' }, { name: 'Sora', role: 'Software Architect' }), false)
  assert.equal(sameCoordinator({ name: 'Sora', role: 'Orchestrator' }, undefined), false)
})
