// Where the chat with the coordinator lives (spec-chat-layout, owner 13 Nov). Pure, so the switch is tested.
//
// Below 1024 px: a third tab in the bottom bar (Tim / Grafik / Chat), one pane at a time.
// From 1024 px: a chat panel docked on the right of the graph, opened from a bubble at the bottom right. The graph keeps
// its own area (the panel takes a column, the graph re-fits once), so the panel never covers the graph's controls or
// its play bar. Open/closed and the panel height are remembered per browser.

export const DESKTOP_MIN_WIDTH = 1024

export type Pane = 'tim' | 'grafik' | 'chat'

export type ChatPlacement = 'tab' | 'panel'

export function chatPlacement(desktop: boolean): ChatPlacement {
  return desktop ? 'panel' : 'tab'
}

/** Bottom bar tabs, left to right (phone and tablet only; desktop has no bottom bar). */
export function navTabs(desktop: boolean): Pane[] {
  return desktop ? [] : ['tim', 'grafik', 'chat']
}

export const TAB_LABEL: Record<Pane, string> = { tim: 'Tim', grafik: 'Grafik', chat: 'Chat' }

/**
 * The chat is on screen: the Chat tab on a phone or tablet, the open panel on desktop; never while the page itself is
 * in the background. Unread replies are cleared only while this is true.
 */
export function chatOnScreen(v: { desktop: boolean; pane: Pane; panelOpen: boolean; pageVisible: boolean }): boolean {
  if (!v.pageVisible) return false
  return v.desktop ? v.panelOpen : v.pane === 'chat'
}

/** The pane shown when the width changes: on desktop the Chat tab does not exist, so it falls back to Tim. */
export function paneForWidth(pane: Pane, desktop: boolean): Pane {
  return desktop && pane === 'chat' ? 'tim' : pane
}

export const CHAT_OPEN_KEY = 'tm-chat-open'
export const CHAT_HEIGHT_KEY = 'tm-chat-height'

/** Closed until the owner opens it once; then remembered. */
export function parseChatOpen(raw: string | null | undefined): boolean {
  return raw === '1'
}

export function storeChatOpen(open: boolean): string {
  return open ? '1' : '0'
}

/** Smallest panel that still shows a few messages and the message box. */
export const CHAT_MIN_HEIGHT = 320
/** Arrow keys on the resize handle move it by this much. */
export const CHAT_HEIGHT_STEP = 40

/**
 * Panel height in px inside the column (`available` = the column's inner height). Null (never resized) = the full
 * column. Clamped to [CHAT_MIN_HEIGHT, available]; a column shorter than the minimum gets the whole column.
 */
export function clampChatHeight(h: number | null, available: number): number {
  const max = Math.max(0, Math.floor(available))
  if (h === null || !Number.isFinite(h)) return max
  if (max <= CHAT_MIN_HEIGHT) return max
  return Math.round(Math.min(max, Math.max(CHAT_MIN_HEIGHT, h)))
}

export function parseChatHeight(raw: string | null | undefined): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}
