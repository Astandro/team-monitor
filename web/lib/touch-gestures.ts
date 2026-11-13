/**
 * Touch gestures on the graph (owner feedback 13 Nov, phone Grafik view): one finger pans, two fingers pinch-zoom
 * around the pinch centre, a double tap zooms in around the tapped point, a long press opens the node menu.
 * Pure camera math and tap timing; the canvas hook (web/hooks/use-canvas-interaction.ts) feeds it points in canvas
 * pixels (relative to the canvas' top-left corner) and stores the returned camera.
 *
 * Camera convention (same as the draw loop): screen = world * scale + (x, y).
 */

export interface Cam {
  x: number
  y: number
  scale: number
}

export interface Pt {
  x: number
  y: number
}

export interface TapMark {
  pt: Pt
  /** ms timestamp */
  t: number
}

export const GESTURE = {
  /** Same range as the mouse wheel (CAMERA in canvas-constants.ts) */
  minScale: 0.2,
  maxScale: 4,
  /** A finger that moved less than this (px) and lifted within tapMaxMs is a tap */
  tapSlopPx: 10,
  tapMaxMs: 350,
  /** Second tap within this time and distance of the first one is a double tap */
  doubleTapMs: 320,
  doubleTapSlopPx: 32,
  /** Double tap zooms in by this factor around the tapped point */
  doubleTapZoom: 1.8,
  /** Hold without moving this long for the node menu (right click on desktop) */
  longPressMs: 550,
} as const

export function clampScale(scale: number, min: number = GESTURE.minScale, max: number = GESTURE.maxScale): number {
  if (!Number.isFinite(scale)) return min
  return Math.min(max, Math.max(min, scale))
}

export function pan(cam: Cam, dx: number, dy: number): Cam {
  return { x: cam.x + dx, y: cam.y + dy, scale: cam.scale }
}

/** Zoom by `factor` keeping the world point under `centre` where it is on screen. Scale is clamped. */
export function zoomAround(cam: Cam, centre: Pt, factor: number, min: number = GESTURE.minScale, max: number = GESTURE.maxScale): Cam {
  const scale = clampScale(cam.scale * factor, min, max)
  const k = scale / cam.scale
  return { scale, x: centre.x - (centre.x - cam.x) * k, y: centre.y - (centre.y - cam.y) * k }
}

export function centroid(points: readonly Pt[]): Pt {
  if (points.length === 0) return { x: 0, y: 0 }
  let x = 0
  let y = 0
  for (const p of points) {
    x += p.x
    y += p.y
  }
  return { x: x / points.length, y: y / points.length }
}

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export interface PinchStart {
  cam: Cam
  centre: Pt
  dist: number
}

export function pinchStart(cam: Cam, a: Pt, b: Pt): PinchStart {
  return { cam, centre: centroid([a, b]), dist: Math.max(distance(a, b), 1) }
}

/**
 * Camera while two fingers move: the scale follows the finger spread (clamped), and the world point that was under
 * the starting pinch centre follows the current pinch centre (so pinching also pans, as on a map).
 */
export function pinchMove(start: PinchStart, a: Pt, b: Pt, min: number = GESTURE.minScale, max: number = GESTURE.maxScale): Cam {
  const c = centroid([a, b])
  const d = Math.max(distance(a, b), 1)
  const scale = clampScale(start.cam.scale * (d / start.dist), min, max)
  const wx = (start.centre.x - start.cam.x) / start.cam.scale
  const wy = (start.centre.y - start.cam.y) / start.cam.scale
  return { scale, x: c.x - wx * scale, y: c.y - wy * scale }
}

/** Did a finger that went down at `down` and lifted at `up` (no second finger in between) tap? */
export function isTap(down: TapMark, up: TapMark): boolean {
  return up.t - down.t <= GESTURE.tapMaxMs && distance(down.pt, up.pt) <= GESTURE.tapSlopPx
}

/** Is `tap` the second tap of a double tap whose first tap was `prev`? */
export function isDoubleTap(prev: TapMark | null, tap: TapMark): boolean {
  if (!prev) return false
  const dt = tap.t - prev.t
  return dt >= 0 && dt <= GESTURE.doubleTapMs && distance(prev.pt, tap.pt) <= GESTURE.doubleTapSlopPx
}

/** Camera after a double tap at `pt`: zoom in around it (clamped at the max). */
export function doubleTapZoom(cam: Cam, pt: Pt): Cam {
  return zoomAround(cam, pt, GESTURE.doubleTapZoom)
}

/** Has a held finger moved too far to still count as a tap or long press? */
export function movedPastSlop(down: Pt, now: Pt): boolean {
  return distance(down, now) > GESTURE.tapSlopPx
}
