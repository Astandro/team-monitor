import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@/lib/agent-types'
import { BUBBLE_VISIBLE_S } from '@/lib/canvas-constants'
import { agentDisplayName } from '@/lib/readable-labels'
import { handleMessage } from './handle-message-events'
import { animateAgents } from './animate'
import type { MutableEventState } from './process-event'

function makeState(): MutableEventState {
  const main = {
    id: 'orchestrator', name: 'orchestrator', state: 'idle', isMain: true, task: '',
    opacity: 1, scale: 1, timeAlive: 0, messageBubbles: [],
  } as unknown as Agent
  return { agents: new Map([['orchestrator', main]]), conversations: new Map() } as unknown as MutableEventState
}

test('a user message does not rename the main node: it stays "Orchestrator", the prompt becomes its task', () => {
  const state = makeState()
  handleMessage({ agent: 'orchestrator', role: 'user', content: 'skrg nunggu apa nih?' }, 5, state)
  const main = state.agents.get('orchestrator')!
  assert.equal(main.name, 'orchestrator')
  assert.equal(agentDisplayName(main.name), 'Orchestrator')
  assert.equal(main.task, 'skrg nunggu apa nih?')
})

test('the user message bubble fades like any other after BUBBLE_VISIBLE_S', () => {
  const state = makeState()
  handleMessage({ agent: 'orchestrator', role: 'user', content: 'skrg nunggu apa nih?' }, 5, state)
  let agents = state.agents
  assert.equal(agents.get('orchestrator')!.messageBubbles.length, 1)
  agents = animateAgents(agents, 0.1, 5 + BUBBLE_VISIBLE_S - 1)
  assert.equal(agents.get('orchestrator')!.messageBubbles.length, 1, 'still shown shortly after')
  agents = animateAgents(agents, 0.1, 5 + BUBBLE_VISIBLE_S + 0.5)
  assert.equal(agents.get('orchestrator')!.messageBubbles.length, 0, 'gone after the visible window')
  assert.equal(agentDisplayName(agents.get('orchestrator')!.name), 'Orchestrator', 'nothing of the prompt is left on the node')
})
