/**
 * Offboard endpoints (spec offboard-names item 1): same auth, CSRF and Origin rules as answers; validation; 409 for
 * a running agent; the list. Plus the coordinator in graphProjects and the store wired by setupTeam.
 */
import { test, describe, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { LoginLimiter, SESSION_COOKIE, SessionStore } from './auth'
import { buildRegistry } from './config'
import { createRequestHandler, RemoteAccess, TeamService } from './http'
import { setupTeam } from './index'
import { OFFBOARD_FILE, OffboardStore } from './offboard'
import type { RemoteConfig } from './remote'
import { GraphAgents, type GraphView } from '../../../scripts/graph-agents'
import type { AgentEvent } from '../../../extension/src/protocol'
import { listen, makeProject, makeTmpDir, removeTmpDir, request, Resp, sampleState, waitFor, writeState } from './test-helpers'

const S = '7e23e8af-0000-4000-8000-0000000000bb'
const S2 = '7e23e8af-0000-4000-8000-0000000000cc'
const HIRO = 'Hiro (Frontend Engineer): panel'
const REN = 'Ren (Backend Engineer): store'
const MEI = 'Mei (QA Engineer): review'
const TOKEN = 'cd'.repeat(32)
const TS_IP = '100.101.102.103'

interface Ctx {
  root: string
  home: string
  team: TeamService
  port: number
  close: () => Promise<void>
  remote: RemoteAccess | null
  announced: Array<{ session: string; agents: string[] }>
}

function graph(): { g: GraphAgents; view: GraphView; announced: Ctx['announced'] } {
  const g = new GraphAgents()
  const at = (sid: string, type: AgentEvent['type'], payload: Record<string, unknown>) => g.observe({ time: 0, type, payload, sessionId: sid })
  for (const sid of [S, S2]) at(sid, 'agent_spawn', { name: 'orchestrator', isMain: true })
  at(S, 'agent_spawn', { name: HIRO, displayName: 'Hiro', role: 'Frontend Engineer', task: 'panel' })
  at(S, 'agent_spawn', { name: REN, displayName: 'Ren', role: 'Backend Engineer', task: 'store' })
  at(S, 'agent_spawn', { name: MEI, displayName: 'Mei', role: 'QA Engineer', task: 'review' })
  at(S, 'agent_complete', { name: HIRO })
  at(S, 'agent_complete', { name: REN })
  at(S2, 'agent_spawn', { name: 'Explore the code' })
  at(S2, 'agent_complete', { name: 'Explore the code' })
  const announced: Ctx['announced'] = []
  const view: GraphView = {
    agents: (sid) => g.agents(sid),
    sessionProject: (sid) => (sid === S ? 'proyek-satu' : 'proyek-dua'),
    announceOffboarded: (session, agents) => { announced.push({ session, agents }) },
  }
  return { g, view, announced }
}

async function setup(remoteMode: boolean, withGraph = true): Promise<Ctx> {
  const root = makeTmpDir()
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { mode: 0o700 })
  const p1 = makeProject(root, 'Proyek Satu')
  const p2 = makeProject(root, 'Proyek Dua')
  const team = new TeamService(buildRegistry([], [p1, p2]), { debounceMs: 10, pollMs: 60_000, log: () => {} })
  team.offboard = new OffboardStore(home, () => {})
  const { view, announced } = graph()
  if (withGraph) team.graph = view
  let remote: RemoteAccess | null = null
  if (remoteMode) {
    const config: RemoteConfig = {
      bindMode: 'loopback', bindAddress: '127.0.0.1', tailscaleIp: TS_IP, dnsName: null,
      allowedHosts: new Set([TS_IP]),
    }
    remote = { config, token: TOKEN, sessions: new SessionStore(null, TOKEN), limiter: new LoginLimiter(5) }
  }
  const handler = createRequestHandler({
    team, remote, log: () => {},
    fallback: (_req, res) => { res.writeHead(200); res.end('fallback') },
  })
  const { port, close } = await listen(handler)
  return { root, home, team, port, close, remote, announced }
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.close()
  ctx.team.dispose()
  removeTmpDir(ctx.root)
}

const json = (r: Resp) => JSON.parse(r.body) as Record<string, unknown>

function post(ctx: Ctx, route: string, body: unknown, headers: Record<string, string> = {}): Promise<Resp> {
  return request(ctx.port, {
    method: 'POST', path: `/api/team/${route}`,
    headers: { 'Content-Type': 'application/json', 'X-Team-Monitor': '1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('offboard endpoints, default mode', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(false) })
  after(async () => { await teardown(ctx) })

  test('header, Origin and Sec-Fetch-Site rules as for answers (403), nothing written', async () => {
    for (const route of ['offboard', 'offboard-all']) {
      const body = { session: S, agent: HIRO }
      const noHeader = await request(ctx.port, { method: 'POST', path: `/api/team/${route}`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(noHeader.status, 403, `${route} without X-Team-Monitor`)
      assert.equal((await post(ctx, route, body, { 'X-Team-Monitor': '2' })).status, 403)
      assert.equal((await post(ctx, route, body, { Origin: 'http://evil.example' })).status, 403, `${route} foreign Origin`)
      assert.equal((await post(ctx, route, body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
      assert.equal(json(noHeader).ok, false)
    }
    assert.equal(fs.existsSync(path.join(ctx.home, OFFBOARD_FILE)), false)
  })

  test('a same-origin Origin header is accepted', async () => {
    const r = await post(ctx, 'offboard', { session: S2, agent: 'Explore the code' }, { Origin: `http://127.0.0.1:${ctx.port}`, 'Sec-Fetch-Site': 'same-origin' })
    assert.equal(r.status, 200, r.body)
  })

  test('media type, size, JSON and shape (400)', async () => {
    const wrongType = await post(ctx, 'offboard', { session: S, agent: HIRO }, { 'Content-Type': 'text/plain' })
    assert.equal(wrongType.status, 400)
    const big = await post(ctx, 'offboard', JSON.stringify({ session: S, agent: HIRO, pad: 'x'.repeat(5000) }))
    assert.equal(big.status, 400)
    assert.match(String(json(big).error), /larger than 4096/)
    assert.equal((await post(ctx, 'offboard', '{not json')).status, 400)
    assert.equal((await post(ctx, 'offboard', { session: '../../etc', agent: HIRO })).status, 400)
    assert.equal((await post(ctx, 'offboard', { session: S })).status, 400)
    assert.equal((await post(ctx, 'offboard', { session: S, agent: 'x'.repeat(201) })).status, 400)
    assert.equal((await post(ctx, 'offboard-all', [])).status, 400)
    assert.equal((await post(ctx, 'offboard', { session: S, agent: 'orchestrator' })).status, 400, 'the Orchestrator')
  })

  test('unknown session or agent (404), running agent (409)', async () => {
    assert.equal((await post(ctx, 'offboard', { session: 'unknown-session', agent: HIRO })).status, 404)
    assert.equal((await post(ctx, 'offboard', { session: S, agent: 'Nobody (QA Engineer): x' })).status, 404)
    assert.equal((await post(ctx, 'offboard-all', { session: 'unknown-session' })).status, 404)
    const running = await post(ctx, 'offboard', { session: S, agent: MEI })
    assert.equal(running.status, 409)
    assert.deepEqual(json(running), { ok: false, error: 'agent is still running' })
  })

  test('offboard one: 200 with the record, stored 0600, announced; again is idempotent', async () => {
    const r = await post(ctx, 'offboard', { session: S, agent: HIRO })
    assert.equal(r.status, 200, r.body)
    const body = json(r) as { ok: boolean; alreadyOffboarded: boolean; offboarded: Array<Record<string, unknown>> }
    assert.equal(body.ok, true)
    assert.equal(body.alreadyOffboarded, false)
    assert.equal(body.offboarded.length, 1)
    const rec = body.offboarded[0]
    assert.equal(rec.session, S)
    assert.equal(rec.agent, HIRO)
    assert.equal(rec.name, 'Hiro')
    assert.equal(rec.role, 'Frontend Engineer')
    assert.equal(rec.task, 'panel')
    assert.equal(rec.project, 'proyek-satu')
    assert.match(String(rec.finishedAt), /^\d{4}-\d\d-\d\dT/)
    assert.match(String(rec.offboardedAt), /^\d{4}-\d\d-\d\dT/)
    assert.equal(fs.statSync(path.join(ctx.home, OFFBOARD_FILE)).mode & 0o777, 0o600)
    assert.deepEqual(ctx.announced.at(-1), { session: S, agents: [HIRO] })
    const again = await post(ctx, 'offboard', { session: S, agent: HIRO })
    assert.equal(again.status, 200)
    assert.equal(json(again).alreadyOffboarded, true)
  })

  test('offboard all: every finished one left, never the running one', async () => {
    const r = await post(ctx, 'offboard-all', { session: S })
    assert.equal(r.status, 200, r.body)
    const recs = (json(r).offboarded as Array<{ agent: string }>).map((x) => x.agent)
    assert.deepEqual(recs, [REN])
    assert.equal(ctx.team.offboard!.isOffboarded(S, MEI), false)
    assert.deepEqual(json(await post(ctx, 'offboard-all', { session: S })).offboarded, [])
  })

  test('list: all, per project, per session; unknown project 404, bad session 400', async () => {
    const all = await request(ctx.port, { path: '/api/team/offboarded' })
    assert.equal(all.status, 200)
    assert.deepEqual((json(all).offboarded as Array<{ agent: string }>).map((x) => x.agent).sort(), [HIRO, REN, 'Explore the code'].sort())
    const p1 = json(await request(ctx.port, { path: '/api/team/offboarded?project=proyek-satu' })).offboarded as Array<{ agent: string }>
    assert.deepEqual(p1.map((x) => x.agent).sort(), [HIRO, REN].sort())
    const s2 = json(await request(ctx.port, { path: `/api/team/offboarded?session=${S2}` })).offboarded as Array<{ agent: string }>
    assert.deepEqual(s2.map((x) => x.agent), ['Explore the code'])
    assert.equal((await request(ctx.port, { path: '/api/team/offboarded?project=nope' })).status, 404)
    assert.equal((await request(ctx.port, { path: '/api/team/offboarded?session=../x' })).status, 400)
  })

  test('wrong methods give 405', async () => {
    const get = await request(ctx.port, { path: '/api/team/offboard' })
    assert.equal(get.status, 405)
    assert.equal(get.headers.allow, 'POST')
    assert.equal((await request(ctx.port, { path: '/api/team/offboard-all' })).status, 405)
    assert.equal((await post(ctx, 'offboarded', {})).status, 405)
  })

  test('a foreign Host is refused before anything else (403)', async () => {
    assert.equal((await post(ctx, 'offboard', { session: S, agent: HIRO }, { Host: 'evil.example' })).status, 403)
  })
})

describe('offboard endpoints without a running graph', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(false, false) })
  after(async () => { await teardown(ctx) })

  test('answers 503 and writes nothing', async () => {
    const r = await post(ctx, 'offboard', { session: S, agent: HIRO })
    assert.equal(r.status, 503)
    assert.equal(fs.existsSync(path.join(ctx.home, OFFBOARD_FILE)), false)
  })
})

describe('offboard endpoints, remote mode', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(true) })
  after(async () => { await teardown(ctx) })

  const phone = () => ({ Host: `${TS_IP}:${ctx.port}`, 'X-Forwarded-For': '100.64.0.7', 'X-Forwarded-Proto': 'https' })

  test('no session: 401 for the actions and the list', async () => {
    assert.equal((await post(ctx, 'offboard', { session: S, agent: HIRO }, phone())).status, 401)
    assert.equal((await post(ctx, 'offboard-all', { session: S }, phone())).status, 401)
    assert.equal((await request(ctx.port, { path: '/api/team/offboarded', headers: phone() })).status, 401)
    assert.equal(fs.existsSync(path.join(ctx.home, OFFBOARD_FILE)), false)
  })

  test('with a session from the phone: works, still needs the header and the same origin', async () => {
    const cookie = `${SESSION_COOKIE}=${ctx.remote!.sessions.create()}`
    const h = { ...phone(), Cookie: cookie }
    assert.equal((await post(ctx, 'offboard', { session: S, agent: HIRO }, { ...h, 'X-Team-Monitor': '0' })).status, 403)
    assert.equal((await post(ctx, 'offboard', { session: S, agent: HIRO }, { ...h, Origin: `http://${TS_IP}:${ctx.port}` })).status, 403, 'http origin behind https serve')
    const ok = await post(ctx, 'offboard', { session: S, agent: HIRO }, { ...h, Origin: `https://${TS_IP}:${ctx.port}` })
    assert.equal(ok.status, 200, ok.body)
    const list = await request(ctx.port, { path: '/api/team/offboarded?project=proyek-satu', headers: h })
    assert.deepEqual((json(list).offboarded as Array<{ agent: string }>).map((x) => x.agent), [HIRO])
  })
})

describe('coordinator in graphProjects and the store in setupTeam', () => {
  test('graphProjects carries meta.coordinator and follows changes', async () => {
    const root = makeTmpDir()
    const p = makeProject(root, 'Proyek', sampleState({ meta: { title: 'T', coordinator: { name: 'Sora' } } }))
    const team = new TeamService(buildRegistry([], [p]), { debounceMs: 10, pollMs: 50, log: () => {} })
    try {
      assert.deepEqual(team.graphProjects()[0].coordinator, { name: 'Sora', role: 'Orchestrator' })
      writeState(p, sampleState({ meta: { title: 'T', coordinator: { name: 'Haru', role: 'Software Architect' } } }))
      await waitFor(() => team.graphProjects()[0].coordinator?.name === 'Haru')
      assert.deepEqual(team.graphProjects()[0].coordinator, { name: 'Haru', role: 'Software Architect' })
      writeState(p, sampleState({ meta: { title: 'T' } }))
      await waitFor(() => team.graphProjects()[0].coordinator === undefined)
    } finally {
      team.dispose()
      removeTmpDir(root)
    }
  })

  test('setupTeam opens the store in the team home', () => {
    const root = makeTmpDir()
    try {
      const home = path.join(root, 'tm-home')
      const setup = setupTeam({ projects: [], remote: false, hostAllow: [] }, { env: { TEAM_MONITOR_HOME: home }, log: () => {}, warn: () => {} })
      try {
        assert.ok(setup.team.offboard)
        assert.equal(setup.team.offboard!.file, path.join(home, OFFBOARD_FILE))
        assert.equal(setup.team.graph, null, 'attached later by the server')
      } finally { setup.dispose() }
    } finally { removeTmpDir(root) }
  })
})
