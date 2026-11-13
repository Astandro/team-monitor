'use client'

// The one sound engine and settings store of the page, shared by the graph and the team panel.
// Created lazily in the browser; the first tap or key press anywhere unlocks audio (browsers block it before that).

import { AudioEngine } from '@/lib/audio-engine'
import type { SoundCue } from './cues'
import { STAGGER_MS } from './gate'
import { SoundSettingsStore, type SoundSettings } from './settings'

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
