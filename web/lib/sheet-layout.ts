/**
 * Agent details on phones and tablets (owner screenshot 13 Nov): tapping a node opened the floating detail card and
 * the chat panel at once; they covered each other, the nodes and the play bar, and text ran off the edges. Below the
 * desktop breakpoint they become one bottom sheet: full width, above the play bar, below the top controls, at most
 * 70% of the graph's height, its own scroll; the detail first, the transcript one tap away in the same sheet.
 * Pure: the sheet component (web/components/agent-visualizer/agent-sheet.tsx) reads these numbers.
 */

/** Same breakpoint as the team panel's Tim/Grafik switch */
export const SHEET_MAX_VIEWPORT = 1024

export const SHEET = {
  /** Screen px from the bottom of the graph to the top of the play bar plus a gap */
  bottom: 88,
  /** Gap kept under the top controls */
  gapTop: 8,
  /** Share of the graph's height the sheet may take */
  maxShare: 0.7,
  /** Never shorter than this, even on a very short screen (it then scrolls inside) */
  minHeight: 160,
  side: 8,
} as const

export function isSheetLayout(viewportWidth: number): boolean {
  return viewportWidth > 0 && viewportWidth < SHEET_MAX_VIEWPORT
}

/** Tallest the sheet may be in a graph `paneHeight` px tall whose top `topReserve` px hold the controls. */
export function sheetMaxHeight(paneHeight: number, topReserve: number): number {
  const free = paneHeight - Math.max(0, topReserve) - SHEET.gapTop - SHEET.bottom
  return Math.max(SHEET.minHeight, Math.floor(Math.min(paneHeight * SHEET.maxShare, free)))
}

export type SheetView = 'detail' | 'transcript'

/** Which view a sheet shows after `event`: a new agent always starts at its detail. */
export function nextSheetView(current: SheetView, event: 'open-transcript' | 'back' | 'agent-changed'): SheetView {
  if (event === 'open-transcript') return 'transcript'
  return 'detail'
}
