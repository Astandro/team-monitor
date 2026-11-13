/**
 * What a tool-call card on the graph says, and how wide it is (drawing and hit-testing share this).
 *
 * Shell commands (owner screenshot 13 Nov): two lines. The small top line is the plain label ("Jalanin perintah"),
 * followed by the folder as a muted "di <folder>" only when it fits the card, and the token count once done; the
 * main line is the action itself (`npm test`, `git merge …`), shortened in the middle when it is still too long.
 * Other tools keep one line, "<label>: <args>", with the label whole and the args shortened in the middle.
 * The full command stays one tap away in the tool detail popup.
 */
import { toolLabel } from './readable-labels'
import { fitLabelLine, isCommandTool, middleTruncate, toolArgsDisplay } from './command-label'

export interface ToolCardInput {
  toolName: string
  args?: string
  inputData?: Record<string, unknown>
  state: 'running' | 'complete' | 'error'
  tokenCost?: number
}

export interface ToolCardText {
  /** Small muted line above the main one (shell commands only), else null */
  top: string | null
  /** Folder part of the top line, drawn in a softer tone ("di haze-commands"), else null */
  topDir: string | null
  /** Main line */
  main: string
  /** Card width, px at scale 1 */
  width: number
}

/** Narrowest card. */
export const TOOL_CARD_MIN_W = 60
/** Horizontal padding inside the card, both sides together. */
export const TOOL_CARD_PAD = 12

export function toolCardText(
  tool: ToolCardInput,
  maxWidth: number,
  measureMain: (s: string) => number,
  measureTop: (s: string) => number,
): ToolCardText {
  const inner = maxWidth - TOOL_CARD_PAD
  const label = toolLabel(tool.toolName)
  const shown = toolArgsDisplay(tool.toolName, tool.args, tool.inputData)

  if (!isCommandTool(tool.toolName) || !shown.action || tool.state === 'error') {
    const main = fitLabelLine(label, shown.action, inner, measureMain)
    return { top: null, topDir: null, main, width: clampWidth(measureMain(main) + TOOL_CARD_PAD, maxWidth) }
  }

  const main = middleTruncate(shown.action, inner, measureMain)
  const tokens = tool.state === 'complete' && tool.tokenCost ? ` · ${tool.tokenCost} token` : ''
  let top = label + tokens
  let topDir: string | null = null
  if (shown.dir) {
    const withDir = ` di ${shown.dir}`
    // the folder is extra: shown only if the whole top line still fits the widest card
    if (measureTop(label + withDir + tokens) <= inner) { topDir = withDir; top = label + withDir + tokens }
  }
  if (measureTop(top) > inner) top = middleTruncate(top, inner, measureTop)
  const width = clampWidth(Math.max(measureMain(main), measureTop(top)) + TOOL_CARD_PAD, maxWidth)
  return { top, topDir, main, width }
}

/** Card height: the taller size when there is a second line under the main one (tokens or an error). */
export function toolCardHeight(tool: ToolCardInput, card: ToolCardText, collapsed: number, expanded: number): number {
  if (card.top) return tool.state === 'complete' && tool.tokenCost ? expanded : collapsed
  return tool.state !== 'running' && (tool.tokenCost || tool.state === 'error') ? expanded : collapsed
}

function clampWidth(w: number, maxWidth: number): number {
  return Math.max(TOOL_CARD_MIN_W, Math.min(w, maxWidth))
}
