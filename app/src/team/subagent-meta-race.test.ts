// A sub-agent transcript that appears before its .meta.json (seen in a cloud session, 15 Nov 2026) must not become a
// second node next to the one the main transcript already named from its Agent call ("subagent-174432" beside
// "Thorvald (QA Engineer): ...").
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import type { AgentEvent, WatchedSession } from '../../../extension/src/protocol'
import { TranscriptParser } from '../../../extension/src/transcript-parser'
import { scanSubagentsDir, unclaimedSubagentNames, type SubagentWatcherDelegate } from '../../../extension/src/subagent-watcher'
import { makeTmpDir, removeTmpDir } from './test-helpers'

const S = '7e23e8af-0000-4000-8000-0000000000bb'
const ING = 'Ignatius (Backend Engineer): engine'
const QA = 'Thorvald (QA Engineer): QA phase 3'

let root: string | null = null
afterEach(() => { if (root) removeTmpDir(root); root = null })

function makeSession(dir: string): WatchedSession {
  return {
    sessionId: S, filePath: path.join(dir, `${S}.jsonl`),
    fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(), seenToolUseIds: new Set(), seenMessageHashes: new Set(),
    sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), inactivityTimer: null,
    subagentWatchers: new Map(), spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null,
    subagentsDir: path.join(dir, S, 'subagents'),
    label: 'Session', labelSet: true, model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

const working = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/x' } }] } }) + '\n'

function run(setup: (subDir: string, session: WatchedSession) => void): { events: AgentEvent[]; session: WatchedSession } {
  root = makeTmpDir()
  const session = makeSession(root)
  const subDir = session.subagentsDir!
  fs.mkdirSync(subDir, { recursive: true })
  const events: AgentEvent[] = []
  const delegate: SubagentWatcherDelegate & ConstructorParameters<typeof TranscriptParser>[0] = {
    emit: (event) => { events.push(event) },
    elapsed: () => 0,
    getLastActivityTime: () => Date.now(),
    getSession: (id) => (id === S ? session : undefined),
    resetInactivityTimer: () => {},
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  setup(subDir, session)
  try {
    scanSubagentsDir(delegate, new TranscriptParser(delegate), S)
  } finally {
    session.subagentsDirWatcher?.close()
    for (const st of session.subagentWatchers.values()) {
      st.watcher?.close()
      if (st.permissionTimer) clearTimeout(st.permissionTimer)
    }
  }
  return { events, session }
}

test('unclaimedSubagentNames: dispatched names without a watched transcript', () => {
  assert.deepEqual(unclaimedSubagentNames([ING, QA], [ING]), [QA])
  assert.deepEqual(unclaimedSubagentNames([ING, QA], [ING, QA]), [])
  assert.deepEqual(unclaimedSubagentNames([], []), [])
})

test('a transcript without its .meta.json yet takes the one dispatched name that has no transcript', () => {
  const { events, session } = run((subDir, s) => {
    // Ignatius: transcript and meta, already watched under his name
    fs.writeFileSync(path.join(subDir, 'agent-aaaa000001.jsonl'), working)
    fs.writeFileSync(path.join(subDir, 'agent-aaaa000001.meta.json'), JSON.stringify({ description: ING }))
    s.spawnedSubagents.add(ING)
    // Thorvald: dispatched by the main transcript; his transcript is there, his meta not yet
    s.spawnedSubagents.add(QA)
    fs.writeFileSync(path.join(subDir, 'agent-bbbb174432.jsonl'), working)
  })
  const names = [...session.subagentWatchers.values()].map((w) => w.agentName).sort()
  assert.deepEqual(names, [ING, QA].sort())
  const spawned = events.filter((e) => e.type === 'agent_spawn').map((e) => e.payload.name)
  assert.ok(!spawned.some((n) => String(n).startsWith('subagent-')), `no fallback node: ${spawned.join(', ')}`)
})

test('with two unclaimed names it cannot tell which: the old fallback name stays', () => {
  const { session } = run((subDir, s) => {
    s.spawnedSubagents.add(ING)
    s.spawnedSubagents.add(QA)
    fs.writeFileSync(path.join(subDir, 'agent-bbbb174432.jsonl'), working)
  })
  assert.deepEqual([...session.subagentWatchers.values()].map((w) => w.agentName), ['subagent-174432'])
})
