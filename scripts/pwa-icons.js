#!/usr/bin/env node
/**
 * Draws the PWA icons (web/public/pwa/*.png) from the same shapes as web/public/icon.svg, with no image library:
 * each pixel is sampled 4x4 and the result written as an RGBA PNG. Run it after changing the icon design:
 *   node scripts/pwa-icons.js
 * The PNGs are committed; the app build only copies them.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const OUT = path.join(__dirname, '..', 'web', 'public', 'pwa')

// Shapes of web/public/icon.svg, in its 64x64 view box.
const BG = [0x11, 0x18, 0x27]
const LINE = { color: [0x9c, 0xa3, 0xaf], width: 3, segments: [[32, 17, 17, 44], [32, 17, 47, 44], [17, 44, 47, 44]] }
const CIRCLES = [
  { x: 32, y: 17, r: 7, color: [0x60, 0xa5, 0xfa] },
  { x: 17, y: 44, r: 7, color: [0xe5, 0xe7, 0xeb] },
  { x: 47, y: 44, r: 7, color: [0xe5, 0xe7, 0xeb] },
]

function distToSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1
  const dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function insideRoundedRect(x, y, size, r) {
  const cx = Math.max(r, Math.min(size - r, x))
  const cy = Math.max(r, Math.min(size - r, y))
  return Math.hypot(x - cx, y - cy) <= r
}

/**
 * Colour at a point of the 64-unit icon. `rounded`: transparent outside the 14-unit corner radius (plain icon);
 * otherwise the background fills the square (maskable and Apple icons, whose corners the system cuts).
 * `scale`: the glyph is drawn smaller around the centre (maskable safe zone).
 */
function sample(x, y, { rounded, scale }) {
  if (rounded && !insideRoundedRect(x, y, 64, 14)) return null
  const gx = 32 + (x - 32) / scale
  const gy = 32 + (y - 32) / scale
  let color = BG
  if (LINE.segments.some((s) => distToSegment(gx, gy, s) <= LINE.width / 2)) color = LINE.color
  for (const c of CIRCLES) if (Math.hypot(gx - c.x, gy - c.y) <= c.r) color = c.color
  return color
}

function render(size, opts) {
  const SS = 4
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(((x + (sx + 0.5) / SS) / size) * 64, ((y + (sy + 0.5) / SS) / size) * 64, opts)
          if (!c) continue
          r += c[0]; g += c[1]; b += c[2]; a++
        }
      }
      const i = (y * size + x) * 4
      if (a) { px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a) }
      px[i + 3] = Math.round((a / (SS * SS)) * 255)
    }
  }
  return encodePng(size, px)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const ICONS = [
  { name: 'icon-192.png', size: 192, rounded: true, scale: 1 },
  { name: 'icon-512.png', size: 512, rounded: true, scale: 1 },
  // Maskable: full-bleed background, glyph inside the 80% safe zone.
  { name: 'icon-maskable-512.png', size: 512, rounded: false, scale: 0.8 },
  // iOS home screen: full square, iOS rounds the corners itself.
  { name: 'apple-touch-icon.png', size: 180, rounded: false, scale: 0.9 },
]

fs.mkdirSync(OUT, { recursive: true })
for (const icon of ICONS) {
  fs.writeFileSync(path.join(OUT, icon.name), render(icon.size, icon))
  console.log(`wrote web/public/pwa/${icon.name}`)
}
