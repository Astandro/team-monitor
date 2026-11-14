/**
 * Hub intake limits through the real relay:
 * - a deeply nested event is refused (400) and nothing reaches the relay; an event that cannot be serialised never
 *   enters a session buffer, and later /events clients get their replay and stay connected;
 * - cloud session buffers are capped in bytes per session and per source (oldest dropped), and a new client's
 *   replay of cloud events is bounded;
 * - at the cloud session cap, ended sessions and sessions of stale sources are evicted (with their buffers); when
 *   every session is live the hub answers 503 instead of a 200 that ignores the messages.
 *
 * Small limits are passed to createRelay (cloudLimits) so the caps are reached with a few events. The relay is a
 * process singleton and reads HOME when loaded: same set-up as ingest-relay.test.ts.
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

const TOKEN = 'ef'.repeat(32)
const LIMITS = { maxSessions: 3, sessionBufferBytes: 4000, sourceBufferBytes: 6000, replayBytes: 5000 }
const sid = (n: number) => `5a6b7c8d-0000-4000-8000-${String(n).padStart(12, '0')}`
const P = sid(1)
const A1 = sid(2)
const A2 = sid(3)
const N1 = sid(4)
const N2 = sid(5)

type Msg = { type: string; [k: string]: unknown }

function openSSE(port: number): { msgs: Msg[]; raw: () => string; closed: () => boolean; close: () => void } {
  const msgs: Msg[] = []
  let all = ''
  let ended = false
  const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    let buf = ''
    res.setEncoding('utf-8')
    res.on('data', (chunk: string) => {
      all += chunk
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        if (block.startsWith('data: ')) msgs.push(JSON.parse(block.slice(6)) as Msg)
      }
    })
    res.on('end', () => { ended = true })
    res.on('close', () => { ended = true })
  })
  req.on('error', () => { ended = true })
  return { msgs, raw: () => all, closed: () => ended, close: () => req.destroy() }
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Events of one session in a client's replay batches. */
const replayed = (msgs: Msg[], session: string) => msgs.filter((m) => m.type === 'agent-event-batch')
  .flatMap((m) => m.events as Array<{ sessionId: string; payload: { n?: number } }>).filter((e) => e.sessionId === session)

test('cloud limits on the real relay: depth, unserialisable events, byte caps, bounded replay, eviction at the session cap', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRelay } = require('../../../scripts/relay') as typeof import('../../../scripts/relay')
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
  const port = srv.port

  const seqs = new Map<string, number>()
  const postRaw = (sourceId: string, body: string) => request(port, {
    method: 'POST', path: '/api/ingest/v1/events', body,
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Team-Monitor-Source-Key': Buffer.from(sourceId.padEnd(32, '-')).toString('hex').slice(0, 64), 'Content-Type': 'application/json' },
  })
  const post = (sourceId: string, messages: unknown[]) => {
    const seq = (seqs.get(sourceId) ?? 0) + 1
    seqs.set(sourceId, seq)
    return postRaw(sourceId, JSON.stringify({ sourceId, project: { id: 'repo', name: `Repo ${sourceId}` }, seq, messages }))
  }
  const start = (id: string) => ({ type: 'session-started', session: { id, label: 'Repo', status: 'active', startTime: 1, lastActivityTime: 1, prompt: 'p' } })
  let n = 0
  /** An event of about 450 bytes on /events. */
  const ev = (session: string) => ({ time: 1, type: 'tool_call_start', payload: { agent: 'orchestrator', n: ++n, pad: 'x'.repeat(300) }, sessionId: session })

  // ── Depth: the QA repro (20,000 levels) is a 400; nothing reaches the relay ──
  assert.equal((await post('box-p', [start(P), { type: 'agent-event', event: ev(P) }])).status, 200)
  const deep = '{"a":'.repeat(20000) + '1' + '}'.repeat(20000)
  const deepRes = await postRaw('box-p', `{"sourceId":"box-p","project":{"id":"repo","name":"Repo box-p"},"seq":99,"messages":[{"type":"agent-event","event":{"sessionId":"${P}","type":"tool_call_start","time":1,"payload":{"deep":${deep}}}}]}`)
  assert.equal(deepRes.status, 400, deepRes.body)
  assert.match(JSON.parse(deepRes.body).error, /nested deeper/)

  // ── An event that cannot be serialised (here a BigInt) never enters a buffer ──
  const live = openSSE(port)
  cleanups.push(live.close)
  await until(() => live.msgs.some((m) => m.type === 'session-list'), 'first client')
  const bad = { time: 2, type: 'tool_call_start', payload: { agent: 'orchestrator', big: BigInt(1) }, sessionId: P }
  assert.doesNotThrow(() => relay.cloud.apply('box-p', 'cloud-box-p', [{ type: 'agent-event', event: bad as never }]))
  assert.equal((await post('box-p', [{ type: 'agent-event', event: ev(P) }])).status, 200)
  const late = openSSE(port)
  cleanups.push(late.close)
  await until(() => late.msgs.some((m) => m.type === 'agent-event-batch'), 'replay for a later client')
  assert.deepEqual(replayed(late.msgs, P).map((e) => e.payload.n), [1, 2], 'the unserialisable event is not in the replay')
  // Both clients stay connected and get the next live event.
  assert.equal((await post('box-p', [{ type: 'agent-event', event: ev(P) }])).status, 200)
  await until(() => late.msgs.some((m) => m.type === 'agent-event' && (m.event as { payload: { n: number } }).payload.n === 3), 'live event (late client)')
  await until(() => live.msgs.some((m) => m.type === 'agent-event' && (m.event as { payload: { n: number } }).payload.n === 3), 'live event (first client)')
  assert.equal(late.closed() || live.closed(), false)

  // ── Byte caps: per session 4000 bytes, per source 6000 bytes, oldest first ──
  assert.equal((await post('box-a', [start(A1), { type: 'agent-event-batch', events: Array.from({ length: 20 }, () => ev(A1)) }])).status, 200)
  const firstA1 = n - 19
  const afterA1 = openSSE(port)
  cleanups.push(afterA1.close)
  await until(() => replayed(afterA1.msgs, A1).length > 0, 'A1 replay')
  const a1 = replayed(afterA1.msgs, A1)
  const bytes = (evs: unknown[]) => evs.reduce<number>((s, e) => s + Buffer.byteLength(JSON.stringify({ type: 'agent-event', event: e })), 0)
  assert.ok(a1.length < 20 && a1.length >= 5, `session cap keeps the newest (${a1.length})`)
  assert.ok(bytes(a1) <= LIMITS.sessionBufferBytes)
  assert.equal(a1[a1.length - 1].payload.n, n, 'the newest event is kept')
  assert.ok(a1[0].payload.n! > firstA1, 'the oldest events were dropped')
  afterA1.close()

  assert.equal((await post('box-a', [start(A2), { type: 'agent-event-batch', events: Array.from({ length: 8 }, () => ev(A2)) }])).status, 200)
  const both = openSSE(port)
  cleanups.push(both.close)
  await until(() => replayed(both.msgs, A2).length > 0, 'A2 replay')
  const a1b = replayed(both.msgs, A1)
  const a2 = replayed(both.msgs, A2)
  assert.equal(a2.length, 8, 'A2 is within its session cap')
  assert.ok(bytes([...a1b, ...a2]) <= LIMITS.sourceBufferBytes, 'source cap')
  assert.ok(a1b.length < a1.length, 'the source cap dropped the oldest events (of A1 first)')
  // The replay of cloud events to one client is bounded (5000 bytes here), newest sessions first.
  const cloudReplay = [...replayed(both.msgs, P), ...a1b, ...a2]
  const replayBytes = cloudReplay.reduce<number>((s, e) => s + Buffer.byteLength(JSON.stringify(e)) + 1, 0)
  assert.ok(replayBytes <= LIMITS.replayBytes, `replay bounded (${replayBytes})`)
  assert.ok(replayed(both.msgs, P).length < 3, 'the least recent session got what was left of the budget')
  both.close()

  // ── Session cap (3): all live → 503 (not "200 ignored"); an ended session is evicted with its buffer ──
  const full = await post('box-n', [start(N1), { type: 'agent-event', event: ev(N1) }])
  assert.equal(full.status, 503, full.body)
  assert.match(JSON.parse(full.body).error, /capacity/)
  assert.ok(Number(full.headers['retry-after']) > 0)
  assert.equal(relay.cloud.sourceOf(N1), null)

  assert.equal((await post('box-a', [{ type: 'session-ended', sessionId: A1 }])).status, 200)
  const room = await post('box-n', [start(N1), { type: 'agent-event', event: ev(N1) }])
  assert.equal(room.status, 200, room.body)
  assert.deepEqual(JSON.parse(room.body), { ok: true, seq: seqs.get('box-n'), applied: 2, ignored: 0 })
  assert.equal(relay.cloud.sourceOf(A1), null, 'the ended session was evicted')
  assert.ok(!relay.graph.sessions().includes(A1))
  const afterEvict = openSSE(port)
  cleanups.push(afterEvict.close)
  await until(() => afterEvict.msgs.some((m) => m.type === 'agent-event-batch'), 'replay after eviction')
  const listed = (afterEvict.msgs.find((m) => m.type === 'session-list')!.sessions as Array<{ id: string }>).map((s) => s.id).sort()
  assert.deepEqual(listed, [P, A2, N1].sort())
  assert.equal(replayed(afterEvict.msgs, A1).length, 0, 'its buffer is gone')
  afterEvict.close()

  // ── A session of a stale source is evicted next (box-p went quiet first); live sessions are kept ──
  clock.t += 61_000
  ingest.sweep() // every source stale
  assert.equal((await post('box-a', [{ type: 'agent-event', event: ev(A2) }])).status, 200) // box-a live again
  const stale = await post('box-n', [start(N2)]) // box-n live again with this request
  assert.equal(stale.status, 200, stale.body)
  assert.equal(relay.cloud.sourceOf(P), null, 'the session of the stale source was evicted')
  assert.equal(relay.cloud.sourceOf(A2), 'box-a')
  assert.equal(relay.cloud.sourceOf(N1), 'box-n')
  assert.equal(relay.cloud.sourceOf(N2), 'box-n')
})
