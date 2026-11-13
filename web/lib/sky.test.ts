import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSkyParticles, GOLD_SHARE, skyAlpha, skyTints, SKY_COUNT, TWINKLE_DEPTH, updateSkyParticles } from './sky'

/** Deterministic random numbers so the tests do not flake. */
function seeded(seed = 7): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

test('Terang: background particles are soft blues only', () => {
  for (const c of skyTints('light')) {
    const [r, g, b] = rgb(c)
    assert.ok(b > r + 40 && b > g, `${c} is not blue`)
  }
  const ps = createSkyParticles('light', 800, 600, seeded())
  assert.equal(ps.length, SKY_COUNT.light)
  for (const p of ps) assert.ok(p.brightness <= 0.5, 'soft, never strong dots on white')
})

test('Gelap: stars are mostly white with a few warm gold ones', () => {
  const tints = skyTints('dark')
  const ps = createSkyParticles('dark', 1200, 800, seeded(3))
  assert.equal(ps.length, SKY_COUNT.dark)
  const warm = (c: string) => {
    const [r, , b] = rgb(c)
    return r - b >= 60
  }
  const gold = ps.filter((p) => warm(tints[p.tint])).length
  const white = ps.filter((p) => {
    const [r, g, b] = rgb(tints[p.tint])
    return Math.min(r, g, b) >= 200
  }).length
  assert.ok(gold > 0, 'some gold stars')
  assert.ok(gold < ps.length * (GOLD_SHARE + 0.1), `too many gold stars: ${gold}`)
  assert.ok(white > ps.length * 0.6, `white stars should dominate: ${white}`)
})

test('Gelap: stars vary in size and brightness, most are tiny', () => {
  const ps = createSkyParticles('dark', 1200, 800, seeded(11))
  const sizes = ps.map((p) => p.size)
  const bright = ps.map((p) => p.brightness)
  assert.ok(Math.max(...sizes) - Math.min(...sizes) > 0.6, 'size spread')
  assert.ok(Math.max(...bright) - Math.min(...bright) > 0.3, 'brightness spread')
  const tiny = sizes.filter((s) => s < 0.8).length
  assert.ok(tiny > ps.length * 0.6, `most stars are pinpricks: ${tiny}/${ps.length}`)
  assert.ok(Math.max(...sizes) <= 1.6, 'distant stars, no big dots')
})

test('Gelap: stars twinkle gently over time', () => {
  const [p] = createSkyParticles('dark', 800, 600, seeded(5))
  const samples = Array.from({ length: 200 }, (_, i) => skyAlpha(p, 'dark', i * 0.1, false))
  const lo = Math.min(...samples), hi = Math.max(...samples)
  assert.ok(hi - lo > 0.2 * hi, 'brightness changes')
  assert.ok(lo >= hi * (1 - TWINKLE_DEPTH) - 1e-9, 'never goes out completely')
})

test('reduced motion: no twinkle, no drift', () => {
  const [star] = createSkyParticles('dark', 800, 600, seeded(5))
  const a = [0, 1.3, 2.9, 7].map((t) => skyAlpha(star, 'dark', t, true))
  assert.ok(a.every((v) => v === a[0]), 'constant brightness')

  const dust = createSkyParticles('light', 800, 600, seeded(9))
  const before = dust.map((p) => [p.x, p.y])
  updateSkyParticles(dust, 1, 800, 600, true)
  assert.deepEqual(dust.map((p) => [p.x, p.y]), before)
})

test('Terang dust drifts when motion is allowed; stars never drift and Terang never twinkles', () => {
  const dust = createSkyParticles('light', 800, 600, seeded(9))
  const x0 = dust[0].x
  updateSkyParticles(dust, 1, 800, 600, false)
  assert.notEqual(dust[0].x, x0)
  assert.equal(skyAlpha(dust[0], 'light', 0, false), skyAlpha(dust[0], 'light', 3.7, false))

  const stars = createSkyParticles('dark', 800, 600, seeded(4))
  const pos = stars.map((p) => [p.x, p.y])
  updateSkyParticles(stars, 5, 800, 600, false)
  assert.deepEqual(stars.map((p) => [p.x, p.y]), pos)
})
