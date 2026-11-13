import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DISINTEGRATING_TAG, flickerPeriod, tagPulse } from './disintegration'
import { ALERT_TOKENS, compositeOver, mixHex, WARNING_ICON } from './alert-tag'
import { contrastRatio, PANEL_TOKENS } from './graph-palette'

// The node's own effect (ember glow, debris, sparks) is tested in disintegration-ember.test.ts; this file keeps the
// alert tag.

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
