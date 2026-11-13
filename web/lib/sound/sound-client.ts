'use client'

// The one sound engine and settings store of the page, shared by the graph and the team panel.
// Created lazily in the browser; the first tap or key press anywhere unlocks audio (browsers block it before that).

import { AudioEngine } from '@/lib/audio-engine'
import type { SoundCue } from './cues'
import { demoLabel, demoSteps, DEMO_ORDER } from './demo'
import { STAGGER_MS } from './gate'
import { SoundSettingsStore, type SoundSettings } from './settings'
import { renderCueOffline, renderMixOffline } from './synth'

// QA handle (read-only, plays nothing): render any sound offline, e.g. to save it as a WAV in a headless browser.
if (typeof window !== 'undefined') {
  ;(window as unknown as { tmSoundLab?: unknown }).tmSoundLab = {
    cues: DEMO_ORDER,
    render: (cue: SoundCue, sampleRate?: number) => renderCueOffline(cue, sampleRate),
    renderMix: (mix: { cue: SoundCue; at: number }[], sampleRate?: number) => renderMixOffline(mix, sampleRate),
  }
}

interface SoundClient {
  engine: AudioEngine
  store: SoundSettingsStore
}

let client: SoundClient | null = null

function browserStorage() {
  return window.localStorage
}

export function getSoundClient(): SoundClient | null {
  if (typeof window === 'undefined') return null
  if (client) return client
  const engine = new AudioEngine()
  const store = new SoundSettingsStore(browserStorage, engine)
  client = { engine, store }

  const unlock = () => {
    engine.unlock()
    window.removeEventListener('pointerdown', unlock, true)
    window.removeEventListener('keydown', unlock, true)
    window.removeEventListener('touchend', unlock, true)
  }
  window.addEventListener('pointerdown', unlock, true)
  window.addEventListener('keydown', unlock, true)
  window.addEventListener('touchend', unlock, true)
  return client
}

/** Play cues already ordered by importance, a short gap apart. */
export function playCues(cues: readonly SoundCue[]): void {
  const c = getSoundClient()
  if (!c || cues.length === 0 || c.store.get().muted) return
  cues.forEach((cue, i) => c.engine.play(cue, (i * STAGGER_MS) / 1000))
}

/** Toggle from a button press (a user gesture, so audio may start right away). */
export function toggleSound(): void {
  const c = getSoundClient()
  if (!c) return
  c.store.toggleMuted()
  c.engine.unlock()
}

/**
 * "Coba suara": play every sound in turn, reporting each one's label (null when the demo is over or stopped).
 * Called from a button press, so audio may start; it turns sound on when it was off (the owner asked to hear it).
 * Bypasses the rate limits on purpose. Returns a stop function (sounds already started finish on their own).
 */
export function startSoundDemo(onStep: (label: string | null) => void): () => void {
  const c = getSoundClient()
  if (!c) {
    onStep(null)
    return () => {}
  }
  if (c.store.get().muted) c.store.setMuted(false)
  c.engine.unlock()
  const { steps, total } = demoSteps()
  const timers = steps.map((step, i) =>
    window.setTimeout(() => {
      c.engine.play(step.cue)
      onStep(demoLabel(step, i, steps.length))
    }, step.at * 1000),
  )
  timers.push(window.setTimeout(() => onStep(null), total * 1000))
  return () => {
    for (const t of timers) window.clearTimeout(t)
    onStep(null)
  }
}

export function setSoundVolume(volume: number): void {
  getSoundClient()?.store.setVolume(volume)
}

const SERVER_SETTINGS: SoundSettings = { muted: true, volume: 0.5 }

export function soundSubscribe(listener: () => void): () => void {
  const c = getSoundClient()
  return c ? c.store.subscribe(listener) : () => {}
}

export function soundSnapshot(): SoundSettings {
  return getSoundClient()?.store.get() ?? SERVER_SETTINGS
}

export function soundServerSnapshot(): SoundSettings {
  return SERVER_SETTINGS
}
