import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@/lib/agent-types'
import { COMPLETED_SUBAGENT_OPACITY } from '@/lib/canvas-constants'
import { animateAgents } from './animate'
import { snapVisualState } from './snap-visual-state'
import { createEmptyState } from './types'

function agent(id: string, over: Partial<Agent>): Agent {
  return { id, name: id, state: 'idle', opacity: 1, scale: 1, timeAlive: 0, messageBubbles: [], isMain: false, ...over } as unknown as Agent
}

test('a finished sub-agent dims to the floor and stays on the graph', () => {
  let agents = new Map([['sub', agent('sub', { state: 'complete' })]])
  for (let i = 0; i < 200; i++) agents = animateAgents(agents, 0.1, i * 0.1)
  const sub = agents.get('sub')
  assert.ok(sub, 'still present after a long time')
  assert.equal(sub!.opacity, COMPLETED_SUBAGENT_OPACITY)
  assert.ok(COMPLETED_SUBAGENT_OPACITY > 0, 'the floor keeps it visible')
})

test('a sub-agent spawned already finished (rebuilt after a restart) fades in to the floor instead of vanishing', () => {
  let agents = new Map([['sub', agent('sub', { state: 'complete', opacity: 0, scale: 0.3 })]])
  agents = animateAgents(agents, 0.1, 0.1)
  assert.ok(agents.get('sub')!.opacity > 0, 'visible after the first frame, so the faded-agent cleanup keeps it')
  for (let i = 0; i < 200; i++) agents = animateAgents(agents, 0.1, i * 0.1)
  assert.equal(agents.get('sub')!.opacity, COMPLETED_SUBAGENT_OPACITY)
  assert.equal(agents.get('sub')!.scale, 0.8)
})

test('replaying buffered events (page load, seek) keeps finished sub-agents, dimmed', () => {
  const state = createEmptyState({
    agents: new Map([
      ['main', agent('main', { state: 'idle', isMain: true, spawnTime: 0 })],
      ['sub', agent('sub', { state: 'complete', opacity: 0, scale: 0.3, spawnTime: 0 })],
    ]),
  })
  const snapped = snapVisualState(state, 10)
  assert.ok(snapped.agents.has('sub'))
  assert.equal(snapped.agents.get('sub')!.opacity, COMPLETED_SUBAGENT_OPACITY)
})

test('a running sub-agent is not dimmed', () => {
  let agents = new Map([['sub', agent('sub', { state: 'thinking' })]])
  for (let i = 0; i < 50; i++) agents = animateAgents(agents, 0.1, i * 0.1)
  assert.equal(agents.get('sub')!.opacity, 1)
})
