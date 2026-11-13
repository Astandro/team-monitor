// "Coba suara": every sound in turn with its name, so the owner can listen to the whole set from the sound popover.
// Pure (names and timing); sound-client.ts plays it.

import type { SoundCue } from './cues'
import { RECIPES, recipeDuration } from './recipes'

/** Plain names for each sound, as the owner reads them in the popover. */
export const CUE_NAMES: Record<SoundCue, string> = {
  session_start: 'Sesi baru dimulai',
  agent_spawn: 'Agent baru muncul',
  agent_complete: 'Agent selesai',
  tool_start: 'Mulai pakai alat',
  tool_complete: 'Selesai pakai alat',
  tool_error: 'Alat gagal',
  handoff: 'Kirim pesan antar-agent',
  agent_offboarded: 'Agent keluar dari tim',
  decision_open: 'Keputusan menunggu kamu',
  decision_answered: 'Keputusan dijawab',
  task_start: 'Tugas mulai',
  task_review: 'Tugas masuk review',
  task_done: 'Tugas selesai',
  task_blocked: 'Tugas terhambat',
  stage_done: 'Tahap selesai',
}

/** Demo order: the quiet frequent ones first, the big rare ones last. */
export const DEMO_ORDER: readonly SoundCue[] = [
  'tool_start',
  'tool_complete',
  'handoff',
  'tool_error',
  'agent_spawn',
  'agent_complete',
  'task_start',
  'task_review',
  'task_done',
  'task_blocked',
  'decision_answered',
  'agent_offboarded',
  'decision_open',
  'session_start',
  'stage_done',
]

/** Silence after each sound (its reverb still rings in it), in seconds. */
export const DEMO_GAP = 1.2

export interface DemoStep {
  cue: SoundCue
  name: string
  /** seconds from the start of the demo */
  at: number
}

/** When each sound of the demo starts, and when the demo is over (seconds). */
export function demoSteps(gap: number = DEMO_GAP): { steps: DemoStep[]; total: number } {
  let at = 0
  const steps = DEMO_ORDER.map((cue) => {
    const step = { cue, name: CUE_NAMES[cue], at }
    at += recipeDuration(RECIPES[cue]) + gap
    return step
  })
  return { steps, total: at }
}

/** What the popover shows while the demo runs. */
export function demoLabel(step: DemoStep, index: number, count: number): string {
  return `${step.name} (${index + 1} dari ${count})`
}
