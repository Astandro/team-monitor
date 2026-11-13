// Sound set v3 (owner decision D45): every event sound is built from CC0 samples by build.mjs.
// This file is the recipe list. Sources are named "<pack>/<file>", packs are listed in PACKS (licences in
// web/public/sounds/LICENSES.md). Times are seconds, gains dB, pan -1 (left) .. 1 (right).
//
// A layer: { src, at | endAt, from, to, rate, reverse, gain, filters, pan, panTo, fadeIn, fadeOut }
//   at       where the layer starts in the output; endAt instead places the layer so it ends there
//   from/to  trim of the source before anything else
//   rate     pitch and speed together (0.5 = an octave down and twice as long)
//   filters  plain ffmpeg audio filters (EQ etc.), applied after the pitch change
// A cue: { cue, file, dur, space, target, layers }
//   space    reverb: { mix (wet level), seconds (tail), predelay }
//   target   level: { lufs (loudest 400 ms window, LUFS), peak (true-peak cap, dBTP) }

/** Licensed packs this set may use; build.mjs refuses any other source and checks each pack's licence file. */
export const PACKS = {
  scifi: {
    name: 'Sci-Fi Sounds (1.0) by Kenney',
    licenceFile: 'License.txt',
    audioDir: 'Audio',
  },
  interface: {
    name: 'Interface Sounds (1.0) by Kenney',
    licenceFile: 'License.txt',
    audioDir: 'Audio',
  },
}

export const SAMPLE_RATE = 48000
export const BITRATE = '128k'

/** Rare events are big and wide; frequent ones quiet, short and nearly dry. */
export const RECIPES = [
  {
    cue: 'tool_start',
    file: 'sfx-tool_start.mp3',
    dur: 0.16,
    space: { mix: 0.05, seconds: 0.6, predelay: 0.01 },
    target: { lufs: -38, peak: -24 },
    layers: [
      { src: 'interface/tick_002.ogg', at: 0, rate: 0.8, filters: ['highpass=f=500', 'lowpass=f=6500'], pan: -0.15 },
    ],
  },
  {
    cue: 'tool_complete',
    file: 'sfx-tool_complete.mp3',
    dur: 0.18,
    space: { mix: 0.05, seconds: 0.6, predelay: 0.01 },
    target: { lufs: -38, peak: -24 },
    layers: [
      { src: 'interface/select_002.ogg', at: 0, rate: 1.12, filters: ['highpass=f=600', 'lowpass=f=7000'], pan: 0.15 },
    ],
  },
  {
    cue: 'handoff',
    file: 'sfx-handoff.mp3',
    dur: 0.4,
    space: { mix: 0.08, seconds: 0.9, predelay: 0.015 },
    target: { lufs: -33, peak: -20 },
    layers: [
      {
        src: 'scifi/computerNoise_002.ogg', at: 0, from: 0.5, to: 0.78, rate: 1.1,
        filters: ['bandpass=f=2400:w=1800', 'highpass=f=300'], fadeIn: 0.02, fadeOut: 0.1, pan: -0.5, panTo: 0.5,
      },
      { src: 'interface/glitch_002.ogg', at: 0.02, rate: 0.9, gain: -4, filters: ['lowpass=f=6000'] },
    ],
  },
  {
    cue: 'tool_error',
    file: 'sfx-tool_error.mp3',
    dur: 1.05,
    space: { mix: 0.3, seconds: 1.4, predelay: 0.02 },
    target: { lufs: -24, peak: -10 },
    layers: [
      { src: 'interface/error_005.ogg', at: 0, rate: 0.7, filters: ['lowpass=f=5000'] },
      { src: 'scifi/impactMetal_002.ogg', at: 0, rate: 0.75, gain: -2 },
      { src: 'scifi/laserSmall_002.ogg', at: 0.06, rate: 0.5, gain: -3, filters: ['lowpass=f=1500'] },
    ],
  },
  {
    cue: 'agent_spawn',
    file: 'sfx-agent_spawn.mp3',
    dur: 1.25,
    space: { mix: 0.35, seconds: 1.6, predelay: 0.02 },
    target: { lufs: -27, peak: -12 },
    layers: [
      { src: 'scifi/forceField_000.ogg', at: 0, fadeIn: 0.06, fadeOut: 0.3, pan: -0.5, panTo: 0.3 },
      { src: 'interface/maximize_003.ogg', at: 0.1, rate: 0.8, gain: -3, filters: ['lowpass=f=6000'] },
    ],
  },
  {
    cue: 'agent_complete',
    file: 'sfx-agent_complete.mp3',
    dur: 1.6,
    space: { mix: 0.45, seconds: 2, predelay: 0.025 },
    target: { lufs: -27, peak: -12 },
    layers: [
      { src: 'interface/confirmation_002.ogg', at: 0, rate: 0.8 },
      { src: 'interface/glass_003.ogg', at: 0.05, rate: 0.5, gain: -2, pan: -0.35 },
      { src: 'interface/glass_003.ogg', at: 0.12, rate: 1, gain: -8, pan: 0.45 },
    ],
  },
  {
    cue: 'agent_offboarded',
    file: 'sfx-agent_offboarded.mp3',
    dur: 2,
    space: { mix: 0.5, seconds: 2.2, predelay: 0.03 },
    target: { lufs: -27, peak: -12 },
    layers: [
      {
        src: 'scifi/thrusterFire_002.ogg', at: 0, from: 0.5, to: 1.8, rate: 0.8,
        filters: ['lowpass=f=3200', 'highpass=f=250'], fadeIn: 0.3, fadeOut: 0.8, pan: 0.7, panTo: -0.7,
      },
      { src: 'interface/minimize_004.ogg', at: 0.2, rate: 0.55, gain: -4, pan: 0.2, panTo: -0.4 },
    ],
  },
  {
    cue: 'task_start',
    file: 'sfx-task_start.mp3',
    dur: 1.05,
    space: { mix: 0.3, seconds: 1.4, predelay: 0.02 },
    target: { lufs: -25, peak: -10 },
    layers: [
      { src: 'scifi/spaceEngineLow_001.ogg', at: 0, from: 0, to: 0.9, fadeIn: 0.15, fadeOut: 0.4, gain: -3 },
      { src: 'scifi/doorOpen_001.ogg', at: 0, rate: 0.6, gain: -4, filters: ['lowpass=f=7000'] },
      { src: 'interface/open_002.ogg', at: 0.05, rate: 0.7, gain: -6 },
    ],
  },
  {
    cue: 'task_review',
    file: 'sfx-task_review.mp3',
    dur: 1.6,
    space: { mix: 0.4, seconds: 1.8, predelay: 0.02 },
    target: { lufs: -26, peak: -10 },
    layers: [
      { src: 'scifi/laserLarge_001.ogg', at: 0, rate: 0.55, filters: ['lowpass=f=4000'], pan: -0.6, panTo: 0.6 },
      { src: 'interface/scroll_003.ogg', at: 0.1, rate: 0.8, gain: -8, pan: -0.3, panTo: 0.3 },
    ],
  },
  {
    cue: 'task_done',
    file: 'sfx-task_done.mp3',
    dur: 1.8,
    space: { mix: 0.5, seconds: 2.2, predelay: 0.025 },
    target: { lufs: -24, peak: -8 },
    layers: [
      { src: 'interface/confirmation_003.ogg', at: 0 },
      { src: 'interface/glass_004.ogg', at: 0.1, rate: 0.75, gain: -2, pan: -0.3 },
      { src: 'interface/glass_004.ogg', at: 0.18, rate: 1.5, gain: -8, pan: 0.45 },
    ],
  },
  {
    cue: 'task_blocked',
    file: 'sfx-task_blocked.mp3',
    dur: 1.25,
    space: { mix: 0.3, seconds: 1.5, predelay: 0.02 },
    target: { lufs: -20, peak: -6 },
    layers: [
      { src: 'interface/error_006.ogg', at: 0, rate: 0.55, filters: ['lowpass=f=4000'] },
      { src: 'scifi/impactMetal_001.ogg', at: 0, rate: 0.8 },
      { src: 'scifi/forceField_004.ogg', at: 0, from: 0, to: 0.5, rate: 0.6, gain: -4, filters: ['lowpass=f=800'], fadeOut: 0.3 },
    ],
  },
  {
    cue: 'decision_answered',
    file: 'sfx-decision_answered.mp3',
    dur: 1.8,
    space: { mix: 0.45, seconds: 2.2, predelay: 0.025 },
    target: { lufs: -21, peak: -6 },
    layers: [
      { src: 'scifi/laserLarge_002.ogg', at: 0, rate: 0.7, filters: ['lowpass=f=5000'], pan: 0.4, panTo: -0.2 },
      { src: 'interface/confirmation_004.ogg', at: 0.15, rate: 0.9 },
      { src: 'interface/glass_006.ogg', at: 0.2, rate: 0.6, gain: -3, pan: 0.3 },
    ],
  },
  {
    cue: 'decision_open',
    file: 'sfx-decision_open.mp3',
    dur: 2.6,
    space: { mix: 0.4, seconds: 2.2, predelay: 0.02 },
    target: { lufs: -16, peak: -3 },
    layers: [
      { src: 'interface/question_002.ogg', at: 0, rate: 0.6, pan: -0.3 },
      { src: 'interface/question_002.ogg', at: 0.55, rate: 0.6, pan: 0.3 },
      { src: 'interface/question_002.ogg', at: 1.1, rate: 0.6 },
      { src: 'scifi/forceField_003.ogg', at: 0, rate: 0.5, gain: -2, filters: ['lowpass=f=400'], fadeOut: 0.5 },
      { src: 'scifi/lowFrequency_explosion_001.ogg', at: 0, gain: -10 },
    ],
  },
  {
    cue: 'session_start',
    file: 'sfx-session_start.mp3',
    dur: 3.8,
    space: { mix: 0.5, seconds: 3, predelay: 0.03 },
    target: { lufs: -14, peak: -1.5 },
    layers: [
      {
        src: 'scifi/spaceEngineLarge_002.ogg', at: 0, from: 0, to: 2.4, rate: 0.7,
        filters: ['lowpass=f=5000'], fadeIn: 1.2, fadeOut: 1.2, gain: -4,
      },
      {
        src: 'scifi/thrusterFire_003.ogg', at: 0, from: 0, to: 2.8, rate: 0.9,
        fadeIn: 1.5, fadeOut: 1.1, pan: -0.6, panTo: 0.6, gain: -2,
      },
      { src: 'scifi/forceField_002.ogg', at: 0, rate: 0.5, gain: -6, filters: ['lowpass=f=900'] },
      { src: 'scifi/laserLarge_000.ogg', at: 1.3, rate: 0.35, gain: -3, filters: ['lowpass=f=3000'] },
      { src: 'scifi/lowFrequency_explosion_000.ogg', at: 1.45 },
    ],
  },
  {
    cue: 'stage_done',
    file: 'sfx-stage_done.mp3',
    dur: 4.5,
    space: { mix: 0.55, seconds: 3.2, predelay: 0.03 },
    target: { lufs: -13, peak: -1.5 },
    layers: [
      // riser: a force field played backwards, an octave-ish down, ending on the impact
      { src: 'scifi/forceField_001.ogg', endAt: 1.5, rate: 0.65, reverse: true, gain: -3, pan: -0.4, panTo: 0.2 },
      { src: 'scifi/spaceEngineLow_002.ogg', at: 0, from: 0, to: 1.5, fadeIn: 1.4, fadeOut: 0.05, gain: -8 },
      // impact
      { src: 'scifi/lowFrequency_explosion_000.ogg', at: 1.5 },
      { src: 'scifi/explosionCrunch_003.ogg', at: 1.5, rate: 0.6, gain: -5, filters: ['lowpass=f=3000'] },
      { src: 'scifi/impactMetal_003.ogg', at: 1.5, rate: 0.5, gain: -2 },
      // shimmer after the hit
      { src: 'interface/glass_005.ogg', at: 1.55, rate: 0.5, gain: -4, pan: -0.5 },
      { src: 'interface/glass_005.ogg', at: 1.6, rate: 1, gain: -9, pan: 0.5 },
    ],
  },
]
