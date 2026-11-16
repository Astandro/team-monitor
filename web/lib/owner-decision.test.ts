import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { graphPalette } from './graph-palette'
import {
  isOpenApproval, nodeAlert, OWNER_TAG, ownerAsksKey, ownerNodeIds, ownerTagPulse, openOwnerAsks, type OwnerNode,
} from './owner-decision'
import { ambienceFor } from './sound/ambience'
import type { TeamState } from './team/types'

const main: OwnerNode = { id: 'm', name: 'main', isMain: true, state: 'idle' }
const leif: OwnerNode = { id: 's1', name: 'sub-1', displayName: 'Leif', role: 'Frontend Engineer', isMain: false, state: 'tool_calling' }
const daichi: OwnerNode = { id: 's2', name: 'sub-2', displayName: 'Daichi', isMain: false, state: 'waiting_permission' }
const nodes = [main, leif, daichi]

const state = (approvals: TeamState['approvals'], agents: TeamState['agents'] = {}): TeamState => ({ approvals, agents })

test('open means status "open" without an answer; answered or answer present is not open', () => {
  assert.equal(isOpenApproval({ status: 'open' }), true)
  assert.equal(isOpenApproval({ status: 'open', answer: '5 MB' }), false)
  assert.equal(isOpenApproval({ status: 'answered', answer: '5 MB' }), false)
  assert.equal(isOpenApproval({}), false)
  assert.equal(isOpenApproval(undefined), false)
})

test('openOwnerAsks: only open decisions, with the asker under its key, name and nick', () => {
  const s = state(
    {
      D2: { status: 'open', agent: 'leif' },
      D1: { status: 'open' },
      D3: { status: 'answered', answer: 'ya', agent: 'leif' },
    },
    { leif: { name: 'Leif', nick: 'FE' } },
  )
  assert.deepEqual(openOwnerAsks(s), [
    { id: 'D1', names: [] },
    { id: 'D2', names: ['leif', 'Leif', 'FE'] },
  ])
  assert.deepEqual(openOwnerAsks(null), [])
  assert.deepEqual(openOwnerAsks({}), [])
  assert.equal(ownerAsksKey(openOwnerAsks(s)), 'D1:,D2:leif|Leif|FE')
})

test('the asking agent\'s node shows the state; no agent named: the coordinator node', () => {
  assert.deepEqual([...ownerNodeIds(nodes, openOwnerAsks(state({ D1: { status: 'open', agent: 'Leif' } })))], ['s1'])
  // by the state.json key whose name is on the graph
  const byKey = state({ D1: { status: 'open', agent: 'fe1' } }, { fe1: { name: 'Leif' } })
  assert.deepEqual([...ownerNodeIds(nodes, openOwnerAsks(byKey))], ['s1'])
  assert.deepEqual([...ownerNodeIds(nodes, openOwnerAsks(state({ D1: { status: 'open' } })))], ['m'])
  // the coordinator's own name finds the main node through the session's coordinator
  const asks = openOwnerAsks(state({ D1: { status: 'open', agent: 'Sora' } }))
  assert.deepEqual([...ownerNodeIds(nodes, asks, { name: 'Sora', role: 'Software Architect' })], ['m'])
  // a name not on the graph, or only on a finished node: the coordinator
  assert.deepEqual([...ownerNodeIds(nodes, openOwnerAsks(state({ D1: { status: 'open', agent: 'Nobody' } })))], ['m'])
  const gone = [main, { ...leif, state: 'complete' }]
  assert.deepEqual([...ownerNodeIds(gone, openOwnerAsks(state({ D1: { status: 'open', agent: 'Leif' } })))], ['m'])
  // no main node either: nothing on the graph
  assert.deepEqual([...ownerNodeIds([leif], openOwnerAsks(state({ D1: { status: 'open' } })))], [])
})

test('acceptance 3: opening an approval puts the state on the node; answering it removes the state and the owner loop', () => {
  const open = state({ D1: { status: 'open', agent: 'Daichi' } })
  const answered = state({ D1: { status: 'answered', answer: 'ya', agent: 'Daichi' } })
  const before = ownerNodeIds(nodes, openOwnerAsks(state({})))
  assert.equal(before.size, 0)
  const during = ownerNodeIds(nodes, openOwnerAsks(open))
  assert.deepEqual([...during], ['s2'])
  assert.ok(ambienceFor(nodes, 0, during).has('owner'))
  const after = ownerNodeIds(nodes, openOwnerAsks(answered))
  assert.equal(after.size, 0)
  assert.ok(!ambienceFor(nodes, 0, after).has('owner'))
  assert.ok(ambienceFor(nodes, 0, after).has('waiting'), 'Daichi still waits for permission: back to amber')
})

test('acceptance 4: a node with an open approval and waiting_permission shows the owner state, not the lock', () => {
  const ids = ownerNodeIds(nodes, openOwnerAsks(state({ D1: { status: 'open', agent: 'Daichi' } })))
  const a = nodeAlert(daichi.state, ids.has(daichi.id), false)
  assert.equal(a?.kind, 'owner')
  assert.equal(a?.icon, 'warning')
  assert.equal(a?.ripples, 3)
  assert.equal(a?.tag, OWNER_TAG)
  assert.deepEqual([...ambienceFor(nodes, 0, ids)].sort(), ['owner'], 'no waiting loop from the same node')
  // waiting_permission alone keeps its lock and two ripples
  const w = nodeAlert('waiting_permission', false, false)
  assert.deepEqual({ kind: w?.kind, icon: w?.icon, ripples: w?.ripples, tag: w?.tag }, { kind: 'waiting', icon: 'lock', ripples: 2, tag: null })
  assert.equal(nodeAlert('idle', false, false), null)
})

test('acceptance 6: under reduced motion no ripple, no moving ring, no blink; icon, ring and tag stay', () => {
  for (const [state, owner] of [['idle', true], ['waiting_permission', true], ['waiting_permission', false]] as const) {
    const a = nodeAlert(state, owner, true)!
    assert.equal(a.ripples, 0)
    assert.equal(a.animated, false)
    assert.ok(a.icon)
    for (const t of [0, 0.3, 0.55, 1.7]) assert.equal(ownerTagPulse(t, a.animated), 0)
  }
  assert.equal(nodeAlert('idle', true, true)?.tag, OWNER_TAG)
  // with motion the tag blinks
  const pulses = [0, 0.275, 0.55].map((t) => ownerTagPulse(t, true))
  assert.ok(pulses[0] < 0.01 && pulses[2] > 0.99)
})

test('the owner state is red: the blocked token in both themes; the tag text has no em dash', () => {
  assert.equal(graphPalette('light').ownerDecision, '#B3261E')
  assert.equal(graphPalette('dark').ownerDecision, '#F4897E')
  assert.equal(graphPalette('light').ownerDecision, graphPalette('light').error)
  assert.ok(!OWNER_TAG.includes('—'))
})
