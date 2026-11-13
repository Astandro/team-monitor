import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickMarkerInterval, timelineLabelWidth } from './timeline-markers'

test('wide track with a short span keeps 1 second markers', () => {
  assert.equal(pickMarkerInterval(10, 600), 1)
})

test('narrow track thins the markers out so they are at least 44px apart', () => {
  // 200 seconds on a 208px track: 10s would be only ~10px apart
  const step = pickMarkerInterval(200, 208)
  assert.ok((step / 200) * 208 >= 44, `step ${step}`)
  assert.equal(step, 60)
})

test('the chosen interval is the smallest one that fits', () => {
  const step = pickMarkerInterval(100, 440) // 44px per 10s
  assert.equal(step, 10)
  assert.equal(pickMarkerInterval(100, 439), 15)
})

test('degenerate input does not throw or return 0', () => {
  assert.ok(pickMarkerInterval(0, 0) >= 1)
  assert.ok(pickMarkerInterval(1e9, 300) >= 1)
})

test('label column is 150 on wide panels and shrinks with narrow ones', () => {
  assert.equal(timelineLabelWidth(700), 150)
  assert.equal(timelineLabelWidth(358), 143)
  assert.equal(timelineLabelWidth(200), 80)
})
