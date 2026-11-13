/**
 * The "disintegrating" alert tag (owner correction 13 Nov, item 4a; translucent with a warning icon since the owner's
 * second pass): a see-through tint of the alert colour (`bg`, `bgHi` are #RRGGBBAA, 16-32% alpha of `line`) with a
 * matching solid border, dark-red (light theme) or pale-red (dark theme) text and a small warning triangle in front.
 * It pulses between `bg` and `bgHi`; the text colour never changes and reads at 4.5:1 or more on both, laid over every
 * surface it can sit on (tested). The same values live in team-panel.css (`--alert-*`, a test keeps them in sync) and
 * are drawn on the canvas by draw-agents.ts. `groupBg` tints the panel's "Disintegrating" group.
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
  light: { ink: '#9B1C14', bg: '#B3261E29', bgHi: '#B3261E42', line: '#B3261E', groupBg: '#FCEDEB' },
  dark: { ink: '#FFD7D2', bg: '#F4897E33', bgHi: '#F4897E52', line: '#F4897E', groupBg: '#2A1A1A' },
}

/** Warning triangle with an exclamation mark, drawn in the ink colour (SVG path data, viewBox 0 0 12 12). */
export const WARNING_ICON = {
  viewBox: '0 0 12 12',
  triangle: 'M6 1.4 L11.2 10.4 H0.8 Z',
  mark: 'M6 4.6 V7.2',
  dot: { cx: 6, cy: 8.85, r: 0.75 },
} as const

function channel(hex: string, i: number): number {
  const h = hex.replace('#', '')
  if (i === 3 && h.length < 8) return 255
  return parseInt(h.slice(i * 2, i * 2 + 2), 16)
}

function toHex(values: number[]): string {
  return `#${values.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/** Linear mix of two #RRGGBB or #RRGGBBAA colours, t = 0 -> a, 1 -> b. Keeps the alpha when either has one. */
export function mixHex(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t))
  const alpha = a.length > 7 || b.length > 7
  const out = (alpha ? [0, 1, 2, 3] : [0, 1, 2]).map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * k))
  return toHex(out)
}

/** Lowest opacity of the whole alert component at the bottom of a blink (owner, 13 Nov: the component blinks). */
export const ALERT_BLINK_MIN_ALPHA = 0.3

/**
 * Opacity of the whole alert component (pill, triangle and text together) for a pulse value 0..1: fully visible at
 * pulse 0 (also the static, reduced-motion state), fading to ALERT_BLINK_MIN_ALPHA at pulse 1.
 */
export function alertBlinkAlpha(pulse: number): number {
  const k = Math.min(1, Math.max(0, pulse))
  return 1 - (1 - ALERT_BLINK_MIN_ALPHA) * k
}

/** A #RRGGBBAA colour laid over an opaque #RRGGBB background: the opaque colour the eye sees. */
export function compositeOver(fg: string, bg: string): string {
  const a = channel(fg, 3) / 255
  return toHex([0, 1, 2].map((i) => Math.round(channel(fg, i) * a + channel(bg, i) * (1 - a))))
}
