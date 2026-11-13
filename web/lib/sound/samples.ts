// Sound set v3: which sample file plays for which event, and what the build measured for each file.
// The files (web/public/sounds/sfx-*.mp3) are built from CC0 packs by scripts/sounds/build.mjs, which also writes
// sample-report.json. The app copies them flat next to index.js, so they load from "/<file>".
// Pure module (no Web Audio): the mapping and the levels are unit tested (samples.test.ts).

import type { SoundCue } from './cues'
import { RECIPES, recipeDuration } from './recipes'
import report from './sample-report.json'

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

export interface SampleInfo {
  file: string
  bytes: number
  /** seconds */
  duration: number
  /** loudest 400 ms window, LUFS (EBU R128 momentary maximum) */
  lufsMax: number
  /** dBTP */
  truePeak: number
  target: { lufs: number; peak: number }
  sources: string[]
}

export interface SampleReport {
  totalBytes: number
  cues: Record<SoundCue, SampleInfo>
  sources: Record<string, string>
}

/** What scripts/sounds/build.mjs measured on the finished files. */
export const SAMPLE_REPORT = report as unknown as SampleReport

/** URL of a cue's file under the app's root (or another base). */
export function sampleUrl(cue: SoundCue, base = '/'): string {
  return base + SAMPLE_FILES[cue]
}

export function sampleUrls(base = '/'): Record<SoundCue, string> {
  const out = {} as Record<SoundCue, string>
  for (const cue of Object.keys(SAMPLE_FILES) as SoundCue[]) out[cue] = sampleUrl(cue, base)
  return out
}

/** How long a cue sounds, whichever version plays (the file, or the synthesised fallback). */
export function cueLength(cue: SoundCue): number {
  return Math.max(SAMPLE_REPORT.cues[cue].duration, recipeDuration(RECIPES[cue]))
}
