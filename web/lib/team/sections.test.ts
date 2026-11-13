import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  ANSWERED_OPEN_BY_DEFAULT,
  answeredSummary,
  isPanelToggleKey,
  panelSections,
  parsePanelHidden,
  SECTION_ORDER,
  splitDecisions,
  storePanelHidden,
} from './sections'
import { buildTeamVM } from './view-model'
import { makeFixtureState } from './fixtures/sample'

test('section order: stages, live, open decisions, team, queue, offboarded, answered; no chat in the panel (item 4, spec-chat-layout)', () => {
  assert.deepEqual(panelSections(2), ['stages', 'live', 'decisions', 'team', 'queue', 'offboarded', 'answered'])
  assert.deepEqual([...SECTION_ORDER], panelSections(1))
})

test('the answered group is left out when nothing was answered yet', () => {
  assert.deepEqual(panelSections(0), ['stages', 'live', 'decisions', 'team', 'queue', 'offboarded'])
})

test('no log section anywhere (item 5)', () => {
  assert.ok(!(SECTION_ORDER as readonly string[]).includes('log'))
})

test('decisions split: open stay expanded in order, answered go to the collapsed group in order (item 3)', () => {
  const ds = [
    { t: 'a', open: true },
    { t: 'b', open: false },
    { t: 'c', open: true },
    { t: 'd', open: false },
  ]
  const { open, answered } = splitDecisions(ds)
  assert.deepEqual(open.map((d) => d.t), ['a', 'c'])
  assert.deepEqual(answered.map((d) => d.t), ['b', 'd'])
})

test('a decision answered from this browser moves to the answered group at once', () => {
  const now = new Date(2026, 10, 13, 12).getTime()
  const vm = buildTeamVM(makeFixtureState('revamp-ui', now), { now, localAnswers: { D1: '5 MB' } })
  const { open, answered } = splitDecisions(vm.decisions)
  assert.equal(open.length, 1)
  assert.deepEqual(answered.map((d) => d.answer), ['5 MB', 'Hijau tua'])
})

test('the answered group starts collapsed behind "N sudah dijawab"', () => {
  assert.equal(ANSWERED_OPEN_BY_DEFAULT, false)
  assert.equal(answeredSummary(3), '3 sudah dijawab')
  assert.equal(answeredSummary(1), '1 sudah dijawab')
})

test('panel hidden flag: only "1" means hidden; anything else (missing, broken storage) shows the panel', () => {
  assert.equal(parsePanelHidden('1'), true)
  for (const raw of ['0', '', null, undefined, 'true', 'yes']) assert.equal(parsePanelHidden(raw), false)
  assert.equal(parsePanelHidden(storePanelHidden(true)), true)
  assert.equal(parsePanelHidden(storePanelHidden(false)), false)
})

test('"[" toggles the panel, but not while typing, with a modifier, on repeat or when already handled', () => {
  const body = { tagName: 'BODY' }
  assert.equal(isPanelToggleKey({ key: '[', target: body }), true)
  assert.equal(isPanelToggleKey({ key: '[', target: { tagName: 'button' } }), true)
  assert.equal(isPanelToggleKey({ key: '[', target: null }), true)
  assert.equal(isPanelToggleKey({ key: ']', target: body }), false)
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'textarea']) {
    assert.equal(isPanelToggleKey({ key: '[', target: { tagName } }), false, tagName)
  }
  assert.equal(isPanelToggleKey({ key: '[', target: { tagName: 'DIV', isContentEditable: true } }), false)
  assert.equal(isPanelToggleKey({ key: '[', ctrlKey: true, target: body }), false)
  assert.equal(isPanelToggleKey({ key: '[', metaKey: true, target: body }), false)
  assert.equal(isPanelToggleKey({ key: '[', altKey: true, target: body }), false)
  assert.equal(isPanelToggleKey({ key: '[', repeat: true, target: body }), false)
  assert.equal(isPanelToggleKey({ key: '[', defaultPrevented: true, target: body }), false)
})
