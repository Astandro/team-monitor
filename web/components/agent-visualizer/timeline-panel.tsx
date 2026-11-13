'use client'

import { useRef, useEffect, useMemo, useCallback } from 'react'
import { TimelineEntry, Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { formatTimelineModels } from '@/lib/timeline-models'
import { wrapText } from '@/lib/wrap-text'
import { PanelHeader, SlidingPanel } from './shared-ui'

interface TimelinePanelProps {
  visible: boolean
  timelineEntries: Map<string, TimelineEntry>
  currentTime: number
  onClose: () => void
}

// ─── Layout constants ────────────────────────────────────────────────────────

const ROW_HEIGHT = 22
const HEADER_HEIGHT = 20
const LABEL_WIDTH = 150
const NAME_LINE_HEIGHT = 11
const MODEL_LINE_HEIGHT = 10
const ROW_PAD_Y = 5
const FONT = '9px monospace'
const MODEL_FONT = '8px monospace'

// ─── Legend (static DOM, no perf cost) ──────────────────────────────────────

const LEGEND_ITEMS = [
  { color: COLORS.idle, label: 'Diam' },
  { color: COLORS.thinking, label: 'Berpikir' },
  { color: COLORS.tool, label: 'Pakai alat' },
  { color: COLORS.error, label: 'Gagal' },
  { color: COLORS.complete, label: 'Selesai' },
]

// ─── Row layout ─────────────────────────────────────────────────────────────

interface RowLayout {
  top: number
  height: number
  nameLines: string[]
  modelLines: string[]
}

interface TimelineLayout {
  rows: RowLayout[]
  height: number
}

interface TimeRange {
  minTime: number
  timeSpan: number
  width: number
}

let scratchCtx: CanvasRenderingContext2D | null = null
function getScratchCtx(): CanvasRenderingContext2D | null {
  if (scratchCtx) return scratchCtx
  if (typeof document === 'undefined') return null
  scratchCtx = document.createElement('canvas').getContext('2d')
  return scratchCtx
}

/**
 * Agent names carry task titles, so they are wrapped across lines and each row
 * grows to fit (owner request O3). The title is never cut.
 */
function layoutRows(entries: TimelineEntry[]): TimelineLayout {
  const ctx = getScratchCtx()
  const maxW = LABEL_WIDTH - 12
  let top = HEADER_HEIGHT
  const rows: RowLayout[] = entries.map((entry) => {
    let nameLines = [entry.agentName]
    let modelLines: string[] = []
    const models = formatTimelineModels(entry.models)
    if (ctx) {
      ctx.font = FONT
      nameLines = wrapText(entry.agentName, maxW, (s) => ctx.measureText(s).width)
      if (models) {
        ctx.font = MODEL_FONT
        modelLines = wrapText(models, maxW, (s) => ctx.measureText(s).width)
      }
    } else if (models) {
      modelLines = [models]
    }
    const textH = nameLines.length * NAME_LINE_HEIGHT + modelLines.length * MODEL_LINE_HEIGHT + ROW_PAD_Y * 2
    const height = Math.max(ROW_HEIGHT, textH)
    const row = { top, height, nameLines, modelLines }
    top += height
    return row
  })
  return { rows, height: top }
}

// ─── Canvas-based timeline rendering ────────────────────────────────────────

function drawTimeline(
  ctx: CanvasRenderingContext2D,
  entries: TimelineEntry[],
  layout: TimelineLayout,
  currentTime: number,
  width: number,
  height: number,
  dpr: number,
): TimeRange | null {
  ctx.clearRect(0, 0, width * dpr, height * dpr)
  ctx.save()
  ctx.scale(dpr, dpr)

  if (entries.length === 0) {
    ctx.font = FONT
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'center'
    ctx.fillText('Belum ada data linimasa', width / 2, height / 2)
    ctx.restore()
    return null
  }

  // Compute time range
  let minTime = entries[0].startTime
  let maxTime = currentTime
  for (const e of entries) {
    if (e.startTime < minTime) minTime = e.startTime
    const end = e.endTime ?? currentTime
    if (end > maxTime) maxTime = end
  }
  const timeSpan = Math.max(maxTime - minTime, 1)
  const barWidth = width - LABEL_WIDTH

  // Time markers
  const markerInterval = timeSpan > 60 ? 10 : timeSpan > 20 ? 5 : timeSpan > 10 ? 2 : 1
  const markers: number[] = []
  for (let t = Math.ceil(minTime / markerInterval) * markerInterval; t <= maxTime; t += markerInterval) {
    markers.push(t)
  }

  ctx.font = FONT

  // ── Header row: time labels ──
  ctx.textAlign = 'center'
  ctx.fillStyle = COLORS.textMuted
  for (const t of markers) {
    const x = LABEL_WIDTH + ((t - minTime) / timeSpan) * barWidth
    ctx.fillText(`${t.toFixed(0)}s`, x, HEADER_HEIGHT - 4)
  }

  // ── Agent rows ──
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const row = layout.rows[i]
    const y = row.top

    // Agent label (wrapped, in full), with its models underneath when known
    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.textDim
    ctx.font = FONT
    const textH = row.nameLines.length * NAME_LINE_HEIGHT + row.modelLines.length * MODEL_LINE_HEIGHT
    let ty = y + (row.height - textH) / 2 + NAME_LINE_HEIGHT - 2
    for (const line of row.nameLines) {
      ctx.fillText(line, LABEL_WIDTH - 6, ty)
      ty += NAME_LINE_HEIGHT
    }
    if (row.modelLines.length > 0) {
      ctx.font = MODEL_FONT
      ctx.fillStyle = COLORS.textMuted
      ty -= NAME_LINE_HEIGHT - MODEL_LINE_HEIGHT
      for (const line of row.modelLines) {
        ctx.fillText(line, LABEL_WIDTH - 6, ty)
        ty += MODEL_LINE_HEIGHT
      }
      ctx.font = FONT
    }

    // Background track, centred in the row
    const trackH = ROW_HEIGHT - 8
    const trackY = y + (row.height - trackH) / 2
    ctx.fillStyle = COLORS.holoBg03
    ctx.fillRect(LABEL_WIDTH, trackY, barWidth, trackH)

    // Vertical marker lines
    ctx.fillStyle = COLORS.panelSeparator
    for (const t of markers) {
      const x = LABEL_WIDTH + ((t - minTime) / timeSpan) * barWidth
      ctx.fillRect(x, trackY, 1, trackH)
    }

    // Blocks
    for (const block of entry.blocks) {
      const blockStart = ((block.startTime - minTime) / timeSpan) * barWidth
      const blockEndTime = block.endTime ?? currentTime
      const blockEnd = ((blockEndTime - minTime) / timeSpan) * barWidth
      const blockW = Math.max(blockEnd - blockStart, 1)
      const x = LABEL_WIDTH + blockStart

      // Block fill
      ctx.globalAlpha = 0.3
      ctx.fillStyle = block.color
      ctx.fillRect(x, trackY + 1, blockW, trackH - 2)

      // Block border
      ctx.globalAlpha = 0.2
      ctx.strokeStyle = block.color
      ctx.lineWidth = 1
      ctx.strokeRect(x, trackY + 1, blockW, trackH - 2)

      ctx.globalAlpha = 1

      // Label inside block if wide enough. Clipped to the block on purpose: it
      // is a tool-call label, and the full text shows on hover.
      if (blockW > 40) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, trackY, blockW, trackH)
        ctx.clip()
        ctx.fillStyle = block.color
        ctx.globalAlpha = 0.8
        ctx.textAlign = 'left'
        ctx.fillText(block.label, x + 4, trackY + trackH / 2 + 3)
        ctx.restore()
      }
    }

    // Playhead
    const playheadX = LABEL_WIDTH + ((currentTime - minTime) / timeSpan) * barWidth
    ctx.fillStyle = COLORS.holoHot
    ctx.globalAlpha = 0.5
    ctx.fillRect(playheadX, trackY, 1, trackH)
    ctx.globalAlpha = 1
  }

  ctx.restore()
  return { minTime, timeSpan, width }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TimelinePanel({ visible, timelineEntries, currentTime, onClose }: TimelinePanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rangeRef = useRef<TimeRange | null>(null)

  const sortedEntries = useMemo(() => {
    if (!visible) return []
    return Array.from(timelineEntries.values()).sort((a, b) => a.startTime - b.startTime)
  }, [visible, timelineEntries])

  const layout = useMemo(() => layoutRows(sortedEntries), [sortedEntries])
  const canvasHeight = layout.height

  // Block labels are clipped to their block; hovering a block shows its full text
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { offsetX, offsetY } = e.nativeEvent
    const range = rangeRef.current
    let title = ''
    if (range && offsetX >= LABEL_WIDTH) {
      const idx = layout.rows.findIndex(r => offsetY >= r.top && offsetY < r.top + r.height)
      const entry = idx >= 0 ? sortedEntries[idx] : undefined
      if (entry) {
        const t = range.minTime + ((offsetX - LABEL_WIDTH) / (range.width - LABEL_WIDTH)) * range.timeSpan
        const block = entry.blocks.find(b => t >= b.startTime && t <= (b.endTime ?? currentTime))
        if (block) title = block.label
      }
    }
    if (e.currentTarget.title !== title) e.currentTarget.title = title
  }, [sortedEntries, layout, currentTime])

  useEffect(() => {
    if (!visible) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Use the scroll container's clientWidth (excludes scrollbar) for a snug fit
    const scrollContainer = canvas.parentElement
    const width = scrollContainer?.clientWidth ?? canvas.clientWidth
    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = canvasHeight * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${canvasHeight}px`

    rangeRef.current = drawTimeline(ctx, sortedEntries, layout, currentTime, width, canvasHeight, dpr)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- redraw on every prop change (component only re-renders on data/time updates)
  }, [visible, sortedEntries, layout, currentTime, canvasHeight])

  if (!visible) return null

  return (
    <SlidingPanel
      visible={visible}
      position={{ bottom: 72, left: 16, right: 16 }}
      axis="Y"
      zIndex={Z.sidePanel}
      className="mx-auto"
      style={{ maxWidth: 700 }}
    >
      <div className="glass-card relative">
        <PanelHeader onClose={onClose}>
          <span className="text-[10px] font-mono tracking-wider" style={{ color: COLORS.textPrimary }}>
            LINIMASA EKSEKUSI
          </span>
        </PanelHeader>

        <div className="overflow-auto" style={{ maxHeight: 300 }}>
          <canvas ref={canvasRef} style={{ display: 'block' }} onMouseMove={handleMouseMove} />
        </div>

        {/* Legend (static DOM) */}
        <div className="flex items-center gap-3 px-3 py-1.5" style={{ borderTop: `1px solid ${COLORS.holoBorder06}` }}>
          <div style={{ width: LABEL_WIDTH, flexShrink: 0 }} />
          <div className="flex items-center gap-3">
            {LEGEND_ITEMS.map(item => (
              <div key={item.label} className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-sm" style={{ background: item.color + '70' }} />
                <span className="text-[9px] font-mono" style={{ color: COLORS.textMuted }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </SlidingPanel>
  )
}
