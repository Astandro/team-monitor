'use client'

/**
 * Procedural audio engine using the Web Audio API. Every sound is synthesised from the recipes in
 * lib/sound/recipes.ts by lib/sound/synth.ts (oscillators, noise, FM, ring modulation, filters, distortion,
 * a generated reverb, a limiter on the master bus); no audio files, no network.
 *
 * Muted by default. The AudioContext is only created after a user gesture (unlock) and only while sound is on,
 * so a muted page never touches audio and the browser never warns about autoplay.
 */

import type { SoundCue } from '@/lib/sound/cues'
import { RECIPES } from '@/lib/sound/recipes'
import { DEFAULT_VOLUME } from '@/lib/sound/settings'
import { createMasterBus, scheduleCue, type MasterBus } from '@/lib/sound/synth'

export class AudioEngine {
  private ctx: AudioContext | null = null
  private bus: MasterBus | null = null
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
    const bus = this.bus
    if (!ctx || !bus) return
    scheduleCue(bus, RECIPES[cue], ctx.currentTime + 0.01 + delay)
  }

  private applyGain() {
    if (!this.ctx || !this.bus) return
    this.bus.input.gain.setTargetAtTime(this._muted ? 0 : this._volume, this.ctx.currentTime, 0.03)
  }

  private ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
      return
    }
    try {
      const ctx = new AudioContext()
      this.bus = createMasterBus(ctx, this._muted ? 0 : this._volume)
      this.ctx = ctx
    } catch {
      /* no Web Audio: stay silent */
    }
  }

  dispose() {
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
      this.bus = null
    }
  }
}
