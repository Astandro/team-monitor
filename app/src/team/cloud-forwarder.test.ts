/**
 * The cloud forwarder against a fake container monitor (`/events` like the relay: session list, replay batch, live
 * events) and a fake hub that checks every events body with the hub's own parser (ingest.ts) and keeps `seq` like
 * the hub does. Covers ordering, seq, replay without duplicates (reconnect, forwarder restart, monitor restart),
 * hub down and back, lost responses, refused batches, the unsent cap, state and outbox files, the token header and
 * the proxy (acceptance criteria 5 forwarder half and 7).
 */
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { ACKED_FILE, cloudDir, Forwarder, ForwarderOptions, PLACEHOLDER_TOKEN, STATUS_FILE } from './cloud-forwarder'
import { IngestError, parseEventsBody, parseStateBody } from './ingest'
import { fakeConnectProxy, listen, makeProject, makeTmpDir, removeTmpDir, sampleState, waitFor, writeState } from './test-helpers'

const root = makeTmpDir()
after(() => removeTmpDir(root))

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const S2 = 'bbbbbbbb-0000-4000-8000-000000000002'
let counter = 0

// ─── Fake container monitor ─────────────────────────────────────────────────

async function fakeMonitor() {
  const sessions = new Map<string, Record<string, unknown>>()
  const buffer = new Map<string, Array<Record<string, unknown>>>()
  const clients = new Set<http.ServerResponse>()
  let t = 0
  const srv = await listen((req, res) => {
    if (req.url !== '/events') { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    clients.add(res)
    req.on('close', () => clients.delete(res))
    if (sessions.size) res.write(`data: ${JSON.stringify({ type: 'session-list', sessions: [...sessions.values()] })}\n\n`)
    for (const [, evs] of buffer) res.write(`data: ${JSON.stringify({ type: 'agent-event-batch', events: evs })}\n\n`)
  })
  const send = (m: unknown) => { for (const c of clients) c.write(`data: ${JSON.stringify(m)}\n\n`) }
  return {
    port: srv.port,
    clients,
    startSession(id: string) {
      const s = { id, label: 'proj', status: 'active', startTime: Date.now(), lastActivityTime: Date.now(), projectId: 'proj' }
      sessions.set(id, s)
      send({ type: 'session-started', session: s })
    },
    emit(sid: string, n = 1) {
      for (let i = 0; i < n; i++) {
        const ev = { time: ++t / 10, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read', n: t }, sessionId: sid }
        const b = buffer.get(sid) ?? []
        b.push(ev)
        buffer.set(sid, b)
        send({ type: 'agent-event', event: ev })
      }
    },
    /** As after a monitor restart: same sessions, history rebuilt with other times. */
    rebuild() {
      for (const [sid, evs] of buffer) buffer.set(sid, evs.map((e) => ({ ...e, time: (e.time as number) + 1000 })))
    },
    dropClients() { for (const c of clients) { c.destroy() } clients.clear() },
    close: srv.close,
  }
}

// ─── Fake hub (contract checks from ingest.ts) ─────────────────────────────

type HubMode = 'ok' | 'down503' | 'refuse400' | 'dropAfterApply' | 'unauthorized'

async function fakeHub(token?: string) {
  const events: Array<Record<string, unknown>> = []
  const seqs: number[] = []
  const auths: string[] = []
  const states: Array<{ state: unknown; watcher: unknown }> = []
  let lastSeq = -1
  let mode: HubMode = 'ok'
  let outbox: Array<{ path: string; content: string }> = []
  let lifecycle = 0
  const srv = await listen((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      auths.push(String(req.headers.authorization))
      const reply = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (token && req.headers.authorization !== `Bearer ${token}`) return reply(401, { ok: false, error: 'ingest token required' })
      if (mode === 'unauthorized') return reply(401, { ok: false, error: 'ingest token required' })
      if (mode === 'down503') return reply(503, { ok: false, error: 'down' })
      const u = new URL(req.url ?? '/', 'http://x')
      if (u.pathname === '/api/ingest/v1/events') {
        if (mode === 'refuse400') { mode = 'ok'; return reply(400, { ok: false, error: 'messages[0] is bad' }) }
        let input
        try { input = parseEventsBody(JSON.parse(Buffer.concat(chunks).toString())) } catch (e) {
          return reply(400, { ok: false, error: e instanceof IngestError ? e.message : 'bad json' })
        }
        if (input.seq <= lastSeq) return reply(200, { ok: true, seq: lastSeq, duplicate: true })
        lastSeq = input.seq
        seqs.push(input.seq)
        for (const m of input.messages) {
          if (m.type === 'agent-event') events.push({ ...m.event })
          else if (m.type === 'agent-event-batch') events.push(...m.events.map((e) => ({ ...e })))
          else lifecycle++
        }
        if (mode === 'dropAfterApply') { mode = 'ok'; req.socket.destroy(); return }
        return reply(200, { ok: true, seq: input.seq })
      }
      if (u.pathname === '/api/ingest/v1/state') {
        const s = parseStateBody(JSON.parse(Buffer.concat(chunks).toString()))
        states.push({ state: s.state, watcher: s.watcher })
        return reply(200, { ok: true })
      }
      if (u.pathname === '/api/ingest/v1/outbox') {
        const after = Number((u.searchParams.get('after') ?? 'x-0').split('-')[1])
        const files = outbox.slice(after)
        if (!files.length) { setTimeout(() => reply(200, { cursor: `x-${after}`, files: [] }), 100); return }
        return reply(200, { cursor: `x-${outbox.length}`, files })
      }
      reply(404, { ok: false, error: 'not found' })
    })
  })
  return {
    port: srv.port, events, seqs, auths, states,
    get lifecycle() { return lifecycle },
    set mode(m: HubMode) { mode = m },
    setOutbox(files: Array<{ path: string; content: string }>) { outbox = files },
    close: srv.close,
  }
}

function setup(monitorPort: number, hubPort: number, over: Partial<ForwarderOptions> = {}) {
  const dir = path.join(root, `f${++counter}`)
  const home = path.join(dir, 'tm')
  fs.mkdirSync(home, { recursive: true })
  const project = makeProject(dir, 'proj')
  const logs: string[] = []
  const make = (extra: Partial<ForwarderOptions> = {}) => new Forwarder({
    home, projectPath: project, project: { id: 'proj', name: 'Proj' }, monitorPort, hubUrl: `http://127.0.0.1:${hubPort}/`,
    sourceId: 'session-01test', env: { TEAM_MONITOR_INGEST_TOKEN: 'tok-123' }, log: (m) => logs.push(m),
    flushMs: 40, statePollMs: 40, backoffMinMs: 40, backoffMaxMs: 200, outboxWaitS: 1, reconnectMs: 30,
    monitorInstance: () => 'm1', ...over, ...extra,
  })
  return { home, project, logs, make }
}

const ids = (evs: Array<Record<string, unknown>>) => evs.map((e) => (e.payload as { n: number }).n)

test('forwards the session list and live events in order, with an increasing seq and the bearer token', async () => {
  const mon = await fakeMonitor()
  const hub = await fakeHub('tok-123')
  const { make, logs, home } = setup(mon.port, hub.port)
  mon.startSession(S1)
  mon.emit(S1, 3)
  const f = make()
  f.start()
  try {
    await waitFor(() => hub.events.length === 3)
    mon.emit(S1, 250) // more than one flush worth
    await waitFor(() => hub.events.length === 253, 5000)
    assert.deepEqual(ids(hub.events), Array.from({ length: 253 }, (_, i) => i + 1))
    assert.ok(hub.lifecycle >= 1, 'session-list became session-started')
    for (let i = 1; i < hub.seqs.length; i++) assert.ok(hub.seqs[i] > hub.seqs[i - 1])
    assert.ok(hub.auths.every((a) => a === 'Bearer tok-123'))
    assert.ok(!logs.join('\n').includes('tok-123'), 'token never logged')
    await waitFor(() => fs.existsSync(path.join(cloudDir(home), STATUS_FILE)))
  } finally {
    await f.stop()
    await mon.close(); await hub.close()
  }
  const status = JSON.parse(fs.readFileSync(path.join(cloudDir(home), STATUS_FILE), 'utf-8'))
  assert.ok(status.lastPostAt)
  assert.equal(status.hub, `http://127.0.0.1:${hub.port}`)
  assert.equal((fs.statSync(path.join(cloudDir(home), ACKED_FILE)).mode & 0o777), 0o600)
})

test('without TEAM_MONITOR_INGEST_TOKEN a placeholder bearer is sent (the platform proxy replaces it)', async () => {
  const mon = await fakeMonitor()
  const hub = await fakeHub()
  const { make } = setup(mon.port, hub.port)
  mon.startSession(S1)
  mon.emit(S1, 1)
  const f = make({ env: {} })
  f.start()
  try {
    await waitFor(() => hub.events.length === 1)
    assert.ok(hub.auths.every((a) => a === `Bearer ${PLACEHOLDER_TOKEN}`))
  } finally {
    await f.stop(); await mon.close(); await hub.close()
  }
})

test('a reconnect to /events and a forwarder restart send no event twice; seq keeps increasing', async () => {
  const mon = await fakeMonitor()
  const hub = await fakeHub()
  const { make } = setup(mon.port, hub.port)
  mon.startSession(S1)
  mon.emit(S1, 5)
  let f = make()
  f.start()
  try {
    await waitFor(() => hub.events.length === 5)
    mon.dropClients()
    await waitFor(() => mon.clients.size === 1)
    mon.emit(S1, 2)
    await waitFor(() => hub.events.length === 7)
    await f.stop()
    const seqBefore = hub.seqs[hub.seqs.length - 1]

    mon.emit(S1, 3) // while no forwarder runs: only in the replay
    f = make()
    f.start()
    await waitFor(() => hub.events.length === 10)
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(ids(hub.events), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.ok(hub.seqs[hub.seqs.length - 1] > seqBefore)
  } finally {
    await f.stop(); await mon.close(); await hub.close()
  }
})

test('hub down: events wait and arrive once, in order, when it is back; a lost response is retried with the same seq', async () => {
  const mon = await fakeMonitor()
  const hub = await fakeHub()
  const { make, logs } = setup(mon.port, hub.port)
  hub.mode = 'down503'
  mon.startSession(S1)
  mon.emit(S1, 4)
  const f = make()
  f.start()
  try {
    await waitFor(() => logs.some((l) => l.includes('HTTP 503')))
    mon.emit(S1, 2)
    assert.equal(hub.events.length, 0)
    hub.mode = 'ok'
    await waitFor(() => hub.events.length === 6, 5000)

    hub.mode = 'dropAfterApply' // applied on the hub, but the reply never comes back
    mon.emit(S1, 1)
    await waitFor(() => logs.some((l) => l.includes('posting events') && !l.includes('503')), 5000)
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(ids(hub.events), [1, 2, 3, 4, 5, 6, 7])
    assert.equal(f.queued, 0)
    assert.ok(logs.some((l) => l.includes('hub reachable again')))
  } finally {
    await f.stop(); await mon.close(); await hub.close()
  }
})

test('a batch the hub refuses (400) is dropped with one log line and not sent again from a replay', async () => {
  const mon = await fakeMonitor()
  const hub = await fakeHub()
  const { make, logs } = setup(mon.port, hub.port)
  mon.startSession(S1)
  hub.mode = 'refuse400'
  mon.emit(S1, 2)
  const f = make()
  f.start()
  try {
    await waitFor(() => logs.some((l) => l.includes('hub refused')))
    mon.emit(S1, 1)
    await waitFor(() => hub.events.length >= 1)
    mon.dropClients()
    await waitFor(() => mon.clients.size === 1)
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(ids(hub.events), [3])
  } finally {
    await f.stop(); await mon.close(); await hub.close()
  }
})

test('at most maxQueue unsent messages are kept: the oldest are dropped with a log line', async () => {
  const mon = await fakeMonitor()
  const hub = await fakeHub()
  const { make, logs } = setup(mon.port, hub.port)
  hub.mode = 'unauthorized'
  const f = make({ maxQueue: 5 })
  f.start()
  try {
    await waitFor(() => mon.clients.size === 1)
    mon.startSession(S1)
    mon.emit(S1, 10)
    await waitFor(() => logs.some((l) => l.includes('unsent messages')))
    hub.mode = 'ok'
    await waitFor(() => hub.events.length > 0 && f.queued === 0, 5000)
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(hub.events.length <= 5)
    assert.deepEqual(ids(hub.events).slice(-3), [8, 9, 10])
  } finally {
    await f.stop(); await mon.close(); await hub.close()
  }
})

test('after a monitor restart the rebuilt history of a known session is not sent again; a new session is', async () => {
  const mon = await fakeMonitor()
  const hub = await fakeHub()
  let instance = 'm1'
  const { make } = setup(mon.port, hub.port, { monitorInstance: () => instance })
  mon.startSession(S1)
  mon.emit(S1, 3)
  const f = make()
  f.start()
  try {
    await waitFor(() => hub.events.length === 3)
    await f.stop()
    instance = 'm2'
    mon.rebuild()
    mon.startSession(S2)
    mon.emit(S2, 2)
    const g = make()
    g.start()
    try {
      await waitFor(() => hub.events.length === 5)
      mon.dropClients() // and the next reconnect in the same instance sends nothing again either
      await waitFor(() => mon.clients.size === 1)
      mon.emit(S1, 1)
      await waitFor(() => hub.events.length === 6)
      await new Promise((r) => setTimeout(r, 300))
      assert.deepEqual(hub.events.map((e) => e.sessionId), [S1, S1, S1, S2, S2, S1])
    } finally {
      await g.stop()
    }
  } finally {
    await mon.close(); await hub.close()
  }
})

test('state and .watcher are put on change; outbox files land in answers/ and inbox/ (checked names, unchanged not rewritten)', async () => {
  const mon = await fakeMonitor()
  const hub = await fakeHub()
  const { make, project } = setup(mon.port, hub.port)
  const f = make()
  f.start()
  try {
    await waitFor(() => hub.states.length === 1)
    assert.equal((hub.states[0].state as { meta: { title: string } }).meta.title, 'Proyek uji')
    assert.equal(hub.states[0].watcher, null)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(hub.states.length, 1, 'not sent again while unchanged')
    writeState(project, sampleState({ meta: { title: 'Baru', status: 'running', updatedAt: '2026-11-13T00:00:00.000Z' } }))
    const hb = { pid: 4242, startedAt: new Date().toISOString(), beatAt: new Date().toISOString() }
    fs.writeFileSync(path.join(project, '.agent-team', '.watcher'), JSON.stringify(hb))
    await waitFor(() => hub.states.length >= 2 && (hub.states[hub.states.length - 1].watcher as { pid?: number } | null)?.pid === 4242)

    const answer = JSON.stringify({ id: 'D1', answer: 'b', answeredAt: '2026-11-13T00:00:00.000Z' })
    const msg = JSON.stringify({ id: 'm1', text: 'halo', sentAt: '2026-11-13T00:00:00.000Z' })
    hub.setOutbox([
      { path: 'answers/D1.json', content: answer },
      { path: 'inbox/1763000000000-0123456789ab.json', content: msg },
      { path: 'answers/../../evil.json', content: 'x' },
      { path: 'inbox/notes.txt', content: 'x' },
      { path: 'state.json', content: '{}' },
    ])
    const team = path.join(project, '.agent-team')
    await waitFor(() => fs.existsSync(path.join(team, 'inbox', '1763000000000-0123456789ab.json')), 5000)
    assert.equal(fs.readFileSync(path.join(team, 'answers', 'D1.json'), 'utf-8'), answer)
    assert.equal(fs.readFileSync(path.join(team, 'inbox', '1763000000000-0123456789ab.json'), 'utf-8'), msg)
    assert.equal(fs.existsSync(path.join(root, 'evil.json')), false)
    assert.deepEqual(fs.readdirSync(path.join(team, 'inbox')), ['1763000000000-0123456789ab.json'])
    assert.equal(f.stats.filesWritten, 2)
  } finally {
    await f.stop(); await mon.close(); await hub.close()
  }
})

test('with HTTP_PROXY set every hub request goes through the CONNECT proxy; /events stays direct', async () => {
  const mon = await fakeMonitor()
  const hub = await fakeHub()
  const proxy = await fakeConnectProxy()
  const { make } = setup(mon.port, hub.port)
  mon.startSession(S1)
  mon.emit(S1, 2)
  const f = make({ env: { TEAM_MONITOR_INGEST_TOKEN: 'tok-123', HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } })
  f.start()
  try {
    await waitFor(() => hub.events.length === 2 && hub.states.length === 1)
    assert.ok(proxy.targets.length >= 2)
    assert.ok(proxy.targets.every((t) => t === `127.0.0.1:${hub.port}`), 'only the hub is tunnelled, not the monitor')
  } finally {
    await f.stop(); await proxy.close(); await mon.close(); await hub.close()
  }
})
