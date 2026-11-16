// Sample maths of the sound build (build.mjs), kept pure so it is unit tested (dsp.test.ts).
// segment() and mix() are a straight port of the reference mixer the owner approved (handover mix.py, 16 Nov 2026):
// trim, pitch by linear interpolation, peak-normalise, linear fade in, squared fade out, linear gain. Mono, 48 kHz.

export const SR = 48000

/** Python's int(t * SR) for a time in seconds (truncation, same IEEE arithmetic). */
export const frames = (seconds) => Math.trunc(seconds * SR)

/**
 * One layer cut from a decoded source (mono Float32Array/Float64Array at SR), as mix.py's seg():
 * from/to trim (to undefined = to the end), rate = pitch and speed together (1.5 = higher and shorter),
 * then the peak is normalised to 1, a linear fade in of `fadeIn` s and a squared fade out of `fadeOut` s are
 * applied, and the layer is scaled by `gain` (linear).
 */
export function segment(source, { from = 0, to, rate = 1, fadeIn = 0.005, fadeOut = 0.08, gain = 1 } = {}) {
  const a = frames(from)
  const b = to === undefined ? source.length : frames(to)
  let x = Float64Array.from(source.subarray(a, Math.min(b, source.length)))
  if (x.length < 2) throw new Error(`segment ${from}..${to} is empty`)
  if (rate !== 1) {
    // numpy: idx = arange(0, len - 1, rate); interp(idx, arange(len), x)
    const n = Math.ceil((x.length - 1) / rate)
    const y = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      const p = k * rate
      const i = Math.floor(p)
      const f = p - i
      y[k] = i + 1 < x.length ? x[i] * (1 - f) + x[i + 1] * f : x[i]
    }
    x = y
  }
  let peak = 0
  for (const v of x) peak = Math.max(peak, Math.abs(v))
  const norm = 1 / (peak + 1e-9)
  for (let i = 0; i < x.length; i++) x[i] *= norm
  const ni = frames(fadeIn)
  for (let i = 0; i < ni && i < x.length; i++) x[i] *= ni > 1 ? i / (ni - 1) : 0
  const no = Math.trunc(Math.min(fadeOut * SR, x.length - 1))
  for (let i = 0; i < no; i++) {
    const g = no > 1 ? 1 - i / (no - 1) : 0
    x[x.length - no + i] *= g * g
  }
  for (let i = 0; i < x.length; i++) x[i] *= gain
  return x
}

/** Layers placed at their start times (seconds) and summed, as mix.py's mix(). */
export function mix(parts) {
  let n = 0
  for (const { at, x } of parts) n = Math.max(n, frames(at) + x.length)
  const y = new Float64Array(n)
  for (const { at, x } of parts) {
    const o = frames(at)
    for (let i = 0; i < x.length; i++) y[o + i] += x[i]
  }
  return y
}

/**
 * One period of a seamless loop from a rendered mix `x`:
 * - without crossfade, everything after the period is folded back onto its start (overlap-add), which is exactly
 *   what endless repetition at that period sounds like, so the seam is continuous (tails ring into the next turn);
 * - with `crossfade` seconds, the start fades in and the material just after the period fades out over that time
 *   with an equal-power (sine/cosine) pair, then is folded back: for a continuous ambience there is no dip and no
 *   jump at the seam. `x` must then be at least period + crossfade long.
 */
export function loopPeriod(x, period, crossfade = 0) {
  const p = frames(period)
  const c = frames(crossfade)
  if (p < 1) throw new Error('loop period must be positive')
  let src = x
  if (c > 0) {
    if (x.length < p + c) throw new Error(`loop needs ${(p + c) / SR} s of material, has ${x.length / SR} s`)
    src = Float64Array.from(x.subarray(0, p + c))
    for (let i = 0; i < c; i++) {
      const t = (i + 0.5) / c
      src[i] *= Math.sin((t * Math.PI) / 2)
      src[p + i] *= Math.cos((t * Math.PI) / 2)
    }
  }
  const y = new Float64Array(p)
  for (let i = 0; i < src.length; i++) y[i % p] += src[i]
  return y
}

/** `times` copies of `x` back to back. */
export function repeat(x, times) {
  const y = new Float64Array(x.length * times)
  for (let k = 0; k < times; k++) y.set(x, k * x.length)
  return y
}

export const dbToGain = (db) => 10 ** (db / 20)

/**
 * Scale by `gain`, then hold the peaks under `ceilingDb` (dBFS) with a tanh soft clip, as mix.py's level().
 * Memoryless, so a loop stays a loop.
 */
export function levelAndClip(x, gain, ceilingDb) {
  const cap = dbToGain(ceilingDb)
  const y = new Float64Array(x.length)
  let peak = 0
  for (let i = 0; i < x.length; i++) {
    y[i] = x[i] * gain
    peak = Math.max(peak, Math.abs(y[i]))
  }
  if (peak > cap) for (let i = 0; i < y.length; i++) y[i] = cap * Math.tanh(y[i] / cap)
  return y
}

// ITU-R BS.1770 K-weighting at 48 kHz: high shelf, then the RLB high pass.
const K_STAGES = [
  { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
  { b: [1.0, -2.0, 1.0], a: [-1.99004745483398, 0.99007225036621] },
]

/** K-weighted copy of a mono signal at 48 kHz. */
export function kWeight(x) {
  let y = Float64Array.from(x)
  for (const { b, a } of K_STAGES) {
    const out = new Float64Array(y.length)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < y.length; i++) {
      const v = b[0] * y[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v
      out[i] = v
    }
    y = out
  }
  return y
}

/**
 * Loudness (LUFS, mono) of a whole sound: the K-weighted energy of everything in `x` (its filter tail included)
 * divided by `length` frames, default x.length. Used for cues shorter than the 400 ms momentary window, where a
 * window would average in silence. `length` lets a decoded MP3 (encoder delay and padding are silent) be measured
 * over the length the cue was rendered at.
 */
export function wholeLoudness(x, length = x.length) {
  const k = kWeight(x)
  let sum = 0
  for (const v of k) sum += v * v
  return -0.691 + 10 * Math.log10(sum / length + 1e-20)
}

/** Cues shorter than this many seconds are measured over their whole length instead of the loudest window. */
export const MOMENTARY_WINDOW_S = 0.4

/** How far a finished file may sit from its loudness target (LU), and the highest true peak allowed anywhere. */
export const LOUDNESS_TOLERANCE_LU = 1.5
export const MAX_TRUE_PEAK_DBTP = -1

/**
 * Problems with a build report's levels (empty = all good): a file more than LOUDNESS_TOLERANCE_LU off its loudness
 * target, or a true peak over its cap or over MAX_TRUE_PEAK_DBTP. `entries` maps a name to {lufsMax, truePeak, target}.
 */
export function levelProblems(entries) {
  const out = []
  for (const [name, e] of Object.entries(entries)) {
    if (!e || !Number.isFinite(e.lufsMax) || !Number.isFinite(e.truePeak) || !e.target) {
      out.push(`${name}: no measurement`)
      continue
    }
    const off = e.lufsMax - e.target.lufs
    if (Math.abs(off) > LOUDNESS_TOLERANCE_LU) {
      out.push(`${name}: ${e.lufsMax} LUFS is ${off > 0 ? '+' : ''}${Math.round(off * 10) / 10} LU off its target ${e.target.lufs}`)
    }
    const cap = Math.min(e.target.peak, MAX_TRUE_PEAK_DBTP)
    if (e.truePeak > cap) out.push(`${name}: true peak ${e.truePeak} dBTP over ${cap}`)
  }
  return out
}
