import { Agent, NODE, ANIM } from '@/lib/agent-types'
import { COLORS, getStateColor, contextSegments, getGraphTheme } from '@/lib/colors'
import {
  AGENT_DRAW, CONTEXT_BAR, CONTEXT_RING, STATS_OVERLAY, COMPLETED_SUBAGENT_OPACITY,
} from '@/lib/canvas-constants'
import { alphaHex, formatTokens } from '@/lib/utils'
import { canvasIdentity } from './identity'
import { wrapTextCanvas, drawHexagon, CLAUDE_SPARK_D, OPENAI_LOGO_D, OPENAI_LOGO_VIEWBOX } from './draw-misc'
import { getAgentGlowSprite, getEmberGlowSprite, getGlowSprite } from './render-cache'
import { debris, DISINTEGRATING_TAG, disintegrationLook, disintegrationProgress, EMBER, emberGlow, sparks, tagPulse, type EmberGlow, type Mote } from '@/lib/disintegration'
import { ALERT_TOKENS, alertBlinkAlpha, mixHex, WARNING_ICON } from '@/lib/alert-tag'
import { reducedMotion } from '@/lib/motion'
import { nodeAlert, ownerTagPulse, type NodeAlert } from '@/lib/owner-decision'
import { isCanvasOwnerNode } from './owner-state'
import { drawNodeAvatar } from './avatar-sprites'

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

function drawStateRing(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isSelected: boolean, alert: NodeAlert | null, time: number) {
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.strokeStyle = color
  ctx.lineWidth = (isSelected || isHovered) ? 2.5 : 2
  if (alert) {
    // dashed ring, moving unless reduced motion
    ctx.setLineDash([6, 4])
    ctx.lineDashOffset = alert.animated ? -time * AGENT_DRAW.waitingDashSpeed : 0
    ctx.lineWidth = 2.5
  } else if (agent.state === 'complete') {
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = color + '60'
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineDashOffset = 0
}

/** Warning triangle with an exclamation mark centred on (cx, cy), `size` wide (the owner state's icon). */
function drawCenteredWarning(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, color: string) {
  drawWarningIcon(ctx, cx - size / 2, cy - size / 2, size, color)
}

function drawCenterIcon(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, alert: NodeAlert | null) {
  if (alert?.icon === 'warning') {
    drawCenteredWarning(ctx, agent.x, agent.y, r * 0.75, color)
  } else if (alert?.icon === 'lock') {
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

/** Waiting for permission while the avatar fills the hexagon: the lock moves to a small badge on its lower right. */
function drawLockBadge(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string) {
  const s = r * 0.42
  const bx = agent.x + r * 0.52
  const by = agent.y + r * 0.5
  ctx.save()
  ctx.beginPath()
  ctx.arc(bx, by, s * 0.75, 0, Math.PI * 2)
  ctx.fillStyle = COLORS.nodeInterior
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.roundRect(bx - s * 0.32, by - s * 0.05, s * 0.64, s * 0.46, 1.5)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(bx, by - s * 0.08, s * 0.22, Math.PI, 0)
  ctx.lineWidth = 1.3
  ctx.stroke()
  ctx.restore()
}

/** The owner state while the avatar fills the hexagon: the warning triangle in a small badge on its lower right. */
function drawWarningBadge(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string) {
  const s = r * 0.42
  const bx = agent.x + r * 0.52
  const by = agent.y + r * 0.5
  ctx.save()
  ctx.beginPath()
  ctx.arc(bx, by, s * 0.75, 0, Math.PI * 2)
  ctx.fillStyle = COLORS.nodeInterior
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.restore()
  drawCenteredWarning(ctx, bx, by - s * 0.03, s * 0.95, color)
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

/** Ripples and orbiting particles of a node that waits (permission, or the owner's answer). Nothing under reduced motion. */
function drawWaitingRipples(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, time: number, alert: NodeAlert) {
  if (!alert.animated) return
  // Radar ripples: concentric rings expanding outward, evenly staggered (2 for permission, 3 for the owner)
  const n = alert.ripples
  for (let i = 0; i < n; i++) {
    const ripplePhase = ((time * 0.65 + i / n) % 1.0)
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

/**
 * The ember glow behind a leaving node: the same symmetric shape as the active glow (drawAgentGlow), in ember orange,
 * one cached sprite drawn at the wanted strength. Additive on the dark sky, plain blending on the light canvas.
 */
function drawEmberGlow(ctx: CanvasRenderingContext2D, agent: Agent, r: number, g: EmberGlow, dark: boolean, base: number) {
  const outer = Math.ceil(r + g.pad)
  const sprite = getEmberGlowSprite(dark ? EMBER.dark.glow : EMBER.light.glow, r * 0.85, outer)
  const prevOp = ctx.globalCompositeOperation
  ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over'
  ctx.globalAlpha = base * g.alpha
  ctx.drawImage(sprite, agent.x - outer, agent.y - outer)
  ctx.globalCompositeOperation = prevOp
}

/**
 * Debris breaking off a leaving node (small squares, one fillRect each) and the sparks among it (a small cached light
 * sprite with a bright point in the middle). Sparks add light on the dark sky; on the light canvas they are hot orange
 * points with a soft halo.
 */
function drawDebrisAndSparks(ctx: CanvasRenderingContext2D, agent: Agent, bits: Mote[], lights: Mote[], dark: boolean, base: number) {
  const ember = dark ? EMBER.dark : EMBER.light
  ctx.fillStyle = ember.debris
  for (const m of bits) {
    if (m.alpha <= 0.01) continue
    ctx.globalAlpha = base * m.alpha
    ctx.fillRect(agent.x + m.x - m.size / 2, agent.y + m.y - m.size / 2, m.size, m.size)
  }
  if (!lights.length) return
  const prevOp = ctx.globalCompositeOperation
  if (dark) ctx.globalCompositeOperation = 'lighter'
  for (const s of lights) {
    if (s.alpha <= 0.01) continue
    const halo = getGlowSprite(ember.spark, Math.ceil(s.size), 'cc', '00')
    ctx.globalAlpha = base * s.alpha
    ctx.drawImage(halo, agent.x + s.x - halo.width / 2, agent.y + s.y - halo.height / 2)
    ctx.fillStyle = dark ? '#FFFFFF' : ember.debris
    ctx.fillRect(agent.x + s.x - 0.75, agent.y + s.y - 0.75, 1.5, 1.5)
  }
  ctx.globalCompositeOperation = prevOp
}

/**
 * The alert tag under a node's name and role: "disintegrating" on a leaving node (item 4a), "Butuh jawaban" on a node
 * waiting for the owner's answer. A see-through red pill with a matching border, a warning triangle and readable
 * text; the whole tag blinks (`pulse` 0..1). Static under reduced motion (pulse 0).
 */
function drawAlertTag(ctx: CanvasRenderingContext2D, agent: Agent, r: number, pulse: number, label: string) {
  const maxLabelW = Math.max(r * AGENT_DRAW.labelWidthMultiplier, AGENT_DRAW.labelMinWidth)
  const hasBar = agent.tokensUsed > 0
  const top = hasBar
    ? r + CONTEXT_BAR.yOffset + CONTEXT_BAR.barHeight + AGENT_DRAW.labelBelowBarGap
    : r + AGENT_DRAW.labelYOffset
  ctx.font = '10px monospace'
  const id = canvasIdentity(agent)
  const lines = wrapTextCanvas(ctx, id.name, maxLabelW).length + (id.role ? wrapTextCanvas(ctx, id.role, maxLabelW).length : 0)
  const t = ALERT_TOKENS[getGraphTheme() === 'dark' ? 'dark' : 'light']
  ctx.font = 'bold 9px sans-serif'
  const icon = 9
  const textW = ctx.measureText(label).width
  const w = textW + icon + 3 + 9
  const h = 13
  const x = agent.x - w / 2
  const y = agent.y + top + lines * AGENT_DRAW.labelLineHeight + 2
  // Owner (13 Nov): the whole alert component blinks (pill, triangle and text together), not only its border.
  ctx.save()
  ctx.globalAlpha *= alertBlinkAlpha(pulse)
  if (pulse > 0) {
    // the ring is a stroke outside the pill, so the see-through tint does not darken under it
    ctx.beginPath()
    ctx.roundRect(x - 1.5, y - 1.5, w + 3, h + 3, 5.5)
    ctx.strokeStyle = t.line + alphaHex(0.35 * pulse)
    ctx.lineWidth = 3
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 4)
  ctx.fillStyle = mixHex(t.bg, t.bgHi, pulse)
  ctx.fill()
  ctx.strokeStyle = t.line
  ctx.lineWidth = 1
  ctx.stroke()
  drawWarningIcon(ctx, x + 4, y + (h - icon) / 2, icon, t.ink)
  ctx.fillStyle = t.ink
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + 4 + icon + 3, y + h / 2 + 0.5)
  ctx.restore()
}

/** The tag's warning triangle (same shape as the panel's inline SVG, WARNING_ICON). */
function drawWarningIcon(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(size / 12, size / 12)
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 1.4
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke(new Path2D(WARNING_ICON.triangle))
  ctx.stroke(new Path2D(WARNING_ICON.mark))
  ctx.beginPath()
  ctx.arc(WARNING_ICON.dot.cx, WARNING_ICON.dot.cy, WARNING_ICON.dot.r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
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
  const theme = getGraphTheme() === 'dark' ? 'dark' : 'light'
  for (const [id, agent] of agents) {
    const radius = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const isHovered = id === hoveredAgentId
    const isSelected = id === selectedAgentId

    // Waiting for the owner's answer (red, triangle, tag) wins over waiting for permission (amber, lock)
    const alert = nodeAlert(agent.state, isCanvasOwnerNode(id), still)
    const isWaiting = alert !== null
    const color = alert?.kind === 'owner' ? COLORS.ownerDecision : getStateColor(agent.state)

    const breathe = isWaiting
      ? (alert.animated ? Math.sin(time * AGENT_DRAW.waitingBreatheSpeed) * AGENT_DRAW.waitingBreatheAmp + 1 : 1)
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
    // The ember glow sits behind the node, symmetric like the active glow (owner, 13 Nov)
    const dark = theme === 'dark'
    if (look) {
      const glow = emberGlow(id, progress, time, still)
      if (glow) drawEmberGlow(ctx, agent, r, glow, dark, agent.opacity)
    }
    ctx.globalAlpha = bodyAlpha

    drawDepthShadow(ctx, agent, r)
    drawAgentGlow(ctx, agent, r, color, isHovered, isSelected, isWaiting)
    // The member's bot face inside the hexagon (owner, 13 Nov), the same face as in the team list. It takes the
    // hexagon's interior, so the scanline and the centre icon are only drawn while its bitmap is still decoding.
    const avatarDrawn = drawNodeAvatar(ctx, agent.x, agent.y, r, canvasIdentity(agent).name, !!agent.isMain, theme)
    if (!avatarDrawn) drawScanline(ctx, agent, r, color, isHovered, isWaiting, time)
    if (look?.pieces) {
      ctx.globalAlpha = agent.opacity
      drawBrokenOutline(ctx, agent, r, color, look.pieces)
      // debris and sparks in front of the node, so they read over its body
      drawDebrisAndSparks(ctx, agent, debris(id, progress, time, still, r), sparks(id, progress, time, still, r), dark, agent.opacity)
      ctx.globalAlpha = bodyAlpha
    } else {
      drawStateRing(ctx, agent, r, color, isHovered, isSelected, alert, time)
    }
    if (!avatarDrawn) drawCenterIcon(ctx, agent, r, color, alert)
    else if (alert?.icon === 'warning') drawWarningBadge(ctx, agent, r, color)
    else if (alert?.icon === 'lock') drawLockBadge(ctx, agent, r, color)

    if (agent.state === 'thinking' && !alert) {
      drawOrbitingParticles(ctx, agent, r, color, time)
    }

    if (alert) {
      drawWaitingRipples(ctx, agent, r, color, time, alert)
    }

    // A finished sub-agent's node is dimmed, but its name stays readable (muted text at full strength): the owner
    // wants to see who was on the team, and a dimmed label failed contrast on the light canvas.
    // While it disintegrates the name stays steady and the alert tag under it pulses (item 4a); reduced motion: static tag.
    if (agent.state === 'complete' && !agent.isMain && agent.opacity >= COMPLETED_SUBAGENT_OPACITY) {
      ctx.globalAlpha = look ? look.label : 1
    }
    drawAgentLabel(ctx, agent, r, isHovered)
    if (look && progress < 1) {
      ctx.globalAlpha = look.label
      drawAlertTag(ctx, agent, r, tagPulse(id, progress, time, still), DISINTEGRATING_TAG)
    } else if (alert?.tag) {
      drawAlertTag(ctx, agent, r, ownerTagPulse(time, alert.animated), alert.tag)
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
