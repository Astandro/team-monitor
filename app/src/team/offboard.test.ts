/**
 * Offboard store and operations (spec offboard-names item 1), and the graph stream after a server restart.
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  OFFBOARD_FILE, OffboardError, OffboardRecord, OffboardStore, offboardAgent, offboardFinished,
  parseOffboardAllBody, parseOffboardBody,
} from './offboard'
import { GraphAgents, type GraphView } from '../../../scripts/graph-agents'
import type { AgentEvent, WatchedSession } from '../../../extension/src/protocol'
import { TranscriptParser } from '../../../extension/src/transcript-parser'
import { rebuildSubagentsOnAttach, type SubagentWatcherDelegate } from '../../../extension/src/subagent-watcher'
import { makeTmpDir, removeTmpDir } from './test-helpers'

const S = '7e23e8af-0000-4000-8000-0000000000aa'
const HIRO = 'Hiro (Frontend Engineer): panel'
const REN = 'Ren (Backend Engineer): store'
const MEI = 'Mei (QA Engineer): review'

const rec = (agent: string, extra: Partial<OffboardRecord> = {}): OffboardRecord => ({
  session: S, agent, project: 'proj', name: agent.split(' ')[0], role: 'Engineer', task: 't',
  finishedAt: '2026-11-13T01:00:00.000Z', offboardedAt: '2026-11-13T02:00:00.000Z', ...extra,
})

/** A graph view over a GraphAgents registry that records announcements. */
function fakeGraph(g: GraphAgents, project: string | null = 'proj') {
  const announced: Array<{ session: string; agents: string[] }> = []
  const view: GraphView = {
    agents: (sid) => g.agents(sid),
    sessionProject: () => project,
    announceOffboarded: (session, agents) => { announced.push({ session, agents }) },
  }
  return { view, announced }
}

function teamGraph(): GraphAgents {
  const g = new GraphAgents()
  const at = (type: AgentEvent['type'], payload: Record<string, unknown>, t: number) => g.observe({ time: 0, type, payload, sessionId: S }, t)
  at('agent_spawn', { name: 'orchestrator', isMain: true, task: 'Proyek' }, 1)
  at('agent_spawn', { name: HIRO, parent: 'orchestrator', task: 'panel', displayName: 'Hiro', role: 'Frontend Engineer' }, 2)
  at('agent_spawn', { name: REN, parent: 'orchestrator', task: 'store', displayName: 'Ren', role: 'Backend Engineer' }, 3)
  at('agent_spawn', { name: MEI, parent: 'orchestrator', task: 'review', displayName: 'Mei', role: 'QA Engineer' }, 4)
  at('agent_spawn', { name: 'Explore the code', parent: 'orchestrator', task: 'Explore the code' }, 5)
  at('agent_complete', { name: HIRO }, Date.parse('2026-11-13T03:00:00.000Z'))
  at('agent_complete', { name: REN }, Date.parse('2026-11-13T03:30:00.000Z'))
  at('agent_complete', { name: 'Explore the code' }, Date.parse('2026-11-13T03:40:00.000Z'))
  return g
}

const fixedNow = () => new Date('2026-11-13T04:00:00.000Z')

let home: string
let logs: string[]
beforeEach(() => { home = makeTmpDir(); logs = [] })
afterEach(() => removeTmpDir(home))

describe('OffboardStore', () => {
  test('starts empty without a file and writes nothing until something is added', () => {
    const s = new OffboardStore(home, (m) => logs.push(m))
    assert.deepEqual(s.list(), [])
    assert.equal(fs.existsSync(path.join(home, OFFBOARD_FILE)), false)
  })

  test('saves 0600, keyed by session and agent, and survives a reload', () => {
    const s = new OffboardStore(home)
    s.add([rec(HIRO), rec(REN, { offboardedAt: '2026-11-13T02:30:00.000Z' })])
    const file = path.join(home, OFFBOARD_FILE)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    assert.equal(raw.version, 1)
    assert.deepEqual(Object.keys(raw.sessions[S]).sort(), [HIRO, REN].sort())
    assert.equal(raw.sessions[S][HIRO].session, undefined, 'the keys are not repeated inside')
    const again = new OffboardStore(home)
    assert.equal(again.isOffboarded(S, HIRO), true)
    assert.equal(again.isOffboarded(S, MEI), false)
    assert.equal(again.isOffboarded('other', HIRO), false)
    assert.deepEqual(again.get(S, HIRO), rec(HIRO))
    assert.deepEqual(again.list().map((r) => r.agent), [REN, HIRO], 'newest offboarding first')
  })

  test('leaves no temp file behind', () => {
    const s = new OffboardStore(home)
    s.add([rec(HIRO)])
    s.add([rec(REN)])
    assert.deepEqual(fs.readdirSync(home).sort(), [OFFBOARD_FILE])
  })

  test('list filters by project and session', () => {
    const s = new OffboardStore(home)
    s.add([rec(HIRO), rec(REN, { project: 'lain' }), { ...rec(MEI), session: 'other-session' }])
    assert.deepEqual(s.list({ project: 'proj' }).map((r) => r.agent).sort(), [HIRO, MEI].sort())
    assert.deepEqual(s.list({ session: S }).map((r) => r.agent).sort(), [HIRO, REN].sort())
    assert.deepEqual(s.list({ project: 'proj', session: S }).map((r) => r.agent), [HIRO])
  })

  test('an agent called __proto__ stays a plain key', () => {
    const s = new OffboardStore(home)
    s.add([rec('__proto__')])
    assert.equal(new OffboardStore(home).isOffboarded(S, '__proto__'), true)
  })

  test('a broken file is reported, kept as .bad on the next save, and does not stop the store', () => {
    fs.writeFileSync(path.join(home, OFFBOARD_FILE), '{"sessions": {broken', { mode: 0o600 })
    const s = new OffboardStore(home, (m) => logs.push(m))
    assert.equal(s.list().length, 0)
    assert.ok(logs.some((l) => l.includes('not valid JSON')))
    assert.ok(!logs.some((l) => l.includes('broken')), 'no file content in the log')
    s.add([rec(HIRO)])
    assert.equal(fs.readFileSync(path.join(home, OFFBOARD_FILE + '.bad'), 'utf-8'), '{"sessions": {broken')
    assert.equal(new OffboardStore(home).isOffboarded(S, HIRO), true)
  })

  test('malformed entries are skipped, good ones kept', () => {
    const good = { project: null, name: 'Hiro', role: null, task: null, finishedAt: null, offboardedAt: '2026-11-13T00:00:00.000Z' }
    fs.writeFileSync(path.join(home, OFFBOARD_FILE), JSON.stringify({
      version: 1,
      sessions: { [S]: { [HIRO]: good, [REN]: { name: 5 } }, 'bad id!': { x: good }, other: 'nope' },
    }))
    const s = new OffboardStore(home, (m) => logs.push(m))
    assert.deepEqual(s.list().map((r) => r.agent), [HIRO])
    assert.ok(logs.some((l) => l.includes('3 malformed entries')))
  })

  test('a failed write leaves memory and disk unchanged', () => {
    const s = new OffboardStore(home)
    s.add([rec(HIRO)])
    fs.chmodSync(home, 0o500)
    try {
      assert.throws(() => s.add([rec(REN)]), (e: unknown) => e instanceof OffboardError && e.status === 500 && !e.message.includes(home))
    } finally {
      fs.chmodSync(home, 0o700)
    }
    assert.equal(s.isOffboarded(S, REN), false)
    assert.equal(new OffboardStore(home).isOffboarded(S, REN), false)
  })

  test('a symlink in place of the file is replaced, not followed', () => {
    const target = path.join(home, 'elsewhere.json')
    fs.writeFileSync(target, 'keep me')
    fs.symlinkSync(target, path.join(home, OFFBOARD_FILE))
    const s = new OffboardStore(home, (m) => logs.push(m))
    s.add([rec(HIRO)])
    assert.equal(fs.readFileSync(target, 'utf-8'), 'keep me')
    assert.equal(fs.lstatSync(path.join(home, OFFBOARD_FILE)).isFile(), true)
  })
})

describe('request bodies', () => {
  test('parseOffboardBody', () => {
    assert.deepEqual(parseOffboardBody({ session: S, agent: HIRO, extra: 1 }), { session: S, agent: HIRO })
    for (const [body, msg] of [
      [null, 'JSON object'], [[], 'JSON object'], ['x', 'JSON object'],
      [{ agent: HIRO }, 'session'], [{ session: '', agent: HIRO }, 'session'], [{ session: '../x', agent: HIRO }, 'session'],
      [{ session: 'a'.repeat(129), agent: HIRO }, 'session'], [{ session: 5, agent: HIRO }, 'session'],
      [{ session: S }, 'agent'], [{ session: S, agent: '' }, 'agent'], [{ session: S, agent: 3 }, 'agent'],
      [{ session: S, agent: 'x'.repeat(201) }, 'longer'],
    ] as Array<[unknown, string]>) {
      assert.throws(() => parseOffboardBody(body), (e: unknown) => e instanceof OffboardError && e.status === 400 && e.message.includes(msg), JSON.stringify(body))
    }
    assert.equal(parseOffboardBody({ session: S, agent: 'x'.repeat(200) }).agent.length, 200)
  })

  test('parseOffboardAllBody', () => {
    assert.deepEqual(parseOffboardAllBody({ session: S }), { session: S })
    assert.throws(() => parseOffboardAllBody({}), (e: unknown) => e instanceof OffboardError && e.status === 400)
  })
})

describe('offboardAgent / offboardFinished', () => {
  test('offboards a finished agent with its name, role, task and finish time, and announces it', () => {
    const store = new OffboardStore(home)
    const { view, announced } = fakeGraph(teamGraph())
    const { record, created } = offboardAgent(store, view, { session: S, agent: HIRO }, fixedNow)
    assert.equal(created, true)
    assert.deepEqual(record, {
      session: S, agent: HIRO, project: 'proj', name: 'Hiro', role: 'Frontend Engineer', task: 'panel',
      finishedAt: '2026-11-13T03:00:00.000Z', offboardedAt: '2026-11-13T04:00:00.000Z',
    })
    assert.equal(new OffboardStore(home).isOffboarded(S, HIRO), true)
    assert.deepEqual(announced, [{ session: S, agents: [HIRO] }])
  })

  test('an agent without an instance name falls back to its node name', () => {
    const store = new OffboardStore(home)
    const { record } = offboardAgent(store, fakeGraph(teamGraph(), null).view, { session: S, agent: 'Explore the code' }, fixedNow)
    assert.equal(record.name, 'Explore the code')
    assert.equal(record.role, null)
    assert.equal(record.project, null)
  })

  test('a second offboard returns the first record and writes nothing', () => {
    const store = new OffboardStore(home)
    const { view, announced } = fakeGraph(teamGraph())
    offboardAgent(store, view, { session: S, agent: HIRO }, fixedNow)
    const before = fs.statSync(path.join(home, OFFBOARD_FILE)).mtimeMs
    const again = offboardAgent(store, view, { session: S, agent: HIRO }, () => new Date('2027-01-01T00:00:00.000Z'))
    assert.equal(again.created, false)
    assert.equal(again.record.offboardedAt, '2026-11-13T04:00:00.000Z')
    assert.equal(fs.statSync(path.join(home, OFFBOARD_FILE)).mtimeMs, before)
    assert.equal(announced.length, 1)
  })

  test('refuses a running agent (409), the Orchestrator (400), unknown agents and sessions (404), no graph (503)', () => {
    const store = new OffboardStore(home)
    const { view } = fakeGraph(teamGraph())
    const status = (fn: () => unknown) => { try { fn(); return 0 } catch (e) { return (e as OffboardError).status } }
    assert.equal(status(() => offboardAgent(store, view, { session: S, agent: MEI })), 409)
    assert.equal(status(() => offboardAgent(store, view, { session: S, agent: 'orchestrator' })), 400)
    assert.equal(status(() => offboardAgent(store, view, { session: S, agent: 'Nobody (QA Engineer): x' })), 404)
    assert.equal(status(() => offboardAgent(store, view, { session: 'other', agent: HIRO })), 404)
    assert.equal(status(() => offboardAgent(store, null, { session: S, agent: HIRO })), 503)
    assert.equal(status(() => offboardFinished(store, view, 'other')), 404)
    assert.equal(fs.existsSync(path.join(home, OFFBOARD_FILE)), false, 'nothing written')
  })

  test('offboardFinished takes every finished sub-agent once, never running ones or the Orchestrator', () => {
    const store = new OffboardStore(home)
    const { view, announced } = fakeGraph(teamGraph())
    offboardAgent(store, view, { session: S, agent: HIRO }, fixedNow)
    const records = offboardFinished(store, view, S, fixedNow)
    assert.deepEqual(records.map((r) => r.agent).sort(), [REN, 'Explore the code'].sort())
    assert.equal(store.isOffboarded(S, MEI), false)
    assert.equal(store.isOffboarded(S, 'orchestrator'), false)
    assert.deepEqual(offboardFinished(store, view, S, fixedNow), [], 'nothing left')
    assert.equal(announced.length, 2, 'one announcement per call that offboarded something')
  })
})

// ─── Graph stream after a restart ───────────────────────────────────────────

function makeSession(filePath: string): WatchedSession {
  return {
    sessionId: S, filePath,
    fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(), seenToolUseIds: new Set(), seenMessageHashes: new Set(),
    sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), inactivityTimer: null,
    subagentWatchers: new Map(), spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null,
    subagentsDir: path.join(path.dirname(filePath), S, 'subagents'),
    label: 'Session', labelSet: true, model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

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

/**
 * What the relay does when it attaches a session (server start): pre-scan the main transcript, rebuild every
 * sub-agent from disk, and feed each event into the buffer and the registry. Returns the buffer.
 */
function attachSession(transcripts: string, g: GraphAgents): { buffer: AgentEvent[]; dispose: () => void } {
  const session = makeSession(path.join(transcripts, '-proj', `${S}.jsonl`))
  const buffer: AgentEvent[] = []
  const delegate: SubagentWatcherDelegate & ConstructorParameters<typeof TranscriptParser>[0] = {
    emit: (event, sessionId) => {
      const e = sessionId ? { ...event, sessionId } : event
      buffer.push(e)
      g.observe(e)
    },
    elapsed: () => 0,
    getLastActivityTime: () => Date.now(),
    getSession: (id) => (id === S ? session : undefined),
    resetInactivityTimer: () => {},
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(delegate)
  delegate.emit({ time: 0, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true, task: 'Proyek' } }, S)
  parser.prescanExistingContent(session.filePath, fs.statSync(session.filePath).size, session)
  rebuildSubagentsOnAttach(delegate, parser, S)
  return {
    buffer,
    dispose: () => {
      session.subagentsDirWatcher?.close()
      for (const st of session.subagentWatchers.values()) {
        st.watcher?.close()
        if (st.permissionTimer) clearTimeout(st.permissionTimer)
      }
    },
  }
}

describe('graph stream after a restart', () => {
  let transcripts: string
  beforeEach(() => {
    transcripts = makeTmpDir()
    const subDir = path.join(transcripts, '-proj', S, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const sub = (id: string, description: string, toolUseId: string, finished: boolean, body: string) => {
      fs.writeFileSync(path.join(subDir, `agent-${id}.jsonl`), body)
      fs.writeFileSync(path.join(subDir, `agent-${id}.meta.json`), JSON.stringify({ description, toolUseId, ...(finished ? { finished: true } : {}) }))
    }
    sub('a1', HIRO, 't1', true, subWork('x1', true))
    sub('a2', REN, 't2', true, subWork('x2', true))
    sub('a3', MEI, 't3', false, subWork('x3', false))
    fs.writeFileSync(path.join(transcripts, '-proj', `${S}.jsonl`),
      agentCall('t1', HIRO) + agentResult('t1') + agentCall('t2', REN) + agentResult('t2') + agentCall('t3', MEI))
  })
  afterEach(() => removeTmpDir(transcripts))

  test('an offboarded agent stays off the stream after the server restarts; others and running ones stay', () => {
    // First run: the team is rebuilt from disk, Hiro is offboarded, Mei (running) is refused.
    const g1 = new GraphAgents()
    const run1 = attachSession(transcripts, g1)
    try {
      const store1 = new OffboardStore(home)
      const { view } = fakeGraph(g1)
      assert.equal(g1.agent(S, HIRO)?.status, 'finished')
      assert.equal(g1.agent(S, MEI)?.status, 'running')
      assert.equal(g1.agent(S, REN)?.displayName, 'Ren', 'instance name parsed on the rebuilt spawn')
      offboardAgent(store1, view, { session: S, agent: HIRO })
      assert.throws(() => offboardAgent(store1, view, { session: S, agent: MEI }), (e: unknown) => (e as OffboardError).status === 409)
    } finally { run1.dispose() }

    // Restart: a new store from disk and a new registry; the replay a page load gets leaves Hiro out.
    const g2 = new GraphAgents()
    const run2 = attachSession(transcripts, g2)
    try {
      const store2 = new OffboardStore(home)
      const replay = g2.visibleEvents(run2.buffer, store2)
      const about = (name: string) => replay.filter((e) => [e.payload.name, e.payload.agent, e.payload.child].includes(name))
      assert.ok(run2.buffer.some((e) => e.payload.name === HIRO), 'the transcript still has Hiro (nothing deleted)')
      assert.equal(about(HIRO).length, 0, 'no event about Hiro is replayed')
      assert.ok(about(REN).some((e) => e.type === 'agent_spawn'))
      assert.ok(about(MEI).some((e) => e.type === 'agent_spawn'))
      assert.ok(replay.some((e) => e.payload.name === 'orchestrator'))
      // Transcripts are untouched by offboarding.
      assert.equal(fs.readFileSync(path.join(transcripts, '-proj', S, 'subagents', 'agent-a1.jsonl'), 'utf-8'), subWork('x1', true))
    } finally { run2.dispose() }
  })
})
