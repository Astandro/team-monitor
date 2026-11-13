import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { CUE_PRIORITY, cueForGraphTransition, isHandoffParticle, orderCues, type SoundCue } from './cues'
import { RECIPES } from './recipes'

test('each graph transition plays its own cue', () => {
  assert.equal(cueForGraphTransition('agent_spawn'), 'agent_spawn')
  assert.equal(cueForGraphTransition('agent_complete'), 'agent_complete')
  assert.equal(cueForGraphTransition('tool_start'), 'tool_start')
  assert.equal(cueForGraphTransition('tool_complete'), 'tool_complete')
  assert.equal(cueForGraphTransition('tool_error'), 'tool_error')
})

test('subagent dispatch and return are handoffs, other particles are not', () => {
  assert.equal(isHandoffParticle('dispatch'), true)
  assert.equal(isHandoffParticle('return'), true)
  assert.equal(isHandoffParticle('tool_call'), false)
  assert.equal(isHandoffParticle('tool_return'), false)
})

test('orderCues dedupes and puts the owner decision first', () => {
  assert.deepEqual(orderCues(['tool_start', 'decision_open', 'tool_start', 'task_done']), [
    'decision_open',
    'task_done',
    'tool_start',
  ])
})

test('every cue has a priority and a recipe of its own', () => {
  const all = Object.keys(RECIPES) as SoundCue[]
  // the 14 v1 events plus the offboard one (spec v2)
  assert.equal(all.length, 15)
  assert.equal(new Set(CUE_PRIORITY).size, 15)
  for (const cue of all) {
    assert.ok(CUE_PRIORITY.includes(cue), cue)
    assert.ok(RECIPES[cue].length > 0, cue)
  }
  // no two cues share the exact same recipe
  const shapes = new Set(all.map((c) => JSON.stringify(RECIPES[c])))
  assert.equal(shapes.size, all.length)
})

test('agent events landing together play finished, then offboarded, then spawned', () => {
  assert.deepEqual(orderCues(['agent_spawn', 'agent_offboarded', 'agent_complete']), [
    'agent_complete',
    'agent_offboarded',
    'agent_spawn',
  ])
})
