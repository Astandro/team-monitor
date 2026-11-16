// Loads and decodes the sample files (event sounds and background loops), once, when the engine first gets an
// AudioContext (that is after the first tap with sound on: a muted page never downloads them). A file that fails to
// load or decode stays "failed" and its sound keeps playing the synthesised fallback (the engine falls back per
// sound).

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

export class SampleBank<K extends string = SoundCue> {
  private readonly buffers = new Map<K, AudioBuffer>()
  private readonly states = new Map<K, SampleStatus>()
  private loading: Promise<void> | null = null

  constructor(
    private readonly urls: Readonly<Record<K, string>>,
    private readonly fetchBytes: FetchBytes = browserFetchBytes,
  ) {}

  status(key: K): SampleStatus {
    return this.states.get(key) ?? 'idle'
  }

  statuses(): Record<K, SampleStatus> {
    const out = {} as Record<K, SampleStatus>
    for (const key of Object.keys(this.urls) as K[]) out[key] = this.status(key)
    return out
  }

  /** The decoded sound, or null while it loads, after it failed, or before load() ran. */
  get(key: K): AudioBuffer | null {
    return this.buffers.get(key) ?? null
  }

  /** Start loading every file (only the first call does anything). Resolves when all are ready or failed. */
  load(decoder: SampleDecoder): Promise<void> {
    if (this.loading) return this.loading
    const keys = Object.keys(this.urls) as K[]
    for (const key of keys) this.states.set(key, 'loading')
    this.loading = Promise.all(keys.map((key) => this.loadOne(key, decoder))).then(() => undefined)
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

  private async loadOne(key: K, decoder: SampleDecoder): Promise<void> {
    try {
      const bytes = await this.fetchBytes(this.urls[key])
      const buffer = await decoder.decodeAudioData(bytes)
      this.buffers.set(key, buffer)
      this.states.set(key, 'ready')
    } catch {
      this.states.set(key, 'failed')
    }
  }
}
