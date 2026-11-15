// Background sounds that last as long as a state on the graph (owner request 15 Nov 2026), faint and pulsing in
// and out instead of playing once:
// - waiting:        an agent waits for permission: robotic processing bleeps;
// - thinking:       an agent is thinking: a very faint sci-fi processing hum with rare high glints;
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

const WAITING_NOTES = [880, 1175, 1320, 1568, 1760, 2093]

interface Loop {
  kind: AmbienceKind
  out: GainNode
  pulse: GainNode
  lfo: OscillatorNode
  /** long-running sources (thinking's hum) */
  holds: AudioScheduledSourceNode[]
  nextAt: number
  /** second grain clock (waiting's low tones, thinking's glints) */
  nextAt2: number
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

    const loop: Loop = { kind, out, pulse, lfo, holds: [], nextAt: now + 0.05, nextAt2: now + 0.4, timer: null, stopping: null }
    if (kind === 'thinking') loop.holds.push(...this.hum(pulse, now))
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
      // processing bleeps: short square tones on a pentatonic-ish set, through a band
      while (loop.nextAt < horizon) {
        const note = WAITING_NOTES[Math.floor(r() * WAITING_NOTES.length)]
        this.bleep(loop.pulse, loop.nextAt, note, 0.025 + r() * 0.025, 0.011, 'square', 1900, r() * 0.6 - 0.3)
        loop.nextAt += 0.07 + r() * 0.08
      }
      // now and then a lower "computing" tone
      while (loop.nextAt2 < horizon) {
        this.bleep(loop.pulse, loop.nextAt2, r() < 0.5 ? 440 : 494, 0.05, 0.006, 'triangle', 900, 0)
        loop.nextAt2 += 0.5 + r() * 0.5
      }
    } else if (loop.kind === 'thinking') {
      // rare, very faint high glints over the hum
      while (loop.nextAt2 < horizon) {
        this.bleep(loop.pulse, loop.nextAt2, 2400 + r() * 1400, 0.08, 0.0025, 'sine', 3000, r() * 1.2 - 0.6)
        loop.nextAt2 += 0.5 + r() * 0.6
      }
      loop.nextAt = horizon
    } else {
      // crackle: tiny noise grains at random, bright, scattered in the stereo field
      while (loop.nextAt < horizon) {
        this.grain(loop.pulse, loop.nextAt, 0.004 + r() * 0.01, 0.003 + r() * 0.008, 2600, r() * 1.4 - 0.7)
        loop.nextAt += 0.03 + r() * 0.08
      }
    }
  }

  /** thinking's hum: looped noise in a narrow, slowly wandering band. */
  private hum(dest: AudioNode, t: number): AudioScheduledSourceNode[] {
    const { ctx } = this.bus
    const src = ctx.createBufferSource()
    src.buffer = this.bus.noise
    src.loop = true
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = 1100
    band.Q.value = 9
    const wander = ctx.createOscillator()
    wander.frequency.value = 0.11
    const wanderDepth = ctx.createGain()
    wanderDepth.gain.value = 450
    wander.connect(wanderDepth)
    wanderDepth.connect(band.frequency)
    const g = ctx.createGain()
    g.gain.value = 0.004
    src.connect(band)
    band.connect(g)
    g.connect(dest)
    src.start(t)
    wander.start(t)
    return [src, wander]
  }

  private bleep(dest: AudioNode, t: number, freq: number, dur: number, peak: number, type: OscillatorType, band: number, pan: number): void {
    const { ctx } = this.bus
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = band
    f.Q.value = 1.5
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, t)
    env.gain.linearRampToValueAtTime(peak, t + Math.min(0.006, dur / 3))
    env.gain.setTargetAtTime(0.0001, t + dur * 0.5, dur / 4)
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    osc.connect(f)
    f.connect(env)
    env.connect(p)
    p.connect(dest)
    osc.start(t)
    osc.stop(t + dur + 0.05)
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
