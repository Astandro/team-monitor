/**
 * End to end on one machine with real processes (acceptance criteria 7 and 9, and 5 through the real forwarder):
 *
 * - a "container": `cloud start` (CLAUDE_CODE_REMOTE=true, its own HOME and team home, a free port) with
 *   TEAM_MONITOR_HUB_URL pointing at a hub port where nothing listens yet;
 * - `cloud start` returns 0 within 5 s with one line; a second run leaves one monitor and one forwarder; a stale
 *   pid file (a live pid that is not ours) is replaced;
 * - a Claude session transcript appears in the container's ~/.claude/projects;
 * - the hub starts (`--ingest`, another HOME and team home, another free port): the session shows in its /events
 *   for a new client, marked cloud, and the project in /api/team/projects; no event arrives twice, also after the
 *   forwarder is restarted;
 * - a decision answer and a chat message sent on the hub reach the container: `wait-answer` exits 0 with them;
 * - a second forwarder with the same sourceId but another source key gets 403 for events, state and outbox: the
 *   hub's state, project name and events stay as they were, and it does not receive the answer;
 * - the hub restarts: the idle session reappears with its label, prompt and full history, nothing twice;
 * - `cloud stop` stops both; nothing is left running.
 *
 * Processes run from an esbuild bundle of app/src/app.ts made in the temp dir (as app/build.js does, without the
 * webview), so `cloud start` starts its children exactly as it does from a release.
 */
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { ChildProcess, spawn } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as path from 'path'
import { encodeProjectPath } from '../../../scripts/session-projects'
import { FORWARDER_FILE } from './cloud'
import { cloudDir, MONITOR_FILE } from './cloud-forwarder'
import { buildAppBundle, makeProject, makeTmpDir, removeTmpDir, request, sampleState, waitFor } from './test-helpers'

const REPO = path.resolve(__dirname, '..', '..', '..')
const S = 'e2e00000-0000-4000-8000-00000000c10d'
const SOURCE = 'session-e2etest01'
const linux = process.platform === 'linux' && fs.existsSync('/proc/self/cmdline')

const root = makeTmpDir()
const APP = buildAppBundle(path.join(root, 'dist'))
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

/** A clean environment: nothing from this machine's Claude session, no proxy. */
function baseEnv(home: string, tmHome: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TEAM_MONITOR_HOME: tmHome, ...extra }
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd = REPO, timeoutMs = 30_000): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const c = spawn(process.execPath, [APP, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', (d: Buffer) => { out += d })
    c.stderr.on('data', (d: Buffer) => { err += d })
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs)
    // 'exit', not 'close': a detached grandchild must not be able to hold this open (it never gets our pipes).
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err, ms: Date.now() - t0 }) })
  })
}

/** Messages a new /events client receives within `ms`. */
function sse(port: number, ms: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const msgs: Array<Record<string, unknown>> = []
    const req = http.get({ host: '127.0.0.1', port, path: '/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let buf = ''
      res.setEncoding('utf-8')
      res.on('data', (c: string) => {
        buf += c
        let i: number
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          if (block.startsWith('data: ')) { try { msgs.push(JSON.parse(block.slice(6))) } catch { /* partial */ } }
        }
      })
    })
    req.on('error', () => resolve(msgs))
    setTimeout(() => { req.destroy(); resolve(msgs) }, ms)
  })
}

function eventsOf(msgs: Array<Record<string, unknown>>, sid: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of msgs) {
    if (m.type === 'agent-event-batch') out.push(...(m.events as Array<Record<string, unknown>>).filter((e) => e.sessionId === sid))
    if (m.type === 'agent-event' && (m.event as { sessionId?: string }).sessionId === sid) out.push(m.event as Record<string, unknown>)
  }
  return out
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

async function healthy(port: number): Promise<boolean> {
  try { return (await request(port, { path: '/api/team/projects' })).status === 200 } catch { return false }
}

async function waitAsync(cond: () => Promise<boolean>, timeoutMs: number, stepMs = 200): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

const line = (o: unknown) => JSON.stringify(o) + '\n'
let toolN = 0
function turn(): string {
  const id = `toolu_${++toolN}`
  return line({ type: 'assistant', uuid: `a-${id}`, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/x' } }] } }) +
    line({ type: 'user', uuid: `u-${id}`, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
}

test('cloud mode end to end: container monitor + forwarder to a hub on another port and home', { skip: linux ? false : 'needs Linux /proc', timeout: 180_000 }, async () => {
  const hubPort = await freePort()
  const boxPort = await freePort()
  const hubHome = path.join(root, 'hub-home')
  const hubTm = path.join(root, 'hub-tm')
  const boxHome = path.join(root, 'box-home')
  const boxTm = path.join(root, 'box-tm')
  for (const d of [hubHome, hubTm, boxHome, boxTm]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  const project = makeProject(path.join(root, 'work'), 'cloudproj', sampleState())
  // The hub's ingest token exists before the hub first starts (the hub keeps an existing one).
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(path.join(hubTm, 'ingest-token'), token + '\n', { mode: 0o600 })

  const boxEnv = baseEnv(boxHome, boxTm, {
    CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: 'session_E2eTest01',
    TEAM_MONITOR_HUB_URL: `http://127.0.0.1:${hubPort}`, TEAM_MONITOR_INGEST_TOKEN: token,
  })
  const dir = cloudDir(boxTm)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // A stale forwarder pid file: the pid is alive but not a forwarder (this test process).
  fs.writeFileSync(path.join(dir, FORWARDER_FILE), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port: boxPort }))

  let hub: ChildProcess | null = null
  try {
    // ── criterion 7: hub down, cloud start still returns 0 quickly with one line ──
    const first = await run(['cloud', 'start', '--project', project, '--port', String(boxPort)], boxEnv)
    assert.equal(first.code, 0, first.err)
    assert.ok(first.ms < 5000, `cloud start took ${first.ms} ms`)
    assert.equal(first.out.trim().split('\n').length, 1, first.out)
    assert.match(first.out, /monitor (started|still starting) on http:\/\/127\.0\.0\.1:\d+; forwarder started to http:\/\/127\.0\.0\.1:\d+/)
    await waitAsync(() => healthy(boxPort), 15_000)

    const second = await run(['cloud', 'start', '--project', project, '--port', String(boxPort)], boxEnv)
    assert.equal(second.code, 0)
    assert.match(second.out, /monitor running on .*; forwarder running to /)
    assert.equal(second.out.trim().split('\n').length, 1)
    const portArgs = ['--port', String(boxPort)]
    const monitors = () => pidsWith(['--cloud', ...portArgs])
    const forwarders = () => pidsWith(['cloud', 'forward', ...portArgs])
    assert.equal(monitors().length, 1)
    assert.equal(forwarders().length, 1)
    const logMode = fs.statSync(path.join(dir, 'monitor.log')).mode & 0o777
    assert.equal(logMode, 0o600)

    // ── a Claude session in the container ──
    const tdir = path.join(boxHome, '.claude', 'projects', encodeProjectPath(project))
    fs.mkdirSync(tdir, { recursive: true })
    const transcript = path.join(tdir, `${S}.jsonl`)
    fs.writeFileSync(transcript, line({ type: 'user', uuid: 'u0', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Bangun fitur cloud' } }) + turn() + turn())
    await waitAsync(async () => eventsOf(await sse(boxPort, 400), S).length >= 2, 20_000)
    fs.appendFileSync(transcript, turn()) // live events too, not only the catch-up
    await waitAsync(async () => eventsOf(await sse(boxPort, 400), S).length >= 4, 20_000)
    await new Promise((r) => setTimeout(r, 1500)) // the forwarder is retrying against the closed hub port

    // ── criterion 9: the hub starts; the session and project show up there ──
    hub = spawn(process.execPath, [APP, '--ingest', '--no-open', '--port', String(hubPort)], {
      env: baseEnv(hubHome, hubTm), cwd: REPO, stdio: 'ignore',
    })
    started.push(hub)
    await waitAsync(() => healthy(hubPort), 20_000)

    const hubSession = async () => {
      const msgs = await sse(hubPort, 400)
      const list = msgs.find((m) => m.type === 'session-list') as { sessions?: Array<Record<string, unknown>> } | undefined
      return { session: list?.sessions?.find((s) => s.id === S), events: eventsOf(msgs, S) }
    }
    await waitAsync(async () => (await hubSession()).session !== undefined, 40_000, 500)
    const seen = await hubSession()
    assert.equal(seen.session?.origin, 'cloud')
    assert.equal(seen.session?.sourceId, SOURCE)

    const projectId = `cloud-${SOURCE}`
    await waitAsync(async () => {
      const r = await request(hubPort, { path: '/api/team/projects' })
      return (JSON.parse(r.body).projects as Array<{ id: string }>).some((p) => p.id === projectId)
    }, 40_000, 500)
    // The state comes with its own retry (the events may have registered the project first).
    const hubState = async () => JSON.parse((await request(hubPort, { path: `/api/team/state?project=${projectId}` })).body)
    await waitAsync(async () => (await hubState()).state !== null, 40_000, 500)
    assert.equal((await hubState()).state.approvals.D1.status, 'open')

    // Same events on both sides, none twice.
    const same = async () => {
      const box = eventsOf(await sse(boxPort, 400), S).length
      const h = (await hubSession()).events.length
      return box > 0 && box === h
    }
    await waitAsync(same, 20_000, 500)

    // A forwarder restart (killed, then cloud start again) sends nothing twice; new events still arrive.
    const [fpid] = forwarders()
    process.kill(fpid, 'SIGTERM')
    await waitFor(() => forwarders().length === 0, 5000)
    const before = eventsOf(await sse(boxPort, 400), S).length
    fs.appendFileSync(transcript, turn())
    await waitAsync(async () => eventsOf(await sse(boxPort, 400), S).length > before, 20_000)
    const third = await run(['cloud', 'start', '--project', project, '--port', String(boxPort)], boxEnv)
    assert.equal(third.code, 0)
    assert.match(third.out, /monitor running .*; forwarder started/)
    await waitAsync(same, 20_000, 500)
    await new Promise((r) => setTimeout(r, 1500))
    assert.ok(await same(), 'hub and container agree after the restart')
    assert.equal(forwarders().length, 1)

    // ── criterion 5 (forwarder half): answer and chat travel back; wait-answer exits 0 ──
    // As the hub UI sends them (same origin, X-Team-Monitor).
    const uiHeaders = { 'Content-Type': 'application/json', 'X-Team-Monitor': '1', Origin: `http://127.0.0.1:${hubPort}` }
    const answer = await request(hubPort, { method: 'POST', path: '/api/team/answer', headers: uiHeaders, body: JSON.stringify({ project: projectId, id: 'D1', answer: 'b' }) })
    assert.equal(answer.status, 200, answer.body)
    const waitA = await run(['wait-answer', '--project', project, '--timeout', '30', '--answers-only'], boxEnv)
    assert.equal(waitA.code, 0, waitA.err)
    assert.match(waitA.out, /D1\.json/)
    assert.match(waitA.out, /"answer":\s*"b"/)

    const waitingMsg = run(['wait-answer', '--project', project, '--timeout', '30', '--only-new'], boxEnv)
    await new Promise((r) => setTimeout(r, 2000))
    const msg = await request(hubPort, { method: 'POST', path: '/api/team/message', headers: uiHeaders, body: JSON.stringify({ project: projectId, text: 'Halo dari hub' }) })
    assert.equal(msg.status, 200, msg.body)
    const waitM = await waitingMsg
    assert.equal(waitM.code, 0, waitM.err)
    assert.match(waitM.out, /Halo dari hub/)

    // ── A second forwarder for the same sourceId but with another source key (its own home) can neither write the
    //    source (events, state, name) nor read its outbox (the D1 answer) ──
    const evilHome = path.join(root, 'evil-home')
    const evilTm = path.join(root, 'evil-tm')
    for (const d of [evilHome, evilTm]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    const evilProject = makeProject(path.join(root, 'evil-work'), 'palsu', sampleState({ meta: { title: 'Proyek palsu', status: 'running', updatedAt: '2026-11-14T00:00:00.000Z' } }))
    const evilLog = path.join(root, 'evil-forwarder.log')
    const evilFd = fs.openSync(evilLog, 'a', 0o600)
    const evil = spawn(process.execPath, [APP, 'cloud', 'forward', '--project', evilProject, '--port', String(boxPort)], {
      env: baseEnv(evilHome, evilTm, {
        CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_SESSION_ID: 'session_E2eTest01',
        TEAM_MONITOR_HUB_URL: `http://127.0.0.1:${hubPort}`, TEAM_MONITOR_INGEST_TOKEN: token,
      }),
      cwd: REPO, stdio: ['ignore', evilFd, evilFd],
    })
    fs.closeSync(evilFd)
    started.push(evil)
    try {
      await waitAsync(async () => /HTTP 403/.test(fs.readFileSync(evilLog, 'utf-8')), 20_000, 300)
      await new Promise((r) => setTimeout(r, 3000)) // events, state and outbox all tried and refused
      const evilText = fs.readFileSync(evilLog, 'utf-8')
      assert.match(evilText, /posting events: HTTP 403/)
      assert.match(evilText, /sending state: HTTP 403/)
      assert.match(evilText, /reading the outbox: HTTP 403/)
      assert.equal((await hubState()).state.meta.title, 'Proyek uji', 'state not overwritten')
      const listed = JSON.parse((await request(hubPort, { path: '/api/team/projects' })).body).projects as Array<{ id: string; name: string }>
      assert.equal(listed.find((p) => p.id === projectId)?.name, 'cloudproj', 'not renamed')
      assert.equal(fs.existsSync(path.join(evilProject, '.agent-team', 'answers', 'D1.json')), false, 'the outbox was not read')
      assert.ok(await same(), 'no events from the second forwarder')
      assert.ok(!evilText.includes(token), 'token never logged')
    } finally {
      evil.kill('SIGTERM')
      await new Promise((r) => { if (evil.exitCode !== null || evil.signalCode !== null) r(null); else evil.once('exit', r) })
    }

    // ── Hub restart: the idle session reappears with its label, prompt and history, without a new event ──
    const beforeRestart = (await hubSession()).session!
    hub.kill('SIGTERM')
    await new Promise((r) => { if (hub!.exitCode !== null || hub!.signalCode !== null) r(null); else hub!.once('exit', r) })
    hub = spawn(process.execPath, [APP, '--ingest', '--no-open', '--port', String(hubPort)], {
      env: baseEnv(hubHome, hubTm), cwd: REPO, stdio: 'ignore',
    })
    started.push(hub)
    await waitAsync(() => healthy(hubPort), 20_000)
    await waitAsync(async () => (await hubSession()).session !== undefined, 40_000, 500)
    await waitAsync(same, 40_000, 500)
    const afterRestart = (await hubSession()).session!
    assert.equal(afterRestart.label, beforeRestart.label)
    assert.equal(afterRestart.prompt, beforeRestart.prompt)
    assert.ok(typeof afterRestart.prompt === 'string' && afterRestart.prompt.length > 0, 'with its prompt')
    assert.equal(afterRestart.origin, 'cloud')
    await new Promise((r) => setTimeout(r, 1500))
    assert.ok(await same(), 'history complete and nothing twice after the hub restart')

    // cloud status reports a successful post
    const status = await run(['cloud', 'status', '--port', String(boxPort)], boxEnv)
    assert.equal(status.code, 0)
    assert.match(status.out, /Monitor: healthy/)
    assert.match(status.out, /Forwarder: running/)
    assert.match(status.out, /Last successful post: \d{4}-/)
    assert.match(status.out, /Hub restarts seen: 1/)
    assert.ok(!status.out.includes(token) && !fs.readFileSync(path.join(dir, 'forwarder.log'), 'utf-8').includes(token), 'token never printed or logged')
  } catch (e) {
    // Show the children's logs with the failure (they hold no token: see the assertion above).
    const tail = (f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf-8').split('\n').slice(-15).join('\n') } catch { return '(none)' } }
    ;(e as Error).message += `\n--- monitor.log\n${tail('monitor.log')}\n--- forwarder.log\n${tail('forwarder.log')}`
    throw e
  } finally {
    const stop = await run(['cloud', 'stop'], boxEnv)
    if (stop.code !== 0) console.error(`cloud stop exited ${stop.code}: ${stop.err}`)
    if (hub) {
      hub.kill('SIGTERM')
      await new Promise((r) => { if (hub!.exitCode !== null) r(null); else hub!.once('exit', r) })
    }
  }
  assert.match(fs.readFileSync(path.join(dir, 'monitor.log'), 'utf-8'), /Cloud mode: any Host header accepted/)
  await waitFor(() => pidsWith(['--port', String(boxPort)]).length === 0 && pidsWith(['--port', String(hubPort)]).length === 0, 8000)
  assert.equal(fs.existsSync(path.join(dir, MONITOR_FILE)), false)
  assert.equal(fs.existsSync(path.join(dir, FORWARDER_FILE)), false)
})
