import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BURST_LIFE, burstAt, burstPeriod, DISINTEGRATING_TAG, flickerPeriod, nameFlicker } from './disintegration'

/** Share of a long stretch of time during which a burst is showing, sampled every 50 ms. */
function burstShare(id: string, progress: number, reduce = false, seconds = 120): number {
  let on = 0
  let n = 0
  for (let t = 0; t < seconds; t += 0.05, n++) if (burstAt(id, progress, t, reduce)) on++
  return on / n
}

/** Number of separate bursts (rising edges) in a stretch of time. */
function burstCount(id: string, progress: number, seconds = 120): number {
  let count = 0
  let prev = false
  for (let t = 0; t < seconds; t += 0.05) {
    const now = burstAt(id, progress, t, false) !== null
    if (now && !prev) count++
    prev = now
  }
  return count
}

test('bursts come more often as the deadline nears: every 12 s at the start, every 2.5 s at the end', () => {
  assert.equal(burstPeriod(0), 12)
  assert.equal(burstPeriod(1), 2.5)
  assert.ok(burstPeriod(0.5) < burstPeriod(0.2))
  assert.equal(burstPeriod(-1), 12)
  assert.equal(burstPeriod(2), 2.5)
  const early = burstCount('Yuto', 0.1)
  const late = burstCount('Yuto', 0.9)
  assert.ok(early >= 9 && early <= 12, `early ${early}`)
  // progress 0.9: one every 3.45 s, about 35 in two minutes
  assert.ok(late >= 33 && late <= 36, `late ${late}`)
})

test('a burst is a short quiet flash: brief, faint, fading and growing', () => {
  assert.ok(burstShare('Yuto', 0.5) < 0.15)
  let seen = null
  for (let t = 0; t < 20 && !seen; t += 0.01) seen = burstAt('Yuto', 0.5, t, false)
  assert.ok(seen)
  assert.ok(seen.alpha <= 0.35 && seen.alpha > 0)
  assert.ok(seen.phase >= 0 && seen.phase < 1)
  assert.ok(BURST_LIFE < burstPeriod(1))
})

test('no bursts under reduced motion, before the clock starts or once the node is gone', () => {
  assert.equal(burstShare('Yuto', 0.5, true), 0)
  assert.equal(burstShare('Yuto', 0), 0)
  assert.equal(burstShare('Yuto', 1), 0)
})

test('leaving nodes do not flash in step', () => {
  const firstBurst = (id: string) => {
    for (let t = 0; t < 30; t += 0.05) if (burstAt(id, 0.3, t, false)) return Math.round(t * 20)
    return -1
  }
  const starts = new Set(['Yuto', 'Riku', 'Hana', 'Takumi'].map(firstBurst))
  assert.ok(starts.size >= 3)
})

test('the name blinks slowly between 55% and 100%, faster near the end, steady under reduced motion', () => {
  assert.equal(flickerPeriod(0), 4)
  assert.ok(Math.abs(flickerPeriod(1) - 1.6) < 1e-9)
  let min = 1
  let max = 0
  for (let t = 0; t < 10; t += 0.02) {
    const v = nameFlicker('Yuto', 0.5, t, false)
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  assert.ok(min >= 0.55 - 1e-9 && min < 0.6, `min ${min}`)
  assert.ok(max > 0.99 && max <= 1)
  for (let t = 0; t < 10; t += 0.5) assert.equal(nameFlicker('Yuto', 0.5, t, true), 1)
  assert.equal(nameFlicker('Yuto', 0, 1.3, false), 1)
  assert.equal(DISINTEGRATING_TAG, 'disintegrating')
})
