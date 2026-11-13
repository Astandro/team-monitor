import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { dashArrayFromPieces, memberPhase, offboardClock, OFFBOARD_MINUTES } from './members'
import { disintegrationLook, outlinePieces } from '../disintegration'

const NOW = Date.UTC(2026, 10, 13, 5, 0, 0)
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

test('working and idle members show as they are; unknown statuses count as idle', () => {
  assert.deepEqual(memberPhase({ status: 'working' }, NOW), { kind: 'working' })
  assert.deepEqual(memberPhase({ status: 'idle' }, NOW), { kind: 'idle' })
  assert.deepEqual(memberPhase({}, NOW), { kind: 'idle' })
  assert.deepEqual(memberPhase({ status: 'lagi-istirahat' }, NOW), { kind: 'idle' })
  // finishedAt alone does not retire anyone: only the offboarding status does
  assert.deepEqual(memberPhase({ status: 'idle', finishedAt: ago(500) }, NOW), { kind: 'idle' })
})

test('an offboarding member runs the 60-minute clock from finishedAt', () => {
  assert.equal(OFFBOARD_MINUTES, 60)
  const p = memberPhase({ status: 'offboarding', finishedAt: ago(30) }, NOW)
  assert.equal(p.kind, 'offboarding')
  assert.ok(p.kind === 'offboarding' && p.clock)
  assert.equal(p.progress, 0.5)
  assert.equal(p.clock.offboardAt - p.clock.at, 60 * 60_000)
  const start = memberPhase({ status: 'offboarding', finishedAt: ago(0) }, NOW)
  assert.ok(start.kind === 'offboarding' && start.progress === 0)
  const late = memberPhase({ status: 'offboarding', finishedAt: ago(59) }, NOW)
  assert.ok(late.kind === 'offboarding' && Math.abs(late.progress - 59 / 60) < 1e-9)
})

test('a member is never shown past finishedAt + 60 min, even when still in the file', () => {
  assert.deepEqual(memberPhase({ status: 'offboarding', finishedAt: ago(60) }, NOW), { kind: 'gone' })
  assert.deepEqual(memberPhase({ status: 'offboarding', finishedAt: ago(61) }, NOW), { kind: 'gone' })
  assert.deepEqual(memberPhase({ status: 'offboarding', finishedAt: ago(60 * 24) }, NOW), { kind: 'gone' })
})

test('offboarding without a readable finishedAt stays at the start until the coordinator removes it', () => {
  for (const finishedAt of [undefined, '', 'kemarin', 12345]) {
    assert.deepEqual(memberPhase({ status: 'offboarding', finishedAt }, NOW), { kind: 'offboarding', clock: null, progress: 0 })
  }
  assert.equal(offboardClock('bukan tanggal'), null)
})

test('a finishedAt in the future (clock skew) starts the break-up at 0, not negative', () => {
  const p = memberPhase({ status: 'offboarding', finishedAt: new Date(NOW + 5 * 60_000).toISOString() }, NOW)
  assert.ok(p.kind === 'offboarding' && p.progress === 0)
})

test('outline dash array: runs of drawn and missing pieces, solid when whole, nothing when all gone', () => {
  assert.equal(dashArrayFromPieces([true, true, true]), 'none')
  assert.equal(dashArrayFromPieces([]), 'none')
  assert.equal(dashArrayFromPieces([false, false, false]), '0 3')
  assert.equal(dashArrayFromPieces([true, false, true, true]), '1 1 2 0')
  assert.equal(dashArrayFromPieces([false, true, true, false]), '0 1 2 1')
  assert.equal(dashArrayFromPieces([true, true, false, false]), '2 2')
})

test('dash array draws exactly the pieces still there at every stage of the hour', () => {
  for (const progress of [0.1, 0.33, 0.5, 0.9]) {
    const pieces = outlinePieces('Yuto', progress)
    const runs = dashArrayFromPieces(pieces).split(' ').map(Number)
    const drawn = runs.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0)
    const total = runs.reduce((a, b) => a + b, 0)
    assert.equal(total, pieces.length)
    assert.equal(drawn, pieces.filter(Boolean).length)
  }
})

test('reduced motion: the panel gets a whole outline and a plain fade (same rule as the graph)', () => {
  const look = disintegrationLook('Yuto', 0.5, true)
  assert.equal(look.pieces, null)
  assert.equal(look.body, 0.5)
})
