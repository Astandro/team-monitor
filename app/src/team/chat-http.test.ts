/**
 * POST /api/team/message (spec-chat): same auth, CSRF and Origin rules as answers; validation; 4000 characters;
 * 429 above 20 a minute; atomic inbox write; the thread and the watcher on /state and the SSE stream.
 */
import { test, describe, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { LoginLimiter, SESSION_COOKIE, SessionStore } from './auth'
import { MessageLimiter } from './chat'
import { buildRegistry } from './config'
import { writeHeartbeat } from './heartbeat'
import { createRequestHandler, RemoteAccess, TeamService } from './http'
import type { RemoteConfig } from './remote'
import { listen, makeProject, makeTmpDir, removeTmpDir, request, Resp, sampleState, waitFor, writeState } from './test-helpers'

const TOKEN = 'ef'.repeat(32)
const TS_IP = '100.101.102.103'
const PID = 'proyek-satu'

interface Ctx {
  root: string
  project: string
  team: TeamService
  port: number
  close: () => Promise<void>
  remote: RemoteAccess | null
  logs: string[]
  clock: { t: number }
}

async function setup(remoteMode: boolean): Promise<Ctx> {
  const root = makeTmpDir()
  const project = makeProject(root, 'Proyek Satu')
  const logs: string[] = []
  const team = new TeamService(buildRegistry([], [project]), {
    debounceMs: 10, pollMs: 60_000, log: (m) => logs.push(m), heartbeat: { pidAlive: () => true },
  })
  const clock = { t: 1_000_000 }
  team.messageLimiter = new MessageLimiter(20, 60_000, () => clock.t)
  let remote: RemoteAccess | null = null
  if (remoteMode) {
    const config: RemoteConfig = {
      bindMode: 'loopback', bindAddress: '127.0.0.1', tailscaleIp: TS_IP, dnsName: null, allowedHosts: new Set([TS_IP]),
    }
    remote = { config, token: TOKEN, sessions: new SessionStore(null, TOKEN), limiter: new LoginLimiter(5) }
  }
  const handler = createRequestHandler({
    team, remote, log: (m) => logs.push(m),
    fallback: (_req, res) => { res.writeHead(200); res.end('fallback') },
  })
  const { port, close } = await listen(handler)
  return { root, project, team, port, close, remote, logs, clock }
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.close()
  ctx.team.dispose()
  try { fs.chmodSync(inboxDir(ctx), 0o700) } catch { /* not there */ }
  removeTmpDir(ctx.root)
}

const inboxDir = (ctx: Ctx) => path.join(ctx.project, '.agent-team', 'inbox')
const inboxFiles = (ctx: Ctx) => { try { return fs.readdirSync(inboxDir(ctx)) } catch { return [] } }
const json = (r: Resp) => JSON.parse(r.body) as Record<string, unknown>

function send(ctx: Ctx, body: unknown, headers: Record<string, string> = {}): Promise<Resp> {
  const host = headers.Host ?? `127.0.0.1:${ctx.port}`
  return request(ctx.port, {
    method: 'POST', path: '/api/team/message',
    headers: {
      Host: host, 'Content-Type': 'application/json', 'X-Team-Monitor': '1',
      Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin', ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function openSSE(port: number, pathName: string) {
  const events: Array<Record<string, unknown>> = []
  const req = http.request({ host: '127.0.0.1', port, path: pathName, headers: { Host: `localhost:${port}` } })
  let buf = ''
  req.on('response', (res) => {
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
  return { events, close: () => req.destroy() }
}

describe('POST /api/team/message, default mode', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(false) })
  after(async () => { await teardown(ctx) })

  test('missing or wrong X-Team-Monitor header is 403, nothing written', async () => {
    const r = await request(ctx.port, {
      method: 'POST', path: '/api/team/message',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: PID, text: 'x' }),
    })
    assert.equal(r.status, 403)
    assert.equal((await send(ctx, { project: PID, text: 'x' }, { 'X-Team-Monitor': '0' })).status, 403)
    assert.deepEqual(inboxFiles(ctx), [])
  })

  test('cross-origin is 403 (Origin, scheme, Sec-Fetch-Site), nothing written', async () => {
    const body = { project: PID, text: 'x' }
    assert.equal((await send(ctx, body, { Origin: 'http://evil.example' })).status, 403)
    assert.equal((await send(ctx, body, { Origin: 'null' })).status, 403)
    assert.equal((await send(ctx, body, { Origin: `https://127.0.0.1:${ctx.port}` })).status, 403)
    assert.equal((await send(ctx, body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
    assert.equal((await send(ctx, body, { 'Sec-Fetch-Site': 'same-site' })).status, 403)
    assert.deepEqual(inboxFiles(ctx), [])
  })

  test('a foreign Host is 403', async () => {
    assert.equal((await send(ctx, { project: PID, text: 'x' }, { Host: 'evil.example' })).status, 403)
  })

  test('validation: 400 for bad bodies, media type, size; 404 unknown project; 405 GET', async () => {
    const cases: Array<[string, unknown]> = [
      ['no text', { project: PID }],
      ['blank text', { project: PID, text: ' \n ' }],
      ['text not a string', { project: PID, text: ['x'] }],
      ['too long', { project: PID, text: 'x'.repeat(4001) }],
      ['no project', { text: 'x' }],
      ['array body', [1]],
      ['invalid JSON', '{"project":'],
    ]
    for (const [name, body] of cases) {
      const r = await send(ctx, body)
      assert.equal(r.status, 400, `${name}: ${r.body}`)
      assert.equal(json(r).ok, false)
    }
    assert.equal((await send(ctx, { project: PID, text: 'x' }, { 'Content-Type': 'text/plain' })).status, 400)
    assert.equal((await send(ctx, { project: PID, text: 'x', pad: 'y'.repeat(33 * 1024) })).status, 400, 'body over 32 KB')
    assert.equal((await send(ctx, { project: 'nope', text: 'x' })).status, 404)
    assert.equal((await send(ctx, { project: '__proto__', text: 'x' })).status, 404)
    assert.equal((await request(ctx.port, { path: '/api/team/message' })).status, 405)
    assert.deepEqual(inboxFiles(ctx), [])
  })

  test('a valid message is written atomically, served at once as "sent", and pushed over SSE', async () => {
    const sse = openSSE(ctx.port, `/api/team/events?project=${PID}`)
    try {
      await waitFor(() => sse.events.length >= 1)
      assert.deepEqual(sse.events[0].chat, [])
      assert.deepEqual(sse.events[0].watcher, { alive: false, since: null })

      const r = await send(ctx, { project: PID, text: '  Halo Sora,\r\ncek ini ya  ' })
      assert.equal(r.status, 200, r.body)
      const body = json(r)
      assert.equal(body.ok, true)
      assert.match(String(body.id), /^[0-9a-f]{12}$/)
      assert.ok(!Number.isNaN(Date.parse(String(body.sentAt))))

      const files = inboxFiles(ctx)
      assert.deepEqual(files, [`${Date.parse(String(body.sentAt))}-${body.id}.json`], 'one file, no temp file left')
      const file = path.join(inboxDir(ctx), files[0])
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { id: body.id, text: 'Halo Sora,\ncek ini ya', sentAt: body.sentAt })
      assert.equal(fs.statSync(file).mode & 0o077, 0)

      const entry = { id: body.id, from: 'owner', text: 'Halo Sora,\ncek ini ya', t: body.sentAt, status: 'sent' }
      const state = json(await request(ctx.port, { path: `/api/team/state?project=${PID}` }))
      assert.deepEqual(state.chat, [entry], 'served right after the POST')
      await waitFor(() => sse.events.some((e) => (e.chat as unknown[]).length === 1))

      // Sora records it and replies: the thread shows "read" and the reply, live.
      writeState(ctx.project, sampleState({
        chat: {
          r1: { from: 'sora', text: 'Siap', t: new Date(Date.parse(String(body.sentAt)) + 5000).toISOString() },
          [String(body.id)]: { from: 'owner', text: 'Halo Sora,\ncek ini ya', t: body.sentAt, readAt: 'x' },
        },
      }))
      await waitFor(() => sse.events.some((e) => (e.chat as unknown[]).length === 2))
      const last = sse.events[sse.events.length - 1]
      assert.deepEqual((last.chat as Array<{ id: string; status?: string }>).map((c) => [c.id, c.status]), [[body.id, 'read'], ['r1', undefined]])
      assert.equal((last.state as Record<string, unknown>).chat, undefined)
      assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.project, '.agent-team', 'state.json'), 'utf-8')).chat.r1.text, 'Siap', 'state.json untouched by the server')

      // A running watcher shows up as alive.
      const now = new Date().toISOString()
      writeHeartbeat(path.join(ctx.project, '.agent-team'), { pid: 99, startedAt: now, beatAt: now })
      await waitFor(() => sse.events.some((e) => (e.watcher as { alive: boolean }).alive))
      assert.deepEqual(sse.events[sse.events.length - 1].watcher, { alive: true, since: now })
    } finally {
      sse.close()
    }
  })

  test('exactly 4000 characters is accepted', async () => {
    const r = await send(ctx, { project: PID, text: 'z'.repeat(4000) })
    assert.equal(r.status, 200, r.body)
  })

  test('more than 20 messages a minute is 429 with Retry-After; nothing written for the refused one', async () => {
    ctx.clock.t += 120_000 // fresh window
    for (let i = 0; i < 20; i++) {
      const r = await send(ctx, { project: PID, text: `pesan ${i}` })
      assert.equal(r.status, 200, `message ${i + 1}: ${r.body}`)
    }
    const before = inboxFiles(ctx).length
    const r = await send(ctx, { project: PID, text: 'kebanyakan' })
    assert.equal(r.status, 429)
    assert.equal(r.headers['retry-after'], '60')
    assert.equal(json(r).ok, false)
    assert.equal(inboxFiles(ctx).length, before)
    ctx.clock.t += 60_000
    assert.equal((await send(ctx, { project: PID, text: 'sudah boleh' })).status, 200)
  })

  test('a symlinked inbox gives a generic 500, nothing written at the target, detail only in the log', async () => {
    const outside = path.join(ctx.root, 'outside')
    fs.mkdirSync(outside)
    fs.renameSync(inboxDir(ctx), path.join(ctx.root, 'old-inbox'))
    fs.symlinkSync(outside, inboxDir(ctx))
    ctx.clock.t += 120_000
    try {
      const r = await send(ctx, { project: PID, text: 'lewat symlink' })
      assert.equal(r.status, 500)
      assert.deepEqual(json(r), { ok: false, error: 'cannot save message' })
      assert.deepEqual(fs.readdirSync(outside), [])
      assert.ok(ctx.logs.some((l) => l.includes(inboxDir(ctx))))
    } finally {
      fs.unlinkSync(inboxDir(ctx))
      fs.renameSync(path.join(ctx.root, 'old-inbox'), inboxDir(ctx))
    }
  })
})

describe('POST /api/team/message, remote mode', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup(true) })
  after(async () => { await teardown(ctx) })

  const phone = () => ({ Host: `${TS_IP}:${ctx.port}`, 'X-Forwarded-For': '100.64.0.7', 'X-Forwarded-Proto': 'https', Origin: `https://${TS_IP}:${ctx.port}` })

  test('no session: 401, nothing written', async () => {
    assert.equal((await send(ctx, { project: PID, text: 'x' }, phone())).status, 401)
    assert.deepEqual(inboxFiles(ctx), [])
  })

  test('with a session from the phone: 200, still needs the header and the https origin', async () => {
    const h = { ...phone(), Cookie: `${SESSION_COOKIE}=${ctx.remote!.sessions.create()}` }
    assert.equal((await send(ctx, { project: PID, text: 'x' }, { ...h, 'X-Team-Monitor': '0' })).status, 403)
    assert.equal((await send(ctx, { project: PID, text: 'x' }, { ...h, Origin: `http://${TS_IP}:${ctx.port}` })).status, 403)
    const ok = await send(ctx, { project: PID, text: 'dari HP' }, h)
    assert.equal(ok.status, 200, ok.body)
    assert.equal(inboxFiles(ctx).length, 1)
  })
})
