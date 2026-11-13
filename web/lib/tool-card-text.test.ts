import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toolCardText, toolCardHeight, TOOL_CARD_MIN_W, TOOL_CARD_PAD } from './tool-card-text'

// monospace like the canvas: 8 px font about 4.8 px per character, 6 px font about 3.6
const main = (s: string) => s.length * 4.8
const top = (s: string) => s.length * 3.6
const MAX = 160

const owner = 'cd /Users/example-developer-account/projects/my-app && npm test'

describe('tool card for a shell command', () => {
  it('owner case: the action is the main line, the label and folder sit above it', () => {
    const c = toolCardText({ toolName: 'Bash', args: owner.slice(0, 80), inputData: { command: owner }, state: 'running' }, MAX, main, top)
    assert.equal(c.main, 'npm test')
    assert.equal(c.top, 'Jalanin perintah di my-app')
    assert.equal(c.topDir, ' di my-app')
    assert.ok(!c.main.includes('cd /Users'))
  })
  it('a long action is shortened in the middle: start and end both readable, card never wider than the max', () => {
    const cmd = 'cd /Users/a/projects/team-monitor-wt/haze-commands && npx -y pnpm@10 --dir web exec tsc --noEmit'
    const c = toolCardText({ toolName: 'Bash', args: '', inputData: { command: cmd }, state: 'running' }, MAX, main, top)
    assert.ok(c.main.startsWith('npx -y pnpm@10'), c.main)
    assert.ok(c.main.endsWith('--noEmit'), c.main)
    assert.ok(c.main.includes('…'))
    assert.ok(main(c.main) <= MAX - TOOL_CARD_PAD)
    assert.ok(c.width <= MAX)
  })
  it('the folder is left out when it does not fit, the label stays', () => {
    const cmd = 'cd /x/a-very-long-folder-name-that-takes-the-whole-card-and-more && make'
    const c = toolCardText({ toolName: 'Bash', inputData: { command: cmd }, state: 'running' }, MAX, main, top)
    assert.equal(c.top, 'Jalanin perintah')
    assert.equal(c.topDir, null)
    assert.equal(c.main, 'make')
  })
  it('tokens join the top line once done; the card grows to the expanded height', () => {
    const tool = { toolName: 'Bash', inputData: { command: 'cd /r/app && npm test' }, state: 'complete' as const, tokenCost: 412 }
    const c = toolCardText(tool, MAX, main, top)
    assert.equal(c.top, 'Jalanin perintah di app · 412 token')
    assert.equal(toolCardHeight(tool, c, 24, 30), 30)
    assert.equal(toolCardHeight({ ...tool, state: 'running' }, toolCardText({ ...tool, state: 'running' }, MAX, main, top), 24, 30), 24)
  })
  it('a failed command keeps the one-line layout (the error message is the second line)', () => {
    const c = toolCardText({ toolName: 'Bash', inputData: { command: 'cd /a && npm test' }, state: 'error' }, MAX, main, top)
    assert.equal(c.top, null)
    assert.equal(c.main, 'Jalanin perintah: npm test')
  })
  it('Codex exec_command gets the same treatment', () => {
    const c = toolCardText({ toolName: 'exec_command', args: 'bash -lc "cd /w/site && npm run build"', state: 'running' }, MAX, main, top)
    assert.equal(c.main, 'npm run build')
    assert.equal(c.topDir, ' di site')
  })
  it('short card: never narrower than the minimum', () => {
    const c = toolCardText({ toolName: 'Bash', inputData: { command: 'ls' }, state: 'running' }, MAX, main, top)
    assert.ok(c.width >= TOOL_CARD_MIN_W)
    assert.equal(c.main, 'ls')
  })
})

describe('tool card for other tools', () => {
  it('one line, label whole, a long path shortened in the middle so the file name stays', () => {
    const c = toolCardText({ toolName: 'Read', args: '/Users/example-developer-account/projects/team-monitor-wt/haze-commands/web/lib/sky.ts', state: 'running' }, MAX, main, top)
    assert.equal(c.top, null)
    assert.ok(c.main.startsWith('Baca file: '), c.main)
    assert.ok(c.main.endsWith('sky.ts'), c.main)
    assert.ok(main(c.main) <= MAX - TOOL_CARD_PAD)
  })
  it('short args are shown whole', () => {
    const c = toolCardText({ toolName: 'Grep', args: 'nebula', state: 'complete', tokenCost: 10 }, MAX, main, top)
    assert.equal(c.main, 'Cari isi file: nebula')
    assert.equal(toolCardHeight({ toolName: 'Grep', state: 'complete', tokenCost: 10 }, c, 24, 30), 30)
  })
})
