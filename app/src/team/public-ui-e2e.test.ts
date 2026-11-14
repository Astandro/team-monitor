/**
 * Addendum G end to end, against a real monitor process (esbuild bundle in a temp dir, fake HOME and team home, fake
 * `tailscale` CLI, a free port) started with `--remote --bind loopback --public-ui --ingest`. Every request is made
 * the way Funnel's local proxy delivers it: loopback socket, the public Host, X-Forwarded-For/-Proto/-Host.
 *
 * - G2: `--public-ui` without `--remote --bind loopback` exits 1 with one line, creates no token, listens nowhere.
 * - G4: route audit. Without a session, every route and static path (UI, assets, icons, sounds, manifest,
 *   /events, every /api/team route, unknown paths, paths that would echo input) answers only 302 to /login or 401
 *   `login required`, for every method, with no data; only /login (GET, POST), /logout and the three ingest routes
 *   answer otherwise, and those with no data either. After login: UI, assets, /events, answers and chat work.
 * - G5: six wrong tokens from one forwarded address are limited, another address is not, forged forwarded headers
 *   do not move the count; the log has one line per kind and client and never the token.
 * - G6: `logout-all` (a second process) ends the sessions of the running monitor; the next request goes to the login.
 */
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { ChildProcess, spawn } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as path from 'path'
import { encodeProjectPath } from '../../../scripts/session-projects'
import { buildAppBundle, makeProject, makeTmpDir, removeTmpDir, request, Resp, sampleState, waitFor } from './test-helpers'

const REPO = path.resolve(__dirname, '..', '..', '..')
const SESSION = 'e2e00000-0000-4000-8000-0000000a0d17'
const DNS = 'machine.tailnet.ts.net'
const MARKER = 'PUBLIC-UI-AUDIT-MARKER'
const linux = process.platform === 'linux' && fs.existsSync('/proc/self/cmdline')

const root = makeTmpDir()
const DIST = path.join(root, 'dist')
const APP = buildAppBundle(DIST)
// A webview next to the bundle, as app/build.js makes it, so static assets and sounds really exist.
fs.mkdirSync(path.join(DIST, 'webview'))
fs.writeFileSync(path.join(DIST, 'webview', 'index.js'), `/* ${MARKER} js */`)
fs.writeFileSync(path.join(DIST, 'webview', 'index.css'), `/* ${MARKER} css */`)
fs.writeFileSync(path.join(DIST, 'webview', 'chime.ogg'), `${MARKER} ogg`)
fs.writeFileSync(path.join(DIST, 'webview', 'chime.mp3'), `${MARKER} mp3`)

const BIN = path.join(root, 'bin')
fs.mkdirSync(BIN)
const TAILSCALE = path.join(BIN, 'tailscale')
fs.writeFileSync(TAILSCALE, [
  '#!/bin/sh',
  'case "$1" in',
  '  ip) echo 100.64.0.10 ;;',
  `  status) echo '{"Self":{"DNSName":"${DNS}."}}' ;;`,
  '  serve) if [ -n "$FAKE_SERVE_STATUS" ]; then cat "$FAKE_SERVE_STATUS"; else exit 1; fi ;;',
  '  *) exit 1 ;;',
  'esac',
  '',
].join('\n'), { mode: 0o755 })

const started: ChildProcess[] = []
after(() => {
  for (const c of started) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  removeTmpDir(root)
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => (p === 3002 ? freePort().then(resolve, reject) : resolve(p)))
    })
    s.on('error', reject)
  })
}

function env(name: string): NodeJS.ProcessEnv {
  const home = path.join(root, name, 'home')
  fs.mkdirSync(home, { recursive: true })
  return { PATH: `${BIN}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, TEAM_MONITOR_HOME: path.join(root, name, 'tm') }
}

function run(args: string[], e: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [APP, ...args], { env: e, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', (d: Buffer) => { out += d })
    c.stderr.on('data', (d: Buffer) => { err += d })
    const t = setTimeout(() => c.kill('SIGKILL'), 30_000)
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }) })
  })
}

/** Pids of processes whose command line has all of `marks` (Linux /proc). */
function pidsWith(marks: string[]): number[] {
  const out: number[] = []
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const args = fs.readFileSync(`/proc/${d}/cmdline`, 'utf-8').split('\0')
      if (marks.every((m) => args.includes(m))) out.push(Number(d))
    } catch { /* gone */ }
  }
  return out
}

/** A request as Funnel's local proxy delivers it. */
function funnel(port: number, opts: { method?: string; path: string; xff?: string; headers?: Record<string, string>; body?: string }): Promise<Resp> {
  return request(port, {
    method: opts.method, path: opts.path, body: opts.body,
    headers: {
      Host: DNS, 'X-Forwarded-For': opts.xff ?? '203.0.113.200', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': DNS,
      'Tailscale-Funnel-Request': '?1', ...opts.headers,
    },
  })
}

const SAME_ORIGIN = { Origin: `https://${DNS}`, 'Sec-Fetch-Site': 'same-origin' }

function login(port: number, token: string, xff: string, headers: Record<string, string> = {}): Promise<Resp> {
  return funnel(port, {
    method: 'POST', path: '/login', xff, body: new URLSearchParams({ token }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...SAME_ORIGIN, ...headers },
  })
}

/** Status, content type and text of a streaming response read for `ms` (then dropped). */
function stream(port: number, p: string, headers: Record<string, string>, ms = 1000): Promise<{ status: number; type: string; text: string }> {
  return new Promise((resolve) => {
    let status = 0
    let type = ''
    let text = ''
    const req = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      status = res.statusCode ?? 0
      type = String(res.headers['content-type'] ?? '')
      res.setEncoding('utf-8')
      res.on('data', (c: string) => { text += c })
    })
    req.on('error', () => { /* dropped below */ })
    req.end()
    setTimeout(() => { req.destroy(); resolve({ status, type, text }) }, ms)
  })
}

test('G2: --public-ui without --remote --bind loopback refuses to start with one line', { skip: !linux && 'needs Linux /proc' }, async () => {
  const port = await freePort()
  for (const extra of [[], ['--remote', '--bind', 'tailscale'], ['--remote']]) {
    const e = env(`refuse-${extra.length}`)
    const r = await run(['--public-ui', ...extra, '--no-open', '--port', String(port), '--tailscale-bin', TAILSCALE], e)
    assert.equal(r.code, 1, r.err)
    const lines = r.err.trim().split('\n')
    assert.equal(lines.length, 1, r.err)
    assert.equal(lines[0], 'Cannot start: --public-ui needs --remote --bind loopback (the monitor behind Tailscale Funnel on 127.0.0.1); not started.')
    assert.equal(fs.existsSync(path.join(e.TEAM_MONITOR_HOME!, 'token')), false)
    assert.equal(fs.existsSync(path.join(e.HOME!, '.claude', 'settings.json')), false, 'no hooks written either')
  }
  assert.deepEqual(pidsWith(['--port', String(port)]), [])
})

test('G4, G5, G6 against a running --remote --bind loopback --public-ui --ingest monitor', { skip: !linux && 'needs Linux /proc' }, async () => {
  const port = await freePort()
  const e = env('hub')
  const projectsRoot = path.join(root, 'projects')
  fs.mkdirSync(projectsRoot)
  const project = makeProject(projectsRoot, 'audit-proj', sampleState({ meta: { title: MARKER, status: 'running', updatedAt: '2026-11-14T00:00:00.000Z' } }))
  const PID = 'audit-proj'
  // A Claude session of that project, so /events has data to (not) give away.
  const tdir = path.join(e.HOME!, '.claude', 'projects', encodeProjectPath(project))
  fs.mkdirSync(tdir, { recursive: true })
  const line = (o: unknown) => JSON.stringify(o) + '\n'
  fs.writeFileSync(path.join(tdir, `${SESSION}.jsonl`), line({ type: 'user', uuid: 'u0', timestamp: new Date().toISOString(), message: { role: 'user', content: `Bangun ${MARKER}` } }) +
    line({ type: 'assistant', uuid: 'a1', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }] } }))
  let out = ''
  let err = ''
  const hub = spawn(process.execPath, [
    APP, '--remote', '--bind', 'loopback', '--public-ui', '--ingest', '--no-open', '--port', String(port),
    '--project', project, '--tailscale-bin', TAILSCALE,
  ], { env: e, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  started.push(hub)
  hub.stdout!.on('data', (d: Buffer) => { out += d })
  hub.stderr!.on('data', (d: Buffer) => { err += d })
  try {
    await waitFor(() => out.includes('Waiting for agent events'), 20_000, 50)
    const token = fs.readFileSync(path.join(e.TEAM_MONITOR_HOME!, 'token'), 'utf-8').trim()
    const ingestToken = fs.readFileSync(path.join(e.TEAM_MONITOR_HOME!, 'ingest-token'), 'utf-8').trim()

    // Banner: says plainly that the UI is public, gives the Funnel command.
    assert.match(out, /PUBLIC UI: this monitor is meant to be reachable from the INTERNET/)
    assert.ok(out.includes(`tailscale funnel --bg --https=443 http://127.0.0.1:${port}`), out)

    // The session is on the graph stream before the audit. With --public-ui there is no local exception (P-01): a
    // request from this machine needs a session too, so this one logs in first (another address than the audit's).
    const pre = String((await login(port, token, '192.0.2.9')).headers['set-cookie']).split(';')[0]
    assert.equal((await stream(port, '/events', { Host: `127.0.0.1:${port}` }, 300)).status, 401, 'no login-free local request')
    const local = { Host: `127.0.0.1:${port}`, Cookie: pre }
    let seen = ''
    for (let i = 0; i < 20 && !seen.includes(SESSION); i++) seen = (await stream(port, '/events', local, 1000)).text
    assert.ok(seen.includes(MARKER), 'the relay picked up the session')

    // ── G4: unauthenticated surface ──
    const LOGIN_REQUIRED = '{"ok":false,"error":"login required"}'
    const gated = [
      '/', '/index.html', '/index.js', '/index.css', '/chime.ogg', '/chime.mp3', '/favicon.ico', '/apple-touch-icon.png',
      '/manifest.json', '/manifest.webmanifest', '/site.webmanifest', '/robots.txt', '/sw.js', '/index.js?v=2',
      '/events', '/events?x=1', '/api/team/projects', `/api/team/state?project=${PID}`, `/api/team/events?project=${PID}`,
      '/api/team/offboarded', `/api/team/offboarded?project=${PID}`, '/api/team/answer', '/api/team/message',
      '/api/team/offboard', '/api/team/offboard-all', '/api/team/nope', '/api', '/api/', '/nope', '/LOGIN', '/login/',
      '/logout/', '/Login', '//api/team/projects', '/%3Cscript%3Ealert(1)%3C%2Fscript%3E', '/<b>echo</b>',
      `/${MARKER}`, '/api/team/projects?project=<i>x</i>',
    ]
    const audit: Array<{ method: string; path: string; status: number; body: string }> = []
    for (const p of gated) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
        for (const accept of ['*/*', 'text/html,application/xhtml+xml']) {
          const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? JSON.stringify({ project: PID, id: 'D1', answer: 'x', text: 'x' }) : undefined
          const r = await funnel(port, { method, path: p, body, headers: { Accept: accept, 'Content-Type': 'application/json', 'X-Team-Monitor': '1', ...SAME_ORIGIN } })
          audit.push({ method, path: p, status: r.status, body: r.body })
          const page = (method === 'GET' || method === 'HEAD') && accept.startsWith('text/html')
          if (r.status === 400) {
            // Only paths the ingest guard refuses (encoded slash): a fixed message, nothing else.
            assert.equal(r.body, method === 'HEAD' ? '' : '{"ok":false,"error":"bad request path"}', `${method} ${p}`)
            continue
          }
          if (page) {
            assert.equal(r.status, 302, `${method} ${p} ${accept}`)
            assert.equal(r.headers.location, '/login')
            assert.equal(r.body, '')
          } else {
            assert.equal(r.status, 401, `${method} ${p} ${accept}: ${r.body.slice(0, 80)}`)
            assert.equal(r.body, method === 'HEAD' ? '' : LOGIN_REQUIRED, `${method} ${p}`)
          }
        }
      }
    }
    // A request that only pretends to be local (loopback Host, but forwarded) still needs the login.
    assert.equal((await funnel(port, { path: '/api/team/projects', headers: { Host: `127.0.0.1:${port}` } })).status, 401)
    assert.equal((await funnel(port, { path: '/api/team/projects', headers: { Host: `localhost:${port}`, 'X-Forwarded-For': '127.0.0.1' } })).status, 401)
    // A foreign Host: 403, plain.
    const foreign = await funnel(port, { path: '/login', headers: { Host: 'evil.example' } })
    assert.deepEqual([foreign.status, foreign.body], [403, 'Forbidden'])

    // The routes that do answer without a session, and what they answer.
    const loginPage = await funnel(port, { path: '/login?next=<script>' })
    assert.equal(loginPage.status, 200)
    assert.match(loginPage.body, /<form method="post" action="\/login">/)
    assert.doesNotMatch(loginPage.body, /<script>/, 'the query is not echoed')
    assert.match(String(loginPage.headers['content-security-policy']), /default-src 'none'/)
    assert.equal(loginPage.headers['x-frame-options'], 'DENY')
    assert.equal((await funnel(port, { method: 'HEAD', path: '/login' })).body, '')
    const badLogin = await login(port, `wrong-${MARKER}`, '198.51.100.250')
    assert.equal(badLogin.status, 401)
    assert.doesNotMatch(badLogin.body, new RegExp(MARKER), 'the sent token is not echoed')
    assert.deepEqual([(await funnel(port, { method: 'PUT', path: '/login' })).status], [405])
    assert.deepEqual([(await funnel(port, { path: '/logout' })).status], [405])
    const logout = await funnel(port, { method: 'POST', path: '/logout', headers: SAME_ORIGIN })
    assert.deepEqual([logout.status, logout.headers.location, logout.body], [303, '/login', ''])
    for (const [method, p] of [['POST', '/api/ingest/v1/events'], ['PUT', '/api/ingest/v1/state'], ['GET', '/api/ingest/v1/outbox?sourceId=box-1']]) {
      const r = await funnel(port, { method, path: p, body: method === 'GET' ? undefined : '{}', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })
      assert.equal(r.status, 401, `${p}: the login token does not open ingest`)
      assert.match(r.body, /^\{"ok":false,"error":"[^"]{1,80}"\}$/)
    }
    const other = await funnel(port, { path: '/api/ingest/v2/x', headers: { Authorization: `Bearer ${ingestToken}` } })
    assert.deepEqual([other.status, other.body], [400, '{"ok":false,"error":"not an ingest route"}'])
    const sneaky = await funnel(port, { path: '/x/../api/team/projects' })
    assert.deepEqual([sneaky.status, sneaky.body], [400, '{"ok":false,"error":"bad request path"}'])
    for (const a of audit) assert.ok(!a.body.includes(MARKER) && !a.body.includes(PID), `${a.method} ${a.path} leaked data`)

    // ── G4: after login, full access ──
    const ok = await login(port, token, '192.0.2.10')
    assert.equal(ok.status, 303)
    const setCookie = String(ok.headers['set-cookie'])
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(setCookie.includes(flag), setCookie)
    const cookie = setCookie.split(';')[0]
    const authed = (o: { method?: string; path: string; body?: string; headers?: Record<string, string> }) =>
      funnel(port, { ...o, xff: '192.0.2.10', headers: { Cookie: cookie, ...o.headers } })
    const ui = await authed({ path: '/', headers: { Accept: 'text/html' } })
    assert.equal(ui.status, 200)
    assert.match(ui.body, /<div id="root"/)
    for (const asset of ['/index.js', '/index.css', '/chime.ogg', '/chime.mp3']) {
      const r = await authed({ path: asset })
      assert.equal(r.status, 200, asset)
      assert.ok(r.body.includes(MARKER), asset)
    }
    const projects = JSON.parse((await authed({ path: '/api/team/projects' })).body).projects as Array<{ id: string }>
    assert.ok(projects.some((p) => p.id === PID))
    assert.equal(JSON.parse((await authed({ path: `/api/team/state?project=${PID}` })).body).state.meta.title, MARKER)
    const fwdHeaders = { Host: DNS, 'X-Forwarded-For': '192.0.2.10', 'X-Forwarded-Proto': 'https', Cookie: cookie }
    let ev = await stream(port, '/events', fwdHeaders)
    for (let i = 0; i < 10 && !ev.text.includes(SESSION); i++) ev = await stream(port, '/events', fwdHeaders)
    assert.deepEqual([ev.status, ev.type], [200, 'text/event-stream'])
    assert.ok(ev.text.includes(SESSION) && ev.text.includes(MARKER), 'the graph stream carries the session')
    const tev = await stream(port, `/api/team/events?project=${PID}`, fwdHeaders, 500)
    assert.equal(tev.status, 200)
    assert.ok(tev.text.includes(MARKER), 'the team stream carries the state')
    // Without the cookie the same streams give nothing.
    const { Cookie: _c, ...noCookie } = fwdHeaders
    for (const p of ['/events', `/api/team/events?project=${PID}`]) {
      const r = await stream(port, p, noCookie, 500)
      assert.equal(r.status, 401)
      assert.ok(!r.text.includes(MARKER) && !r.text.includes(SESSION))
    }
    const write = { 'Content-Type': 'application/json', 'X-Team-Monitor': '1', ...SAME_ORIGIN }
    const ans = await authed({ method: 'POST', path: '/api/team/answer', headers: write, body: JSON.stringify({ project: PID, id: 'D1', answer: 'a' }) })
    assert.equal(ans.status, 200, ans.body)
    assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.agent-team', 'answers', 'D1.json'), 'utf-8')).answer, 'a')
    const msg = await authed({ method: 'POST', path: '/api/team/message', headers: write, body: JSON.stringify({ project: PID, text: 'halo dari luar' }) })
    assert.equal(msg.status, 200, msg.body)
    assert.equal(fs.readdirSync(path.join(project, '.agent-team', 'inbox')).length, 1)
    // CSRF stays: a cross-site write with the cookie is refused.
    const csrf = await authed({ method: 'POST', path: '/api/team/message', headers: { ...write, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ project: PID, text: 'x' }) })
    assert.equal(csrf.status, 403)

    // ── G5: limiter behind Funnel ──
    const victim = '203.0.113.20'
    const attacker = '203.0.113.66'
    const forged = { Forwarded: `for=${victim}`, 'X-Real-IP': victim, 'Tailscale-Client-IP': victim, 'X-Client-IP': victim }
    const codes: number[] = []
    for (let i = 0; i < 6; i++) codes.push((await login(port, 'f'.repeat(64), `${victim}, ${attacker}`, forged)).status)
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429])
    assert.equal((await login(port, 'x', victim)).status, 401, 'the address named in forged headers is not limited')
    assert.equal((await login(port, token, '203.0.113.21')).status, 303, 'another address logs in')
    assert.equal((await login(port, token, `${victim}, ${attacker}`)).status, 429, 'the limited address stays limited')

    // ── G6: logout-all from another process, no restart ──
    const second = String((await login(port, token, '192.0.2.11')).headers['set-cookie']).split(';')[0]
    // P-05: an open team stream of that session, timed from the moment logout-all returns.
    let streamClosedAt = 0
    const open = http.request({ host: '127.0.0.1', port, path: `/api/team/events?project=${PID}`, headers: { ...fwdHeaders, Cookie: second } }, (res) => {
      res.resume()
      res.on('close', () => { streamClosedAt = Date.now() })
    })
    open.on('error', () => { /* closed by the server */ })
    open.end()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(streamClosedAt, 0, 'the stream is open')
    const lo = await run(['logout-all'], e)
    const loDone = Date.now()
    await waitFor(() => streamClosedAt > 0, 3000, 20)
    assert.ok(streamClosedAt - loDone < 1500, `stream closed ${streamClosedAt - loDone} ms after logout-all`)
    // P-01: the health route answers without a session (fixed body), also through Funnel.
    for (const h of [{ Host: `127.0.0.1:${port}` }, { Host: DNS, 'X-Forwarded-For': '203.0.113.1' }]) {
      const hr = await request(port, { path: '/healthz', headers: h })
      assert.deepEqual([hr.status, hr.body], [200, '{"ok":true}'])
    }
    assert.equal(lo.code, 0, lo.err)
    assert.match(lo.out, /Ended \d+ login session\(s\)/)
    for (const c of [cookie, second]) {
      const page = await funnel(port, { path: '/', xff: '192.0.2.10', headers: { Cookie: c, Accept: 'text/html' } })
      assert.deepEqual([page.status, page.headers.location], [302, '/login'])
      assert.equal((await funnel(port, { path: '/api/team/projects', xff: '192.0.2.10', headers: { Cookie: c } })).status, 401)
    }
    const fresh = String((await login(port, token, '192.0.2.12')).headers['set-cookie']).split(';')[0]
    assert.equal((await funnel(port, { path: '/api/team/projects', xff: '192.0.2.12', headers: { Cookie: fresh } })).status, 200)

    // Log: login lines with the counted address, never the tokens.
    const log = out + err
    assert.ok(err.includes(`[login] failed login from fwd:${attacker}`), err)
    assert.ok(err.includes(`[login] refused for fwd:${attacker}: too many failed logins`), err)
    assert.ok(err.includes('[login] successful login from fwd:192.0.2.10'), err)
    // The victim's own one wrong try leaves 4: the six forged requests naming it were not counted under it.
    assert.ok(err.includes(`[login] failed login from fwd:${victim} (wrong or missing token; 4 tries left before the limit)`), err)
    assert.ok(!err.includes(`fwd:${victim}, `), 'a forged list is never a key')
    for (const secret of [token, token.slice(0, 12), ingestToken, ingestToken.slice(0, 12), 'f'.repeat(16)]) assert.ok(!log.includes(secret), 'no token in the output')
  } finally {
    hub.kill('SIGTERM')
    await new Promise((r) => { if (hub.exitCode !== null || hub.signalCode !== null) r(null); else hub.once('exit', r) })
  }
  await waitFor(() => pidsWith(['--port', String(port)]).length === 0, 8000)
})

test('P-02/P-03: a default-mode monitor on a Funnel mapping warns at start and refuses forwarded requests', { skip: !linux && 'needs Linux /proc' }, async () => {
  const port = await freePort()
  const e = env('default')
  const statusFile = path.join(root, 'default', 'serve-status.json')
  fs.writeFileSync(statusFile, JSON.stringify({
    Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
    AllowFunnel: { [`${DNS}:443`]: true },
  }))
  let out = ''
  let err = ''
  const mon = spawn(process.execPath, [APP, '--no-open', '--port', String(port), '--tailscale-bin', TAILSCALE], {
    env: { ...e, FAKE_SERVE_STATUS: statusFile }, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
  })
  started.push(mon)
  mon.stdout!.on('data', (d: Buffer) => { out += d })
  mon.stderr!.on('data', (d: Buffer) => { err += d })
  try {
    await waitFor(() => out.includes('Turn it off:'), 20_000, 50)
    assert.match(out, /WARNING: this monitor is REACHABLE FROM THE INTERNET through Tailscale Funnel/)
    assert.ok(out.includes(`Funnel maps / on ${DNS}:443 to 127.0.0.1:${port}, but the monitor was not started with --public-ui.`), out)
    assert.ok(out.includes(`Turn it off: ${TAILSCALE} funnel --https=443 off`), out)
    assert.match(err, /\[funnel\] WARNING/)
    // A request as Funnel delivers it (even with a loopback Host): 403, fixed text. A plain local request: as before.
    const fwd = await funnel(port, { path: '/api/team/projects', headers: { Host: 'localhost' } })
    assert.equal(fwd.status, 403)
    assert.match(fwd.body, /^Forbidden: this monitor runs without --remote/)
    assert.equal((await request(port, { path: '/api/team/projects' })).status, 200)
    assert.deepEqual([(await request(port, { path: '/healthz' })).body], ['{"ok":true}'])
  } finally {
    mon.kill('SIGTERM')
    await new Promise((r) => { if (mon.exitCode !== null || mon.signalCode !== null) r(null); else mon.once('exit', r) })
  }
  await waitFor(() => pidsWith(['--port', String(port)]).length === 0, 8000)
})
