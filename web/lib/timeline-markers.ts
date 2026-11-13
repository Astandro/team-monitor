/** Steps (seconds) a timeline axis may use, smallest first. */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]

/**
 * Pick the time-marker interval so labels never run together: the smallest step
 * whose neighbouring markers are at least `minPx` apart on screen.
 */
export function pickMarkerInterval(timeSpan: number, trackWidth: number, minPx = 44): number {
  const span = Math.max(timeSpan, 1)
  const width = Math.max(trackWidth, 1)
  for (const step of STEPS) {
    if ((step / span) * width >= minPx) return step
  }
  return STEPS[STEPS.length - 1]
}

/** Width of the name column: up to 150px, but never more than 40% of the panel (min 80). */
export function timelineLabelWidth(panelWidth: number): number {
  return Math.round(Math.min(150, Math.max(80, panelWidth * 0.4)))
}
