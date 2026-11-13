import { test, describe, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { LoginLimiter, SESSION_TTL_MS, SessionStore } from './auth'
import { buildRegistry } from './config'
import { AnswerError, answerPath, containedPath } from './answers'
import { clientKey, createRequestHandler, isHttpsRequest, isLocalRequest, ownOrigin, RemoteAccess, TeamService } from './http'
import type { RemoteConfig } from './remote'
import { listen, makeProject, makeTmpDir, removeTmpDir, request, Resp, waitFor, writeState, sampleState } from './test-helpers'

const TOKEN = 'ab'.repeat(32)
const TS_IP = '100.101.102.103'
const DNS = 'mini.tail1234.ts.net'

interface Ctx {
  root: string
  project: string
  team: TeamService
  port: number
  close: () => Promise<void>
  remote: RemoteAccess | null
  /** Fake clock for the session store. */
  clock: { t: number }
  /** Server-side log lines (handler and watchers). */
  logs: string[]
}

async function setup(remoteMode: boolean, extra: { secondProject?: boolean; sessionSweepMs?: number } = {}): Promise<Ctx> {
  const root = makeTmpDir()
  const project = makeProject(root, 'Proyek Satu')
  fs.mkdirSync(path.join(root, 'kosong'))
  const paths = [project, path.join(root, 'kosong'), path.join(root, 'tidak-ada')]
  if (extra.secondProject) paths.push(makeProject(root, 'Proyek Dua', sampleState({ meta: { title: 'Dua' } })))
  const logs: string[] = []
  const projects = buildRegistry([], paths)
  const team = new TeamService(projects, { debounceMs: 10, pollMs: 60_000, log: (m) => logs.push(m) })
  const clock = { t: Date.now() }
  let remote: RemoteAccess | null = null
  if (remoteMode) {
    const config: RemoteConfig = {
      bindMode: 'loopback', bindAddress: '127.0.0.1', tailscaleIp: TS_IP, dnsName: DNS,
      allowedHosts: new Set([TS_IP, DNS]),
    }
    remote = { config, token: TOKEN, sessions: new SessionStore(null, TOKEN, () => clock.t), limiter: new LoginLimiter(5) }
  }
  const handler = createRequestHandler({
    team,
    remote,
    fallback: (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('fallback') },
    sessionSweepMs: extra.sessionSweepMs,
    log: (m) => logs.push(m),
  })
  const { port, close } = await listen(handler)
  return { root, project, team, port, close, remote, clock, logs }
}

/** Open an SSE stream and collect `data:` events; `ended` resolves when the server closes it. */
function openSSE(port: number, pathName: string, headers: Record<string, string> = {}) {
  const events: Array<Record<string, unknown>> = []
  let status = 0
  let resolveEnded: () => void = () => {}
  const ended = new Promise<void>((r) => { resolveEnded = r })
  const req = http.request({ host: '127.0.0.1', port, path: pathName, headers: { Host: `localhost:${port}`, ...headers } })
  let buf = ''
  req.on('response', (res) => {
    status = res.statusCode ?? 0
    res.on('data', (c: Buffer) => {
      buf += c.toString()
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)))
      }
    })
    res.on('end', resolveEnded)
    res.on('close', resolveEnded)
  })
  req.on('error', resolveEnded)
  req.end()
  return { events, ended, status: () => status, close: () => req.destroy() }
}

async function teardown(ctx: Ctx) {
  ctx.team.dispose()
  await ctx.close()
  removeTmpDir(ctx.root)
}

function answer(ctx: Ctx, body: unknown, headers: Record<string, string> = {}, hostHeader?: string): Promise<Resp> {
  const host = hostHeader ?? `127.0.0.1:${ctx.port}`
  return request(ctx.port, {
    method: 'POST',
    path: '/api/team/answer',
    headers: {
      Host: host,
      'Content-Type': 'application/json',
      'X-Team-Monitor': '1',
      Origin: `http://${host}`,
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const PID = 'proyek-satu'
const answersDir = (ctx: Ctx) => path.join(ctx.project, '.agent-team', 'answers')

describe('team API, default (local) mode', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(false) })
  after(async () => { await teardown(ctx) })

  test('projects lists existing folders with hasState', async () => {
    const r = await request(ctx.port, { path: '/api/team/projects' })
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(r.body), {
      projects: [
        { id: PID, name: 'Proyek Satu', hasState: true },
        { id: 'kosong', name: 'kosong', hasState: false },
      ],
    })
  })

  test('a foreign Host is refused as upstream does', async () => {
    const r = await request(ctx.port, { path: '/api/team/projects', headers: { Host: 'evil.example:80' } })
    assert.equal(r.status, 403)
    const r2 = await request(ctx.port, { path: '/api/team/projects', headers: { Host: `${TS_IP}:${ctx.port}` } })
    assert.equal(r2.status, 403, 'tailnet names are only accepted in remote mode')
  })

  test('state returns the snapshot, unknown project is 404', async () => {
    const r = await request(ctx.port, { path: `/api/team/state?project=${PID}` })
    assert.equal(r.status, 200)
    const body = JSON.parse(r.body)
    assert.equal(body.project, PID)
    assert.equal(body.error, null)
    assert.equal(body.state.meta.title, 'Proyek uji')
    assert.equal(typeof body.updatedAt, 'string')
    assert.equal((await request(ctx.port, { path: '/api/team/state?project=nope' })).status, 404)
    assert.equal((await request(ctx.port, { path: '/api/team/state?project=__proto__' })).status, 404)
  })

  test('other paths go to the upstream handler', async () => {
    const r = await request(ctx.port, { path: '/' })
    assert.equal(r.body, 'fallback')
  })

  test('validation: bad input is 400', async () => {
    const cases: Array<[string, unknown]> = [
      ['id with path', { project: PID, id: '../D1', answer: 'x' }],
      ['id too long', { project: PID, id: 'D12345', answer: 'x' }],
      ['lowercase id', { project: PID, id: 'd1', answer: 'x' }],
      ['id with suffix', { project: PID, id: 'D1.json', answer: 'x' }],
      ['blank answer', { project: PID, id: 'D1', answer: '   ' }],
      ['answer too long', { project: PID, id: 'D1', answer: 'x'.repeat(2001) }],
      ['answer not a string', { project: PID, id: 'D1', answer: 5 }],
      ['no project', { id: 'D1', answer: 'x' }],
      ['array body', [1]],
      ['invalid JSON', '{"project":'],
    ]
    for (const [name, body] of cases) {
      const r = await answer(ctx, body)
      assert.equal(r.status, 400, `${name}: ${r.body}`)
    }
    assert.equal(fs.existsSync(path.join(answersDir(ctx), 'D1.json')), false)
  })

  test('Content-Type other than application/json is 400', async () => {
    const r = await answer(ctx, { project: PID, id: 'D1', answer: 'x' }, { 'Content-Type': 'text/plain' })
    assert.equal(r.status, 400)
  })

  test('body over 16 KB is 400', async () => {
    const r = await answer(ctx, { project: PID, id: 'D1', answer: 'x', pad: 'y'.repeat(17 * 1024) })
    assert.equal(r.status, 400)
  })

  test('missing or wrong X-Team-Monitor header is 403', async () => {
    const r = await request(ctx.port, {
      method: 'POST', path: '/api/team/answer',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: PID, id: 'D1', answer: 'x' }),
    })
    assert.equal(r.status, 403)
    assert.equal((await answer(ctx, { project: PID, id: 'D1', answer: 'x' }, { 'X-Team-Monitor': '0' })).status, 403)
  })

  test('cross-origin requests are 403 (Origin, Sec-Fetch-Site)', async () => {
    const body = { project: PID, id: 'D1', answer: 'x' }
    assert.equal((await answer(ctx, body, { Origin: 'http://evil.example' })).status, 403)
    assert.equal((await answer(ctx, body, { Origin: 'null' })).status, 403)
    assert.equal((await answer(ctx, body, { Origin: `https://127.0.0.1:${ctx.port}` })).status, 403, 'scheme must match')
    assert.equal((await answer(ctx, body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
    assert.equal((await answer(ctx, body, { 'Sec-Fetch-Site': 'same-site' })).status, 403)
    assert.equal(fs.existsSync(path.join(answersDir(ctx), 'D1.json')), false)
  })

  test('unknown project or decision is 404', async () => {
    assert.equal((await answer(ctx, { project: 'nope', id: 'D1', answer: 'x' })).status, 404)
    assert.equal((await answer(ctx, { project: PID, id: 'D7', answer: 'x' })).status, 404)
  })

  test('a decision that is not open is 409', async () => {
    assert.equal((await answer(ctx, { project: PID, id: 'D2', answer: 'x' })).status, 409)
  })

  test('GET on the answer endpoint is 405', async () => {
    assert.equal((await request(ctx.port, { path: '/api/team/answer' })).status, 405)
  })

  test('SSE pushes team_state on connect and on change', async () => {
    const events: Array<{ type: string; project: string; state: { meta: { title: string } } }> = []
    const req = http.request({ host: '127.0.0.1', port: ctx.port, path: `/api/team/events?project=${PID}`, headers: { Host: `localhost:${ctx.port}` } })
    let buf = ''
    let status = 0
    req.on('response', (res) => {
      status = res.statusCode ?? 0
      res.on('data', (c: Buffer) => {
        buf += c.toString()
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)))
        }
      })
    })
    req.on('error', () => {})
    req.end()
    try {
      await waitFor(() => events.length >= 1)
      assert.equal(status, 200)
      assert.equal(events[0].type, 'team_state')
      assert.equal(events[0].project, PID)
      writeState(ctx.project, sampleState({ meta: { title: 'Lewat SSE' } }))
      await waitFor(() => events.some((e) => e.state.meta.title === 'Lewat SSE'))
    } finally {
      req.destroy()
      writeState(ctx.project, sampleState())
      await waitFor(() => ctx.team.watcher(PID)!.snapshot().state!.meta !== undefined && (ctx.team.watcher(PID)!.snapshot().state!.meta as { title: string }).title === 'Proyek uji')
    }
  })

  test('a valid answer is written atomically, overlaid, and a second one is 409', async () => {
    const r = await answer(ctx, { project: PID, id: 'D1', answer: '  pakai opsi a  ' })
    assert.equal(r.status, 200, r.body)
    const body = JSON.parse(r.body)
    assert.equal(body.ok, true)
    assert.ok(!Number.isNaN(Date.parse(body.answeredAt)))

    const files = fs.readdirSync(answersDir(ctx))
    assert.deepEqual(files, ['D1.json'], 'no temp file is left behind')
    const onDisk = JSON.parse(fs.readFileSync(path.join(answersDir(ctx), 'D1.json'), 'utf-8'))
    assert.deepEqual(onDisk, { answer: 'pakai opsi a', answeredAt: body.answeredAt })
    assert.equal((fs.statSync(path.join(answersDir(ctx), 'D1.json')).mode & 0o077), 0)

    const state = JSON.parse((await request(ctx.port, { path: `/api/team/state?project=${PID}` })).body)
    assert.equal(state.state.approvals.D1.status, 'answered')
    assert.equal(state.state.approvals.D1.answer, 'pakai opsi a')

    const stateFile = JSON.parse(fs.readFileSync(path.join(ctx.project, '.agent-team', 'state.json'), 'utf-8'))
    assert.equal(stateFile.approvals.D1.status, 'open', 'the server never writes state.json')

    const again = await answer(ctx, { project: PID, id: 'D1', answer: 'lain' })
    assert.equal(again.status, 409)
    assert.equal(JSON.parse(fs.readFileSync(path.join(answersDir(ctx), 'D1.json'), 'utf-8')).answer, 'pakai opsi a')
  })

  test('an answer of exactly 2000 characters is accepted', async () => {
    writeState(ctx.project, sampleState({ approvals: { D3: { title: 't', status: 'open' } } }))
    const r = await answer(ctx, { project: PID, id: 'D3', answer: 'z'.repeat(2000) })
    assert.equal(r.status, 200, r.body)
  })
})

describe('guards: SSE isolation, symlinks, no paths in client bodies', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(false, { secondProject: true }) })
  after(async () => { await teardown(ctx) })

  const project2 = () => path.join(ctx.root, 'Proyek Dua')

  test('an SSE client on project A gets nothing when project B changes', async () => {
    const sse = openSSE(ctx.port, `/api/team/events?project=${PID}`)
    try {
      await waitFor(() => sse.events.length >= 1)
      assert.equal(sse.events[0].project, PID)
      const before = sse.events.length
      writeState(project2(), sampleState({ meta: { title: 'Dua berubah' } }))
      await waitFor(() => (ctx.team.watcher('proyek-dua')!.snapshot().state!.meta as { title: string }).title === 'Dua berubah')
      await new Promise((r) => setTimeout(r, 200))
      assert.equal(sse.events.length, before, 'no event from project B')
      assert.ok(sse.events.every((e) => e.project === PID))
      writeState(ctx.project, sampleState({ meta: { title: 'Satu berubah' } }))
      await waitFor(() => sse.events.some((e) => (e.state as { meta: { title: string } }).meta.title === 'Satu berubah'))
    } finally {
      sse.close()
    }
  })

  test('a symlinked answers folder is refused: 500, nothing written at the link target, no path in the body', async () => {
    const outside = path.join(ctx.root, 'outside')
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, answersDir(ctx))
    try {
      writeState(ctx.project, sampleState())
      ctx.team.watcher(PID)!.refresh()
      const r = await answer(ctx, { project: PID, id: 'D1', answer: 'lewat symlink' })
      assert.equal(r.status, 500)
      assert.deepEqual(fs.readdirSync(outside), [], 'nothing written outside')
      assert.deepEqual(JSON.parse(r.body), { ok: false, error: 'cannot write answer' })
      assert.ok(!r.body.includes(ctx.root) && !r.body.includes('/'), 'no filesystem path in the body')
      assert.ok(ctx.logs.some((l) => l.includes(answersDir(ctx))), 'the detail is logged on the server')
    } finally {
      fs.unlinkSync(answersDir(ctx))
    }
  })

  test('a dangling symlink at answers/D<n>.json counts as already answered: 409, nothing written at its target', async () => {
    fs.mkdirSync(answersDir(ctx), { recursive: true, mode: 0o700 })
    const link = path.join(answersDir(ctx), 'D1.json')
    const target = path.join(ctx.root, 'dangling-target.json')
    fs.symlinkSync(target, link)
    try {
      assert.equal(fs.existsSync(link), false, 'precondition: existsSync cannot see a dangling link')
      writeState(ctx.project, sampleState())
      ctx.team.watcher(PID)!.refresh()
      const r = await answer(ctx, { project: PID, id: 'D1', answer: 'lewat link' })
      assert.equal(r.status, 409, r.body)
      assert.equal(fs.existsSync(target), false, 'nothing written at the link target')
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link was not replaced')
    } finally {
      fs.unlinkSync(link)
      fs.rmdirSync(answersDir(ctx)) // empty again; the next test needs the folder gone
    }
  })

  test('answers being a regular file gives a generic 500 without the path', async () => {
    fs.writeFileSync(answersDir(ctx), 'not a folder')
    try {
      const r = await answer(ctx, { project: PID, id: 'D1', answer: 'x' })
      assert.equal(r.status, 500)
      assert.ok(!r.body.includes(ctx.root), r.body)
      assert.equal(JSON.parse(r.body).error, 'cannot write answer')
    } finally {
      fs.unlinkSync(answersDir(ctx))
    }
  })

  test('the state error field is fixed text: no path, no file content', async () => {
    const file = path.join(ctx.project, '.agent-team', 'state.json')
    writeState(ctx.project, '{"secret": "isi rahasia", oops')
    ctx.team.watcher(PID)!.refresh()
    let body = (await request(ctx.port, { path: `/api/team/state?project=${PID}` })).body
    assert.equal(JSON.parse(body).error, 'state.json is not valid JSON')
    assert.ok(!body.includes('rahasia'))

    fs.chmodSync(file, 0o000)
    try {
      ctx.team.watcher(PID)!.refresh()
      body = (await request(ctx.port, { path: `/api/team/state?project=${PID}` })).body
      assert.equal(JSON.parse(body).error, 'state.json cannot be read')
      assert.ok(!body.includes(ctx.root), body)
      assert.ok(ctx.logs.some((l) => l.includes(file)), 'the detail with the path is logged')
    } finally {
      fs.chmodSync(file, 0o644)
      writeState(ctx.project, sampleState())
      ctx.team.watcher(PID)!.refresh()
    }
  })
})

test('containedPath refuses names that leave the folder', () => {
  const dir = makeTmpDir()
  try {
    assert.equal(containedPath(dir, 'D1.json'), path.join(dir, 'D1.json'))
    for (const name of ['../D1.json', '..', 'sub/D1.json', '/etc/passwd', '.']) {
      assert.throws(() => containedPath(dir, name), AnswerError, name)
    }
    assert.throws(() => answerPath(dir, '../D1'), AnswerError)
  } finally {
    removeTmpDir(dir)
  }
})

test('X-Forwarded-Proto is trusted only from a loopback socket', () => {
  const fake = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as unknown as http.IncomingMessage
  const xfp = { host: '100.101.102.103:3002', 'x-forwarded-proto': 'https' }
  assert.equal(isHttpsRequest(fake('127.0.0.1', xfp)), true)
  assert.equal(isHttpsRequest(fake('100.90.1.2', xfp)), false, 'a tailnet client cannot claim https')
  assert.equal(ownOrigin(fake('100.90.1.2', xfp)), 'http://100.101.102.103:3002')
  assert.equal(isHttpsRequest(fake('127.0.0.1', { host: 'x', 'x-forwarded-proto': 'http' })), false)
})

test('clientKey: socket address directly, last X-Forwarded-For entry behind a loopback proxy', () => {
  const fake = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as unknown as http.IncomingMessage
  assert.equal(clientKey(fake('100.90.1.2', { 'x-forwarded-for': '1.2.3.4' })), '100.90.1.2', 'direct: header ignored')
  assert.equal(clientKey(fake('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 100.90.1.2' })), 'fwd:100.90.1.2', 'last entry, the one the proxy set')
  assert.equal(clientKey(fake('127.0.0.1', {})), '127.0.0.1')
})

describe('team API, remote mode', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(true) })
  after(async () => { await teardown(ctx) })

  const tsHost = () => `${TS_IP}:${ctx.port}`

  async function login(token: string, headers: Record<string, string> = {}): Promise<Resp> {
    return request(ctx.port, {
      method: 'POST', path: '/login',
      headers: { Host: tsHost(), 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://${tsHost()}`, ...headers },
      body: new URLSearchParams({ token }).toString(),
    })
  }

  function cookieOf(r: Resp): string {
    const sc = r.headers['set-cookie']
    assert.ok(sc && sc.length === 1, 'one Set-Cookie header')
    return sc![0].split(';')[0]
  }

  test('Host allow-list: tailnet IP and MagicDNS pass, others 403', async () => {
    assert.equal((await request(ctx.port, { path: '/login', headers: { Host: tsHost() } })).status, 200)
    assert.equal((await request(ctx.port, { path: '/login', headers: { Host: DNS } })).status, 200)
    assert.equal((await request(ctx.port, { path: '/login', headers: { Host: 'evil.example' } })).status, 403)
    assert.equal((await request(ctx.port, { path: '/login', headers: { Host: '100.101.102.104' } })).status, 403)
    assert.equal((await request(ctx.port, { path: '/login', headers: { Host: `${DNS}.evil.example` } })).status, 403)
  })

  test('without a session: HTML GET redirects to /login, the rest is 401', async () => {
    const page = await request(ctx.port, { path: '/', headers: { Host: tsHost(), Accept: 'text/html' } })
    assert.equal(page.status, 302)
    assert.equal(page.headers.location, '/login')
    assert.equal((await request(ctx.port, { path: '/index.js', headers: { Host: tsHost() } })).status, 401)
    assert.equal((await request(ctx.port, { path: '/events', headers: { Host: tsHost() } })).status, 401)
    assert.equal((await request(ctx.port, { path: '/api/team/projects', headers: { Host: tsHost() } })).status, 401)
    const r = await answer(ctx, { project: PID, id: 'D1', answer: 'x' }, {}, tsHost())
    assert.equal(r.status, 401)
    assert.equal(fs.existsSync(path.join(answersDir(ctx), 'D1.json')), false)
  })

  test('a loopback request on this machine needs no session, a proxied one does', async () => {
    assert.equal((await request(ctx.port, { path: '/' })).body, 'fallback')
    const proxied = await request(ctx.port, { path: '/api/team/projects', headers: { 'X-Forwarded-For': '100.90.1.2' } })
    assert.equal(proxied.status, 401)
    const proto = await request(ctx.port, { path: '/api/team/projects', headers: { 'X-Forwarded-Proto': 'https' } })
    assert.equal(proto.status, 401)
  })

  test('wrong token is 401 and sets no cookie; a cookie that is not a session is refused', async () => {
    const r = await login('cd'.repeat(32))
    assert.equal(r.status, 401)
    assert.equal(r.headers['set-cookie'], undefined)
    const forged = await request(ctx.port, { path: '/api/team/projects', headers: { Host: tsHost(), Cookie: `tm_session=${TOKEN}` } })
    assert.equal(forged.status, 401, 'the token itself is not a session id')
  })

  test('cross-origin login is 403', async () => {
    assert.equal((await login(TOKEN, { Origin: 'http://evil.example' })).status, 403)
  })

  test('valid token: session cookie works for the UI, API and answers; logout ends it', async () => {
    const r = await login(TOKEN)
    assert.equal(r.status, 303)
    assert.equal(r.headers.location, '/')
    const sc = r.headers['set-cookie']![0]
    assert.match(sc, /HttpOnly/)
    assert.match(sc, /SameSite=Strict/)
    assert.match(sc, /Path=\//)
    assert.doesNotMatch(sc, /Secure/, 'plain http gets no Secure flag')
    const cookie = cookieOf(r)
    assert.ok(!cookie.includes(TOKEN), 'the cookie never carries the token')

    const projects = await request(ctx.port, { path: '/api/team/projects', headers: { Host: tsHost(), Cookie: cookie } })
    assert.equal(projects.status, 200)
    assert.equal((await request(ctx.port, { path: '/', headers: { Host: tsHost(), Cookie: cookie, Accept: 'text/html' } })).body, 'fallback')

    const ok = await answer(ctx, { project: PID, id: 'D1', answer: 'dari HP' }, { Cookie: cookie }, tsHost())
    assert.equal(ok.status, 200, ok.body)

    const out = await request(ctx.port, { method: 'POST', path: '/logout', headers: { Host: tsHost(), Cookie: cookie, Origin: `http://${tsHost()}` } })
    assert.equal(out.status, 303)
    assert.match(out.headers['set-cookie']![0], /Max-Age=0/)
    assert.equal((await request(ctx.port, { path: '/api/team/projects', headers: { Host: tsHost(), Cookie: cookie } })).status, 401)
  })

  test('Secure is set when tailscale serve forwards https', async () => {
    const r = await login(TOKEN, { Host: DNS, Origin: `https://${DNS}`, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '100.90.9.9' })
    assert.equal(r.status, 303)
    assert.match(r.headers['set-cookie']![0], /; Secure/)
  })

  test('failed logins are rate limited, even a correct token then waits', async () => {
    const headers = { 'X-Forwarded-For': '100.77.7.7' }
    for (let i = 0; i < 5; i++) assert.equal((await login('00'.repeat(32), headers)).status, 401)
    const blocked = await login(TOKEN, headers)
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers['retry-after']) > 0)
    assert.equal(blocked.headers['set-cookie'], undefined)
    assert.equal((await login(TOKEN, { 'X-Forwarded-For': '100.77.7.8' })).status, 303, 'other clients are not locked out')
  })

  test('a client cannot dodge the limit by varying the first X-Forwarded-For entry', async () => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await login('00'.repeat(32), { 'X-Forwarded-For': `1.2.3.${i}, 100.77.7.9` })).status, 401)
    }
    assert.equal((await login(TOKEN, { 'X-Forwarded-For': '9.9.9.9, 100.77.7.9' })).status, 429)
  })

  test('many failing clients do not lock the owner out (no global cap)', async () => {
    for (let i = 0; i < 30; i++) await login('00'.repeat(32), { 'X-Forwarded-For': `100.88.0.${i}` })
    assert.equal((await login(TOKEN, { 'X-Forwarded-For': '100.88.1.1' })).status, 303)
    assert.equal((await login(TOKEN)).status, 303, 'nor this Mac')
  })

  test('logout closes that session\'s open SSE streams, not other sessions\' streams', async () => {
    const c1 = cookieOf(await login(TOKEN))
    const c2 = cookieOf(await login(TOKEN))
    const s1 = openSSE(ctx.port, `/api/team/events?project=${PID}`, { Host: tsHost(), Cookie: c1 })
    const s2 = openSSE(ctx.port, `/api/team/events?project=${PID}`, { Host: tsHost(), Cookie: c2 })
    try {
      await waitFor(() => s1.events.length >= 1 && s2.events.length >= 1)
      let s2Ended = false
      void s2.ended.then(() => { s2Ended = true })
      const out = await request(ctx.port, { method: 'POST', path: '/logout', headers: { Host: tsHost(), Cookie: c1, Origin: `http://${tsHost()}` } })
      assert.equal(out.status, 303)
      await Promise.race([s1.ended, new Promise((_, rej) => setTimeout(() => rej(new Error('stream 1 still open after logout')), 2000))])
      await new Promise((r) => setTimeout(r, 100))
      assert.equal(s2Ended, false, 'the other session keeps its stream')
    } finally {
      s1.close()
      s2.close()
    }
  })
})

describe('remote mode: session expiry', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(true, { sessionSweepMs: 30 }) })
  after(async () => { await teardown(ctx) })

  test('an expired session\'s SSE stream is closed', async () => {
    const host = `${TS_IP}:${ctx.port}`
    const r = await request(ctx.port, {
      method: 'POST', path: '/login',
      headers: { Host: host, 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://${host}` },
      body: new URLSearchParams({ token: TOKEN }).toString(),
    })
    const cookie = r.headers['set-cookie']![0].split(';')[0]
    const sse = openSSE(ctx.port, `/api/team/events?project=${PID}`, { Host: host, Cookie: cookie })
    try {
      await waitFor(() => sse.events.length >= 1)
      let ended = false
      void sse.ended.then(() => { ended = true })
      await new Promise((res) => setTimeout(res, 120))
      assert.equal(ended, false, 'a valid session keeps its stream')
      ctx.clock.t += SESSION_TTL_MS + 1
      await Promise.race([sse.ended, new Promise((_, rej) => setTimeout(() => rej(new Error('stream still open after expiry')), 2000))])
    } finally {
      sse.close()
    }
  })
})

test('isLocalRequest needs a loopback socket, a loopback Host and no proxy headers', () => {
  const fake = (remoteAddress: string, headers: Record<string, string>) => ({ socket: { remoteAddress }, headers }) as unknown as http.IncomingMessage
  assert.equal(isLocalRequest(fake('127.0.0.1', { host: '127.0.0.1:3001' })), true)
  assert.equal(isLocalRequest(fake('::ffff:127.0.0.1', { host: 'localhost' })), true)
  assert.equal(isLocalRequest(fake('100.90.1.2', { host: '127.0.0.1:3001' })), false)
  assert.equal(isLocalRequest(fake('127.0.0.1', { host: DNS })), false)
  assert.equal(isLocalRequest(fake('127.0.0.1', { host: 'localhost', 'x-forwarded-for': '1.2.3.4' })), false)
  assert.equal(isLocalRequest(fake('127.0.0.1', { host: 'localhost', 'tailscale-user-login': 'a@b' })), false)
})
