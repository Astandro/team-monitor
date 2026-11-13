import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { alertBlinkAlpha, ALERT_BLINK_MIN_ALPHA } from './alert-tag'

test('the whole alert component blinks: full opacity at rest, dimmed at the peak of a pulse', () => {
  assert.equal(alertBlinkAlpha(0), 1, 'static and reduced-motion state is fully visible')
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
  assert.ok(near(alertBlinkAlpha(1), ALERT_BLINK_MIN_ALPHA))
  assert.ok(ALERT_BLINK_MIN_ALPHA <= 0.5, 'the blink is clearly visible')
  assert.ok(alertBlinkAlpha(0.5) < 1 && alertBlinkAlpha(0.5) > ALERT_BLINK_MIN_ALPHA)
  assert.equal(alertBlinkAlpha(-1), 1)
  assert.ok(near(alertBlinkAlpha(2), ALERT_BLINK_MIN_ALPHA))
})

test('the panel tag animation fades the whole element, not only its border', () => {
  const css = readFileSync(join(__dirname, '..', 'components', 'team-panel', 'team-panel.css'), 'utf8')
  const kf = /@keyframes tm-alert-pulse\{([^@]*?)\}\}/.exec(css)
  assert.ok(kf, 'keyframes present')
  assert.match(kf![1], /opacity:\s*\.?\d/, 'the pulse animates opacity of the whole component')
})
