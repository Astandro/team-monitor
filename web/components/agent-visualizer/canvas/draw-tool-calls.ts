import { ToolCallNode } from '@/lib/agent-types'
import { COLORS, withAlpha } from '@/lib/colors'
import { TOOL_MAX_CARD_W, TOOL_DRAW } from '@/lib/canvas-constants'
import { toolLabel } from '@/lib/readable-labels'
import { toolCardHeight, toolCardText } from '@/lib/tool-card-text'
import { truncateText } from './draw-misc'
import { measureTextCached } from './render-cache'

export function drawToolCalls(
  ctx: CanvasRenderingContext2D,
  toolCalls: Map<string, ToolCallNode>,
  time: number,
  selectedToolCallId?: string | null,
) {
  for (const [id, tool] of toolCalls) {
    const isRunning = tool.state === 'running'
    const isError = tool.state === 'error'
    const pulse = isRunning ? Math.sin(time * 4) * 0.2 + 0.8 : isError ? Math.sin(time * 6) * 0.15 + 0.85 : 0.5

    ctx.save()
    ctx.globalAlpha = tool.opacity

    // Compact card by design (owner request O3): readable label; shell commands show their action (setup such as
    // `cd <dir> &&` dropped) and long text is shortened in the middle (lib/tool-card-text.ts). The full text is one
    // tap away in the tool detail popup.
    const mainFont = `${TOOL_DRAW.fontSize}px monospace`
    const topFont = `${TOOL_DRAW.tokenFontSize}px monospace`
    const measureIn = (font: string) => (s: string) => { ctx.font = font; return measureTextCached(ctx, s) }
    const card = toolCardText(tool, TOOL_MAX_CARD_W, measureIn(mainFont), measureIn(topFont))
    ctx.font = mainFont
    const cardW = card.width
    const cardH = toolCardHeight(tool, card, TOOL_DRAW.collapsedHeight, TOOL_DRAW.expandedHeight)
    const cardX = tool.x - cardW / 2
    const cardY = tool.y - cardH / 2

    const isSelected = id === selectedToolCallId

    // Error glow
    if (isError) {
      ctx.shadowColor = COLORS.error
      ctx.shadowBlur = TOOL_DRAW.errorGlowBase + Math.sin(time * 6) * TOOL_DRAW.errorGlowPulse
    }

    ctx.beginPath()
    ctx.roundRect(cardX, cardY, cardW, cardH, TOOL_DRAW.borderRadius)
    ctx.fillStyle = isError
      ? withAlpha(COLORS.toolCardErrorBase, 0.8 * pulse)
      : isSelected ? withAlpha(COLORS.toolCardSelectedBase, 0.15 * pulse) : withAlpha(COLORS.toolCardBase, 0.7 * pulse)
    ctx.fill()
    ctx.strokeStyle = isError
      ? COLORS.error + '90'
      : isSelected ? COLORS.holoBase + 'aa' : isRunning ? COLORS.tool + '60' : COLORS.return + '40'
    ctx.lineWidth = isError ? 2 : isSelected ? 1.5 : 1
    ctx.stroke()

    ctx.shadowBlur = 0

    // Spinning ring
    if (isRunning) {
      ctx.beginPath()
      ctx.arc(tool.x, tool.y, Math.max(cardW, cardH) / 2 + TOOL_DRAW.spinRingPadding, time * TOOL_DRAW.spinSpeed, time * TOOL_DRAW.spinSpeed + TOOL_DRAW.spinArc)
      ctx.strokeStyle = COLORS.tool + '50'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Crack lines for errors
    if (isError) {
      ctx.save()
      ctx.strokeStyle = COLORS.error + '40'
      ctx.lineWidth = 0.8
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5
        ctx.beginPath()
        ctx.moveTo(tool.x, tool.y)
        ctx.lineTo(tool.x + Math.cos(a) * cardW * 0.5, tool.y + Math.sin(a) * cardH * 0.6)
        ctx.stroke()
      }
      ctx.restore()
    }

    const truncatedLabel = card.main

    ctx.font = mainFont
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    if (card.top) {
      // Shell command: small label line (folder in a softer tone, tokens once done), the action below it
      ctx.font = topFont
      const topY = tool.y - TOOL_DRAW.twoLineOffset
      if (card.topDir) {
        const [head, tail] = [card.top.slice(0, card.top.indexOf(card.topDir)), card.top.slice(card.top.indexOf(card.topDir) + card.topDir.length)]
        const wHead = measureTextCached(ctx, head)
        const wDir = measureTextCached(ctx, card.topDir)
        const wTail = measureTextCached(ctx, tail)
        let x = tool.x - (wHead + wDir + wTail) / 2
        ctx.textAlign = 'left'
        ctx.fillStyle = COLORS.tool + 'cc'
        ctx.fillText(head, x, topY); x += wHead
        ctx.fillStyle = COLORS.tool + '90'
        ctx.fillText(card.topDir, x, topY); x += wDir
        ctx.fillStyle = COLORS.tool + 'cc'
        ctx.fillText(tail, x, topY)
        ctx.textAlign = 'center'
      } else {
        ctx.fillStyle = COLORS.tool + 'cc'
        ctx.fillText(card.top, tool.x, topY)
      }
      ctx.font = mainFont
      ctx.fillStyle = isRunning ? COLORS.tool : COLORS.return
      ctx.fillText(card.main, tool.x, tool.y + TOOL_DRAW.twoLineOffset)
    } else if (isRunning) {
      ctx.fillStyle = COLORS.tool
      ctx.fillText(truncatedLabel, tool.x, tool.y)
    } else if (isError) {
      ctx.fillStyle = COLORS.error
      ctx.fillText(truncateText(ctx, `${toolLabel(tool.toolName)}: gagal`, cardW - 8), tool.x, tool.y - TOOL_DRAW.twoLineOffset)
      ctx.font = `${TOOL_DRAW.errorFontSize}px monospace`
      ctx.fillStyle = COLORS.error + 'aa'
      ctx.fillText(truncateText(ctx, tool.errorMessage || tool.result || '', cardW - 8), tool.x, tool.y + TOOL_DRAW.twoLineOffset + 2)
    } else {
      // Completed card: show action + file path (most useful info at a glance)
      ctx.fillStyle = COLORS.return
      ctx.fillText(truncatedLabel, tool.x, tool.y - TOOL_DRAW.twoLineOffset)
      if (tool.tokenCost) {
        // Token cost as dim text below
        ctx.fillStyle = COLORS.tool + '90'
        ctx.font = `${TOOL_DRAW.tokenFontSize}px monospace`
        ctx.fillText(`${tool.tokenCost} token`, tool.x, tool.y + TOOL_DRAW.twoLineOffset + 2)
      }
    }

    ctx.restore()
  }
}
