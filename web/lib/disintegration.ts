/**
 * A finished sub-agent disintegrates slowly until the server offboards it (spec ui-cleanup item 6, contract in
 * handover/sota-auto-offboard-server.md). Its last `agent_complete` carries `finished: true`, `finishedAt` and
 * `autoOffboardAt`; progress = (now - finishedAt) / (autoOffboardAt - finishedAt), clamped 0..1.
 *
 * What the owner sees: the node starts whole (dimmed, as before), its outline breaks up piece by piece (the share
 * of outline still there reads as "time left" at a glance), small fragments drift off and fade, and the body fades.
 * At the deadline it is gone; the server then removes it and lists it in "Selesai kontrak" as "otomatis".
 * Under prefers-reduced-motion: no fragments, a plain slow fade.
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

export interface Fragment {
  /** Angle (radians) of the point on the node it left from */
  angle: number
  /** Distance travelled beyond the node edge, px at scale 1 */
  drift: number
  alpha: number
  size: number
}

/** Seconds one fragment takes to drift off and fade. */
export const FRAGMENT_LIFE = 6

/**
 * Fragments in flight at `time` seconds. More of them as the node wears away (2 at the start, 8 near the end);
 * each one drifts outward and fades over FRAGMENT_LIFE seconds, then another leaves from somewhere else.
 * None under reduced motion, none before the clock starts and none once the node is gone.
 */
export function fragments(id: string, progress: number, time: number, reducedMotion: boolean): Fragment[] {
  if (reducedMotion || progress <= 0 || progress >= 1) return []
  const n = Math.round(2 + 6 * progress)
  const out: Fragment[] = []
  for (let j = 0; j < n; j++) {
    const t = time / FRAGMENT_LIFE + unitHash(id, 100 + j)
    const cycle = Math.floor(t)
    const phase = t - cycle
    out.push({
      angle: unitHash(id, 1000 + j * 31 + cycle) * Math.PI * 2,
      drift: phase * (10 + 22 * progress),
      alpha: (1 - phase) * 0.85,
      size: 0.8 + unitHash(id, 2000 + j) * 1.4,
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
 * (b) a slow nebula explosion repeats on the node: a bright core, then soft clouds of gas (magenta, violet, teal,
 *     gold) that swell and fade over a few seconds, more often as the deadline nears.
 * Reduced motion: no nebula, the tag stays as a static alert, the node keeps its plain fade.
 * Canvas cost per leaving node per frame while a nebula shows: five radial-gradient circles, nothing per pixel.
 */

/** Small tag next to a disintegrating name (graph label and panel card). */
export const DISINTEGRATING_TAG = 'disintegrating'

/*
 * Owner feedback 13 Nov (calmer nebula): with several nodes leaving at once the four-cloud bursts were crowded.
 * Now two smaller clouds per burst at about half the strength, a slower swell and longer gaps; still slow and epic.
 */

/** Seconds between nebula explosions: one every 22 s at the start of the hour, one every 10 s near the end. */
export function burstPeriod(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  return 22 - 12 * p
}

/** Seconds one nebula explosion takes to swell and fade (slow). */
export const BURST_LIFE = 6

/** Share of an explosion spent swelling in, before the long fade. */
export const NEBULA_SWELL = 0.35

/** Gas clouds per explosion; each explosion takes a different pair of the colours. */
export const NEBULA_CLOUDS = 2

/** Peak alpha at a cloud's centre, and of the bright core. */
export const NEBULA_PEAK_ALPHA = 0.2
export const NEBULA_CORE_ALPHA = 0.45

/** Nebula gas colours (dark sky); the core is a warm white. */
export const NEBULA_COLORS = ['#E35BD6', '#8E6CFF', '#2FD3C4', '#F5C451'] as const
export const NEBULA_CORE = '#FFF4DC'

export interface NebulaCloud {
  /** Cloud centre offset from the node centre, px at scale 1 */
  dx: number
  dy: number
  /** Cloud radius, px at scale 1 */
  radius: number
  color: string
  /** Peak alpha at the cloud centre (the gradient fades it to 0 at the edge) */
  alpha: number
}

export interface Burst {
  /** 0..1 through the explosion */
  phase: number
  /** Bright core: radius px and alpha (it flares first and fades before the clouds) */
  core: { radius: number; alpha: number }
  clouds: NebulaCloud[]
}

const easeOut = (x: number) => 1 - (1 - x) ** 3

/**
 * The nebula showing at `time` seconds for a node of radius `r`, or null between explosions. Each node has its own
 * offset (no two flare in step) and each explosion its own cloud directions. None under reduced motion, before the
 * clock starts or once the node is gone.
 */
export function burstAt(id: string, progress: number, time: number, reducedMotion: boolean, r = 24): Burst | null {
  if (reducedMotion || progress <= 0 || progress >= 1) return null
  const period = burstPeriod(progress)
  const t = time + unitHash(id, 7) * period
  const cycle = Math.floor(t / period)
  const into = t - cycle * period
  if (into >= BURST_LIFE) return null
  const phase = into / BURST_LIFE
  const grow = easeOut(phase)
  // slow swell in, then a long fade
  const env = phase < NEBULA_SWELL ? phase / NEBULA_SWELL : 1 - (phase - NEBULA_SWELL) / (1 - NEBULA_SWELL)
  const core = {
    radius: r * (0.5 + 0.6 * easeOut(Math.min(1, phase / 0.4))),
    alpha: phase < 0.12 ? NEBULA_CORE_ALPHA * (phase / 0.12) : Math.max(0, NEBULA_CORE_ALPHA * (1 - (phase - 0.12) / 0.45)),
  }
  // a different pair of colours each explosion (opposite ones on the colour list), per node
  const first = Math.floor(unitHash(id, 600 + cycle) * NEBULA_COLORS.length)
  const clouds: NebulaCloud[] = Array.from({ length: NEBULA_CLOUDS }, (_, k) => {
    const color = NEBULA_COLORS[(first + k * 2) % NEBULA_COLORS.length]
    const angle = (unitHash(id, 300 + cycle * 7 + k) * 0.5 + k / NEBULA_CLOUDS) * Math.PI * 2
    const reach = r * (0.3 + 0.8 * grow) * (0.7 + 0.6 * unitHash(id, 400 + cycle * 5 + k))
    return {
      dx: Math.cos(angle) * reach,
      dy: Math.sin(angle) * reach,
      radius: r * (0.7 + (1.4 + 0.6 * unitHash(id, 500 + k)) * grow),
      color,
      alpha: NEBULA_PEAK_ALPHA * env,
    }
  })
  return { phase, core, clouds }
}

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
