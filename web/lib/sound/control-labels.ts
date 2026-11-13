/** Words for the graph's one sound control: what it is now and what a tap does. */
export function soundButtonLabel(muted: boolean): string {
  return muted ? 'Suara mati. Ketuk untuk nyalakan' : 'Suara nyala. Ketuk untuk matikan'
}

/** Stored volume (0..1) as the slider's whole percent, clamped. */
export function volumePercent(volume: number): number {
  if (!Number.isFinite(volume)) return 0
  return Math.round(Math.min(1, Math.max(0, volume)) * 100)
}
