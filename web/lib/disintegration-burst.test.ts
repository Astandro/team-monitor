import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  BURST_LIFE, burstAt, burstPeriod, DISINTEGRATING_TAG, flickerPeriod, NEBULA_CLOUDS, NEBULA_COLORS, NEBULA_CORE,
  NEBULA_CORE_ALPHA, NEBULA_PEAK_ALPHA, NEBULA_SWELL, tagPulse,
} from './disintegration'
import { ALERT_TOKENS, compositeOver, mixHex, WARNING_ICON } from './alert-tag'
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

test('nebula explosions repeat more often as the deadline nears, with long gaps: every 22 s at the start, every 10 s at the end', () => {
  assert.equal(burstPeriod(0), 22)
  assert.equal(burstPeriod(1), 10)
  assert.ok(burstPeriod(0.5) < burstPeriod(0.2))
  assert.equal(burstPeriod(-1), 22)
  assert.equal(burstPeriod(2), 10)
  const early = burstCount('Yuto', 0.1) // one every 20.8 s, about 6-7 in 140 s
  const late = burstCount('Yuto', 0.9) // one every 11.2 s, about 12-13
  assert.ok(early >= 6 && early <= 8, `early ${early}`)
  assert.ok(late >= 12 && late <= 14, `late ${late}`)
})

test('an explosion is slow and the sky stays quiet most of the time', () => {
  assert.ok(BURST_LIFE >= 5 && BURST_LIFE < burstPeriod(1))
  const share = burstShare('Yuto', 0.5)
  // 6 s out of every 16 s
  assert.ok(share > 0.3 && share < 0.45, `share ${share}`)
  // even near the deadline a node is quiet at least 40% of the time
  assert.ok(burstShare('Yuto', 0.99) < 0.6)
})

test('the clouds swell slowly and fade: radius grows, alpha peaks a third of the way in, then falls to nothing', () => {
  const r = 24
  let start = -1
  for (let t = 0; t < 30; t += 0.01) {
    const b = burstAt('Yuto', 0.5, t, false, r)
    if (b && b.phase < 0.01) { start = t; break }
  }
  assert.ok(start >= 0)
  const at = (s: number) => burstAt('Yuto', 0.5, start + s, false, r)!
  const early = at(0.6)
  const peak = at(BURST_LIFE * NEBULA_SWELL)
  const mid = at(3)
  const late = at(5.8)
  assert.ok(mid.clouds[0].radius > early.clouds[0].radius && late.clouds[0].radius > mid.clouds[0].radius, 'clouds grow')
  // calmer: past the node, but smaller than before (it reached 4x the node radius)
  assert.ok(late.clouds[0].radius > r * 1.8 && late.clouds[0].radius < r * 3, `radius ${late.clouds[0].radius / r}`)
  // slow swell: still rising after a second
  assert.ok(at(1.2).clouds[0].alpha > early.clouds[0].alpha && peak.clouds[0].alpha >= at(1.2).clouds[0].alpha)
  assert.ok(Math.abs(peak.clouds[0].alpha - NEBULA_PEAK_ALPHA) < 0.01)
  assert.ok(mid.clouds[0].alpha > late.clouds[0].alpha && late.clouds[0].alpha < 0.02, 'clouds fade out')
  // about half the old strength (0.42 clouds, 0.9 core)
  assert.ok(NEBULA_PEAK_ALPHA <= 0.25 && NEBULA_CORE_ALPHA <= 0.5)
  for (const s of [0.3, 1, 2, 3, 4, 5]) for (const c of at(s).clouds) assert.ok(c.alpha <= NEBULA_PEAK_ALPHA + 1e-9)
  // the core glows first and is gone before the clouds
  assert.ok(at(0.8).core.alpha > 0.3, 'core glows')
  assert.equal(late.core.alpha, 0)
})

test('a calm nebula: two clouds of different gas colours per explosion, apart from each other, with a warm core', () => {
  let b = null
  for (let t = 0; t < 30 && !b; t += 0.05) b = burstAt('Hana', 0.4, t, false)
  assert.ok(b)
  assert.equal(NEBULA_CLOUDS, 2)
  assert.equal(b.clouds.length, 2)
  for (const c of b.clouds) assert.ok((NEBULA_COLORS as readonly string[]).includes(c.color))
  assert.notEqual(b.clouds[0].color, b.clouds[1].color)
  assert.equal(NEBULA_CORE, '#FFF4DC')
  const [a, c] = b.clouds.map((x) => Math.atan2(x.dy, x.dx))
  const apart = Math.abs(Math.atan2(Math.sin(a - c), Math.cos(a - c)))
  assert.ok(apart > Math.PI / 4, `clouds ${apart} rad apart`)
  // over several explosions every colour shows up
  const seen = new Set<string>()
  for (let t = 0; t < 400; t += 0.5) for (const x of burstAt('Hana', 0.4, t, false)?.clouds ?? []) seen.add(x.color)
  assert.equal(seen.size, 4)
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

test('the alert tag is see-through: 15-35% of the alert colour, never opaque', () => {
  for (const theme of ['light', 'dark'] as const) {
    const a = ALERT_TOKENS[theme]
    for (const fill of [a.bg, a.bgHi]) {
      assert.equal(fill.length, 9, `${theme} ${fill} has an alpha`)
      assert.equal(fill.slice(0, 7), a.line, 'tint of the alert colour')
      const alpha = parseInt(fill.slice(7), 16) / 255
      assert.ok(alpha >= 0.15 && alpha <= 0.35, `${theme} alpha ${alpha.toFixed(2)}`)
    }
    // the base is about 15-25%, the pulse a bit stronger
    const base = parseInt(a.bg.slice(7), 16) / 255
    assert.ok(base <= 0.25)
    assert.ok(parseInt(a.bgHi.slice(7), 16) > parseInt(a.bg.slice(7), 16))
  }
  assert.equal(compositeOver('#FF000080', '#000000'), '#800000')
  assert.equal(mixHex('#00000000', '#FFFFFFFF', 0.5), '#80808080')
})

test('the tag starts with a warning triangle (shared by the panel SVG and the canvas)', () => {
  assert.equal(WARNING_ICON.viewBox, '0 0 12 12')
  assert.match(WARNING_ICON.triangle, /^M[\d. ]+L[\d. ]+H[\d.]+ Z$/)
  const css = fs.readFileSync(path.join(__dirname, '..', 'components', 'team-panel', 'team-panel.tsx'), 'utf-8')
  const tag = css.slice(css.indexOf('tm-alert-tag'), css.indexOf('{DISINTEGRATING_TAG}'))
  assert.ok(tag.includes('WARNING_ICON.triangle') && tag.includes('aria-hidden="true"'), 'panel tag draws the icon before the word')
  const draw = fs.readFileSync(path.join(__dirname, '..', 'components', 'agent-visualizer', 'canvas', 'draw-agents.ts'), 'utf-8')
  assert.ok(draw.includes('drawWarningIcon(ctx'), 'graph tag draws the icon')
})

test('the alert tag text reads at every point of the pulse, laid over every surface, in light and dark; the border shows', () => {
  for (const theme of ['light', 'dark'] as const) {
    const a = ALERT_TOKENS[theme]
    const pt = PANEL_TOKENS[theme]
    for (const under of [pt.bg, pt.surface, pt.sunk, a.groupBg]) {
      for (let p = 0; p <= 1; p += 0.25) {
        const bg = compositeOver(mixHex(a.bg, a.bgHi, p), under)
        assert.ok(contrastRatio(a.ink, bg) >= 4.5, `${theme} ink on ${bg} (over ${under}): ${contrastRatio(a.ink, bg).toFixed(2)}`)
      }
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
