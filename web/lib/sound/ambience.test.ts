import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { detectStateChanges } from '../../components/agent-visualizer/canvas/detect-state-changes'
import type { Agent, ToolCallNode } from '../agent-types'
import { AudioEngine } from '../audio-engine'
import { AmbiencePlayer, ambienceFor, OWNER_PERIOD_S, WAITING_PERIOD_S, type AmbienceAgent, type AmbienceKind, type LoopSample } from './ambience'
import { FakeCtx, type AnyNode } from './fake-audio'
import { SampleBank, type FetchBytes } from './sample-bank'
import { loopKey, loopWindow, sampleUrls } from './samples'
import { createMasterBus } from './synth'

const NOW = 1_000_000

test('ambienceFor: a node in the owner state asks for the owner loop, and the owner state wins over waiting', () => {
  const a = (id: string, state: string, isMain = false): AmbienceAgent => ({ id, state, isMain })
  const owner = new Set(['m'])
  assert.deepEqual([...ambienceFor([a('m', 'waiting_permission', true)], NOW, owner)], ['owner'])
  assert.deepEqual([...ambienceFor([a('m', 'idle', true)], NOW, owner)], ['owner'])
  // another node still waits for permission: both loops
  assert.deepEqual([...ambienceFor([a('m', 'idle', true), a('s', 'waiting_permission')], NOW, owner)].sort(), ['owner', 'waiting'])
  // decision answered: no owner nodes, the waiting comes back
  assert.deepEqual([...ambienceFor([a('m', 'waiting_permission', true)], NOW, new Set())], ['waiting'])
})

/** A loop sample getter for the player: `ready` lists the kinds whose file is loaded. */
function loopFiles(ctx: FakeCtx, ready: Set<AmbienceKind>) {
  const buffers = new Map<AmbienceKind, AudioBuffer>()
  return (kind: AmbienceKind): LoopSample | null => {
    if (!ready.has(kind)) return null
    if (!buffers.has(kind)) buffers.set(kind, ctx.createBuffer(1, 8000, 8000) as unknown as AudioBuffer)
    return { buffer: buffers.get(kind)!, ...loopWindow(kind) }
  }
}

test('AmbiencePlayer: a loaded loop file loops over its one-period window, starts and stops with its state', () => {
  const ctx = new FakeCtx()
  const bus = createMasterBus(ctx as unknown as BaseAudioContext, 0.5)
  const player = new AmbiencePlayer(bus, () => 0.5, loopFiles(ctx, new Set(['owner', 'waiting', 'thinking', 'disintegrating'])))
  try {
    player.set(['owner'])
    const srcs = ctx.nodes.filter((n) => n.kind === 'buffer') as AnyNode[]
    assert.equal(srcs.length, 1)
    const src = srcs[0]
    assert.equal(src.loop, true)
    assert.equal(src.loopStart, loopWindow('owner').start)
    assert.equal(src.loopEnd, loopWindow('owner').end)
    assert.ok(Math.abs((src.loopEnd as number) - (src.loopStart as number) - 2.2) < 1e-9, 'one 2.2 s turn')
    assert.equal(src.startOffset, loopWindow('owner').start, 'starts inside the window')
    assert.equal(ctx.nodes.filter((n) => n.kind === 'oscillator' && (n as AnyNode).type === 'sawtooth').length, 0, 'no synth stand-in')
    assert.deepEqual(player.active(), ['owner'])
    player.set([])
    assert.deepEqual(player.active(), [], 'fading out')
  } finally {
    player.dispose()
  }
  const src = ctx.nodes.find((n) => n.kind === 'buffer') as AnyNode
  assert.notEqual(src.stopAt, null, 'the loop source is stopped on teardown')
})

test('AmbiencePlayer: before its file loads a loop plays the synthesised stand-in, then swaps to the file', async () => {
  const ctx = new FakeCtx()
  const bus = createMasterBus(ctx as unknown as BaseAudioContext, 0.5)
  const ready = new Set<AmbienceKind>()
  const player = new AmbiencePlayer(bus, () => 0.5, loopFiles(ctx, ready))
  try {
    player.set(['owner'])
    const thumps = (ctx.nodes.filter((n) => n.kind === 'oscillator') as AnyNode[]).filter((o) => o.type === 'sine' && o.startAt !== null)
    assert.ok(thumps.length >= 2, 'the stand-in double thump')
    assert.equal(ctx.nodes.filter((n) => n.kind === 'buffer' && (n as AnyNode).loop).length, 0)
    ready.add('owner')
    await new Promise((r) => setTimeout(r, 250)) // a scheduler tick
    const looping = ctx.nodes.filter((n) => n.kind === 'buffer' && (n as AnyNode).loop) as AnyNode[]
    assert.equal(looping.length, 1, 'swapped to the file')
    const before = ctx.nodes.length
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(ctx.nodes.length, before, 'no more synth grains after the swap')
  } finally {
    player.dispose()
  }
  assert.ok(OWNER_PERIOD_S === 2.2)
})

test('ambienceFor: waiting for permission, thinking, and a finished sub-agent before its offboard deadline', () => {
  const a = (state: string, extra: Partial<AmbienceAgent> = {}): AmbienceAgent => ({ state, isMain: false, ...extra })
  assert.deepEqual([...ambienceFor([], NOW)], [])
  assert.deepEqual([...ambienceFor([a('waiting_permission')], NOW)], ['waiting'])
  assert.deepEqual([...ambienceFor([a('thinking', { isMain: true })], NOW)], ['thinking'])
  const finished = { at: NOW - 1000, offboardAt: NOW + 1000 }
  assert.deepEqual([...ambienceFor([a('complete', { finished })], NOW)], ['disintegrating'])
  // past the deadline, the main agent, or not marked finished: no crackle
  assert.deepEqual([...ambienceFor([a('complete', { finished: { at: NOW - 2000, offboardAt: NOW - 1 } })], NOW)], [])
  assert.deepEqual([...ambienceFor([a('complete', { isMain: true, finished })], NOW)], [])
  assert.deepEqual([...ambienceFor([a('complete'), a('idle'), a('tool_calling')], NOW)], [])
  assert.deepEqual([...ambienceFor([a('thinking'), a('waiting_permission'), a('complete', { finished })], NOW)].sort(), ['disintegrating', 'thinking', 'waiting'])
})

test('AmbiencePlayer: starts with a fade-in and a pulse, fades out on stop, revives, and tears down on dispose', () => {
  const ctx = new FakeCtx()
  const bus = createMasterBus(ctx as unknown as BaseAudioContext, 0.5)
  let i = 0
  const player = new AmbiencePlayer(bus, () => (i++ * 0.37) % 1) // cycles through every phrase kind
  try {
    player.set(['waiting', 'disintegrating'])
    assert.deepEqual(player.active().sort(), ['disintegrating', 'waiting'])
    // grains were scheduled ahead, and every one of them is quiet
    const gains = ctx.nodes.filter((n) => n.kind === 'gain') as AnyNode[]
    const peaks = gains.flatMap((g) => (g.gain as { calls: [string, number, number][] }).calls.filter((c) => c[0] === 'linear').map((c) => c[1]))
    assert.ok(peaks.length > 0)
    for (const p of peaks) assert.ok(p <= 0.012, `grain peak ${p}`)
    // waiting is servo whir: buzzy saw oscillators gliding in pitch ("zuitt"), not fixed bleeps
    const saws = (ctx.nodes.filter((n) => n.kind === 'oscillator') as AnyNode[]).filter((o) => o.type === 'sawtooth')
    assert.ok(saws.length > 0, 'servo whines')
    for (const o of saws) assert.ok((o.frequency as { calls: [string, number, number][] }).calls.some((c) => c[0] === 'exp'), 'pitch glide')
    // each loop has a slow LFO (the swell in and out)
    const lfos = (ctx.nodes.filter((n) => n.kind === 'oscillator') as AnyNode[])
      .filter((o) => (o.frequency as { value: number }).value < 1)
    assert.ok(lfos.length >= 2)

    player.set(['waiting'])
    assert.deepEqual(player.active(), ['waiting'], 'disintegrating is fading out')
    player.set(['waiting', 'disintegrating'])
    assert.deepEqual(player.active().sort(), ['disintegrating', 'waiting'], 'revived before teardown')
  } finally {
    player.dispose()
  }
  assert.deepEqual(player.active(), [])
})

function engineSetup() {
  const fetchBytes: FetchBytes = async () => new Uint8Array([1]).buffer
  const bank = new SampleBank(sampleUrls('/'), fetchBytes)
  const contexts: FakeCtx[] = []
  const engine = new AudioEngine({
    samples: bank,
    createContext: () => {
      const c = new FakeCtx()
      contexts.push(c)
      return c as unknown as AudioContext
    },
  })
  return { engine, contexts, bank }
}

test('engine: background loops play only with sound on after a tap; muting stops them; the wish is kept', () => {
  const { engine } = engineSetup()
  try {
    engine.setAmbience(['thinking'])
    assert.deepEqual(engine.ambienceActive(), [], 'muted by default')
    engine.unlock()
    assert.deepEqual(engine.ambienceActive(), [], 'still muted')
    engine.setMuted(false)
    assert.deepEqual(engine.ambienceActive(), ['thinking'])
    engine.setMuted(true)
    assert.deepEqual(engine.ambienceActive(), [])
    engine.setMuted(false)
    assert.deepEqual(engine.ambienceActive(), ['thinking'], 'comes back with the sound')
    engine.setAmbience([])
    assert.deepEqual(engine.ambienceActive(), [])
  } finally {
    engine.dispose()
  }
})

test('engine: each of the four loops plays its loaded file while its state lasts, and stops with it', async () => {
  const { engine, contexts, bank } = engineSetup()
  try {
    engine.setMuted(false)
    engine.unlock()
    await engine.samplesSettled(1000)
    const ctx = contexts[0]
    for (const kind of ['owner', 'waiting', 'thinking', 'disintegrating'] as const) {
      const before = ctx.nodes.length
      engine.setAmbience([kind])
      assert.deepEqual(engine.ambienceActive(), [kind])
      const src = (ctx.nodes.slice(before) as AnyNode[]).find((n) => n.kind === 'buffer' && n.loop)
      assert.ok(src, `${kind} loops a file`)
      assert.equal(src.buffer, bank.get(loopKey(kind)), kind)
      assert.equal(src.loopStart, loopWindow(kind).start)
      assert.equal(src.loopEnd, loopWindow(kind).end)
      engine.setAmbience([])
      assert.deepEqual(engine.ambienceActive(), [], `${kind} stops with its state`)
    }
  } finally {
    engine.dispose()
  }
})

test('a tool first seen already done (start and result in one batch) still counts as start plus end', () => {
  const tool = (state: ToolCallNode['state']) => new Map([['t1', { state, x: 0, y: 0 } as unknown as ToolCallNode]])
  const none = new Map<string, Agent>()
  const kinds = (m: Map<string, ToolCallNode>, prev = new Map<string, string>()) =>
    detectStateChanges(none, m, new Map(), prev).transitions.map((t) => t.kind)
  assert.deepEqual(kinds(tool('complete')), ['tool_start', 'tool_complete'])
  assert.deepEqual(kinds(tool('error')), ['tool_start', 'tool_error'])
  assert.deepEqual(kinds(tool('running')), ['tool_start'])
  assert.deepEqual(kinds(tool('complete'), new Map([['t1', 'running']])), ['tool_complete'])
  assert.deepEqual(kinds(tool('complete'), new Map([['t1', 'complete']])), [], 'nothing twice')
})

test('waiting is steady: the same ziiing at a fixed pace, nothing random', () => {
  const ctx = new FakeCtx()
  const bus = createMasterBus(ctx as unknown as BaseAudioContext, 0.5)
  const player = new AmbiencePlayer(bus, () => { throw new Error('waiting must not use randomness') })
  try {
    player.set(['waiting'])
    const saws = (ctx.nodes.filter((n) => n.kind === 'oscillator') as AnyNode[]).filter((o) => o.type === 'sawtooth')
    const starts = saws.map((o) => o.startAt as number)
    assert.ok(starts.length >= 1)
    for (let i = 1; i < starts.length; i++) assert.ok(Math.abs(starts[i] - starts[i - 1] - WAITING_PERIOD_S) < 1e-9)
    const glides = saws.map((o) => JSON.stringify((o.frequency as { calls: unknown[] }).calls.map((c) => (c as number[]).slice(0, 2))))
    assert.equal(new Set(glides).size, 1, 'every ziiing has the same pitch sweep')
  } finally {
    player.dispose()
  }
})
