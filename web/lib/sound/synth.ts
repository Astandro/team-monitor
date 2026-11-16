// Turns recipes (recipes.ts) into Web Audio nodes on any BaseAudioContext: the live AudioContext of the page
// (audio-engine.ts) or an OfflineAudioContext (renderCueOffline, used to listen to a sound without the UI).
//
// Signal path: voice -> envelope -> (panner) -> master gain (volume) -> limiter -> speakers
//              voice -> space send -> reverb (convolver, generated impulse) -> reverb return -> master gain
// Everything reaches the speakers through the limiter, so overlapping cues never clip.

import type { SoundCue } from './cues'
import { driveCurve, RECIPES, recipeDuration, stepTimes, type Voice } from './recipes'

export const SILENT = 0.0001

/** Gentle limiter on the master bus. */
export const LIMITER = { threshold: -6, knee: 4, ratio: 12, attack: 0.002, release: 0.2 } as const

/** The space reverb: impulse length, how much of it comes back, the short gap before it starts. */
export const SPACE = { seconds: 2.6, returnGain: 2, predelay: 0.02 } as const

/** Glide between two steps of a stepped voice, in seconds. */
const STEP_GLIDE = 0.006

/** Small deterministic random generator (mulberry32), so every render of a sound is the same. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** White noise, -1..1. */
export function whiteNoise(length: number, seed = 7): Float32Array {
  const rnd = seededRandom(seed)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = rnd() * 2 - 1
  return out
}

/**
 * Impulse response of a large, dark space: stereo noise fading by 60 dB over `seconds`, getting darker as it
 * fades (a one-pole lowpass closing over time), after a short silent predelay.
 */
export function spaceImpulse(sampleRate: number, seconds: number = SPACE.seconds, seed = 11): [Float32Array, Float32Array] {
  const length = Math.max(1, Math.round(sampleRate * seconds))
  const pre = Math.round(sampleRate * SPACE.predelay)
  const make = (s: number) => {
    const rnd = seededRandom(s)
    const out = new Float32Array(length)
    let y = 0
    for (let i = pre; i < length; i++) {
      const t = (i - pre) / (length - pre)
      const x = rnd() * 2 - 1
      const c = 0.85 - 0.7 * t // brightness: open at the start, dark in the tail
      y += c * (x - y)
      out[i] = y * Math.exp(-6.9 * t)
    }
    return out
  }
  return [make(seed), make(seed + 1)]
}

export interface MasterBus {
  ctx: BaseAudioContext
  /** master volume */
  input: GainNode
  limiter: DynamicsCompressorNode
  /** reverb input (voices send here) */
  space: AudioNode
  noise: AudioBuffer
}

/** Master gain -> limiter -> destination, plus the reverb returning into the master gain. */
export function createMasterBus(ctx: BaseAudioContext, volume: number): MasterBus {
  const input = ctx.createGain()
  input.gain.value = volume
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = LIMITER.threshold
  limiter.knee.value = LIMITER.knee
  limiter.ratio.value = LIMITER.ratio
  limiter.attack.value = LIMITER.attack
  limiter.release.value = LIMITER.release
  input.connect(limiter)
  limiter.connect(ctx.destination)

  const space = ctx.createGain()
  const reverb = ctx.createConvolver()
  const [l, r] = spaceImpulse(ctx.sampleRate)
  const ir = ctx.createBuffer(2, l.length, ctx.sampleRate)
  ir.getChannelData(0).set(l)
  ir.getChannelData(1).set(r)
  reverb.buffer = ir
  const ret = ctx.createGain()
  ret.gain.value = SPACE.returnGain
  space.connect(reverb)
  reverb.connect(ret)
  ret.connect(input)

  const noiseLen = Math.round(ctx.sampleRate * 2)
  const noise = ctx.createBuffer(1, noiseLen, ctx.sampleRate)
  noise.getChannelData(0).set(whiteNoise(noiseLen))

  return { ctx, input, limiter, space, noise }
}

/** Schedule one cue's voices starting at time t0 (seconds on the context clock). */
export function scheduleCue(bus: MasterBus, voices: readonly Voice[], t0: number): void {
  voices.forEach((v, i) => scheduleVoice(bus, v, t0, i))
}

function scheduleVoice(bus: MasterBus, v: Voice, t0: number, index: number): void {
  const { ctx } = bus
  const start = t0 + v.start
  const end = start + v.dur
  const sources: AudioScheduledSourceNode[] = []
  const nodes: AudioNode[] = []

  // source
  let head: AudioNode
  if (v.type === 'noise') {
    const src = ctx.createBufferSource()
    src.buffer = bus.noise
    src.loop = true
    sources.push(src)
    head = src
    // different voices read different stretches of the noise, so layered noise does not cancel or double up
    const offset = (index * 0.37) % bus.noise.duration
    src.start(start, offset)
  } else {
    const osc = ctx.createOscillator()
    osc.type = v.type
    if (v.steps && v.steps.length > 0) {
      let prev = v.steps[0]
      for (const { at, freq } of stepTimes(v)) {
        if (at === 0) osc.frequency.setValueAtTime(freq, start)
        else {
          osc.frequency.setValueAtTime(prev, start + at - STEP_GLIDE)
          osc.frequency.exponentialRampToValueAtTime(freq, start + at)
        }
        prev = freq
      }
    } else {
      osc.frequency.setValueAtTime(v.freq, start)
      if (v.to) osc.frequency.exponentialRampToValueAtTime(v.to, end)
    }
    if (v.detune) osc.detune.value = v.detune
    if (v.fm) {
      const mod = ctx.createOscillator()
      mod.type = 'sine'
      mod.frequency.value = v.freq * v.fm.ratio
      const depth = ctx.createGain()
      depth.gain.setValueAtTime(v.fm.index * v.freq, start)
      if (v.fm.indexTo !== undefined) depth.gain.exponentialRampToValueAtTime(Math.max(0.01, v.fm.indexTo * v.freq), end)
      mod.connect(depth)
      depth.connect(osc.frequency)
      sources.push(mod)
      nodes.push(depth)
      mod.start(start)
    }
    sources.push(osc)
    head = osc
    osc.start(start)
  }

  if (v.ring) {
    const ring = ctx.createGain()
    ring.gain.value = 0
    const carrier = ctx.createOscillator()
    carrier.type = 'sine'
    carrier.frequency.value = v.ring
    carrier.connect(ring.gain)
    head.connect(ring)
    head = ring
    sources.push(carrier)
    nodes.push(ring)
    carrier.start(start)
  }

  if (v.filter) {
    const filter = ctx.createBiquadFilter()
    filter.type = v.filter.type
    filter.frequency.setValueAtTime(v.filter.freq, start)
    if (v.filter.to) filter.frequency.exponentialRampToValueAtTime(v.filter.to, end)
    if (v.filter.q !== undefined) filter.Q.value = v.filter.q
    head.connect(filter)
    head = filter
    nodes.push(filter)
  }

  if (v.drive) {
    const shaper = ctx.createWaveShaper()
    shaper.curve = driveCurve(v.drive) as Float32Array<ArrayBuffer>
    shaper.oversample = '2x'
    head.connect(shaper)
    head = shaper
    nodes.push(shaper)
  }

  // envelope
  const env = ctx.createGain()
  const attack = Math.min(v.attack ?? 0.005, v.dur / 2)
  env.gain.setValueAtTime(SILENT, start)
  env.gain.linearRampToValueAtTime(v.peak, start + attack)
  if (v.release) {
    const hold = Math.max(start + attack, end - v.release)
    env.gain.setValueAtTime(v.peak, hold)
  }
  env.gain.exponentialRampToValueAtTime(SILENT, end)
  head.connect(env)
  nodes.push(env)
  let out: AudioNode = env

  if (v.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner()
    panner.pan.setValueAtTime(v.pan, start)
    if (v.panTo !== undefined) panner.pan.linearRampToValueAtTime(v.panTo, end)
    env.connect(panner)
    out = panner
    nodes.push(panner)
  }
  out.connect(bus.input)

  if (v.space) {
    const send = ctx.createGain()
    send.gain.value = v.space
    out.connect(send)
    send.connect(bus.space)
    nodes.push(send)
  }

  const main = sources[sources.length - 1]
  main.onended = () => {
    for (const s of sources) s.disconnect()
    for (const n of nodes) n.disconnect()
  }
  for (const s of sources) s.stop(end + 0.02)
}

/**
 * Play a decoded sample (sound set v4) at time t0 into the master gain, so volume, mute and the limiter apply to it
 * like to the synthesised sounds. The file is the finished sound, so it does not use the space send.
 */
export function scheduleSample(bus: MasterBus, buffer: AudioBuffer, t0: number): void {
  const src = bus.ctx.createBufferSource()
  src.buffer = buffer
  src.connect(bus.input)
  src.onended = () => src.disconnect()
  src.start(t0)
}

/** Seconds of reverb and margin rendered after a cue's last voice. */
export const RENDER_TAIL = SPACE.seconds + 0.4

/**
 * Render one cue offline at full volume, through the same master bus as the page (limiter and reverb included).
 * Used to listen to the sounds without the UI and to measure their length and peak level.
 */
export function renderCueOffline(cue: SoundCue, sampleRate = 44100, volume = 1): Promise<AudioBuffer> {
  return renderMixOffline([{ cue, at: 0 }], sampleRate, volume)
}

/** Several cues at given offsets (seconds), e.g. a burst staggered like playCues does, to check nothing clips. */
export function renderMixOffline(mix: readonly { cue: SoundCue; at: number }[], sampleRate = 44100, volume = 1): Promise<AudioBuffer> {
  const end = mix.reduce((m, { cue, at }) => Math.max(m, at + recipeDuration(RECIPES[cue])), 0)
  const ctx = new OfflineAudioContext(2, Math.ceil((end + RENDER_TAIL) * sampleRate), sampleRate)
  const bus = createMasterBus(ctx, volume)
  for (const { cue, at } of mix) scheduleCue(bus, RECIPES[cue], 0.01 + at)
  return ctx.startRendering()
}
