// Background sounds that last as long as a state on the graph (owner request 15 Nov 2026), faint and pulsing in
// and out instead of playing once:
// - waiting:        an agent waits for permission: a robot's servos whirring in short phrases ("zuitt, zuitt
//                   zhing zhingg, zuittt": rising motor whines and metallic pings), owner request 15 Nov 2026;
// - thinking:       an agent is thinking: a slow, very faint servo moving back and forth, now and then a soft ping;
// - disintegrating: a finished sub-agent is wearing away before its offboard: a light crackle in episodes.
//
// ambienceFor() decides which play (pure, unit tested). AmbiencePlayer makes them with Web Audio on the master bus
// (volume, limiter) of synth.ts. No sample files: everything is synthesised.

import type { MasterBus } from './synth'

export type AmbienceKind = 'waiting' | 'thinking' | 'disintegrating'

export const AMBIENCE_KINDS: readonly AmbienceKind[] = ['waiting', 'thinking', 'disintegrating']

/** What ambienceFor reads of an agent (lib/agent-types Agent). */
export interface AmbienceAgent {
  state: string
  isMain: boolean
  finished?: { at: number; offboardAt: number }
}

/** The background sounds the agents call for now. */
export function ambienceFor(agents: Iterable<AmbienceAgent>, now: number): Set<AmbienceKind> {
  const out = new Set<AmbienceKind>()
  for (const a of agents) {
    if (a.state === 'waiting_permission') out.add('waiting')
    else if (a.state === 'thinking') out.add('thinking')
    // same rule as the canvas (draw-agents.ts): a finished sub-agent before its offboard deadline
    else if (!a.isMain && a.state === 'complete' && a.finished && now < a.finished.offboardAt) out.add('disintegrating')
  }
  return out
}

/**
 * How each loop sounds. `pulseHz`/`pulseDepth`: a slow swell in and out (depth 1 = down to silence at the bottom).
 * `level`: the loop's overall gain before the master volume. Grain peaks below are relative to it.
 */
export const AMBIENCE_SPECS: Record<AmbienceKind, { pulseHz: number; pulseDepth: number; level: number }> = {
  waiting: { pulseHz: 0.4, pulseDepth: 0.9, level: 1 },
  thinking: { pulseHz: 0.2, pulseDepth: 0.7, level: 1 },
  disintegrating: { pulseHz: 0.12, pulseDepth: 1, level: 1 },
}

/** Fade in and out of a loop (time constant, seconds); a stopped loop is torn down after STOP_AFTER_S. */
const FADE_TAU = 0.25
const STOP_AFTER_S = 1.6
/** The scheduler wakes this often and schedules grains this far ahead. */
const TICK_MS = 100
const AHEAD_S = 0.3


interface Loop {
  kind: AmbienceKind
  out: GainNode
  pulse: GainNode
  lfo: OscillatorNode
  /** long-running sources (thinking's hum) */
  holds: AudioScheduledSourceNode[]
  nextAt: number
  timer: ReturnType<typeof setInterval> | null
  stopping: ReturnType<typeof setTimeout> | null
}

export class AmbiencePlayer {
  private loops = new Map<AmbienceKind, Loop>()
  private readonly rnd: () => number

  constructor(private readonly bus: MasterBus, rnd: () => number = Math.random) {
    this.rnd = rnd
  }

  /** The kinds now playing (or fading in); a fading-out loop no longer counts. */
  active(): AmbienceKind[] {
    return [...this.loops.values()].filter((l) => l.stopping === null).map((l) => l.kind)
  }

  /** Play exactly these kinds: start the missing ones (fade in), fade out the others. */
  set(kinds: Iterable<AmbienceKind>): void {
    const want = new Set(kinds)
    for (const kind of AMBIENCE_KINDS) {
      const loop = this.loops.get(kind)
      if (want.has(kind)) {
        if (!loop) this.start(kind)
        else if (loop.stopping !== null) this.revive(loop)
      } else if (loop && loop.stopping === null) {
        this.stop(loop)
      }
    }
  }

  dispose(): void {
    for (const loop of this.loops.values()) this.teardown(loop)
    this.loops.clear()
  }

  private start(kind: AmbienceKind): void {
    const { ctx } = this.bus
    const spec = AMBIENCE_SPECS[kind]
    const out = ctx.createGain()
    out.gain.value = 0
    const pulse = ctx.createGain()
    pulse.gain.value = 1 - spec.pulseDepth / 2
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = spec.pulseHz
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = spec.pulseDepth / 2
    lfo.connect(lfoGain)
    lfoGain.connect(pulse.gain)
    pulse.connect(out)
    out.connect(this.bus.input)
    const send = ctx.createGain()
    send.gain.value = kind === 'thinking' ? 0.35 : 0.15
    out.connect(send)
    send.connect(this.bus.space)
    const now = ctx.currentTime
    lfo.start(now)
    out.gain.setTargetAtTime(spec.level, now, FADE_TAU)

    const loop: Loop = { kind, out, pulse, lfo, holds: [], nextAt: now + 0.05, timer: null, stopping: null }
    this.loops.set(kind, loop)
    this.schedule(loop)
    loop.timer = setInterval(() => this.schedule(loop), TICK_MS)
  }

  private revive(loop: Loop): void {
    if (loop.stopping !== null) clearTimeout(loop.stopping)
    loop.stopping = null
    loop.out.gain.cancelScheduledValues(this.bus.ctx.currentTime)
    loop.out.gain.setTargetAtTime(AMBIENCE_SPECS[loop.kind].level, this.bus.ctx.currentTime, FADE_TAU)
  }

  private stop(loop: Loop): void {
    const now = this.bus.ctx.currentTime
    loop.out.gain.cancelScheduledValues(now)
    loop.out.gain.setTargetAtTime(0, now, FADE_TAU)
    loop.stopping = setTimeout(() => {
      this.teardown(loop)
      this.loops.delete(loop.kind)
    }, STOP_AFTER_S * 1000)
  }

  private teardown(loop: Loop): void {
    if (loop.timer !== null) clearInterval(loop.timer)
    if (loop.stopping !== null) clearTimeout(loop.stopping)
    loop.timer = null
    loop.stopping = null
    for (const s of [loop.lfo, ...loop.holds]) {
      try { s.stop() } catch { /* already stopped */ }
    }
    try { loop.out.disconnect() } catch { /* already disconnected */ }
  }

  /** Schedule the grains of one loop up to AHEAD_S ahead of the audio clock. */
  private schedule(loop: Loop): void {
    const horizon = this.bus.ctx.currentTime + AHEAD_S
    const r = this.rnd
    if (loop.kind === 'waiting') {
      // servo phrases: "zuitt", "zuitt zuitt", "zhing zhingg", "zuittt", with a pause between them
      while (loop.nextAt < horizon) loop.nextAt += this.waitingPhrase(loop.pulse, loop.nextAt) + 0.35 + r() * 0.5
    } else if (loop.kind === 'thinking') {
      // a servo slowly turning one way and back, very faint; now and then a soft ping
      while (loop.nextAt < horizon) {
        const t = loop.nextAt
        const pan = r() * 0.8 - 0.4
        const low = 200 + r() * 60
        const high = low * (2.2 + r() * 0.5)
        this.whir(loop.pulse, t, low, high, 0.5, 0.005, pan)
        this.whir(loop.pulse, t + 0.62, high, low * 1.1, 0.45, 0.004, -pan)
        if (r() < 0.35) this.zhing(loop.pulse, t + 1.1, 1900 + r() * 700, 0.3, 0.0025, pan)
        loop.nextAt += 1.4 + r() * 1.2
      }
    } else {
      // crackle: tiny noise grains at random, bright, scattered in the stereo field
      while (loop.nextAt < horizon) {
        this.grain(loop.pulse, loop.nextAt, 0.004 + r() * 0.01, 0.003 + r() * 0.008, 2600, r() * 1.4 - 0.7)
        loop.nextAt += 0.03 + r() * 0.08
      }
    }
  }

  /** One waiting phrase starting at t; returns its length in seconds. */
  private waitingPhrase(dest: AudioNode, t: number): number {
    const r = this.rnd
    const pan = r() * 0.8 - 0.4
    const kind = Math.floor(r() * 4)
    if (kind === 0) { // zuitt
      this.whir(dest, t, 380, 1100, 0.17, 0.011, pan)
      return 0.17
    }
    if (kind === 1) { // zuitt, zuitt
      this.whir(dest, t, 380, 1050, 0.15, 0.011, pan)
      this.whir(dest, t + 0.24, 420, 1200, 0.15, 0.011, -pan)
      return 0.39
    }
    if (kind === 2) { // zhing zhingg
      this.zhing(dest, t, 1700, 0.28, 0.009, pan)
      this.zhing(dest, t + 0.2, 2050, 0.38, 0.009, -pan)
      return 0.58
    }
    // zuittt: a longer whine that settles
    this.whir(dest, t, 330, 1250, 0.34, 0.011, pan)
    return 0.34
  }

  /** A servo motor whine gliding from `from` to `to` Hz: buzzy saw through a band that follows it, a fast jitter. */
  private whir(dest: AudioNode, t: number, from: number, to: number, dur: number, peak: number, pan: number): void {
    const { ctx } = this.bus
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(from, t)
    osc.frequency.exponentialRampToValueAtTime(to, t + dur * 0.85)
    const jitter = ctx.createOscillator()
    jitter.frequency.value = 38
    const jitterDepth = ctx.createGain()
    jitterDepth.gain.value = from * 0.02
    jitter.connect(jitterDepth)
    jitterDepth.connect(osc.frequency)
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.Q.value = 2
    band.frequency.setValueAtTime(from * 2, t)
    band.frequency.exponentialRampToValueAtTime(to * 2, t + dur * 0.85)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.linearRampToValueAtTime(peak, t + Math.min(0.03, dur / 4))
    env.gain.setTargetAtTime(0.0001, t + dur * 0.8, dur * 0.08)
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    osc.connect(band)
    band.connect(env)
    env.connect(p)
    p.connect(dest)
    osc.start(t)
    jitter.start(t)
    osc.stop(t + dur + 0.1)
    jitter.stop(t + dur + 0.1)
  }

  /** A metallic ping ("zhing"): an FM sine with an inharmonic modulator that dies away, gliding up a little. */
  private zhing(dest: AudioNode, t: number, freq: number, dur: number, peak: number, pan: number): void {
    const { ctx } = this.bus
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, t)
    osc.frequency.exponentialRampToValueAtTime(freq * 1.08, t + dur)
    const mod = ctx.createOscillator()
    mod.frequency.value = freq * 2.76
    const modDepth = ctx.createGain()
    modDepth.gain.setValueAtTime(freq * 1.5, t)
    modDepth.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur * 0.6)
    mod.connect(modDepth)
    modDepth.connect(osc.frequency)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.linearRampToValueAtTime(peak, t + 0.004)
    env.gain.setTargetAtTime(0.0001, t + 0.01, dur / 4)
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    osc.connect(env)
    env.connect(p)
    p.connect(dest)
    osc.start(t)
    mod.start(t)
    osc.stop(t + dur + 0.1)
    mod.stop(t + dur + 0.1)
  }

  private grain(dest: AudioNode, t: number, dur: number, peak: number, highpass: number, pan: number): void {
    const { ctx } = this.bus
    const src = ctx.createBufferSource()
    src.buffer = this.bus.noise
    const f = ctx.createBiquadFilter()
    f.type = 'highpass'
    f.frequency.value = highpass
    const env = ctx.createGain()
    env.gain.setValueAtTime(peak, t)
    env.gain.setTargetAtTime(0.0001, t + 0.001, dur / 3)
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    src.connect(f)
    f.connect(env)
    env.connect(p)
    p.connect(dest)
    const offset = this.rnd() * Math.max(0, this.bus.noise.duration - dur - 0.01)
    src.start(t, offset, dur + 0.02)
  }
}
