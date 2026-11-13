import { useSyncExternalStore } from 'react'
import { graphThemeVersion, subscribeGraphTheme } from '@/lib/colors'

/** Re-render when the graph palette changes. Returns a counter that changes with every theme switch, usable as a
 *  dependency for effects that draw with COLORS. */
export function useGraphTheme(): number {
  return useSyncExternalStore(subscribeGraphTheme, graphThemeVersion, graphThemeVersion)
}
