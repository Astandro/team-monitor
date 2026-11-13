/**
 * Graph palette built from the team panel's tokens (team-panel.css, `.tm-themed`), so the graph and the panel read
 * as one app (owner direction 13 Nov): Terang = mostly white, ink nodes, blue accent for everything interactive or
 * active; Gelap = a near-black night sky with dark grey cards just above it. Status colours keep their meaning
 * (running = accent, tool = amber, done = green, error = red). The background particles (soft blue dust in Terang,
 * white and gold stars in Gelap) live in sky.ts.
 *
 * Contract kept from the upstream palette: every key that was a 6-digit hex stays a 6-digit hex (callers append a
 * 2-digit alpha, e.g. `COLORS.idle + '40'`), `*Base` keys are partial `rgba(r, g, b,` strings.
 */

export type GraphTheme = 'light' | 'dark'

/** The panel's tokens, copied from team-panel.css (a test keeps them in sync). `slate` is the graph's one extra hue,
 *  a muted violet kept apart from the blue accent, for reasoning (thinking bubbles, reasoning tokens). */
export interface PanelTokens {
  bg: string; surface: string; sunk: string; ink: string; muted: string; line: string
  accent: string; done: string; review: string; blocked: string
  slate: string; errorSurface: string
}

export const PANEL_TOKENS: Record<GraphTheme, PanelTokens> = {
  light: {
    bg: '#F4F7FC', surface: '#FFFFFF', sunk: '#EAF0F8', ink: '#16202F', muted: '#506079', line: '#D9E1EE',
    accent: '#1E5FD0', done: '#1F7046', review: '#8A5A0B', blocked: '#B3261E',
    slate: '#5A4FA0', errorSurface: '#FBE3E1',
  },
  dark: {
    bg: '#05060A', surface: '#16171D', sunk: '#1E2026', ink: '#ECEEF2', muted: '#A2A8B4', line: '#2D3038',
    accent: '#79AEFF', done: '#6FCF97', review: '#EDBB5C', blocked: '#F4897E',
    slate: '#B7AEF0', errorSurface: '#3A1A18',
  },
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = rgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** Partial rgba for the `withAlpha(base, a)` callers. */
function base(hex: string): string {
  const [r, g, b] = rgb(hex)
  return `rgba(${r}, ${g}, ${b},`
}

/** Full graph palette for one theme. Keys match the upstream COLORS object. */
export function graphPalette(theme: GraphTheme) {
  const t = PANEL_TOKENS[theme]
  const dark = theme === 'dark'
  return {
    // Background
    void: t.bg,
    hexGrid: t.line,

    // Ink for structure, accent for activity
    holoBase: t.muted,
    holoBright: t.ink,
    holoHot: dark ? '#FFFFFF' : t.ink,

    // Agent states
    idle: t.ink,
    thinking: t.accent,
    tool_calling: t.review,
    complete: t.done,
    error: t.blocked,
    paused: t.muted,
    waiting_permission: t.review,

    // Edges and particles
    dispatch: t.muted,
    return: t.done,
    tool: t.review,
    message: t.accent,

    // Context breakdown
    contextSystem: t.muted,
    contextUser: t.accent,
    contextToolResults: t.review,
    contextReasoning: t.slate,
    contextSubagent: t.done,

    // UI chrome
    nodeInterior: rgba(t.surface, dark ? 0.75 : 0.92),
    textPrimary: t.ink,
    textDim: t.muted,
    textMuted: t.muted,

    // Glass card (solid enough to read, no blur look)
    glassBg: rgba(t.surface, 0.96),
    glassBorder: t.line,
    glassHighlight: rgba(t.accent, 0.06),

    holoBg03: rgba(t.ink, 0.03),
    holoBg05: rgba(t.ink, 0.05),
    holoBg10: rgba(t.ink, 0.08),
    holoBorder06: rgba(t.ink, 0.08),
    holoBorder08: rgba(t.ink, 0.1),
    holoBorder10: rgba(t.ink, 0.12),
    holoBorder12: rgba(t.ink, 0.16),

    // Panel chrome
    panelBg: rgba(t.surface, 0.96),
    panelSeparator: t.line,

    // Toggle buttons
    toggleActive: rgba(t.accent, dark ? 0.16 : 0.14),
    toggleInactive: rgba(t.ink, 0.03),
    toggleBorder: t.line,

    // Live indicator
    liveDot: t.blocked,
    liveText: t.blocked,
    liveResumeBg: rgba(t.blocked, 0.12),
    liveResumeBorder: rgba(t.blocked, 0.4),

    // Discovery types
    discoveryFile: t.accent,
    discoveryPattern: t.slate,
    discoveryFinding: t.done,
    discoveryCode: t.review,

    // Session tabs
    tabSelectedBg: rgba(t.accent, dark ? 0.16 : 0.14),
    tabInactiveBg: t.surface,
    tabSelectedBorder: rgba(t.accent, 0.5),
    tabInactiveBorder: t.line,
    tabClose: t.blocked,

    // Message roles
    roleAssistantBg: rgba(t.accent, 0.08),
    roleAssistantBgSelected: rgba(t.accent, 0.16),
    roleAssistantText: t.accent,
    roleThinkingBg: rgba(t.slate, 0.08),
    roleThinkingBgSelected: rgba(t.slate, 0.16),
    roleThinkingText: t.slate,
    roleUserBg: rgba(t.review, 0.08),
    roleUserBgSelected: rgba(t.review, 0.16),
    roleUserText: t.review,

    resultBg: rgba(t.done, 0.06),
    resultBorder: rgba(t.done, 0.2),

    unreadDot: t.blocked,

    // Play button and scrubber: flat accent, no glow
    playBtnBg: rgba(t.accent, 0.12),
    playBtnActiveBg: rgba(t.accent, 0.22),
    playBtnBorder: rgba(t.accent, 0.5),
    playBtnGlow: 'none',
    scrubberFill: `linear-gradient(90deg, ${rgba(t.accent, 0.55)}, ${rgba(t.accent, 0.55)})`,
    scrubberHeadGlow: `0 0 0 2px ${rgba(t.accent, 0.25)}`,
    reviewBtnBorder: rgba(t.accent, 0.4),

    costActiveBg: rgba(t.done, 0.15),

    // Canvas partial rgba bases
    bubbleThinkingBase: base(t.slate),
    bubbleUserBase: base(t.review),
    bubbleAssistantBase: base(t.accent),
    toolCardErrorBase: base(t.errorSurface),
    toolCardSelectedBase: base(t.accent),
    toolCardBase: base(t.surface),

    // Canvas cards
    cardBgDark: rgba(t.surface, 0.94),
    cardBg: rgba(t.surface, 0.85),
    cardBgSelected: rgba(t.surface, 0.97),
    cardBgError: rgba(t.errorSurface, 0.94),
    cardBgSelectedHolo: rgba(t.accent, 0.14),
    cardBgFaintOverlay: 'rgba(0, 0, 0, 0.01)',

    // Active tool indicator
    toolIndicatorBg: rgba(t.review, 0.1),
    toolIndicatorBorder: rgba(t.review, 0.3),
    toolIndicatorText: t.review,

    // Cost labels
    costText: t.done,
    costTextDim: t.muted,
    costPillBg: rgba(t.surface, 0.94),
    costPillStroke: rgba(t.done, 0.4),
    barFillMain: rgba(t.accent, 0.18),
    barFillSub: rgba(t.slate, 0.18),

    // Transcript / message feed
    userMsgBg: rgba(t.review, 0.07),
    userMsgBorder: rgba(t.review, 0.2),
    userLabel: t.review,
    userText: t.ink,
    assistantLabel: t.accent,
    assistantText: t.ink,
    thinkingBgExpanded: rgba(t.slate, 0.07),
    thinkingBgCollapsed: rgba(t.slate, 0.04),
    thinkingBorder: rgba(t.slate, 0.16),
    thinkingLabel: t.slate,
    thinkingArrow: t.slate,
    thinkingPreview: t.slate,
    thinkingTextExpanded: t.muted,
    thinkingBorderLeft: rgba(t.slate, 0.3),
    toolCallBg: rgba(t.review, 0.06),
    toolCallBorder: rgba(t.review, 0.16),
    bashResultBg: t.sunk,
    toolResultBg: rgba(t.done, 0.05),
    bashResultBorder: rgba(t.review, 0.16),
    toolResultBorder: rgba(t.done, 0.16),
    bashResultText: t.muted,
    toolResultText: t.done,
    textFaint: t.muted,
    searchHighlightBg: rgba(t.review, 0.3),

    // Diff / code
    codeBlockBg: t.sunk,
    diffRemoved: t.blocked,
    diffRemovedBg: rgba(t.blocked, 0.1),
    diffAdded: t.done,
    diffAddedBg: rgba(t.done, 0.1),

    // Tool content
    filePathActive: t.accent,
    filePathInactive: t.muted,
    todoCompleted: t.done,
    todoCompletedText: t.done,
    todoPending: t.muted,
    contentDim: t.muted,
    searchIcon: t.muted,

    // Panel header text
    panelLabel: t.muted,
    panelLabelDim: t.muted,
    scrollBtnText: t.accent,
    scrollbarThumb: rgba(t.ink, 0.2),
  }
}

export type GraphPalette = ReturnType<typeof graphPalette>

// ─── Contrast helpers (also used by the tests) ───────────────────────────────

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
