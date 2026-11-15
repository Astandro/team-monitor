// The sound set (v2, space-opera style), as data. Each cue is a list of voices; a voice is one sound source
// (an oscillator or white noise) with optional FM, ring modulation, stepped pitch, filter, drive (distortion),
// stereo movement and a send to the shared space reverb. synth.ts turns these into Web Audio nodes. All original
// synthesis: no audio files, no samples, no network.
//
// To tweak a sound, change its numbers here: freq/to (Hz, `to` makes a glide), start/dur (seconds from the cue's
// start), peak (loudness before the master volume, see the caps in cues.test.ts), attack (seconds to reach the
// peak), release (seconds of fade at the end; without it the voice fades from the peak to the end), filter
// (lowpass softens, bandpass narrows, highpass thins; `to` sweeps it), space (share sent to the reverb).

import type { SoundCue } from './cues'

export interface VoiceFilter {
  type: BiquadFilterType
  freq: number
  to?: number
  q?: number
}

export interface Voice {
  /** source: an oscillator wave, or white noise (then freq/to/steps/fm/detune are ignored; shape it with a filter) */
  type: OscillatorType | 'noise'
  freq: number
  /** glide target (exponential) over the voice's duration */
  to?: number
  /** stepped pitch (robotic): these frequencies in turn, equal shares of the duration, with a 6 ms glide between */
  steps?: number[]
  start: number
  dur: number
  peak: number
  attack?: number
  /** fade-out length at the end; the voice holds its peak until then. Without it: fade from the peak to the end. */
  release?: number
  /** cents */
  detune?: number
  /** FM: a sine at freq * ratio moves the pitch by index * freq Hz; inharmonic ratios sound metallic */
  fm?: { ratio: number; index: number; indexTo?: number }
  /** ring modulation: the voice is multiplied by a sine at this frequency (robotic, metallic) */
  ring?: number
  /** distortion 0..1 (soft clipping before the envelope) */
  drive?: number
  filter?: VoiceFilter
  /** stereo position -1..1, `panTo` moves it over the voice */
  pan?: number
  panTo?: number
  /** share sent to the space reverb, 0..1 */
  space?: number
}

// ─── building blocks ─────────────────────────────────────────────────────────

/** Partials of a struck metal bar (free-free beam ratios), loudness and decay of each relative to the first. */
const METAL_PARTIALS: readonly { ratio: number; amp: number; decay: number }[] = [
  { ratio: 1, amp: 1, decay: 1 },
  { ratio: 2.756, amp: 0.55, decay: 0.7 },
  { ratio: 5.404, amp: 0.3, decay: 0.45 },
  { ratio: 8.933, amp: 0.15, decay: 0.3 },
]

/** Ringing metal: inharmonic sine partials with long decays, a short FM strike on top. */
function metal(freq: number, start: number, dur: number, peak: number, space = 0.3, pan?: number): Voice[] {
  const voices: Voice[] = METAL_PARTIALS.map((p, i) => ({
    type: 'sine' as const, freq: freq * p.ratio, start, dur: dur * p.decay, peak: peak * p.amp, attack: 0.002,
    // a few cents off on the second partial makes it beat like a real plate
    detune: i === 1 ? 6 : undefined, space, pan,
  }))
  voices.push({
    type: 'sine', freq, start, dur: Math.min(0.12, dur / 3), peak: peak * 0.5, attack: 0.001,
    fm: { ratio: 1.414, index: 3, indexTo: 0.2 }, space, pan,
  })
  return voices
}

/** Filtered noise sweep: meteor whoosh, rocket thrust. Swells to its peak, then a short fade. */
function whoosh(
  start: number, dur: number, from: number, to: number, peak: number,
  opts: { q?: number; attack?: number; release?: number; pan?: number; panTo?: number; space?: number } = {},
): Voice {
  return {
    type: 'noise', freq: 0, start, dur, peak, attack: opts.attack ?? dur * 0.7, release: opts.release,
    filter: { type: 'bandpass', freq: from, to, q: opts.q ?? 1.2 },
    pan: opts.pan, panTo: opts.panTo, space: opts.space,
  }
}

/** Sub-bass: impact drop or engine swell. */
function sub(start: number, dur: number, from: number, to: number, peak: number, attack = 0.005, release?: number): Voice {
  return { type: 'sine', freq: from, to, start, dur, peak, attack, release }
}

/** Robotic chatter: square wave stepping through pitches, ring modulated, through a bandpass. */
function chatter(steps: number[], start: number, dur: number, peak: number, ring: number, band: number): Voice {
  return {
    type: 'square', freq: steps[0], steps, start, dur, peak, attack: 0.003, release: 0.02, ring,
    filter: { type: 'bandpass', freq: band, q: 1.8 },
  }
}

/** Energy zap: fast pitch drop with distortion. */
function zap(start: number, dur: number, from: number, to: number, peak: number, space = 0.15): Voice {
  return {
    type: 'sawtooth', freq: from, to, start, dur, peak, attack: 0.002, drive: 0.6,
    filter: { type: 'lowpass', freq: 4200, to: 900, q: 2 }, space,
  }
}

// ─── the bigger sounds ───────────────────────────────────────────────────────

/** Klaxon: three soft-edged pulses of two detuned tones bending up a little, lowpassed so it is not harsh. */
function klaxon(): Voice[] {
  const voices: Voice[] = []
  for (let i = 0; i < 3; i++) {
    const s = i * 0.36
    for (const [f, detune] of [[415, -8], [415, 8], [554, 0]] as const) {
      voices.push({
        type: 'sawtooth', freq: f * 0.94, to: f, start: s, dur: 0.28, peak: f > 500 ? 0.07 : 0.08, attack: 0.025,
        release: 0.08, detune, filter: { type: 'lowpass', freq: 1500, q: 0.9 }, space: 0.2,
      })
    }
    voices.push(sub(s, 0.22, 104, 98, 0.12, 0.02, 0.1))
  }
  return voices
}

/** Rocket ignition (crackling burst), then thrust and engine swelling up, about 2 s. */
function rocket(): Voice[] {
  return [
    // ignition crack
    { type: 'noise', freq: 0, start: 0, dur: 0.35, peak: 0.22, attack: 0.004, drive: 0.7, filter: { type: 'lowpass', freq: 2400, to: 500, q: 0.7 }, space: 0.3 },
    // thrust: noise opening up
    whoosh(0.05, 1.95, 220, 2600, 0.3, { q: 0.7, attack: 1.4, release: 0.4, space: 0.25 }),
    // engine body: low saw rising, slightly distorted
    { type: 'sawtooth', freq: 42, to: 118, start: 0.05, dur: 1.95, peak: 0.07, attack: 1.2, release: 0.4, drive: 0.5, filter: { type: 'lowpass', freq: 180, to: 1100, q: 1.2 } },
    sub(0, 1.95, 36, 72, 0.16, 1.0, 0.4),
    // turbine whine climbing on top
    { type: 'triangle', freq: 260, to: 1040, start: 0.3, dur: 1.65, peak: 0.018, attack: 1.2, release: 0.35, space: 0.3 },
  ]
}

/** Epic swell: low fifths open up while a meteor whooshes across, then an impact with a long reverb tail. */
function stageDone(): Voice[] {
  const hit = 1.15
  const swell: Voice[] = [55, 82.5, 110, 165].flatMap((f) => [-9, 9].map((detune): Voice => ({
    type: 'sawtooth', freq: f, start: 0, dur: 2.4, peak: 0.022, attack: 1.1, release: 1.1, detune,
    filter: { type: 'lowpass', freq: 160, to: 2000, q: 1.4 }, space: 0.45,
  })))
  return [
    ...swell,
    whoosh(0, hit, 500, 5200, 0.22, { q: 1.6, attack: 1.0, pan: -0.8, panTo: 0.5, space: 0.35 }),
    // impact
    sub(hit, 1.2, 72, 30, 0.26, 0.004),
    { type: 'noise', freq: 0, start: hit, dur: 0.7, peak: 0.2, attack: 0.003, drive: 0.6, filter: { type: 'lowpass', freq: 1800, to: 180, q: 0.8 }, space: 0.6 },
    ...metal(98, hit, 1.25, 0.08, 0.6),
    // shimmer in the tail
    ...metal(1568, hit + 0.08, 1.1, 0.018, 0.7, 0.4),
  ]
}

// ─── the sound set ───────────────────────────────────────────────────────────

export const RECIPES: Record<SoundCue, Voice[]> = {
  // graph: frequent, so quiet and short
  // Owner request 15 Nov 2026: running a command sounds like a small meteor streaking past, its result like the
  // meteor touching down. Frequent, so both stay quiet, short and dry (no reverb).
  tool_start: [
    // meteor streak: a narrow noise band falling from high to low, crossing left to right
    whoosh(0, 0.26, 5200, 1300, 0.024, { q: 2.6, attack: 0.16, release: 0.09, pan: -0.45, panTo: 0.45 }),
    // its faint burning whistle
    { type: 'sine', freq: 2300, to: 900, start: 0.02, dur: 0.22, peak: 0.006, attack: 0.12, release: 0.08, pan: -0.3, panTo: 0.3 },
  ],
  tool_complete: [
    // touchdown: a soft thud (high enough for phone speakers) and a short crumble
    sub(0, 0.22, 170, 60, 0.022, 0.004, 0.15),
    { type: 'noise', freq: 0, start: 0, dur: 0.09, peak: 0.012, attack: 0.002, filter: { type: 'lowpass', freq: 1200, to: 400, q: 0.7 } },
  ],
  tool_error: [
    // low metallic clank
    ...metal(118, 0, 0.5, 0.08, 0.2),
    { type: 'noise', freq: 0, start: 0, dur: 0.07, peak: 0.08, attack: 0.001, filter: { type: 'lowpass', freq: 1400, q: 0.8 } },
    // short distorted buzz
    { type: 'sawtooth', freq: 82, steps: [82, 78], start: 0.06, dur: 0.24, peak: 0.05, attack: 0.01, release: 0.06, drive: 0.85, filter: { type: 'lowpass', freq: 1300, q: 1 } },
  ],
  handoff: [
    // data burst: stepped square glides
    chatter([1400, 2100, 1650, 2600, 1900, 3000], 0, 0.17, 0.022, 95, 2200),
  ],
  agent_spawn: [
    // boot-up chirp climbing in steps, then a short servo
    chatter([330, 495, 660, 990], 0, 0.2, 0.03, 55, 1400),
    { type: 'sawtooth', freq: 140, to: 270, start: 0.17, dur: 0.26, peak: 0.035, attack: 0.03, release: 0.07, ring: 37, filter: { type: 'lowpass', freq: 900, q: 2 } },
  ],
  agent_complete: [
    // metallic two-tone ring with a soft tail
    ...metal(784, 0, 0.9, 0.035, 0.3, -0.2),
    ...metal(1046.5, 0.13, 1.1, 0.032, 0.35, 0.2),
  ],
  session_start: rocket(),

  // team panel
  decision_open: klaxon(),
  decision_answered: [
    zap(0, 0.13, 1900, 240, 0.05),
    ...metal(1318.5, 0.1, 0.95, 0.06, 0.35),
  ],
  task_start: [
    // engine rev
    { type: 'sawtooth', freq: 62, to: 165, start: 0, dur: 0.45, peak: 0.06, attack: 0.14, release: 0.16, drive: 0.4, filter: { type: 'lowpass', freq: 260, to: 1500, q: 1.5 } },
    whoosh(0, 0.45, 400, 1600, 0.06, { q: 1, attack: 0.25, release: 0.15 }),
  ],
  task_review: [
    // scanner sweep across the stereo field
    { type: 'triangle', freq: 520, to: 1900, start: 0, dur: 0.6, peak: 0.09, attack: 0.08, release: 0.15, ring: 62, filter: { type: 'bandpass', freq: 700, to: 2600, q: 2 }, pan: -0.7, panTo: 0.7, space: 0.25 },
  ],
  task_done: [
    // bright metallic chime
    ...metal(1760, 0, 1.0, 0.05, 0.35, -0.15),
    ...metal(2637, 0.08, 0.9, 0.035, 0.4, 0.15),
  ],
  task_blocked: [
    // warning pulse: two low bent pulses with a sub underneath
    ...[0, 0.22].flatMap((s): Voice[] => [
      { type: 'square', freq: 250, to: 220, start: s, dur: 0.17, peak: 0.045, attack: 0.01, release: 0.06, ring: 31, filter: { type: 'lowpass', freq: 900, q: 1.2 } },
      sub(s, 0.17, 110, 98, 0.07, 0.01, 0.06),
    ]),
  ],
  stage_done: stageDone(),
  agent_offboarded: [
    // a distant meteor burning up: a quiet falling hiss far away, crackle, lots of space
    whoosh(0, 1.5, 3200, 650, 0.1, { q: 2.5, attack: 0.35, pan: 0.6, panTo: -0.6, space: 0.65 }),
    { type: 'noise', freq: 0, start: 0.25, dur: 0.9, peak: 0.025, attack: 0.2, ring: 23, filter: { type: 'highpass', freq: 2500, q: 0.7 }, pan: 0.3, panTo: -0.4, space: 0.6 },
    { type: 'sine', freq: 1300, to: 260, start: 0.05, dur: 1.3, peak: 0.01, attack: 0.3, space: 0.6 },
  ],
}

/** Length of a cue in seconds (end of its last voice; the reverb tail rings on after this). */
export function recipeDuration(voices: readonly Voice[]): number {
  return voices.reduce((m, v) => Math.max(m, v.start + v.dur), 0)
}

/** Loudest single voice of a cue. */
export function recipePeak(voices: readonly Voice[]): number {
  return voices.reduce((m, v) => Math.max(m, v.peak), 0)
}

/**
 * Upper bound of a cue's loudness before the master bus: the largest sum of peaks of the voices sounding at the
 * moment any voice reaches its peak.
 */
export function recipeLevel(voices: readonly Voice[]): number {
  let max = 0
  for (const v of voices) {
    const t = v.start + Math.min(v.attack ?? 0.005, v.dur / 2)
    let sum = 0
    for (const w of voices) if (w.start <= t && t < w.start + w.dur) sum += w.peak
    max = Math.max(max, sum)
  }
  return max
}

/** Soft-clipping curve for `drive` (0 = almost clean, 1 = heavy): tanh(k x) normalised to reach +-1. */
export function driveCurve(amount: number, size = 1024): Float32Array {
  const k = 1 + Math.max(0, Math.min(1, amount)) * 24
  const norm = Math.tanh(k)
  const curve = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / norm
  }
  return curve
}

/** Times (seconds from the voice start) and pitches of a stepped voice. */
export function stepTimes(v: Pick<Voice, 'steps' | 'dur'>): { at: number; freq: number }[] {
  const steps = v.steps ?? []
  const each = v.dur / Math.max(1, steps.length)
  return steps.map((freq, i) => ({ at: i * each, freq }))
}
