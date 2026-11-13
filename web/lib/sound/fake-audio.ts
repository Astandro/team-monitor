// Test-only: a minimal fake of the Web Audio graph that records nodes, connections and automation.
// Used by synth.test.ts and audio-engine.test.ts; not imported by the app.

export class FakeParam {
  value = 0
  calls: [string, number, number][] = []
  setValueAtTime(v: number, t: number) { this.calls.push(['set', v, t]); return this }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push(['linear', v, t]); return this }
  exponentialRampToValueAtTime(v: number, t: number) { this.calls.push(['exp', v, t]); return this }
  setTargetAtTime(v: number, t: number) { this.calls.push(['target', v, t]); return this }
}

export class FakeNode {
  out: unknown[] = []
  constructor(readonly kind: string, readonly ctx: FakeCtx) { ctx.nodes.push(this) }
  connect(target: unknown) { this.out.push(target); return target }
  disconnect() {}
}

export class FakeSource extends FakeNode {
  startAt: number | null = null
  stopAt: number | null = null
  onended: (() => void) | null = null
  start(t: number) { this.startAt = t }
  stop(t: number) { this.stopAt = t }
}

export class FakeCtx {
  nodes: FakeNode[] = []
  sampleRate = 8000
  currentTime = 0
  state = 'running'
  destination = new FakeNode('destination', this)
  /** what decodeAudioData received, in order */
  decoded: ArrayBuffer[] = []
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
  /** "Decodes" any non-empty data into a 1-second buffer tagged with its first byte; empty data fails like bad audio. */
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    this.decoded.push(data)
    if (data.byteLength === 0) return Promise.reject(new Error('EncodingError'))
    const buf = this.createBuffer(2, this.sampleRate, this.sampleRate)
    return Promise.resolve(Object.assign(buf, { tag: new Uint8Array(data)[0] }) as unknown as AudioBuffer)
  }
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { this.state = 'closed'; return Promise.resolve() }
}

export type AnyNode = FakeNode & Record<string, unknown>
