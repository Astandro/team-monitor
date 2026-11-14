/**
 * Hub-wide byte cap across all cloud session buffers (real relay):
 * - when a new event would exceed it, the oldest buffered events go first from sessions of stale sources, then from
 *   ended sessions, then from the largest live session buffers; the new event is never refused (200, applied);
 * - the running total stays exact through drops, session eviction and source eviction.
 *
 * Small limits are passed to createRelay (cloudLimits) so the cap is reached with a few events of a fixed size. The
 * relay is a process singleton and reads HOME when loaded: same set-up as ingest-relay.test.ts.
 */
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { makeTmpDir, removeTmpDir, listen, request } from './test-helpers'
import { createRequestHandler, TeamService } from './http'
import { IngestService } from './ingest'
import { OffboardStore } from './offboard'

const root = makeTmpDir()
const home = path.join(root, 'home')
const workspace = path.join(root, 'proj')
const tmHome = path.join(root, 'tm')
for (const d of [home, workspace, tmHome]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })

const savedHome = process.env.HOME
process.env.HOME = home
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module') as { _resolveFilename: (req: string, ...rest: unknown[]) => string }
const origResolve = Module._resolveFilename
Module._resolveFilename = function (req: string, ...rest: unknown[]) {
  if (req === 'vscode') return path.join(__dirname, '..', '..', '..', 'scripts', 'vscode-shim.js')
  return origResolve.call(this, req, ...rest)
}

const cleanups: Array<() => void | Promise<void>> = []
after(async () => {
  for (const fn of cleanups.reverse()) { try { await fn() } catch { /* keep going */ } }
  Module._resolveFilename = origResolve
  process.env.HOME = savedHome
  removeTmpDir(root)
})

const TOKEN = 'ab'.repeat(32)
const sid = (n: number) => `6a7b8c9d-0000-4000-8000-${String(n).padStart(12, '0')}`
const SA = sid(1) // stale source box-a
const SB = sid(2) // ended session of live source box-b
const L1 = sid(3) // live source box-c, larger buffer
const L2 = sid(4) // live source box-c, small buffer
const SD = sid(5) // live source box-d, the one that keeps posting

let n = 0
/** An event of a fixed size (n is zero-padded). Key order as ingest.ts parseEvent builds it. */
const ev = (session: string) => ({ time: 1, type: 'tool_call_start', payload: { agent: 'orchestrator', n: String(++n).padStart(6, '0'), pad: 'x'.repeat(300) }, sessionId: session })
const E = Buffer.byteLength(JSON.stringify({ type: 'agent-event', event: ev(SA) }))
const LIMITS = { maxSessions: 50, sessionBufferBytes: 30 * E, sourceBufferBytes: 30 * E, totalBufferBytes: Math.floor(18.5 * E), replayBytes: 100 * E }

test('hub-wide cloud buffer cap: stale sources first, then ended sessions, then the largest live buffers; never refused; exact accounting', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRelay, cloudBufferStats } = require('../../../scripts/relay') as typeof import('../../../scripts/relay')
  const store = new OffboardStore(tmHome)
  const relay = await createRelay({ workspace, runtime: 'claude', offboarded: store, autoOffboardMinutes: 60, cloudLimits: LIMITS })
  cleanups.push(() => relay.dispose())
  const team = new TeamService([], { pollMs: 60_000 })
  team.offboard = store
  team.graph = relay.graph
  const clock = { t: Date.now() }
  const ingest = new IngestService({ home: tmHome, token: TOKEN, team, now: () => clock.t, sweepMs: 0, log: () => {} })
  ingest.start()
  ingest.attachRelay(relay.cloud)
  cleanups.push(() => { ingest.dispose(); team.dispose() })
  const srv = await listen(createRequestHandler({
    team, remote: null, ingest,
    fallback: (req, res) => { if (req.url === '/events') return relay.handleSSE(req, res); res.writeHead(404); res.end() },
  }))
  cleanups.push(() => srv.close())

  const seqs = new Map<string, number>()
  const post = async (sourceId: string, messages: unknown[]) => {
    const seq = (seqs.get(sourceId) ?? 0) + 1
    seqs.set(sourceId, seq)
    const r = await request(srv.port, {
      method: 'POST', path: '/api/ingest/v1/events',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Team-Monitor-Source-Key': Buffer.from(sourceId.padEnd(32, '-')).toString('hex').slice(0, 64), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId, project: { id: 'repo', name: `Repo ${sourceId}` }, seq, messages }),
    })
    assert.equal(r.status, 200, r.body)
    return JSON.parse(r.body) as { applied: number; ignored: number }
  }
  const start = (id: string) => ({ type: 'session-started', session: { id, label: 'Repo', status: 'active', startTime: 1, lastActivityTime: 1 } })
  const batch = (session: string, k: number) => ({ type: 'agent-event-batch', events: Array.from({ length: k }, () => ev(session)) })
  const counts = () => {
    const st = cloudBufferStats()
    assert.equal(st.total, st.recounted, 'running total equals the recount')
    assert.ok(st.total <= LIMITS.totalBufferBytes, `under the hub-wide cap (${st.total})`)
    const c = (id: string) => st.sessions[id]?.events ?? 0
    for (const [id, s] of Object.entries(st.sessions)) assert.equal(s.bytes, s.events * E, `bytes match the events of ${id}`)
    return { SA: c(SA), SB: c(SB), L1: c(L1), L2: c(L2), SD: c(SD) }
  }

  // 18 events, under the cap (18.5 events).
  await post('box-a', [start(SA), batch(SA, 5)])
  await post('box-b', [start(SB), batch(SB, 4), { type: 'session-ended', sessionId: SB }])
  await post('box-c', [start(L1), batch(L1, 8), start(L2), batch(L2, 1)])
  assert.deepEqual(counts(), { SA: 5, SB: 4, L1: 8, L2: 1, SD: 0 })

  // box-a goes stale; the others are live again with their next request.
  clock.t += 61_000
  ingest.sweep()
  await post('box-b', [])
  await post('box-c', [])

  // A new live source: its events are accepted; the stale source's oldest events make room.
  assert.deepEqual(await post('box-d', [start(SD), batch(SD, 4)]), { ok: true, seq: 1, applied: 5, ignored: 0 })
  assert.deepEqual(counts(), { SA: 1, SB: 4, L1: 8, L2: 1, SD: 4 })

  // Stale source drained first, then the ended session (oldest first); live sessions untouched.
  assert.equal((await post('box-d', [batch(SD, 3)])).applied, 3)
  assert.deepEqual(counts(), { SA: 0, SB: 2, L1: 8, L2: 1, SD: 7 })

  // Ended session drained, then the largest live buffer (here the poster's own, oldest first; its new events stay).
  assert.equal((await post('box-d', [batch(SD, 5)])).applied, 5)
  assert.deepEqual(counts(), { SA: 0, SB: 0, L1: 8, L2: 1, SD: 9 })
  // A small live session's new event is not refused: the largest buffer (another source's) gives way.
  assert.equal((await post('box-c', [batch(L2, 1)])).applied, 1)
  assert.deepEqual(counts(), { SA: 0, SB: 0, L1: 8, L2: 2, SD: 8 })
  // The newest event is kept and replayed to a new client.
  const newest = `"n":"${String(n).padStart(6, '0')}"`
  const sse = await new Promise<string>((resolve) => {
    let all = ''
    const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/events', headers: { Host: `127.0.0.1:${srv.port}` } }, (res) => {
      res.setEncoding('utf-8')
      res.on('data', (c: string) => { all += c; if (all.includes(newest)) { req.destroy(); resolve(all) } })
    })
    const timer = setTimeout(() => { req.destroy(); resolve(all) }, 5000)
    timer.unref()
    req.on('error', () => resolve(all))
  })
  assert.ok(sse.includes(newest), 'the newest event is in the replay')

  // Exact accounting when sessions and sources are evicted: everything goes back to zero.
  clock.t += 25 * 3600_000
  ingest.sweep()
  const st = cloudBufferStats()
  assert.equal(st.total, 0)
  assert.equal(st.recounted, 0)
  assert.deepEqual(st.sessions, {})
  // New data after that is counted from zero again.
  await post('box-e', [start(SA), batch(SA, 2)])
  assert.equal(cloudBufferStats().total, 2 * E)
})
