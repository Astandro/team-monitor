/**
 * The "disintegrating" alert tag (owner correction 13 Nov, item 4a): a red tint with a matching border and dark-red
 * (light theme) or pale-red (dark theme) text. It pulses between `bg` and `bgHi`; the text colour never changes and
 * reads at 4.5:1 or more on both (tested). The same values live in team-panel.css (`--alert-*`, a test keeps them in
 * sync) and are drawn on the canvas by draw-agents.ts. `groupBg` tints the panel's "Disintegrating" group.
 */
import type { GraphTheme } from './graph-palette'

export interface AlertTokens {
  ink: string
  bg: string
  bgHi: string
  line: string
  groupBg: string
}

export const ALERT_TOKENS: Record<GraphTheme, AlertTokens> = {
  light: { ink: '#9B1C14', bg: '#FBE3E1', bgHi: '#F6C9C4', line: '#B3261E', groupBg: '#FCEDEB' },
  dark: { ink: '#FFD7D2', bg: '#4A1B17', bgHi: '#6B2620', line: '#F4897E', groupBg: '#2A1A1A' },
}

function channel(hex: string, i: number): number {
  return parseInt(hex.replace('#', '').slice(i * 2, i * 2 + 2), 16)
}

/** Linear mix of two #RRGGBB colours, t = 0 -> a, 1 -> b. */
export function mixHex(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t))
  const out = [0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * k))
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}
