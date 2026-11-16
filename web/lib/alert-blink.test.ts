import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ALERT_BLINK_MIN_ALPHA, ALERT_TAG_BASE, ALERT_TAG_MIN_SCREEN, ALERT_TOKENS, alertBlinkAlpha, alertTagAlphas,
  alertTagBackdrop, alertTagBox, alertTagSize, compositeOver, mixHex,
} from './alert-tag'
import { contrastRatio, PANEL_TOKENS } from './graph-palette'
import { ownerTagPulse } from './owner-decision'

test('the whole alert component blinks: full opacity at rest, dimmed at the peak of a pulse', () => {
  assert.equal(alertBlinkAlpha(0), 1, 'static and reduced-motion state is fully visible')
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
  assert.ok(near(alertBlinkAlpha(1), ALERT_BLINK_MIN_ALPHA))
  assert.ok(ALERT_BLINK_MIN_ALPHA <= 0.5, 'the blink is clearly visible')
  assert.ok(alertBlinkAlpha(0.5) < 1 && alertBlinkAlpha(0.5) > ALERT_BLINK_MIN_ALPHA)
  assert.equal(alertBlinkAlpha(-1), 1)
  assert.ok(near(alertBlinkAlpha(2), ALERT_BLINK_MIN_ALPHA))
})

test('F4: only the pill blinks; the text and triangle stay fully opaque at every point of the pulse', () => {
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const a = alertTagAlphas(p)
    assert.equal(a.ink, 1, `ink at pulse ${p.toFixed(2)}`)
    assert.ok(Math.abs(a.pill - alertBlinkAlpha(p)) < 1e-12)
  }
  assert.equal(alertTagAlphas(0).pill, 1, 'reduced motion (pulse 0): the pill is static at full strength')
  assert.ok(alertTagAlphas(1).pill < 0.5, 'the pill still blinks visibly')
})

test('F4: tag text reads at 4.5:1 or more through the whole blink, in light and dark, on every canvas surface', () => {
  for (const theme of ['light', 'dark'] as const) {
    const a = ALERT_TOKENS[theme]
    const t = PANEL_TOKENS[theme]
    for (const under of [t.bg, t.surface, t.sunk]) {
      let worst = Infinity
      for (let i = 0; i <= 100; i++) {
        const pulse = ownerTagPulse(i * 0.016, true) // samples across the blink period
        worst = Math.min(worst, contrastRatio(a.ink, alertTagBackdrop(a, pulse, under)))
        worst = Math.min(worst, contrastRatio(a.ink, alertTagBackdrop(a, i / 100, under)))
      }
      assert.ok(worst >= 4.5, `${theme} ink over ${under}: worst ${worst.toFixed(2)}`)
    }
  }
  // the backdrop at pulse 0 is the plain tint over the surface; at pulse 1 the tint is faded
  assert.equal(alertTagBackdrop(ALERT_TOKENS.light, 0, '#FFFFFF'), compositeOver(ALERT_TOKENS.light.bg, '#FFFFFF'))
  const hi = mixHex(ALERT_TOKENS.light.bg, ALERT_TOKENS.light.bgHi, 1)
  assert.notEqual(alertTagBackdrop(ALERT_TOKENS.light, 1, '#FFFFFF'), compositeOver(hi, '#FFFFFF'))
})

test('F2: the owner tag text and triangle never look smaller than 11 and 14 CSS px, whatever the zoom', () => {
  for (const zoom of [0.1, 0.25, 0.4, 0.6, 0.8, 1, 1.2, 1.5, 2, 3]) {
    const s = alertTagSize(zoom, true)
    assert.ok(s.font * zoom >= ALERT_TAG_MIN_SCREEN.font - 1e-9, `text ${s.font * zoom} px at zoom ${zoom}`)
    assert.ok(s.icon * zoom >= ALERT_TAG_MIN_SCREEN.icon - 1e-9, `icon ${s.icon * zoom} px at zoom ${zoom}`)
    assert.ok(s.font >= ALERT_TAG_BASE.font && s.icon >= ALERT_TAG_BASE.icon, 'never smaller than the base size')
    assert.ok(s.height >= s.icon && s.height >= s.font, 'the triangle and the text fit inside the pill')
  }
  assert.equal(ALERT_TAG_MIN_SCREEN.font, 11)
  assert.equal(ALERT_TAG_MIN_SCREEN.icon, 14)
  // QA's 390 px case: zoom-to-fit near 0.45 used to give about 4 px; now 11 and 14 px
  const small = alertTagSize(0.45, true)
  assert.ok(Math.abs(small.font * 0.45 - 11) < 1e-9 && Math.abs(small.icon * 0.45 - 14) < 1e-9)
})

test('F2: where the zoom already makes the tag bigger, its size is unchanged; without the minimum it is the base', () => {
  const base = { ...ALERT_TAG_BASE }
  for (const zoom of [14 / 9, 2, 3]) assert.deepEqual(alertTagSize(zoom, true), base, `zoom ${zoom}`)
  for (const zoom of [0.3, 1, 2]) assert.deepEqual(alertTagSize(zoom, false), base, 'the disintegrating tag keeps its size')
  for (const zoom of [0, -1, Number.NaN, Infinity]) {
    const s = alertTagSize(zoom, true)
    assert.ok(Number.isFinite(s.font) && Number.isFinite(s.icon) && s.font > 0, `bad zoom ${zoom} is safe`)
  }
  // between 11/9 and 14/9 only the triangle needs to grow
  const mid = alertTagSize(1.4, true)
  assert.equal(mid.font, ALERT_TAG_BASE.font)
  assert.ok(Math.abs(mid.icon * 1.4 - 14) < 1e-9)
})

test('F2: at the minimum size the tag stays below the name label and grows downward only', () => {
  const labelBottom = 100
  for (const zoom of [0.1, 0.45, 1, 2]) {
    const s = alertTagSize(zoom, true)
    const box = alertTagBox(s, 60, 50, labelBottom)
    assert.ok(box.y > labelBottom, `tag top ${box.y} below the label bottom at zoom ${zoom}`)
    assert.equal(box.h, s.height)
    assert.ok(Math.abs(box.x + box.w / 2 - 50) < 1e-9, 'centred under the node')
    assert.ok(box.w >= s.padL + s.icon + s.gap + 60, 'room for the triangle and the text')
  }
  const base = alertTagBox(alertTagSize(2, true), 60, 0, 0)
  assert.equal(base.y, ALERT_TAG_BASE.offset, 'base gap under the label as before')
  assert.equal(base.w, 60 + 4 + 9 + 3 + 5)
})

test('the panel tag animation fades the whole element, not only its border', () => {
  const css = readFileSync(join(__dirname, '..', 'components', 'team-panel', 'team-panel.css'), 'utf8')
  const kf = /@keyframes tm-alert-pulse\{([^@]*?)\}\}/.exec(css)
  assert.ok(kf, 'keyframes present')
  assert.match(kf![1], /opacity:\s*\.?\d/, 'the pulse animates opacity of the whole component')
})
