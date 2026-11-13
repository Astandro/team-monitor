import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SoundCue } from './cues'
import { RECIPES, recipeDuration, type Voice } from './recipes'
import { createMasterBus, LIMITER, scheduleCue, spaceImpulse, whiteNoise } from './synth'

// ─── a minimal fake of the Web Audio graph: records nodes, connections and automation ───

class FakeParam {
  value = 0
  calls: [string, number, number][] = []
  setValueAtTime(v: number, t: number) { this.calls.push(['set', v, t]); return this }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push(['linear', v, t]); return this }
  exponentialRampToValueAtTime(v: number, t: number) { this.calls.push(['exp', v, t]); return this }
  setTargetAtTime(v: number, t: number) { this.calls.push(['target', v, t]); return this }
}

class FakeNode {
  out: unknown[] = []
  constructor(readonly kind: string, readonly ctx: FakeCtx) { ctx.nodes.push(this) }
  connect(target: unknown) { this.out.push(target); return target }
  disconnect() {}
}

class FakeSource extends FakeNode {
  startAt: number | null = null
  stopAt: number | null = null
  onended: (() => void) | null = null
  start(t: number) { this.startAt = t }
  stop(t: number) { this.stopAt = t }
}

class FakeCtx {
  nodes: FakeNode[] = []
  sampleRate = 8000
  currentTime = 0
  destination = new FakeNode('destination', this)
  createGain() { return Object.assign(new FakeNode('gain', this), { gain: new FakeParam() }) }
  createOscillator() {
    return Object.assign(new FakeSource('oscillator', this), { type: 'sine', frequency: new FakeParam(), detune: new FakeParam() })
  }
  createBufferSource() { return Object.assign(new FakeSource('buffer', this), { buffer: null, loop: false }) }
  createBiquadFilter() {
    return Object.assign(new FakeNode('filter', this), { type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam() })
  }
  createWaveShaper() { return Object.assign(new FakeNode('shaper', this), { curve: null, oversample: 'none' }) }
  createStereoPanner() { return Object.assign(new FakeNode('panner', this), { pan: new FakeParam() }) }
  createConvolver() { return Object.assign(new FakeNode('convolver', this), { buffer: null }) }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode('compressor', this), {
      threshold: new FakeParam(), knee: new FakeParam(), ratio: new FakeParam(), attack: new FakeParam(), release: new FakeParam(),
    })
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return { length, sampleRate, duration: length / sampleRate, numberOfChannels: channels, getChannelData: (i: number) => data[i] }
  }
}

type AnyNode = FakeNode & Record<string, unknown>

function setup() {
  const ctx = new FakeCtx()
  const bus = createMasterBus(ctx as unknown as BaseAudioContext, 0.8)
  const before = ctx.nodes.length
  return { ctx, bus, newNodes: () => ctx.nodes.slice(before) as AnyNode[] }
}

function play(voice: Voice) {
  const s = setup()
  scheduleCue(s.bus, [voice], 1)
  return { ...s, nodes: s.newNodes() }
}

const base: Voice = { type: 'sine', freq: 440, start: 0, dur: 0.5, peak: 0.1, attack: 0.01 }

test('the master bus ends in a limiter: master gain -> limiter -> speakers, nothing else reaches the speakers', () => {
  const { ctx, bus } = setup()
  const limiter = bus.limiter as unknown as AnyNode
  assert.equal(limiter.kind, 'compressor')
  assert.deepEqual((bus.input as unknown as FakeNode).out, [limiter])
  assert.deepEqual(limiter.out, [ctx.destination])
  const intoSpeakers = ctx.nodes.filter((n) => n.out.includes(ctx.destination))
  assert.deepEqual(intoSpeakers, [limiter])
  assert.equal((bus.input as unknown as { gain: FakeParam }).gain.value, 0.8)
  // its settings are a limiter's, and gentle
  for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release'] as const) {
    assert.equal((limiter[k] as FakeParam).value, LIMITER[k], k)
  }
  assert.ok(LIMITER.threshold <= -3 && LIMITER.threshold >= -12)
  assert.ok(LIMITER.ratio >= 8)
  assert.ok(LIMITER.attack <= 0.005)
})

test('the reverb returns into the master gain, so it goes through the limiter too', () => {
  const { ctx, bus } = setup()
  const space = bus.space as unknown as FakeNode
  const conv = space.out[0] as FakeNode
  assert.equal(conv.kind, 'convolver')
  const ret = conv.out[0] as FakeNode & { gain: FakeParam }
  assert.deepEqual(ret.out, [bus.input])
  assert.ok(ret.gain.value > 0 && ret.gain.value <= 4)
  assert.ok((conv as unknown as { buffer: unknown }).buffer)
  assert.ok(ctx.nodes.every((n) => n === bus.limiter as unknown || !n.out.includes(ctx.destination)))
})

test('a plain voice: oscillator -> envelope -> master, started and stopped on time', () => {
  const { nodes, bus } = play(base)
  const osc = nodes.find((n) => n.kind === 'oscillator') as FakeSource & AnyNode
  assert.equal(osc.startAt, 1)
  assert.ok(Math.abs(osc.stopAt! - 1.52) < 1e-9)
  const env = osc.out[0] as FakeNode & { gain: FakeParam }
  assert.deepEqual(env.out, [bus.input])
  assert.deepEqual(env.gain.calls.map((c) => c[0]), ['set', 'linear', 'exp'])
  assert.equal(env.gain.calls[1][1], 0.1)
  assert.equal(nodes.filter((n) => n.kind === 'convolver').length, 0)
})

test('release holds the peak until the fade', () => {
  const { nodes } = play({ ...base, release: 0.1 })
  const env = (nodes.find((n) => n.kind === 'oscillator') as FakeNode).out[0] as FakeNode & { gain: FakeParam }
  assert.deepEqual(env.gain.calls.map((c) => c[0]), ['set', 'linear', 'set', 'exp'])
  assert.deepEqual(env.gain.calls[2].slice(1), [0.1, 1.4])
})

test('noise voices read the shared looping noise buffer', () => {
  const { nodes, bus } = play({ ...base, type: 'noise', freq: 0, filter: { type: 'bandpass', freq: 300, to: 3000 } })
  const src = nodes.find((n) => n.kind === 'buffer') as AnyNode
  assert.equal(src.buffer, bus.noise)
  assert.equal(src.loop, true)
  assert.equal(nodes.filter((n) => n.kind === 'oscillator').length, 0)
  const filter = nodes.find((n) => n.kind === 'filter') as AnyNode
  assert.deepEqual((filter.frequency as FakeParam).calls.map((c) => c[0]), ['set', 'exp'])
})

test('FM: a second oscillator drives the carrier frequency', () => {
  const { nodes } = play({ ...base, fm: { ratio: 1.4, index: 3, indexTo: 0.2 } })
  const oscs = nodes.filter((n) => n.kind === 'oscillator') as AnyNode[]
  assert.equal(oscs.length, 2)
  const [carrier, mod] = oscs
  const depth = mod.out[0] as AnyNode
  assert.deepEqual(depth.out, [carrier.frequency])
  assert.equal((mod.frequency as FakeParam).value, 440 * 1.4)
  assert.equal((depth.gain as FakeParam).calls[0][1], 3 * 440)
})

test('ring modulation multiplies the voice by a sine (oscillator into a gain param)', () => {
  const { nodes } = play({ ...base, ring: 37 })
  const ringOsc = nodes.find((n) => n.kind === 'oscillator' && (n.frequency as FakeParam).value === 37) as AnyNode
  assert.ok(ringOsc)
  const ringGain = nodes.find((n) => n.kind === 'gain' && ringOsc.out.includes(n.gain)) as AnyNode
  assert.ok(ringGain)
  assert.equal((ringGain.gain as FakeParam).value, 0)
})

test('drive adds a wave shaper, pan a stereo panner, space a send into the reverb', () => {
  const { nodes, bus } = play({ ...base, drive: 0.5, pan: -0.5, panTo: 0.5, space: 0.4 })
  const shaper = nodes.find((n) => n.kind === 'shaper') as AnyNode
  assert.ok(shaper.curve instanceof Float32Array)
  const panner = nodes.find((n) => n.kind === 'panner') as AnyNode
  assert.deepEqual((panner.pan as FakeParam).calls.map((c) => [c[0], c[1]]), [['set', -0.5], ['linear', 0.5]])
  const send = nodes.find((n) => n.kind === 'gain' && n.out.includes(bus.space)) as AnyNode
  assert.equal((send.gain as FakeParam).value, 0.4)
})

test('stepped pitch jumps through each step', () => {
  const { nodes } = play({ ...base, type: 'square', steps: [300, 600, 900], dur: 0.3 })
  const osc = nodes.find((n) => n.kind === 'oscillator') as AnyNode
  const exps = (osc.frequency as FakeParam).calls.filter((c) => c[0] === 'exp').map((c) => c[1])
  assert.deepEqual(exps, [600, 900])
})

test('every cue schedules cleanly and every source stops right after the cue ends', () => {
  for (const cue of Object.keys(RECIPES) as SoundCue[]) {
    const { bus, newNodes } = setup()
    scheduleCue(bus, RECIPES[cue], 2)
    const sources = newNodes().filter((n) => n instanceof FakeSource) as unknown as FakeSource[]
    assert.ok(sources.length >= RECIPES[cue].length, cue)
    const end = 2 + recipeDuration(RECIPES[cue])
    for (const s of sources) {
      assert.ok(s.startAt !== null && s.startAt >= 2, cue)
      assert.ok(s.stopAt !== null && s.stopAt <= end + 0.03, cue)
    }
  }
})

test('the generated space fades by about 60 dB and noise stays in range', () => {
  const [l, r] = spaceImpulse(8000, 2)
  const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length)
  const head = rms(l.subarray(400, 2000))
  const tail = rms(l.subarray(l.length - 1600))
  assert.ok(tail < head / 100, `tail ${tail} head ${head}`)
  assert.notDeepEqual(l.subarray(400, 410), r.subarray(400, 410))
  // predelay: silent start
  assert.equal(l[0], 0)
  const n = whiteNoise(1000)
  assert.ok(n.every((x) => x >= -1 && x <= 1))
  assert.deepEqual(whiteNoise(10), whiteNoise(10))
})
