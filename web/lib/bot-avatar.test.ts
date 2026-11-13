import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOT_FACE, BOT_PALETTE, botAvatarSvg, botSpec, COORDINATOR_BG, hashName } from './bot-avatar'
import { contrastRatio, PANEL_TOKENS } from './graph-palette'

// Names the team actually uses (handovers and state.json), more than the 12 the spec asks for
const NAMES = ['Sora', 'Kaito', 'Haruki', 'Citra', 'Kenta', 'Haruto', 'Orion', 'Hana', 'Aoi', 'Yuto', 'Riku', 'Felix',
  'Mei', 'Yuki', 'Ren', 'Daichi', 'Takumi', 'Sota']

test('same name gives the same SVG, also after trimming and case changes', () => {
  for (const n of NAMES) {
    assert.equal(botAvatarSvg(n), botAvatarSvg(n))
    assert.equal(botAvatarSvg(n), botAvatarSvg(` ${n.toUpperCase()} `))
  }
  assert.equal(hashName('Orion'), hashName('orion'))
})

test('every one of the team names gets its own avatar (colour or shape differs)', () => {
  const svgs = new Set(NAMES.map((n) => botAvatarSvg(n)))
  assert.equal(svgs.size, NAMES.length)
})

test('different names mostly differ in colour, and every part varies across the team', () => {
  const specs = NAMES.map((n) => botSpec(n))
  let pairs = 0
  let sameColour = 0
  for (let i = 0; i < specs.length; i++) {
    for (let j = i + 1; j < specs.length; j++) {
      pairs++
      if (specs[i].bg === specs[j].bg) sameColour++
    }
  }
  assert.ok(sameColour / pairs < 0.2, `${sameColour} of ${pairs} pairs share a colour`)
  assert.ok(new Set(specs.map((s) => s.bg)).size >= 7, 'at least 7 of the 10 colours in use')
  for (const k of ['head', 'eyes', 'top', 'mouth'] as const) {
    assert.ok(new Set(specs.map((s) => s[k])).size >= 3, `${k} varies`)
  }
})

test('a one-letter difference in the name still changes the avatar', () => {
  assert.notEqual(botAvatarSvg('Haruki'), botAvatarSvg('Haruto'))
  assert.notEqual(botAvatarSvg('Ren'), botAvatarSvg('Rin'))
})

test('the coordinator has its own look: hexagon head, crown, a colour no member gets', () => {
  const lead = botSpec('Sora', { coordinator: true })
  assert.equal(lead.head, 'hex')
  assert.equal(lead.top, 'crown')
  assert.equal(lead.bg, COORDINATOR_BG)
  assert.ok(!(BOT_PALETTE as readonly string[]).includes(COORDINATOR_BG))
  assert.notEqual(botAvatarSvg('Sora', { coordinator: true }), botAvatarSvg('Sora'))
  for (const n of NAMES) {
    const s = botSpec(n)
    assert.notEqual(s.head, 'hex')
    assert.notEqual(s.top, 'crown')
  }
})

test('tiles stand off every background and card in light and dark (3:1), the face reads on the tile (4.5:1)', () => {
  for (const c of [...BOT_PALETTE, COORDINATOR_BG]) {
    for (const theme of ['light', 'dark'] as const) {
      const t = PANEL_TOKENS[theme]
      for (const bg of [t.bg, t.surface, t.sunk]) {
        assert.ok(contrastRatio(c, bg) >= 3, `${theme} ${c} on ${bg}: ${contrastRatio(c, bg).toFixed(2)}`)
      }
    }
    assert.ok(contrastRatio(BOT_FACE, c) >= 4.5, `face on ${c}: ${contrastRatio(BOT_FACE, c).toFixed(2)}`)
  }
})

test('the markup is inert: an SVG of shapes only, the name never appears in it', () => {
  const svg = botAvatarSvg('<img src=x onerror=alert(1)>')
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'))
  assert.ok(!svg.includes('img') && !svg.includes('onerror'))
  assert.ok(!/<(script|image|foreignObject|text)\b/.test(svg))
  assert.ok(!botAvatarSvg('Orion').includes('Orion'))
})
