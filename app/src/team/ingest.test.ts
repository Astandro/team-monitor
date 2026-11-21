/**
 * Hub intake (`--ingest`): routes, token, validation, mirror, outbox, stale marking, mirror pruning, doctor checks.
 * The relay is replaced by a recording fake here; ingest-relay.test.ts runs the real one.
 */
import { test, describe, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { parseArgs } from '../args'
import { LoginLimiter, SessionStore } from './auth'
import { buildRegistry } from './config'
import { funnelEntries, ingestChecks } from './doctor'
import { createRequestHandler, RemoteAccess, TeamService } from './http'
import * as crypto from 'crypto'
import { CLOUD_RETIRE_AFTER_MS, cloudRetireAfterMs, EPOCH_HEADER, IngestService, jsonTooDeep, MAX_EVENT_BYTES, MAX_JSON_DEPTH, MAX_MESSAGES, mirrorPath, parseEventsBody } from './ingest'
import type { CloudIntake, CloudMessage } from '../../../scripts/relay'
import { setupTeam } from './index'
import { parseInstallArgs, programArguments, ServiceSpec } from './service'
import { waitForAnswer } from './wait-answer'
import { listen, makeProject, makeTmpDir, removeTmpDir, request, Resp, sampleState, waitFor } from './test-helpers'
import { TombstoneStore } from './ingest-tombstones'

const INGEST = 'cd'.repeat(32)
const LOGIN = 'ab'.repeat(32)
const SRC = 'cloud-box-1'
/** Hub project of the test repo (`project.id` "my-repo"; spec 0.9.8 item 1: one hub project per repo). */
const PID = 'cloud-my-repo'
const S1 = '0b1c2d3e-0000-4000-8000-000000000001'

class FakeRelay implements CloudIntake {
  applied: Array<{ sourceId: string; projectId: string; messages: CloudMessage[] }> = []
  stale: Array<[string, boolean]> = []
  projectsChanged = 0
  owner = new Map<string, string>()
  /** makeRoom's answer (false: every session live and the cap reached). */
  room = true
  forgotten: string[] = []
  retired: string[] = []
  finished: string[] = []
  finishedAgents: Array<[string, string]> = []
  moved: Array<[string, string]> = []
  /** finishAgent's answer. */
  agentRunning = false
  makeRoom(_ids: string[]) { return this.room }
  forgetSource(sourceId: string) { this.forgotten.push(sourceId) }
  retireSource(sourceId: string) { this.retired.push(sourceId); return 0 }
  finishSource(sourceId: string) { this.finished.push(sourceId); return 0 }
  finishAgent(sessionId: string, agent: string) { this.finishedAgents.push([sessionId, agent]); return this.agentRunning }
  moveSource(sourceId: string, projectId: string) { this.moved.push([sourceId, projectId]) }
  apply(sourceId: string, projectId: string, messages: CloudMessage[]) {
    this.applied.push({ sourceId, projectId, messages })
    for (const m of messages) {
      const id = m.type === 'session-started' ? m.session.id : m.type === 'agent-event' ? m.event.sessionId : 'sessionId' in m ? m.sessionId : undefined
      if (id) this.owner.set(id, sourceId)
    }
    return { applied: messages.length, ignored: 0 }
  }
  setStale(sourceId: string, stale: boolean) { this.stale.push([sourceId, stale]) }
  sourceOf(sessionId: string) { return this.owner.get(sessionId) ?? null }
  announceProjectsChanged() { this.projectsChanged++ }
}

interface Ctx {
  root: string
  home: string
  local: string
  team: TeamService
  ingest: IngestService | null
  relay: FakeRelay
  clock: { t: number }
  port: number
  close: () => Promise<void>
  logs: string[]
  remote: RemoteAccess | null
}

async function setup(opts: { ingest?: boolean; remote?: boolean; noRelay?: boolean; maxSources?: number; maxOutboxWaiters?: number; retireAfterMs?: number } = {}): Promise<Ctx> {
  const root = makeTmpDir()
  const home = path.join(root, 'tm')
  fs.mkdirSync(home, { mode: 0o700 })
  const local = makeProject(root, 'lokal')
  const logs: string[] = []
  const team = new TeamService(buildRegistry([], [local]), { debounceMs: 10, pollMs: 60_000, log: (m) => logs.push(m) })
  const clock = { t: Date.now() }
  const relay = new FakeRelay()
  let ingest: IngestService | null = null
  if (opts.ingest !== false) {
    ingest = new IngestService({
      home, token: INGEST, team, limiter: new LoginLimiter(5), now: () => clock.t, log: (m) => logs.push(m), sweepMs: 0, outboxPollMs: 50,
      maxSources: opts.maxSources, maxOutboxWaiters: opts.maxOutboxWaiters, cloudRetireAfterMs: opts.retireAfterMs,
    })
    ingest.start()
    if (!opts.noRelay) ingest.attachRelay(relay)
  }
  let remote: RemoteAccess | null = null
  if (opts.remote) {
    const config = {
      bindMode: 'loopback' as const, bindAddress: '127.0.0.1', tailscaleIp: '100.101.102.103', dnsName: 'box.example.ts.net',
      allowedHosts: new Set(['100.101.102.103', 'box.example.ts.net']),
    }
    remote = { config, token: LOGIN, sessions: new SessionStore(null, LOGIN), limiter: new LoginLimiter(5) }
  }
  const handler = createRequestHandler({
    team, remote, ingest, log: (m) => logs.push(m),
    fallback: (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('fallback') },
  })
  const { port, close } = await listen(handler)
  return { root, home, local, team, ingest, relay, clock, port, close, logs, remote }
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.close()
  ctx.ingest?.dispose()
  ctx.team.dispose()
  removeTmpDir(ctx.root)
}

/** The source key of the test source (X-Team-Monitor-Source-Key). */
const KEY = '5e'.repeat(32)
const OTHER_KEY = '0f'.repeat(32)
const auth = (token = INGEST, key = KEY) => ({ Authorization: `Bearer ${token}`, 'X-Team-Monitor-Source-Key': key })
const JSON_H = { 'Content-Type': 'application/json' }

function send(ctx: Ctx, method: string, p: string, body?: unknown, headers: Record<string, string> = auth()): Promise<Resp> {
  return request(ctx.port, {
    method, path: p, headers: { ...(body !== undefined ? JSON_H : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const project = { id: 'my-repo', name: 'My Repo' }
const startMsg = (id = S1) => ({ type: 'session-started', session: { id, label: 'My Repo', status: 'active', startTime: 1, lastActivityTime: 1 } })
const eventMsg = (id = S1, type = 'agent_spawn') => ({ type: 'agent-event', event: { time: 0, type, payload: { name: 'orchestrator', isMain: true }, sessionId: id } })
const events = (ctx: Ctx, seq: number, messages: unknown[] = [startMsg(), eventMsg()], sourceId = SRC) =>
  send(ctx, 'POST', '/api/ingest/v1/events', { sourceId, project, seq, messages })
const putState = (ctx: Ctx, state: unknown = sampleState(), watcher: unknown = null, sourceId = SRC) =>
  send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId, project, state, watcher })
const projects = async (ctx: Ctx) => JSON.parse((await request(ctx.port, { path: '/api/team/projects' })).body).projects as Array<Record<string, unknown>>

/** Every path under `dir`, relative, sorted (to prove nothing was written elsewhere). */
function tree(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      out.push(path.relative(dir, p))
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out.sort()
}

/** POST without Content-Length (chunked), resolving on the response even if the upload is cut off. */
function postChunked(port: number, p: string, size: number, method = 'POST'): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...JSON_H, ...auth() } })
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0) })
    req.on('error', () => { /* the server closes after its early reply */ })
    const chunk = Buffer.alloc(64 * 1024, 0x20)
    let sent = 0
    const pump = () => {
      while (sent < size) {
        sent += chunk.length
        if (!req.write(chunk)) { req.once('drain', pump); return }
      }
      req.end()
    }
    pump()
  })
}

// ─── Criterion 1: --ingest off ───────────────────────────────────────────────

describe('ingest off', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup({ ingest: false }) })
  after(async () => { await teardown(ctx) })

  test('every /api/ingest route answers 404, with or without a token, any Host', async () => {
    for (const [method, p] of [['POST', '/api/ingest/v1/events'], ['PUT', '/api/ingest/v1/state'], ['GET', `/api/ingest/v1/outbox?sourceId=${SRC}`],
      ['GET', '/api/ingest'], ['GET', '/api/ingest/'], ['GET', '/api/ingest/other']] as const) {
      assert.equal((await send(ctx, method, p, method === 'GET' ? undefined : {})).status, 404, `${method} ${p}`)
      assert.equal((await send(ctx, method, p, method === 'GET' ? undefined : {}, {})).status, 404, `${method} ${p} without token`)
    }
    assert.equal((await send(ctx, 'GET', '/api/ingest/v1/outbox', undefined, { Host: 'public.example.com' })).status, 404)
    assert.ok(!fs.existsSync(path.join(ctx.home, 'remote')))
    assert.ok(!fs.existsSync(path.join(ctx.home, 'ingest-token')))
  })

  test('a path under /api/ingest that normalises elsewhere still answers 404, never the team API or the UI', async () => {
    for (const p of ['/api/ingest/%2e%2e/team/projects', '/api/ingest/../team/projects', '/api/ingest/%2E%2E/%2E%2E/', '/api/ingest%2f..%2fteam/projects']) {
      const r = await send(ctx, 'GET', p)
      assert.equal(r.status, 404, p)
      assert.ok(!r.body.includes('projects') && r.body !== 'fallback', p)
    }
  })

  test('setupTeam without --ingest has no intake and creates no ingest token', () => {
    const root = makeTmpDir()
    try {
      const setup1 = setupTeam({ projects: [], remote: false, hostAllow: [] }, { env: { TEAM_MONITOR_HOME: root }, log: () => {}, warn: () => {} })
      assert.equal(setup1.ingest, null)
      setup1.dispose()
      assert.ok(!fs.existsSync(path.join(root, 'ingest-token')))
    } finally { removeTmpDir(root) }
  })
})

// ─── Criterion 2: token ─────────────────────────────────────────────────────

describe('ingest token', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup({ remote: true }) })
  after(async () => { await teardown(ctx) })

  test('401 without the ingest token, from loopback, with the login token and with a valid login session', async () => {
    const sid = ctx.remote!.sessions.create()
    const cookie = { Cookie: `tm_session=${sid}` }
    const tries: Array<Record<string, string>> = [{}, auth('00'.repeat(32)), auth(LOGIN), cookie, { ...cookie, ...auth(LOGIN) }, { Authorization: INGEST }]
    for (const [i, headers] of tries.entries()) {
      // A client address per try, so the limiter (5 per client) does not answer 429 first.
      const r = await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, { 'X-Forwarded-For': `198.51.100.${i + 1}`, ...headers })
      assert.equal(r.status, 401, JSON.stringify(Object.keys(headers)))
    }
    assert.equal((await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC, project, seq: 1, messages: [] }, cookie)).status, 401)
    assert.equal((await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: SRC, project, state: null, watcher: null }, auth(LOGIN))).status, 401)
    assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', SRC)), 'nothing written without the token')
  })

  test('the ingest token does not open the team API or the UI (remote mode, through serve)', async () => {
    const r = await request(ctx.port, {
      path: '/api/team/projects', headers: { Host: 'box.example.ts.net', 'X-Forwarded-For': '100.64.0.9', ...auth() },
    })
    assert.equal(r.status, 401)
  })

  test('failures count per client: 429 after 5, other clients and the right token still pass', async () => {
    const fwd = { 'X-Forwarded-For': '203.0.113.7' }
    for (let i = 0; i < 5; i++) assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, { ...fwd, ...auth('x') })).status, 401)
    const limited = await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, { ...fwd, ...auth('x') })
    assert.equal(limited.status, 429)
    assert.ok(Number(limited.headers['retry-after']) > 0)
    assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, { ...fwd, ...auth() })).status, 200, 'the right token is not locked out')
    assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, { 'X-Forwarded-For': '203.0.113.8', ...auth('x') })).status, 401)
  })

  test('with the token, a foreign Host (Funnel) is accepted on ingest routes only', async () => {
    const r = await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, { Host: 'public.example.ts.net', ...auth() })
    assert.equal(r.status, 200)
    assert.equal((await request(ctx.port, { path: '/', headers: { Host: 'public.example.ts.net' } })).status, 403)
  })
})

// ─── Criteria 3-4 (with the fake relay), routes and seq ─────────────────────

describe('events and state', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup() })
  after(async () => { await teardown(ctx) })

  test('events register the cloud project and reach the relay; the same or a lower seq is acknowledged and ignored', async () => {
    const r = await events(ctx, 5)
    assert.equal(r.status, 200, r.body)
    assert.deepEqual(JSON.parse(r.body), { ok: true, seq: 5, applied: 2, ignored: 0 })
    assert.equal(ctx.relay.applied.length, 2)
    assert.deepEqual(ctx.relay.applied.map((a) => [a.sourceId, a.projectId, a.messages[0].type]), [[SRC, PID, 'session-started'], [SRC, PID, 'agent-event']])
    const listed = (await projects(ctx)).find((p) => p.id === PID)
    assert.deepEqual(listed, { id: PID, name: 'My Repo', hasState: false, origin: 'cloud', sourceId: SRC, stale: false })
    const localEntry = (await projects(ctx)).find((p) => p.id === 'lokal')
    assert.deepEqual(Object.keys(localEntry!).sort(), ['hasState', 'id', 'name'], 'local projects carry no cloud fields')
    assert.ok(ctx.relay.projectsChanged >= 1)

    for (const seq of [5, 3]) {
      const dup = await events(ctx, seq)
      assert.equal(dup.status, 200)
      assert.deepEqual(JSON.parse(dup.body), { ok: true, seq: 5, duplicate: true })
    }
    assert.equal(ctx.relay.applied.length, 2, 'a repeated seq adds nothing')
    assert.equal((await events(ctx, 6, [eventMsg(S1, 'tool_call_start')])).status, 200)
    assert.equal(ctx.relay.applied.length, 3)
  })

  test('PUT state makes the project and its tasks and decisions appear without a restart', async () => {
    const state = sampleState({ tasks: { T1: { title: 'Bangun', status: 'doing' } } })
    const beat = new Date(ctx.clock.t - 10 * 60_000).toISOString()
    const r = await putState(ctx, state, { pid: 999999, startedAt: beat, beatAt: beat })
    assert.equal(r.status, 200, r.body)
    assert.deepEqual(JSON.parse(r.body), { ok: true })
    const listed = (await projects(ctx)).find((p) => p.id === PID)
    assert.equal(listed?.hasState, true)
    const snap = JSON.parse((await request(ctx.port, { path: `/api/team/state?project=${PID}` })).body)
    assert.deepEqual(snap.state.tasks, { T1: { title: 'Bangun', status: 'doing' } })
    assert.equal(snap.state.approvals.D1.status, 'open')
    // The heartbeat is another machine's: stamped with this machine's time, pid not checked here.
    assert.equal(snap.watcher.alive, true)
    const mirror = path.join(ctx.home, 'remote', SRC, '.agent-team')
    assert.equal(fs.statSync(path.join(mirror, 'state.json')).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(ctx.home, 'remote', SRC)).mode & 0o777, 0o700)
    assert.ok(!fs.readdirSync(mirror).some((n) => n.endsWith('.tmp')), 'no temp files left')
    // The local graph does not look for cloud projects on disk.
    assert.deepEqual(ctx.team.graphProjects().map((p) => p.id), ['lokal'])

    // state null removes the mirrored state.json; the project stays.
    assert.equal((await putState(ctx, null, null)).status, 200)
    assert.ok(!fs.existsSync(path.join(mirror, 'state.json')))
    assert.ok(!fs.existsSync(path.join(mirror, '.watcher')))
  })

  test('a renamed project is updated; wrong methods 405, unknown route 400; 503 before the relay runs', async () => {
    const r = await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: SRC, project: { id: 'my-repo', name: 'Nama Baru' }, state: null, watcher: null })
    assert.equal(r.status, 200)
    assert.equal((await projects(ctx)).find((p) => p.id === PID)?.name, 'Nama Baru')
    assert.equal((await send(ctx, 'GET', '/api/ingest/v1/events')).status, 405)
    assert.equal((await send(ctx, 'POST', '/api/ingest/v1/state', {})).status, 405)
    assert.equal((await send(ctx, 'POST', '/api/ingest/v1/outbox', {})).status, 405)
    assert.equal((await send(ctx, 'GET', '/api/ingest/v2/events')).status, 400)

    const early = await setup({ noRelay: true })
    try {
      assert.equal((await events(early, 1)).status, 503)
      assert.equal((await putState(early)).status, 200, 'state does not need the graph')
    } finally { await teardown(early) }
  })
})

// ─── Criterion 5: answers and chat come back through the outbox ─────────────

describe('outbox', () => {
  let ctx: Ctx
  before(async () => {
    ctx = await setup()
    assert.equal((await putState(ctx)).status, 200)
  })
  after(async () => { await teardown(ctx) })

  const writeHeaders = (ctx: Ctx) => ({ ...JSON_H, 'X-Team-Monitor': '1', Origin: `http://127.0.0.1:${ctx.port}` })
  const outbox = async (ctx: Ctx, q: string) => {
    const r = await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}${q}`)
    assert.equal(r.status, 200, r.body)
    return JSON.parse(r.body) as { cursor: string; files: Array<{ path: string; content: string }> }
  }

  test('an answer and a chat message from the hub UI are returned, then the cursor moves past them', async () => {
    const first = await outbox(ctx, '')
    assert.deepEqual(first.files, [])
    const a = await request(ctx.port, { method: 'POST', path: '/api/team/answer', headers: writeHeaders(ctx), body: JSON.stringify({ project: PID, id: 'D1', answer: 'b' }) })
    assert.equal(a.status, 200, a.body)
    const m = await request(ctx.port, { method: 'POST', path: '/api/team/message', headers: writeHeaders(ctx), body: JSON.stringify({ project: PID, text: 'Halo dari hub' }) })
    assert.equal(m.status, 200, m.body)

    const got = await outbox(ctx, `&after=${first.cursor}`)
    assert.deepEqual(got.files.map((f) => f.path.replace(/inbox\/.*/, 'inbox/*')), ['answers/D1.json', 'inbox/*'])
    assert.match(got.files[1].path, /^inbox\/[0-9]{13}-[0-9a-f]{12}\.json$/)
    assert.equal(JSON.parse(got.files[0].content).answer, 'b')
    assert.equal(JSON.parse(got.files[1].content).text, 'Halo dari hub')
    assert.deepEqual((await outbox(ctx, `&after=${got.cursor}`)).files, [])
    // A cursor from before a restart (another epoch) starts over.
    assert.equal((await outbox(ctx, '&after=00000000-1')).files.length, 2)

    // What the forwarder does with them (B): write the files into the container project; wait-answer then ends.
    const container = makeProject(ctx.root, 'container', sampleState())
    const answerWait = waitForAnswer({ projectPath: container, timeoutMs: 5000, pollMs: 50, includePending: false })
    // The coordinator's chat watcher; `ids` keeps the D1 answer from ending it first.
    const msgWait = waitForAnswer({ projectPath: container, timeoutMs: 5000, pollMs: 50, includePending: false, inbox: true, ids: new Set(['D99']) })
    await new Promise((r) => setTimeout(r, 100))
    for (const f of got.files) {
      const target = path.join(container, '.agent-team', f.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target + '.tmp', f.content)
      fs.renameSync(target + '.tmp', target)
    }
    const ans = await answerWait
    assert.equal(ans?.kind, 'answer')
    assert.equal(JSON.parse(ans!.content).answer, 'b')
    const msg = await msgWait
    assert.ok(msg)
    assert.ok(msg!.items.some((i) => JSON.parse(i.content).text === 'Halo dari hub'))
  })

  test('a long poll returns as soon as a message is written, and empty when the wait ends', async () => {
    const now = await outbox(ctx, '')
    const t0 = Date.now()
    const waiting = outbox(ctx, `&after=${now.cursor}&wait=10`)
    await new Promise((r) => setTimeout(r, 150))
    const m = await request(ctx.port, { method: 'POST', path: '/api/team/message', headers: writeHeaders(ctx), body: JSON.stringify({ project: PID, text: 'kedua' }) })
    assert.equal(m.status, 200)
    const got = await waiting
    assert.equal(got.files.length, 1)
    assert.equal(JSON.parse(got.files[0].content).text, 'kedua')
    assert.ok(Date.now() - t0 < 5000)

    const t1 = Date.now()
    const empty = await outbox(ctx, `&after=${got.cursor}&wait=1`)
    assert.deepEqual(empty.files, [])
    assert.ok(Date.now() - t1 >= 900, 'waited')
    // An unknown source gets an empty list (nothing is created for it).
    const unknown = await send(ctx, 'GET', '/api/ingest/v1/outbox?sourceId=never-seen&wait=0')
    assert.deepEqual(JSON.parse(unknown.body).files, [])
    assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', 'never-seen')))
  })
})

// ─── Criterion 6: refusals ──────────────────────────────────────────────────

describe('refusals', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup() })
  after(async () => { await teardown(ctx) })

  test('bad sourceId, path-like names, bad shapes: 400; oversized bodies: 413; nothing written outside remote/<sourceId>', async () => {
    const before = tree(ctx.root)
    for (const sourceId of ['../x', 'x/y', '..', 'A', '-x', '', 'a'.repeat(65), 'a.b', 'a\\b', 42, null]) {
      assert.equal((await events(ctx, 1, [], sourceId as string)).status, 400, `events ${String(sourceId)}`)
      assert.equal((await putState(ctx, null, null, sourceId as string)).status, 400, `state ${String(sourceId)}`)
    }
    for (const q of ['../x', '..%2Fx', 'x%2Fy', 'A', '']) {
      assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${q}`)).status, 400, `outbox ${q}`)
    }
    const bodies: unknown[] = [
      '{not json', [], { sourceId: SRC, project: { id: '../p', name: 'x' }, seq: 1, messages: [] },
      { sourceId: SRC, project: { id: 'p', name: '' }, seq: 1, messages: [] },
      { sourceId: SRC, project, seq: -1, messages: [] }, { sourceId: SRC, project, seq: 1.5, messages: [] },
      { sourceId: SRC, project, seq: 1, messages: {} },
      { sourceId: SRC, project, seq: 1, messages: [{ type: 'session-list', sessions: [] }] },
      { sourceId: SRC, project, seq: 1, messages: [{ type: 'agent-event', event: { time: 0, type: 'agent_spawn', payload: {} } }] },
      { sourceId: SRC, project, seq: 1, messages: [{ type: 'agent-event', event: { time: 0, type: 'agent_spawn', payload: {}, sessionId: '../../etc' } }] },
      { sourceId: SRC, project, seq: 1, messages: [{ type: 'agent-event', event: { time: 0, type: '<b>', payload: {}, sessionId: S1 } }] },
      { sourceId: SRC, project, seq: 1, messages: [{ type: 'session-ended', sessionId: 'a/b' }] },
      { sourceId: SRC, project, seq: 1, messages: Array.from({ length: MAX_MESSAGES + 1 }, () => ({ type: 'session-ended', sessionId: S1 })) },
    ]
    for (const b of bodies) assert.equal((await send(ctx, 'POST', '/api/ingest/v1/events', b)).status, 400, JSON.stringify(b).slice(0, 80))
    for (const b of [
      { sourceId: SRC, project, state: [], watcher: null }, { sourceId: SRC, project, state: null },
      { sourceId: SRC, project, state: null, watcher: { pid: -1, startedAt: 'x', beatAt: 'y' } },
    ]) assert.equal((await send(ctx, 'PUT', '/api/ingest/v1/state', b)).status, 400)
    assert.equal((await send(ctx, 'POST', '/api/ingest/v1/events', '{}', { ...auth(), 'Content-Type': 'text/plain' })).status, 400)
    assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}&after=../../x`)).status, 400)
    assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}&wait=26`)).status, 400)

    // Too large: declared and counted while reading (no Content-Length).
    const big = JSON.stringify({ sourceId: SRC, project, seq: 1, messages: [{ type: 'session-ended', sessionId: S1, pad: 'x'.repeat(600 * 1024) }] })
    assert.equal((await send(ctx, 'POST', '/api/ingest/v1/events', big)).status, 413)
    assert.equal(await postChunked(ctx.port, '/api/ingest/v1/events', 700 * 1024), 413)
    assert.equal(await postChunked(ctx.port, '/api/ingest/v1/state', 1200 * 1024, 'PUT'), 413)
    const bigState = JSON.stringify({ sourceId: SRC, project, state: { pad: 'x'.repeat(1100 * 1024) }, watcher: null })
    assert.equal((await send(ctx, 'PUT', '/api/ingest/v1/state', bigState)).status, 413)

    assert.deepEqual(tree(ctx.root), before, 'refused requests wrote nothing')

    // An accepted request writes only under remote/<sourceId>/ (plus the remote/ folder itself).
    assert.equal((await putState(ctx)).status, 200)
    const added = tree(ctx.root).filter((p) => !before.includes(p))
    const prefix = path.join('tm', 'remote')
    assert.ok(added.length > 0)
    for (const p of added) assert.ok(p === prefix || p.startsWith(path.join(prefix, SRC)), p)
    assert.equal(ctx.relay.applied.length, 0)
  })

  test('mirrorPath and parseEventsBody refuse path-like ids directly', () => {
    for (const bad of ['..', '../x', 'a/b', '/abs', 'A']) assert.throws(() => mirrorPath('/tmp/remote', bad))
    assert.equal(mirrorPath('/tmp/remote', 'ok-1'), path.resolve('/tmp/remote/ok-1'))
    const parsed = parseEventsBody({ sourceId: SRC, project: { id: 'p', name: ' A\nB\u0000 ' }, seq: 0, messages: [startMsg()] })
    assert.equal(parsed.project.name, 'A B')
  })
})

// ─── Stale marking ──────────────────────────────────────────────────────────

describe('stale sources', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup() })
  after(async () => { await teardown(ctx) })

  test('60 s without a request marks the source stale; the next request makes it live again', async () => {
    assert.equal((await events(ctx, 1)).status, 200)
    ctx.ingest!.sweep()
    assert.equal((await projects(ctx)).find((p) => p.id === PID)?.stale, false)
    const changedBefore = ctx.relay.projectsChanged

    ctx.clock.t += 59_000
    ctx.ingest!.sweep()
    assert.deepEqual(ctx.relay.stale, [])
    ctx.clock.t += 2_000
    ctx.ingest!.sweep()
    assert.deepEqual(ctx.relay.stale, [[SRC, true]])
    assert.equal((await projects(ctx)).find((p) => p.id === PID)?.stale, true)
    assert.equal(ctx.relay.projectsChanged, changedBefore + 1)
    ctx.ingest!.sweep()
    assert.equal(ctx.relay.stale.length, 1, 'told once')

    // Any request counts, also an outbox poll.
    assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`)).status, 200)
    assert.deepEqual(ctx.relay.stale, [[SRC, true], [SRC, false]])
    assert.equal((await projects(ctx)).find((p) => p.id === PID)?.stale, false)
  })
})

// ─── Mirrors at start ───────────────────────────────────────────────────────

describe('mirrors at start', () => {
  test('a mirror idle for more than 24 hours is removed; younger ones come back as stale projects; others are left alone', async () => {
    const root = makeTmpDir()
    try {
      const home = path.join(root, 'tm')
      const remote = path.join(home, 'remote')
      const now = Date.parse('2026-11-13T12:00:00Z')
      const mk = (id: string, lastSeenAt: string | null) => {
        fs.mkdirSync(path.join(remote, id, '.agent-team'), { recursive: true })
        if (lastSeenAt) fs.writeFileSync(path.join(remote, id, 'source.json'), JSON.stringify({ sourceId: id, name: `Proj ${id}`, projectId: 'p', lastSeenAt }))
      }
      mk('old-box', new Date(now - 8 * 24 * 3600_000).toISOString())
      mk('day-old-box', new Date(now - 25 * 3600_000).toISOString()) // kept for 7 days before; now removed after 24 h
      mk('fresh-box', new Date(now - 23 * 3600_000).toISOString())
      fs.mkdirSync(path.join(remote, 'Not_A_Source'), { recursive: true })
      const outside = path.join(root, 'outside')
      fs.mkdirSync(outside)
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'x')
      fs.symlinkSync(outside, path.join(remote, 'linked-box'))

      const team = new TeamService([], { pollMs: 60_000 })
      const ingest = new IngestService({ home, token: INGEST, team, now: () => now, sweepMs: 0, log: () => {} })
      const r = ingest.start()
      assert.deepEqual(r, { removed: ['day-old-box', 'old-box'], restored: ['fresh-box'] })
      assert.ok(!fs.existsSync(path.join(remote, 'old-box')))
      assert.ok(!fs.existsSync(path.join(remote, 'day-old-box')))
      assert.ok(fs.existsSync(path.join(remote, 'Not_A_Source')))
      assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'a symlinked mirror is not followed')
      // Spec 0.9.8 item 1: the hub project is named after the reported project id ("p"), not the sourceId.
      assert.deepEqual(team.list(), [{ id: 'cloud-p', name: 'Proj fresh-box', hasState: false, origin: 'cloud', sourceId: 'fresh-box', stale: true }])
      ingest.dispose()
      team.dispose()
    } finally { removeTmpDir(root) }
  })
})

// ─── setupTeam, flags, service, doctor ──────────────────────────────────────

describe('flags and setup', () => {
  test('--ingest is parsed and does not swallow the next flag; service install writes it into the service', () => {
    const a = parseArgs(['--ingest', '--no-open', '--port', '4000'])
    assert.equal(a.team.ingest, true)
    assert.equal(a.open, false)
    assert.equal(a.port, 4000)
    assert.ok(!parseArgs([]).team.ingest, 'off by default')
    const o = parseInstallArgs(['--ingest', '--port', '3002'])
    assert.ok(typeof o !== 'string' && o.ingest === true)
    const spec: ServiceSpec = {
      platform: 'linux', label: 'team-monitor', node: '/usr/bin/node', appJs: '/opt/tm/app.js', port: 3002, remote: false,
      hostAllow: [], workingDirectory: '/opt/tm', home: '/home/u', teamHome: '/home/u/.team-monitor', logFile: '/x.log', ingest: true,
    }
    assert.deepEqual(programArguments(spec).slice(-1), ['--ingest'])
    assert.ok(!programArguments({ ...spec, ingest: undefined }).includes('--ingest'))
  })

  test('setupTeam with --ingest creates a 0600 ingest token once, prints only its path, and wires the intake', () => {
    const root = makeTmpDir()
    try {
      const logs: string[] = []
      const s = setupTeam({ projects: [], remote: false, hostAllow: [], ingest: true }, { env: { TEAM_MONITOR_HOME: root }, log: (m) => logs.push(m), warn: () => {} })
      assert.ok(s.ingest)
      const file = path.join(root, 'ingest-token')
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      const token = fs.readFileSync(file, 'utf-8').trim()
      assert.match(token, /^[0-9a-f]{64}$/)
      assert.ok(!fs.existsSync(path.join(root, 'token')), 'the login token is separate')
      s.dispose()
      const logs2: string[] = []
      const s2 = setupTeam({ projects: [], remote: false, hostAllow: [], ingest: true }, { env: { TEAM_MONITOR_HOME: root }, log: (m) => logs2.push(m), warn: () => {} })
      assert.equal(fs.readFileSync(file, 'utf-8').trim(), token)
      assert.ok(!logs.some((l) => l.includes(token)), 'never printed, also not when created')
      assert.ok(logs.some((l) => l.includes(file)), 'the file path is printed when created')
      assert.ok(!logs2.some((l) => l.includes(token)), 'never shown again')
      s2.dispose()
    } finally { removeTmpDir(root) }
  })

  test('doctor: ingest token mode and a Funnel mapping that exposes only /api/ingest', () => {
    const root = makeTmpDir()
    try {
      const status = (web: Record<string, unknown>, funnel: Record<string, boolean>) => JSON.stringify({ TCP: {}, Web: web, AllowFunnel: funnel })
      const ui = { Handlers: { '/': { Proxy: 'http://127.0.0.1:3002' } } }
      const ing = { Handlers: { '/api/ingest': { Proxy: 'http://127.0.0.1:3002/api/ingest' } } }
      const run = (json: string) => () => json
      const levels = (json: string) => ingestChecks(root, 3002, 8443, 'tailscale', run(json)).map((c) => `${c.level}:${c.what.split(' ').slice(0, 4).join(' ')}`)

      // No token file, no funnel.
      let checks = ingestChecks(root, 3002, 8443, 'tailscale', run(status({ 'box.example.ts.net:8443': ui }, {})))
      assert.equal(checks[0].level, 'fail')
      assert.equal(checks[1].level, 'fail')
      assert.equal(checks[1].fix, 'tailscale funnel --bg --https=443 --set-path /api/ingest http://127.0.0.1:3002/api/ingest')

      fs.writeFileSync(path.join(root, 'ingest-token'), 'x', { mode: 0o644 })
      fs.chmodSync(path.join(root, 'ingest-token'), 0o644)
      assert.equal(ingestChecks(root, 3002, 8443, 'tailscale', run('{}'))[0].level, 'fail')
      fs.chmodSync(path.join(root, 'ingest-token'), 0o600)

      // UI on 8443 (serve), ingest on 443 (funnel): all good.
      const good = status({ 'box.example.ts.net:8443': ui, 'box.example.ts.net:443': ing }, { 'box.example.ts.net:443': true })
      assert.deepEqual(levels(good), ['ok:ingest token file is', 'ok:tailscale funnel exposes /api/ingest'])
      // Ingest mapped but Funnel off: fail.
      assert.equal(ingestChecks(root, 3002, 8443, 'tailscale', run(status({ 'box.example.ts.net:443': ing }, {})))[1].level, 'fail')
      // Funnel on the UI port: the UI would be public, fail.
      const both = { Handlers: { ...ui.Handlers, ...ing.Handlers } }
      checks = ingestChecks(root, 3002, 8443, 'tailscale', run(status({ 'box.example.ts.net:8443': both }, { 'box.example.ts.net:8443': true })))
      assert.equal(checks[1].level, 'ok')
      assert.equal(checks[2].level, 'fail')
      assert.match(checks[2].what, /public/)
      // UI on 443: the suggested Funnel port moves away from it.
      assert.match(ingestChecks(root, 3002, 443, 'tailscale', run('{}'))[1].fix!, /--https=8443 /)
      assert.deepEqual(funnelEntries('not json', 3002), [])
      // tailscale missing.
      const failing = ingestChecks(root, 3002, 8443, 'tailscale', () => { throw new Error('not found') })
      assert.equal(failing[1].level, 'fail')
    } finally { removeTmpDir(root) }
  })
})

// ─── Source key: a per-source secret, bound on first use ────────────────────

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

describe('source key', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup() })
  after(async () => { await teardown(ctx) })

  test('a request without a (well-formed) source key is refused with 403 and creates nothing', async () => {
    const noKey = { Authorization: `Bearer ${INGEST}` }
    assert.equal((await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC, project, seq: 1, messages: [startMsg()] }, noKey)).status, 403)
    assert.equal((await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: SRC, project, state: null, watcher: null }, noKey)).status, 403)
    assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, noKey)).status, 403)
    assert.equal((await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: SRC, project, state: null, watcher: null }, auth(INGEST, 'not-a-key'))).status, 403)
    assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', SRC)))
    assert.equal(ctx.relay.applied.length, 0)
  })

  test('the first accepted key is bound: another key cannot read, write, rename or blackhole the source', async () => {
    assert.equal((await putState(ctx)).status, 200)
    assert.equal((await events(ctx, 10)).status, 200)
    const answer = await request(ctx.port, {
      method: 'POST', path: '/api/team/answer', headers: { ...JSON_H, 'X-Team-Monitor': '1', Origin: `http://127.0.0.1:${ctx.port}` },
      body: JSON.stringify({ project: PID, id: 'D1', answer: 'b' }),
    })
    assert.equal(answer.status, 200, answer.body)
    const applied = ctx.relay.applied.length
    const stateFile = path.join(ctx.home, 'remote', SRC, '.agent-team', 'state.json')
    const stateBefore = fs.readFileSync(stateFile, 'utf-8')

    const evil = auth(INGEST, OTHER_KEY)
    const fake = { id: 'evil', name: 'Palsu' }
    const blackhole = await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC, project: fake, seq: Number.MAX_SAFE_INTEGER, messages: [eventMsg(S1, 'tool_call_start')] }, evil)
    assert.equal(blackhole.status, 403)
    const overwrite = await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: SRC, project: fake, state: sampleState({ meta: { title: 'Palsu' } }), watcher: null }, evil)
    assert.equal(overwrite.status, 403)
    const read = await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, evil)
    assert.equal(read.status, 403)
    assert.ok(!read.body.includes('answers/'), 'the outbox is not shown')

    assert.equal(ctx.relay.applied.length, applied, 'nothing applied')
    assert.equal(fs.readFileSync(stateFile, 'utf-8'), stateBefore, 'state not overwritten')
    assert.equal((await projects(ctx)).find((p) => p.id === PID)?.name, 'My Repo', 'not renamed')
    // The seq was not used up: the real source's next post is applied, not acknowledged as a duplicate.
    const next = await events(ctx, 11, [eventMsg(S1, 'tool_call_end')])
    assert.deepEqual(JSON.parse(next.body), { ok: true, seq: 11, applied: 1, ignored: 0 })
    const outbox = await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`)
    assert.equal(outbox.status, 200)
    assert.ok(outbox.body.includes('answers/D1.json'), 'the real source still reads its answers')

    // Only the key's hash is stored, with the mirror.
    const rec = JSON.parse(fs.readFileSync(path.join(ctx.home, 'remote', SRC, 'source.json'), 'utf-8'))
    assert.equal(rec.keyHash, sha256(KEY))
    assert.ok(!JSON.stringify(rec).includes(KEY))
  })

  test('the binding survives a hub restart; a mirror from before source keys is bound by its next keyed request', async () => {
    const legacy = 'legacy-box'
    const legacyDir = path.join(ctx.home, 'remote', legacy)
    fs.mkdirSync(path.join(legacyDir, '.agent-team'), { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'source.json'), JSON.stringify({ sourceId: legacy, name: 'Lama', projectId: 'p', lastSeenAt: new Date(ctx.clock.t).toISOString() }))

    const team2 = new TeamService([], { pollMs: 60_000 })
    const ingest2 = new IngestService({ home: ctx.home, token: INGEST, team: team2, now: () => ctx.clock.t, sweepMs: 0, log: () => {} })
    ingest2.start()
    ingest2.attachRelay(new FakeRelay())
    const srv = await listen(createRequestHandler({ team: team2, remote: null, ingest: ingest2, fallback: (_q, r) => { r.writeHead(404); r.end() } }))
    try {
      const post = (sourceId: string, key: string) => request(srv.port, {
        method: 'POST', path: '/api/ingest/v1/events', headers: { ...JSON_H, ...auth(INGEST, key) },
        body: JSON.stringify({ sourceId, project, seq: 1, messages: [startMsg()] }),
      })
      assert.equal((await post(SRC, OTHER_KEY)).status, 403, 'still bound after the restart')
      assert.equal((await post(SRC, KEY)).status, 200)
      assert.equal((await post(legacy, OTHER_KEY)).status, 200, 'an unbound legacy mirror takes the first key')
      assert.equal((await post(legacy, KEY)).status, 403)
      assert.equal(JSON.parse(fs.readFileSync(path.join(legacyDir, 'source.json'), 'utf-8')).keyHash, sha256(OTHER_KEY))
    } finally {
      await srv.close()
      ingest2.dispose()
      team2.dispose()
    }
  })
})

// ─── Routing on the raw path ────────────────────────────────────────────────

describe('ingest routing on the raw path', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup() })
  after(async () => { await teardown(ctx) })

  test('dot segments, encoded dots/slashes/backslashes and any path but the three routes: 400, never the UI or team routes', async () => {
    const bad = [
      '/api/ingest/%2e%2e/team/projects', '/api/ingest/%2E%2E/%2E%2E/login', '/api/ingest/..%2fteam/projects', '/api/ingest/v1/../../team/projects',
      '/api/ingest/./v1/events', '/api/ingest/v1/%65vents', '/api/ingest/v1/events/', '/api/ingest/v1/events%2f', '/api/ingest/v1//events',
      '/api/ingest/v1\\..\\..\\team\\projects', '/api/ingest%2fv1%2fevents', '/API/ingest/v1/events', '/api/ingest', '/api/ingest/',
      '/api/ingest/v1/outbox/..%5c..%5cteam',
    ]
    for (const p of bad) {
      const r = await send(ctx, 'GET', p)
      assert.equal(r.status, 400, p)
      assert.ok(r.body !== 'fallback' && !r.body.includes('"projects"'), p)
      // Without the token too: refused before any handler (also the intake's token check) sees it.
      assert.equal((await send(ctx, 'GET', p, undefined, {})).status, 400, `${p} without token`)
    }
    // The three routes still work, also with a query.
    assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}&wait=0`)).status, 200)
    // A path that only normalises into /api/ingest is neither an ingest request nor a UI one.
    const sneaky = await send(ctx, 'POST', '/x/../api/ingest/v1/events', { sourceId: SRC, project, seq: 1, messages: [] })
    assert.equal(sneaky.status, 400)
    assert.equal(ctx.relay.applied.length, 0)
  })

  test('QA gap: sibling names and dot segments anywhere are refused with 400 before any other handler (plain and remote hub)', async () => {
    const remoteCtx = await setup({ remote: true })
    try {
      const bad = [
        '/api/ingestX/../team/projects', '/api/ingest-x/../team/projects', '/api/ingest:/../team/projects', '/api/ingest@/../team/projects',
        '/api/ingest~/../team/projects', '/api/ingestX/../../login', '/api/ingest-x', '/api/ingest:', '/API/INGESTX', '/api/Ingest/v1/events',
        '/api/%69ngest/v1/events', '/api/ingest/v1/events#x', '/x/../api/team/projects', '/./api/team/projects', '/api/team/./projects',
        '/api/team/%2e%2e/team/projects', '/api/team%2fprojects', '/static/..%5cx', '/x\\y', '/x/%2E/y', '/x/%252e%252e/api/team/projects',
        '/x/..', '/..', '/.', '/events/..', '/login/../api/team/projects', 'http://evil.example/api/ingestX/../team/projects',
      ]
      for (const c of [ctx, remoteCtx]) {
        for (const p of bad) {
          const variants: Array<Record<string, string>> = [{}, auth(), { Host: 'public.example.ts.net' }, { Host: 'box.example.ts.net', 'X-Forwarded-For': '100.64.0.9' }]
          for (const headers of variants) {
            const r = await send(c, 'GET', p, undefined, headers)
            assert.equal(r.status, 400, `${p} ${JSON.stringify(headers)}`)
            assert.ok(r.body !== 'fallback' && !r.body.includes('"projects"') && !r.body.includes('<form'), p)
          }
          assert.equal((await send(c, 'POST', p, {}, {})).status, 400, `POST ${p}`)
        }
      }
      assert.equal(ctx.relay.applied.length, 0)
      assert.deepEqual(ctx.logs.filter((l) => l.includes('[ingest]')), [], 'nothing reached the intake')
    } finally { await teardown(remoteCtx) }
  })

  test('with --ingest, normal UI, static files, /events, login and /api/team requests work as before', async () => {
    const remoteCtx = await setup({ remote: true })
    try {
      const writeHeaders = (c: Ctx) => ({ ...JSON_H, 'X-Team-Monitor': '1', Origin: `http://127.0.0.1:${c.port}` })
      for (const p of ['/', '/index.html', '/favicon.ico', '/_next/static/chunks/app/page-0a1b2c.js', '/_next/static/css/a.b.c.css',
        '/fonts/x.woff2', '/events', '/events?x=1', '/?next=../x&y=%2e%2e', '/apix', '/api/ingesx', '/.well-known/x', '/a..b/c.d']) {
        const r = await request(ctx.port, { path: p })
        assert.equal(r.status, 200, p)
        assert.equal(r.body, 'fallback', p)
      }
      const list = await request(ctx.port, { path: '/api/team/projects' })
      assert.equal(list.status, 200)
      assert.ok(Array.isArray(JSON.parse(list.body).projects))
      assert.equal((await request(ctx.port, { path: '/api/team/state?project=lokal' })).status, 200)
      assert.equal((await request(ctx.port, { path: '/api/team/offboarded' })).status, 200)
      const msg = await request(ctx.port, { method: 'POST', path: '/api/team/message', headers: writeHeaders(ctx), body: JSON.stringify({ project: 'lokal', text: 'halo' }) })
      assert.equal(msg.status, 200, msg.body)
      // Remote mode with --ingest: the login page, login and the logged-in UI.
      const page = await request(remoteCtx.port, { path: '/login', headers: { Host: 'box.example.ts.net', 'X-Forwarded-For': '100.64.0.9' } })
      assert.equal(page.status, 200)
      assert.match(page.body, /<form/)
      const login = await request(remoteCtx.port, {
        method: 'POST', path: '/login', body: `token=${LOGIN}`,
        headers: { Host: 'box.example.ts.net', 'X-Forwarded-For': '100.64.0.9', 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://box.example.ts.net' },
      })
      assert.equal(login.status, 303, login.body)
      const cookie = String(login.headers['set-cookie']).split(';')[0]
      for (const p of ['/', '/events', '/api/team/projects']) {
        const r = await request(remoteCtx.port, { path: p, headers: { Host: 'box.example.ts.net', 'X-Forwarded-For': '100.64.0.9', Cookie: cookie } })
        assert.equal(r.status, 200, p)
      }
      assert.equal((await request(remoteCtx.port, { path: '/api/team/projects', headers: { Host: 'box.example.ts.net', 'X-Forwarded-For': '100.64.0.9' } })).status, 401)
    } finally { await teardown(remoteCtx) }
  })
})

describe('raw-path refusal only with --ingest', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup({ ingest: false }) })
  after(async () => { await teardown(ctx) })

  test('without --ingest, paths with dot segments are handled as before (normalised), /api/ingest still 404', async () => {
    assert.equal((await request(ctx.port, { path: '/x/../api/team/projects' })).status, 200)
    assert.equal((await request(ctx.port, { path: '/static/./a.js' })).body, 'fallback')
    assert.equal((await request(ctx.port, { path: '/api/ingestX/../team/projects' })).status, 200, 'unchanged without --ingest (no intake to protect)')
    assert.equal((await request(ctx.port, { path: '/api/ingest/v1/events' })).status, 404)
  })
})

// ─── Capacity: evict instead of refuse ──────────────────────────────────────

describe('capacity', () => {
  test('at the source cap the longest-stale source is evicted with its mirror; with every source live: 503 with Retry-After', async () => {
    const ctx = await setup({ maxSources: 3 })
    try {
      for (const id of ['box-a', 'box-b', 'box-c']) {
        assert.equal((await putState(ctx, null, null, id)).status, 200)
        ctx.clock.t += 1000
      }
      const full = await putState(ctx, null, null, 'box-d')
      assert.equal(full.status, 503)
      assert.match(JSON.parse(full.body).error, /capacity/)
      assert.ok(Number(full.headers['retry-after']) > 0)
      assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', 'box-d')))

      ctx.clock.t += 61_000
      ctx.ingest!.sweep() // all three stale
      assert.equal((await putState(ctx, null, null, 'box-a')).status, 200, 'box-a is live again')
      // box-d is not bound yet: it may evict a source with a bound key only once that has been stale for 10 minutes.
      const early = await putState(ctx, null, null, 'box-d')
      assert.equal(early.status, 503, early.body)
      assert.match(JSON.parse(early.body).error, /none can be removed for a new one now \(a live source never is, a source with a bound key only after 10 minutes stale\)/)
      assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', 'box-d')))
      ctx.clock.t += 10 * 60_000
      ctx.ingest!.sweep()
      assert.equal((await putState(ctx, null, null, 'box-a')).status, 200, 'box-a is live again')
      const r = await putState(ctx, null, null, 'box-d')
      assert.equal(r.status, 200, r.body)
      assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', 'box-b')), 'the longest-stale source is removed')
      assert.ok(fs.existsSync(path.join(ctx.home, 'remote', 'box-a')))
      assert.ok(fs.existsSync(path.join(ctx.home, 'remote', 'box-c')))
      assert.deepEqual(ctx.relay.forgotten, ['box-b'])
      // One hub project for the repo (spec 0.9.8 item 1), still shown from box-a: it is live, so a new source does not
      // take it over (item 5a, F4).
      assert.deepEqual((await projects(ctx)).filter((p) => p.origin === 'cloud').map((p) => [p.id, p.sourceId]), [[PID, 'box-a']])
    } finally { await teardown(ctx) }
  })

  test('a source silent for more than 24 hours is removed with its mirror while the hub runs', async () => {
    const ctx = await setup()
    try {
      assert.equal((await putState(ctx)).status, 200)
      ctx.clock.t += 23 * 3600_000
      ctx.ingest!.sweep()
      assert.ok(fs.existsSync(path.join(ctx.home, 'remote', SRC)))
      ctx.clock.t += 2 * 3600_000
      ctx.ingest!.sweep()
      assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', SRC)))
      assert.ok(!(await projects(ctx)).some((p) => p.id === PID))
      assert.deepEqual(ctx.relay.forgotten, [SRC])
    } finally { await teardown(ctx) }
  })

  test('when every cloud session on the graph is live and the cap is reached: 503 (not 200), and the seq is not used up', async () => {
    const ctx = await setup()
    try {
      ctx.relay.room = false
      const r = await events(ctx, 7)
      assert.equal(r.status, 503)
      assert.equal(JSON.parse(r.body).error, 'hub at capacity: the cloud session limit is reached and not enough ended or stale sessions can be evicted; retry later')
      assert.ok(Number(r.headers['retry-after']) > 0)
      assert.equal(ctx.relay.applied.length, 0)
      // The refused request of a new source registered nothing: no project, no mirror, no key binding.
      assert.ok(!(await projects(ctx)).some((p) => p.id === PID))
      assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', SRC)))
      assert.deepEqual(ctx.ingest!.sourceStates(), [])
      ctx.relay.room = true
      const other = await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC, project, seq: 7, messages: [startMsg(), eventMsg()] }, auth(INGEST, OTHER_KEY))
      assert.deepEqual(JSON.parse(other.body), { ok: true, seq: 7, applied: 2, ignored: 0 }, 'the refused key was not bound')
    } finally { await teardown(ctx) }
  })

  test('a refused new source at the source cap leaves nothing behind', async () => {
    const ctx = await setup({ maxSources: 1 })
    try {
      assert.equal((await putState(ctx, null, null, 'box-a')).status, 200)
      const r = await events(ctx, 1, [startMsg(), eventMsg()], 'box-b')
      assert.equal(r.status, 503)
      assert.equal(r.headers['retry-after'], '30')
      assert.deepEqual(ctx.ingest!.sourceStates().map((s) => s.sourceId), ['box-a'])
      assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', 'box-b')))
      assert.deepEqual((await projects(ctx)).filter((p) => p.origin === 'cloud').map((p) => [p.id, p.sourceId]), [[PID, 'box-a']])
      assert.equal(ctx.relay.applied.length, 0)
    } finally { await teardown(ctx) }
  })
})

// ─── Key bindings survive eviction (NEW-2) ──────────────────────────────────

describe('key bindings after eviction', () => {
  const tombFile = (ctx: Ctx) => path.join(ctx.home, 'ingest-tombstones.json')
  const tombs = (ctx: Ctx) => (JSON.parse(fs.readFileSync(tombFile(ctx), 'utf-8')) as { tombstones: Array<{ sourceId: string; keyHash: string; evictedAt: string }> }).tombstones
  const VICTIM = 'box-victim'

  test('QA repro: a token holder fills the cap so a stale victim is evicted, then claims its sourceId: 403; the real key works again', async () => {
    const ctx = await setup({ maxSources: 2 })
    try {
      assert.equal((await putState(ctx, sampleState(), null, VICTIM)).status, 200) // bound to KEY
      ctx.clock.t += 1000
      assert.equal((await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: 'evil-1', project, state: null, watcher: null }, auth(INGEST, OTHER_KEY))).status, 200)
      ctx.clock.t += 61_000
      ctx.ingest!.sweep() // both stale (61 s)

      // A new, unbound sourceId cannot evict the bound victim yet: 503, and nothing of it is registered.
      const evil = (sourceId: string) => send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId, project, state: null, watcher: null }, auth(INGEST, OTHER_KEY))
      assert.equal((await evil('evil-2')).status, 503)
      assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', 'evil-2')))
      assert.ok(!fs.existsSync(tombFile(ctx)), 'nothing evicted')
      // After 10 minutes stale it can be (the victim is the longest stale).
      ctx.clock.t += 10 * 60_000
      assert.equal((await evil('evil-2')).status, 200)
      assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', VICTIM)), 'victim evicted with its mirror')
      assert.equal(fs.statSync(tombFile(ctx)).mode & 0o777, 0o600)
      assert.deepEqual(tombs(ctx).map((t) => [t.sourceId, t.keyHash]), [[VICTIM, sha256(KEY)]])
      assert.ok(!fs.readFileSync(tombFile(ctx), 'utf-8').includes(KEY), 'only the hash is kept')
      assert.deepEqual(fs.readdirSync(ctx.home).filter((n) => n.endsWith('.tmp')), [], 'atomic write left no temp file')

      // The takeover: state, events and outbox for the victim's sourceId with another key are refused.
      assert.equal((await evil(VICTIM)).status, 403)
      assert.equal((await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: VICTIM, project, seq: 1, messages: [startMsg()] }, auth(INGEST, OTHER_KEY))).status, 403)
      assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${VICTIM}`, undefined, auth(INGEST, OTHER_KEY))).status, 403)
      assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', VICTIM)))
      assert.ok(!(await projects(ctx)).some((p) => p.id === `cloud-${VICTIM}`))

      // Also after a hub restart.
      const team2 = new TeamService([], { pollMs: 60_000 })
      const ingest2 = new IngestService({ home: ctx.home, token: INGEST, team: team2, now: () => ctx.clock.t, sweepMs: 0, log: () => {}, maxSources: 2 })
      ingest2.start()
      ingest2.attachRelay(new FakeRelay())
      const srv = await listen(createRequestHandler({ team: team2, remote: null, ingest: ingest2, fallback: (_q, r) => { r.writeHead(404); r.end() } }))
      try {
        const put = (key: string) => request(srv.port, {
          method: 'PUT', path: '/api/ingest/v1/state', headers: { ...JSON_H, ...auth(INGEST, key) },
          body: JSON.stringify({ sourceId: VICTIM, project, state: null, watcher: null }),
        })
        assert.equal((await put(OTHER_KEY)).status, 403, 'still refused after a restart')
        // The real key: its source is created again. A returning bound sourceId may evict any stale source.
        ctx.clock.t += 61_000
        ingest2.sweep()
        const back = await put(KEY)
        assert.equal(back.status, 200, back.body)
        assert.ok(fs.existsSync(path.join(ctx.home, 'remote', VICTIM)))
        assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.home, 'remote', VICTIM, 'source.json'), 'utf-8')).keyHash, sha256(KEY))
        // Its tombstone is gone (source.json holds the binding); the evicted one's binding is kept.
        assert.deepEqual(tombs(ctx).map((t) => t.sourceId), ['evil-1'])
        assert.equal((await put(OTHER_KEY)).status, 403)
      } finally {
        await srv.close()
        ingest2.dispose()
        team2.dispose()
      }
    } finally { await teardown(ctx) }
  })

  test('a source removed after 24 hours silent keeps its binding; tombstones expire after 30 days', async () => {
    const ctx = await setup()
    try {
      assert.equal((await putState(ctx)).status, 200)
      ctx.clock.t += 25 * 3600_000
      ctx.ingest!.sweep()
      assert.ok(!fs.existsSync(path.join(ctx.home, 'remote', SRC)))
      assert.equal((await putState(ctx, null, null, SRC)).status, 200, 'the real key is accepted again')
      ctx.clock.t += 25 * 3600_000
      ctx.ingest!.sweep()
      const other = () => send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: SRC, project, state: null, watcher: null }, auth(INGEST, OTHER_KEY))
      ctx.clock.t += 29 * 24 * 3600_000
      assert.equal((await other()).status, 403, 'still bound 29 days after the eviction')
      ctx.clock.t += 24 * 3600_000
      assert.equal((await other()).status, 200, 'expired 30 days after the eviction: unbound again')
    } finally { await teardown(ctx) }
  })

  test('tombstone store: capped (oldest dropped), expiry, reload, damaged file ignored', () => {
    const root = makeTmpDir()
    try {
      const file = path.join(root, 'ingest-tombstones.json')
      const clock = { t: 1_000_000 }
      const logs: string[] = []
      const store = new TombstoneStore({ file, now: () => clock.t, log: (m) => logs.push(m), max: 3, ttlMs: 1000 })
      store.load()
      for (const id of ['s-1', 's-2', 's-3', 's-4', 's-5']) { store.add(id, sha256(id)); clock.t += 10 }
      assert.ok(store.flush())
      assert.equal(store.get('s-1'), null, 'oldest dropped at the cap')
      assert.equal(store.get('s-2'), null)
      assert.equal(store.get('s-5'), sha256('s-5'))
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      const again = new TombstoneStore({ file, now: () => clock.t, log: () => {}, max: 3, ttlMs: 1000 })
      again.load()
      assert.deepEqual(['s-3', 's-4', 's-5'].map((id) => again.get(id)), ['s-3', 's-4', 's-5'].map(sha256))
      clock.t += 1000
      assert.equal(again.get('s-5'), null, 'expired')
      fs.writeFileSync(file, '{"tombstones": "nope"}')
      store.load()
      assert.equal(store.size(), 0)
      assert.match(logs.join('\n'), /ignored/)
      fs.writeFileSync(file, JSON.stringify({ tombstones: [{ sourceId: '../x', keyHash: sha256('a'), evictedAt: new Date(clock.t).toISOString() }, { sourceId: 'ok', keyHash: 'zz', evictedAt: new Date(clock.t).toISOString() }] }))
      store.load()
      assert.equal(store.size(), 0, 'bad entries are left out')
    } finally { removeTmpDir(root) }
  })

  test('mirrors removed at start keep their binding too', async () => {
    const root = makeTmpDir()
    try {
      const home = path.join(root, 'tm')
      const now = Date.parse('2026-11-13T12:00:00Z')
      fs.mkdirSync(path.join(home, 'remote', 'old-box', '.agent-team'), { recursive: true })
      fs.writeFileSync(path.join(home, 'remote', 'old-box', 'source.json'), JSON.stringify({ sourceId: 'old-box', name: 'X', projectId: 'p', lastSeenAt: new Date(now - 25 * 3600_000).toISOString(), keyHash: sha256(KEY) }))
      const team = new TeamService([], { pollMs: 60_000 })
      const ingest = new IngestService({ home, token: INGEST, team, now: () => now, sweepMs: 0, log: () => {} })
      assert.deepEqual(ingest.start().removed, ['old-box'])
      assert.equal(ingest.tombstones.get('old-box'), sha256(KEY))
      ingest.dispose()
      team.dispose()
    } finally { removeTmpDir(root) }
  })
})

// ─── Refusal log lines are limited (NEW-1) ──────────────────────────────────

describe('refusal log limit', () => {
  test('a client repeating any refused request writes at most one line per kind and client/source per minute, with the count on the next', async () => {
    const ctx = await setup({ maxSources: 1, maxOutboxWaiters: 0 })
    try {
      assert.equal((await putState(ctx)).status, 200) // SRC bound to KEY
      const lines = (re: RegExp) => ctx.logs.filter((l) => re.test(l))
      const start = ctx.logs.length
      const fwd = (i: number) => ({ 'X-Forwarded-For': `198.51.100.${i}` })

      // The QA repro: wrong source key in a loop.
      for (let i = 0; i < 200; i++) {
        assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, auth(INGEST, OTHER_KEY))).status, 403)
      }
      assert.equal(lines(/source key mismatch/).length, 1)
      // Wrong token from one client (401, then 429).
      for (let i = 0; i < 100; i++) await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, { ...fwd(1), ...auth('x') })
      assert.equal(lines(/ingest token/).length, 1)
      // Wrong token from many clients: bounded per kind (10 per minute).
      for (let i = 2; i < 102; i++) await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, { ...fwd(i), ...auth('x') })
      assert.equal(lines(/ingest token/).length, 10)
      // Capacity: sources (cap 1), sessions, outbox polls.
      for (let i = 0; i < 50; i++) assert.equal((await putState(ctx, null, null, 'other-box')).status, 503)
      assert.equal(lines(/source cap/).length, 1)
      ctx.relay.room = false
      for (let i = 0; i < 50; i++) assert.equal((await events(ctx, 5)).status, 503)
      assert.equal(lines(/cloud session cap/).length, 1)
      ctx.relay.room = true
      for (let i = 0; i < 50; i++) assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}&wait=5`)).status, 503)
      assert.equal(lines(/outbox long polls/).length, 1)
      // Bad paths, bad bodies, other refusals: no line at all.
      for (let i = 0; i < 50; i++) {
        await send(ctx, 'GET', '/api/ingest/v1/nope')
        await send(ctx, 'POST', '/api/ingest/v1/events', '{bad json')
        await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: '../x', project, state: null, watcher: null })
      }
      const written = ctx.logs.length - start
      assert.ok(written <= 14, `${written} lines for ${200 + 200 + 150 + 150} refused requests`)

      // After the minute: the next line carries the count of what was held back.
      ctx.clock.t += 60_000
      assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, auth(INGEST, OTHER_KEY))).status, 403)
      assert.match(ctx.logs[ctx.logs.length - 1], /source key mismatch for cloud-box-1 .*\(199 more like it suppressed\)$/)
      for (const l of ctx.logs) assert.ok(!l.includes(INGEST) && !l.includes(OTHER_KEY) && !l.includes(KEY), 'no secret in the log')
    } finally { await teardown(ctx) }
  })
})

// ─── Limits: JSON depth, event size, outbox polls; hub epoch ────────────────

describe('limits and epoch', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup({ maxOutboxWaiters: 1 }) })
  after(async () => { await teardown(ctx) })

  const deep = (n: number) => '{"a":'.repeat(n) + '1' + '}'.repeat(n)
  // body (1) > messages (2) > message (3) > event (4) > payload (5) > n more levels
  const deepBody = (n: number, seq: number) => `{"sourceId":"${SRC}","project":{"id":"my-repo","name":"My Repo"},"seq":${seq},"messages":[` +
    `{"type":"agent-event","event":{"sessionId":"${S1}","type":"tool_call_start","time":1,"payload":{"deep":${deep(n)}}}}]}`

  test('JSON nested deeper than 32 levels is refused with 400 before anything is applied', async () => {
    const before = ctx.relay.applied.length
    for (const n of [20000, 40, MAX_JSON_DEPTH - 4]) {
      const r = await send(ctx, 'POST', '/api/ingest/v1/events', deepBody(n, 1))
      assert.equal(r.status, 400, `depth ${n}`)
      assert.match(JSON.parse(r.body).error, /nested deeper than 32/)
    }
    const st = await send(ctx, 'PUT', '/api/ingest/v1/state', `{"sourceId":"${SRC}","project":{"id":"p","name":"P"},"state":{"x":${deep(40)}},"watcher":null}`)
    assert.equal(st.status, 400)
    assert.equal(ctx.relay.applied.length, before)
    assert.equal((await send(ctx, 'POST', '/api/ingest/v1/events', deepBody(MAX_JSON_DEPTH - 5, 2))).status, 200, 'exactly 32 levels is accepted')
    assert.equal(jsonTooDeep('{"a":"{{{{[[[["}', 1), false, 'brackets inside strings do not count')
    assert.equal(jsonTooDeep('{"a":"\\"{{"}', 1), false, 'escaped quotes')
    assert.equal(jsonTooDeep('[[1]]', 1), true)
  })

  test('an event larger than 64 KB is refused with a clear 400 (the whole batch, nothing applied)', async () => {
    const before = ctx.relay.applied.length
    const big = { time: 1, type: 'tool_call_start', payload: { pad: 'x'.repeat(MAX_EVENT_BYTES) }, sessionId: S1 }
    const small = { time: 1, type: 'tool_call_end', payload: {}, sessionId: S1 }
    const r = await events(ctx, 50, [{ type: 'agent-event-batch', events: [small, big] }])
    assert.equal(r.status, 400)
    assert.match(JSON.parse(r.body).error, /events\[1\] is larger than 65536 bytes/)
    assert.equal(ctx.relay.applied.length, before)
  })

  test('above the long-poll cap an outbox poll gets 503 with Retry-After at once, not an empty 200', async () => {
    assert.equal((await putState(ctx)).status, 200)
    const cur = JSON.parse((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`)).body).cursor as string
    const first = send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}&after=${cur}&wait=2`)
    await new Promise((r) => setTimeout(r, 150))
    const t0 = Date.now()
    const second = await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}&after=${cur}&wait=2`)
    assert.equal(second.status, 503)
    assert.equal(second.headers['retry-after'], '5')
    assert.ok(Date.now() - t0 < 1000)
    assert.equal((await first).status, 200)
    // A poll that does not wait is still answered at once.
    assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}&wait=0`)).status, 200)
  })

  test('every authenticated ingest response carries the hub epoch; an events post naming another epoch gets 409 and nothing applied', async () => {
    const r = await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`)
    const epoch = r.headers[EPOCH_HEADER]
    assert.match(String(epoch), /^[0-9a-f]{8}$/)
    assert.equal(epoch, ctx.ingest!.epoch)
    assert.equal((await send(ctx, 'GET', '/api/ingest/v1/events')).headers[EPOCH_HEADER], epoch, 'also on errors (405)')
    assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`, undefined, {})).headers[EPOCH_HEADER], undefined, 'not without the token')
    const before = ctx.relay.applied.length
    const old = await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC, project, seq: 100, messages: [eventMsg()] }, { ...auth(), [EPOCH_HEADER]: '00000000' })
    assert.equal(old.status, 409)
    assert.match(JSON.parse(old.body).error, /restarted/)
    assert.equal(ctx.relay.applied.length, before)
    const ok = await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC, project, seq: 100, messages: [eventMsg()] }, { ...auth(), [EPOCH_HEADER]: String(epoch) })
    assert.equal(ok.status, 200, ok.body)
    assert.equal(ctx.relay.applied.length, before + 1)
  })
})

// ─── 0.9.8: one hub project per repo, retiring stale sources, finishing silent sources ─────────────────────

describe('0.9.8 one hub project per repo', () => {
  const SRC2 = 'cloud-box-2'
  const SRC3 = 'cloud-box-3'
  const KEYS: Record<string, string> = { [SRC]: KEY, [SRC2]: OTHER_KEY, [SRC3]: '7a'.repeat(32) }
  const S2 = '0b1c2d3e-0000-4000-8000-000000000002'
  const S3 = '0b1c2d3e-0000-4000-8000-000000000003'
  const post = (ctx: Ctx, sourceId: string, seq: number, sid: string, proj = project) =>
    send(ctx, 'POST', '/api/ingest/v1/events', { sourceId, project: proj, seq, messages: [startMsg(sid), eventMsg(sid)] }, auth(INGEST, KEYS[sourceId]))
  const cloudList = async (ctx: Ctx) => (await projects(ctx)).filter((p) => p.origin === 'cloud')
    .map((p) => ({ id: p.id, name: p.name, sourceId: p.sourceId, stale: p.stale }))

  test('item 1 / AC2: two live sources of one repo share one hub project, each keeps its key and mirror; nobody is retired', async () => {
    const ctx = await setup()
    try {
      assert.equal((await post(ctx, SRC, 1, S1)).status, 200)
      const r = await post(ctx, SRC2, 1, S2)
      assert.equal(r.status, 200, r.body) // no 403: each sourceId is bound to its own key
      // One project for the repo, still shown from the first source (live: a new one does not take it over, item 5a);
      // the list shape is unchanged.
      assert.deepEqual(await cloudList(ctx), [{ id: PID, name: 'My Repo', sourceId: SRC, stale: false }])
      assert.deepEqual([...new Set(ctx.relay.applied.map((a) => `${a.sourceId} ${a.projectId}`))], [`${SRC} ${PID}`, `${SRC2} ${PID}`])
      for (const s of [SRC, SRC2]) assert.ok(fs.existsSync(path.join(ctx.home, 'remote', s, '.agent-team')), `mirror of ${s}`)
      assert.deepEqual(ctx.ingest!.sourceStates().map((s) => [s.sourceId, s.projectId]), [[SRC, PID], [SRC2, PID]])
      // The keys stay per source: SRC2's key cannot write as SRC.
      const wrong = await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC, project, seq: 2, messages: [eventMsg()] }, auth(INGEST, OTHER_KEY))
      assert.equal(wrong.status, 403)
      assert.deepEqual(ctx.relay.retired, [], 'live siblings are never retired')

      // Another repo is another hub project.
      const other = { id: 'other-repo', name: 'Other' }
      assert.equal((await post(ctx, SRC3, 1, S3, other)).status, 200)
      assert.deepEqual((await cloudList(ctx)).map((p) => p.id).sort(), [PID, 'cloud-other-repo'])

      // The project is stale only when every source of it is; the shown source then stays the one seen last.
      ctx.clock.t += 30_000
      assert.equal((await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${SRC}`)).status, 200) // SRC seen later
      ctx.clock.t += 31_000
      ctx.ingest!.sweep() // SRC2 and SRC3 stale, SRC live
      assert.deepEqual((await cloudList(ctx)).find((p) => p.id === PID), { id: PID, name: 'My Repo', sourceId: SRC, stale: false })
      ctx.clock.t += 31_000
      ctx.ingest!.sweep()
      assert.deepEqual((await cloudList(ctx)).find((p) => p.id === PID), { id: PID, name: 'My Repo', sourceId: SRC, stale: true })
      // A request makes it live again from that source.
      assert.equal((await post(ctx, SRC2, 2, S2)).status, 200)
      assert.deepEqual((await cloudList(ctx)).find((p) => p.id === PID), { id: PID, name: 'My Repo', sourceId: SRC2, stale: false })
      assert.deepEqual(ctx.relay.retired, [], 'a source that comes back is not new: nothing retired')
    } finally { await teardown(ctx) }
  })

  test('item 1: answers written to the hub project reach the outbox of the source it shows', async () => {
    const ctx = await setup()
    try {
      assert.equal((await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: SRC, project, state: sampleState(), watcher: null }, auth(INGEST, KEY))).status, 200)
      assert.equal((await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: SRC2, project, state: sampleState(), watcher: null }, auth(INGEST, OTHER_KEY))).status, 200)
      const w = ctx.team.watcher(PID)!
      assert.ok(w, 'one watcher for the hub project')
      // SRC is live with a state: SRC2 does not take the project over (item 5a, F4). SRC goes stale, SRC2 is live
      // with a state: the project now shows SRC2.
      assert.equal(ctx.team.cloudSourceOf(PID), SRC)
      ctx.clock.t += 61_000
      ctx.ingest!.sweep()
      assert.equal((await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: SRC2, project, state: sampleState(), watcher: null }, auth(INGEST, OTHER_KEY))).status, 200)
      ctx.ingest!.sweep()
      assert.equal(ctx.team.cloudSourceOf(PID), SRC2)
      const w2 = ctx.team.watcher(PID)!
      assert.notEqual(w2, w, 'a new watcher on the other mirror')
      assert.equal(path.resolve(w2.answersDir).startsWith(path.resolve(path.join(ctx.home, 'remote', SRC2)) + path.sep), true, 'answers go to the mirror of SRC2')
      // An answer from the hub UI is what SRC2's outbox returns, not SRC's.
      const a = await request(ctx.port, {
        method: 'POST', path: '/api/team/answer', body: JSON.stringify({ project: PID, id: 'D1', answer: 'b' }),
        headers: { ...JSON_H, 'X-Team-Monitor': '1', Origin: `http://127.0.0.1:${ctx.port}` },
      })
      assert.equal(a.status, 200, a.body)
      const out = async (s: string, key: string) => (await send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${s}`, undefined, auth(INGEST, key))).body
      assert.equal((await out(SRC, KEY)).includes('answers/D1.json'), false)
      assert.equal((await out(SRC2, OTHER_KEY)).includes('answers/D1.json'), true)
    } finally { await teardown(ctx) }
  })

  test('item 1: a source that reports another project id moves to that hub project; the old one goes with its last source', async () => {
    const ctx = await setup()
    try {
      assert.equal((await post(ctx, SRC, 1, S1)).status, 200)
      const moved = { id: 'renamed-repo', name: 'Renamed' }
      assert.equal((await post(ctx, SRC, 2, S1, moved)).status, 200)
      assert.deepEqual(ctx.relay.moved, [[SRC, 'cloud-renamed-repo']])
      assert.deepEqual(await cloudList(ctx), [{ id: 'cloud-renamed-repo', name: 'Renamed', sourceId: SRC, stale: false }])
    } finally { await teardown(ctx) }
  })

  test('item 1: a project id that a local project already has is refused with 409 and registers nothing', async () => {
    const root = makeTmpDir()
    const team = new TeamService(buildRegistry([], [makeProject(root, 'cloud-x')]), { pollMs: 60_000 })
    const relay = new FakeRelay()
    const ingest = new IngestService({ home: path.join(root, 'tm'), token: INGEST, team, sweepMs: 0, log: () => {} })
    ingest.start()
    ingest.attachRelay(relay)
    const srv = await listen(createRequestHandler({ team, remote: null, ingest, fallback: (_q, r) => { r.writeHead(404); r.end() } }))
    try {
      assert.ok(team.watcher('cloud-x') && !team.isCloudProject('cloud-x'), 'a local project with that id')
      const r = await send({ port: srv.port } as Ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC, project: { id: 'x', name: 'X' }, seq: 1, messages: [startMsg()] })
      assert.equal(r.status, 409)
      assert.deepEqual(ingest.sourceStates(), [])
      assert.equal(relay.applied.length, 0)
      assert.ok(!fs.existsSync(path.join(root, 'tm', 'remote', SRC)), 'no mirror')
    } finally { await srv.close(); ingest.dispose(); team.dispose(); removeTmpDir(root) }
  })

  test('item 2: a new source of a project retires the stale sources of that project only, after its own messages', async () => {
    const ctx = await setup()
    try {
      assert.equal((await post(ctx, SRC, 1, S1)).status, 200)
      assert.equal((await post(ctx, SRC3, 1, S3, { id: 'other-repo', name: 'Other' })).status, 200)
      ctx.clock.t += 61_000
      ctx.ingest!.sweep() // both stale
      assert.deepEqual(ctx.relay.retired, [])
      const appliedBefore = ctx.relay.applied.length
      assert.equal((await post(ctx, SRC2, 1, S2)).status, 200)
      assert.deepEqual(ctx.relay.retired, [SRC], 'the stale source of the same repo; not the other repo')
      assert.ok(ctx.relay.applied.slice(appliedBefore).every((a) => a.sourceId === SRC2) && ctx.relay.applied.length > appliedBefore,
        'the new source was applied (retirement comes after)')
      assert.deepEqual((await cloudList(ctx)).find((p) => p.id === PID), { id: PID, name: 'My Repo', sourceId: SRC2, stale: false })
      // The retired source keeps its mirror and binding (24 h removal as before) and may come back.
      assert.ok(fs.existsSync(path.join(ctx.home, 'remote', SRC)))
      assert.ok(ctx.ingest!.sourceStates().some((s) => s.sourceId === SRC && s.stale))
      // Its next request is not "new": it retires nobody.
      assert.equal((await post(ctx, SRC, 2, S1)).status, 200)
      assert.deepEqual(ctx.relay.retired, [SRC])
    } finally { await teardown(ctx) }
  })

  test('item 2: a new source that first sends its state (PUT state) retires stale siblings too', async () => {
    const ctx = await setup()
    try {
      assert.equal((await post(ctx, SRC, 1, S1)).status, 200)
      ctx.clock.t += 61_000
      ctx.ingest!.sweep()
      assert.equal((await send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId: SRC2, project, state: null, watcher: null }, auth(INGEST, OTHER_KEY))).status, 200)
      assert.deepEqual(ctx.relay.retired, [SRC])
    } finally { await teardown(ctx) }
  })

  test('item 3: a source silent for longer than the retire time gets its sub-agents finished once; again after it was live', async () => {
    const ctx = await setup({ retireAfterMs: 120_000 })
    try {
      assert.equal(ctx.ingest!.retireAfterMs, 120_000)
      assert.equal((await post(ctx, SRC, 1, S1)).status, 200)
      ctx.clock.t += 61_000
      ctx.ingest!.sweep()
      assert.deepEqual(ctx.relay.stale, [[SRC, true]])
      assert.deepEqual(ctx.relay.finished, [], 'stale is not enough')
      ctx.clock.t += 60_000
      ctx.ingest!.sweep()
      assert.deepEqual(ctx.relay.finished, [SRC])
      ctx.clock.t += 600_000
      ctx.ingest!.sweep()
      assert.deepEqual(ctx.relay.finished, [SRC], 'once per silence')
      assert.deepEqual(ctx.relay.retired, [], 'finishing is not retiring: the sessions stay listed (stale)')
      // Live again, then silent again: finished again.
      assert.equal((await post(ctx, SRC, 2, S1)).status, 200)
      ctx.clock.t += 121_000
      ctx.ingest!.sweep()
      assert.deepEqual(ctx.relay.finished, [SRC, SRC])
    } finally { await teardown(ctx) }
  })

  test('item 3: CLOUD_RETIRE_AFTER_MS defaults to 10 minutes; the env var of that name overrides it when it is a whole number > 0', () => {
    assert.equal(CLOUD_RETIRE_AFTER_MS, 600_000)
    assert.equal(cloudRetireAfterMs({}), 600_000)
    assert.equal(cloudRetireAfterMs({ CLOUD_RETIRE_AFTER_MS: '90000' }), 90_000)
    assert.equal(cloudRetireAfterMs({ CLOUD_RETIRE_AFTER_MS: ' 5000 ' }), 5000)
    for (const bad of ['', '0', '-5', '1.5', 'abc', '1e6', '99999999999999']) {
      assert.equal(cloudRetireAfterMs({ CLOUD_RETIRE_AFTER_MS: bad }), 600_000, `"${bad}" ignored`)
    }
    const saved = process.env.CLOUD_RETIRE_AFTER_MS
    process.env.CLOUD_RETIRE_AFTER_MS = '4321'
    try {
      const team = new TeamService([], { pollMs: 60_000 })
      const root = makeTmpDir()
      try {
        const svc = new IngestService({ home: root, token: INGEST, team, sweepMs: 0, log: () => {} })
        assert.equal(svc.retireAfterMs, 4321)
        assert.equal(new IngestService({ home: root, token: INGEST, team, sweepMs: 0, log: () => {}, cloudRetireAfterMs: 7 }).retireAfterMs, 7, 'the option wins')
        svc.dispose()
      } finally { team.dispose(); removeTmpDir(root) }
    } finally {
      if (saved === undefined) delete process.env.CLOUD_RETIRE_AFTER_MS
      else process.env.CLOUD_RETIRE_AFTER_MS = saved
    }
  })

  test('item 5: a source removed (capacity or 24 h idle) is forgotten by the relay, which retires and removes its sessions', async () => {
    const ctx = await setup({ maxSources: 1 })
    try {
      assert.equal((await post(ctx, SRC, 1, S1)).status, 200)
      ctx.clock.t += 11 * 60_000 // a bound source can be evicted for an unknown sourceId once stale for 10 minutes
      ctx.ingest!.sweep()
      // The cap is 1; the stale source of the same repo is evicted for the new one (its key binding kept as a tombstone).
      assert.equal((await post(ctx, SRC2, 1, S2)).status, 200)
      assert.deepEqual(ctx.relay.forgotten, [SRC])
      assert.deepEqual(await cloudList(ctx), [{ id: PID, name: 'My Repo', sourceId: SRC2, stale: false }])
    } finally { await teardown(ctx) }
  })
})

describe('0.9.8 fix round: shown source (F4) and stateMtime (F2)', () => {
  const SRC2 = 'cloud-box-2'
  const SRC3 = 'cloud-box-3'
  const KEYS: Record<string, string> = { [SRC]: KEY, [SRC2]: OTHER_KEY, [SRC3]: '7a'.repeat(32) }
  const titled = (t: string) => sampleState({ meta: { title: t } })
  const put = (ctx: Ctx, sourceId: string, state: unknown) =>
    send(ctx, 'PUT', '/api/ingest/v1/state', { sourceId, project, state, watcher: null }, auth(INGEST, KEYS[sourceId]))
  const seen = (ctx: Ctx, sourceId: string) => send(ctx, 'GET', `/api/ingest/v1/outbox?sourceId=${sourceId}`, undefined, auth(INGEST, KEYS[sourceId]))
  const stateOf = async (ctx: Ctx) => JSON.parse((await request(ctx.port, { path: `/api/team/state?project=${PID}` })).body) as
    { state: { meta: { title: string } } | null; stateMtime: string | null; updatedAt: string }
  /** An open /api/team/events stream: its team_state messages and whether the server ended it. */
  function teamStream(port: number) {
    const msgs: Array<Record<string, unknown>> = []
    let ended = false
    const req = http.request({ host: '127.0.0.1', port, path: `/api/team/events?project=${PID}`, headers: { Host: `localhost:${port}` } })
    let buf = ''
    req.on('response', (res) => {
      res.setEncoding('utf-8')
      res.on('data', (c: string) => {
        buf += c
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (chunk.startsWith('data: ')) msgs.push(JSON.parse(chunk.slice(6)))
        }
      })
      res.on('end', () => { ended = true })
      res.on('close', () => { ended = true })
    })
    req.on('error', () => { ended = true })
    req.end()
    return { msgs, ended: () => ended, close: () => req.destroy() }
  }

  test('F4: the shown source stays while it is live with a state; once stale, a live source with a state is shown and open streams are closed', async () => {
    const ctx = await setup()
    try {
      assert.equal((await put(ctx, SRC, titled('from box-1'))).status, 200)
      const s1 = teamStream(ctx.port)
      await waitFor(() => s1.msgs.length >= 1)
      assert.equal((s1.msgs[0].state as { meta: { title: string } }).meta.title, 'from box-1')

      // A second live source with a state, and a third (newest, no state) register: neither takes the project over.
      assert.equal((await put(ctx, SRC2, titled('from box-2'))).status, 200)
      ctx.clock.t += 1000
      assert.equal((await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC3, project, seq: 1, messages: [] }, auth(INGEST, KEYS[SRC3]))).status, 200)
      assert.equal(ctx.team.cloudSourceOf(PID), SRC)
      assert.equal((await stateOf(ctx)).state!.meta.title, 'from box-1')
      // SRC writes again while live: still shown, the stream stays open.
      assert.equal((await put(ctx, SRC, titled('box-1 again'))).status, 200)
      await waitFor(() => s1.msgs.some((m) => (m.state as { meta: { title: string } } | null)?.meta.title === 'box-1 again'))
      assert.equal(s1.ended(), false, 'no switch: the open stream is kept')
      assert.equal(ctx.team.cloudSourceOf(PID), SRC)

      // SRC goes stale while SRC2 (with a state) and SRC3 (newer, no state) stay live: SRC2 is shown.
      ctx.clock.t += 31_000
      assert.equal((await seen(ctx, SRC2)).status, 200)
      ctx.clock.t += 1000
      assert.equal((await seen(ctx, SRC3)).status, 200)
      ctx.clock.t += 30_000
      ctx.ingest!.sweep()
      assert.deepEqual(ctx.ingest!.sourceStates().map((s) => [s.sourceId, s.stale]), [[SRC, true], [SRC2, false], [SRC3, false]])
      assert.equal(ctx.team.cloudSourceOf(PID), SRC2, 'a live source with a state before the newer one without')
      await waitFor(() => s1.ended())
      // A reconnecting viewer (EventSource does) reads the new mirror.
      const s2 = teamStream(ctx.port)
      try {
        await waitFor(() => s2.msgs.length >= 1)
        assert.equal((s2.msgs[0].state as { meta: { title: string } }).meta.title, 'from box-2')
        assert.equal(s2.msgs[0].stateMtime, fs.statSync(path.join(ctx.home, 'remote', SRC2, '.agent-team', 'state.json')).mtime.toISOString())
        // SRC comes back live: SRC2 is live, so the project does not switch back.
        assert.equal((await seen(ctx, SRC)).status, 200)
        assert.equal(ctx.team.cloudSourceOf(PID), SRC2)
        await new Promise((r) => setTimeout(r, 50))
        assert.equal(s2.ended(), false)
      } finally { s2.close() }
      s1.close()
    } finally { await teardown(ctx) }
  })

  test('F4: when the shown source is stale and no live source has a state, a live one is shown anyway; all stale: kept', async () => {
    const ctx = await setup()
    try {
      assert.equal((await put(ctx, SRC, titled('from box-1'))).status, 200)
      ctx.clock.t += 61_000
      ctx.ingest!.sweep()
      assert.equal(ctx.team.cloudSourceOf(PID), SRC, 'every source stale: the shown one stays')
      assert.equal((await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC2, project, seq: 1, messages: [] }, auth(INGEST, KEYS[SRC2]))).status, 200)
      assert.equal(ctx.team.cloudSourceOf(PID), SRC2, 'live before stale')
    } finally { await teardown(ctx) }
  })

  test('F2: the served stateMtime is the mirror file time; an identical PUT does not rewrite it; null without a state', async () => {
    const ctx = await setup()
    try {
      assert.equal((await send(ctx, 'POST', '/api/ingest/v1/events', { sourceId: SRC, project, seq: 1, messages: [] })).status, 200)
      let snap = await stateOf(ctx)
      assert.equal(snap.stateMtime, null, 'no state file yet')
      assert.equal((await put(ctx, SRC, titled('one'))).status, 200)
      const file = path.join(ctx.home, 'remote', SRC, '.agent-team', 'state.json')
      const old = new Date('2026-11-20T01:02:03.456Z')
      fs.utimesSync(file, old, old)
      ctx.team.watcher(PID)!.refresh()
      snap = await stateOf(ctx)
      assert.equal(snap.stateMtime, old.toISOString())
      // The forwarder sends the same state again (heartbeat, hub restart): not rewritten, stateMtime unchanged.
      assert.equal((await put(ctx, SRC, titled('one'))).status, 200)
      assert.equal(fs.statSync(file).mtime.toISOString(), old.toISOString())
      assert.equal((await stateOf(ctx)).stateMtime, old.toISOString())
      // The team stream carries it too.
      const s = teamStream(ctx.port)
      try {
        await waitFor(() => s.msgs.length >= 1)
        assert.equal(s.msgs[0].type, 'team_state')
        assert.equal(s.msgs[0].stateMtime, old.toISOString())
      } finally { s.close() }
      // Another state is written: stateMtime is the new file time.
      assert.equal((await put(ctx, SRC, titled('two'))).status, 200)
      snap = await stateOf(ctx)
      assert.equal(snap.state!.meta.title, 'two')
      assert.equal(snap.stateMtime, fs.statSync(file).mtime.toISOString())
      assert.notEqual(snap.stateMtime, old.toISOString())
      // The state removed: null.
      assert.equal((await put(ctx, SRC, null)).status, 200)
      assert.equal((await stateOf(ctx)).stateMtime, null)
    } finally { await teardown(ctx) }
  })
})
