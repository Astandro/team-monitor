/**
 * 0.9.8 fix round (F1 option A, F7) through the real relay, with a local Claude session on disk next to cloud
 * sources: retiring a source ends its sessions but keeps them listed (completed) and replayed, with no
 * `session-removed`; a retired source that reports again revives its session; `session-removed` is sent only on a
 * real eviction (the cloud session cap, the 24 h source removal), once per session, and never for a local session
 * (also not when a cloud source names the local session's id).
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
import { encodeProjectPath } from '../../../scripts/session-projects'

const root = makeTmpDir()
const home = path.join(root, 'home')
const workspace = path.join(root, 'proj')
const tmHome = path.join(root, 'tm')
for (const d of [home, workspace, tmHome]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })

/** The local session: a Claude transcript of the start folder, written just now (picked up at relay start). */
const LOCAL = '7e23e8af-0000-4000-8000-0000000000ee'
const line = (o: unknown) => JSON.stringify(o) + '\n'
const projDir = path.join(home, '.claude', 'projects', encodeProjectPath(workspace))
fs.mkdirSync(projDir, { recursive: true })
fs.writeFileSync(path.join(projDir, `${LOCAL}.jsonl`),
  line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } }) +
  line({
    type: 'assistant', uuid: 'a1',
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Hiro (Frontend Engineer): panel', prompt: 'go' } }] },
  }))

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

const TOKEN = '9c'.repeat(32)
const MIN = 60_000
const HIRO = 'Hiro (Frontend Engineer): panel'
const sid = (n: number) => `6b7c8d9e-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`
const SA = sid(1)
const SB = sid(2)
const SC = sid(3)
const SD = sid(4)
const SE = sid(5)
const KEYS: Record<string, string> = {
  'box-a': 'a1'.repeat(32), 'box-b': 'b2'.repeat(32), 'box-c': 'c3'.repeat(32), 'box-d': 'd4'.repeat(32), 'box-e': 'e5'.repeat(32),
}

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
  await new Promise((r) => setTimeout(r, 150))
  c.close()
  const list = (c.msgs.find((m) => m.type === 'session-list')?.sessions ?? []) as Array<Record<string, unknown>>
  const replayed = new Set<string>()
  for (const m of c.msgs.filter((x) => x.type === 'agent-event-batch')) {
    for (const e of m.events as Array<{ sessionId?: string }>) if (e.sessionId) replayed.add(e.sessionId)
  }
  return { list, replayed }
}

test('F1/F7: retire keeps sessions listed (no session-removed); eviction removes them once; never for a local session', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRelay } = require('../../../scripts/relay') as typeof import('../../../scripts/relay')
  const store = new OffboardStore(tmHome)
  const relay = await createRelay({ workspace, runtime: 'claude', offboarded: store, autoOffboardMinutes: 60, cloudLimits: { maxSessions: 4 } })
  cleanups.push(() => relay.dispose())
  const team = new TeamService([], { pollMs: 60_000 })
  team.offboard = store
  team.graph = relay.graph
  const clock = { t: Date.now() }
  const ingest = new IngestService({ home: tmHome, token: TOKEN, team, now: () => clock.t, sweepMs: 0, log: () => {}, cloudRetireAfterMs: 2 * MIN })
  ingest.start()
  ingest.attachRelay(relay.cloud)
  cleanups.push(() => { ingest.dispose(); team.dispose() })
  const srv = await listen(createRequestHandler({
    team, remote: null, ingest,
    fallback: (req, res) => { if (req.url === '/events') return relay.handleSSE(req, res); res.writeHead(404); res.end() },
  }))
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

  const live = openSSE(port)
  // The local session is on the graph (listed for a new client).
  let snap = await snapshot(port)
  for (let i = 0; i < 30 && !snap.list.some((s) => s.id === LOCAL); i++) snap = await snapshot(port)
  assert.ok(snap.list.some((s) => s.id === LOCAL), 'the local session is listed')
  const localEntry = () => snap.list.find((s) => s.id === LOCAL)
  const removedFor = (id: string) => live.msgs.filter((m) => m.type === 'session-removed' && m.sessionId === id)

  // ── Retire (F1 option A): box-a (alpha) and box-d (delta) go stale; a new source of each repo registers. ─────
  await post('box-a', 'alpha', start(SA, [HIRO]))
  await post('box-d', 'delta', start(SD, []))
  clock.t += 61_000
  ingest.sweep()
  await post('box-b', 'alpha', start(SB, []))
  await post('box-e', 'delta', start(SE, []))
  await until(() => live.msgs.some((m) => m.type === 'session-ended' && m.sessionId === SA)
    && live.msgs.some((m) => m.type === 'session-ended' && m.sessionId === SD), 'both retired sessions ended')
  assert.equal(relay.graph.agents(SA)?.find((a) => a.name === HIRO)?.status, 'finished', 'its sub-agent finished')
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(!live.msgs.some((m) => m.type === 'session-removed'), 'retiring sends no session-removed')

  // A client that connects (or reloads) now still gets the retired sessions, as completed, with their replay.
  snap = await snapshot(port)
  assert.deepEqual(snap.list.map((s) => s.id).sort(), [LOCAL, SA, SB, SD, SE].sort())
  for (const s of [SA, SD]) {
    const e = snap.list.find((x) => x.id === s)!
    assert.equal(e.status, 'completed', `${s} completed`)
    assert.equal(e.stale, true)
    assert.equal(e.origin, 'cloud')
    assert.ok(snap.replayed.has(s), `${s} replayed`)
  }
  assert.equal(localEntry()!.origin, undefined, 'the local entry carries no cloud fields')

  // ── A retired source comes back: its session is active again and announced afresh (same id), not removed. ──
  const markBack = live.msgs.length
  await post('box-d', 'delta', [ev(SD, 'message', { name: 'orchestrator', role: 'assistant', content: 'back' })])
  await until(() => live.msgs.slice(markBack).some((m) => m.type === 'session-started' && (m.session as { id: string }).id === SD), 'SD announced again')
  const back = live.msgs.slice(markBack).find((m) => m.type === 'session-started')!.session as Record<string, unknown>
  assert.equal(back.status, 'active')
  assert.equal(back.stale, false)
  snap = await snapshot(port)
  assert.equal(snap.list.filter((s) => s.id === SD).length, 1, 'still one entry')
  assert.equal(snap.list.find((s) => s.id === SD)!.status, 'active')

  // ── A cloud source naming the local session's id: every message dropped, the local session untouched. ─────
  const hijack = await post('box-e', 'delta', [
    { type: 'session-started', session: { id: LOCAL, label: 'x', status: 'active', startTime: 1, lastActivityTime: 1 } },
    ev(LOCAL, 'agent_spawn', { name: 'Mallory (QA Engineer): x', parent: 'orchestrator', task: 'x' }),
    { type: 'session-ended', sessionId: LOCAL },
    { type: 'agents-offboarded', sessionId: LOCAL, agents: [HIRO] },
  ])
  assert.deepEqual([hijack.applied, hijack.ignored], [0, 4])
  assert.equal(relay.cloud.sourceOf(LOCAL), null)

  // ── Capacity (cap 4: SA, SB, SD, SE): a new session evicts the retired SA, the only candidate. ─────────────
  const markCap = live.msgs.length
  await post('box-c', 'gamma', start(SC, []))
  await until(() => removedFor(SA).length === 1, 'SA removed at the cap')
  const capTail = live.msgs.slice(markCap)
  assert.deepEqual(capTail.find((m) => m.type === 'session-removed'), { type: 'session-removed', sessionId: SA })
  assert.ok(!capTail.some((m) => m.type === 'session-ended' && m.sessionId === SA), 'ended at its retirement already: not again')
  assert.deepEqual(capTail.filter((m) => m.type === 'session-removed').map((m) => m.sessionId), [SA], 'nothing else evicted')
  snap = await snapshot(port)
  assert.deepEqual(snap.list.map((s) => s.id).sort(), [LOCAL, SB, SC, SD, SE].sort())
  assert.ok(!snap.replayed.has(SA))

  // ── 24 h: every source is removed; each remaining cloud session removed once; the local one stays. ─────────
  const markIdle = live.msgs.length
  clock.t += 25 * 60 * MIN
  ingest.sweep()
  await until(() => live.msgs.slice(markIdle).filter((m) => m.type === 'session-removed').length === 4, 'four removals')
  const idleTail = live.msgs.slice(markIdle)
  for (const s of [SB, SC, SD, SE]) {
    assert.equal(idleTail.filter((m) => m.type === 'session-removed' && m.sessionId === s).length, 1, `one removal for ${s}`)
    const iEnd = idleTail.findIndex((m) => m.type === 'session-ended' && m.sessionId === s)
    const iRem = idleTail.findIndex((m) => m.type === 'session-removed' && m.sessionId === s)
    if (iEnd >= 0) assert.ok(iEnd < iRem, `${s}: ended before removed`)
  }
  assert.equal(removedFor(SA).length, 1, 'SA removed once in all')
  snap = await snapshot(port)
  assert.deepEqual(snap.list.map((s) => s.id), [LOCAL])

  // Never a session-removed (nor a session-ended from these paths) for the local session.
  assert.equal(removedFor(LOCAL).length, 0)
  assert.ok(!live.msgs.some((m) => m.type === 'session-ended' && m.sessionId === LOCAL))
})
