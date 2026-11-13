import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  centroid,
  clampScale,
  distance,
  doubleTapZoom,
  GESTURE,
  isDoubleTap,
  isTap,
  movedPastSlop,
  pan,
  pinchMove,
  pinchStart,
  zoomAround,
  type Cam,
  type Pt,
} from './touch-gestures'

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`)
/** World point under a screen point */
const world = (cam: Cam, p: Pt): Pt => ({ x: (p.x - cam.x) / cam.scale, y: (p.y - cam.y) / cam.scale })

test('one-finger pan moves the camera by the finger delta and keeps the scale', () => {
  assert.deepEqual(pan({ x: 10, y: 20, scale: 1.5 }, 30, -12), { x: 40, y: 8, scale: 1.5 })
})

test('scale is clamped to the sane range, also for junk input', () => {
  assert.equal(clampScale(10), GESTURE.maxScale)
  assert.equal(clampScale(0.01), GESTURE.minScale)
  assert.equal(clampScale(1.3), 1.3)
  assert.equal(clampScale(Number.NaN), GESTURE.minScale)
})

test('zoom around a point keeps the world point under it in place', () => {
  const cam = { x: 100, y: 50, scale: 1 }
  const c = { x: 200, y: 300 }
  const before = world(cam, c)
  const next = zoomAround(cam, c, 2)
  near(next.scale, 2)
  const after = world(next, c)
  near(after.x, before.x)
  near(after.y, before.y)
})

test('zoom around clamps the scale and still pins the centre', () => {
  const cam = { x: 0, y: 0, scale: 3 }
  const c = { x: 120, y: 80 }
  const next = zoomAround(cam, c, 5)
  near(next.scale, GESTURE.maxScale)
  near(world(next, c).x, world(cam, c).x)
  near(world(next, c).y, world(cam, c).y)
})

test('centroid and distance of two fingers', () => {
  assert.deepEqual(centroid([{ x: 0, y: 0 }, { x: 10, y: 20 }]), { x: 5, y: 10 })
  assert.deepEqual(centroid([]), { x: 0, y: 0 })
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
})

test('pinch spreading the fingers to twice the distance doubles the scale around the pinch centre', () => {
  const cam = { x: 40, y: 60, scale: 1 }
  const start = pinchStart(cam, { x: 150, y: 300 }, { x: 250, y: 300 })
  const next = pinchMove(start, { x: 100, y: 300 }, { x: 300, y: 300 })
  near(next.scale, 2)
  // the world point under the pinch centre stays under it
  const w0 = world(cam, { x: 200, y: 300 })
  const w1 = world(next, { x: 200, y: 300 })
  near(w1.x, w0.x)
  near(w1.y, w0.y)
})

test('pinch closing zooms out, and moving both fingers together pans', () => {
  const cam = { x: 0, y: 0, scale: 2 }
  const start = pinchStart(cam, { x: 100, y: 100 }, { x: 300, y: 100 })
  const out = pinchMove(start, { x: 150, y: 100 }, { x: 250, y: 100 })
  near(out.scale, 1)
  const moved = pinchMove(start, { x: 130, y: 140 }, { x: 330, y: 140 })
  near(moved.scale, 2)
  near(moved.x - cam.x, 30)
  near(moved.y - cam.y, 40)
})

test('pinch scale is clamped at both ends', () => {
  const cam = { x: 0, y: 0, scale: 1 }
  const start = pinchStart(cam, { x: 190, y: 400 }, { x: 200, y: 400 })
  near(pinchMove(start, { x: 0, y: 400 }, { x: 390, y: 400 }).scale, GESTURE.maxScale)
  const wide = pinchStart(cam, { x: 0, y: 400 }, { x: 390, y: 400 })
  near(pinchMove(wide, { x: 195, y: 400 }, { x: 196, y: 400 }).scale, GESTURE.minScale)
})

test('a tap is short and still; a slow press or a drag is not', () => {
  const down = { pt: { x: 100, y: 100 }, t: 1000 }
  assert.equal(isTap(down, { pt: { x: 104, y: 103 }, t: 1150 }), true)
  assert.equal(isTap(down, { pt: { x: 100, y: 100 }, t: 1000 + GESTURE.tapMaxMs + 1 }), false)
  assert.equal(isTap(down, { pt: { x: 130, y: 100 }, t: 1100 }), false)
})

test('double tap: second tap soon and close to the first', () => {
  const first = { pt: { x: 100, y: 100 }, t: 1000 }
  assert.equal(isDoubleTap(null, first), false)
  assert.equal(isDoubleTap(first, { pt: { x: 110, y: 108 }, t: 1200 }), true)
  assert.equal(isDoubleTap(first, { pt: { x: 110, y: 108 }, t: 1000 + GESTURE.doubleTapMs + 1 }), false)
  assert.equal(isDoubleTap(first, { pt: { x: 200, y: 100 }, t: 1200 }), false)
  assert.equal(isDoubleTap(first, { pt: { x: 100, y: 100 }, t: 900 }), false)
})

test('double tap zooms in around the tapped point, clamped at the max', () => {
  const cam = { x: 10, y: 10, scale: 1 }
  const p = { x: 200, y: 400 }
  const next = doubleTapZoom(cam, p)
  near(next.scale, GESTURE.doubleTapZoom)
  near(world(next, p).x, world(cam, p).x)
  near(world(next, p).y, world(cam, p).y)
  near(doubleTapZoom({ x: 0, y: 0, scale: 3.9 }, p).scale, GESTURE.maxScale)
})

test('a finger past the tap slop is a drag', () => {
  assert.equal(movedPastSlop({ x: 0, y: 0 }, { x: 6, y: 6 }), false)
  assert.equal(movedPastSlop({ x: 0, y: 0 }, { x: 11, y: 0 }), true)
})
