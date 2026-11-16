import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { AudioEngine } from './audio-engine'
import { FakeCtx, type AnyNode } from './sound/fake-audio'
import { SampleBank, type FetchBytes } from './sound/sample-bank'
import { sampleUrls } from './sound/samples'

function setup(opts: { samples?: boolean; fail?: string[] } = {}) {
  const fetched: string[] = []
  const fetchBytes: FetchBytes = async (url) => {
    fetched.push(url)
    if (opts.fail?.some((f) => url.endsWith(f))) throw new Error('404')
    return new Uint8Array([fetched.length]).buffer
  }
  const bank = opts.samples === false ? undefined : new SampleBank(sampleUrls('/'), fetchBytes)
  const contexts: FakeCtx[] = []
  const engine = new AudioEngine({
    samples: bank,
    createContext: () => {
      const c = new FakeCtx()
      contexts.push(c)
      return c as unknown as AudioContext
    },
  })
  return { engine, bank, fetched, contexts }
}

/** The master gain: the one node that feeds the limiter. */
function masterInput(ctx: FakeCtx) {
  const limiter = ctx.nodes.find((n) => n.kind === 'compressor')
  return ctx.nodes.find((n) => n.out.includes(limiter))
}

test('lazy: no context and no download while muted or before the first tap; the tap with sound on starts loading', async () => {
  const s = setup()
  s.engine.unlock() // a tap, but sound is off (the default)
  s.engine.play('stage_done')
  assert.equal(s.contexts.length, 0)
  assert.equal(s.fetched.length, 0)

  const t = setup()
  t.engine.setMuted(false) // sound on (stored setting) but no tap yet
  t.engine.play('stage_done')
  assert.equal(t.contexts.length, 0)
  assert.equal(t.fetched.length, 0)
  t.engine.unlock() // first tap
  assert.equal(t.contexts.length, 1)
  await t.engine.samplesSettled(1000)
  assert.equal(t.fetched.length, 19, '15 event sounds and 4 loops')
  assert.equal(t.contexts[0].decoded.length, 19)
  t.engine.unlock()
  t.engine.setMuted(false)
  await t.engine.samplesSettled(1000)
  assert.equal(t.fetched.length, 19, 'loaded once')
})

test('every one of the 15 events plays its own sample file once loaded (tool_start and tool_complete too)', async () => {
  const s = setup()
  s.engine.setMuted(false)
  s.engine.unlock()
  await s.engine.samplesSettled(1000)
  const ctx = s.contexts[0]
  const cues = ['decision_open', 'task_blocked', 'tool_error', 'stage_done', 'decision_answered', 'task_done', 'task_review',
    'task_start', 'session_start', 'agent_complete', 'agent_offboarded', 'agent_spawn', 'handoff', 'tool_complete', 'tool_start'] as const
  for (const cue of cues) {
    const before = ctx.nodes.length
    s.engine.play(cue)
    const created = ctx.nodes.slice(before) as AnyNode[]
    assert.equal(created.length, 1, cue)
    assert.equal(created[0].kind, 'buffer', cue)
    assert.equal(created[0].buffer, s.bank!.get(cue), cue)
  }
})

test('volume: the slider value is squared into the master gain (0.5 -> 0.25), muted is 0', async () => {
  const s = setup()
  s.engine.setVolume(0.5)
  s.engine.setMuted(false)
  s.engine.unlock()
  const ctx = s.contexts[0]
  const master = masterInput(ctx) as AnyNode
  assert.equal((master.gain as { value: number }).value, 0.25, 'created at value squared')
  s.engine.setVolume(0.7)
  const calls = (master.gain as { calls: [string, number, number][] }).calls
  assert.ok(Math.abs(calls[calls.length - 1][1] - 0.49) < 1e-12)
  s.engine.setMuted(true)
  assert.equal(calls[calls.length - 1][1], 0)
})

test('a loaded cue plays its file through the master gain (volume, limiter), not the synthesiser', async () => {
  const s = setup()
  s.engine.setMuted(false)
  s.engine.unlock()
  await s.engine.samplesSettled(1000)
  const ctx = s.contexts[0]
  const before = ctx.nodes.length
  s.engine.play('stage_done', 0.5)
  const created = ctx.nodes.slice(before) as AnyNode[]
  assert.equal(created.length, 1)
  const src = created[0]
  assert.equal(src.kind, 'buffer')
  assert.equal(src.buffer, s.bank!.get('stage_done'))
  assert.deepEqual(src.out, [masterInput(ctx)])
  assert.ok(Math.abs((src.startAt as number) - 0.51) < 1e-9)
})

test('fallback: a cue whose file failed, or is still loading, plays the synthesised v2 sound', async () => {
  const s = setup({ fail: ['sfx-task_done.mp3'] })
  s.engine.setMuted(false)
  s.engine.unlock()
  const ctx = s.contexts[0]
  // still loading: synthesised
  let before = ctx.nodes.length
  s.engine.play('agent_spawn')
  assert.ok(ctx.nodes.slice(before).some((n) => n.kind === 'oscillator'))
  await s.engine.samplesSettled(1000)
  assert.equal(s.bank!.status('task_done'), 'failed')
  before = ctx.nodes.length
  s.engine.play('task_done')
  const created = ctx.nodes.slice(before) as AnyNode[]
  assert.ok(created.some((n) => n.kind === 'oscillator'))
  assert.ok(!created.some((n) => n.kind === 'buffer' && n.buffer !== null && (n.buffer as { tag?: number }).tag !== undefined))
})

test('without a sample bank (VS Code webview) every cue is synthesised and nothing is downloaded', async () => {
  const s = setup({ samples: false })
  s.engine.setMuted(false)
  s.engine.unlock()
  await s.engine.samplesSettled(1000)
  const ctx = s.contexts[0]
  const before = ctx.nodes.length
  s.engine.play('session_start')
  assert.ok(ctx.nodes.slice(before).some((n) => n.kind === 'oscillator'))
  assert.equal(s.fetched.length, 0)
})
