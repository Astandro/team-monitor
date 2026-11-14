/**
 * Fixes after the `--public-ui` security QA (P-01 to P-06), in process:
 * - P-01: with --public-ui no request is login-free (no local exception); the unauthenticated health route answers a
 *   fixed body in every mode and `service status` / doctor use it; without --public-ui more headers count as
 *   forwarding evidence.
 * - P-02/P-03: doctor looks at Funnel in every mode and fails when the monitor is on Funnel without --public-ui (the
 *   "tailscale serve maps" line is tailnet-only); the start-up warning; default mode refuses forwarded requests.
 * - P-04: with --public-ui a login without a usable client address is refused (400) before the token check, counted
 *   under no key and logged rate-limited.
 * - P-05: logout-all closes open streams of dropped sessions at once.
 * - P-06: protective headers on the app shell and every static asset (no framing ban in cloud mode only).
 */
import { test, describe, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { appCsp, serveStatic, staticHeaders } from '../static'
import { LoginLimiter, logoutAll, SessionStore } from './auth'
import { buildRegistry } from './config'
import { DoctorDeps, funnelChecks, funnelOffCommand, runDoctor, serveMappings } from './doctor'
import {
  createRequestHandler, FORWARDED_REFUSED, hasForwardingEvidence, HEALTH_BODY, HEALTH_PATH, NO_CLIENT_ADDRESS_MESSAGE,
  RemoteAccess, TeamService,
} from './http'
import { funnelStartWarning, remoteBannerLines } from './index'
import { addProject } from './projects'
import type { RemoteConfig } from './remote'
import { CmdRunner, installService, realProbe } from './service'
import { listen, makeProject, makeTmpDir, removeTmpDir, request, Resp } from './test-helpers'

const TOKEN = 'cd'.repeat(32)
const DNS = 'machine.tailnet.ts.net'
const quiet = () => {}

interface Ctx { root: string; home: string; port: number; close: () => Promise<void>; team: TeamService; remote: RemoteAccess | null; logs: string[]; pid: string }

/** A handler on a free port. `mode`: default (no --remote), cloud (anyHost), remote, public (remote + --public-ui). */
async function setup(mode: 'default' | 'cloud' | 'remote' | 'public'): Promise<Ctx> {
  const root = makeTmpDir()
  const home = path.join(root, 'tm')
  fs.mkdirSync(home, { mode: 0o700 })
  const project = makeProject(root, 'proj-fixes')
  const team = new TeamService(buildRegistry([], [project]), { debounceMs: 10, pollMs: 60_000, log: quiet })
  const config: RemoteConfig = { bindMode: 'loopback', bindAddress: '127.0.0.1', tailscaleIp: null, dnsName: DNS, allowedHosts: new Set([DNS]) }
  const remote: RemoteAccess | null = mode === 'remote' || mode === 'public'
    ? { config, token: TOKEN, sessions: new SessionStore(home, TOKEN), limiter: new LoginLimiter() }
    : null
  const logs: string[] = []
  const handler = createRequestHandler({
    team, remote, publicUi: mode === 'public', anyHost: mode === 'cloud', log: (m) => logs.push(m),
    fallback: (req, res) => {
      if (req.url === '/events') {
        // Stands in for the relay's graph stream: stays open until closed.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(': open\n\n')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ui')
    },
  })
  const { port, close } = await listen(handler)
  return { root, home, port, close, team, remote, logs, pid: team.list()[0].id }
}

async function teardown(ctx: Ctx): Promise<void> {
  ctx.team.dispose()
  await ctx.close()
  removeTmpDir(ctx.root)
}

const local = (ctx: Ctx, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Resp> =>
  request(ctx.port, { ...o, headers: { Host: `127.0.0.1:${ctx.port}`, ...o.headers } })

/** As Funnel's proxy delivers it: public Host, forwarded headers, loopback socket. */
const viaFunnel = (ctx: Ctx, o: { method?: string; path: string; xff?: string; headers?: Record<string, string>; body?: string }): Promise<Resp> =>
  request(ctx.port, {
    ...o,
    headers: { Host: DNS, 'X-Forwarded-For': o.xff ?? '203.0.113.200', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': DNS, ...o.headers },
  })

function loginForm(ctx: Ctx, token: string, headers: Record<string, string>, xff?: string): Promise<Resp> {
  const h = { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }
  const body = `token=${token}`
  return xff === undefined
    ? local(ctx, { method: 'POST', path: '/login', body, headers: h })
    : viaFunnel(ctx, { method: 'POST', path: '/login', body, xff, headers: { Origin: `https://${DNS}`, 'Sec-Fetch-Site': 'same-origin', ...h } })
}

const EVIDENCE: Array<Record<string, string>> = [
  { 'X-Forwarded-For': '203.0.113.1' }, { 'X-Forwarded-Host': DNS }, { 'X-Forwarded-Proto': 'https' },
  { Forwarded: 'for=203.0.113.1' }, { 'X-Real-IP': '203.0.113.1' }, { Via: '1.1 proxy' },
  { 'Tailscale-User-Login': 'a@b' }, { 'Tailscale-Funnel-Request': '?1' }, { 'Tailscale-Anything': 'x' }, { 'X-Forwarded-For': '' },
]

// ─── P-01 ───────────────────────────────────────────────────────────────────

describe('P-01: forwarding evidence and the local exception', () => {
  test('hasForwardingEvidence: the six headers and any Tailscale-* header, even empty; nothing else', () => {
    const fake = (headers: Record<string, string>) => ({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) }) as unknown as http.IncomingMessage
    for (const h of EVIDENCE) assert.equal(hasForwardingEvidence(fake(h)), true, JSON.stringify(h))
    assert.equal(hasForwardingEvidence(fake({ host: 'localhost', accept: '*/*', 'x-forwarded': 'x', x_forwarded_for: '1.2.3.4', 'user-agent': 'curl' })), false)
  })

  describe('remote mode without --public-ui', () => {
    let ctx: Ctx
    before(async () => { ctx = await setup('remote') })
    after(async () => { await teardown(ctx) })

    test('a plain local request still needs no login; any forwarding evidence makes it need one', async () => {
      assert.equal((await local(ctx, { path: '/api/team/projects' })).status, 200)
      for (const h of EVIDENCE) assert.equal((await local(ctx, { path: '/api/team/projects', headers: h })).status, 401, JSON.stringify(h))
    })
  })

  describe('--public-ui: no login-free path', () => {
    let ctx: Ctx
    before(async () => { ctx = await setup('public') })
    after(async () => { await teardown(ctx) })

    test('a plain local request (loopback socket, loopback Host, no forwarded header) needs a session', async () => {
      for (const host of [`127.0.0.1:${ctx.port}`, 'localhost', '[::1]', `LOCALHOST:${ctx.port}`]) {
        for (const p of ['/api/team/projects', `/api/team/state?project=${ctx.pid}`, '/events', '/index.js', '/']) {
          const r = await local(ctx, { path: p, headers: { Host: host } })
          assert.equal(r.status, 401, `${host} ${p}`)
          assert.equal(r.body, '{"ok":false,"error":"login required"}')
        }
        const page = await local(ctx, { path: '/', headers: { Host: host, Accept: 'text/html' } })
        assert.deepEqual([page.status, page.headers.location], [302, '/login'])
      }
      const write = await local(ctx, {
        method: 'POST', path: '/api/team/message', body: JSON.stringify({ project: ctx.pid, text: 'x' }),
        headers: { 'Content-Type': 'application/json', 'X-Team-Monitor': '1' },
      })
      assert.equal(write.status, 401, 'no chat written as the owner')
      assert.equal(fs.existsSync(path.join(ctx.root, 'proj-fixes', '.agent-team', 'inbox')), false)
    })

    test('the health route answers a fixed body without a session, locally and through Funnel; only GET/HEAD', async () => {
      for (const r of [await local(ctx, { path: HEALTH_PATH }), await viaFunnel(ctx, { path: HEALTH_PATH }), await local(ctx, { path: `${HEALTH_PATH}?x=1` })]) {
        assert.equal(r.status, 200)
        assert.equal(r.body, HEALTH_BODY)
        assert.equal(r.headers['x-content-type-options'], 'nosniff')
      }
      assert.equal(HEALTH_BODY, '{"ok":true}')
      assert.equal((await local(ctx, { method: 'HEAD', path: HEALTH_PATH })).body, '')
      assert.equal((await local(ctx, { method: 'POST', path: HEALTH_PATH, body: '{}' })).status, 405)
      assert.equal((await viaFunnel(ctx, { path: HEALTH_PATH, headers: { Host: 'evil.example' } })).status, 403, 'Host check first')
      // Neighbours are not open.
      for (const p of ['/healthz/', '/healthz/x', '/health', '/HEALTHZ']) assert.equal((await local(ctx, { path: p })).status, 401, p)
    })

    test('service status / doctor probe uses the health route and is healthy on a --public-ui monitor', async () => {
      const h = await realProbe.health('127.0.0.1', ctx.port)
      assert.equal(h.ok, true)
      assert.equal(h.status, 200)
    })
  })

  test('the health route also answers in default and cloud mode, with nothing but the fixed body', async () => {
    for (const mode of ['default', 'cloud', 'remote'] as const) {
      const ctx = await setup(mode)
      try {
        const r = await local(ctx, { path: HEALTH_PATH })
        assert.deepEqual([r.status, r.body], [200, HEALTH_BODY], mode)
        assert.equal((await realProbe.health('127.0.0.1', ctx.port)).ok, true, mode)
      } finally {
        await teardown(ctx)
      }
    }
  })
})

// ─── P-03: default mode refuses forwarded requests ──────────────────────────

describe('P-03: default mode refuses forwarded requests', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup('default') })
  after(async () => { await teardown(ctx) })

  test('any forwarding evidence: 403 with a fixed text, whatever the Host; a plain local request works as before', async () => {
    assert.equal((await local(ctx, { path: '/api/team/projects' })).status, 200)
    assert.equal((await local(ctx, { path: '/api/team/projects', headers: { Host: 'localhost' } })).status, 200)
    for (const h of EVIDENCE) {
      for (const host of ['localhost', `127.0.0.1:${ctx.port}`, '[::1]']) {
        for (const p of ['/api/team/projects', '/', '/events', HEALTH_PATH]) {
          const r = await local(ctx, { path: p, headers: { Host: host, ...h } })
          assert.deepEqual([r.status, r.body], [403, FORWARDED_REFUSED], `${JSON.stringify(h)} ${host} ${p}`)
        }
      }
    }
    const write = await local(ctx, {
      method: 'POST', path: '/api/team/message', body: JSON.stringify({ project: ctx.pid, text: 'x' }),
      headers: { Host: 'localhost', 'X-Forwarded-For': '203.0.113.9', 'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json', 'X-Team-Monitor': '1' },
    })
    assert.equal(write.status, 403)
    assert.equal(fs.existsSync(path.join(ctx.root, 'proj-fixes', '.agent-team', 'inbox')), false)
  })

  test('cloud mode (preview pane, any Host for reads) is a separate mode and unchanged', async () => {
    const cloud = await setup('cloud')
    try {
      assert.equal((await local(cloud, { path: '/api/team/projects', headers: { Host: 'preview.example', 'X-Forwarded-For': '10.0.0.1' } })).status, 200)
    } finally {
      await teardown(cloud)
    }
  })
})

// ─── P-02 / P-03: doctor and the start-up warning ───────────────────────────

const PORT = 3803
const ROOT = { '/': { Proxy: `http://127.0.0.1:${PORT}` } }
const st = (web: Record<string, unknown>, funnel: string[] = []) =>
  JSON.stringify({ Web: web, AllowFunnel: Object.fromEntries(funnel.map((k) => [k, true])) })
const TAILNET = st({ [`${DNS}:8443`]: { Handlers: ROOT } })
const FUNNEL_ROOT_ONLY = st({ [`${DNS}:443`]: { Handlers: ROOT } }, [`${DNS}:443`])
const FUNNEL_ROOT_AND_TAILNET = st({ [`${DNS}:8443`]: { Handlers: ROOT }, [`${DNS}:443`]: { Handlers: ROOT } }, [`${DNS}:443`])
const FUNNEL_INGEST = st({ [`${DNS}:443`]: { Handlers: { '/api/ingest': { Proxy: `http://127.0.0.1:${PORT}/api/ingest` } } } }, [`${DNS}:443`])
const FUNNEL_SUBPATH = st({ [`${DNS}:10000`]: { Handlers: { '/x': { Proxy: `http://localhost:${PORT}/api/team` } } } }, [`${DNS}:10000`])
const FUNNEL_OTHER_SERVICE = st({ [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } }, [`${DNS}:443`])

describe('P-02/P-03: doctor looks at Funnel in every mode', () => {
  let root: string
  let home: string
  let deps: DoctorDeps
  const serve: { json: string | (() => string) } = { json: TAILNET }

  async function install(flags: { remote: boolean; ingest?: boolean; publicUi?: boolean }): Promise<void> {
    await installService({ port: PORT, hostAllow: [], ...(flags.remote ? { bind: 'loopback' } : {}), ...flags }, deps)
  }
  const lines = async (d: DoctorDeps = deps) => (await runDoctor(d)).filter((c) => /funnel|serve|internet/.test(c.what))

  before(() => {
    root = makeTmpDir()
    home = path.join(root, 'user', '.team-monitor')
    const dist = path.join(root, 'dist')
    fs.mkdirSync(path.join(dist, 'webview'), { recursive: true })
    for (const f of ['app.js', 'ask-hook.js', 'webview/index.js', 'webview/index.css']) fs.writeFileSync(path.join(dist, f), '')
    const proj = path.join(root, 'web')
    fs.mkdirSync(proj)
    addProject(home, proj)
    fs.writeFileSync(path.join(home, 'token'), 'a'.repeat(64), { mode: 0o600 })
    fs.writeFileSync(path.join(home, 'ingest-token'), 'b'.repeat(64), { mode: 0o600 })
    const loaded = new Set<string>()
    const run: CmdRunner = (_cmd, args) => {
      if (args[0] === 'print') return loaded.size ? { code: 0, stdout: 'state = running\npid = 99\n', stderr: '' } : { code: 113, stdout: '', stderr: '' }
      if (args[0] === 'bootstrap') loaded.add('x')
      if (args[0] === 'bootout') loaded.clear()
      return { code: 0, stdout: '', stderr: '' }
    }
    deps = {
      env: { TEAM_MONITOR_HOME: home }, platform: 'darwin', homedir: path.join(root, 'user'), uid: 501, execPath: '/n/node',
      appJs: path.join(dist, 'app.js'), run, sleep: async () => {},
      runTailscale: (args) => {
        if (args[0] !== 'serve') return JSON.stringify({ Self: { DNSName: `${DNS}.` } })
        return typeof serve.json === 'function' ? serve.json() : serve.json
      },
      probe: { portOpen: async () => true, health: async () => ({ ok: true, status: 200 }) },
      settingsFile: path.join(root, 'none.json'), out: quiet, err: quiet,
    }
  })
  after(() => removeTmpDir(root))

  test('serveMappings counts tailnet-only host:ports, never a Funnel one', () => {
    assert.deepEqual(serveMappings(FUNNEL_ROOT_AND_TAILNET, PORT), ['8443'])
    assert.deepEqual(serveMappings(FUNNEL_ROOT_ONLY, PORT), [])
    assert.deepEqual(serveMappings(TAILNET, PORT), ['8443'])
  })

  test('remote --bind loopback without --public-ui, whole app on Funnel: FAIL, never the "serve maps" OK line for it', async () => {
    await install({ remote: true })
    serve.json = FUNNEL_ROOT_ONLY
    const l = await lines()
    assert.ok(!l.some((c) => c.level === 'ok' && /serve maps https port 443/.test(c.what)), JSON.stringify(l))
    const exposed = l.find((c) => /reachable from the internet/.test(c.what))
    assert.ok(exposed && exposed.level === 'fail', JSON.stringify(l))
    assert.match(exposed!.what, new RegExp(`makes / on ${DNS.replace(/\./g, '\\.')}:443 public \\(to 127\\.0\\.0\\.1:${PORT}\\) without --public-ui`))
    assert.equal(exposed!.fix, 'turn that Funnel mapping off: tailscale funnel --https=443 off')
    assert.ok(l.some((c) => c.level === 'fail' && /no tailnet-only mapping/.test(c.what)), 'the tailnet mapping is still missing')
    // With the tailnet mapping next to it: the OK line names 8443 only, and Funnel still fails.
    serve.json = FUNNEL_ROOT_AND_TAILNET
    const l2 = await lines()
    assert.ok(l2.some((c) => c.level === 'ok' && c.what === `tailscale serve maps https port 8443 to 127.0.0.1:${PORT} (tailnet only)`), JSON.stringify(l2))
    assert.ok(l2.some((c) => c.level === 'fail' && /reachable from the internet/.test(c.what)))
    // Tailnet only: all good.
    serve.json = TAILNET
    assert.deepEqual((await lines()).map((c) => c.level), ['ok', 'ok'])
  })

  test('default mode service (no --remote): Funnel on its port fails; any path, any Funnel port', async () => {
    await install({ remote: false })
    for (const [json, hp, cmd] of [
      [FUNNEL_ROOT_ONLY, `${DNS}:443`, 'tailscale funnel --https=443 off'],
      [FUNNEL_INGEST, `${DNS}:443`, 'tailscale funnel --https=443 --set-path /api/ingest off'],
      [FUNNEL_SUBPATH, `${DNS}:10000`, 'tailscale funnel --https=10000 --set-path /x off'],
    ]) {
      serve.json = json
      const f = (await lines()).filter((c) => c.level === 'fail')
      assert.equal(f.length, 1, json)
      assert.match(f[0].what, new RegExp(`reachable from the internet: .* on ${hp.replace(/\./g, '\\.')} public`))
      assert.equal(f[0].fix, `turn that Funnel mapping off: ${cmd}`)
    }
    serve.json = FUNNEL_OTHER_SERVICE
    assert.deepEqual((await lines()).map((c) => c.level), ['ok'], 'another service on Funnel is not this monitor')
  })

  test('--ingest only: exactly /api/ingest allowed; anything else of the monitor fails with the off command', async () => {
    await install({ remote: true, ingest: true })
    serve.json = st({ [`${DNS}:8443`]: { Handlers: ROOT }, [`${DNS}:443`]: { Handlers: { '/api/ingest': { Proxy: `http://127.0.0.1:${PORT}/api/ingest` } } } }, [`${DNS}:443`])
    assert.deepEqual((await lines()).filter((c) => c.level === 'fail'), [])
    serve.json = st({ [`${DNS}:8443`]: { Handlers: ROOT }, [`${DNS}:443`]: { Handlers: { '/api/ingest': { Proxy: `http://127.0.0.1:${PORT}/api/ingest` }, '/x': { Proxy: `http://127.0.0.1:${PORT}/` } } } }, [`${DNS}:443`])
    const f = (await lines()).filter((c) => c.level === 'fail')
    assert.equal(f.length, 1)
    assert.match(f[0].what, /reachable from the internet: tailscale funnel makes \/x on/)
    assert.equal(f[0].fix, 'turn that Funnel mapping off: tailscale funnel --https=443 --set-path /x off')
  })

  test('--public-ui: the whole-app mapping is expected, as before', async () => {
    await install({ remote: true, publicUi: true })
    serve.json = FUNNEL_ROOT_ONLY
    const l = await lines()
    assert.deepEqual(l.filter((c) => c.level === 'fail'), [], 'no tailnet-only mapping needed either')
    assert.ok(l.some((c) => c.level === 'ok' && /serves the whole app/.test(c.what)))
    // The service's health line names the health route.
    assert.ok((await runDoctor(deps)).some((c) => c.level === 'ok' && c.what === `healthy: GET http://127.0.0.1:${PORT}${HEALTH_PATH} 200`))
  })

  test('no tailscale binary: no Funnel line; status unreadable: a warning (no failure) in default mode', async () => {
    await install({ remote: false })
    const enoent = Object.assign(new Error('spawnSync tailscale ENOENT'), { code: 'ENOENT' })
    serve.json = () => { throw enoent }
    assert.deepEqual(await lines(), [])
    assert.deepEqual(funnelChecks(PORT, 'tailscale', () => { throw enoent }), [])
    serve.json = () => { throw new Error('failed to connect to local tailscaled') }
    assert.deepEqual((await lines()).map((c) => c.level), ['warn'])
  })

  test('funnelOffCommand quotes a binary path with spaces', () => {
    assert.equal(funnelOffCommand('h:8443', '/', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'), '/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --https=8443 off')
    assert.equal(funnelOffCommand('h:443', '/', '/a b/tailscale'), '"/a b/tailscale" funnel --https=443 off')
  })
})

describe('P-02/P-03: start-up warning of a monitor without --public-ui', () => {
  const ok = (json: string) => async () => json
  test('Funnel on its port: prominent lines with where and the off command; never with --public-ui', async () => {
    const w = await funnelStartWarning(PORT, {}, ok(FUNNEL_ROOT_ONLY))
    const text = w.join('\n')
    assert.match(text, /REACHABLE FROM THE INTERNET through Tailscale Funnel/)
    assert.match(text, new RegExp(`Funnel maps / on ${DNS.replace(/\./g, '\\.')}:443 to 127\\.0\\.0\\.1:${PORT}, but the monitor was not started with --public-ui`))
    assert.match(text, /Turn it off: tailscale funnel --https=443 off/)
    assert.deepEqual(await funnelStartWarning(PORT, { publicUi: true }, ok(FUNNEL_ROOT_ONLY)), [])
    assert.deepEqual(await funnelStartWarning(PORT, {}, ok(TAILNET)), [])
    assert.deepEqual(await funnelStartWarning(PORT, { ingest: true }, ok(FUNNEL_INGEST)), [], '--ingest: /api/ingest is expected')
    assert.notDeepEqual(await funnelStartWarning(PORT, { ingest: true }, ok(FUNNEL_ROOT_ONLY)), [])
    assert.notDeepEqual(await funnelStartWarning(PORT, {}, ok(FUNNEL_INGEST)), [], 'without --ingest even /api/ingest is unexpected')
  })

  test('best effort: a missing binary, an error or junk give no lines and never throw', async () => {
    const fail = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
    assert.deepEqual(await funnelStartWarning(PORT, {}, fail), [])
    assert.deepEqual(await funnelStartWarning(PORT, {}, ok('not json')), [])
  })
})

// ─── P-04: no shared lockout bucket ─────────────────────────────────────────

describe('P-04: --public-ui login without a usable client address', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup('public') })
  after(async () => { await teardown(ctx) })

  const SAME = { Origin: `http://127.0.0.1:0`, 'Sec-Fetch-Site': 'same-origin' }

  test('refused with a fixed 400 before the token is checked (also the right token), counted under no key', async () => {
    const same = { ...SAME, Origin: `http://127.0.0.1:${ctx.port}` }
    for (let i = 0; i < 12; i++) {
      const r = await loginForm(ctx, i === 11 ? TOKEN : 'wrong', same)
      assert.equal(r.status, 400)
      assert.ok(r.body.includes(NO_CLIENT_ADDRESS_MESSAGE), r.body)
      assert.equal(r.headers['set-cookie'], undefined)
    }
    // Non-IP last entries (only a local process can send them): the same refusal.
    for (const xff of ['not-an-ip', '203.0.113.5, junk', ' , ', '']) {
      assert.equal((await loginForm(ctx, TOKEN, {}, xff)).status, 400, JSON.stringify(xff))
    }
    assert.equal(ctx.remote!.limiter.size, 0, 'nothing counted')
    // Real addresses are not affected at all: a wrong token is a plain 401, the right one logs in.
    assert.equal((await loginForm(ctx, 'wrong', {}, '203.0.113.30')).status, 401)
    assert.equal((await loginForm(ctx, TOKEN, {}, '203.0.113.31')).status, 303)
  })

  test('logged, rate-limited: one line, never the token', () => {
    const lines = ctx.logs.filter((l) => /without a usable client address/.test(l))
    assert.equal(lines.length, 1, ctx.logs.join('\n'))
    assert.match(lines[0], /not counted\)\. Log in through the Funnel or tailnet URL, not http:\/\/127\.0\.0\.1\./)
    assert.ok(!ctx.logs.join('\n').includes(TOKEN.slice(0, 8)))
  })

  test('a public client cannot lock out a real address (the proxy appends the real client IP last)', async () => {
    const victim = '198.51.100.40'
    const attacker = '198.51.100.66'
    for (let i = 0; i < 8; i++) await loginForm(ctx, 'x', { 'X-Real-IP': victim, Forwarded: `for=${victim}` }, `${victim}, ${attacker}`)
    assert.equal((await loginForm(ctx, 'x', {}, `${victim}, ${attacker}`)).status, 429, 'the attacker is limited')
    assert.equal((await loginForm(ctx, TOKEN, {}, victim)).status, 303, 'the victim is not')
    // Without a forwarded address the attacker gets 400, not a counted try against anyone.
    assert.equal((await loginForm(ctx, 'x', { Origin: `http://127.0.0.1:${ctx.port}` })).status, 400)
  })

  test('the banner tells the owner to log in from this machine through the Funnel or tailnet URL', () => {
    const remote = { config: { bindMode: 'loopback', bindAddress: '127.0.0.1', tailscaleIp: null, dnsName: DNS, allowedHosts: new Set([DNS]) } } as unknown as RemoteAccess
    const text = remoteBannerLines(remote, 4100, true).join('\n')
    assert.match(text, new RegExp(`On this machine too, log in through https://${DNS.replace(/\./g, '\\.')}/login`))
    assert.match(text, /http:\/\/127\.0\.0\.1:4100 has no\nclient address/)
  })
})

// ─── P-05: logout-all closes open streams at once ───────────────────────────

/** Open a stream and resolve with how long after `t0()` it was closed by the server. */
function openStream(port: number, p: string, headers: Record<string, string>): Promise<{ status: number; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      res.resume()
      const closed = new Promise<number>((r) => { res.on('close', () => r(Date.now())) })
      resolve({ status: res.statusCode ?? 0, closed })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('P-05: streams of dropped sessions close at once', () => {
  for (const mode of ['public', 'remote'] as const) {
    test(`${mode}: logout-all closes /events and /api/team/events within about a second`, async () => {
      const ctx = await setup(mode)
      try {
        const cookie = String((await loginForm(ctx, TOKEN, {}, '192.0.2.50')).headers['set-cookie']).split(';')[0]
        const headers = { Host: DNS, 'X-Forwarded-For': '192.0.2.50', 'X-Forwarded-Proto': 'https', Cookie: cookie }
        const a = await openStream(ctx.port, '/events', headers)
        const b = await openStream(ctx.port, `/api/team/events?project=${ctx.pid}`, headers)
        assert.deepEqual([a.status, b.status], [200, 200])
        await new Promise((r) => setTimeout(r, 100))
        const t0 = Date.now()
        assert.equal(logoutAll(ctx.home), 1)
        const timeout = new Promise<number>((r) => setTimeout(() => r(-1), 3000))
        const [ta, tb] = await Promise.all([Promise.race([a.closed, timeout]), Promise.race([b.closed, timeout])])
        assert.ok(ta > 0 && ta - t0 < 1500, `/events closed after ${ta - t0} ms`)
        assert.ok(tb > 0 && tb - t0 < 1500, `/api/team/events closed after ${tb - t0} ms`)
      } finally {
        await teardown(ctx)
      }
    })
  }
})

// ─── P-06: protective headers on the app shell and every asset ──────────────

describe('P-06: app shell and static assets', () => {
  function capture(url: string, opts?: { frameable?: boolean }): { status: number; headers: Record<string, string>; body: string } {
    const out = { status: 0, headers: {} as Record<string, string>, body: '' }
    const res = {
      writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.headers = headers ?? {} },
      end(b?: unknown) { out.body = b === undefined ? '' : String(b) },
    }
    serveStatic({ url } as never, res as never, opts)
    return out
  }

  test('every static response has X-Frame-Options DENY, a CSP with frame-ancestors none, nosniff and a referrer policy', () => {
    for (const url of ['/', '/index.html', '/index.js', '/index.css', '/sfx-x.mp3', '/x.ogg', '/x.exe', '/nope']) {
      const h = capture(url).headers
      assert.equal(h['X-Frame-Options'], 'DENY', url)
      assert.match(h['Content-Security-Policy'], /(^|; )frame-ancestors 'none'(;|$)/, url)
      assert.match(h['Content-Security-Policy'], /^default-src 'none'; script-src 'self'; /, url)
      assert.equal(h['X-Content-Type-Options'], 'nosniff', url)
      assert.ok(['no-referrer', 'same-origin'].includes(h['Referrer-Policy']), url)
    }
    assert.equal(capture('/index.js').headers['Referrer-Policy'], 'no-referrer')
  })

  test('the CSP allows exactly the shell style by hash; no unsafe-inline, no unsafe-eval; the shell has no inline style attribute or script', () => {
    const shell = capture('/')
    const csp = shell.headers['Content-Security-Policy']
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*|https?:/)
    const style = /<style>([^<]*)<\/style>/.exec(shell.body)![1]
    const hash = crypto.createHash('sha256').update(style, 'utf-8').digest('base64')
    assert.ok(csp.includes(`style-src 'self' 'sha256-${hash}'`), csp)
    assert.doesNotMatch(shell.body, /style="/)
    assert.doesNotMatch(shell.body, /<script>[^<]/, 'no inline script')
    assert.equal(csp, appCsp(false))
    for (const d of ["img-src 'self' data:", "connect-src 'self'", "base-uri 'none'", "form-action 'self'"]) assert.ok(csp.includes(d), d)
  })

  test('cloud mode (preview pane frames the page): no X-Frame-Options and no frame-ancestors, the rest kept', () => {
    for (const url of ['/', '/index.js']) {
      const h = capture(url, { frameable: true }).headers
      assert.equal(h['X-Frame-Options'], undefined)
      assert.doesNotMatch(h['Content-Security-Policy'], /frame-ancestors/)
      assert.match(h['Content-Security-Policy'], /^default-src 'none'; script-src 'self'; /)
      assert.equal(h['X-Content-Type-Options'], 'nosniff')
    }
    assert.deepEqual(Object.keys(staticHeaders({ frameable: true })).sort(), ['Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options'])
  })
})
