// The sound set, as data. Each cue is a list of voices; a voice is one oscillator with an optional filter and an
// attack/decay envelope. audio-engine.ts turns these into Web Audio nodes. No audio files, no network.
//
// To tweak a sound, change its numbers here: freq/to (Hz, `to` makes a glide), start/dur (seconds from the cue's
// start), peak (loudness before the master volume; keep it under about 0.06), attack (seconds to reach the peak),
// filter (lowpass softens, bandpass narrows; `to` sweeps the filter).

import type { SoundCue } from './cues'

export interface VoiceFilter {
  type: BiquadFilterType
  freq: number
  to?: number
  q?: number
}

export interface Voice {
  type: OscillatorType
  freq: number
  /** glide target (exponential) over the voice's duration */
  to?: number
  start: number
  dur: number
  peak: number
  attack?: number
  /** cents */
  detune?: number
  filter?: VoiceFilter
}

// C major notes used by the chimes
const C4 = 261.63, E4 = 329.63, G4 = 392, C5 = 523.25, G5 = 783.99, C6 = 1046.5, E6 = 1318.51, G6 = 1567.98

function pad(): Voice[] {
  const voices: Voice[] = []
  ;[C4, E4, G4, C5].forEach((f, i) => {
    for (const detune of [-7, 7]) {
      voices.push({
        type: 'sawtooth', freq: f, detune, start: i * 0.04, dur: 1.3, peak: 0.008, attack: 0.25,
        filter: { type: 'lowpass', freq: 500, to: 2400, q: 1.5 },
      })
    }
  })
  voices.push({ type: 'sine', freq: C6 * 2, start: 0.3, dur: 0.5, peak: 0.007, attack: 0.02 })
  return voices
}

export const RECIPES: Record<SoundCue, Voice[]> = {
  // graph
  tool_start: [
    { type: 'sine', freq: 1500, to: 1900, start: 0, dur: 0.05, peak: 0.018, attack: 0.004, filter: { type: 'bandpass', freq: 1700, q: 2 } },
  ],
  tool_complete: [
    { type: 'sine', freq: 2300, to: 2700, start: 0, dur: 0.04, peak: 0.012, attack: 0.003 },
  ],
  tool_error: [
    { type: 'sawtooth', freq: 120, to: 95, start: 0, dur: 0.24, peak: 0.035, attack: 0.01, filter: { type: 'lowpass', freq: 700, q: 1 } },
    { type: 'square', freq: 126, to: 100, start: 0, dur: 0.24, peak: 0.018, attack: 0.01, filter: { type: 'lowpass', freq: 600, q: 1 } },
  ],
  handoff: [1800, 2600, 2100, 3000].map((freq, i): Voice => ({
    type: 'square', freq, start: i * 0.04, dur: 0.03, peak: 0.01, attack: 0.002,
    filter: { type: 'bandpass', freq: 2400, q: 3 },
  })),
  agent_spawn: [
    { type: 'triangle', freq: 280, to: 1100, start: 0, dur: 0.3, peak: 0.035, attack: 0.03, filter: { type: 'lowpass', freq: 900, to: 4000, q: 4 } },
    { type: 'sine', freq: 560, to: 2200, start: 0.02, dur: 0.26, peak: 0.01, attack: 0.03 },
  ],
  agent_complete: [
    { type: 'sine', freq: G5, start: 0, dur: 0.24, peak: 0.028, attack: 0.008 },
    { type: 'sine', freq: C6, start: 0.1, dur: 0.28, peak: 0.03, attack: 0.008 },
    { type: 'sine', freq: C6 * 2, start: 0.1, dur: 0.18, peak: 0.005, attack: 0.008 },
  ],
  session_start: [
    { type: 'sawtooth', freq: 70, to: 560, start: 0, dur: 0.6, peak: 0.028, attack: 0.05, filter: { type: 'lowpass', freq: 200, to: 3200, q: 8 } },
    { type: 'sine', freq: 140, to: 1120, start: 0, dur: 0.6, peak: 0.018, attack: 0.05 },
    { type: 'sine', freq: 1680, start: 0.5, dur: 0.25, peak: 0.014, attack: 0.01 },
  ],

  // team panel
  decision_open: [880, 1320, 880, 1320].map((freq, i): Voice => ({
    type: 'triangle', freq, start: i * 0.12, dur: 0.1, peak: 0.06, attack: 0.005,
  })),
  decision_answered: [
    { type: 'sine', freq: 660, to: 990, start: 0, dur: 0.14, peak: 0.035, attack: 0.006 },
    { type: 'sine', freq: 1320, start: 0.12, dur: 0.22, peak: 0.03, attack: 0.006 },
  ],
  task_start: [
    { type: 'triangle', freq: 520, to: 880, start: 0, dur: 0.13, peak: 0.028, attack: 0.01, filter: { type: 'lowpass', freq: 2500 } },
  ],
  task_review: [
    { type: 'triangle', freq: 1100, to: 800, start: 0, dur: 0.1, peak: 0.025, attack: 0.008 },
    { type: 'triangle', freq: 800, to: 1200, start: 0.1, dur: 0.12, peak: 0.025, attack: 0.008 },
  ],
  task_done: [C6, E6, G6].map((freq, i): Voice => ({
    type: 'sine', freq, start: i * 0.06, dur: 0.26, peak: 0.025, attack: 0.006,
  })),
  task_blocked: [
    { type: 'square', freq: 392, start: 0, dur: 0.14, peak: 0.022, attack: 0.006, filter: { type: 'lowpass', freq: 1400 } },
    { type: 'square', freq: 294, start: 0.15, dur: 0.22, peak: 0.024, attack: 0.006, filter: { type: 'lowpass', freq: 1200 } },
  ],
  stage_done: pad(),
}

/** Length of a cue in seconds (end of its last voice). */
export function recipeDuration(voices: readonly Voice[]): number {
  return voices.reduce((m, v) => Math.max(m, v.start + v.dur), 0)
}

/** Loudest single voice of a cue. */
export function recipePeak(voices: readonly Voice[]): number {
  return voices.reduce((m, v) => Math.max(m, v.peak), 0)
}
