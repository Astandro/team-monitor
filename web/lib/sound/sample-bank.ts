// Loads and decodes the sample files of sound set v3, once, when the engine first gets an AudioContext (that is
// after the first tap with sound on: a muted page never downloads them). A file that fails to load or decode stays
// "failed" and its cue keeps playing the synthesised v2 sound (the engine falls back per cue).

import type { SoundCue } from './cues'

export type SampleStatus = 'idle' | 'loading' | 'ready' | 'failed'

/** Downloads one file; rejects on a network error or a non-OK response. */
export type FetchBytes = (url: string) => Promise<ArrayBuffer>

export interface SampleDecoder {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>
}

/** fetch() for the browser: same origin, revalidated like the bundle. */
export const browserFetchBytes: FetchBytes = async (url) => {
  const res = await fetch(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.arrayBuffer()
}

export class SampleBank {
  private readonly buffers = new Map<SoundCue, AudioBuffer>()
  private readonly states = new Map<SoundCue, SampleStatus>()
  private loading: Promise<void> | null = null

  constructor(
    private readonly urls: Readonly<Record<SoundCue, string>>,
    private readonly fetchBytes: FetchBytes = browserFetchBytes,
  ) {}

  status(cue: SoundCue): SampleStatus {
    return this.states.get(cue) ?? 'idle'
  }

  statuses(): Record<SoundCue, SampleStatus> {
    const out = {} as Record<SoundCue, SampleStatus>
    for (const cue of Object.keys(this.urls) as SoundCue[]) out[cue] = this.status(cue)
    return out
  }

  /** The decoded sound, or null while it loads, after it failed, or before load() ran. */
  get(cue: SoundCue): AudioBuffer | null {
    return this.buffers.get(cue) ?? null
  }

  /** Start loading every file (only the first call does anything). Resolves when all are ready or failed. */
  load(decoder: SampleDecoder): Promise<void> {
    if (this.loading) return this.loading
    const cues = Object.keys(this.urls) as SoundCue[]
    for (const cue of cues) this.states.set(cue, 'loading')
    this.loading = Promise.all(cues.map((cue) => this.loadOne(cue, decoder))).then(() => undefined)
    return this.loading
  }

  /** Resolves once loading settled, or after `timeoutMs`, whichever comes first (immediately if never started). */
  settled(timeoutMs: number): Promise<void> {
    if (!this.loading) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs)
      void this.loading!.then(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  private async loadOne(cue: SoundCue, decoder: SampleDecoder): Promise<void> {
    try {
      const bytes = await this.fetchBytes(this.urls[cue])
      const buffer = await decoder.decodeAudioData(bytes)
      this.buffers.set(cue, buffer)
      this.states.set(cue, 'ready')
    } catch {
      this.states.set(cue, 'failed')
    }
  }
}
