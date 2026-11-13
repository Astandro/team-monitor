/**
 * Owner screenshots 13 Nov: large soft blobs sat behind the graph on the phone and slid along when panning.
 * Cause: the bloom pass was laid over the canvas dpr times too large (BloomRenderer drew `canvas.width` device pixels
 * into a context already scaled by the device pixel ratio). These tests pin the fix and the rules around it: the
 * bloom covers the canvas pixel for pixel at any dpr, the background draws no soft glow, the stars move only slightly
 * with the camera, and the ember effect of a leaving node stays small and on its node.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compositeBloom, type BloomTarget } from '@/components/agent-visualizer/bloom-renderer'
import { drawBackground } from '@/components/agent-visualizer/background-layer'
import { createSkyParticles } from './sky'
import { applyGraphTheme as setGraphTheme } from './colors'
import { debris, emberGlow, sparks } from './disintegration'

type M = [number, number, number, number, number, number]

/** Records draws with the transform in force, like a 2D context. */
function fakeCtx() {
  let m: M = [1, 0, 0, 1, 0, 0]
  const stack: Array<{ m: M; op: string; alpha: number }> = []
  const log = {
    images: [] as Array<{ x: number; y: number; w: number; h: number }>,
    gradients: 0,
    fills: [] as Array<{ w: number; h: number }>,
    arcs: [] as Array<{ x: number; y: number; r: number }>,
  }
  const ctx = {
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    save() { stack.push({ m: [...m] as M, op: ctx.globalCompositeOperation, alpha: ctx.globalAlpha }) },
    restore() {
      const s = stack.pop()
      if (s) { m = s.m; ctx.globalCompositeOperation = s.op; ctx.globalAlpha = s.alpha }
    },
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) { m = [a, b, c, d, e, f] },
    scale(sx: number, sy: number) { m = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[4], m[5]] },
    translate(tx: number, ty: number) { m = [m[0], m[1], m[2], m[3], m[4] + m[0] * tx + m[2] * ty, m[5] + m[1] * tx + m[3] * ty] },
    drawImage(_img: unknown, x: number, y: number, w: number, h: number) {
      log.images.push({ x: m[0] * x + m[4], y: m[3] * y + m[5], w: m[0] * w, h: m[3] * h })
    },
    createRadialGradient() { log.gradients++; return { addColorStop() {} } },
    createLinearGradient() { log.gradients++; return { addColorStop() {} } },
    fillRect(_x: number, _y: number, w: number, h: number) { log.fills.push({ w, h }) },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    arc(x: number, y: number, r: number) { log.arcs.push({ x, y, r }) },
  }
  return { ctx, log }
}

describe('bloom is laid over the canvas pixel for pixel', () => {
  for (const dpr of [1, 2, 2.625, 3]) {
    it(`dpr ${dpr}`, () => {
      const { ctx, log } = fakeCtx()
      const cssW = 390, cssH = 700
      ctx.scale(dpr, dpr) // as canvas.tsx sets it up
      compositeBloom(ctx as unknown as BloomTarget, {} as CanvasImageSource, cssW * dpr, cssH * dpr, 0.5)
      assert.equal(log.images.length, 1)
      assert.deepEqual(log.images[0], { x: 0, y: 0, w: cssW * dpr, h: cssH * dpr })
      // and the caller's transform is back afterwards
      ctx.drawImage({}, 0, 0, 1, 1)
      assert.equal(log.images[1].w, dpr)
      assert.equal(ctx.globalCompositeOperation, 'source-over')
    })
  }
})

describe('background: stars or dust only, no soft glow', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(theme, () => {
      setGraphTheme(theme)
      const { ctx, log } = fakeCtx()
      const w = 390, h = 700
      const sky = createSkyParticles(theme, w, h, mulberry(7))
      drawBackground(ctx as unknown as CanvasRenderingContext2D, w, h, sky, { x: 120, y: -80, scale: 0.6 }, false, 3, false)
      assert.equal(log.gradients, 0, 'no gradient behind the graph')
      assert.deepEqual(log.fills, [{ w, h }], 'one plain fill: the sky colour')
      assert.ok(log.arcs.length > 0)
      for (const a of log.arcs) assert.ok(a.r <= 2, `particle radius ${a.r}`)
    })
  }
  it('the stars move at most a tenth of a pan', () => {
    setGraphTheme('dark')
    const w = 390, h = 700
    // all particles mid-screen so none is culled and the draw order matches between the two frames
    const sky = createSkyParticles('dark', w, h, mulberry(3)).map((p) => ({ ...p, x: w / 2, y: h / 2 }))
    const at = (x: number) => {
      const { ctx, log } = fakeCtx()
      drawBackground(ctx as unknown as CanvasRenderingContext2D, w, h, sky, { x, y: 0, scale: 1 }, false, 0, true)
      return log.arcs
    }
    const a = at(0), b = at(-60)
    let moved = 0
    for (let i = 0; i < Math.min(a.length, b.length); i++) moved = Math.max(moved, Math.abs(b[i].x - a[i].x))
    assert.ok(moved > 0 && moved <= 6, `moved ${moved} px for a 60 px pan`)
  })
})

describe('the ember effect of a leaving node stays on its node', () => {
  it('glow, debris and sparks end within about 3 node radii of the node centre', () => {
    const r = 24
    let worst = 0
    for (const id of ['a', 'mei-review', 'kaito-x', 'sota']) {
      for (let p = 0.05; p < 1; p += 0.15) {
        for (let t = 0; t < 30; t += 0.25) {
          const g = emberGlow(id, p, t, false)
          if (g) worst = Math.max(worst, r + g.pad)
          for (const m of debris(id, p, t, false, r)) worst = Math.max(worst, Math.hypot(m.x, m.y) + m.size)
          for (const s of sparks(id, p, t, false, r)) worst = Math.max(worst, Math.hypot(s.x, s.y) + s.size)
        }
      }
    }
    assert.ok(worst > 2 * r && worst <= 3.2 * r, `worst extent ${(worst / r).toFixed(2)} r`)
  })
})

function mulberry(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
