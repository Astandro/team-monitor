import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@/lib/agent-types'
import { canOffboard } from '@/lib/team/offboard'
import { handleAgentComplete, handleAgentSpawn } from './handle-agent-events'
import type { MutableEventState, ProcessEventContext } from './process-event'

function makeState(): MutableEventState {
  const main = { id: 'orchestrator', name: 'orchestrator', state: 'thinking', isMain: true, parentId: null } as unknown as Agent
  const hiro = { id: 'Hiro', name: 'Hiro', state: 'thinking', isMain: false, parentId: 'orchestrator' } as unknown as Agent
  const ren = { id: 'Ren', name: 'Ren', state: 'thinking', isMain: false, parentId: 'orchestrator' } as unknown as Agent
  return {
    agents: new Map([['orchestrator', main], ['Hiro', hiro], ['Ren', ren]]),
    toolCalls: new Map(),
    timelineEntries: new Map(),
    conversations: new Map(),
    edges: [],
  } as unknown as MutableEventState
}

const ctx = { skipForceSync: true, getContextWindowSize: () => 200_000 } as unknown as ProcessEventContext
const done = { finished: true, finishedAt: '2026-11-13T14:00:00Z', autoOffboardAt: '2026-11-13T15:00:00Z' }

test('a finished agent_complete gives the sub-agent its clock and makes it offboardable', () => {
  const s = makeState()
  handleAgentComplete({ name: 'Hiro', ...done }, 1, s, ctx)
  const hiro = s.agents.get('Hiro')!
  assert.equal(hiro.state, 'complete')
  assert.deepEqual(hiro.finished, { at: Date.parse(done.finishedAt), offboardAt: Date.parse(done.autoOffboardAt) })
  assert.equal(canOffboard(hiro), true)
})

test('dimmed by the parent completing is not finished: no clock, no Offboard; the server word lands later', () => {
  const s = makeState()
  handleAgentComplete({ name: 'orchestrator', sessionEnd: true }, 1, s, ctx)
  const ren = s.agents.get('Ren')!
  assert.equal(ren.state, 'complete')
  assert.equal(ren.finished, undefined)
  assert.equal(canOffboard(ren), false)
  // the server's own completion for Ren (sessionEnded) still lands on the already dimmed node
  handleAgentComplete({ name: 'Ren', ...done, sessionEnded: true }, 2, s, ctx)
  assert.ok(s.agents.get('Ren')!.finished)
  assert.equal(canOffboard(s.agents.get('Ren')), true)
})

test('the end of a main turn (Stop hook) does not complete sub-agents that keep working in the background', () => {
  const s = makeState()
  handleAgentComplete({ name: 'orchestrator' }, 1, s, ctx)
  assert.equal(s.agents.get('orchestrator')!.state, 'complete')
  assert.equal(s.agents.get('Ren')!.state, 'thinking')
  assert.equal(s.agents.get('Hiro')!.state, 'thinking')
  // the end of the session still completes them all
  handleAgentComplete({ name: 'orchestrator', sessionEnd: true }, 2, s, ctx)
  assert.equal(s.agents.get('orchestrator')!.state, 'complete')
  assert.equal(s.agents.get('Ren')!.state, 'complete')
  assert.equal(s.agents.get('Hiro')!.state, 'complete')
})

test('the Orchestrator never gets a clock, even if a payload says finished', () => {
  const s = makeState()
  handleAgentComplete({ name: 'orchestrator', ...done }, 1, s, ctx)
  assert.equal(s.agents.get('orchestrator')!.finished, undefined)
})

test('reactivated before the hour is up: restored fully, the clock is gone', () => {
  const s = makeState()
  handleAgentComplete({ name: 'Hiro', ...done }, 1, s, ctx)
  handleAgentSpawn({ name: 'Hiro', parent: 'orchestrator' }, 2, s, ctx)
  const hiro = s.agents.get('Hiro')!
  assert.equal(hiro.state, 'idle')
  assert.equal(hiro.finished, undefined)
  assert.equal(canOffboard(hiro), false)
})
