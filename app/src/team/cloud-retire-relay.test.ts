/**
 * Spec 0.9.8 items 2-5 through the real relay: a stale source is retired when a new source of the same repo goes
 * live (sub-agents finished, `session-ended`; revised for F1: no `session-removed`, still listed as completed and
 * replayed); a source
 * silent for longer than CLOUD_RETIRE_AFTER_MS gets its sub-agents finished (session still listed, stale); a manual
 * offboard of a running cloud sub-agent succeeds once its source is stale (AC4); `agents-offboarded` from a container
 * for an agent still running on the hub finishes it first; a removed source's sessions get `session-removed` once.
 *
 * The relay is a process singleton and reads HOME when it is loaded, so this file sets HOME first and loads it with
 * require(); `vscode` (imported by the hook server) is mapped to the same shim the build uses.
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
import { AutoOffboarder } from './auto-offboard'

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
const MIN = 60_000
const HIRO = 'Hiro (Frontend Engineer): panel'
const MEI = 'Mei (QA Engineer): review'
const REN = 'Ren (Backend Engineer): store'
const sid = (n: number) => `5a6b7c8d-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`
const SA = sid(1)
const SB = sid(2)
const SC = sid(3)
const SD = sid(4)
const KEYS: Record<string, string> = { 'box-a': 'a1'.repeat(32), 'box-b': 'b2'.repeat(32), 'box-c': 'c3'.repeat(32), 'box-d': 'd4'.repeat(32) }

type Msg = { type: string; [k: string]: unknown }

function openSSE(port: number): { msgs: Msg[]; close: () => void } {
  const msgs: Msg[] = []
  const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    let buf = ''
    res.setEncoding('utf-8')
    res.on('data', (chunk: string) => {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        if (block.startsWith('data: ')) msgs.push(JSON.parse(block.slice(6)) as Msg)
      }
    })
  })
  req.on('error', () => {})
  cleanups.push(() => { req.destroy() })
  return { msgs, close: () => { req.destroy() } }
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A client that connected now: its session list and the session ids it got a replay for. */
async function snapshot(port: number): Promise<{ list: Array<Record<string, unknown>>; replayed: Set<string> }> {
  const c = openSSE(port)
  // An empty marker stream ends after the list (when any) and the batches: wait a little for both.
  await new Promise((r) => setTimeout(r, 150))
  c.close()
  const list = (c.msgs.find((m) => m.type === 'session-list')?.sessions ?? []) as Array<Record<string, unknown>>
  const replayed = new Set<string>()
  for (const m of c.msgs.filter((x) => x.type === 'agent-event-batch')) {
    for (const e of m.events as Array<{ sessionId?: string }>) if (e.sessionId) replayed.add(e.sessionId)
  }
  return { list, replayed }
}

test('0.9.8: retire stale siblings, finish silent sources, AC4 manual offboard, offboard from the container, session-removed', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRelay } = require('../../../scripts/relay') as typeof import('../../../scripts/relay')
  const store = new OffboardStore(tmHome)
  const relay = await createRelay({ workspace, runtime: 'claude', offboarded: store, autoOffboardMinutes: 60 })
  cleanups.push(() => relay.dispose())
  const team = new TeamService([], { pollMs: 60_000 })
  team.offboard = store
  team.graph = relay.graph
  const clock = { t: Date.now() }
  const logs: string[] = []
  const ingest = new IngestService({ home: tmHome, token: TOKEN, team, now: () => clock.t, sweepMs: 0, log: (m) => logs.push(m), cloudRetireAfterMs: 2 * MIN })
  ingest.start()
  ingest.attachRelay(relay.cloud)
  cleanups.push(() => { ingest.dispose(); team.dispose() })
  const handler = createRequestHandler({
    team, remote: null, ingest, log: (m) => logs.push(m),
    fallback: (req, res) => { if (req.url === '/events') return relay.handleSSE(req, res); res.writeHead(404); res.end() },
  })
  const srv = await listen(handler)
  cleanups.push(() => srv.close())
  const port = srv.port

  const seqs: Record<string, number> = {}
  const post = async (sourceId: string, repo: string, messages: unknown[]) => {
    seqs[sourceId] = (seqs[sourceId] ?? 0) + 1
    const r = await request(port, {
      method: 'POST', path: '/api/ingest/v1/events',
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Team-Monitor-Source-Key': KEYS[sourceId], 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId, project: { id: repo, name: repo }, seq: seqs[sourceId], messages }),
    })
    assert.equal(r.status, 200, r.body)
    return JSON.parse(r.body) as { applied: number; ignored: number }
  }
  const ev = (sessionId: string, type: string, payload: Record<string, unknown>) => ({ type: 'agent-event', event: { time: 1, type, payload, sessionId } })
  const start = (sessionId: string, agents: string[]) => [
    { type: 'session-started', session: { id: sessionId, label: 'L', status: 'active', startTime: 1, lastActivityTime: 1 } },
    ev(sessionId, 'agent_spawn', { name: 'orchestrator', isMain: true, task: 't' }),
    ...agents.map((a) => ev(sessionId, 'agent_spawn', { name: a, parent: 'orchestrator', task: 'x' })),
  ]
  const offboard = (session: string, agent: string) => request(port, {
    method: 'POST', path: '/api/team/offboard', body: JSON.stringify({ session, agent }),
    headers: { 'Content-Type': 'application/json', 'X-Team-Monitor': '1', Origin: `http://127.0.0.1:${port}` },
  })
  const status = (session: string, agent: string) => relay.graph.agents(session)?.find((a) => a.name === agent)?.status

  const live = openSSE(port)
  await new Promise((r) => setTimeout(r, 50))

  // ── Item 2 (+3, 5): box-a (repo alpha) with a running sub-agent goes stale; box-b of alpha registers. ──────────
  await post('box-a', 'alpha', start(SA, [HIRO]))
  await post('box-c', 'beta', start(SC, [HIRO, MEI]))
  await until(() => live.msgs.filter((m) => m.type === 'session-started').length === 2, 'two sessions')
  clock.t += 61_000
  ingest.sweep() // box-a and box-c stale
  assert.equal(status(SA, HIRO), 'running', 'stale alone finishes nothing')

  // AC4 before it: a live source's running agent is still refused (box-d is live).
  await post('box-d', 'gamma', start(SD, [REN]))
  assert.equal((await offboard(SD, REN)).status, 409)

  const mark = live.msgs.length
  await post('box-b', 'alpha', start(SB, []))
  await until(() => live.msgs.slice(mark).some((m) => m.type === 'session-ended' && m.sessionId === SA), 'session-ended')
  await new Promise((r) => setTimeout(r, 50))
  const after1 = live.msgs.slice(mark)
  const iDone = after1.findIndex((m) => m.type === 'agent-event' && (m.event as { sessionId: string; type: string; payload: { name: string } }).sessionId === SA
    && (m.event as { type: string }).type === 'agent_complete' && (m.event as { payload: { name: string } }).payload.name === HIRO)
  const iEnded = after1.findIndex((m) => m.type === 'session-ended' && m.sessionId === SA)
  assert.ok(iDone >= 0 && iEnded > iDone, `order: sub-agent finished ${iDone}, ended ${iEnded}`)
  // F1 (option A): retiring does not remove the session.
  assert.ok(!live.msgs.some((m) => m.type === 'session-removed'), 'no session-removed on retire')
  const done = (after1[iDone].event as { payload: Record<string, unknown> }).payload
  assert.equal(done.sessionEnded, true)
  assert.equal(done.finished, true)
  assert.equal(typeof done.finishedAt, 'string')
  assert.equal(typeof done.autoOffboardAt, 'string')
  assert.equal(status(SA, HIRO), 'finished')
  // box-c (repo beta) is stale too but another repo: untouched; box-b's own session is never removed.
  assert.ok(!live.msgs.some((m) => m.type === 'session-removed' && (m.sessionId === SC || m.sessionId === SB)))
  assert.equal(status(SC, HIRO), 'running')

  // A client connecting (reload) after the retirement: SA is still listed, as completed (history), and replayed (F1).
  let snap = await snapshot(port)
  assert.deepEqual(snap.list.map((s) => s.id).sort(), [SA, SB, SC, SD].sort())
  assert.equal(snap.list.find((s) => s.id === SA)!.status, 'completed')
  assert.equal(snap.list.find((s) => s.id === SA)!.stale, true)
  assert.ok(snap.replayed.has(SA), 'a retired session is replayed (as far as the hub keeps it)')
  assert.ok(snap.replayed.has(SB) && snap.replayed.has(SC))
  // One hub project for alpha, shown from box-b.
  assert.deepEqual(team.list().filter((p) => p.id === 'cloud-alpha').map((p) => [p.sourceId, p.stale]), [['box-b', false]])

  // Auto offboarding runs for the finished agent of the retired session as for a local one.
  const auto = new AutoOffboarder(store, relay.graph, 60, { clock: { now: () => Date.now() + 61 * MIN, setTimeout: () => null, clearTimeout: () => {} }, log: () => {} })
  const autoRecords = auto.sweep()
  assert.ok(autoRecords.some((r) => r.session === SA && r.agent === HIRO && r.reason === 'auto' && r.project === 'cloud-alpha'))
  await until(() => live.msgs.some((m) => m.type === 'agents-offboarded' && m.sessionId === SA), 'auto offboarding announced')

  // ── AC4: a manual offboard of a running sub-agent of a stale source succeeds (finished first). ───────────────
  const r = await offboard(SC, MEI)
  assert.equal(r.status, 200, r.body)
  assert.equal(store.isOffboarded(SC, MEI), true)
  assert.equal(status(SC, MEI), 'finished')
  const isMeiOff = (m: Msg) => m.type === 'agents-offboarded' && m.sessionId === SC && (m.agents as string[]).includes(MEI)
  await until(() => live.msgs.some(isMeiOff), 'agents-offboarded for Mei')
  const iMeiDone = live.msgs.findIndex((m) => m.type === 'agent-event' && (m.event as { type: string }).type === 'agent_complete'
    && (m.event as { sessionId: string }).sessionId === SC && (m.event as { payload: { name: string } }).payload.name === MEI)
  assert.ok(iMeiDone >= 0 && iMeiDone < live.msgs.findIndex(isMeiOff), 'viewers saw it finish, then offboarded')
  const meiDone = live.msgs[iMeiDone]
  assert.equal((meiDone!.event as { payload: Record<string, unknown> }).payload.sessionEnded, true)

  // ── Item 3: box-c silent for longer than the retire time (2 min here): its other sub-agent is finished. ──────
  clock.t += 60_000 // box-c silent 121 s
  ingest.sweep()
  assert.equal(status(SC, HIRO), 'finished')
  const isHiroC = (m: Msg) => m.type === 'agent-event' && (m.event as { sessionId: string }).sessionId === SC
    && (m.event as { payload: { name: string } }).payload.name === HIRO && (m.event as { type: string }).type === 'agent_complete'
  await until(() => live.msgs.some(isHiroC), 'Hiro of box-c finished')
  const hiroC = live.msgs.find(isHiroC)
  assert.equal((hiroC!.event as { payload: Record<string, unknown> }).payload.sessionEnded, true)
  // Not retired: still listed, stale (history for the UI), never removed.
  snap = await snapshot(port)
  const cEntry = snap.list.find((s) => s.id === SC)
  assert.ok(cEntry && cEntry.stale === true, 'listed as stale')
  assert.ok(!live.msgs.some((m) => m.type === 'session-removed' && m.sessionId === SC))

  // ── Item 4: the container offboards an agent the hub still has running: finished first, then offboarded. ────
  const markD = live.msgs.length
  const res4 = await post('box-d', 'gamma', [{ type: 'agents-offboarded', sessionId: SD, agents: [REN] }])
  assert.deepEqual([res4.applied, res4.ignored], [1, 0])
  assert.equal(store.isOffboarded(SD, REN), true)
  assert.equal(status(SD, REN), 'finished')
  await until(() => live.msgs.slice(markD).some((m) => m.type === 'agents-offboarded'), 'agents-offboarded from the container')
  const iRen = live.msgs.slice(markD).findIndex((m) => m.type === 'agent-event' && (m.event as { type: string }).type === 'agent_complete')
  const iOff = live.msgs.slice(markD).findIndex((m) => m.type === 'agents-offboarded')
  assert.ok(iRen >= 0 && iOff > iRen, 'the completion comes before the offboarding')
  // Other refusals are logged, once per source per minute.
  const before = logs.filter((l) => l.includes('offboarding from box-d not applied')).length
  for (let i = 0; i < 3; i++) {
    const x = await post('box-d', 'gamma', [{ type: 'agents-offboarded', sessionId: SD, agents: ['Nobody (QA Engineer): x', 'orchestrator'] }])
    assert.deepEqual([x.applied, x.ignored], [0, 2])
  }
  assert.equal(logs.filter((l) => l.includes('offboarding from box-d not applied')).length, before + 1)

  // ── AC6: the forwarder announcing its session again (409 epoch / hub restart) does not duplicate it. ─────────
  await post('box-d', 'gamma', start(SD, [REN]))
  snap = await snapshot(port)
  assert.equal(snap.list.filter((s) => s.id === SD).length, 1)

  // ── Item 5 on eviction: every source silent for 24 h is removed; each session, the retired SA included, gets
  //    exactly one session-removed (after its session-ended); SA ended already, so it gets no second one. ───────
  const markE = live.msgs.length
  clock.t += 25 * 60 * MIN
  ingest.sweep()
  await until(() => live.msgs.slice(markE).filter((m) => m.type === 'session-removed').length === 4, 'four removals')
  const tail = live.msgs.slice(markE)
  for (const s of [SA, SB, SC, SD]) {
    assert.equal(tail.filter((m) => m.type === 'session-removed' && m.sessionId === s).length, 1, `one removal for ${s}`)
    assert.deepEqual(tail.find((m) => m.type === 'session-removed' && m.sessionId === s), { type: 'session-removed', sessionId: s }, 'exactly the contract shape')
    const iEnd = tail.findIndex((m) => m.type === 'session-ended' && m.sessionId === s)
    const iRem = tail.findIndex((m) => m.type === 'session-removed' && m.sessionId === s)
    if (iEnd >= 0) assert.ok(iEnd < iRem, `${s}: ended before removed`)
  }
  assert.ok(!tail.some((m) => m.type === 'session-ended' && m.sessionId === SA), 'SA ended at its retirement already')
  assert.equal(live.msgs.filter((m) => m.type === 'session-removed' && m.sessionId === SA).length, 1)
  snap = await snapshot(port)
  assert.deepEqual(snap.list, [])
  assert.equal(team.list().filter((p) => p.origin === 'cloud').length, 0)
})
