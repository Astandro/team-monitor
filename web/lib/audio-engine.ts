'use client'

/**
 * Audio engine using the Web Audio API. Sound set v3 plays sample files (built from CC0 packs, see
 * lib/sound/samples.ts) through a SampleBank; any cue whose file is missing, still loading or failed plays the
 * synthesised v2 sound from lib/sound/recipes.ts (lib/sound/synth.ts) instead. Both go through the same master bus
 * (volume, limiter).
 *
 * Muted by default. The AudioContext is only created after a user gesture (unlock) and only while sound is on,
 * so a muted page never touches audio, never downloads the files, and the browser never warns about autoplay.
 */

import type { SoundCue } from '@/lib/sound/cues'
import { RECIPES } from '@/lib/sound/recipes'
import type { SampleBank } from '@/lib/sound/sample-bank'
import { DEFAULT_VOLUME } from '@/lib/sound/settings'
import { createMasterBus, scheduleCue, scheduleSample, type MasterBus } from '@/lib/sound/synth'

export interface AudioEngineOptions {
  /** Sample files to play (sound set v3); without it every cue is synthesised (v2), e.g. in the VS Code webview. */
  samples?: SampleBank
  /** For tests: makes the context. */
  createContext?: () => AudioContext
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private bus: MasterBus | null = null
  private _muted = true
  private _volume = DEFAULT_VOLUME
  private unlocked = false
  private readonly samples: SampleBank | null
  private readonly createContext: () => AudioContext

  constructor(options: AudioEngineOptions = {}) {
    this.samples = options.samples ?? null
    this.createContext = options.createContext ?? (() => new AudioContext())
  }

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
    const t = ctx.currentTime + 0.01 + delay
    const sample = this.samples?.get(cue)
    if (sample) scheduleSample(bus, sample, t)
    else scheduleCue(bus, RECIPES[cue], t)
  }

  /** Resolves when the sample files have loaded (or failed), at most after `timeoutMs`; at once without samples. */
  samplesSettled(timeoutMs: number): Promise<void> {
    return this.samples ? this.samples.settled(timeoutMs) : Promise.resolve()
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
    let ctx: AudioContext
    try {
      ctx = this.createContext()
      this.bus = createMasterBus(ctx, this._muted ? 0 : this._volume)
      this.ctx = ctx
    } catch {
      /* no Web Audio: stay silent */
      return
    }
    // lazy: the files are fetched the first time audio actually starts (a tap with sound on)
    void this.samples?.load(ctx)
  }

  dispose() {
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
      this.bus = null
    }
  }
}
