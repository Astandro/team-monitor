import { useSyncExternalStore } from 'react'
import {
  setSoundVolume,
  soundServerSnapshot,
  soundSnapshot,
  soundSubscribe,
  toggleSound,
} from '@/lib/sound/sound-client'

/** The page-wide mute and volume (same state in the graph's top bar and the team panel header). */
export function useSoundSettings() {
  const settings = useSyncExternalStore(soundSubscribe, soundSnapshot, soundServerSnapshot)
  return { muted: settings.muted, volume: settings.volume, toggle: toggleSound, setVolume: setSoundVolume }
}
