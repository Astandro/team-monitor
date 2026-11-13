/**
 * Rebuilding a session's subagents when it is attached (server restart, late page load).
 *
 * Before: the pre-scan of the main transcript put every Agent child name into
 * spawnedSubagents without emitting anything, and the initial subagent scan only
 * spawned files with unmatched tool calls that were not "already spawned". After a
 * restart the graph therefore showed the Orchestrator alone. Now every transcript
 * under subagents/ gets a node; finished ones are completed (dimmed) at once.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TranscriptParser, TranscriptParserDelegate } from '../src/transcript-parser'
import { AgentEvent, WatchedSession } from '../src/protocol'
import {
  SubagentWatcherDelegate, rebuildSubagentsOnAttach, scanSubagentsDir,
  isSubagentFinishedAtAttach, readSubagentMeta,
} from '../src/subagent-watcher'

const SESSION_ID = '7e23e8af-0000-4000-8000-000000000001'

function makeSession(filePath: string): WatchedSession {
  return {
    sessionId: SESSION_ID, filePath,
    fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(), seenToolUseIds: new Set(), seenMessageHashes: new Set(),
    sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), inactivityTimer: null,
    subagentWatchers: new Map(), spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null,
    subagentsDir: path.join(path.dirname(filePath), SESSION_ID, 'subagents'),
    label: 'Session', labelSet: true, model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

const line = (o: unknown) => JSON.stringify(o) + '\n'
const agentCall = (id: string, description: string) => line({
  type: 'assistant', uuid: `a-${id}`,
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [
    { type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'do it' } },
  ] },
})
const agentResult = (id: string, async: boolean) => line({
  type: 'user', uuid: `r-${id}`,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: async ? 'launched' : 'done' }] },
  ...(async ? { toolUseResult: { status: 'async_launched' } } : {}),
})
const notification = (id: string) => line({
  type: 'user', uuid: `n-${id}`,
  message: { role: 'user', content: `<task-notification><tool-use-id>${id}</tool-use-id><status>completed</status><result>ok</result></task-notification>` },
})
const subLine = (toolId: string, withResult: boolean) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/x' } }] } }) +
  (withResult ? line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] } }) : '')

let root: string
let session: WatchedSession
let events: AgentEvent[]
let delegate: SubagentWatcherDelegate & TranscriptParserDelegate
let parser: TranscriptParser

function writeSub(id: string, meta: Record<string, unknown>, body: string) {
  fs.mkdirSync(session.subagentsDir!, { recursive: true })
  fs.writeFileSync(path.join(session.subagentsDir!, `agent-${id}.jsonl`), body)
  fs.writeFileSync(path.join(session.subagentsDir!, `agent-${id}.meta.json`), JSON.stringify(meta))
}

function attach(mainTranscript: string) {
  fs.mkdirSync(path.dirname(session.filePath), { recursive: true })
  fs.writeFileSync(session.filePath, mainTranscript)
  parser.prescanExistingContent(session.filePath, fs.statSync(session.filePath).size, session)
  rebuildSubagentsOnAttach(delegate, parser, SESSION_ID)
}

const names = (type: string) => events.filter((e) => e.type === type).map((e) => (e.payload as { name: string }).name).sort()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-subagent-rebuild-'))
  events = []
  session = makeSession(path.join(root, '-proj', `${SESSION_ID}.jsonl`))
  delegate = {
    emit: (event) => { events.push(event) },
    elapsed: () => 0,
    getLastActivityTime: () => Date.now(),
    getSession: (id) => (id === SESSION_ID ? session : undefined),
    resetInactivityTimer: () => {},
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  parser = new TranscriptParser(delegate)
})

afterEach(() => {
  session.subagentsDirWatcher?.close()
  for (const state of session.subagentWatchers.values()) {
    state.watcher?.close()
    if (state.permissionTimer) clearTimeout(state.permissionTimer)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('rebuildSubagentsOnAttach', () => {
  beforeEach(() => {
    // A: background, notified, meta finished. B: background, still running.
    // C: sync, returned, old meta without `finished`. D: sync, still running.
    writeSub('aaa', { description: 'Mei: review', toolUseId: 'tA', finished: true, pickedEffortModel: 'claude-opus-5-5' }, subLine('s1', true))
    writeSub('bbb', { description: 'Kaito: tema', toolUseId: 'tB', pickedEffortModel: 'claude-opus-5-5' }, subLine('s2', true))
    writeSub('ccc', { description: 'Aoi: label', toolUseId: 'tC' }, subLine('s3', true))
    writeSub('ddd', { description: 'Yuki: panel', toolUseId: 'tD' }, subLine('s4', true))
    attach(
      agentCall('tA', 'Mei: review') + agentResult('tA', true) +
      agentCall('tB', 'Kaito: tema') + agentResult('tB', true) +
      agentCall('tC', 'Aoi: label') + agentResult('tC', false) +
      agentCall('tD', 'Yuki: panel') + notification('tA'),
    )
  })

  it('spawns a node for every subagent transcript, under the Orchestrator', () => {
    const spawns = events.filter((e) => e.type === 'agent_spawn')
    assert.deepEqual(spawns.map((e) => (e.payload as { name: string }).name).sort(),
      ['Aoi: label', 'Kaito: tema', 'Mei: review', 'Yuki: panel'])
    for (const s of spawns) assert.equal((s.payload as { parent: string }).parent, 'orchestrator')
  })

  it('completes (dims) only the finished ones, running ones stay live', () => {
    assert.deepEqual(names('agent_complete'), ['Aoi: label', 'Mei: review'])
  })

  it('reports the model from the meta sidecar', () => {
    const models = events.filter((e) => e.type === 'model_detected').map((e) => (e.payload as { agent: string }).agent).sort()
    assert.deepEqual(models, ['Kaito: tema', 'Mei: review'])
  })

  it('does not spawn them again on the next periodic scan', () => {
    const before = events.length
    scanSubagentsDir(delegate, parser, SESSION_ID)
    assert.equal(events.length, before)
  })
})

describe('isSubagentFinishedAtAttach', () => {
  const idle = { metaFinished: false, pendingInFile: 0, launchPending: false, backgroundRunning: false }
  it('trusts finished: true in the meta', () => {
    assert.equal(isSubagentFinishedAtAttach({ ...idle, metaFinished: true, backgroundRunning: true }), true)
  })
  it('counts it running while any sign of work is left', () => {
    assert.equal(isSubagentFinishedAtAttach({ ...idle, pendingInFile: 1 }), false)
    assert.equal(isSubagentFinishedAtAttach({ ...idle, launchPending: true }), false)
    assert.equal(isSubagentFinishedAtAttach({ ...idle, backgroundRunning: true }), false)
  })
  it('counts it finished when nothing is left', () => {
    assert.equal(isSubagentFinishedAtAttach(idle), true)
  })
})

describe('readSubagentMeta', () => {
  it('reads toolUseId, finished and a real model id; ignores aliases and missing files', () => {
    writeSub('m1', { toolUseId: 't1', finished: true, model: 'opus', pickedEffortModel: 'claude-opus-5-5' }, '')
    writeSub('m2', { model: 'opus' }, '')
    const dir = session.subagentsDir!
    assert.deepEqual(readSubagentMeta(path.join(dir, 'agent-m1.jsonl')), { toolUseId: 't1', finished: true, model: 'claude-opus-5-5' })
    assert.deepEqual(readSubagentMeta(path.join(dir, 'agent-m2.jsonl')), { toolUseId: undefined, finished: false, model: undefined })
    assert.deepEqual(readSubagentMeta(path.join(dir, 'agent-none.jsonl')), {})
  })
})
