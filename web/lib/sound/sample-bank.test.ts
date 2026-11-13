import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SoundCue } from './cues'
import { FakeCtx } from './fake-audio'
import { SampleBank, type FetchBytes } from './sample-bank'
import { sampleUrls } from './samples'

/** A fetch that serves a one-byte file for every URL except those listed as failing (404) or broken (bad audio). */
function fakeFetch(opts: { fail?: string[]; broken?: string[] } = {}) {
  const calls: string[] = []
  const fetchBytes: FetchBytes = async (url) => {
    calls.push(url)
    if (opts.fail?.some((f) => url.endsWith(f))) throw new Error(`${url}: 404`)
    if (opts.broken?.some((f) => url.endsWith(f))) return new ArrayBuffer(0)
    return new Uint8Array([calls.length]).buffer
  }
  return { fetchBytes, calls }
}

test('nothing is downloaded until load(); then every file once, and a second load() reuses the first', async () => {
  const f = fakeFetch()
  const bank = new SampleBank(sampleUrls('/'), f.fetchBytes)
  assert.equal(f.calls.length, 0)
  assert.equal(bank.status('stage_done'), 'idle')
  assert.equal(bank.get('stage_done'), null)
  const ctx = new FakeCtx()
  const p1 = bank.load(ctx)
  const p2 = bank.load(ctx)
  assert.equal(p1, p2)
  assert.equal(bank.status('stage_done'), 'loading')
  await p1
  assert.equal(f.calls.length, 15)
  assert.equal(new Set(f.calls).size, 15)
  assert.ok(f.calls.includes('/sfx-stage_done.mp3'))
  for (const s of Object.values(bank.statuses())) assert.equal(s, 'ready')
  assert.ok(bank.get('tool_start'))
  await bank.load(ctx)
  assert.equal(f.calls.length, 15)
})

test('a file that fails to download or decode stays failed (its cue falls back), the others still load', async () => {
  const f = fakeFetch({ fail: ['sfx-task_done.mp3'], broken: ['sfx-decision_open.mp3'] })
  const bank = new SampleBank(sampleUrls('/'), f.fetchBytes)
  await bank.load(new FakeCtx())
  assert.equal(bank.status('task_done'), 'failed')
  assert.equal(bank.get('task_done'), null)
  assert.equal(bank.status('decision_open'), 'failed')
  assert.equal(bank.get('decision_open'), null)
  const ready = (Object.entries(bank.statuses()) as [SoundCue, string][]).filter(([, s]) => s === 'ready')
  assert.equal(ready.length, 13)
})

test('settled() waits for loading, but never longer than its timeout, and is immediate when nothing loads', async () => {
  const idle = new SampleBank(sampleUrls('/'), fakeFetch().fetchBytes)
  await idle.settled(10_000) // would hang the test if it waited

  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const slow: FetchBytes = async () => { await gate; return new Uint8Array([1]).buffer }
  const bank = new SampleBank(sampleUrls('/'), slow)
  void bank.load(new FakeCtx())
  const t0 = Date.now()
  await bank.settled(30)
  assert.ok(Date.now() - t0 < 1000)
  assert.equal(bank.status('tool_start'), 'loading')
  release()
  await bank.settled(10_000)
  assert.equal(bank.status('tool_start'), 'ready')
})
