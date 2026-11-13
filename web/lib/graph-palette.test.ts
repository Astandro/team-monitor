import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { graphPalette, PANEL_TOKENS, contrastRatio, luminance, type GraphTheme } from './graph-palette'
import { COLORS, ROLE_COLORS, applyGraphTheme, getGraphTheme, graphBloomEnabled, liveColor } from './colors'

const THEMES: GraphTheme[] = ['light', 'dark']
const CSS = fs.readFileSync(path.join(__dirname, '..', 'components', 'team-panel', 'team-panel.css'), 'utf-8')

/** `--name:#HEX` pairs inside the first rule whose selector is exactly `selector`. */
function cssTokens(selector: string, prefix = '--'): Record<string, string> {
  const start = CSS.indexOf(selector + '{')
  assert.ok(start >= 0, `no rule ${selector}`)
  const body = CSS.slice(start, CSS.indexOf('}', start))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(new RegExp(`${prefix}([a-z-]+):(#[0-9A-Fa-f]{6})`, 'g'))) out[m[1]] = m[2].toUpperCase()
  return out
}

const PANEL_SELECTOR: Record<GraphTheme, string> = { light: '.tm-themed', dark: '.tm-root[data-tm-theme="dark"] .tm-themed' }
const GRAPH_SELECTOR: Record<GraphTheme, string> = { light: '.tm-pane-graph', dark: '.tm-root[data-tm-theme="dark"] .tm-pane-graph' }
const SHARED = ['bg', 'surface', 'sunk', 'ink', 'muted', 'line', 'accent'] as const

for (const theme of THEMES) {
  test(`${theme}: the graph tokens are the panel's tokens (team-panel.css)`, () => {
    const panel = cssTokens(PANEL_SELECTOR[theme])
    const chrome = cssTokens(GRAPH_SELECTOR[theme], '--g-')
    const t = PANEL_TOKENS[theme]
    for (const k of [...SHARED, 'done', 'review', 'blocked'] as const) assert.equal(t[k], panel[k], `${theme} --${k}`)
    for (const k of SHARED) assert.equal(chrome[k], panel[k], `${theme} --g-${k}`)
  })

  test(`${theme}: canvas is the panel background`, () => {
    assert.equal(graphPalette(theme).void, PANEL_TOKENS[theme].bg)
  })

  test(`${theme}: status colours keep their meaning and reach 3:1 on the canvas`, () => {
    const p = graphPalette(theme)
    const t = PANEL_TOKENS[theme]
    assert.equal(p.thinking, t.accent, 'activity is the accent')
    assert.equal(p.complete, t.done)
    assert.equal(p.error, t.blocked)
    assert.equal(p.tool_calling, t.review)
    assert.equal(p.idle, t.ink, 'nodes are ink')
    const status = [p.idle, p.thinking, p.tool_calling, p.complete, p.error, p.waiting_permission, p.dispatch, p.return, p.message]
    for (const c of status) {
      for (const bg of [t.bg, t.surface]) assert.ok(contrastRatio(c, bg) >= 3, `${theme} ${c} on ${bg}: ${contrastRatio(c, bg).toFixed(2)}`)
    }
  })

  test(`${theme}: text colours reach 4.5:1 on the canvas and on cards`, () => {
    const p = graphPalette(theme)
    const t = PANEL_TOKENS[theme]
    const text = {
      textPrimary: p.textPrimary, textDim: p.textDim, textMuted: p.textMuted, textFaint: p.textFaint,
      roleAssistantText: p.roleAssistantText, roleThinkingText: p.roleThinkingText, roleUserText: p.roleUserText,
      userLabel: p.userLabel, userText: p.userText, assistantLabel: p.assistantLabel, assistantText: p.assistantText,
      thinkingLabel: p.thinkingLabel, toolResultText: p.toolResultText, bashResultText: p.bashResultText,
      panelLabel: p.panelLabel, panelLabelDim: p.panelLabelDim, costText: p.costText, costTextDim: p.costTextDim,
      liveText: p.liveText, toolIndicatorText: p.toolIndicatorText, filePathActive: p.filePathActive,
      filePathInactive: p.filePathInactive, diffRemoved: p.diffRemoved, diffAdded: p.diffAdded,
    }
    for (const [k, c] of Object.entries(text)) {
      for (const bg of [t.bg, t.surface, t.sunk]) {
        assert.ok(contrastRatio(c, bg) >= 4.5, `${theme} ${k} ${c} on ${bg}: ${contrastRatio(c, bg).toFixed(2)}`)
      }
    }
  })
}

/** [r, g, b] of a #RRGGBB colour */
function rgbOf(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

test('Terang (owner 13 Nov): mostly white, blue accent for interactive and active things', () => {
  const t = PANEL_TOKENS.light
  // white surfaces and a near-white background, not bone-white: no warm cast
  assert.equal(t.surface, '#FFFFFF')
  assert.ok(luminance(t.bg) > 0.9, `background ${t.bg} is not near white`)
  const [br, , bb] = rgbOf(t.bg)
  assert.ok(bb >= br, `background ${t.bg} is warm (bone-white look)`)
  // the accent is clearly blue
  const [r, g, b] = rgbOf(t.accent)
  assert.ok(b > r + 80 && b > g + 40, `accent ${t.accent} is not blue`)
  const p = graphPalette('light')
  assert.equal(p.thinking, t.accent, 'active node ring is the accent')
  assert.equal(p.message, t.accent, 'edges in flight are the accent')
  assert.equal(p.toggleActive.startsWith(`rgba(${r}, ${g}, ${b},`), true, 'active toggles use the accent')
})

test('Gelap (owner 13 Nov): near-black night sky, cards dark grey just above black', () => {
  const t = PANEL_TOKENS.dark
  assert.ok(luminance(t.bg) < 0.005, `background ${t.bg} is not near black`)
  for (const k of ['surface', 'sunk'] as const) {
    const l = luminance(t[k])
    assert.ok(l > luminance(t.bg) && l < 0.03, `${k} ${t[k]} is not a dark grey just above black`)
    const [r, g, b] = rgbOf(t[k])
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 12, `${k} ${t[k]} is tinted, not grey`)
  }
  assert.ok(contrastRatio(t.surface, t.bg) >= 1.1, 'cards stand off the sky')
})

test('the default floating card (globals.css, VS Code webview) uses the Gelap tokens', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'globals.css'), 'utf-8')
  const start = css.indexOf('.glass-card {')
  const body = css.slice(start, css.indexOf('}', start))
  assert.match(body, new RegExp(`background: ${PANEL_TOKENS.dark.surface}`, 'i'))
  assert.match(body, new RegExp(`border: 1px solid ${PANEL_TOKENS.dark.line}`, 'i'))
})

test('the two themes differ in every surface token (no warm leftovers from the old palette)', () => {
  const old = ['#F6F1E7', '#FFFDF8', '#EFE8DA', '#15130F', '#1E1B16', '#26221B', '#1D6B66', '#62C3B9']
  for (const theme of THEMES) {
    for (const v of Object.values(PANEL_TOKENS[theme])) assert.ok(!old.includes(v), `${theme} still uses ${v}`)
  }
})

test('both themes define the same keys, solid colours stay 6-digit hex, bases stay partial rgba', () => {
  const light = graphPalette('light')
  const dark = graphPalette('dark')
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort())
  for (const p of [light, dark]) {
    for (const [k, v] of Object.entries(p)) {
      if (v.startsWith('#')) assert.match(v, /^#[0-9A-Fa-f]{6}$/, k)
      if (k.endsWith('Base') && k !== 'holoBase') assert.match(v, /^rgba\(\d+, \d+, \d+,$/, k)
    }
  }
})

test('applyGraphTheme swaps the live palette in place; stored colours follow; bloom only in the dark', () => {
  applyGraphTheme('dark')
  const before = COLORS
  assert.equal(COLORS.void, PANEL_TOKENS.dark.bg)
  assert.equal(graphBloomEnabled(), true)
  const storedDone = COLORS.complete

  applyGraphTheme('light')
  assert.equal(COLORS, before, 'same object, so draw code needs no new reference')
  assert.equal(getGraphTheme(), 'light')
  assert.equal(COLORS.void, PANEL_TOKENS.light.bg)
  assert.equal(ROLE_COLORS.assistant.text, PANEL_TOKENS.light.accent)
  assert.equal(graphBloomEnabled(), false)
  assert.equal(liveColor(storedDone), PANEL_TOKENS.light.done, 'a dark green stored earlier draws as the light green')
  assert.equal(liveColor('#123456'), '#123456', 'unknown colours are kept')

  applyGraphTheme('dark')
  assert.equal(liveColor(PANEL_TOKENS.light.accent), PANEL_TOKENS.dark.accent)
})
