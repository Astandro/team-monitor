/**
 * The graph's background particles, per theme (owner direction 13 Nov).
 * - Terang: soft blue dust drifting slowly on the near-white canvas.
 * - Gelap: distant stars on a night sky. Mostly tiny white points, some cool white, a few warm gold ones, with a
 *   spread of sizes and brightness and a gentle twinkle. Stars stay where they are (no drift).
 * Under prefers-reduced-motion nothing drifts and nothing twinkles: each particle keeps its base brightness.
 * Pure: the canvas layer (background-layer.ts) draws what these functions return.
 */

import type { GraphTheme } from './graph-palette'

export interface SkyParticle {
  x: number
  y: number
  /** Radius in px before the depth factor */
  size: number
  /** Base alpha, 0..1 */
  brightness: number
  /** Drift speed (Terang only) */
  speed: number
  /** 0 = far, 1 = near (parallax and size) */
  depth: number
  /** Index into skyTints(theme) */
  tint: number
  /** Twinkle phase (radians) and rate (radians per second) */
  phase: number
  rate: number
}

/** Tints in draw order. Gelap: white, cool white, then the two warm golds. */
const TINTS: Record<GraphTheme, string[]> = {
  light: ['#7FA6E6', '#A8C3EF', '#5B8AD6'],
  dark: ['#FFFFFF', '#DCE6FF', '#FFD58A', '#F2BE62'],
}

export function skyTints(theme: GraphTheme): string[] {
  return TINTS[theme]
}

// Particles are spread over a 2x by 2x area (parallax room), so about a quarter is on screen at once
export const SKY_COUNT: Record<GraphTheme, number> = { light: 90, dark: 280 }

/** Share of gold stars in Gelap: "a few", so the sky still reads white. */
export const GOLD_SHARE = 0.18

/** How deep the twinkle dips: alpha swings between (1 - TWINKLE_DEPTH) and 1 times the base brightness. */
export const TWINKLE_DEPTH = 0.55

type Rand = () => number

function pickTint(theme: GraphTheme, r: number, r2: number): number {
  if (theme === 'light') return Math.floor(r * TINTS.light.length) % TINTS.light.length
  if (r < GOLD_SHARE) return r2 < 0.5 ? 2 : 3
  return r < GOLD_SHARE + 0.25 ? 1 : 0
}

export function createSkyParticles(theme: GraphTheme, width: number, height: number, rand: Rand = Math.random): SkyParticle[] {
  const out: SkyParticle[] = []
  const n = SKY_COUNT[theme]
  for (let i = 0; i < n; i++) {
    const depth = rand()
    const tint = pickTint(theme, rand(), rand())
    // Gelap: most stars are pinpricks, a handful are a little larger (power curve); Terang: soft dust.
    const s = rand()
    const size = theme === 'dark' ? 0.35 + Math.pow(s, 3) * 1.25 : 0.6 + s * 1.6
    const brightness = theme === 'dark' ? 0.35 + rand() * 0.6 : 0.18 + rand() * 0.3
    out.push({
      x: rand() * width * 2 - width * 0.5,
      y: rand() * height * 2 - height * 0.5,
      size,
      brightness,
      speed: theme === 'dark' ? 0 : rand() * 0.15 + 0.05,
      depth,
      tint,
      phase: rand() * Math.PI * 2,
      // a slow twinkle: one cycle every ~3 to ~9 seconds
      rate: 0.7 + rand() * 1.4,
    })
  }
  return out
}

/** Moves the Terang dust; stars and reduced motion stay put. */
export function updateSkyParticles(
  particles: SkyParticle[], deltaTime: number, width: number, height: number, reducedMotion: boolean,
): void {
  if (reducedMotion) return
  for (const p of particles) {
    if (p.speed === 0) continue
    p.x += p.speed * deltaTime * 10 * (1 - p.depth * 0.5)
    p.y -= p.speed * deltaTime * 5 * (1 - p.depth * 0.3)
    if (p.x > width * 1.5) p.x = -width * 0.5
    if (p.y < -height * 0.5) p.y = height * 1.5
  }
}

/** Alpha of one particle at `time` seconds. Twinkles only in Gelap and only when motion is allowed. */
export function skyAlpha(p: SkyParticle, theme: GraphTheme, time: number, reducedMotion: boolean): number {
  const base = p.brightness * (0.55 + p.depth * 0.45)
  if (theme !== 'dark' || reducedMotion) return base
  const wave = (Math.sin(p.phase + time * p.rate) + 1) / 2 // 0..1
  return base * (1 - TWINKLE_DEPTH * wave)
}
