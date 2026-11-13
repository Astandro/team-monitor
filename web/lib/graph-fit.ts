/**
 * How the graph frames itself (owner feedback 13 Nov, phone Grafik view).
 *
 * Wide graph (>= 640 px): as upstream, every node with its bubbles, tool cards and discoveries, generous padding,
 * scale up to 2; the frame keeps clear of the control bar at the bottom and of the top bars.
 * Compact graph (< 640 px, a phone): frame the Orchestrator and the sub-agents still at work, nodes only (no
 * bubbles, tool cards or discoveries), small padding, inside the area left free by the one-row top controls and the
 * bottom control bar, at a readable scale (0.8 to 1.25). Finished sub-agents may sit past the edge; pinch and drag
 * still reach them. When no sub-agent is at work the frame takes every node, still tight.
 * Pure: the camera (web/hooks/use-canvas-camera.ts) feeds it boxes and reads the transform.
 */

export const COMPACT_GRAPH_MAX_WIDTH = 640

export const FIT = {
  widePadding: 120,
  compactPadding: 36,
  wideMaxScale: 2,
  compactMaxScale: 1.25,
  /** Below this the names under the hexagons get too small to read on a phone */
  compactMinScale: 0.8,
  minUsableHeight: 120,
} as const

export function isCompactGraph(width: number): boolean {
  return width > 0 && width < COMPACT_GRAPH_MAX_WIDTH
}

export interface FitAgent {
  isMain: boolean
  state: string
  finished?: unknown
  opacity: number
}

/** Is this sub-agent still at work (not complete, not marked finished by the server)? */
export function isCurrentAgent(a: FitAgent): boolean {
  return !a.isMain && a.state !== 'complete' && !a.finished && a.opacity > 0.1
}

/**
 * Which agents the compact frame holds: the main agent(s) and the current sub-agents; every visible node when no
 * sub-agent is at work. Wide frames hold every agent (returns null = no filter).
 */
export function compactFocus<T extends FitAgent>(agents: Iterable<[string, T]>, compact: boolean): Set<string> | null {
  if (!compact) return null
  const list = [...agents]
  const current = list.filter(([, a]) => isCurrentAgent(a))
  if (current.length === 0) return new Set(list.filter(([, a]) => a.isMain || a.opacity > 0.1).map(([id]) => id))
  return new Set([...list.filter(([, a]) => a.isMain).map(([id]) => id), ...current.map(([id]) => id)])
}

export interface Box {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface FitInsets {
  /** Screen px at the top taken by controls */
  top: number
  /** Screen px at the bottom taken by the control bar */
  bottom: number
}

export interface CameraTransform {
  x: number
  y: number
  scale: number
}

export function fitTransform(box: Box, dims: { width: number; height: number }, insets: FitInsets, compact: boolean): CameraTransform {
  const padding = compact ? FIT.compactPadding : FIT.widePadding
  const boundsW = box.maxX - box.minX + padding * 2
  const boundsH = box.maxY - box.minY + padding * 2
  const top = Math.max(0, insets.top)
  const usableH = Math.max(dims.height - top - Math.max(0, insets.bottom), FIT.minUsableHeight)
  let scale = Math.min(dims.width / boundsW, usableH / boundsH, compact ? FIT.compactMaxScale : FIT.wideMaxScale)
  if (compact) scale = Math.max(scale, FIT.compactMinScale)
  const cx = (box.minX + box.maxX) / 2
  const cy = (box.minY + box.maxY) / 2
  return { x: dims.width / 2 - cx * scale, y: top + usableH / 2 - cy * scale, scale }
}
