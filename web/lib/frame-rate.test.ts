import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { graphFrameMode, graphFrameRate, graphPaneVisible, resumeDelta } from './frame-rate'

test('the graph draws every frame only while it is on screen', () => {
  assert.equal(graphFrameMode({ paneVisible: true, pageVisible: true }), 'every-frame')
  assert.equal(graphFrameRate({ paneVisible: true, pageVisible: true }), Infinity)
})

test('behind the Tim tab (hidden pane) the graph does not draw at all', () => {
  assert.equal(graphFrameMode({ paneVisible: false, pageVisible: true }), 'paused')
  assert.equal(graphFrameRate({ paneVisible: false, pageVisible: true }), 0)
})

test('a page in the background does not draw either, whichever tab is chosen', () => {
  assert.equal(graphFrameMode({ paneVisible: true, pageVisible: false }), 'paused')
  assert.equal(graphFrameMode({ paneVisible: false, pageVisible: false }), 'paused')
})

test('the graph pane is on screen on desktop always, on phone and tablet only on the Grafik tab', () => {
  assert.equal(graphPaneVisible('tim', true), true, 'desktop: panel column next to the graph')
  assert.equal(graphPaneVisible('grafik', true), true)
  assert.equal(graphPaneVisible('grafik', false), true)
  assert.equal(graphPaneVisible('tim', false), false, 'phone, Tim tab: graph hidden')
})

test('after a pause the first frame advances the clock by one frame, not by the pause', () => {
  const fallback = 1 / 60
  assert.equal(resumeDelta(0, 5000, fallback), fallback, 'first frame ever')
  assert.equal(resumeDelta(1000, 61_000, fallback), fallback, 'a minute behind the Tim tab')
  assert.ok(Math.abs(resumeDelta(1000, 1016.7, fallback) - 0.0167) < 1e-9, 'normal frame keeps its real delta')
  assert.equal(resumeDelta(2000, 1000, fallback), fallback, 'clock going backwards')
})

test('the canvas stops scheduling frames while paused and the app passes the pane state down', () => {
  const root = join(__dirname, '..')
  const canvas = readFileSync(join(root, 'components', 'agent-visualizer', 'canvas.tsx'), 'utf8')
  const draw = canvas.slice(canvas.indexOf('const draw = useCallback'), canvas.indexOf('drawRef.current = draw'))
  const pausedAt = draw.indexOf("frameModeRef.current === 'paused'")
  const scheduleAt = draw.indexOf('requestAnimationFrame(')
  assert.ok(pausedAt >= 0 && scheduleAt > pausedAt, 'the draw returns before it asks for the next frame when paused')
  assert.match(canvas, /graphFrameMode\(\{ paneVisible: active, pageVisible \}\)/)
  const app = readFileSync(join(root, 'components', 'team-panel', 'team-app.tsx'), 'utf8')
  assert.match(app, /graphPaneVisible\(pane, desktop\)/)
  assert.match(app, /<AgentVisualizer[^>]*active=\{graphOnScreen\}/)
})

test('the Tim tab animations run on the compositor: opacity and transform only, no box-shadow or background', () => {
  const css = readFileSync(join(__dirname, '..', 'components', 'team-panel', 'team-panel.css'), 'utf8')
  const frames = [...css.matchAll(/@keyframes ([\w-]+)\{(.*?\})\}/g)]
  assert.ok(frames.length >= 4, 'keyframes found')
  for (const [, name, body] of frames) {
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1])
    for (const p of props) assert.ok(p === 'opacity' || p === 'transform', `@keyframes ${name} animates ${p}`)
  }
})
