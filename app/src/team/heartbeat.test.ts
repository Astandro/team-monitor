import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  HANDLING_GRACE_MS, HEARTBEAT_STALE_MS, heartbeatPath, isPidAlive, readHeartbeat, startHeartbeat, watcherStatus, writeHeartbeat,
} from './heartbeat'
import { makeTmpDir, removeTmpDir, waitFor } from './test-helpers'

const T0 = Date.parse('2026-11-13T10:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const running = { pid: 4242, startedAt: iso(T0), beatAt: iso(T0 + 20_000) }
const alivePid = () => true
const deadPid = () => false

test('no heartbeat: not alive, since null', () => {
  assert.deepEqual(watcherStatus(null), { alive: false, since: null })
})

test('a running watcher with a fresh beat and a live pid is alive since it started', () => {
  assert.deepEqual(watcherStatus(running, { now: () => T0 + 25_000, pidAlive: alivePid }), { alive: true, since: iso(T0) })
})

test('a stale beat is not alive (since = last beat), even with a live pid', () => {
  const now = () => T0 + 20_000 + HEARTBEAT_STALE_MS
  assert.deepEqual(watcherStatus(running, { now, pidAlive: alivePid }), { alive: false, since: running.beatAt })
  assert.equal(watcherStatus(running, { now: () => T0 + 20_000 + HEARTBEAT_STALE_MS - 1, pidAlive: alivePid }).alive, true)
})

test('a dead pid is not alive at once, even with a fresh beat', () => {
  assert.deepEqual(watcherStatus(running, { now: () => T0 + 21_000, pidAlive: deadPid }), { alive: false, since: running.beatAt })
})

test('ended by a message, answer or timeout: alive during the handling grace, then not', () => {
  for (const reason of ['message', 'answer', 'timeout'] as const) {
    const rec = { ...running, endedAt: iso(T0 + 30_000), reason }
    assert.deepEqual(watcherStatus(rec, { now: () => T0 + 30_000 + HANDLING_GRACE_MS - 1, pidAlive: deadPid }), { alive: true, since: iso(T0) }, reason)
    assert.deepEqual(watcherStatus(rec, { now: () => T0 + 30_000 + HANDLING_GRACE_MS, pidAlive: deadPid }), { alive: false, since: rec.endedAt }, reason)
  }
})

test('stopped by a signal or an error: not alive at once', () => {
  for (const reason of ['signal', 'error'] as const) {
    const rec = { ...running, endedAt: iso(T0 + 30_000), reason }
    assert.deepEqual(watcherStatus(rec, { now: () => T0 + 30_001, pidAlive: alivePid }), { alive: false, since: rec.endedAt }, reason)
  }
})

test('isPidAlive: this process yes, an unused pid no', () => {
  assert.equal(isPidAlive(process.pid), true)
  assert.equal(isPidAlive(2 ** 22 + 12345), false)
})

test('readHeartbeat refuses malformed records', () => {
  const dir = makeTmpDir()
  try {
    for (const bad of ['{', '[]', '{"pid": "1", "startedAt": "a", "beatAt": "b"}', '{"pid": 0, "startedAt": "a", "beatAt": "b"}', '{"pid": 5, "startedAt": "a"}']) {
      fs.writeFileSync(heartbeatPath(dir), bad)
      assert.equal(readHeartbeat(dir), null, bad)
    }
    writeHeartbeat(dir, running)
    assert.deepEqual(readHeartbeat(dir), running)
    assert.equal(fs.statSync(heartbeatPath(dir)).mode & 0o077, 0)
    assert.deepEqual(fs.readdirSync(dir), ['.watcher'], 'no temp file left')
  } finally {
    removeTmpDir(dir)
  }
})

test('startHeartbeat writes at once, refreshes beatAt, and records why it ended', async () => {
  const dir = makeTmpDir()
  try {
    let t = T0
    const hb = startHeartbeat(dir, { intervalMs: 30, now: () => new Date(t), pid: process.pid })
    assert.deepEqual(readHeartbeat(dir), { pid: process.pid, startedAt: iso(T0), beatAt: iso(T0) })
    t = T0 + 10_000
    await waitFor(() => readHeartbeat(dir)?.beatAt === iso(T0 + 10_000))
    t = T0 + 12_000
    hb.stop('message')
    const rec = readHeartbeat(dir)!
    assert.deepEqual(rec, { pid: process.pid, startedAt: iso(T0), beatAt: iso(T0 + 12_000), endedAt: iso(T0 + 12_000), reason: 'message' })
    t = T0 + 20_000
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(readHeartbeat(dir)!.beatAt, iso(T0 + 12_000), 'no beat after stop')
  } finally {
    removeTmpDir(dir)
  }
})

test('stop does not end a record another watcher took over', () => {
  const dir = makeTmpDir()
  try {
    const hb = startHeartbeat(dir, { intervalMs: 60_000, pid: 111 })
    const other = { pid: 222, startedAt: iso(T0), beatAt: iso(T0) }
    writeHeartbeat(dir, other)
    hb.stop('timeout')
    assert.deepEqual(readHeartbeat(dir), other)
  } finally {
    removeTmpDir(dir)
  }
})

test('a missing folder does not throw', () => {
  const dir = makeTmpDir()
  try {
    const hb = startHeartbeat(path.join(dir, 'nope'), { intervalMs: 60_000 })
    hb.stop('timeout')
    assert.equal(fs.existsSync(path.join(dir, 'nope')), false)
  } finally {
    removeTmpDir(dir)
  }
})
