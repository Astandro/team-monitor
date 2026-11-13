/**
 * Panel layout rules (spec-panel-compact items 1, 3, 4, 5). Pure, so the order and the collapse rules are tested.
 */

/**
 * Section order under the header and the numbers (item 4). "Catatan terbaru" (the log) is gone (item 5): the graph
 * shows the same activity.
 */
export const SECTION_ORDER = [
  'stages', // Tahapan
  'live', // Lagi dikerjain
  'decisions', // Keputusan, open ones only
  'team', // Tim
  'chat', // Chat
  'queue', // Antrian dan yang sudah selesai
  'offboarded', // Selesai kontrak
  'answered', // answered decisions, collapsed
] as const

export type SectionKey = (typeof SECTION_ORDER)[number]

/** Sections to render, in order. The answered group only exists once something was answered. */
export function panelSections(answeredCount: number): SectionKey[] {
  return SECTION_ORDER.filter((k) => k !== 'answered' || answeredCount > 0)
}

/** Open decisions stay expanded in Keputusan; answered ones go to the collapsed group, both keeping their order. */
export function splitDecisions<T extends { open: boolean }>(decisions: T[]): { open: T[]; answered: T[] } {
  return { open: decisions.filter((d) => d.open), answered: decisions.filter((d) => !d.open) }
}

/** Summary line of the collapsed group (item 3): "3 sudah dijawab". */
export function answeredSummary(count: number): string {
  return `${count} sudah dijawab`
}

/** The whole answered group starts collapsed; nothing about it is remembered. */
export const ANSWERED_OPEN_BY_DEFAULT = false

/** localStorage key and value for "panel hidden on desktop" (item 1). */
export const PANEL_HIDDEN_KEY = 'tm-panel-hidden'

export function parsePanelHidden(raw: string | null | undefined): boolean {
  return raw === '1'
}

export function storePanelHidden(hidden: boolean): string {
  return hidden ? '1' : '0'
}

export interface KeyLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  repeat?: boolean
  defaultPrevented?: boolean
  /** The focused element: tag name and whether it is editable. */
  target?: { tagName?: string; isContentEditable?: boolean } | null
}

/**
 * `[` toggles the panel on desktop, unless the owner is typing (input, textarea, select, editable text), a modifier is
 * held (browser and OS shortcuts keep working), the key is auto-repeating, or someone else already handled it.
 */
export function isPanelToggleKey(e: KeyLike): boolean {
  if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return false
  const t = e.target
  if (t?.isContentEditable) return false
  const tag = (t?.tagName ?? '').toUpperCase()
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT'
}
