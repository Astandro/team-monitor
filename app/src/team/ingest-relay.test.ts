/**
 * Hub intake through the real relay (criterion 3 and the stale contract): events posted to /api/ingest reach
 * `/events` clients, also ones that connect later (session list + replay), marked origin "cloud"; a repeated seq
 * adds nothing; a stale source's sessions carry `stale: true` on every message; offboarding works as for local
 * sessions.
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
const SRC = 'cloud-box-7'
const OTHER = 'cloud-box-8'
/** Hub project of the repo (`project.id` "repo"; spec 0.9.8 item 1: one hub project per repo, not per source). */
const PID = 'cloud-repo'
const S = '5a6b7c8d-0000-4000-8000-0000000000c1'
const HIRO = 'Hiro (Frontend Engineer): panel'

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
  return { msgs, close: () => req.destroy() }
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('cloud sessions on /events: replay for late clients, seq dedupe, stale on every message, offboarding', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRelay } = require('../../../scripts/relay') as typeof import('../../../scripts/relay')
  const store = new OffboardStore(tmHome)
  const relay = await createRelay({ workspace, runtime: 'claude', offboarded: store, autoOffboardMinutes: 60 })
  cleanups.push(() => relay.dispose())
  const team = new TeamService([], { pollMs: 60_000 })
  team.offboard = store
  team.graph = relay.graph
  const clock = { t: Date.now() }
  const ingest = new IngestService({ home: tmHome, token: TOKEN, team, now: () => clock.t, sweepMs: 0, log: () => {} })
  ingest.start()
  ingest.attachRelay(relay.cloud)
  cleanups.push(() => { ingest.dispose(); team.dispose() })
  const handler = createRequestHandler({
    team, remote: null, ingest,
    fallback: (req, res) => { if (req.url === '/events') return relay.handleSSE(req, res); res.writeHead(404); res.end() },
  })
  const srv = await listen(handler)
  cleanups.push(() => srv.close())
  const port = srv.port

  const post = (seq: number, messages: unknown[], sourceId = SRC) => request(port, {
    method: 'POST', path: '/api/ingest/v1/events',
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Team-Monitor-Source-Key': sourceId === SRC ? 'a1'.repeat(32) : 'b2'.repeat(32), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, project: { id: 'repo', name: 'Repo' }, seq, messages }),
  })
  const ev = (type: string, payload: Record<string, unknown>, sessionId = S) => ({ time: 1, type, payload, sessionId })

  const live = openSSE(port)
  cleanups.push(live.close)
  await new Promise((r) => setTimeout(r, 50))

  const batch = [
    { type: 'session-started', session: { id: S, label: 'Repo', status: 'active', startTime: 1, lastActivityTime: 1, prompt: 'build it' } },
    { type: 'agent-event', event: ev('agent_spawn', { name: 'orchestrator', isMain: true, task: 'build it' }) },
    { type: 'agent-event-batch', events: [ev('agent_spawn', { name: HIRO, parent: 'orchestrator', task: 'panel' }), ev('tool_call_start', { agent: HIRO, tool: 'Read' })] },
  ]
  const r1 = await post(1, batch)
  assert.equal(r1.status, 200, r1.body)
  assert.deepEqual(JSON.parse(r1.body), { ok: true, seq: 1, applied: 4, ignored: 0 })

  // The open client got the lifecycle message marked as cloud.
  await until(() => live.msgs.some((m) => m.type === 'session-started'), 'session-started')
  const started = live.msgs.find((m) => m.type === 'session-started')!.session as Record<string, unknown>
  assert.equal(started.origin, 'cloud')
  assert.equal(started.sourceId, SRC)
  assert.equal(started.stale, false)
  assert.equal(started.projectId, PID)
  await until(() => live.msgs.filter((m) => m.type === 'agent-event').length === 3, 'three live events')

  // A client that connects later gets the session list and the replay.
  const late = openSSE(port)
  cleanups.push(late.close)
  await until(() => late.msgs.some((m) => m.type === 'agent-event-batch'), 'replay')
  const list = late.msgs.find((m) => m.type === 'session-list')!.sessions as Array<Record<string, unknown>>
  assert.equal(list.length, 1)
  assert.deepEqual({ id: list[0].id, origin: list[0].origin, sourceId: list[0].sourceId, stale: list[0].stale, projectId: list[0].projectId, label: list[0].label },
    { id: S, origin: 'cloud', sourceId: SRC, stale: false, projectId: PID, label: 'Repo' })
  const replayed = late.msgs.find((m) => m.type === 'agent-event-batch')!.events as Array<{ type: string }>
  assert.deepEqual(replayed.map((e) => e.type), ['agent_spawn', 'agent_spawn', 'tool_call_start'])

  // Reposting the same seq adds nothing.
  const dup = await post(1, batch)
  assert.deepEqual(JSON.parse(dup.body), { ok: true, seq: 1, duplicate: true })
  const later = openSSE(port)
  cleanups.push(later.close)
  await until(() => later.msgs.some((m) => m.type === 'agent-event-batch'), 'replay after the repost')
  assert.equal((later.msgs.find((m) => m.type === 'agent-event-batch')!.events as unknown[]).length, 3)
  assert.equal(live.msgs.filter((m) => m.type === 'agent-event').length, 3, 'nothing re-sent live')

  // Another source cannot write into this session.
  const hijack = await post(1, [{ type: 'agent-event', event: ev('agent_complete', { name: HIRO }) }, { type: 'session-ended', sessionId: S }], OTHER)
  assert.deepEqual(JSON.parse(hijack.body), { ok: true, seq: 1, applied: 0, ignored: 2 })
  assert.equal(relay.graph.agents(S)!.find((a) => a.name === HIRO)?.status, 'running')

  // The graph view knows the cloud session (offboard endpoints, auto offboarding).
  assert.ok(relay.graph.sessions().includes(S))
  assert.equal(relay.graph.sessionProject(S), PID)

  // Stale: every message about its sessions says so, also for a client that connects while it is stale.
  clock.t += 61_000
  ingest.sweep()
  await until(() => live.msgs.some((m) => m.type === 'session-updated' && m.stale === true), 'stale update')
  const staleUpd = live.msgs.find((m) => m.type === 'session-updated' && m.stale === true)!
  assert.deepEqual({ sessionId: staleUpd.sessionId, origin: staleUpd.origin, sourceId: staleUpd.sourceId, projectId: staleUpd.projectId },
    { sessionId: S, origin: 'cloud', sourceId: SRC, projectId: PID })
  assert.ok(live.msgs.some((m) => m.type === 'projects-changed'))
  assert.equal(team.list().find((p) => p.id === PID)?.stale, true)
  const whileStale = openSSE(port)
  cleanups.push(whileStale.close)
  await until(() => whileStale.msgs.some((m) => m.type === 'session-list'), 'list while stale')
  const staleEntry = (whileStale.msgs.find((m) => m.type === 'session-list')!.sessions as Array<Record<string, unknown>>)[0]
  assert.equal(staleEntry.stale, true)
  assert.equal(staleEntry.origin, 'cloud')

  // The next request makes it live: session-updated with stale false, origin and sourceId still on it.
  const before = live.msgs.length
  const r2 = await post(2, [{ type: 'session-updated', sessionId: S, label: 'Repo baru' }])
  assert.equal(r2.status, 200)
  await until(() => live.msgs.slice(before).filter((m) => m.type === 'session-updated').length >= 2, 'live again + label')
  for (const m of live.msgs.slice(before).filter((x) => x.type === 'session-updated')) {
    assert.equal(m.stale, false)
    assert.equal(m.origin, 'cloud')
    assert.equal(m.sourceId, SRC)
  }
  assert.equal(live.msgs.slice(before).filter((x) => x.type === 'session-updated').pop()!.label, 'Repo baru')

  // Offboarding: the sub-agent finishes, the source offboards it; the hub records it and tells viewers.
  const r3 = await post(3, [
    { type: 'agent-event', event: ev('agent_complete', { name: HIRO }) },
    { type: 'agents-offboarded', sessionId: S, agents: [HIRO] },
  ])
  assert.deepEqual(JSON.parse(r3.body), { ok: true, seq: 3, applied: 2, ignored: 0 })
  assert.equal(store.isOffboarded(S, HIRO), true)
  assert.equal(store.get(S, HIRO)?.project, PID)
  await until(() => live.msgs.some((m) => m.type === 'agents-offboarded'), 'agents-offboarded')
  const afterOffboard = openSSE(port)
  cleanups.push(afterOffboard.close)
  await until(() => afterOffboard.msgs.some((m) => m.type === 'agent-event-batch'), 'replay after offboarding')
  const names = (afterOffboard.msgs.find((m) => m.type === 'agent-event-batch')!.events as Array<{ payload: { name?: string; agent?: string } }>)
    .map((e) => e.payload.name ?? e.payload.agent)
  assert.ok(!names.includes(HIRO), 'an offboarded cloud agent is not replayed')

  // session-ended marks it completed in the list.
  await post(4, [{ type: 'session-ended', sessionId: S }])
  const end = openSSE(port)
  cleanups.push(end.close)
  await until(() => end.msgs.some((m) => m.type === 'session-list'), 'list after end')
  assert.equal((end.msgs.find((m) => m.type === 'session-list')!.sessions as Array<Record<string, unknown>>)[0].status, 'completed')
})
