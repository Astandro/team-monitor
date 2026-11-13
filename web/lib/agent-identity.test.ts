import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { agentIdentity, identityLine, parseCoordinator, spawnIdentity } from './agent-identity'

test('spawnIdentity takes displayName and role from a spawn payload, role only with a name', () => {
  assert.deepEqual(spawnIdentity({ name: 'Hiro (Frontend Engineer): x', displayName: 'Hiro', role: 'Frontend Engineer' }), {
    displayName: 'Hiro',
    role: 'Frontend Engineer',
  })
  assert.deepEqual(spawnIdentity({ name: 'old style', task: 't' }), {})
  assert.deepEqual(spawnIdentity({ displayName: '  ', role: 'QA Engineer' }), {})
  assert.deepEqual(spawnIdentity({ displayName: 'Aoi' }), { displayName: 'Aoi' })
})

test('parseCoordinator needs a name and defaults the role to Orchestrator', () => {
  assert.deepEqual(parseCoordinator({ name: 'Sora', role: 'Software Architect' }), { name: 'Sora', role: 'Software Architect' })
  assert.deepEqual(parseCoordinator({ name: 'Sora' }), { name: 'Sora', role: 'Orchestrator' })
  assert.equal(parseCoordinator({ role: 'Orchestrator' }), null)
  assert.equal(parseCoordinator(null), null)
  assert.equal(parseCoordinator('Sora'), null)
})

test('sub-agent: displayName with its role, else the old label', () => {
  assert.deepEqual(agentIdentity({ name: 'Hiro (Frontend Engineer): tombol', displayName: 'Hiro', role: 'Frontend Engineer' }), {
    name: 'Hiro',
    role: 'Frontend Engineer',
  })
  assert.deepEqual(agentIdentity({ name: 'Kaito: server' }), { name: 'Kaito: server', role: '' })
  // a session coordinator never renames a sub-agent
  assert.deepEqual(agentIdentity({ name: 'Ren: x' }, { name: 'Sora', role: 'Orchestrator' }), { name: 'Ren: x', role: '' })
})

test('main node: session coordinator wins over the spawn payload, falls back to it, then to "Orchestrator"', () => {
  const main = { name: 'orchestrator', isMain: true, displayName: 'Haru', role: 'Orchestrator' }
  assert.deepEqual(agentIdentity(main, { name: 'Sora', role: 'Orchestrator' }), { name: 'Sora', role: 'Orchestrator' })
  assert.deepEqual(agentIdentity(main, null), { name: 'Haru', role: 'Orchestrator' })
  assert.deepEqual(agentIdentity({ name: 'orchestrator', isMain: true, displayName: 'Haru' }), { name: 'Haru', role: 'Orchestrator' })
  assert.deepEqual(agentIdentity({ name: 'orchestrator', isMain: true }), { name: 'Orchestrator', role: '' })
})

test('identityLine joins name and role with a middle dot', () => {
  assert.equal(identityLine({ name: 'Hiro', role: 'Frontend Engineer' }), 'Hiro · Frontend Engineer')
  assert.equal(identityLine({ name: 'Orchestrator', role: '' }), 'Orchestrator')
})
