// Sound set v4 ("mecha"): which sample file plays for which event and which background loop, and what the build
// measured for each file. The files (web/public/sounds/sfx-*.mp3, loop-*.mp3) are mixed from "Free Cinematic Sound
// Effects" by Gregor Quendel (CC BY 4.0, modified) by scripts/sounds/build.mjs, which also writes
// sample-report.json. The app copies them flat next to index.js, so they load from "/<file>".
// Pure module (no Web Audio): the mapping and the levels are unit tested (samples.test.ts).

import type { AmbienceKind } from './ambience'
import type { SoundCue } from './cues'
import { RECIPES, recipeDuration } from './recipes'
import report from './sample-report.json'

/** Attribution of the sample pack (CC BY 4.0 asks for it): shown in the sound settings and in LICENSES.md. */
export const SOUND_CREDIT = {
  pack: 'Free Cinematic Sound Effects',
  author: 'Gregor Quendel',
  licence: 'CC BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  sourceUrl: 'https://opengameart.org/content/free-cinematic-sound-effects',
  /** shown as "dimodifikasi": our mixes trim, pitch, layer, level and loop the samples */
  modified: 'dimodifikasi',
} as const

/** Event -> file. Lowercase flat names: the static server only serves plain names from the webview folder. */
export const SAMPLE_FILES: Record<SoundCue, string> = {
  tool_start: 'sfx-tool_start.mp3',
  tool_complete: 'sfx-tool_complete.mp3',
  handoff: 'sfx-handoff.mp3',
  tool_error: 'sfx-tool_error.mp3',
  agent_spawn: 'sfx-agent_spawn.mp3',
  agent_complete: 'sfx-agent_complete.mp3',
  agent_offboarded: 'sfx-agent_offboarded.mp3',
  task_start: 'sfx-task_start.mp3',
  task_review: 'sfx-task_review.mp3',
  task_done: 'sfx-task_done.mp3',
  task_blocked: 'sfx-task_blocked.mp3',
  decision_answered: 'sfx-decision_answered.mp3',
  decision_open: 'sfx-decision_open.mp3',
  session_start: 'sfx-session_start.mp3',
  stage_done: 'sfx-stage_done.mp3',
}

/** Background loop -> file. Each file holds two loop periods (see loopWindow). */
export const LOOP_FILES: Record<AmbienceKind, string> = {
  owner: 'loop-owner.mp3',
  waiting: 'loop-waiting.mp3',
  thinking: 'loop-thinking.mp3',
  disintegrating: 'loop-disintegrating.mp3',
}

/** What the sample bank loads: the event sounds by cue name, the loops as "loop:<kind>". */
export type LoopKey = `loop:${AmbienceKind}`
export type SampleKey = SoundCue | LoopKey

export function loopKey(kind: AmbienceKind): LoopKey {
  return `loop:${kind}`
}

export interface SampleInfo {
  file: string
  bytes: number
  /** seconds (for a loop: both periods in the file) */
  duration: number
  /** loudness in LUFS: the loudest 400 ms window (EBU R128 momentary maximum), or the whole sound under 400 ms */
  lufsMax: number
  measuredOn: 'momentary' | 'whole'
  /** dBTP */
  truePeak: number
  target: { lufs: number; peak: number }
  sources: string[]
}

export interface LoopInfo extends SampleInfo {
  /** seconds of one seamless loop turn */
  period: number
  crossfade: number
}

export interface SampleReport {
  totalBytes: number
  cues: Record<SoundCue, SampleInfo>
  loops: Record<AmbienceKind, LoopInfo>
  sources: Record<string, string>
}

/** What scripts/sounds/build.mjs measured on the finished files. */
export const SAMPLE_REPORT = report as unknown as SampleReport

/** URL of a cue's file under the app's root (or another base). */
export function sampleUrl(cue: SoundCue, base = '/'): string {
  return base + SAMPLE_FILES[cue]
}

/** Every file the sample bank loads: the 15 event sounds and the 4 loops. */
export function sampleUrls(base = '/'): Record<SampleKey, string> {
  const out = {} as Record<SampleKey, string>
  for (const cue of Object.keys(SAMPLE_FILES) as SoundCue[]) out[cue] = sampleUrl(cue, base)
  for (const kind of Object.keys(LOOP_FILES) as AmbienceKind[]) out[loopKey(kind)] = base + LOOP_FILES[kind]
  return out
}

/**
 * The part of a loop file to loop over (seconds): exactly one period, from the middle of the first to the middle of
 * the second. The file is periodic, so any one-period window loops without a seam, and this one stays clear of the
 * MP3's encoder delay at the start and its padding at the end, whether or not the browser trims them.
 */
export function loopWindow(kind: AmbienceKind): { start: number; end: number } {
  const period = SAMPLE_REPORT.loops[kind].period
  return { start: period / 2, end: period * 1.5 }
}

/** How long a cue sounds, whichever version plays (the file, or the synthesised fallback). */
export function cueLength(cue: SoundCue): number {
  return Math.max(SAMPLE_REPORT.cues[cue].duration, recipeDuration(RECIPES[cue]))
}
