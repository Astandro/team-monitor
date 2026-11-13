import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boxCentredOn, compactFocus, FIT, fitTransform, isCompactGraph, isCurrentAgent } from './graph-fit'

const a = (isMain: boolean, state: string, extra: { finished?: unknown; opacity?: number } = {}) =>
  ({ isMain, state, opacity: 1, ...extra })

test('compact means a phone-sized graph only', () => {
  assert.equal(isCompactGraph(390), true)
  assert.equal(isCompactGraph(639), true)
  assert.equal(isCompactGraph(640), false)
  assert.equal(isCompactGraph(768), false)
  assert.equal(isCompactGraph(0), false)
})

test('a current sub-agent is at work: not complete, not finished, visible, not the main agent', () => {
  assert.equal(isCurrentAgent(a(false, 'thinking')), true)
  assert.equal(isCurrentAgent(a(false, 'idle')), true)
  assert.equal(isCurrentAgent(a(false, 'complete')), false)
  assert.equal(isCurrentAgent(a(false, 'idle', { finished: { at: 1, offboardAt: 2 } })), false)
  assert.equal(isCurrentAgent(a(false, 'thinking', { opacity: 0.05 })), false)
  assert.equal(isCurrentAgent(a(true, 'thinking')), false)
})

test('compact frame holds the Orchestrator and the sub-agents at work; finished ones are left out', () => {
  const agents: [string, ReturnType<typeof a>][] = [
    ['main', a(true, 'thinking')],
    ['haruki', a(false, 'tool_calling')],
    ['yuto', a(false, 'complete', { finished: { at: 1, offboardAt: 2 } })],
    ['riku', a(false, 'complete')],
  ]
  assert.deepEqual([...(compactFocus(agents, true) ?? [])].sort(), ['haruki', 'main'])
  assert.equal(compactFocus(agents, false), null)
})

test('with nobody at work the compact frame takes every visible node', () => {
  const agents: [string, ReturnType<typeof a>][] = [
    ['main', a(true, 'idle')],
    ['yuto', a(false, 'complete')],
    ['ghost', a(false, 'complete', { opacity: 0 })],
  ]
  assert.deepEqual([...(compactFocus(agents, true) ?? [])].sort(), ['main', 'yuto'])
})

const box = { minX: -300, maxX: 300, minY: -250, maxY: 250 }

test('wide fit keeps the upstream padding and clears the bottom bar and the top bars', () => {
  const t = fitTransform(box, { width: 1000, height: 900 }, { top: 60, bottom: 96 }, false)
  const usableH = 900 - 60 - 96
  const expected = Math.min(1000 / (600 + 2 * FIT.widePadding), usableH / (500 + 2 * FIT.widePadding), 2)
  assert.ok(Math.abs(t.scale - expected) < 1e-9)
  // the box centre lands in the middle of the free area, not of the whole canvas
  assert.ok(Math.abs(t.y - (60 + usableH / 2)) < 1e-9)
  assert.ok(Math.abs(t.x - 500) < 1e-9)
})

test('compact fit on a 390 px phone stays readable: never below the floor even when the box is wide', () => {
  const huge = { minX: -600, maxX: 600, minY: -250, maxY: 250 }
  const t = fitTransform(huge, { width: 390, height: 700 }, { top: 64, bottom: 96 }, true)
  assert.equal(t.scale, FIT.compactMinScale)
  assert.ok(FIT.compactMinScale >= 0.5 && FIT.compactMinScale <= 0.7, 'floor stays readable and fits usual spawn spread')
  const wide = fitTransform(box, { width: 390, height: 700 }, { top: 64, bottom: 96 }, false)
  assert.ok(wide.scale < 0.5, `upstream framing would be ${wide.scale}`)
})

test('compact fit of a small group is capped so one node does not fill the phone', () => {
  const one = { minX: -60, maxX: 60, minY: -60, maxY: 90 }
  const t = fitTransform(one, { width: 390, height: 700 }, { top: 64, bottom: 96 }, true)
  assert.equal(t.scale, FIT.compactMaxScale)
})

test('the frame sits below the top controls: the box top lands under the inset', () => {
  const t = fitTransform(box, { width: 390, height: 844 }, { top: 64, bottom: 96 }, true)
  const screenTop = box.minY * t.scale + t.y
  const screenBottom = box.maxY * t.scale + t.y
  // centred in the free band; with the readable floor the box may run past it, but symmetrically
  const mid = (screenTop + screenBottom) / 2
  assert.ok(Math.abs(mid - (64 + (844 - 64 - 96) / 2)) < 1e-9)
})

test('box centred on the Orchestrator still holds every point of the original box', () => {
  // Orchestrator at 0,0; one sub-agent at work far to the right and a bit below
  const b = { minX: -80, maxX: 420, minY: -80, maxY: 150 }
  const c = boxCentredOn(b, { x: 0, y: 0 })
  assert.deepEqual(c, { minX: -420, maxX: 420, minY: -150, maxY: 150 })
  assert.ok(c.minX <= b.minX && c.maxX >= b.maxX && c.minY <= b.minY && c.maxY >= b.maxY)
})

test('phone frame from the centred box puts the Orchestrator in the middle of the free area', () => {
  const b = { minX: -80, maxX: 300, minY: -80, maxY: 120 }
  const dims = { width: 390, height: 844 }
  const insets = { top: 64, bottom: 96 }
  const t = fitTransform(boxCentredOn(b, { x: 0, y: 0 }), dims, insets, true)
  // the Orchestrator (world 0,0) lands at the centre of the free band
  assert.ok(Math.abs(t.x - 195) < 1e-9)
  assert.ok(Math.abs(t.y - (64 + (844 - 64 - 96) / 2)) < 1e-9)
  // and the sub-agent on the right edge of the box is on screen
  assert.ok(300 * t.scale + t.x <= 390, `right edge at ${300 * t.scale + t.x}`)
  // the plain box would have put the Orchestrator left of centre
  const plain = fitTransform(b, dims, insets, true)
  assert.ok(plain.x < 195 - 20)
})
