import { COLORS, getGraphTheme } from '@/lib/colors'
import { alphaHex } from '@/lib/utils'
import { skyAlpha, skyTints, type SkyParticle } from '@/lib/sky'

const HEX_GRID_SIZE = 60

export function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  particles: SkyParticle[],
  transform: { x: number; y: number; scale: number },
  showHexGrid: boolean,
  time: number,
  reducedMotion: boolean,
  activeAgentPos?: { x: number; y: number; color: string },
): void {
  // Deep void
  ctx.fillStyle = COLORS.void
  ctx.fillRect(0, 0, width, height)

  // Ambient spotlight following active agent
  if (activeAgentPos) {
    const screenX = activeAgentPos.x * transform.scale + transform.x
    const screenY = activeAgentPos.y * transform.scale + transform.y
    const gradient = ctx.createRadialGradient(screenX, screenY, 0, screenX, screenY, 300)
    gradient.addColorStop(0, activeAgentPos.color + '08')
    gradient.addColorStop(1, 'transparent')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
  }

  // Sky particles with parallax: soft blue dust (Terang) or twinkling white and gold stars (Gelap), see lib/sky.ts
  const theme = getGraphTheme()
  const tints = skyTints(theme)
  for (const p of particles) {
    const parallaxFactor = 0.3 + p.depth * 0.7
    const px = p.x + transform.x * parallaxFactor * 0.1
    const py = p.y + transform.y * parallaxFactor * 0.1
    if (px < -4 || py < -4 || px > width + 4 || py > height + 4) continue
    const size = p.size * (0.5 + p.depth * 0.5)
    const alpha = skyAlpha(p, theme, time, reducedMotion)

    ctx.beginPath()
    ctx.fillStyle = (tints[p.tint] ?? tints[0]) + alphaHex(alpha)
    ctx.arc(px, py, size, 0, Math.PI * 2)
    ctx.fill()
  }

  // Hex grid (optional)
  if (showHexGrid) {
    drawHexGrid(ctx, width, height, transform, reducedMotion ? 0 : time)
  }
}

// Pre-computed hex vertex offsets (avoids trig per vertex per frame)
const HEX_OFFSETS = Array.from({ length: 6 }, (_, i) => {
  const angle = (Math.PI / 3) * i - Math.PI / 2
  return { cos: Math.cos(angle), sin: Math.sin(angle) }
})

function drawHexGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  transform: { x: number; y: number; scale: number },
  time: number,
): void {
  ctx.save()
  ctx.translate(transform.x, transform.y)
  ctx.scale(transform.scale, transform.scale)

  const size = HEX_GRID_SIZE
  const hexHeight = size * Math.sqrt(3)
  const startX = Math.floor(-transform.x / transform.scale / (size * 1.5)) * (size * 1.5) - size * 3
  const startY = Math.floor(-transform.y / transform.scale / hexHeight) * hexHeight - hexHeight * 2
  const endX = startX + width / transform.scale + size * 6
  const endY = startY + height / transform.scale + hexHeight * 4

  const r = size * 0.4
  ctx.strokeStyle = COLORS.hexGrid
  ctx.lineWidth = 0.5

  // Quantize alpha into buckets to batch hexagons into fewer draw calls
  const buckets = new Map<number, Array<[number, number]>>()
  const timeSin = time * 0.5

  for (let x = startX; x < endX; x += size * 1.5) {
    for (let y = startY; y < endY; y += hexHeight) {
      const offsetY = ((x - startX) / (size * 1.5)) % 2 === 0 ? 0 : hexHeight / 2
      const cx = x
      const cy = y + offsetY
      const dist = Math.sqrt(cx * cx + cy * cy)
      const pulse = Math.sin(timeSin + dist * 0.005) * 0.3 + 0.7
      // Quantize to 4 alpha levels to batch draws
      const alpha = Math.round(0.15 * pulse * 40) / 40
      let bucket = buckets.get(alpha)
      if (!bucket) { bucket = []; buckets.set(alpha, bucket) }
      bucket.push([cx, cy])
    }
  }

  // Draw each alpha bucket as a single batched path
  for (const [alpha, hexes] of buckets) {
    ctx.globalAlpha = alpha
    ctx.beginPath()
    for (const [cx, cy] of hexes) {
      ctx.moveTo(cx + r * HEX_OFFSETS[0].cos, cy + r * HEX_OFFSETS[0].sin)
      for (let i = 1; i < 6; i++) {
        ctx.lineTo(cx + r * HEX_OFFSETS[i].cos, cy + r * HEX_OFFSETS[i].sin)
      }
      ctx.closePath()
    }
    ctx.stroke()
  }

  ctx.globalAlpha = 1
  ctx.restore()
}
