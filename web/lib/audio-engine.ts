'use client'

/**
 * Audio engine using the Web Audio API. Sound set v4 plays sample files (mixed from Gregor Quendel's CC BY 4.0
 * pack, see lib/sound/samples.ts) through a SampleBank, the event sounds and the background loops alike; any sound
 * whose file is missing, still loading or failed plays its synthesised fallback from lib/sound/recipes.ts
 * (lib/sound/synth.ts) or lib/sound/ambience.ts instead. Both go through the same master bus (volume, limiter).
 * The volume slider's value is squared into the master gain (settings.ts volumeGain).
 *
 * Muted by default. The AudioContext is only created after a user gesture (unlock) and only while sound is on,
 * so a muted page never touches audio, never downloads the files, and the browser never warns about autoplay.
 */

import { AmbiencePlayer, type AmbienceKind, type LoopSample } from '@/lib/sound/ambience'
import type { SoundCue } from '@/lib/sound/cues'
import { RECIPES } from '@/lib/sound/recipes'
import type { SampleBank } from '@/lib/sound/sample-bank'
import { loopKey, loopWindow, type SampleKey } from '@/lib/sound/samples'
import { DEFAULT_VOLUME, volumeGain } from '@/lib/sound/settings'
import { createMasterBus, scheduleCue, scheduleSample, type MasterBus } from '@/lib/sound/synth'

export interface AudioEngineOptions {
  /** Sample files to play (sound set v4); without it every sound is synthesised, e.g. in the VS Code webview. */
  samples?: SampleBank<SampleKey>
  /** For tests: makes the context. */
  createContext?: () => AudioContext
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private bus: MasterBus | null = null
  private _muted = true
  private _volume = DEFAULT_VOLUME
  private unlocked = false
  private readonly samples: SampleBank<SampleKey> | null
  private readonly createContext: () => AudioContext
  /** Background loops (lib/sound/ambience.ts): what the graph asks for, and the player once audio runs. */
  private wantedAmbience = new Set<AmbienceKind>()
  private ambience: AmbiencePlayer | null = null

  constructor(options: AudioEngineOptions = {}) {
    this.samples = options.samples ?? null
    this.createContext = options.createContext ?? (() => new AudioContext())
  }

  get muted() { return this._muted }

  /** Call from a user gesture (tap, key). Creates or resumes the context when sound is on. */
  unlock() {
    this.unlocked = true
    if (!this._muted) this.ensureContext()
    this.applyAmbience()
  }

  setMuted(muted: boolean) {
    this._muted = muted
    if (!muted && this.unlocked) this.ensureContext()
    this.applyGain()
    this.applyAmbience()
  }

  /**
   * The background loops that should play now (waiting, thinking, disintegrating). Kept while muted or locked and
   * started once sound runs; muting fades them out and stops their scheduling.
   */
  setAmbience(kinds: Iterable<AmbienceKind>) {
    this.wantedAmbience = new Set(kinds)
    this.applyAmbience()
  }

  /** The loops now playing (tests, QA). */
  ambienceActive(): AmbienceKind[] {
    return this.ambience?.active() ?? []
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

  /** The loaded loop file of a background state and its loop window, or null (then the stand-in is synthesised). */
  private loopSample = (kind: AmbienceKind): LoopSample | null => {
    const buffer = this.samples?.get(loopKey(kind))
    return buffer ? { buffer, ...loopWindow(kind) } : null
  }

  /** Resolves when the sample files have loaded (or failed), at most after `timeoutMs`; at once without samples. */
  samplesSettled(timeoutMs: number): Promise<void> {
    return this.samples ? this.samples.settled(timeoutMs) : Promise.resolve()
  }

  private applyAmbience() {
    if (!this.ctx || !this.bus) return
    const kinds = this._muted || !this.unlocked ? [] : [...this.wantedAmbience]
    if (!this.ambience) {
      if (kinds.length === 0) return
      this.ambience = new AmbiencePlayer(this.bus, Math.random, this.loopSample)
    }
    this.ambience.set(kinds)
  }

  private applyGain() {
    if (!this.ctx || !this.bus) return
    this.bus.input.gain.setTargetAtTime(this._muted ? 0 : volumeGain(this._volume), this.ctx.currentTime, 0.03)
  }

  private ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
      return
    }
    let ctx: AudioContext
    try {
      ctx = this.createContext()
      this.bus = createMasterBus(ctx, this._muted ? 0 : volumeGain(this._volume))
      this.ctx = ctx
    } catch {
      /* no Web Audio: stay silent */
      return
    }
    // lazy: the files are fetched the first time audio actually starts (a tap with sound on)
    void this.samples?.load(ctx)
    this.applyAmbience()
  }

  dispose() {
    this.ambience?.dispose()
    this.ambience = null
    if (this.ctx) {
      void this.ctx.close().catch(() => {})
      this.ctx = null
      this.bus = null
    }
  }
}
