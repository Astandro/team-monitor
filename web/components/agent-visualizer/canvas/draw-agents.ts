import { Agent, NODE, ANIM } from '@/lib/agent-types'
import { COLORS, getStateColor, contextSegments } from '@/lib/colors'
import {
  AGENT_DRAW, CONTEXT_BAR, CONTEXT_RING, STATS_OVERLAY, COMPLETED_SUBAGENT_OPACITY,
} from '@/lib/canvas-constants'
import { alphaHex, formatTokens } from '@/lib/utils'
import { canvasIdentity } from './identity'
import { wrapTextCanvas, drawHexagon, CLAUDE_SPARK_D, OPENAI_LOGO_D, OPENAI_LOGO_VIEWBOX } from './draw-misc'
import { getAgentGlowSprite } from './render-cache'
import { burstAt, DISINTEGRATING_TAG, disintegrationLook, disintegrationProgress, fragments, nameFlicker, type Burst, type Fragment } from '@/lib/disintegration'
import { reducedMotion } from '@/lib/motion'

let _claudeSparkPath: Path2D | null = null
export function getClaudeSparkPath() {
  if (!_claudeSparkPath) _claudeSparkPath = new Path2D(CLAUDE_SPARK_D)
  return _claudeSparkPath
}

let _openaiLogoPath: Path2D | null = null
function getOpenAILogoPath() {
  if (!_openaiLogoPath) _openaiLogoPath = new Path2D(OPENAI_LOGO_D)
  return _openaiLogoPath
}

export function drawClaudeSpark(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  const scale = (r * AGENT_DRAW.sparkScale) / AGENT_DRAW.sparkViewBox
  ctx.scale(scale, scale)
  ctx.translate(-AGENT_DRAW.sparkViewBox, -AGENT_DRAW.sparkViewBox + 1)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 6 / scale
  ctx.fill(getClaudeSparkPath())
  ctx.restore()
}

export function drawOpenAILogo(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  // Target diameter matches the Claude spark: (r * sparkScale) total.
  const scale = (r * AGENT_DRAW.sparkScale) / OPENAI_LOGO_VIEWBOX
  ctx.scale(scale, scale)
  ctx.translate(-OPENAI_LOGO_VIEWBOX / 2, -OPENAI_LOGO_VIEWBOX / 2)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 6 / scale
  ctx.fill(getOpenAILogoPath())
  ctx.restore()
}

/** Pick the brand logo for the agent's runtime. Defaults to Claude. */
export function drawAgentBrand(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, color: string,
  runtime: Agent['runtime'],
) {
  if (runtime === 'codex') drawOpenAILogo(ctx, cx, cy, r, color)
  else drawClaudeSpark(ctx, cx, cy, r, color)
}

export function drawContextComposition(
  ctx: CanvasRenderingContext2D,
  agent: Agent,
  radius: number,
) {
  const bd = agent.contextBreakdown
  const total = agent.tokensUsed
  if (total <= 0) return

  const barWidth = Math.max(CONTEXT_BAR.minWidth, radius * CONTEXT_BAR.widthMultiplier)
  const barHeight = CONTEXT_BAR.barHeight
  const barX = agent.x - barWidth / 2
  const barY = agent.y + radius + CONTEXT_BAR.yOffset

  // Background
  ctx.fillStyle = COLORS.cardBgDark
  ctx.beginPath()
  ctx.roundRect(barX - 2, barY - 2, barWidth + 4, barHeight + 14, CONTEXT_BAR.borderRadius)
  ctx.fill()

  // Label
  ctx.fillStyle = COLORS.textMuted
  ctx.font = `${CONTEXT_BAR.fontSize}px monospace`
  ctx.textAlign = 'center'
  ctx.fillText(`${formatTokens(total)} / ${formatTokens(agent.tokensMax)} tokens`, agent.x, barY + barHeight + CONTEXT_BAR.labelPadding)

  // Segments
  const segments = contextSegments(bd)

  let x = barX
  const maxWidth = barWidth * (total / agent.tokensMax)

  for (const seg of segments) {
    if (seg.value <= 0) continue
    const segWidth = (seg.value / total) * maxWidth
    ctx.fillStyle = seg.color
    ctx.fillRect(x, barY, segWidth, barHeight)
    x += segWidth
  }

  // Remaining capacity
  if (x < barX + barWidth) {
    ctx.fillStyle = COLORS.holoBg05
    ctx.fillRect(x, barY, barX + barWidth - x, barHeight)
  }

  ctx.strokeStyle = COLORS.glassBorder
  ctx.lineWidth = 0.5
  ctx.strokeRect(barX, barY, barWidth, barHeight)
}

export function drawContextRing(
  ctx: CanvasRenderingContext2D,
  agent: Agent,
  radius: number,
  time: number,
) {
  const bd = agent.contextBreakdown
  const total = agent.tokensUsed
  if (total <= 0) return

  const usage = total / agent.tokensMax
  const ringR = radius + CONTEXT_RING.ringOffset
  const ringW = CONTEXT_RING.ringWidth
  const startAngle = -Math.PI / 2

  // Background ring (empty capacity)
  ctx.beginPath()
  ctx.arc(agent.x, agent.y, ringR, 0, Math.PI * 2)
  ctx.strokeStyle = COLORS.holoBorder06
  ctx.lineWidth = ringW
  ctx.stroke()

  // Filled segments
  const segments = contextSegments(bd)

  let currentAngle = startAngle
  for (const seg of segments) {
    if (seg.value <= 0) continue
    const sweep = (seg.value / agent.tokensMax) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(agent.x, agent.y, ringR, currentAngle, currentAngle + sweep)
    ctx.strokeStyle = seg.color
    ctx.lineWidth = ringW
    ctx.stroke()
    currentAngle += sweep
  }

  // Warning glow at high usage
  if (usage > CONTEXT_RING.warningThreshold) {
    const warningColor = usage > CONTEXT_RING.criticalThreshold ? COLORS.error : COLORS.tool
    const intensity = usage > CONTEXT_RING.criticalThreshold
      ? 0.35 + Math.sin(time * 6) * 0.2
      : 0.15 + Math.sin(time * 3) * 0.1

    ctx.save()
    ctx.beginPath()
    ctx.arc(agent.x, agent.y, ringR + CONTEXT_RING.glowPadding, 0, Math.PI * 2)
    ctx.strokeStyle = warningColor
    ctx.lineWidth = CONTEXT_RING.glowLineWidth
    ctx.globalAlpha = intensity
    ctx.shadowColor = warningColor
    ctx.shadowBlur = CONTEXT_RING.glowBlur
    ctx.stroke()
    ctx.restore()
  }

  // Percentage label when usage is high
  if (usage > CONTEXT_RING.percentLabelThreshold) {
    ctx.font = `${CONTEXT_BAR.fontSize}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = usage > CONTEXT_RING.criticalThreshold ? COLORS.error : usage > CONTEXT_RING.warningThreshold ? COLORS.tool : COLORS.textDim
    ctx.fillText(`${Math.floor(usage * 100)}%`, agent.x, agent.y - radius - CONTEXT_RING.percentYOffset)
  }
}

function drawDepthShadow(ctx: CanvasRenderingContext2D, agent: Agent, r: number) {
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = AGENT_DRAW.shadowBlur
  ctx.shadowOffsetX = AGENT_DRAW.shadowOffsetX
  ctx.shadowOffsetY = AGENT_DRAW.shadowOffsetY
  drawHexagon(ctx, agent.x, agent.y, r * 0.9)
  ctx.fillStyle = COLORS.cardBgFaintOverlay
  ctx.fill()
  ctx.restore()
}

function drawAgentGlow(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isSelected: boolean, isWaiting: boolean) {
  const glowR = r + AGENT_DRAW.glowPadding
  const glowAlpha = isHovered || isSelected ? 0.35 : isWaiting ? 0.3 : agent.state === 'thinking' ? 0.2 : 0.1
  // Pre-rendered glow sprite instead of per-frame gradient creation
  const sprite = getAgentGlowSprite(color, Math.round(r * 0.5), Math.ceil(glowR), alphaHex(glowAlpha))
  ctx.drawImage(sprite, agent.x - Math.ceil(glowR), agent.y - Math.ceil(glowR))

  // Ambient outer hex ring
  drawHexagon(ctx, agent.x, agent.y, r + AGENT_DRAW.outerRingOffset)
  ctx.strokeStyle = color + '25'
  ctx.lineWidth = 1
  ctx.stroke()

  // Inner hex fill
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.fillStyle = COLORS.nodeInterior
  ctx.fill()
}

function drawScanline(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isWaiting: boolean, time: number) {
  const scanSpeed = agent.state === 'thinking' || isHovered || isWaiting ? ANIM.scanline.thinking : ANIM.scanline.normal
  const scanY = agent.y - r + ((time * scanSpeed) % (r * 2))
  ctx.save()
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.clip()
  const scanGrad = ctx.createLinearGradient(agent.x, scanY - AGENT_DRAW.scanlineHalfH, agent.x, scanY + AGENT_DRAW.scanlineHalfH)
  const scanAlpha = isHovered ? '35' : '20'
  scanGrad.addColorStop(0, color + '00')
  scanGrad.addColorStop(0.5, color + scanAlpha)
  scanGrad.addColorStop(1, color + '00')
  ctx.fillStyle = scanGrad
  ctx.fillRect(agent.x - r, scanY - AGENT_DRAW.scanlineHalfH, r * 2, AGENT_DRAW.scanlineWidth)
  ctx.restore()
}

function drawStateRing(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isSelected: boolean, isWaiting: boolean, time: number) {
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.strokeStyle = color
  ctx.lineWidth = (isSelected || isHovered) ? 2.5 : 2
  if (agent.state === 'complete') {
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = color + '60'
  } else if (isWaiting) {
    ctx.setLineDash([6, 4])
    ctx.lineDashOffset = -time * AGENT_DRAW.waitingDashSpeed
    ctx.lineWidth = 2.5
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineDashOffset = 0
}

function drawCenterIcon(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isWaiting: boolean) {
  if (isWaiting) {
    // Geometric lock icon — fits the holographic style
    const s = r * 0.3
    ctx.save()
    ctx.strokeStyle = color + '90'
    ctx.fillStyle = color + '90'
    ctx.lineWidth = 1.5
    // Lock body (rounded rect)
    ctx.beginPath()
    ctx.roundRect(agent.x - s * 0.6, agent.y - s * 0.1, s * 1.2, s * 1.0, 2)
    ctx.fill()
    // Lock shackle (arc)
    ctx.beginPath()
    ctx.arc(agent.x, agent.y - s * 0.15, s * 0.4, Math.PI, 0)
    ctx.stroke()
    ctx.restore()
  } else if (agent.isMain) {
    drawAgentBrand(ctx, agent.x, agent.y, r, color + '90', agent.runtime)
  } else {
    ctx.fillStyle = color + '90'
    ctx.font = `${r * AGENT_DRAW.subIconScale}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(agent.state === 'tool_calling' ? '\u2699' : '\u25C7', agent.x, agent.y)
  }
}

function drawOrbitingParticles(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, time: number) {
  for (let i = 0; i < 4; i++) {
    const angle = time * ANIM.orbitSpeed + (i / 4) * Math.PI * 2
    ctx.beginPath()
    ctx.fillStyle = color + '80'
    ctx.arc(
      agent.x + Math.cos(angle) * (r + AGENT_DRAW.orbitParticleOffset),
      agent.y + Math.sin(angle) * (r + AGENT_DRAW.orbitParticleOffset),
      AGENT_DRAW.orbitParticleSize, 0, Math.PI * 2,
    )
    ctx.fill()
  }
}

function drawWaitingRipples(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, time: number) {
  // Radar ripples — 2 concentric rings expanding outward, staggered
  for (let i = 0; i < 2; i++) {
    const ripplePhase = ((time * 0.65 + i * 0.5) % 1.0)
    const rippleR = r + AGENT_DRAW.rippleInnerOffset + ripplePhase * AGENT_DRAW.rippleMaxExpand
    const rippleAlpha = (1 - ripplePhase) * AGENT_DRAW.rippleMaxAlpha
    ctx.beginPath()
    drawHexagon(ctx, agent.x, agent.y, rippleR)
    ctx.strokeStyle = color + alphaHex(rippleAlpha)
    ctx.lineWidth = 1.5 * (1 - ripplePhase)
    ctx.stroke()
  }

  // Slower orbiting particles in amber
  for (let i = 0; i < 3; i++) {
    const angle = time * AGENT_DRAW.waitingOrbitSpeed + (i / 3) * Math.PI * 2
    ctx.beginPath()
    ctx.fillStyle = color + '70'
    ctx.arc(
      agent.x + Math.cos(angle) * (r + AGENT_DRAW.waitingOrbitOffset),
      agent.y + Math.sin(angle) * (r + AGENT_DRAW.waitingOrbitOffset),
      AGENT_DRAW.waitingOrbitParticleSize, 0, Math.PI * 2,
    )
    ctx.fill()
  }
}

/** A quiet light burst: one faint ring growing off the node edge and fading (item 7). Cheap: one arc stroke. */
function drawBurst(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, b: Burst) {
  ctx.beginPath()
  ctx.strokeStyle = color + alphaHex(Math.min(1, b.alpha))
  ctx.lineWidth = 2 * (1 - b.phase) + 0.5
  ctx.arc(agent.x, agent.y, r + b.spread, 0, Math.PI * 2)
  ctx.stroke()
}

/** Small "disintegrating" tag under a leaving node's name and role, in the muted colour. */
function drawDisintegratingTag(ctx: CanvasRenderingContext2D, agent: Agent, r: number) {
  const maxLabelW = Math.max(r * AGENT_DRAW.labelWidthMultiplier, AGENT_DRAW.labelMinWidth)
  const hasBar = agent.tokensUsed > 0
  const top = hasBar
    ? r + CONTEXT_BAR.yOffset + CONTEXT_BAR.barHeight + AGENT_DRAW.labelBelowBarGap
    : r + AGENT_DRAW.labelYOffset
  ctx.font = '10px monospace'
  const id = canvasIdentity(agent)
  const lines = wrapTextCanvas(ctx, id.name, maxLabelW).length + (id.role ? wrapTextCanvas(ctx, id.role, maxLabelW).length : 0)
  ctx.font = 'italic 9px monospace'
  ctx.fillStyle = COLORS.textMuted
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(DISINTEGRATING_TAG, agent.x, agent.y + top + lines * AGENT_DRAW.labelLineHeight + 1)
}

function drawAgentLabel(ctx: CanvasRenderingContext2D, agent: Agent, r: number, isHovered: boolean) {
  ctx.fillStyle = isHovered ? COLORS.textPrimary : COLORS.textDim
  ctx.font = '10px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const maxLabelW = Math.max(r * AGENT_DRAW.labelWidthMultiplier, AGENT_DRAW.labelMinWidth)
  // Agent names carry task titles: wrap them, never cut them. When the context
  // bar is drawn under the hexagon the name starts below it so they never overlap.
  const hasBar = agent.tokensUsed > 0
  const top = hasBar
    ? r + CONTEXT_BAR.yOffset + CONTEXT_BAR.barHeight + AGENT_DRAW.labelBelowBarGap
    : r + AGENT_DRAW.labelYOffset
  // Personal name first, the role on its own line(s) under it in the muted colour (D23)
  const id = canvasIdentity(agent)
  const lines = wrapTextCanvas(ctx, id.name, maxLabelW)
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], agent.x, agent.y + top + i * AGENT_DRAW.labelLineHeight)
  }
  if (id.role) {
    ctx.fillStyle = COLORS.textMuted
    const roleLines = wrapTextCanvas(ctx, id.role, maxLabelW)
    for (let i = 0; i < roleLines.length; i++) {
      ctx.fillText(roleLines[i], agent.x, agent.y + top + (lines.length + i) * AGENT_DRAW.labelLineHeight)
    }
  }
}

function drawStatsOverlay(ctx: CanvasRenderingContext2D, agent: Agent, r: number) {
  const sy = agent.y - r - STATS_OVERLAY.yOffset
  ctx.fillStyle = COLORS.cardBgDark
  ctx.beginPath()
  ctx.roundRect(agent.x - STATS_OVERLAY.boxWidth / 2, sy, STATS_OVERLAY.boxWidth, STATS_OVERLAY.boxHeight, STATS_OVERLAY.borderRadius)
  ctx.fill()
  ctx.strokeStyle = COLORS.glassBorder
  ctx.lineWidth = 0.5
  ctx.stroke()
  ctx.fillStyle = COLORS.textMuted
  ctx.font = `${STATS_OVERLAY.fontSize}px monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(`${agent.toolCalls} alat \u00B7 ${agent.timeAlive.toFixed(1)} dtk`, agent.x, sy + STATS_OVERLAY.textPaddingY)
}

/** The outline of a disintegrating node: the hexagon in OUTLINE_PIECES pieces, only the ones still there. */
function drawBrokenOutline(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, pieces: boolean[]) {
  const perEdge = pieces.length / 6
  ctx.strokeStyle = color + '70'
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let e = 0; e < 6; e++) {
    const a0 = (Math.PI / 3) * e - Math.PI / 2
    const a1 = a0 + Math.PI / 3
    const x0 = agent.x + r * Math.cos(a0), y0 = agent.y + r * Math.sin(a0)
    const x1 = agent.x + r * Math.cos(a1), y1 = agent.y + r * Math.sin(a1)
    for (let k = 0; k < perEdge; k++) {
      if (!pieces[e * perEdge + k]) continue
      // a hairline gap between pieces so the break-up reads even early on
      const t0 = (k + 0.08) / perEdge, t1 = (k + 0.92) / perEdge
      ctx.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0)
      ctx.lineTo(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)
    }
  }
  ctx.stroke()
}

/** Fragments drifting off a disintegrating node (none under reduced motion). */
function drawFragments(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, list: Fragment[]) {
  for (const f of list) {
    const d = r + 2 + f.drift
    ctx.beginPath()
    ctx.fillStyle = color + alphaHex(Math.min(1, f.alpha))
    ctx.arc(agent.x + Math.cos(f.angle) * d, agent.y + Math.sin(f.angle) * d, f.size, 0, Math.PI * 2)
    ctx.fill()
  }
}

export function drawAgents(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  selectedAgentId: string | null,
  hoveredAgentId: string | null,
  showStats: boolean,
  time: number,
) {
  // Wall clock for the auto-offboard countdown (the server's finishedAt / autoOffboardAt are real times)
  const now = Date.now()
  const still = reducedMotion()
  for (const [id, agent] of agents) {
    const radius = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const color = getStateColor(agent.state)
    const isHovered = id === hoveredAgentId
    const isSelected = id === selectedAgentId

    const isWaiting = agent.state === 'waiting_permission'

    const breathe = isWaiting
      ? Math.sin(time * AGENT_DRAW.waitingBreatheSpeed) * AGENT_DRAW.waitingBreatheAmp + 1
      : agent.state === 'thinking'
      ? Math.sin(time * ANIM.breathe.thinkingSpeed) * ANIM.breathe.thinkingAmp + 1
      : agent.state === 'idle' ? Math.sin(time * ANIM.breathe.idleSpeed) * ANIM.breathe.idleAmp + 1 : 1

    const r = radius * breathe * agent.scale

    // Finished sub-agent counting down to its automatic offboard (spec item 6): wears away over the hour
    const clock = !agent.isMain && agent.state === 'complete' ? agent.finished : undefined
    const progress = clock ? disintegrationProgress(clock, now) : 0
    const look = clock ? disintegrationLook(id, progress, still) : null
    if (look && look.body <= 0 && look.label <= 0) continue
    const bodyAlpha = agent.opacity * (look ? look.body : 1)

    ctx.save()
    ctx.globalAlpha = bodyAlpha

    drawDepthShadow(ctx, agent, r)
    drawAgentGlow(ctx, agent, r, color, isHovered, isSelected, isWaiting)
    drawScanline(ctx, agent, r, color, isHovered, isWaiting, time)
    if (look?.pieces) {
      ctx.globalAlpha = agent.opacity
      drawBrokenOutline(ctx, agent, r, color, look.pieces)
      drawFragments(ctx, agent, r, color, fragments(id, progress, time, still))
      const burst = burstAt(id, progress, time, still)
      if (burst) drawBurst(ctx, agent, r, color, burst)
      ctx.globalAlpha = bodyAlpha
    } else {
      drawStateRing(ctx, agent, r, color, isHovered, isSelected, isWaiting, time)
    }
    drawCenterIcon(ctx, agent, r, color, isWaiting)

    if (agent.state === 'thinking') {
      drawOrbitingParticles(ctx, agent, r, color, time)
    }

    if (isWaiting) {
      drawWaitingRipples(ctx, agent, r, color, time)
    }

    // A finished sub-agent's node is dimmed, but its name stays readable (muted text at full strength): the owner
    // wants to see who was on the team, and a dimmed label failed contrast on the light canvas.
    // While it disintegrates the name blinks slowly and carries a small tag (item 7); reduced motion: steady name.
    if (agent.state === 'complete' && !agent.isMain && agent.opacity >= COMPLETED_SUBAGENT_OPACITY) {
      ctx.globalAlpha = look ? look.label * nameFlicker(id, progress, time, still) : 1
    }
    drawAgentLabel(ctx, agent, r, isHovered)
    if (look && progress < 1) {
      ctx.globalAlpha = look.label
      drawDisintegratingTag(ctx, agent, r)
    }
    ctx.globalAlpha = bodyAlpha

    // Context composition — ring for main agent, bar for sub-agents
    if (agent.state !== 'complete' || agent.opacity > 0.5) {
      if (agent.isMain) {
        drawContextRing(ctx, agent, r, time)
      }
      drawContextComposition(ctx, agent, r)
    }

    if (showStats && agent.state !== 'complete') {
      drawStatsOverlay(ctx, agent, r)
    }

    ctx.restore()
  }
}
