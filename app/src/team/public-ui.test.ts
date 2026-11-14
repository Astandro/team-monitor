/**
 * Addendum G (public UI through Funnel, `--public-ui`), in process: flag validation (G2), service definition,
 * banner, doctor in the four combinations of --public-ui and --ingest (G1, G3), the login limiter key and forged
 * forwarded headers (G5), the login log, cookie flags behind Funnel, and logout-all against a live SessionStore (G6).
 * public-ui-e2e.test.ts runs the same against a real process (route audit G4, G5, G6).
 */
import { test, describe, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from '../args'
import { LoginLimiter, logoutAll, SessionStore } from './auth'
import { buildRegistry } from './config'
import { DoctorDeps, funnelEntries, publicUiChecks, runDoctor, runDoctorCli } from './doctor'
import { clientKey, createRequestHandler, limiterAddress, publicClientKey, RemoteAccess, TeamService } from './http'
import { checkPublicUi, PUBLIC_UI_NEEDS, PublicUiError, remoteBannerLines, setupTeam } from './index'
import { runLogoutAllCli } from './logout-all'
import type { RemoteConfig, TailscaleRunner } from './remote'
import { addProject } from './projects'
import { buildSpec, CmdRunner, installService, parseInstallArgs, programArguments, readServiceRecord } from './service'
import { listen, makeProject, makeTmpDir, removeTmpDir, request, Resp } from './test-helpers'

const TOKEN = 'ab'.repeat(32)
const DNS = 'machine.tailnet.ts.net'
const quiet = () => {}

const fakeTailscale: TailscaleRunner = (args) => {
  if (args[0] === 'ip') return '100.64.0.10\n'
  if (args[0] === 'status') return JSON.stringify({ Self: { DNSName: `${DNS}.` } })
  throw new Error('unexpected')
}

// ─── G2: --public-ui only with --remote --bind loopback ─────────────────────

describe('G2: --public-ui needs --remote --bind loopback', () => {
  test('the flag is parsed and takes no value', () => {
    const a = parseArgs(['--public-ui', '--remote', '--bind', 'loopback', '--port', '4100'])
    assert.equal(a.team.publicUi, true)
    assert.equal(a.team.remote, true)
    assert.equal(a.team.bind, 'loopback')
    assert.equal(a.port, 4100)
    assert.equal(parseArgs(['--remote']).team.publicUi, undefined, 'off by default')
  })

  test('refused with one clear line in every other combination, before a token is created', () => {
    for (const opts of [
      { publicUi: true, remote: false },
      { publicUi: true, remote: true },
      { publicUi: true, remote: true, bind: 'tailscale' },
      { publicUi: true, remote: true, bind: '127.0.0.1' },
      { publicUi: true, remote: false, bind: 'loopback' },
    ]) {
      assert.throws(() => checkPublicUi(opts), (e: Error) => e instanceof PublicUiError && e.message === PUBLIC_UI_NEEDS, JSON.stringify(opts))
    }
    assert.doesNotThrow(() => checkPublicUi({ publicUi: true, remote: true, bind: 'loopback' }))
    assert.doesNotThrow(() => checkPublicUi({ remote: false }))
    assert.ok(!PUBLIC_UI_NEEDS.includes('\n'))

    const root = makeTmpDir()
    const env = { TEAM_MONITOR_HOME: path.join(root, 'tm') }
    try {
      assert.throws(() => setupTeam({ projects: [], remote: false, hostAllow: [], publicUi: true }, { env, log: quiet, warn: quiet }), PublicUiError)
      assert.throws(() => setupTeam({ projects: [], remote: true, bind: 'tailscale', hostAllow: [], publicUi: true }, { env, runTailscale: fakeTailscale, log: quiet, warn: quiet }), PublicUiError)
      assert.equal(fs.existsSync(path.join(env.TEAM_MONITOR_HOME, 'token')), false, 'nothing created')
      const logs: string[] = []
      const ok = setupTeam({ projects: [], remote: true, bind: 'loopback', hostAllow: [], publicUi: true }, { env, runTailscale: fakeTailscale, log: (m) => logs.push(m), warn: quiet })
      assert.equal(ok.publicUi, true)
      assert.equal(ok.listenHost, '127.0.0.1')
      assert.ok(logs.some((l) => /Public UI on/.test(l)))
      ok.dispose()
    } finally {
      removeTmpDir(root)
    }
  })

  test('banner states plainly that the UI is reachable from the internet, with the Funnel command', () => {
    const remote = { config: { bindMode: 'loopback', bindAddress: '127.0.0.1', tailscaleIp: null, dnsName: DNS, allowedHosts: new Set([DNS]) } } as unknown as RemoteAccess
    const lines = remoteBannerLines(remote, 4100, true).join('\n')
    assert.match(lines, /reachable from the INTERNET/)
    assert.match(lines, /tailscale funnel --bg --https=443 http:\/\/127\.0\.0\.1:4100/)
    assert.match(lines, new RegExp(`https://${DNS.replace(/\./g, '\\.')}/login`))
    // Without --public-ui: the tailnet lines as before.
    const tailnet = remoteBannerLines(remote, 4100, false).join('\n')
    assert.doesNotMatch(tailnet, /INTERNET|funnel/)
    assert.match(tailnet, /tailscale serve --bg http:\/\/127\.0\.0\.1:4100/)
    assert.deepEqual(remoteBannerLines(null, 4100, false), [])
  })
})

// ─── Service definition ─────────────────────────────────────────────────────

describe('service install --public-ui', () => {
  let root: string
  let deps: DoctorDeps
  before(() => {
    root = makeTmpDir()
    const dist = path.join(root, 'dist')
    fs.mkdirSync(dist)
    fs.writeFileSync(path.join(dist, 'app.js'), '')
    deps = {
      env: { TEAM_MONITOR_HOME: path.join(root, 'tm') }, platform: 'linux', homedir: path.join(root, 'user'), uid: 1000,
      execPath: '/n/node', appJs: path.join(dist, 'app.js'), runTailscale: fakeTailscale, out: quiet, err: quiet,
    }
  })
  after(() => removeTmpDir(root))

  test('parsed, written into the service arguments, refused without --remote --bind loopback', () => {
    const opts = parseInstallArgs(['--remote', '--bind', 'loopback', '--public-ui', '--ingest'])
    assert.ok(typeof opts !== 'string')
    assert.equal(opts.publicUi, true)
    const { spec } = buildSpec(opts, deps)
    const args = programArguments(spec)
    assert.ok(args.includes('--public-ui') && args.includes('--ingest'))
    assert.deepEqual(args.slice(args.indexOf('--remote'), args.indexOf('--remote') + 3), ['--remote', '--bind', 'loopback'])
    for (const bad of [['--public-ui'], ['--public-ui', '--remote', '--bind', 'tailscale']]) {
      const o = parseInstallArgs(bad)
      assert.ok(typeof o !== 'string')
      assert.throws(() => buildSpec(o, deps), /--public-ui needs --remote --bind loopback/)
    }
    const plain = parseInstallArgs(['--remote', '--bind', 'loopback'])
    assert.ok(typeof plain !== 'string')
    assert.ok(!programArguments(buildSpec(plain, deps).spec).includes('--public-ui'), 'off by default')
  })
})

// ─── G1 / G3: doctor ────────────────────────────────────────────────────────

const PORT = 3802
const UI_SERVE = { '/': { Proxy: `http://127.0.0.1:${PORT}` } }
const status = (web: Record<string, unknown>, funnel: string[] = []) =>
  JSON.stringify({ Web: web, AllowFunnel: Object.fromEntries(funnel.map((k) => [k, true])) })
/** Tailnet UI on 8443 (phone), whole app on Funnel 443. */
const ROOT_FUNNEL = status({ [`${DNS}:8443`]: { Handlers: UI_SERVE }, [`${DNS}:443`]: { Handlers: UI_SERVE } }, [`${DNS}:443`])
/** Tailnet UI on 8443, only /api/ingest on Funnel 443 (the --ingest setup without --public-ui). */
const INGEST_FUNNEL = status({
  [`${DNS}:8443`]: { Handlers: UI_SERVE },
  [`${DNS}:443`]: { Handlers: { '/api/ingest': { Proxy: `http://127.0.0.1:${PORT}/api/ingest` } } },
}, [`${DNS}:443`])
/** Tailnet UI on 8443 only. */
const TAILNET_ONLY = status({ [`${DNS}:8443`]: { Handlers: UI_SERVE } })

describe('doctor with --public-ui and --ingest (four combinations)', () => {
  let root: string
  let home: string
  let deps: DoctorDeps
  const serve = { json: TAILNET_ONLY }

  async function install(flags: { ingest?: boolean; publicUi?: boolean }): Promise<void> {
    await installService({ port: PORT, remote: true, bind: 'loopback', hostAllow: [], ...flags }, deps)
  }
  const funnelChecks = async (d: DoctorDeps = deps) =>
    (await runDoctor(d)).filter((c) => /funnel|ingest token/.test(c.what) || /funnel/.test(c.fix ?? ''))

  before(async () => {
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
      runTailscale: (args) => args[0] === 'serve' ? serve.json : JSON.stringify({ Self: { DNSName: `${DNS}.` } }),
      probe: { portOpen: async () => true, health: async () => ({ ok: true, status: 200, projects: 1 }) },
      settingsFile: path.join(root, 'none.json'), out: quiet, err: quiet,
    }
  })
  after(() => removeTmpDir(root))

  test('funnelEntries marks a root mapping of the monitor', () => {
    const e = funnelEntries(ROOT_FUNNEL, PORT)
    assert.deepEqual(e.map((x) => [x.hostPort, x.funnel, x.root]), [[`${DNS}:8443`, false, true], [`${DNS}:443`, true, true]])
    assert.equal(funnelEntries(INGEST_FUNNEL, PORT)[1].root, false)
    assert.equal(funnelEntries(status({ 'h:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}/x` } } } }, ['h:443']), PORT)[0].root, false)
  })

  test('neither flag: Funnel is checked too (P-02); any path of the monitor on Funnel fails with the off command', async () => {
    await install({})
    serve.json = TAILNET_ONLY
    assert.deepEqual((await funnelChecks()).map((c) => [c.level, c.what]), [['ok', `no tailscale funnel mapping reaches 127.0.0.1:${PORT} (not public)`]])
    serve.json = ROOT_FUNNEL
    let f = await funnelChecks()
    assert.deepEqual(f.map((c) => c.level), ['fail'])
    assert.match(f[0].what, /reachable from the internet: tailscale funnel makes \/ on machine\.tailnet\.ts\.net:443 public/)
    assert.equal(f[0].fix, 'turn that Funnel mapping off: tailscale funnel --https=443 off')
    serve.json = INGEST_FUNNEL
    f = await funnelChecks()
    assert.deepEqual(f.map((c) => c.level), ['fail'])
    assert.match(f[0].what, /makes \/api\/ingest on machine\.tailnet\.ts\.net:443 public/)
    assert.equal(f[0].fix, 'turn that Funnel mapping off: tailscale funnel --https=443 --set-path /api/ingest off')
    assert.equal(readServiceRecord(home)?.publicUi, undefined)
  })

  test('--ingest only: unchanged; a public UI is still a failure', async () => {
    await install({ ingest: true })
    serve.json = INGEST_FUNNEL
    assert.deepEqual((await funnelChecks()).map((c) => c.level), ['ok', 'ok'])
    serve.json = ROOT_FUNNEL
    const f = await funnelChecks()
    assert.ok(f.some((c) => c.level === 'fail' && /no tailscale funnel mapping for \/api\/ingest/.test(c.what)))
    assert.ok(f.some((c) => c.level === 'fail' && /makes \/ on .*:443 public/.test(c.what)), 'the UI on Funnel fails as before')
  })

  test('--public-ui only: passes with a root Funnel mapping next to the tailnet one; fails with the exact command when missing', async () => {
    await install({ publicUi: true })
    assert.equal(readServiceRecord(home)?.publicUi, true)
    serve.json = ROOT_FUNNEL
    const ok = await funnelChecks()
    assert.deepEqual(ok.map((c) => c.level), ['ok'])
    assert.match(ok[0].what, /whole app on machine\.tailnet\.ts\.net:443 \(public UI/)
    assert.ok(!(await runDoctor(deps)).some((c) => c.level === 'fail' && /serve|funnel|public/.test(c.what)), 'the tailnet mapping on 8443 is not flagged')

    for (const json of [TAILNET_ONLY, INGEST_FUNNEL, '{}']) {
      serve.json = json
      const f = await funnelChecks()
      assert.equal(f.length, 1, json)
      assert.equal(f[0].level, 'fail')
      assert.equal(f[0].fix, `tailscale funnel --bg --https=443 http://127.0.0.1:${PORT}`)
    }
    const out: string[] = []
    serve.json = TAILNET_ONLY
    assert.equal(await runDoctorCli([], { ...deps, out: (m) => out.push(m) }), 1)
    assert.ok(out.includes(`      fix: tailscale funnel --bg --https=443 http://127.0.0.1:${PORT}`), out.join('\n'))
    // The tailnet UI on 443 instead: doctor suggests another Funnel port.
    assert.equal((await publicUiChecks(PORT, 443, 'tailscale', () => '{}', false))[0].fix, `tailscale funnel --bg --https=8443 http://127.0.0.1:${PORT}`)
    assert.match(publicUiChecks(PORT, 8443, 'tailscale', () => { throw new Error('down') }, false)[0].what, /cannot read tailscale serve status/)
  })

  test('--public-ui and --ingest: the root mapping also serves /api/ingest; no second (--set-path) mapping is asked for', async () => {
    await install({ publicUi: true, ingest: true })
    serve.json = ROOT_FUNNEL
    const ok = await funnelChecks()
    assert.deepEqual(ok.map((c) => [c.level, /ingest token file is 600/.test(c.what) || /also serves \/api\/ingest/.test(c.what)]), [['ok', true], ['ok', true]])
    // An older /api/ingest mapping on the same Funnel port is fine too.
    serve.json = status({ [`${DNS}:443`]: { Handlers: { ...UI_SERVE, '/api/ingest': { Proxy: `http://127.0.0.1:${PORT}/api/ingest` } } } }, [`${DNS}:443`])
    assert.deepEqual((await funnelChecks()).map((c) => c.level), ['ok', 'ok'])
    // Only the ingest mapping: the one failure is the root mapping, with its command (not the --set-path one).
    serve.json = INGEST_FUNNEL
    const f = await funnelChecks()
    assert.deepEqual(f.map((c) => c.level), ['ok', 'fail'])
    assert.equal(f[1].fix, `tailscale funnel --bg --https=443 http://127.0.0.1:${PORT}`)
    // Token file still checked.
    fs.chmodSync(path.join(home, 'ingest-token'), 0o644)
    serve.json = ROOT_FUNNEL
    assert.ok((await funnelChecks()).some((c) => c.level === 'fail' && /ingest token file is 644/.test(c.what)))
    fs.chmodSync(path.join(home, 'ingest-token'), 0o600)
  })

  test('doctor --public-ui / --ingest without a service record', async () => {
    fs.unlinkSync(path.join(home, 'service.json'))
    serve.json = status({ [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4555' } } } }, [`${DNS}:443`])
    const pub = await funnelChecks({ ...deps, publicUi: true, port: 4555 })
    assert.deepEqual(pub.map((c) => c.level), ['ok'])
    const both = await funnelChecks({ ...deps, publicUi: true, ingest: true, port: 4555 })
    assert.deepEqual(both.map((c) => c.level), ['ok', 'ok'])
    assert.equal(await runDoctorCli(['--public-ui', '--bad'], { ...deps, err: quiet }), 2)
  })
})

// ─── G5: limiter key behind Funnel ──────────────────────────────────────────

function fakeReq(remoteAddress: string, headers: Record<string, string>) {
  return { socket: { remoteAddress }, headers } as unknown as import('http').IncomingMessage
}

describe('G5: login limiter key behind Funnel', () => {
  test('limiterAddress: IPv4, mapped IPv4, IPv6 by /64, ports and brackets; junk is null', () => {
    assert.equal(limiterAddress('203.0.113.7'), '203.0.113.7')
    assert.equal(limiterAddress(' 203.0.113.7:4431 '), '203.0.113.7')
    assert.equal(limiterAddress('::ffff:203.0.113.7'), '203.0.113.7')
    assert.equal(limiterAddress('::ffff:cb00:7107'), '203.0.113.7')
    assert.equal(limiterAddress('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64')
    assert.equal(limiterAddress('[2001:db8:1:2:ffff:ffff:ffff:ffff]:443'), '2001:db8:1:2::/64')
    assert.equal(limiterAddress('2001:DB8:0:0::5'), '2001:db8:0:0::/64')
    assert.equal(limiterAddress('fe80::1%eth0'), 'fe80:0:0:0::/64')
    for (const junk of ['', 'unknown', '203.0.113.700', 'evil.example', '1.2.3', '2001:db8::1::2', 'for=1.2.3.4']) {
      assert.equal(limiterAddress(junk), null, junk)
    }
  })

  test('publicClientKey trusts only the last X-Forwarded-For entry on a loopback socket', () => {
    const k = (h: Record<string, string>, addr = '127.0.0.1') => publicClientKey(fakeReq(addr, h))
    assert.equal(k({ 'x-forwarded-for': '203.0.113.7' }), 'fwd:203.0.113.7')
    // What a client sends itself comes before the entry the proxy adds; other headers are ignored.
    assert.equal(k({
      'x-forwarded-for': '198.51.100.1, 192.0.2.9, 203.0.113.7',
      forwarded: 'for=198.51.100.1', 'x-real-ip': '198.51.100.1', 'tailscale-user-login': 'x', 'tailscale-client-ip': '198.51.100.1',
      'true-client-ip': '198.51.100.1', 'cf-connecting-ip': '198.51.100.1',
    }), 'fwd:203.0.113.7')
    // P-04: no usable client address is null (refused, counted under no key), never a shared key.
    assert.equal(k({ forwarded: 'for=198.51.100.1', 'x-real-ip': '198.51.100.1' }), null, 'no X-Forwarded-For: no client address')
    assert.equal(k({ 'x-forwarded-for': '2001:db8:5:6::1' }), 'fwd:2001:db8:5:6::/64')
    assert.equal(k({ 'x-forwarded-for': '2001:db8:5:6:ffff::9' }), 'fwd:2001:db8:5:6::/64', 'same /64, same key')
    assert.equal(k({ 'x-forwarded-for': '198.51.100.1, not-an-ip' }), null, 'junk last entry never falls back to an earlier one')
    assert.equal(k({ 'x-forwarded-for': ' , ' }), null)
    assert.equal(k({ 'x-forwarded-for': '203.0.113.7' }, '100.64.0.20'), 'ip:100.64.0.20', 'not behind a loopback proxy: the socket')
    // Remote mode without --public-ui keeps the old key.
    assert.equal(clientKey(fakeReq('127.0.0.1', { 'x-forwarded-for': '198.51.100.1, 203.0.113.7' })), 'fwd:203.0.113.7')
  })
})

// ─── Handler with --public-ui: limiter, login log, cookie, logout-all ───────

interface Ctx { root: string; port: number; close: () => Promise<void>; team: TeamService; remote: RemoteAccess; logs: string[]; home: string }

async function setup(publicUi: boolean): Promise<Ctx> {
  const root = makeTmpDir()
  const home = path.join(root, 'tm')
  fs.mkdirSync(home, { mode: 0o700 })
  const project = makeProject(root, 'Proyek Satu')
  const team = new TeamService(buildRegistry([], [project]), { debounceMs: 10, pollMs: 60_000, log: quiet })
  const config: RemoteConfig = { bindMode: 'loopback', bindAddress: '127.0.0.1', tailscaleIp: null, dnsName: DNS, allowedHosts: new Set([DNS]) }
  const remote: RemoteAccess = { config, token: TOKEN, sessions: new SessionStore(home, TOKEN), limiter: new LoginLimiter() }
  const logs: string[] = []
  const handler = createRequestHandler({
    team, remote, publicUi, log: (m) => logs.push(m),
    fallback: (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ui') },
  })
  const { port, close } = await listen(handler)
  return { root, port, close, team, remote, logs, home }
}

async function teardown(ctx: Ctx) {
  ctx.team.dispose()
  await ctx.close()
  removeTmpDir(ctx.root)
}

/** A request as Funnel's proxy delivers it: public Host, forwarded headers, loopback socket. */
function funnel(ctx: Ctx, opts: { method?: string; path: string; xff: string; headers?: Record<string, string>; body?: string }): Promise<Resp> {
  return request(ctx.port, {
    method: opts.method, path: opts.path, body: opts.body,
    headers: {
      Host: DNS, 'X-Forwarded-For': opts.xff, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': DNS,
      'Tailscale-Funnel-Request': '?1', ...opts.headers,
    },
  })
}

function loginWith(ctx: Ctx, xff: string, token: string, headers: Record<string, string> = {}): Promise<Resp> {
  return funnel(ctx, {
    method: 'POST', path: '/login', xff, body: `token=${token}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `https://${DNS}`, 'Sec-Fetch-Site': 'same-origin', ...headers },
  })
}

describe('G5 and login log: --public-ui handler', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(true) })
  after(async () => { await teardown(ctx) })

  test('six wrong tokens from one forwarded address are limited; another address is not; forged headers change nothing', async () => {
    const victim = '203.0.113.20'
    const attacker = '203.0.113.66'
    // The attacker forges every forwarded header with the victim's address; the proxy's entry comes last.
    const forged = { Forwarded: `for=${victim}`, 'X-Real-IP': victim, 'Tailscale-Client-IP': victim, 'True-Client-IP': victim }
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await loginWith(ctx, `${victim}, ${attacker}`, 'f'.repeat(64), forged)).status)
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429])
    // The victim is not locked out: wrong token still 401 (not 429), the right token logs in.
    assert.equal((await loginWith(ctx, victim, 'wrong')).status, 401)
    const ok = await loginWith(ctx, victim, TOKEN)
    assert.equal(ok.status, 303)
    // The attacker cannot get out by changing the forwarded headers it controls.
    assert.equal((await loginWith(ctx, `198.51.100.99, ${attacker}`, TOKEN, { 'X-Real-IP': '198.51.100.99' })).status, 429, 'still counted under the proxy entry, even with the right token')
    // IPv6: rotating inside the same /64 stays limited.
    for (let i = 1; i <= 5; i++) assert.equal((await loginWith(ctx, `2001:db8:7:7::${i}`, 'x')).status, 401)
    assert.equal((await loginWith(ctx, '2001:db8:7:7:abcd::99', 'x')).status, 429)
    assert.equal((await loginWith(ctx, '2001:db8:7:8::1', 'x')).status, 401, 'another /64 is another client')
  })

  test('login log: one line per kind and client per minute, the counted address, never the token', async () => {
    const all = ctx.logs.join('\n')
    assert.ok(ctx.logs.some((l) => /^\[login\] failed login from fwd:203\.0\.113\.66 /.test(l)), all)
    assert.ok(ctx.logs.some((l) => /^\[login\] refused for fwd:203\.0\.113\.66: too many failed logins/.test(l)), all)
    assert.ok(ctx.logs.some((l) => l === '[login] successful login from fwd:203.0.113.20'), all)
    assert.ok(ctx.logs.some((l) => /fwd:2001:db8:7:7::\/64/.test(l)), all)
    assert.ok(!ctx.logs.some((l) => /198\.51\.100\.99|203\.0\.113\.20, /.test(l)), 'forged entries never logged as the client')
    assert.equal(ctx.logs.filter((l) => l.includes('failed login from fwd:203.0.113.66')).length, 1, 'rate-limited: one line per minute')
    for (const secret of [TOKEN, TOKEN.slice(0, 8), 'f'.repeat(16)]) assert.ok(!all.includes(secret), 'no token or part of it')
  })

  test('session cookie is Secure, HttpOnly, SameSite=Strict behind Funnel', async () => {
    const r = await loginWith(ctx, '192.0.2.44', TOKEN)
    assert.equal(r.status, 303)
    const c = String(r.headers['set-cookie'])
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) assert.ok(c.includes(flag), c)
  })
})

describe('G1: remote mode without --public-ui logs no logins and keys as before', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(false) })
  after(async () => { await teardown(ctx) })

  test('no login lines; limiter on the old key', async () => {
    for (let i = 0; i < 5; i++) await loginWith(ctx, '203.0.113.5', 'x')
    assert.equal((await loginWith(ctx, '203.0.113.5', 'x')).status, 429)
    assert.equal((await loginWith(ctx, '203.0.113.6', TOKEN)).status, 303)
    assert.deepEqual(ctx.logs.filter((l) => l.startsWith('[login]')), [])
  })
})

// ─── G6: logout-all ─────────────────────────────────────────────────────────

describe('G6: logout-all', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(true) })
  after(async () => { await teardown(ctx) })

  test('a running store drops every session at the next request; the next request goes to the login', async () => {
    const cookies: string[] = []
    for (const ip of ['192.0.2.1', '192.0.2.2']) {
      const r = await loginWith(ctx, ip, TOKEN)
      cookies.push(String(r.headers['set-cookie']).split(';')[0])
    }
    for (const c of cookies) assert.equal((await funnel(ctx, { path: '/api/team/projects', xff: '192.0.2.1', headers: { Cookie: c } })).status, 200)

    const out: string[] = []
    assert.equal(await runLogoutAllCli([], { env: { TEAM_MONITOR_HOME: ctx.home }, out: (m) => out.push(m) }), 0)
    assert.match(out[0], /Ended 2 login session\(s\)/)
    for (const c of cookies) {
      const page = await funnel(ctx, { path: '/', xff: '192.0.2.1', headers: { Cookie: c, Accept: 'text/html' } })
      assert.equal(page.status, 302)
      assert.equal(page.headers.location, '/login')
      assert.equal((await funnel(ctx, { path: '/api/team/projects', xff: '192.0.2.1', headers: { Cookie: c } })).status, 401)
    }
    // Logging in again works and survives (the store rewrote nothing it should not).
    const again = String((await loginWith(ctx, '192.0.2.3', TOKEN)).headers['set-cookie']).split(';')[0]
    assert.equal((await funnel(ctx, { path: '/api/team/projects', xff: '192.0.2.3', headers: { Cookie: again } })).status, 200)
    // A restart (new store on the same file) keeps the new session and not the old ones.
    const restarted = new SessionStore(ctx.home, TOKEN)
    assert.equal(restarted.isValid(again.split('=')[1]), true)
    assert.equal(restarted.isValid(cookies[0].split('=')[1]), false)
    assert.equal(restarted.droppedForNewToken, 0, 'token binding kept: no "token changed" at the next start')
  })

  test('stopped monitor, no file, usage', async () => {
    const root = makeTmpDir()
    try {
      const store = new SessionStore(root, TOKEN)
      const id = store.create()
      assert.equal(logoutAll(root), 1)
      assert.equal(new SessionStore(root, TOKEN).isValid(id), false, 'a monitor started later has none')
      assert.equal(fs.statSync(path.join(root, 'sessions.json')).mode & 0o077, 0)
      const empty = makeTmpDir()
      try {
        const out: string[] = []
        assert.equal(await runLogoutAllCli([], { env: { TEAM_MONITOR_HOME: empty }, out: (m) => out.push(m) }), 0)
        assert.match(out[0], /No login sessions stored/)
      } finally {
        removeTmpDir(empty)
      }
      assert.equal(await runLogoutAllCli(['x'], { env: { TEAM_MONITOR_HOME: root }, err: quiet }), 2)
    } finally {
      removeTmpDir(root)
    }
  })

  test('a sessions file removed or garbled under a running store ends every session (fail closed)', () => {
    const root = makeTmpDir()
    try {
      const store = new SessionStore(root, TOKEN)
      const a = store.create()
      fs.unlinkSync(path.join(root, 'sessions.json'))
      assert.equal(store.isValid(a), false)
      const b = store.create()
      assert.equal(store.isValid(b), true)
      fs.writeFileSync(path.join(root, 'sessions.json'), '{garbled')
      assert.equal(store.isValid(b), false)
      const c = store.create()
      assert.equal(new SessionStore(root, TOKEN).isValid(c), true, 'rewritten bound to the token')
    } finally {
      removeTmpDir(root)
    }
  })
})
