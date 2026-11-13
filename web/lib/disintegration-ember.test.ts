/**
 * Owner feedback 13 Nov: the nebula bursts are replaced by a symmetric ember glow round a leaving node (like the blue
 * glow of an active agent, in orange), many more pieces of debris breaking off, more often, and small sparks of light.
 * The hour's progress stays readable: glow, debris and sparks all grow as the deadline nears.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as D from './disintegration'
import {
  debris, debrisCount, debrisRate, DEBRIS_LIFE, EMBER, emberGlow, flickerPeriod, GLOW_ALPHA, GLOW_PAD, hexEdge,
  panelEmberVars, SPARK_ON, SPARK_PERIOD, sparkCount, sparkRate, sparks, tagPulse,
} from './disintegration'

const R = 24
const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8')

/** Mean of f over `seconds`, sampled every 50 ms. */
function mean(f: (t: number) => number, seconds = 12): number {
  let s = 0
  let n = 0
  for (let t = 0; t < seconds; t += 0.05, n++) s += f(t)
  return s / n
}

test('hexagon edge: a vertex at the circumradius, an edge midpoint at the apothem', () => {
  assert.ok(Math.abs(hexEdge(R, -Math.PI / 2) - R) < 1e-9)
  assert.ok(Math.abs(hexEdge(R, Math.PI / 6) - R) < 1e-9)
  assert.ok(Math.abs(hexEdge(R, 0) - R * Math.cos(Math.PI / 6)) < 1e-9)
  assert.ok(Math.abs(hexEdge(R, Math.PI / 3) - R * Math.cos(Math.PI / 6)) < 1e-9)
  assert.ok(Math.abs(hexEdge(R, -0.2) - hexEdge(R, 0.2)) < 1e-9, 'symmetric about an edge midpoint')
})

test('the glow is centred on the node (no offset) and grows wider and stronger as the deadline nears', () => {
  const g = emberGlow('Hiro', 0.5, 3, false)!
  assert.deepEqual(Object.keys(g).sort(), ['alpha', 'pad'], 'only strength and reach: always round the centre')
  const strength = (p: number) => mean((t) => emberGlow('Hiro', p, t, false)!.alpha)
  assert.ok(strength(0.1) < strength(0.5) && strength(0.5) < strength(0.9), `${strength(0.1)} ${strength(0.5)} ${strength(0.9)}`)
  assert.ok(emberGlow('Hiro', 0.1, 0, false)!.pad < emberGlow('Hiro', 0.9, 0, false)!.pad)
  assert.equal(emberGlow('Hiro', 0.000001, 0, false)!.pad.toFixed(2), GLOW_PAD.start.toFixed(2))
  // stronger than the active glow (0.2) from the start, so it is clearly visible
  assert.ok(GLOW_ALPHA.start > 0.2 && GLOW_ALPHA.end <= 0.7)
  for (let t = 0; t < 10; t += 0.1) assert.ok(emberGlow('Hiro', 0.9, t, false)!.alpha <= GLOW_ALPHA.end + 1e-9)
})

test('the glow breathes with the alert tag (same period and phase) and fades out at the very end', () => {
  let best = { t: 0, a: 0 }
  for (let t = 0; t < 4; t += 0.01) {
    const a = emberGlow('Ren', 0.5, t, false)!.alpha
    if (a > best.a) best = { t, a }
  }
  assert.ok(tagPulse('Ren', 0.5, best.t, false) > 0.99, 'brightest when the tag peaks')
  const lo = Math.min(...Array.from({ length: 400 }, (_, i) => emberGlow('Ren', 0.5, i * 0.01, false)!.alpha))
  assert.ok(lo / best.a > 0.65 && lo / best.a < 0.75, `breath ${lo / best.a}`)
  assert.ok(emberGlow('Ren', 0.99, 0, false)!.alpha < emberGlow('Ren', 0.9, 0, false)!.alpha * 0.5, 'fades before the end')
})

test('many more pieces of debris than the old fragments, more often as the deadline nears', () => {
  assert.equal(debrisCount(0), 12)
  assert.equal(debrisCount(1), 42)
  let prev = 0
  for (let p = 0.05; p < 1; p += 0.05) {
    assert.ok(debrisRate(p) >= prev, `rate at ${p}`)
    prev = debrisRate(p)
  }
  assert.ok(debrisRate(0.01) >= 5, 'about 5 a second at the start (the old fragments: 1 every 3 s)')
  assert.ok(debrisRate(0.99) >= 18)
  assert.equal(debris('Hiro', 0.5, 7, false, R).length, debrisCount(0.5))
  // pieces really restart that often: count fresh pieces (alpha near full) over 20 s
  let fresh = 0
  const last = new Map<number, number>()
  for (let t = 0; t < 20; t += 0.02) {
    debris('Hiro', 0.5, t, false, R).forEach((m, j) => {
      if (m.alpha > (last.get(j) ?? 2)) fresh++
      last.set(j, m.alpha)
    })
  }
  const want = debrisRate(0.5) * 20
  assert.ok(Math.abs(fresh - want) / want < 0.1, `${fresh} new pieces in 20 s, want about ${want}`)
  assert.ok(DEBRIS_LIFE <= 3, 'short lives: the edge keeps shedding')
})

test('a piece of debris leaves from the edge, drifts outward, shrinks and fades', () => {
  // follow slot 0 through one life
  const at = (t: number) => debris('Mei', 0.5, t, false, R)[0]
  let start = -1
  for (let t = 0; t < 5; t += 0.005) {
    const a = at(t)
    if (a.alpha > 0.94) { start = t; break }
  }
  assert.ok(start >= 0, 'found a fresh piece')
  const a = at(start)
  const b = at(start + DEBRIS_LIFE * 0.4)
  const c = at(start + DEBRIS_LIFE * 0.9)
  const d0 = Math.hypot(a.x, a.y)
  assert.ok(d0 >= R * Math.cos(Math.PI / 6) - 0.5 && d0 <= R + 0.5, `starts on the edge (${d0.toFixed(1)})`)
  assert.ok(Math.hypot(b.x, b.y) > d0 && Math.hypot(c.x, c.y) > Math.hypot(b.x, b.y), 'moves outward')
  assert.ok(b.alpha < a.alpha && c.alpha < b.alpha && c.alpha < 0.05, 'fades')
  assert.ok(c.size < a.size, 'shrinks')
})

test('debris leaves from all round the node, not from one side', () => {
  const sectors = new Set<number>()
  for (let t = 0; t < 10; t += 0.5) {
    for (const m of debris('Sora', 0.3, t, false, R)) sectors.add(Math.floor(((Math.atan2(m.y, m.x) + Math.PI) / (2 * Math.PI)) * 6) % 6)
  }
  assert.equal(sectors.size, 6)
})

test('sparks: short flares just outside the edge, more of them as the deadline nears', () => {
  assert.equal(sparkCount(0), 4)
  assert.equal(sparkCount(1), 16)
  assert.ok(sparkRate(0.01) >= 3 && sparkRate(0.99) > sparkRate(0.5) && sparkRate(0.5) > sparkRate(0.01))
  // lit about SPARK_ON of the time per slot
  const lit = mean((t) => sparks('Yuki', 0.5, t, false, R).length, 24) / sparkCount(0.5)
  assert.ok(Math.abs(lit - SPARK_ON) < 0.08, `lit share ${lit}`)
  for (let t = 0; t < 6; t += 0.1) {
    for (const s of sparks('Yuki', 0.5, t, false, R)) {
      const d = Math.hypot(s.x, s.y)
      assert.ok(d >= hexEdge(R, Math.atan2(s.y, s.x)) - 1e-6, 'outside the edge')
      assert.ok(s.alpha >= 0 && s.alpha <= 1)
    }
  }
  // a spark rises then dies: follow slot 0
  const first = (t: number) => {
    const ph = ((t / SPARK_PERIOD + D.unitHash('Yuki', 3000)) % 1)
    return ph
  }
  let t0 = 0
  while (first(t0) > 0.01) t0 += 0.005
  const alphaAt = (dt: number) => Math.sin(Math.PI * (first(t0 + dt) / SPARK_ON))
  assert.ok(alphaAt(SPARK_PERIOD * SPARK_ON * 0.5) > alphaAt(SPARK_PERIOD * SPARK_ON * 0.1))
})

test('the effect reads as progress: total light from debris and sparks rises over the hour', () => {
  const light = (p: number) => mean((t) => {
    let s = 0
    for (const m of debris('Kaito', p, t, false, R)) s += m.alpha * m.size
    for (const m of sparks('Kaito', p, t, false, R)) s += m.alpha * m.size
    return s
  }, 8)
  assert.ok(light(0.1) < light(0.5) && light(0.5) < light(0.9), `${light(0.1)} ${light(0.5)} ${light(0.9)}`)
})

test('stable per node, different between nodes', () => {
  assert.deepEqual(debris('Hiro', 0.4, 5.5, false, R), debris('Hiro', 0.4, 5.5, false, R))
  assert.notDeepEqual(debris('Hiro', 0.4, 5.5, false, R), debris('Ren', 0.4, 5.5, false, R))
})

test('reduced motion: no glow, no debris, no sparks (a plain fade); nothing before the clock or after the deadline', () => {
  for (const p of [0.2, 0.7]) {
    assert.equal(emberGlow('Hiro', p, 3, true), null)
    assert.deepEqual(debris('Hiro', p, 3, true), [])
    assert.deepEqual(sparks('Hiro', p, 3, true), [])
    assert.equal(panelEmberVars(p, true), null)
  }
  for (const p of [0, 1]) {
    assert.equal(emberGlow('Hiro', p, 3, false), null)
    assert.deepEqual(debris('Hiro', p, 3, false), [])
    assert.deepEqual(sparks('Hiro', p, 3, false), [])
    assert.equal(panelEmberVars(p, false), null)
  }
})

test('ember colours: orange family, one set per theme', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const c of Object.values(EMBER[theme])) {
      assert.match(c, /^#[0-9A-F]{6}$/)
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
      assert.ok(r > g && g >= b, `${theme} ${c} is warm`)
    }
  }
})

test('panel avatar: glow strength, breath and spark period follow the hour', () => {
  const a = panelEmberVars(0.1, false)!
  const b = panelEmberVars(0.9, false)!
  assert.ok(Number(a['--tm-glow']) < Number(b['--tm-glow']))
  assert.equal(b['--tm-flicker'], `${flickerPeriod(0.9).toFixed(2)}s`)
  assert.ok(parseFloat(b['--tm-spark']) < parseFloat(a['--tm-spark']), 'sparks more often near the end')
})

test('the nebula is gone: no nebula exports, no nebula drawing on the canvas or in the panel', () => {
  for (const k of ['burstAt', 'burstPeriod', 'BURST_LIFE', 'NEBULA_COLORS', 'NEBULA_CORE', 'NEBULA_CLOUDS', 'fragments']) {
    assert.equal(k in D, false, `${k} still exported`)
  }
  const draw = read('components', 'agent-visualizer', 'canvas', 'draw-agents.ts')
  assert.ok(!/nebula/i.test(draw), 'draw-agents.ts mentions a nebula')
  assert.ok(draw.includes('drawEmberGlow(ctx') && draw.includes('drawDebrisAndSparks(ctx'))
  const css = read('components', 'team-panel', 'team-panel.css')
  assert.ok(!/tm-nebula|\.bursting/.test(css), 'panel css still has the nebula')
  assert.ok(css.includes('@keyframes tm-ember') && css.includes('.tm-av.leaving.burning::before'))
  const tsx = read('components', 'team-panel', 'team-panel.tsx')
  assert.ok(!tsx.includes('burstPeriod') && tsx.includes('panelEmberVars('))
})

test('cheap on canvas: the per-frame ember drawing uses cached sprites and rectangles, no gradient or pixel work', () => {
  const draw = read('components', 'agent-visualizer', 'canvas', 'draw-agents.ts')
  for (const fn of ['function drawEmberGlow', 'function drawDebrisAndSparks']) {
    const start = draw.indexOf(fn)
    assert.ok(start >= 0, fn)
    const body = draw.slice(start, draw.indexOf('\n}\n', start))
    for (const bad of ['createRadialGradient', 'createLinearGradient', 'getImageData', 'putImageData', 'shadowBlur', 'filter']) {
      assert.ok(!body.includes(bad), `${fn} uses ${bad}`)
    }
  }
  // reduced motion in the panel drops the glow and sparks
  const css = read('components', 'team-panel', 'team-panel.css')
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce)'))
  assert.ok(rm.includes('.tm-av.leaving::before') && rm.includes('.tm-av.leaving::after'))
})
