import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  autoOffboardText,
  disintegrationLook,
  disintegrationProgress,
  finishedClock,
  OUTLINE_PIECES,
  outlinePieces,
} from './disintegration'

const T0 = Date.parse('2026-11-13T14:00:00Z')
const MIN = 60_000
const clock = { at: T0, offboardAt: T0 + 60 * MIN }

test('finishedClock reads the server fields only when finished is true and both times parse', () => {
  const p = { name: 'Hiro', finished: true, finishedAt: '2026-11-13T14:00:00Z', autoOffboardAt: '2026-11-13T15:00:00Z' }
  assert.deepEqual(finishedClock(p), clock)
  assert.equal(finishedClock({ ...p, finished: undefined }), null, 'a plain completion (Orchestrator, cascade) is not finished')
  assert.equal(finishedClock({ ...p, finished: 'true' }), null)
  assert.equal(finishedClock({ ...p, autoOffboardAt: 'bad' }), null)
  assert.equal(finishedClock({ ...p, finishedAt: undefined }), null)
  assert.equal(finishedClock(null), null)
})

test('progress runs from finishedAt to autoOffboardAt, clamped', () => {
  assert.equal(disintegrationProgress(clock, T0 - MIN), 0)
  assert.equal(disintegrationProgress(clock, T0), 0)
  assert.equal(disintegrationProgress(clock, T0 + 15 * MIN), 0.25)
  assert.equal(disintegrationProgress(clock, T0 + 30 * MIN), 0.5)
  assert.equal(disintegrationProgress(clock, T0 + 60 * MIN), 1)
  assert.equal(disintegrationProgress(clock, T0 + 90 * MIN), 1)
  // a broken span never divides by zero
  assert.equal(disintegrationProgress({ at: T0, offboardAt: T0 }, T0 - 1), 0)
  assert.equal(disintegrationProgress({ at: T0, offboardAt: T0 }, T0), 1)
})

test('the outline breaks up in step with the clock: share left = 1 - progress, pieces never come back', () => {
  let prev = outlinePieces('Hiro', 0)
  assert.equal(prev.length, OUTLINE_PIECES)
  assert.ok(prev.every(Boolean), 'whole at the start')
  for (let i = 1; i <= 24; i++) {
    const p = i / 24
    const now = outlinePieces('Hiro', p)
    const kept = now.filter(Boolean).length
    assert.equal(kept, Math.round(OUTLINE_PIECES * (1 - p)), `at ${p}`)
    now.forEach((k, j) => assert.ok(!k || prev[j], `piece ${j} came back at ${p}`))
    prev = now
  }
  assert.ok(prev.every((k) => !k), 'nothing left at the deadline')
  // stable per node, different between nodes
  assert.deepEqual(outlinePieces('Hiro', 0.4), outlinePieces('Hiro', 0.4))
  assert.notDeepEqual(outlinePieces('Hiro', 0.4), outlinePieces('Ren', 0.4))
})

test('look: whole at the start, gone at the deadline; reduced motion is a plain fade', () => {
  const start = disintegrationLook('Hiro', 0, false)
  assert.equal(start.body, 1)
  assert.equal(start.label, 1)
  assert.ok(start.pieces!.every(Boolean))

  const mid = disintegrationLook('Hiro', 0.5, false)
  assert.ok(mid.body < 1 && mid.body > 0)
  assert.equal(mid.label, 1, 'the name stays readable most of the hour')

  const end = disintegrationLook('Hiro', 1, false)
  assert.equal(end.body, 0)
  assert.equal(end.label, 0)

  const calm = disintegrationLook('Hiro', 0.25, true)
  assert.equal(calm.pieces, null, 'no break-up under reduced motion')
  assert.equal(calm.body, 0.75, 'plain linear fade')
  assert.equal(disintegrationLook('Hiro', 1, true).body, 0)
})

test('the detail card says when it leaves and how long is left', () => {
  const text = autoOffboardText(clock, T0 + 37 * MIN)
  assert.match(text, /^Keluar otomatis \d\d\.\d\d \(23 menit lagi\)$/)
  assert.match(autoOffboardText(clock, T0 + 61 * MIN), /sebentar lagi hilang/)
})
