import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { detectStateChanges } from '../../components/agent-visualizer/canvas/detect-state-changes'
import type { Agent, ToolCallNode } from '../agent-types'
import { AudioEngine } from '../audio-engine'
import { AmbiencePlayer, ambienceFor, type AmbienceAgent } from './ambience'
import { FakeCtx, type AnyNode } from './fake-audio'
import { SampleBank, type FetchBytes } from './sample-bank'
import { sampleUrls, SYNTH_ONLY_CUES } from './samples'
import { createMasterBus } from './synth'

const NOW = 1_000_000

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
  return { engine, contexts }
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

test('engine: the tool meteors are synthesised even when their sample files loaded', async () => {
  const { engine, contexts } = engineSetup()
  try {
    engine.setMuted(false)
    engine.unlock()
    await engine.samplesSettled(1000)
    const ctx = contexts[0]
    for (const cue of SYNTH_ONLY_CUES) {
      const before = ctx.nodes.length
      engine.play(cue)
      const created = ctx.nodes.slice(before)
      assert.ok(created.length > 1, `${cue} builds synth voices`)
      assert.ok(created.some((n) => n.kind === 'oscillator' || n.kind === 'buffer'))
    }
    assert.deepEqual([...SYNTH_ONLY_CUES].sort(), ['tool_complete', 'tool_start'])
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
