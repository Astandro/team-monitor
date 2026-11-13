import { test } from 'node:test'
import assert from 'node:assert/strict'
import { soundButtonLabel, volumePercent } from './control-labels'

test('the speaker button says the current state and what a tap does', () => {
  assert.equal(soundButtonLabel(true), 'Suara mati. Ketuk untuk nyalakan')
  assert.equal(soundButtonLabel(false), 'Suara nyala. Ketuk untuk matikan')
})

test('volume shows as a whole, clamped percent', () => {
  assert.equal(volumePercent(0.6), 60)
  assert.equal(volumePercent(0.333), 33)
  assert.equal(volumePercent(1.4), 100)
  assert.equal(volumePercent(-1), 0)
  assert.equal(volumePercent(Number.NaN), 0)
})
