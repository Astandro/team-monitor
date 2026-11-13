import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupMembers, MEMBER_GROUP_LABEL, memberGroupOf } from './groups'
import { buildTeamVM } from './view-model'

type P = 'working' | 'idle' | 'offboarding'
const m = (id: string, phase: P) => ({ id, phase })

test('groups come in the order Aktif, Siaga, Disintegrating with the owner labels', () => {
  const g = groupMembers([m('a', 'offboarding'), m('b', 'idle'), m('c', 'working')])
  assert.deepEqual(g.map((x) => x.key), ['active', 'idle', 'leaving'])
  assert.deepEqual(g.map((x) => x.label), ['Aktif', 'Siaga', 'Disintegrating'])
  assert.equal(MEMBER_GROUP_LABEL.leaving, 'Disintegrating')
})

test('each member lands in its own group, keeping the file order inside the group', () => {
  const g = groupMembers([m('k', 'working'), m('h', 'offboarding'), m('o', 'working'), m('y', 'idle'), m('c', 'offboarding')])
  assert.deepEqual(g.map((x) => x.members.map((y) => y.id)), [['k', 'o'], ['y'], ['h', 'c']])
  assert.equal(memberGroupOf(m('x', 'idle')), 'idle')
})

test('empty groups are hidden', () => {
  assert.deepEqual(groupMembers([m('a', 'idle')]).map((x) => x.key), ['idle'])
  assert.deepEqual(groupMembers([m('a', 'offboarding'), m('b', 'working')]).map((x) => x.key), ['active', 'leaving'])
  assert.deepEqual(groupMembers([]), [])
})

test('the coordinator stays on top, outside the groups, even when it is idle', () => {
  const now = Date.parse('2026-11-13T10:00:00Z')
  const vm = buildTeamVM({
    agents: {
      sora: { nick: 'Sora', desk: 'coordinator', status: 'idle', order: 9 },
      orion: { nick: 'Orion', desk: 'builder', status: 'working', task: 'QA', order: 2 },
      hana: { nick: 'Hana', desk: 'builder', status: 'offboarding', finishedAt: '2026-11-13T09:50:00Z', order: 1 },
    },
  } as never, { now })
  assert.equal(vm.lead?.nick, 'Sora')
  const groups = groupMembers(vm.members)
  assert.deepEqual(groups.map((x) => [x.key, x.members.map((y) => y.nick)]), [['active', ['Orion']], ['leaving', ['Hana']]])
})
