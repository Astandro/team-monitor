import { AGENT_DRAW, CONTEXT_BAR } from './canvas-constants'

/** Width of one character of the 10px monospace agent label. */
const LABEL_CHAR_W = 6

/**
 * How far below the agent centre its wrapped name reaches (world units).
 * An estimate for camera framing: it assumes the name wraps on spaces with some slack,
 * so it errs on the side of one extra line. The real drawing uses measured widths.
 */
export function agentLabelBottom(name: string, radius: number, hasContextBar: boolean): number {
  const maxW = Math.max(radius * AGENT_DRAW.labelWidthMultiplier, AGENT_DRAW.labelMinWidth)
  const perLine = Math.max(1, Math.floor(maxW / LABEL_CHAR_W))
  const lines = Math.max(1, Math.ceil(name.length / perLine) + (name.length > perLine ? 1 : 0))
  const top = hasContextBar
    ? radius + CONTEXT_BAR.yOffset + CONTEXT_BAR.barHeight + AGENT_DRAW.labelBelowBarGap
    : radius + AGENT_DRAW.labelYOffset
  return top + lines * AGENT_DRAW.labelLineHeight
}
