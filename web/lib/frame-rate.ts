/**
 * How often the graph canvas draws (owner, 13 Nov: the Tim tab was heavy on the phone).
 *
 * On a phone or tablet the Tim and Grafik panes are both mounted (the graph keeps its state) and the hidden one is
 * only `visibility: hidden`. The canvas used to keep drawing every display frame behind the Tim tab: stars, bloom,
 * nebula, labels, at the phone's full pixel ratio. That was most of the main thread's time while the owner read the
 * team list. Rule: the canvas draws every display frame only while it is on screen; when its pane is hidden (or the
 * whole page is in the background) it does not draw at all. The simulation itself keeps running, so the graph is
 * current the moment the Grafik tab opens.
 */

export type GraphFrameMode = 'every-frame' | 'paused'

export interface GraphVisibility {
  /** The graph pane is shown: the Grafik tab on a phone or tablet, always on desktop (panel column next to it). */
  paneVisible: boolean
  /** `document.visibilityState === 'visible'` (browsers already stop rAF in background tabs; this makes it explicit). */
  pageVisible: boolean
}

export function graphFrameMode(v: GraphVisibility): GraphFrameMode {
  return v.paneVisible && v.pageVisible ? 'every-frame' : 'paused'
}

/** Frames per second the canvas may draw at: Infinity means "every display frame", 0 means "not at all". */
export function graphFrameRate(v: GraphVisibility): number {
  return graphFrameMode(v) === 'every-frame' ? Infinity : 0
}

/**
 * Whether the graph pane is on screen in the standalone app: always from 1024 px (panel column + graph), below that
 * only while the Grafik tab is chosen (the Tim and Chat tabs hide it).
 */
export function graphPaneVisible(pane: 'tim' | 'grafik' | 'chat', desktop: boolean): boolean {
  return desktop || pane === 'grafik'
}

/**
 * Seconds to feed the animation clock for the first frame after a pause: one normal frame, never the length of the
 * pause (a minute behind the Tim tab must not fast-forward drifting stars or age every effect at once).
 */
export function resumeDelta(lastFrameAt: number, now: number, fallback: number): number {
  if (!lastFrameAt) return fallback
  const d = (now - lastFrameAt) / 1000
  return d > 0.25 || d < 0 ? fallback : d
}
