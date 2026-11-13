/**
 * Bot avatars (owner feedback 13 Nov): every team member gets a small friendly robot head generated from its name,
 * the same everywhere (team list, task bubbles, the graph's node card, chat). Pure and deterministic: the name is
 * hashed (FNV-1a) and the hash picks a tile colour and four parts (head, eyes, top, mouth). Inline SVG, no images,
 * no network. The name itself never goes into the markup.
 *
 * Colours: one fixed palette for both themes. Every tile is a mid tone that stands off the light and the dark
 * backgrounds and cards by at least 3:1, and the white face on it reads at 4.5:1 or more (tested).
 * The coordinator has its own look: a hexagon head (the Orchestrator's hexagon on the graph), a three-point
 * crown antenna and a colour no member gets.
 */

export const BOT_PALETTE = [
  '#2F6FD6', // blue
  '#6A5ACD', // violet
  '#B0408C', // magenta
  '#C2452D', // red
  '#B5591E', // orange
  '#9A6A00', // gold
  '#3A7A2A', // green
  '#0F7C86', // teal
  '#D0367A', // pink
  '#5B6B85', // slate
] as const

export const COORDINATOR_BG = '#4F62D9'
export const BOT_FACE = '#FFFFFF'

export const HEADS = ['round', 'square', 'dome', 'wide'] as const
export const EYES = ['dots', 'visor', 'tall', 'single'] as const
export const TOPS = ['antenna', 'twin', 'ears', 'bolt'] as const
export const MOUTHS = ['line', 'grille', 'smile', 'none'] as const

export interface BotSpec {
  bg: string
  head: (typeof HEADS)[number] | 'hex'
  eyes: (typeof EYES)[number]
  top: (typeof TOPS)[number] | 'crown'
  mouth: (typeof MOUTHS)[number]
}

/** FNV-1a 32-bit over the trimmed, lower-cased name, so "Orion" and " orion" match. */
export function hashName(name: string): number {
  const s = name.trim().toLowerCase()
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // final avalanche so short names that differ in one letter still spread over every part
  h ^= h >>> 16
  h = Math.imul(h, 0x45d9f3b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

export function botSpec(name: string, opts: { coordinator?: boolean } = {}): BotSpec {
  const h = hashName(name || '?')
  const pick = <T,>(list: readonly T[], shift: number) => list[(h >>> shift) % list.length]
  if (opts.coordinator) {
    return { bg: COORDINATOR_BG, head: 'hex', eyes: pick(['visor', 'dots'] as const, 3), top: 'crown', mouth: 'smile' }
  }
  return {
    bg: BOT_PALETTE[h % BOT_PALETTE.length],
    head: pick(HEADS, 5),
    eyes: pick(EYES, 9),
    top: pick(TOPS, 13),
    mouth: pick(MOUTHS, 17),
  }
}

interface HeadBox {
  x: number
  y: number
  w: number
  h: number
}

const HEAD_BOX: Record<BotSpec['head'], HeadBox> = {
  round: { x: 8, y: 11, w: 16, h: 14 },
  square: { x: 8.5, y: 11, w: 15, h: 14 },
  dome: { x: 8, y: 10, w: 16, h: 15 },
  wide: { x: 6, y: 12, w: 20, h: 12 },
  hex: { x: 7, y: 9.5, w: 18, h: 16 },
}

const f = (n: number) => String(Math.round(n * 10) / 10)

function headShape(spec: BotSpec, b: HeadBox): string {
  const fill = `fill="${BOT_FACE}"`
  switch (spec.head) {
    case 'round':
      return `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="6" ${fill}/>`
    case 'square':
      return `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="2.5" ${fill}/>`
    case 'wide':
      return `<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" rx="4" ${fill}/>`
    case 'dome': {
      const r = b.w / 2
      return `<path d="M${f(b.x)} ${f(b.y + r)}a${f(r)} ${f(r)} 0 0 1 ${f(b.w)} 0V${f(b.y + b.h - 2)}a2 2 0 0 1-2 2H${f(b.x + 2)}a2 2 0 0 1-2-2z" ${fill}/>`
    }
    case 'hex': {
      const cx = b.x + b.w / 2
      const cy = b.y + b.h / 2
      const rx = b.w / 2
      const ry = b.h / 2
      const pts = [
        [cx - rx / 2, cy - ry], [cx + rx / 2, cy - ry], [cx + rx, cy],
        [cx + rx / 2, cy + ry], [cx - rx / 2, cy + ry], [cx - rx, cy],
      ].map(([x, y]) => `${f(x)},${f(y)}`).join(' ')
      return `<polygon points="${pts}" stroke="${BOT_FACE}" stroke-width="1.5" stroke-linejoin="round" ${fill}/>`
    }
  }
}

function topShape(spec: BotSpec, b: HeadBox): string {
  const cx = b.x + b.w / 2
  const line = `stroke="${BOT_FACE}" stroke-width="1.6" stroke-linecap="round"`
  switch (spec.top) {
    case 'antenna':
      return `<path d="M${f(cx)} ${f(b.y)}V${f(b.y - 4)}" ${line}/><circle cx="${f(cx)}" cy="${f(b.y - 5)}" r="1.8" fill="${BOT_FACE}"/>`
    case 'twin':
      return `<path d="M${f(cx - 4)} ${f(b.y)}l-2 -4M${f(cx + 4)} ${f(b.y)}l2 -4" ${line}/>` +
        `<circle cx="${f(cx - 6)}" cy="${f(b.y - 4.6)}" r="1.4" fill="${BOT_FACE}"/><circle cx="${f(cx + 6)}" cy="${f(b.y - 4.6)}" r="1.4" fill="${BOT_FACE}"/>`
    case 'ears': {
      const ey = b.y + b.h / 2 - 3
      return `<rect x="${f(b.x - 2.6)}" y="${f(ey)}" width="3" height="6" rx="1.2" fill="${BOT_FACE}"/>` +
        `<rect x="${f(b.x + b.w - 0.4)}" y="${f(ey)}" width="3" height="6" rx="1.2" fill="${BOT_FACE}"/>`
    }
    case 'bolt':
      return `<rect x="${f(cx - 3)}" y="${f(b.y - 3)}" width="6" height="3.4" rx="1" fill="${BOT_FACE}"/>`
    case 'crown':
      return `<path d="M${f(cx - 5)} ${f(b.y + 0.5)}l-1 -4M${f(cx)} ${f(b.y)}v-4.6M${f(cx + 5)} ${f(b.y + 0.5)}l1 -4" ${line}/>` +
        `<circle cx="${f(cx - 6.2)}" cy="${f(b.y - 4.4)}" r="1.4" fill="${BOT_FACE}"/><circle cx="${f(cx)}" cy="${f(b.y - 5.6)}" r="1.7" fill="${BOT_FACE}"/><circle cx="${f(cx + 6.2)}" cy="${f(b.y - 4.4)}" r="1.4" fill="${BOT_FACE}"/>`
  }
}

function eyeShapes(spec: BotSpec, b: HeadBox): string {
  const ink = `fill="${spec.bg}"`
  const cx = b.x + b.w / 2
  const ey = b.y + b.h * 0.42
  const dx = Math.min(4.2, b.w * 0.24)
  switch (spec.eyes) {
    case 'dots':
      return `<circle cx="${f(cx - dx)}" cy="${f(ey)}" r="1.9" ${ink}/><circle cx="${f(cx + dx)}" cy="${f(ey)}" r="1.9" ${ink}/>`
    case 'visor':
      return `<rect x="${f(cx - dx - 2.4)}" y="${f(ey - 1.8)}" width="${f(2 * dx + 4.8)}" height="3.6" rx="1.8" ${ink}/>`
    case 'tall':
      return `<rect x="${f(cx - dx - 1.2)}" y="${f(ey - 2.6)}" width="2.4" height="5.2" rx="1.2" ${ink}/><rect x="${f(cx + dx - 1.2)}" y="${f(ey - 2.6)}" width="2.4" height="5.2" rx="1.2" ${ink}/>`
    case 'single':
      return `<circle cx="${f(cx)}" cy="${f(ey)}" r="3" ${ink}/><circle cx="${f(cx + 0.9)}" cy="${f(ey - 0.9)}" r="0.9" fill="${BOT_FACE}"/>`
  }
}

function mouthShape(spec: BotSpec, b: HeadBox): string {
  const cx = b.x + b.w / 2
  const my = b.y + b.h * 0.76
  const stroke = `stroke="${spec.bg}" stroke-width="1.5" stroke-linecap="round" fill="none"`
  switch (spec.mouth) {
    case 'line':
      return `<path d="M${f(cx - 3)} ${f(my)}h6" ${stroke}/>`
    case 'grille':
      return `<path d="M${f(cx - 3)} ${f(my - 1)}v2M${f(cx)} ${f(my - 1)}v2M${f(cx + 3)} ${f(my - 1)}v2" ${stroke}/>`
    case 'smile':
      return `<path d="M${f(cx - 3)} ${f(my - 1)}q3 2.6 6 0" ${stroke}/>`
    case 'none':
      return ''
  }
}

/** The avatar as SVG markup (32 x 32 view box, scales to any size). Same name and role: same markup. */
export function botAvatarSvg(name: string, opts: { coordinator?: boolean } = {}): string {
  const spec = botSpec(name, opts)
  const b = HEAD_BOX[spec.head]
  return (
    '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" width="100%" height="100%">' +
    `<rect width="32" height="32" fill="${spec.bg}"/>` +
    topShape(spec, b) +
    headShape(spec, b) +
    eyeShapes(spec, b) +
    mouthShape(spec, b) +
    '</svg>'
  )
}
