// One mute and one volume for the whole monitor (graph and team panel), remembered in localStorage.
// Pure apart from the injected storage and engine, so it is unit tested (settings.test.ts).

import { SOUND_PREF_KEY } from '../canvas-constants'

/** Kept from upstream so a choice made before this change survives: 'on' means sound on. */
export const SOUND_MUTE_KEY = SOUND_PREF_KEY
export const SOUND_VOLUME_KEY = `${SOUND_PREF_KEY}-volume`
/**
 * Marks a stored volume as a slider value for the squared gain (volumeGain). A volume stored without it was written
 * by 0.9.6 or earlier, where the value was the gain itself; it is migrated once on load (migrateStoredVolume).
 */
export const SOUND_VOLUME_SCALE_KEY = `${SOUND_PREF_KEY}-volume-scale`
export const VOLUME_SCALE_SQUARED = 'squared'
/** Volume of a fresh profile (spec 0.9.7); a volume stored before keeps the gain the user heard (migrateStoredVolume). */
export const DEFAULT_VOLUME = 0.7

/**
 * The gain a slider value gives: value squared, so the slider follows loudness more evenly than a linear gain
 * (0.5 -> 0.25, about -12 dB; 0.7 -> 0.49, about -6 dB).
 */
export function volumeGain(volume: number): number {
  const v = clampVolume(volume)
  return v * v
}

export interface SoundSettings {
  muted: boolean
  /** 0..1 */
  volume: number
}

/** Anything but an explicit 'on' is muted: muted is the default. */
export function parseMuted(raw: string | null): boolean {
  return raw !== 'on'
}

export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_VOLUME
  return Math.min(1, Math.max(0, v))
}

export function parseVolume(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_VOLUME
  return clampVolume(Number(raw))
}

/**
 * The slider value for a stored volume. Up to 0.9.6 the stored value was the gain; since 0.9.7 the gain is the
 * value squared, so an unmarked value becomes sqrt(old), which plays at the gain the user had (F9). `migrate` says
 * whether the value and the marker must be written back. Nothing stored: the fresh default, nothing to write.
 */
export function migrateStoredVolume(raw: string | null, scale: string | null): { volume: number; migrate: boolean } {
  if (raw === null || raw.trim() === '') return { volume: DEFAULT_VOLUME, migrate: false }
  const stored = Number(raw)
  if (!Number.isFinite(stored)) return { volume: DEFAULT_VOLUME, migrate: false }
  if (scale === VOLUME_SCALE_SQUARED) return { volume: clampVolume(stored), migrate: false }
  return { volume: Math.sqrt(clampVolume(stored)), migrate: true }
}

/** What the store needs from localStorage; every call may throw (private windows, blocked site data). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** What the store needs from the audio engine. */
export interface SoundOutput {
  setMuted(muted: boolean): void
  setVolume(volume: number): void
}

function safeGet(storage: (() => StorageLike | null) | undefined, key: string): string | null {
  try {
    return storage?.()?.getItem(key) ?? null
  } catch {
    return null
  }
}

function safeSet(storage: (() => StorageLike | null) | undefined, key: string, value: string): void {
  try {
    storage?.()?.setItem(key, value)
  } catch {
    /* the setting is simply not remembered */
  }
}

/** Shared settings with change listeners (useSyncExternalStore-compatible). */
export class SoundSettingsStore {
  private state: SoundSettings
  private listeners = new Set<() => void>()

  constructor(
    private readonly storage?: () => StorageLike | null,
    private readonly output?: SoundOutput,
  ) {
    const stored = migrateStoredVolume(safeGet(storage, SOUND_VOLUME_KEY), safeGet(storage, SOUND_VOLUME_SCALE_KEY))
    if (stored.migrate) this.persistVolume(stored.volume)
    this.state = {
      muted: parseMuted(safeGet(storage, SOUND_MUTE_KEY)),
      volume: stored.volume,
    }
    output?.setVolume(this.state.volume)
    output?.setMuted(this.state.muted)
  }

  get = (): SoundSettings => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setMuted(muted: boolean): void {
    if (muted === this.state.muted) return
    this.state = { ...this.state, muted }
    this.output?.setMuted(muted)
    safeSet(this.storage, SOUND_MUTE_KEY, muted ? 'off' : 'on')
    this.emit()
  }

  toggleMuted(): boolean {
    this.setMuted(!this.state.muted)
    return this.state.muted
  }

  setVolume(volume: number): void {
    const v = clampVolume(volume)
    if (v === this.state.volume) return
    this.state = { ...this.state, volume: v }
    this.output?.setVolume(v)
    this.persistVolume(v)
    this.emit()
  }

  /** The marker goes first: if only it is written, the old value stays quieter rather than being migrated twice. */
  private persistVolume(v: number): void {
    safeSet(this.storage, SOUND_VOLUME_SCALE_KEY, VOLUME_SCALE_SQUARED)
    safeSet(this.storage, SOUND_VOLUME_KEY, String(v))
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}
