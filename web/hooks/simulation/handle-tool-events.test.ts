import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@/lib/agent-types'
import type { TimelineEntry } from '@/lib/agent-types'
import { handleToolCallStart, handleToolCallEnd } from './handle-tool-events'
import type { MutableEventState, ProcessEventContext } from './process-event'

function makeState(): MutableEventState {
  const agent = { id: 'main', name: 'main', state: 'thinking', toolCalls: 0, tokensUsed: 0, isMain: true, messageBubbles: [] } as unknown as Agent
  const entry: TimelineEntry = { id: 'tl-main', agentId: 'main', agentName: 'main', startTime: 0, blocks: [] }
  return {
    agents: new Map([['main', agent]]),
    toolCalls: new Map(),
    particles: [],
    edges: [],
    discoveries: [],
    fileAttention: new Map(),
    timelineEntries: new Map([['main', entry]]),
    conversations: new Map(),
  } as unknown as MutableEventState
}

const ctx = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 1000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
} as ProcessEventContext

test('tool_call_start puts a readable label, not the raw tool code, in the transcript', () => {
  for (const tool of ['mcp__a__b', 'FrobnicateWidget_v2', 'Agent']) {
    const state = makeState()
    handleToolCallStart({ agent: 'main', tool, args: '{"q":1}' }, 1, state, ctx)
    const content = state.conversations.get('main')![0].content
    assert.ok(!content.includes('mcp__'), content)
    assert.ok(!content.includes('FrobnicateWidget_v2'), content)
    assert.ok(!/^> Agent\b/.test(content), content)
    assert.ok(content.startsWith('> '))
  }
  const state = makeState()
  handleToolCallStart({ agent: 'main', tool: 'mcp__a__b', args: 'x' }, 1, state, ctx)
  assert.equal(state.conversations.get('main')![0].content, '> Alat a: b: x')
  // the original name still travels with the message for the popup
  assert.equal(state.conversations.get('main')![0].toolName, 'mcp__a__b')
})

test('failed tool: timeline block and result use Indonesian, tokens say "token"', () => {
  const state = makeState()
  handleToolCallStart({ agent: 'main', tool: 'Bash', args: 'ls' }, 1, state, ctx)
  handleToolCallEnd({ agent: 'main', tool: 'Bash', result: 'boom', isError: true, tokenCost: 79 }, 2, state, ctx)
  const blocks = state.timelineEntries.get('main')!.blocks
  assert.ok(blocks.some(b => b.label === 'Jalanin perintah: gagal'), JSON.stringify(blocks.map(b => b.label)))
  assert.ok(!blocks.some(b => b.label.includes('FAILED')))
  const result = state.conversations.get('main')!.find(m => m.type === 'tool_result')!
  assert.equal(result.content, '< boom (79 token)')
})
