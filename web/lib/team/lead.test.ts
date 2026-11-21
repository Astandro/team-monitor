import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isHiddenByOffboard, isOffboardedMember, pickLeadId } from './lead'
import { buildTeamVM } from './view-model'
import { groupMembers } from './groups'
import type { TeamAgent, TeamState } from './types'
import type { OffboardRecord } from './offboard'

const NOW = Date.parse('2026-11-21T10:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const coord = (nick: string, extra: TeamAgent = {}): TeamAgent => ({ nick, name: 'Software Architect', desk: 'coordinator', status: 'idle', ...extra })
const eng = (nick: string, extra: TeamAgent = {}): TeamAgent => ({ nick, name: 'Frontend Engineer', desk: 'builder', status: 'idle', ...extra })

test('one coordinator: it is the lead', () => {
  assert.equal(pickLeadId([['a1', coord('Sora')], ['a2', eng('Yuki')]], {}, NOW), 'a1')
  assert.equal(pickLeadId([['a2', eng('Yuki')]], {}, NOW), null)
})

test('several coordinators: meta.coordinator names the lead (by nick, else by key)', () => {
  const agents: [string, TeamAgent][] = [['old', coord('Arka')], ['new', coord('Nara')]]
  assert.equal(pickLeadId(agents, { coordinator: { name: 'Nara', role: 'Software Architect' } }, NOW), 'new')
  assert.equal(pickLeadId(agents, { coordinator: { name: '  nara ' } }, NOW), 'new', 'trimmed, case-insensitive')
  assert.equal(pickLeadId(agents, { coordinator: { name: 'new' } }, NOW), 'new', 'key as a fallback')
})

test('no meta match: the first coordinator that is not offboarding, else the first', () => {
  const leaving = coord('Arka', { status: 'offboarding', finishedAt: iso(10 * 60_000) })
  assert.equal(pickLeadId([['old', leaving], ['new', coord('Nara')]], { coordinator: { name: 'Zed' } }, NOW), 'new')
  assert.equal(pickLeadId([['old', leaving], ['new', coord('Nara')]], {}, NOW), 'new')
  assert.equal(pickLeadId([['a', leaving], ['b', coord('B', { status: 'offboarding', finishedAt: iso(5 * 60_000) })]], {}, NOW), 'a')
})

test('offboard match: nick against the record name, roles must agree when both are known; key against agent', () => {
  const rec = (r: Partial<OffboardRecord>): OffboardRecord => ({ session: 's', agent: 'x', name: 'n', ...r })
  assert.equal(isOffboardedMember('k', eng('Hiro'), [rec({ name: 'hiro', role: 'Frontend Engineer' })]), true)
  assert.equal(isOffboardedMember('k', eng('Hiro'), [rec({ name: 'Hiro', role: null })]), true, 'no role on the record')
  assert.equal(isOffboardedMember('k', eng('Hiro'), [rec({ name: 'Hiro', role: 'QA Engineer' })]), false, 'another Hiro')
  assert.equal(isOffboardedMember('hiro-fe', eng('Hiro'), [rec({ agent: 'hiro-fe', name: 'Someone' })]), true)
  assert.equal(isOffboardedMember('k', eng('Hiro'), [rec({ name: 'Ren' })]), false)
  assert.equal(isOffboardedMember('k', eng('Hiro'), []), false)
  assert.equal(isOffboardedMember('k', eng('Hiro'), null), false)
  assert.equal(isOffboardedMember('k', {}, [rec({ name: '' })]), false, 'an agent without a nick matches no name')
})

// ─── buildTeamVM: AC5 and item 9 ─────────────────────────────────────────────

function state(agents: Record<string, TeamAgent>, coordinatorName?: string): TeamState {
  return { meta: coordinatorName ? { coordinator: { name: coordinatorName, role: 'Software Architect' } } : {}, agents }
}

test('AC5: two coordinator entries give exactly one lead; the other is in Disintegrating, not under the lead', () => {
  const vm = buildTeamVM(state({
    a1: coord('Arka', { order: 1 }),
    a2: eng('Hiro', { order: 2, status: 'working', task: 'Halaman' }),
    a3: coord('Nara', { order: 3, status: 'working', task: 'Koordinasi' }),
  }, 'Nara'), { now: NOW })
  assert.equal(vm.lead?.nick, 'Nara')
  assert.equal(vm.lead?.isLead, true)
  const leads = [vm.lead, ...vm.members].filter((m) => m?.isLead)
  assert.equal(leads.length, 1)
  const arka = vm.members.find((m) => m.nick === 'Arka')!
  assert.equal(arka.retired, true)
  assert.equal(arka.isLead, false)
  const groups = groupMembers(vm.members)
  assert.deepEqual(groups.map((g) => [g.label, g.members.map((m) => m.nick)]), [['Aktif', ['Hiro']], ['Disintegrating', ['Arka']]])
  assert.equal(vm.decisions.length, 0)
})

test('item 9: a member in the hub offboard list is hidden from the tree; task rows still name it', () => {
  const s: TeamState = {
    ...state({ a1: coord('Nara', { order: 1 }), a2: eng('Hiro', { order: 2 }), a3: eng('Ren', { order: 3, name: 'Backend Engineer' }) }, 'Nara'),
    tasks: { t1: { title: 'Halaman daftar', status: 'done', agent: 'a2' } },
  }
  const offboarded: OffboardRecord[] = [{ session: 's1', agent: 'Hiro (Frontend Engineer): halaman', name: 'Hiro', role: 'Frontend Engineer' } as OffboardRecord]
  const vm = buildTeamVM(s, { now: NOW, offboarded })
  assert.deepEqual(vm.members.map((m) => m.nick), ['Ren'])
  assert.equal(vm.lead?.nick, 'Nara')
  assert.match(vm.queue[0].who, /Hiro/)
  // without the list nothing is hidden (unchanged behaviour)
  assert.deepEqual(buildTeamVM(s, { now: NOW }).members.map((m) => m.nick), ['Hiro', 'Ren'])
})

test('the lead is never hidden by the offboard list', () => {
  const vm = buildTeamVM(state({ a1: coord('Nara') }, 'Nara'), {
    now: NOW,
    offboarded: [{ session: 's', agent: 'orchestrator', name: 'Nara', role: 'Software Architect' } as OffboardRecord],
  })
  assert.equal(vm.lead?.nick, 'Nara')
})

// ─── F2: offboarded, then working again after the offboard ──────────────────

const OFF_AT = iso(30 * 60_000)
const hiroRec = (offboardedAt: string = OFF_AT): OffboardRecord =>
  ({ session: 's1', agent: 'Hiro (Frontend Engineer): panel', name: 'Hiro', role: 'Frontend Engineer', reason: 'auto', offboardedAt })

function f2State(hiroStatus: string): TeamState {
  return state({ a1: coord('Nara', { order: 1 }), a2: eng('Hiro', { order: 2, status: hiroStatus, task: 'Panel' }), a3: eng('Mei', { order: 3, name: 'QA Engineer' }) }, 'Nara')
}
const nicks = (vm: ReturnType<typeof buildTeamVM>) => vm.members.map((m) => m.nick)

test('F2: offboarded, then working again with a state written after the offboard: shown', () => {
  const vm = buildTeamVM(f2State('working'), { now: NOW, offboarded: [hiroRec()], stateMtime: iso(5 * 60_000) })
  assert.deepEqual(nicks(vm), ['Hiro', 'Mei'])
  assert.equal(vm.members[0].working, true)
})

test('F2: offboarded, state written before the offboard: hidden', () => {
  assert.deepEqual(nicks(buildTeamVM(f2State('working'), { now: NOW, offboarded: [hiroRec()], stateMtime: iso(40 * 60_000) })), ['Mei'])
  assert.deepEqual(nicks(buildTeamVM(f2State('working'), { now: NOW, offboarded: [hiroRec()], stateMtime: OFF_AT })), ['Mei'], 'same time is not later')
})

test('F2: offboarded, state newer but the member is not working: hidden', () => {
  for (const status of ['idle', 'offboarding', '']) {
    assert.deepEqual(nicks(buildTeamVM(f2State(status), { now: NOW, offboarded: [hiroRec()], stateMtime: iso(60_000) })), ['Mei'], status)
  }
})

test('F2: missing, null or unreadable stateMtime: hidden', () => {
  const s = f2State('working')
  assert.deepEqual(nicks(buildTeamVM(s, { now: NOW, offboarded: [hiroRec()] })), ['Mei'], 'absent (older hub)')
  assert.deepEqual(nicks(buildTeamVM(s, { now: NOW, offboarded: [hiroRec()], stateMtime: null })), ['Mei'], 'null (no state file)')
  assert.deepEqual(nicks(buildTeamVM(s, { now: NOW, offboarded: [hiroRec()], stateMtime: 'kemarin' })), ['Mei'], 'unparseable')
})

test('F2: several matching records count from the latest offboardedAt; a record without a time hides', () => {
  const recs = [hiroRec(iso(50 * 60_000)), hiroRec(iso(10 * 60_000))]
  assert.equal(isHiddenByOffboard('a2', eng('Hiro', { status: 'working' }), recs, iso(20 * 60_000)), true, 'between the two offboards')
  assert.equal(isHiddenByOffboard('a2', eng('Hiro', { status: 'working' }), recs, iso(5 * 60_000)), false, 'after the latest')
  assert.equal(isHiddenByOffboard('a2', eng('Hiro', { status: 'working' }), [{ ...hiroRec(), offboardedAt: undefined }], iso(60_000)), true, 'no offboardedAt')
  assert.equal(isHiddenByOffboard('a2', eng('Hiro', { status: 'working' }), [], iso(60_000)), false, 'not offboarded: never hidden')
})

test('reloading five times gives the same single lead (no state kept between builds)', () => {
  const s = state({ a1: coord('Arka'), a2: coord('Nara'), a3: eng('Hiro') }, 'Nara')
  for (let i = 0; i < 5; i++) {
    const vm = buildTeamVM(s, { now: NOW })
    assert.equal(vm.lead?.nick, 'Nara')
    assert.equal([vm.lead, ...vm.members].filter((m) => m?.isLead).length, 1)
  }
})
