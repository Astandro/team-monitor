// AC5 on the graph, as far as the client goes: a session's events processed again (a reload replays them, a
// reconnect used to append the replay to the buffer) still give one coordinator node and one node per agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SimulationEvent } from '@/lib/agent-types'
import { processEvent, type ProcessEventContext } from './process-event'
import { createEmptyState, type SimulationState } from './types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

const events: SimulationEvent[] = [
  { time: 0, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true, displayName: 'Nara', role: 'Software Architect' }, sessionId: 's1' },
  { time: 1, type: 'agent_spawn', payload: { name: 'Hiro (Frontend Engineer): halaman', parent: 'orchestrator', displayName: 'Hiro', role: 'Frontend Engineer' }, sessionId: 's1' },
  { time: 2, type: 'agent_spawn', payload: { name: 'Ren (Backend Engineer): api', parent: 'orchestrator', displayName: 'Ren', role: 'Backend Engineer' }, sessionId: 's1' },
  { time: 3, type: 'agent_complete', payload: { name: 'Hiro (Frontend Engineer): halaman', finished: true, finishedAt: '2026-11-21T10:00:00Z' }, sessionId: 's1' },
]

function run(list: SimulationEvent[], times: number): SimulationState {
  let st = createEmptyState()
  for (let i = 0; i < times; i++) for (const e of list) st = processEvent(e, st, ctx)
  return st
}

test('events replayed five times: one main (coordinator) node, one node per agent', () => {
  const once = run(events, 1)
  const five = run(events, 5)
  const mains = [...five.agents.values()].filter((a) => a.isMain)
  assert.equal(mains.length, 1)
  assert.equal(five.agents.size, once.agents.size)
  assert.equal(five.agents.size, 3)
})
