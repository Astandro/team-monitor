import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  BURST_LIFE, burstAt, burstPeriod, DISINTEGRATING_TAG, flickerPeriod, NEBULA_COLORS, NEBULA_CORE, tagPulse,
} from './disintegration'
import { ALERT_TOKENS, mixHex } from './alert-tag'
import { contrastRatio, PANEL_TOKENS } from './graph-palette'

/** Share of a long stretch of time during which a nebula is showing, sampled every 50 ms. */
function burstShare(id: string, progress: number, reduce = false, seconds = 140): number {
  let on = 0
  let n = 0
  for (let t = 0; t < seconds; t += 0.05, n++) if (burstAt(id, progress, t, reduce)) on++
  return on / n
}

/** Number of separate explosions (rising edges) in a stretch of time. */
function burstCount(id: string, progress: number, seconds = 140): number {
  let count = 0
  let prev = false
  for (let t = 0; t < seconds; t += 0.05) {
    const now = burstAt(id, progress, t, false) !== null
    if (now && !prev) count++
    prev = now
  }
  return count
}

test('nebula explosions repeat more often as the deadline nears: every 14 s at the start, every 5 s at the end', () => {
  assert.equal(burstPeriod(0), 14)
  assert.equal(burstPeriod(1), 5)
  assert.ok(burstPeriod(0.5) < burstPeriod(0.2))
  assert.equal(burstPeriod(-1), 14)
  assert.equal(burstPeriod(2), 5)
  const early = burstCount('Yuto', 0.1) // one every 13.1 s, about 10-11 in 140 s
  const late = burstCount('Yuto', 0.9) // one every 5.9 s, about 23-24
  assert.ok(early >= 10 && early <= 12, `early ${early}`)
  assert.ok(late >= 23 && late <= 25, `late ${late}`)
})

test('an explosion is slow: it lasts a few seconds and always ends before the next one', () => {
  assert.ok(BURST_LIFE >= 3 && BURST_LIFE < burstPeriod(1))
  const share = burstShare('Yuto', 0.5)
  // 4 s out of every 9.5 s
  assert.ok(share > 0.35 && share < 0.5, `share ${share}`)
})

test('the clouds swell and fade: radius grows through the explosion, alpha peaks early then falls to nothing', () => {
  const r = 24
  let start = -1
  for (let t = 0; t < 20; t += 0.01) {
    const b = burstAt('Yuto', 0.5, t, false, r)
    if (b && b.phase < 0.01) { start = t; break }
  }
  assert.ok(start >= 0)
  const at = (s: number) => burstAt('Yuto', 0.5, start + s, false, r)!
  const early = at(0.4)
  const mid = at(1.6)
  const late = at(3.8)
  assert.ok(mid.clouds[0].radius > early.clouds[0].radius && late.clouds[0].radius > mid.clouds[0].radius, 'clouds grow')
  assert.ok(late.clouds[0].radius > r * 2.5, 'clouds grow well past the node')
  assert.ok(mid.clouds[0].alpha > late.clouds[0].alpha && late.clouds[0].alpha < 0.05, 'clouds fade out')
  assert.ok(early.clouds[0].alpha <= 0.42 + 1e-9)
  // the bright core flares first and is gone before the clouds
  assert.ok(at(0.2).core.alpha > 0.6, 'core flares')
  assert.equal(late.core.alpha, 0)
})

test('it is a nebula, not the old ring: four clouds of gas colours with a warm core, drifting apart', () => {
  let b = null
  for (let t = 0; t < 20 && !b; t += 0.05) b = burstAt('Hana', 0.4, t, false)
  assert.ok(b)
  assert.equal(b.clouds.length, 4)
  assert.deepEqual(b.clouds.map((c) => c.color), [...NEBULA_COLORS])
  assert.equal(new Set(NEBULA_COLORS).size, 4)
  assert.equal(NEBULA_CORE, '#FFF4DC')
  const angles = new Set(b.clouds.map((c) => Math.round(Math.atan2(c.dy, c.dx) * 4)))
  assert.ok(angles.size >= 3)
})

test('no nebula under reduced motion, before the clock starts or once the node is gone', () => {
  assert.equal(burstShare('Yuto', 0.5, true), 0)
  assert.equal(burstShare('Yuto', 0), 0)
  assert.equal(burstShare('Yuto', 1), 0)
})

test('leaving nodes do not explode in step', () => {
  // when each node's first full explosion starts (phase near 0), in 50 ms steps
  const firstBurst = (id: string) => {
    for (let t = 0; t < 30; t += 0.05) {
      const b = burstAt(id, 0.3, t, false)
      if (b && b.phase < 0.02) return Math.round(t * 20)
    }
    return -1
  }
  const starts = new Set(['Yuto', 'Riku', 'Hana', 'Takumi'].map(firstBurst))
  assert.ok(starts.size >= 3)
})

test('the alert tag pulses slowly, faster near the end, and is static under reduced motion', () => {
  assert.equal(flickerPeriod(0), 3)
  assert.ok(Math.abs(flickerPeriod(1) - 1.4) < 1e-9)
  let min = 1
  let max = 0
  for (let t = 0; t < 10; t += 0.02) {
    const v = tagPulse('Yuto', 0.5, t, false)
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  assert.ok(min < 0.01 && max > 0.99, `pulse ${min}..${max}`)
  for (let t = 0; t < 10; t += 0.5) assert.equal(tagPulse('Yuto', 0.5, t, true), 0)
  assert.equal(tagPulse('Yuto', 0, 1.3, false), 0)
  assert.equal(DISINTEGRATING_TAG, 'disintegrating')
})

test('the alert tag text reads at every point of the pulse, in light and dark; the border shows on the page', () => {
  for (const theme of ['light', 'dark'] as const) {
    const a = ALERT_TOKENS[theme]
    for (let p = 0; p <= 1; p += 0.25) {
      const bg = mixHex(a.bg, a.bgHi, p)
      assert.ok(contrastRatio(a.ink, bg) >= 4.5, `${theme} ink on ${bg}: ${contrastRatio(a.ink, bg).toFixed(2)}`)
    }
    const t = PANEL_TOKENS[theme]
    for (const page of [t.bg, t.surface]) assert.ok(contrastRatio(a.line, page) >= 3, `${theme} border on ${page}`)
    // the "Disintegrating" group: its title and the member text read on the tint
    assert.ok(contrastRatio(a.ink, a.groupBg) >= 4.5)
    assert.ok(contrastRatio(t.ink, a.groupBg) >= 4.5)
  }
  assert.equal(mixHex('#000000', '#FFFFFF', 0.5), '#808080')
})

test('the alert tokens in team-panel.css match ALERT_TOKENS', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'components', 'team-panel', 'team-panel.css'), 'utf-8')
  const rule = (sel: string) => {
    const start = css.indexOf(sel + '{')
    return css.slice(start, css.indexOf('}', start))
  }
  const sel = { light: '.tm-themed', dark: '.tm-root[data-tm-theme="dark"] .tm-themed' } as const
  for (const theme of ['light', 'dark'] as const) {
    const body = rule(sel[theme])
    const a = ALERT_TOKENS[theme]
    const want = { 'alert-ink': a.ink, 'alert-bg': a.bg, 'alert-bg-hi': a.bgHi, 'alert-line': a.line, 'alert-group': a.groupBg }
    for (const [k, v] of Object.entries(want)) assert.ok(body.includes(`--${k}:${v};`), `${theme} --${k}`)
  }
})
