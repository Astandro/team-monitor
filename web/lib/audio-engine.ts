'use client'

/**
 * Procedural audio engine using the Web Audio API. Every sound is synthesised from the recipes in
 * lib/sound/recipes.ts (oscillators, filters, envelopes); no audio files, no network.
 *
 * Muted by default. The AudioContext is only created after a user gesture (unlock) and only while sound is on,
 * so a muted page never touches audio and the browser never warns about autoplay.
 */

import type { SoundCue } from '@/lib/sound/cues'
import { RECIPES, type Voice } from '@/lib/sound/recipes'
import { DEFAULT_VOLUME } from '@/lib/sound/settings'

const SILENT = 0.0001

export class AudioEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private _muted = true
  private _volume = DEFAULT_VOLUME
  private unlocked = false

  get muted() { return this._muted }

  /** Call from a user gesture (tap, key). Creates or resumes the context when sound is on. */
  unlock() {
    this.unlocked = true
    if (!this._muted) this.ensureContext()
  }

  setMuted(muted: boolean) {
    this._muted = muted
    if (!muted && this.unlocked) this.ensureContext()
    this.applyGain()
  }

  setVolume(volume: number) {
    this._volume = volume
    this.applyGain()
  }

  /** Play one cue now, plus an optional delay in seconds. Silent while muted or before the first gesture. */
  play(cue: SoundCue, delay = 0) {
    if (this._muted || !this.unlocked) return
    this.ensureContext()
    const ctx = this.ctx
    const bus = this.masterGain
    if (!ctx || !bus) return
    const t0 = ctx.currentTime + 0.01 + delay
    for (const v of RECIPES[cue]) this.voice(ctx, bus, v, t0)
  }

  private applyGain() {
    if (!this.ctx || !this.masterGain) return
    this.masterGain.gain.setTargetAtTime(this._muted ? 0 : this._volume, this.ctx.currentTime, 0.03)
  }

  private ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
      return
    }
    try {
      const ctx = new AudioContext()
      const master = ctx.createGain()
      master.gain.value = this._muted ? 0 : this._volume
      // gentle limiter so overlapping cues never clip
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -12
      limiter.knee.value = 6
      limiter.ratio.value = 8
      limiter.attack.value = 0.003
      limiter.release.value = 0.15
      master.connect(limiter)
      limiter.connect(ctx.destination)
      this.ctx = ctx
      this.masterGain = master
    } catch {
      /* no Web Audio: stay silent */
    }
  }

  private voice(ctx: AudioContext, bus: AudioNode, v: Voice, t0: number) {
    const start = t0 + v.start
    const end = start + v.dur
    const osc = ctx.createOscillator()
    osc.type = v.type
    osc.frequency.setValueAtTime(v.freq, start)
    if (v.to) osc.frequency.exponentialRampToValueAtTime(v.to, end)
    if (v.detune) osc.detune.value = v.detune

    const gain = ctx.createGain()
    const attack = Math.min(v.attack ?? 0.005, v.dur / 2)
    gain.gain.setValueAtTime(SILENT, start)
    gain.gain.linearRampToValueAtTime(v.peak, start + attack)
    gain.gain.exponentialRampToValueAtTime(SILENT, end)

    let head: AudioNode = osc
    let filter: BiquadFilterNode | null = null
    if (v.filter) {
      filter = ctx.createBiquadFilter()
      filter.type = v.filter.type
      filter.frequency.setValueAtTime(v.filter.freq, start)
      if (v.filter.to) filter.frequency.exponentialRampToValueAtTime(v.filter.to, end)
      if (v.filter.q !== undefined) filter.Q.value = v.filter.q
      osc.connect(filter)
      head = filter
    }
    head.connect(gain)
    gain.connect(bus)
    osc.onended = () => {
      osc.disconnect()
      filter?.disconnect()
      gain.disconnect()
    }
    osc.start(start)
    osc.stop(end + 0.02)
  }

  dispose() {
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
      this.masterGain = null
    }
  }
}
