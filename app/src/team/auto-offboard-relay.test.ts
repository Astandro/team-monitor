/**
 * Auto offboarding through the real relay (spec ui-cleanup item 6): a temp HOME with a Claude session on disk, the
 * relay attaches it as after a restart, the catch-up sweep runs, a graph stream (SSE) is open, time moves on a fake
 * clock, the session ends (mocked inactivity timer). No real waiting for deadlines.
 *
 * The relay is a process singleton and reads HOME when it is loaded, so this file sets HOME first and loads it with
 * require(); `vscode` (imported by the hook server) is mapped to the same shim the build uses.
 */
import { test, after, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import type { AddressInfo } from 'net'
import { makeTmpDir, removeTmpDir } from './test-helpers'
import { AutoOffboarder, type AutoOffboardClock } from './auto-offboard'
import { OffboardStore, offboardAgent } from './offboard'
import { encodeProjectPath } from '../../../scripts/session-projects'
import { INACTIVITY_TIMEOUT_MS } from '../../../extension/src/constants'

const S = '7e23e8af-0000-4000-8000-0000000000dd'
const HIRO = 'Hiro (Frontend Engineer): panel'
const REN = 'Ren (Backend Engineer): store'
const MEI = 'Mei (QA Engineer): review'
const MIN = 60_000

const root = makeTmpDir()
const home = path.join(root, 'home')
const workspace = path.join(root, 'proj')
const tmHome = path.join(root, 'tm')
for (const d of [home, workspace, tmHome]) fs.mkdirSync(d, { recursive: true })

const line = (o: unknown) => JSON.stringify(o) + '\n'
const agentCall = (id: string, description: string) => line({
  type: 'assistant', uuid: `a-${id}`,
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'go' } }] },
})
const agentResult = (id: string) => line({
  type: 'user', uuid: `r-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
})
const subWork = (toolId: string, done: boolean) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/x' } }] } }) +
  (done ? line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] } }) : '')

const projDir = path.join(home, '.claude', 'projects', encodeProjectPath(workspace))
const subDir = path.join(projDir, S, 'subagents')
fs.mkdirSync(subDir, { recursive: true })
const now0 = Date.now()
const sub = (id: string, description: string, toolUseId: string, finished: boolean, body: string, mtime: number) => {
  const file = path.join(subDir, `agent-${id}.jsonl`)
  fs.writeFileSync(file, body)
  fs.writeFileSync(path.join(subDir, `agent-${id}.meta.json`), JSON.stringify({ description, toolUseId, ...(finished ? { finished: true } : {}) }))
  fs.utimesSync(file, new Date(mtime), new Date(mtime))
  return file
}
const hiroFile = sub('a1', HIRO, 't1', true, subWork('x1', true), now0 - 120 * MIN) // done 2 h ago (server was down)
const renFile = sub('a2', REN, 't2', true, subWork('x2', true), now0 - 30 * MIN)
const meiFile = sub('a3', MEI, 't3', false, subWork('x3', false), now0) // still working
fs.writeFileSync(path.join(projDir, `${S}.jsonl`),
  agentCall('t1', HIRO) + agentResult('t1') + agentCall('t2', REN) + agentResult('t2') + agentCall('t3', MEI))

const savedHome = process.env.HOME
process.env.HOME = home
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module') as { _resolveFilename: (req: string, ...rest: unknown[]) => string }
const origResolve = Module._resolveFilename
Module._resolveFilename = function (req: string, ...rest: unknown[]) {
  if (req === 'vscode') return path.join(__dirname, '..', '..', '..', 'scripts', 'vscode-shim.js')
  return origResolve.call(this, req, ...rest)
}

/** Fake time for the auto offboarder: real now plus an offset; its timers run when the test says so. */
let offset = 0
const timers = new Map<number, () => void>()
let seq = 0
const clock: AutoOffboardClock = {
  now: () => Date.now() + offset,
  setTimeout: (fn) => { timers.set(++seq, fn); return seq },
  clearTimeout: (h) => { timers.delete(h as number) },
}
const runTimers = () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn() }

const cleanups: Array<() => void> = []
after(() => {
  for (const fn of cleanups.reverse()) { try { fn() } catch { /* keep going */ } }
  Module._resolveFilename = origResolve
  process.env.HOME = savedHome
  removeTmpDir(root)
})

/** Let I/O run (real timers may be mocked) until `cond` holds or 5 s pass. */
async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}

type Msg = { type: string; [k: string]: unknown }

test('relay: catch-up at start, finishedAt on the stream, deadline sweep announced, session end finishes sub-agents', async () => {
  mock.timers.enable({ apis: ['setTimeout'] }) // the relay's inactivity timer
  cleanups.push(() => mock.timers.reset())
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRelay } = require('../../../scripts/relay') as typeof import('../../../scripts/relay')
  const store = new OffboardStore(tmHome)
  const relay = await createRelay({ workspace, runtime: 'claude', offboarded: store, autoOffboardMinutes: 60 })
  cleanups.push(() => relay.dispose())

  // Catch-up: Hiro finished 2 h ago (its transcript's last write), so it goes before anyone connects.
  const auto = new AutoOffboarder(store, relay.graph, 60, { clock, log: () => {} })
  cleanups.push(() => auto.stop())
  const caught = auto.start()
  assert.deepEqual(caught.map((r) => [r.agent, r.reason]), [[HIRO, 'auto']])
  assert.equal(caught[0].finishedAt, new Date(fs.statSync(hiroFile).mtimeMs).toISOString(), 'finishedAt = last write')

  // A viewer connects: Hiro is not replayed; Ren's completion carries finished/finishedAt/autoOffboardAt.
  const server = http.createServer((req, res) => relay.handleSSE(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  cleanups.push(() => { server.closeAllConnections(); server.close() })
  const msgs: Msg[] = []
  const req = http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/events' }, (res) => {
    let buf = ''
    res.setEncoding('utf-8')
    res.on('data', (chunk: string) => {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        if (block.startsWith('data: ')) msgs.push(JSON.parse(block.slice(6)) as Msg)
      }
    })
  })
  req.on('error', () => {})
  cleanups.push(() => req.destroy())
  await until(() => msgs.some((m) => m.type === 'agent-event-batch'), 'the replay')
  const replay = (msgs.find((m) => m.type === 'agent-event-batch')!.events as Array<{ type: string; payload: Record<string, unknown> }>)
  assert.equal(replay.filter((e) => e.payload.name === HIRO).length, 0, 'Hiro is not replayed')
  const renDone = replay.find((e) => e.type === 'agent_complete' && e.payload.name === REN)
  assert.ok(renDone, 'Ren is replayed as finished')
  const renFinished = new Date(fs.statSync(renFile).mtimeMs).toISOString()
  assert.equal(renDone!.payload.finished, true)
  assert.equal(renDone!.payload.finishedAt, renFinished)
  assert.equal(renDone!.payload.autoOffboardAt, new Date(Date.parse(renFinished) + 60 * MIN).toISOString())
  assert.ok(!replay.some((e) => e.type === 'agent_complete' && e.payload.name === MEI), 'Mei is running')

  // 31 minutes later Ren's hour is up: offboarded by the server, open streams told.
  offset = 31 * MIN
  runTimers()
  assert.equal(store.get(S, REN)?.reason, 'auto')
  await until(() => msgs.some((m) => m.type === 'agents-offboarded'), 'agents-offboarded')
  assert.deepEqual(msgs.filter((m) => m.type === 'agents-offboarded'), [{ type: 'agents-offboarded', sessionId: S, agents: [REN] }])

  // Mei is running: never auto offboarded, and the Offboard button is refused.
  offset = 1000 * MIN
  runTimers()
  assert.equal(store.isOffboarded(S, MEI), false)
  assert.throws(() => offboardAgent(store, relay.graph, { session: S, agent: MEI }), /still running/)

  // The session ends (no writes for INACTIVITY_TIMEOUT_MS): Mei is finished by the server too.
  const before = msgs.length
  mock.timers.tick(INACTIVITY_TIMEOUT_MS)
  await until(() => msgs.slice(before).some((m) => m.type === 'agent-event' && (m.event as { type: string }).type === 'agent_complete'
    && (m.event as { payload: { name: string } }).payload.name === 'orchestrator'), 'the session end')
  const meiDone = msgs.slice(before).find((m) => m.type === 'agent-event' && (m.event as { payload: { name: string } }).payload.name === MEI)
  assert.ok(meiDone, 'Mei gets a completion when the session ends')
  const p = (meiDone!.event as { type: string; payload: Record<string, unknown> })
  assert.equal(p.type, 'agent_complete')
  assert.equal(p.payload.sessionEnded, true)
  assert.equal(p.payload.finished, true)
  assert.equal(p.payload.finishedAt, new Date(fs.statSync(meiFile).mtimeMs).toISOString(), 'finished at its last write')
  assert.equal(relay.graph.agents(S)!.find((a) => a.name === MEI)?.status, 'finished')
  const meiOrder = msgs.indexOf(meiDone!)
  const mainOrder = msgs.findIndex((m, i) => i >= before && m.type === 'agent-event' && (m.event as { payload: { name: string } }).payload.name === 'orchestrator')
  assert.ok(meiOrder < mainOrder, 'sub-agents finish before the Orchestrator')

  // Mei writes again (a resume): she runs again, so her clock does not count while she works.
  fs.appendFileSync(meiFile, line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x3', content: 'ok' }] } }))
  await until(() => relay.graph.agents(S)!.find((a) => a.name === MEI)?.status === 'running', 'Mei to run again')
  offset = 5000 * MIN
  runTimers()
  assert.equal(store.isOffboarded(S, MEI), false, 'running again: not offboarded')
})
