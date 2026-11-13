import { test, describe, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { LoginLimiter, SessionStore } from './auth'
import { buildRegistry } from './config'
import { createRequestHandler, isLocalRequest, RemoteAccess, TeamService } from './http'
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
}

async function setup(remoteMode: boolean): Promise<Ctx> {
  const root = makeTmpDir()
  const project = makeProject(root, 'Proyek Satu')
  fs.mkdirSync(path.join(root, 'kosong'))
  const projects = buildRegistry([], [project, path.join(root, 'kosong'), path.join(root, 'tidak-ada')])
  const team = new TeamService(projects, { debounceMs: 10, pollMs: 60_000 })
  let remote: RemoteAccess | null = null
  if (remoteMode) {
    const config: RemoteConfig = {
      bindMode: 'loopback', bindAddress: '127.0.0.1', tailscaleIp: TS_IP, dnsName: DNS,
      allowedHosts: new Set([TS_IP, DNS]),
    }
    remote = { config, token: TOKEN, sessions: new SessionStore(null), limiter: new LoginLimiter(5, 20) }
  }
  const handler = createRequestHandler({
    team,
    remote,
    fallback: (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('fallback') },
  })
  const { port, close } = await listen(handler)
  return { root, project, team, port, close, remote }
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
