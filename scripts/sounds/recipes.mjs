// Sound set v4, "mecha" (owner approval 16 Nov 2026): every event sound and every background loop is mixed by
// build.mjs from the "Free Cinematic Sound Effects" pack by Gregor Quendel (CC BY 4.0, see
// web/public/sounds/LICENSES.md). The recipes are a port of the reference mixer the owner listened to
// (handover mix.py): same source segments, pitch ratios, offsets and layer gains.
//
// A layer: { src, at, from, to, rate, gain, fadeIn, fadeOut }
//   src      "<pack>/<file>" under scripts/sounds/sources/
//   at       where the layer starts in the output (s)
//   from/to  trim of the source (s); no `to` = to the end of the file
//   rate     pitch and speed together (0.75 = lower and longer)
//   gain     linear, applied after the layer is peak-normalised (mix.py's g)
//   fadeIn   linear fade in (s, default 0.005); fadeOut: squared fade out (s, default 0.08)
// A cue:  { cue, file, target, layers }
// A loop: { loop, file, target, layers, period, crossfade }: one seamless period (dsp.mjs loopPeriod); the file
//         holds two periods so the app can loop a window that never touches the MP3's encoder delay or padding.
// target: { lufs, peak }: loudness (EBU R128 momentary maximum, or the whole length for cues under 400 ms) and the
//         true-peak cap (dBTP). The build calibrates each sound's overall gain to its target.

export const PACKS = {
  'gregor-quendel': {
    name: 'Free Cinematic Sound Effects by Gregor Quendel',
    licenceFile: 'LICENSE.txt',
    licence: 'CC BY 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  },
}

export const SAMPLE_RATE = 48000
export const BITRATE = '96k'

const GQ = 'gregor-quendel/'
const MECHANISMS = `${GQ}Mecha_Sequences_Mechanisms_01.mp3`
const IMPACT = `${GQ}Mecha_Elements_Impact_01.mp3`
const MECHANISM = `${GQ}Mecha_Elements_Mechanism_01.mp3`

/** mix.py's imp(): the mecha impact, whole (or cut at `to`), with a 0.3 s fade out. */
const impact = (at, rate = 1, gain = 1, to) => ({ src: IMPACT, at, rate, gain, ...(to === undefined ? {} : { to }), fadeOut: 0.3 })
const layer = (src, at, from, to, opts = {}) => ({ src: src.includes('/') ? src : GQ + src, at, from, ...(to === undefined ? {} : { to }), ...opts })

// Peak caps follow mix.py: alerts -1.5, milestones -3, the rest -5 (dBTP).
const ALERT = { lufs: -14, peak: -1.5 }
const MILESTONE = { lufs: -18, peak: -3 }
const FREQUENT = { lufs: -20, peak: -5 }

export const RECIPES = [
  // alerts
  {
    cue: 'decision_open',
    target: ALERT,
    layers: [
      impact(0, 0.75),
      impact(0.45, 0.75),
      layer('Circuits_Ambience_Burst_01.mp3', 0, 0, 2.4, { gain: 0.6, fadeOut: 0.8 }),
      layer(MECHANISMS, 0.9, 21.3, 22.7, { gain: 0.5 }),
    ],
  },
  {
    cue: 'task_blocked',
    target: ALERT,
    layers: [layer('Sci-Fi_Circuits_Error_RobotSpeech.mp3', 0, 0, 1.8, { gain: 0.8, fadeOut: 0.3 }), impact(0.9, 0.7)],
  },
  {
    cue: 'tool_error',
    target: ALERT,
    layers: [layer('Sci-Fi_Tuner_Chaoswhip_02.mp3', 0, 0, 1.5, { gain: 0.8 }), impact(0.35, 0.9, 0.9)],
  },
  // milestones
  {
    cue: 'session_start',
    target: MILESTONE,
    layers: [
      layer('Fire_Swooshes_Burst_Evolving_19.mp3', 0, 0.2, 3.6, { fadeIn: 0.3, fadeOut: 1.0 }),
      layer(MECHANISMS, 0.3, 0, 1.8, { gain: 0.35 }),
      impact(1.9, 0.8, 0.9),
    ],
  },
  {
    cue: 'stage_done',
    target: MILESTONE,
    layers: [
      layer(MECHANISMS, 0, 21.3, 22.2, { gain: 0.4 }),
      layer('Fire_Impacts_Complex_04.mp3', 0.7, 0, undefined, { fadeOut: 0.8 }),
      impact(0.7, 0.85, 0.7),
    ],
  },
  { cue: 'task_start', target: MILESTONE, layers: [layer(MECHANISMS, 0, 9.8, 11.3, { gain: 0.6 }), impact(1.15, 1.0, 0.9)] },
  { cue: 'task_review', target: MILESTONE, layers: [layer(MECHANISM, 0, 0.3, 1.8), impact(0, 1.3, 0.35, 0.8)] },
  { cue: 'task_done', target: MILESTONE, layers: [layer(MECHANISM, 0, 0.3, 1.1, { gain: 0.6 }), impact(0.65, 1.0)] },
  { cue: 'decision_answered', target: MILESTONE, layers: [layer(MECHANISMS, 0, 13.1, 14.7, { gain: 0.6 }), impact(1.2, 1.1, 0.9)] },
  { cue: 'agent_spawn', target: MILESTONE, layers: [layer(MECHANISMS, 0, 0, 1.6, { gain: 0.6 }), impact(1.25, 1.15, 0.8)] },
  { cue: 'agent_complete', target: MILESTONE, layers: [layer(MECHANISMS, 0, 16.4, 17.9, { gain: 0.6 }), impact(1.1, 1.25, 0.8)] },
  {
    cue: 'agent_offboarded',
    target: MILESTONE,
    layers: [layer(MECHANISMS, 0, 3.3, 6.2, { rate: 0.75, gain: 0.6, fadeOut: 1.5 }), impact(2.6, 0.7, 0.7)],
  },
  // frequent
  { cue: 'tool_start', target: FREQUENT, layers: [layer(MECHANISMS, 0, 19.7, 20.15, { fadeOut: 0.15 })] },
  { cue: 'tool_complete', target: FREQUENT, layers: [impact(0, 1.35, 1.0, 0.5)] },
  { cue: 'handoff', target: FREQUENT, layers: [layer(MECHANISMS, 0, 6.6, 7.2, { fadeOut: 0.2 })] },
].map((r) => ({ ...r, file: `sfx-${r.cue}.mp3` }))

export const LOOPS = [
  // "Butuh jawaban owner": the double impact of decision_open, once every 2.2 s
  { loop: 'owner', target: { lufs: -20, peak: -5 }, period: 2.2, crossfade: 0, layers: [impact(0, 0.75), impact(0.45, 0.75)] },
  // waiting for permission: one mechanism gesture every 1.5 s
  { loop: 'waiting', target: { lufs: -21, peak: -5 }, period: 1.5, crossfade: 0, layers: [layer(MECHANISMS, 0, 19.7, 20.8)] },
  // thinking: 6 s of mecha ambience with a circuit hum under it, looped every 5 s with a 1 s equal-power crossfade
  // (mix.py's 1.0 s / 1.5 s fades were for a one-shot preview; the crossfade takes their place at the seam)
  {
    loop: 'thinking',
    target: { lufs: -28, peak: -5 },
    period: 5,
    crossfade: 1,
    layers: [layer('Mecha_Sequences_Ambience_06.mp3', 0, 2, 8), layer('Circuits_Hum_06.mp3', 0, 1, 7, { gain: 0.4 })],
  },
  // disintegrating: a creak, then rock crumbling; one gesture every 4.9 s
  {
    loop: 'disintegrating',
    target: { lufs: -26, peak: -5 },
    period: 4.9,
    crossfade: 0,
    layers: [
      layer('Plastic_Elements_Creaking_04.mp3', 0, 0, 2.6, { rate: 0.8, fadeOut: 0.6 }),
      layer('Rocks_Elements_09.mp3', 1.2, 0, 3.7, { gain: 0.8, fadeOut: 1.0 }),
    ],
  },
].map((r) => ({ ...r, file: `loop-${r.loop}.mp3` }))
