/**
 * Graph colour palette and role colour definitions.
 *
 * The values come from the team panel's tokens (see graph-palette.ts) and follow the page theme: `applyGraphTheme`
 * swaps them in place, so canvas code that reads `COLORS.x` every frame picks the new theme up on the next frame,
 * and React components that call `useGraphTheme()` re-render with it.
 * All colors are re-exported from agent-types.ts for backward compatibility.
 */

import type { AgentState, ContextBreakdown } from './agent-types'
import { graphPalette, PANEL_TOKENS, type GraphPalette, type GraphTheme } from './graph-palette'

let currentTheme: GraphTheme = 'dark'
let version = 0
const listeners = new Set<() => void>()

/** Live palette. Mutated in place by applyGraphTheme; read it at draw/render time, never cache a value. */
export const COLORS: GraphPalette = { ...graphPalette(currentTheme) }

// ─── Role Colors (message feed & bubbles) ───────────────────────────────────

type RoleColor = { bg: string; bgSelected: string; text: string; label: string }

function roleColors(): Record<string, RoleColor> {
  return {
    assistant: { bg: COLORS.roleAssistantBg, bgSelected: COLORS.roleAssistantBgSelected, text: COLORS.roleAssistantText, label: 'CLAUDE' },
    thinking:  { bg: COLORS.roleThinkingBg,  bgSelected: COLORS.roleThinkingBgSelected,  text: COLORS.roleThinkingText,  label: 'BERPIKIR' },
    user:      { bg: COLORS.roleUserBg,       bgSelected: COLORS.roleUserBgSelected,       text: COLORS.roleUserText,       label: 'PENGGUNA' },
  }
}

export const ROLE_COLORS: Record<string, RoleColor> = roleColors()

/** Switch the graph to a theme. No-op when it is already active. */
export function applyGraphTheme(theme: GraphTheme): void {
  if (theme === currentTheme) return
  currentTheme = theme
  Object.assign(COLORS, graphPalette(theme))
  Object.assign(ROLE_COLORS, roleColors())
  version++
  for (const l of listeners) l()
}

/**
 * A colour that was stored earlier (timeline blocks keep the colour they were created with), mapped onto the
 * current theme: a panel token of either theme becomes the same token of the active one. Anything else is kept.
 */
export function liveColor(color: string): string {
  const key = color.toUpperCase()
  for (const theme of ['light', 'dark'] as const) {
    const tokens = PANEL_TOKENS[theme]
    for (const name of Object.keys(tokens) as (keyof typeof tokens)[]) {
      if (tokens[name] === key) return PANEL_TOKENS[currentTheme][name]
    }
  }
  return color
}

export function getGraphTheme(): GraphTheme {
  return currentTheme
}

/** Bloom adds light with 'lighter' compositing: right on a dark canvas, it washes a bone-white one out. */
export function graphBloomEnabled(): boolean {
  return currentTheme === 'dark'
}

/** For useSyncExternalStore: subscribe to theme changes; the snapshot is a counter. */
export function subscribeGraphTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function graphThemeVersion(): number {
  return version
}

// ─── Color Helper Functions ──────────────────────────────────────────────────

export function getStateColor(state: AgentState): string {
  switch (state) {
    case 'idle': return COLORS.idle
    case 'thinking': return COLORS.thinking
    case 'tool_calling': return COLORS.tool_calling
    case 'complete': return COLORS.complete
    case 'error': return COLORS.error
    case 'paused': return COLORS.paused
    case 'waiting_permission': return COLORS.waiting_permission
  }
}

export function getDiscoveryTypeColor(type: string): string {
  switch (type) {
    case 'file': return COLORS.discoveryFile
    case 'pattern': return COLORS.discoveryPattern
    case 'finding': return COLORS.discoveryFinding
    default: return COLORS.discoveryCode
  }
}

/** Safely combine a partial rgba base (e.g. 'rgba(10, 15, 30,') with an alpha value */
export function withAlpha(rgbaBase: string, alpha: number): string {
  return `${rgbaBase} ${alpha})`
}

/** Build the context-breakdown color segments for a given breakdown. */
export function contextSegments(bd: ContextBreakdown) {
  return [
    { value: bd.systemPrompt, color: COLORS.contextSystem },
    { value: bd.userMessages, color: COLORS.contextUser },
    { value: bd.toolResults, color: COLORS.contextToolResults },
    { value: bd.reasoning, color: COLORS.contextReasoning },
    { value: bd.subagentResults, color: COLORS.contextSubagent },
  ]
}
