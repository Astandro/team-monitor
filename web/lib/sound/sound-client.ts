'use client'

// The one sound engine and settings store of the page, shared by the graph and the team panel.
// Created lazily in the browser; the first tap or key press anywhere unlocks audio (browsers block it before that).

import { AudioEngine } from '@/lib/audio-engine'
import type { SoundCue } from './cues'
import { demoLabel, demoSteps, DEMO_LOAD_WAIT_MS, DEMO_LOADING_LABEL, DEMO_ORDER } from './demo'
import { STAGGER_MS } from './gate'
import { SampleBank } from './sample-bank'
import { sampleUrls } from './samples'
import { SoundSettingsStore, type SoundSettings } from './settings'
import { renderCueOffline, renderMixOffline } from './synth'

/**
 * Sound set v3 (sample files) only in the standalone app, whose server serves the files next to index.js. The VS Code
 * webview keeps the synthesised v2 set (its CSP does not allow fetching media).
 */
const USE_SAMPLES = process.env.AGENT_FLOW_STANDALONE === '1'

interface SoundClient {
  engine: AudioEngine
  store: SoundSettingsStore
  samples: SampleBank | null
}

let client: SoundClient | null = null

// QA handle (plays nothing): render any synthesised (v2) sound offline, e.g. to save it as a WAV in a headless
// browser, and read which sample files (v3) loaded.
if (typeof window !== 'undefined') {
  ;(window as unknown as { tmSoundLab?: unknown }).tmSoundLab = {
    cues: DEMO_ORDER,
    render: (cue: SoundCue, sampleRate?: number) => renderCueOffline(cue, sampleRate),
    renderMix: (mix: { cue: SoundCue; at: number }[], sampleRate?: number) => renderMixOffline(mix, sampleRate),
    samples: () => client?.samples?.statuses() ?? null,
  }
}

function browserStorage() {
  return window.localStorage
}

export function getSoundClient(): SoundClient | null {
  if (typeof window === 'undefined') return null
  if (client) return client
  const samples = USE_SAMPLES ? new SampleBank(sampleUrls('/')) : null
  const engine = new AudioEngine({ samples: samples ?? undefined })
  const store = new SoundSettingsStore(browserStorage, engine)
  client = { engine, store, samples }

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
 * The first time, the sample files are still downloading: it shows "Memuat suara…" and starts once they are in
 * (at most DEMO_LOAD_WAIT_MS; a sound not loaded by then plays its synthesised version).
 */
export function startSoundDemo(onStep: (label: string | null) => void): () => void {
  const c = getSoundClient()
  if (!c) {
    onStep(null)
    return () => {}
  }
  if (c.store.get().muted) c.store.setMuted(false)
  c.engine.unlock()
  let stopped = false
  const timers: number[] = []
  const begin = () => {
    if (stopped) return
    const { steps, total } = demoSteps()
    steps.forEach((step, i) =>
      timers.push(window.setTimeout(() => {
        c.engine.play(step.cue)
        onStep(demoLabel(step, i, steps.length))
      }, step.at * 1000)),
    )
    timers.push(window.setTimeout(() => onStep(null), total * 1000))
  }
  const loading = c.samples ? Object.values(c.samples.statuses()).some((s) => s === 'loading') : false
  if (loading) {
    onStep(DEMO_LOADING_LABEL)
    void c.engine.samplesSettled(DEMO_LOAD_WAIT_MS).then(begin)
  } else {
    begin()
  }
  return () => {
    stopped = true
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
