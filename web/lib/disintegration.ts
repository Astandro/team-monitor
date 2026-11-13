/**
 * A finished sub-agent disintegrates slowly until the server offboards it (spec ui-cleanup item 6, contract in
 * handover/sota-auto-offboard-server.md). Its last `agent_complete` carries `finished: true`, `finishedAt` and
 * `autoOffboardAt`; progress = (now - finishedAt) / (autoOffboardAt - finishedAt), clamped 0..1.
 *
 * What the owner sees: the node starts whole (dimmed, as before), its outline breaks up piece by piece (the share
 * of outline still there reads as "time left" at a glance), an ember glow sits round it, debris breaks off its edge
 * with small sparks of light, and the body fades. At the deadline it is gone; the server then removes it and lists it
 * in "Selesai kontrak" as "otomatis".
 * Under prefers-reduced-motion: no glow, no debris, no sparks, a plain slow fade.
 * Pure: the canvas (draw-agents.ts) draws what these functions return.
 */

export interface FinishedClock {
  /** Epoch ms of finishedAt / autoOffboardAt */
  at: number
  offboardAt: number
}

/** The clock from an `agent_complete` payload; null unless the server marked the sub-agent finished. */
export function finishedClock(payload: Record<string, unknown> | null | undefined): FinishedClock | null {
  if (!payload || payload.finished !== true) return null
  const at = typeof payload.finishedAt === 'string' ? Date.parse(payload.finishedAt) : NaN
  const offboardAt = typeof payload.autoOffboardAt === 'string' ? Date.parse(payload.autoOffboardAt) : NaN
  if (!Number.isFinite(at) || !Number.isFinite(offboardAt)) return null
  return { at, offboardAt }
}

export function disintegrationProgress(clock: FinishedClock, now: number): number {
  const span = clock.offboardAt - clock.at
  if (!(span > 0)) return now >= clock.offboardAt ? 1 : 0
  return Math.min(1, Math.max(0, (now - clock.at) / span))
}

/** Outline pieces: 6 hexagon edges, 4 pieces each. */
export const OUTLINE_PIECES = 24

/** Small stable hash in 0..1 for a string and an index (same node, same pieces, every frame and every reload). */
export function unitHash(id: string, i: number): number {
  let h = 2166136261 ^ i
  for (let k = 0; k < id.length; k++) {
    h ^= id.charCodeAt(k)
    h = Math.imul(h, 16777619)
  }
  h ^= Math.imul(i + 1, 2654435761)
  h ^= h >>> 15
  h = Math.imul(h, 2246822507)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/**
 * Which outline pieces are still there. Piece k goes once progress passes its own threshold, spread evenly over
 * the hour in a node-specific order, so the share left is 1 - progress and a piece never comes back while the clock
 * runs forward.
 */
export function outlinePieces(id: string, progress: number, count = OUTLINE_PIECES): boolean[] {
  const order = Array.from({ length: count }, (_, k) => k).sort((a, b) => unitHash(id, a) - unitHash(id, b))
  const threshold = new Array<number>(count)
  order.forEach((piece, rank) => { threshold[piece] = (rank + 1) / count })
  return threshold.map((t) => progress < t)
}

/*
 * Owner feedback 13 Nov (replaces the nebula bursts): "symmetric, like the blue light of an active agent, but red or
 * orange; more particles, more often, and small lights, so the effect is clearly visible".
 * - Glow: one radial gradient round the node, the same shape as the active glow, in an ember orange. It grows wider and
 *   stronger over the hour and breathes with the alert tag (same period, same phase), then fades out in the last
 *   moments so the node leaves cleanly.
 * - Debris: small pieces break off the hexagon's edge all the time, drift outward, shrink and fade. 12 in flight at
 *   the start of the hour, 42 near the end (about 5 to 19 a second per node).
 * - Sparks: tiny points of light that flare and die next to the edge, 4 to 16 per node.
 * Positions are offsets from the node centre in px at scale 1. Canvas cost per leaving node per frame: one sprite for
 * the glow, one rectangle per piece of debris, one small sprite per spark; nothing per pixel.
 * Reduced motion: none of it (plain fade). Everything is a pure function of (id, progress, time): stable per node,
 * no state kept between frames.
 */

/** Ember colours per theme: glow, debris and the sparks' light (warm white on the night sky, hot orange on light). */
export const EMBER = {
  dark: { glow: '#FF7A3D', debris: '#FF9F66', spark: '#FFE2B8' },
  light: { glow: '#F2620F', debris: '#C2410C', spark: '#FF8A2A' },
} as const

/** Glow strength at the start and at the end of the hour (peak alpha of the gradient). */
export const GLOW_ALPHA = { start: 0.32, end: 0.62 } as const

/** Glow reach beyond the node edge, px at scale 1, at the start and at the end (the active glow reaches 20). */
export const GLOW_PAD = { start: 14, end: 30 } as const

/** Share of the hour, at its very end, over which the glow fades out. */
export const GLOW_FADE_TAIL = 0.04

export interface EmberGlow {
  /** Peak alpha of the radial gradient */
  alpha: number
  /** How far the glow reaches past the node edge, px at scale 1 */
  pad: number
}

/** The ember glow round a leaving node at `time` seconds, or null when there is none. */
export function emberGlow(id: string, progress: number, time: number, reducedMotion: boolean): EmberGlow | null {
  if (reducedMotion || progress <= 0 || progress >= 1) return null
  const p = progress
  const base = GLOW_ALPHA.start + (GLOW_ALPHA.end - GLOW_ALPHA.start) * p
  const tail = Math.min(1, (1 - p) / GLOW_FADE_TAIL)
  // breathes with the alert tag: 70% at the tag's low point, 100% at its peak
  const breath = 0.7 + 0.3 * tagPulse(id, p, time, false)
  return { alpha: base * breath * tail, pad: GLOW_PAD.start + (GLOW_PAD.end - GLOW_PAD.start) * p }
}

/** Seconds one piece of debris takes to break off, drift and fade. */
export const DEBRIS_LIFE = 2.2

/** Pieces of debris in flight at once: 12 at the start of the hour, 42 near the end. */
export function debrisCount(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  return Math.round(12 + 30 * p)
}

/** Pieces breaking off per second. */
export function debrisRate(progress: number): number {
  return debrisCount(progress) / DEBRIS_LIFE
}

/** Distance from the centre to the edge of a pointy-top hexagon of circumradius r, at `angle`. */
export function hexEdge(r: number, angle: number): number {
  const side = Math.PI / 3
  const a = ((angle % side) + side) % side
  const rel = a <= side / 2 ? a : a - side
  return (r * Math.cos(Math.PI / 6)) / Math.cos(rel)
}

export interface Mote {
  /** Offset from the node centre, px at scale 1 */
  x: number
  y: number
  /** Side of a piece of debris, or the radius of a spark's light, px at scale 1 */
  size: number
  alpha: number
}

const easeOut = (x: number) => 1 - (1 - x) ** 3

/**
 * Debris in flight at `time` seconds for a node of radius `r`. Each slot breaks a piece off a new point of the edge
 * every DEBRIS_LIFE seconds; the piece drifts outward (further as the node wears away), curls a little, shrinks and
 * fades. None under reduced motion, before the clock starts or once the node is gone.
 */
export function debris(id: string, progress: number, time: number, reducedMotion: boolean, r = 24): Mote[] {
  if (reducedMotion || progress <= 0 || progress >= 1) return []
  const n = debrisCount(progress)
  const out: Mote[] = []
  for (let j = 0; j < n; j++) {
    const t = time / DEBRIS_LIFE + unitHash(id, 100 + j)
    const cycle = Math.floor(t)
    const phase = t - cycle
    const h = unitHash(id, 1000 + j * 31 + cycle)
    const angle0 = h * Math.PI * 2
    const angle = angle0 + (unitHash(id, 1500 + j * 13 + cycle) - 0.5) * 0.6 * phase
    const reach = r * (0.5 + 1.0 * progress) * (0.6 + 0.8 * unitHash(id, 2500 + j * 7 + cycle))
    const d = hexEdge(r, angle0) + easeOut(phase) * reach
    out.push({
      x: Math.cos(angle) * d,
      y: Math.sin(angle) * d,
      size: (1 + 1.6 * unitHash(id, 2000 + j)) * (1 - 0.5 * phase),
      alpha: 0.95 * (1 - phase) ** 1.5,
    })
  }
  return out
}

/** Seconds per spark slot, and the share of it the spark is lit (a short flare, then dark until the next one). */
export const SPARK_PERIOD = 1.2
export const SPARK_ON = 0.35

/** Spark slots per node: 4 at the start of the hour, 16 near the end. */
export function sparkCount(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  return Math.round(4 + 12 * p)
}

/** Sparks lit per second. */
export function sparkRate(progress: number): number {
  return sparkCount(progress) / SPARK_PERIOD
}

/**
 * Sparks lit at `time` seconds: each flares up and dies over SPARK_ON x SPARK_PERIOD seconds at a point just past the
 * edge, moving out a little; the next one in that slot lights somewhere else. Size is the radius of its light.
 */
export function sparks(id: string, progress: number, time: number, reducedMotion: boolean, r = 24): Mote[] {
  if (reducedMotion || progress <= 0 || progress >= 1) return []
  const n = sparkCount(progress)
  const out: Mote[] = []
  for (let j = 0; j < n; j++) {
    const t = time / SPARK_PERIOD + unitHash(id, 3000 + j)
    const cycle = Math.floor(t)
    const phase = t - cycle
    if (phase >= SPARK_ON) continue
    const s = phase / SPARK_ON
    const angle = unitHash(id, 4000 + j * 17 + cycle) * Math.PI * 2
    const d = hexEdge(r, angle) + r * (0.05 + 0.55 * unitHash(id, 5000 + j * 11 + cycle)) + s * r * 0.25
    out.push({
      x: Math.cos(angle) * d,
      y: Math.sin(angle) * d,
      size: 2.5 + 2 * unitHash(id, 6000 + j),
      alpha: Math.sin(Math.PI * s),
    })
  }
  return out
}

export interface DisintegrationLook {
  /** Multiplier for the node body (fill, icon, context bar) */
  body: number
  /** Multiplier for the name and role */
  label: number
  /** Outline pieces still drawn; null = draw the outline whole (reduced motion fades it with the body instead) */
  pieces: boolean[] | null
}

/**
 * How a finished node looks at `progress`. The name stays at full strength for most of the hour (who was on the
 * team stays readable) and fades only in the last fifth; at 1 everything is gone.
 */
export function disintegrationLook(id: string, progress: number, reducedMotion: boolean): DisintegrationLook {
  const p = Math.min(1, Math.max(0, progress))
  const label = p < 0.8 ? 1 : Math.max(0, (1 - p) / 0.2)
  if (reducedMotion) return { body: 1 - p, label, pieces: null }
  return { body: p >= 1 ? 0 : 1 - 0.7 * p, label, pieces: outlinePieces(id, p) }
}

/*
 * Owner correction 13 Nov (item 4, replaces Haruki's item 7): while a node or member disintegrates
 * (a) the "disintegrating" tag is an alert: red tint, matching border, readable text; it is the tag that pulses
 *     slowly (faster near the deadline), the name stays steady;
 * (b) the node's own effect is the ember glow, debris and sparks above (the nebula bursts were dropped on the
 *     owner's feedback the same day).
 * Reduced motion: the tag stays as a static alert, the node keeps its plain fade.
 */

/**
 * The team panel's avatar in small (team-panel.css `.burning`): CSS variables for the glow strength (same curve as
 * the graph, without the breath, which the CSS adds in step with the tag), the breath period (the tag's) and the
 * spark period (1.6 s at the start, 0.8 s near the end). Null under reduced motion or outside the hour.
 */
export function panelEmberVars(progress: number, reducedMotion: boolean): Record<'--tm-glow' | '--tm-flicker' | '--tm-spark', string> | null {
  if (reducedMotion || progress <= 0 || progress >= 1) return null
  const p = progress
  const tail = Math.min(1, (1 - p) / GLOW_FADE_TAIL)
  return {
    '--tm-glow': ((GLOW_ALPHA.start + (GLOW_ALPHA.end - GLOW_ALPHA.start) * p) * tail).toFixed(2),
    '--tm-flicker': `${flickerPeriod(p).toFixed(2)}s`,
    '--tm-spark': `${(1.6 - 0.8 * p).toFixed(2)}s`,
  }
}

/** Small tag next to a disintegrating name (graph label and panel card). */
export const DISINTEGRATING_TAG = 'disintegrating'

/** Seconds per slow pulse of the alert tag: 3 s at the start, 1.4 s near the end. */
export function flickerPeriod(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  return 3 - 1.6 * p
}

/**
 * How strong the alert tag's pulse is right now, 0..1 (0 = base tint, 1 = the stronger tint with a ring). Always 0
 * under reduced motion: the tag stays a static alert. The text colour never changes, so it reads at every point.
 */
export function tagPulse(id: string, progress: number, time: number, reducedMotion: boolean): number {
  if (reducedMotion || progress <= 0 || progress >= 1) return 0
  const period = flickerPeriod(progress)
  return 0.5 - 0.5 * Math.cos(((time / period) + unitHash(id, 11)) * Math.PI * 2)
}

/** "Keluar otomatis 15.05 (23 menit lagi)" for the detail card; times in the viewer's local clock. */
export function autoOffboardText(clock: FinishedClock, now: number): string {
  const d = new Date(clock.offboardAt)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`
  const left = Math.ceil((clock.offboardAt - now) / 60_000)
  if (left <= 0) return `Keluar otomatis ${hhmm}, sebentar lagi hilang dari grafik`
  return `Keluar otomatis ${hhmm} (${left} menit lagi)`
}
