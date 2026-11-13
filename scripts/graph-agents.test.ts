/**
 * Agents on the graph and which of their events a viewer gets (spec offboard-names item 1).
 */
import { test, describe } from 'node:test'
import { strict as assert } from 'node:assert'
import type { AgentEvent } from '../extension/src/protocol'
import { GraphAgents, eventAgentNames, NO_OFFBOARDING, type OffboardLookup } from './graph-agents'

const S = 'sess-1'
const ev = (type: AgentEvent['type'], payload: Record<string, unknown>, sessionId: string = S): AgentEvent => ({ time: 0, type, payload, sessionId })
const lookup = (...names: string[]): OffboardLookup => ({ isOffboarded: (sid, n) => sid === S && names.includes(n) })

const HIRO = 'Hiro (Frontend Engineer): panel'
const REN = 'Ren (Backend Engineer): store'

function teamOf(): GraphAgents {
  const g = new GraphAgents()
  g.observe(ev('agent_spawn', { name: 'orchestrator', isMain: true, task: 'Proyek' }), 1000)
  g.observe(ev('agent_spawn', { name: HIRO, parent: 'orchestrator', task: 'panel', displayName: 'Hiro', role: 'Frontend Engineer' }), 2000)
  g.observe(ev('agent_spawn', { name: REN, parent: 'orchestrator', task: 'store', displayName: 'Ren', role: 'Backend Engineer' }), 3000)
  g.observe(ev('agent_complete', { name: HIRO }), 4000)
  return g
}

describe('GraphAgents registry', () => {
  test('tracks status, names and finish time per session', () => {
    const g = teamOf()
    assert.deepEqual(g.agent(S, HIRO), {
      name: HIRO, isMain: false, status: 'finished', displayName: 'Hiro', role: 'Frontend Engineer', task: 'panel',
      spawnedAt: 2000, finishedAt: 4000,
    })
    assert.equal(g.agent(S, REN)?.status, 'running')
    assert.equal(g.agent(S, 'orchestrator')?.isMain, true)
    assert.deepEqual(g.agents(S)?.map((a) => a.name), ['orchestrator', HIRO, REN])
    assert.equal(g.agents('other'), null)
    assert.equal(g.hasSession(S), true)
  })

  test('a given finish time wins over now', () => {
    const g = teamOf()
    g.observe(ev('agent_complete', { name: REN }), 9000, 5000)
    assert.equal(g.agent(S, REN)?.finishedAt, 5000)
  })

  test('a new spawn makes a finished agent running again and keeps its names', () => {
    const g = teamOf()
    g.observe(ev('agent_spawn', { name: HIRO, parent: 'orchestrator', task: '' }), 6000)
    const a = g.agent(S, HIRO)!
    assert.equal(a.status, 'running')
    assert.equal(a.displayName, 'Hiro')
    assert.equal(a.task, 'panel')
  })

  test('ignores events without a session or a name, and completions of unknown agents', () => {
    const g = new GraphAgents()
    g.observe({ time: 0, type: 'agent_spawn', payload: { name: 'x' } })
    g.observe(ev('agent_spawn', { name: '' }))
    g.observe(ev('agent_complete', { name: 'ghost' }))
    assert.equal(g.agents(S), null)
  })

  test('returned agents are copies', () => {
    const g = teamOf()
    g.agent(S, REN)!.status = 'finished'
    g.agents(S)![2].status = 'finished'
    assert.equal(g.agent(S, REN)?.status, 'running')
  })
})

describe('visibility', () => {
  test('eventAgentNames reads name, agent and child', () => {
    assert.deepEqual(eventAgentNames(ev('agent_spawn', { name: 'a', parent: 'p' })), ['a'])
    assert.deepEqual(eventAgentNames(ev('tool_call_start', { agent: 'a', tool: 'Read' })), ['a'])
    assert.deepEqual(eventAgentNames(ev('subagent_dispatch', { parent: 'p', child: 'c' })), ['c'])
    assert.deepEqual(eventAgentNames(ev('message', { agent: 'a', role: 'assistant' })), ['a'])
  })

  test('hides every kind of event of a finished, offboarded agent', () => {
    const g = teamOf()
    const l = lookup(HIRO)
    for (const e of [
      ev('agent_spawn', { name: HIRO }), ev('agent_complete', { name: HIRO }), ev('subagent_dispatch', { parent: 'orchestrator', child: HIRO }),
      ev('subagent_return', { parent: 'orchestrator', child: HIRO }), ev('tool_call_start', { agent: HIRO, tool: 'Read' }),
      ev('tool_call_end', { agent: HIRO, tool: 'Read' }), ev('message', { agent: HIRO, role: 'assistant', content: 'x' }),
      ev('context_update', { agent: HIRO, tokens: 1 }), ev('model_detected', { agent: HIRO, model: 'm' }),
      ev('permission_requested', { agent: HIRO }),
    ]) {
      assert.equal(g.isVisible(e, l), false, e.type)
    }
    assert.equal(g.isVisible(ev('tool_call_start', { agent: 'orchestrator', tool: 'Read' }), l), true)
    assert.equal(g.isVisible(ev('agent_spawn', { name: HIRO }, 'other-session'), l), true, 'only in its own session')
  })

  test('never hides a running agent, even when offboarded', () => {
    const g = teamOf()
    assert.equal(g.isVisible(ev('tool_call_start', { agent: REN, tool: 'Read' }), lookup(REN)), true)
  })

  test('an offboarded agent the registry never saw counts as hidden', () => {
    const g = new GraphAgents()
    assert.equal(g.isHidden(S, 'ghost', lookup('ghost')), true)
    assert.equal(g.isHidden(S, 'ghost', NO_OFFBOARDING), false)
  })

  test('visibleEvents filters a replay buffer', () => {
    const g = teamOf()
    const buf = [
      ev('agent_spawn', { name: 'orchestrator', isMain: true }), ev('agent_spawn', { name: HIRO }),
      ev('tool_call_start', { agent: HIRO, tool: 'Read' }), ev('agent_spawn', { name: REN }), ev('agent_complete', { name: HIRO }),
    ]
    assert.deepEqual(g.visibleEvents(buf, lookup(HIRO)).map((e) => e.payload.name ?? e.payload.agent), ['orchestrator', REN])
    assert.equal(g.visibleEvents(buf, NO_OFFBOARDING).length, buf.length)
  })
})

describe('admit (live events)', () => {
  test('an offboarded agent that runs again is shown from its new spawn', () => {
    const g = teamOf()
    const r = g.admit(ev('agent_spawn', { name: HIRO }), lookup(HIRO), 7000)
    assert.deepEqual(r, { send: true, hide: [] })
    assert.equal(g.admit(ev('tool_call_start', { agent: HIRO, tool: 'Read' }), lookup(HIRO)).send, true)
  })

  test('when it finishes again, viewers get the completion and then a hide', () => {
    const g = teamOf()
    g.admit(ev('agent_spawn', { name: HIRO }), lookup(HIRO), 7000)
    const r = g.admit(ev('agent_complete', { name: HIRO }), lookup(HIRO), 8000)
    assert.deepEqual(r, { send: true, hide: [HIRO] })
    assert.equal(g.agent(S, HIRO)?.status, 'finished')
  })

  test('late events of a hidden agent are not sent', () => {
    const g = teamOf()
    assert.deepEqual(g.admit(ev('model_detected', { agent: HIRO, model: 'm' }), lookup(HIRO)), { send: false, hide: [] })
    assert.deepEqual(g.admit(ev('agent_complete', { name: HIRO }), lookup(HIRO)), { send: false, hide: [] })
  })

  test('a normal completion sends and hides nothing', () => {
    const g = teamOf()
    assert.deepEqual(g.admit(ev('agent_complete', { name: REN }), NO_OFFBOARDING), { send: true, hide: [] })
  })
})
