// Canvas side of the node avatars (web/lib/avatar-bitmap.ts): the avatar's SVG markup becomes an offscreen canvas
// once per name, role and theme. Until the image has decoded (one task after the first request) the node keeps its
// old centre icon, so nothing ever flashes empty.
import { AVATAR_CORNER, AvatarBitmapCache, avatarSide, type AvatarTheme } from '@/lib/avatar-bitmap'

/** Bitmap side in device pixels: sharp up to about 2x zoom on a 3x phone screen, ~100 kB each. */
const SPRITE_PX = 160

/** A thin ring in the canvas's own background colour separates the tile from the hexagon's state ring. */
const RING: Record<AvatarTheme, string> = { light: '#FFFFFF', dark: '#05060A' }

export interface AvatarSprite {
  canvas: HTMLCanvasElement
  ready: boolean
}

function renderSprite(svg: string, req: { theme: AvatarTheme }): AvatarSprite {
  const canvas = document.createElement('canvas')
  canvas.width = SPRITE_PX
  canvas.height = SPRITE_PX
  const sprite: AvatarSprite = { canvas, ready: false }
  const img = new Image()
  img.onload = () => {
    const c = canvas.getContext('2d')
    if (!c) return
    const ring = SPRITE_PX * 0.035
    const rad = SPRITE_PX * AVATAR_CORNER
    c.save()
    c.beginPath()
    c.roundRect(0, 0, SPRITE_PX, SPRITE_PX, rad)
    c.clip()
    c.drawImage(img, 0, 0, SPRITE_PX, SPRITE_PX)
    c.restore()
    c.beginPath()
    c.roundRect(ring / 2, ring / 2, SPRITE_PX - ring, SPRITE_PX - ring, rad - ring / 2)
    c.strokeStyle = RING[req.theme]
    c.lineWidth = ring
    c.stroke()
    sprite.ready = true
  }
  // fixed pixel size: the generator's markup fills its parent (100%), which an <img> cannot size from
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('width="100%" height="100%"', `width="${SPRITE_PX}" height="${SPRITE_PX}"`))
  return sprite
}

let cache: AvatarBitmapCache<AvatarSprite> | null = null

export function avatarSprites(): AvatarBitmapCache<AvatarSprite> {
  if (!cache) cache = new AvatarBitmapCache(renderSprite)
  return cache
}

/**
 * Draws the avatar inside a node's hexagon (radius r) at the current globalAlpha, so a finished node dims and a
 * leaving one fades with its body. Returns false while the bitmap is still decoding (the caller draws the old icon).
 */
export function drawNodeAvatar(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number,
  name: string, coordinator: boolean, theme: AvatarTheme,
): boolean {
  const sprite = avatarSprites().get({ name, coordinator, theme })
  if (!sprite.ready) return false
  const s = avatarSide(r)
  ctx.drawImage(sprite.canvas, x - s / 2, y - s / 2, s, s)
  return true
}
