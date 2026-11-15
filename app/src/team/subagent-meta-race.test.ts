// A sub-agent transcript that appears before its .meta.json (seen in a cloud session, 15 Nov 2026) must not become a
// second node next to the one the main transcript already named from its Agent call ("subagent-174432" beside
// "Thorvald (QA Engineer): ...").
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import type { AgentEvent, WatchedSession } from '../../../extension/src/protocol'
import { TranscriptParser } from '../../../extension/src/transcript-parser'
import { readSubagentNewLines, scanSubagentsDir, unclaimedSubagentNames, type SubagentWatcherDelegate } from '../../../extension/src/subagent-watcher'
import { dispatchPromptKey } from '../../../extension/src/constants'
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

const ARJ = 'Arjuna (Backend Engineer): fix F-02'
const SEK = 'Sekar (Frontend Engineer): fix F-05'
const promptLine = (text: string) => JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: text } }) + '\n'

test('two sub-agents dispatched at once, neither meta written yet: each transcript takes its name from its prompt', () => {
  const { events, session } = run((subDir, s) => {
    s.spawnedSubagents.add(ARJ)
    s.spawnedSubagents.add(SEK)
    s.dispatchPrompts = new Map([
      [dispatchPromptKey('You are Arjuna, Backend Engineer.\n  Fix F-02 in the API.'), ARJ],
      [dispatchPromptKey('You are Sekar, Frontend Engineer. Fix F-05 in the panel.'), SEK],
    ])
    fs.writeFileSync(path.join(subDir, 'agent-cccc1871f7.jsonl'), promptLine('You are Sekar, Frontend Engineer. Fix F-05 in the panel.') + working)
    fs.writeFileSync(path.join(subDir, 'agent-dddd88c35a.jsonl'), promptLine('You are Arjuna, Backend Engineer. Fix F-02 in the API.') + working)
  })
  const byFile = Object.fromEntries([...session.subagentWatchers].map(([f, w]) => [path.basename(f), w.agentName]))
  assert.deepEqual(byFile, { 'agent-cccc1871f7.jsonl': SEK, 'agent-dddd88c35a.jsonl': ARJ })
  const spawned = events.filter((e) => e.type === 'agent_spawn').map((e) => String(e.payload.name))
  assert.ok(!spawned.some((n) => n.startsWith('subagent-')), spawned.join(', '))
})

test('a transcript still empty when found gets its real name once its first lines arrive, before any node is drawn', () => {
  root = makeTmpDir()
  const session = makeSession(root)
  const subDir = session.subagentsDir!
  fs.mkdirSync(subDir, { recursive: true })
  session.spawnedSubagents.add(ARJ)
  session.spawnedSubagents.add(SEK)
  session.dispatchPrompts = new Map([[dispatchPromptKey('Arjuna prompt'), ARJ], [dispatchPromptKey('Sekar prompt'), SEK]])
  const file = path.join(subDir, 'agent-eeee000123.jsonl')
  fs.writeFileSync(file, '')
  const events: AgentEvent[] = []
  const delegate: SubagentWatcherDelegate & ConstructorParameters<typeof TranscriptParser>[0] = {
    emit: (event) => { events.push(event) }, elapsed: () => 0, getLastActivityTime: () => Date.now(),
    getSession: (id) => (id === S ? session : undefined), resetInactivityTimer: () => {},
    fireSessionLifecycle: () => {}, emitContextUpdate: () => {},
  }
  const parser = new TranscriptParser(delegate)
  try {
    scanSubagentsDir(delegate, parser, S)
    assert.equal(session.subagentWatchers.get(file)!.agentName, 'subagent-000123', 'nothing known yet')
    assert.equal(events.filter((e) => e.type === 'agent_spawn').length, 0, 'and nothing drawn')
    fs.writeFileSync(file, promptLine('Sekar prompt') + working)
    readSubagentNewLines(delegate, parser, file, S)
    assert.equal(session.subagentWatchers.get(file)!.agentName, SEK)
    assert.deepEqual(events.filter((e) => e.type === 'agent_spawn').map((e) => e.payload.name), [], 'Sekar was already on the graph from the dispatch')
  } finally {
    session.subagentsDirWatcher?.close()
    for (const st of session.subagentWatchers.values()) st.watcher?.close()
  }
})

test('SubagentStop/Start hook: the name comes from the sub-agent meta (agent_transcript_path, else derived), not agent_type-id', async () => {
  const { subagentNameFromHookMeta } = await import('../../../extension/src/subagent-watcher')
  root = makeTmpDir()
  const main = path.join(root, `${S}.jsonl`)
  const subDir = path.join(root, S, 'subagents')
  fs.mkdirSync(subDir, { recursive: true })
  fs.writeFileSync(path.join(subDir, 'agent-a1b2c388c35a.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: ARJ }))
  // derived from the main transcript path, the session and the agent id
  assert.equal(subagentNameFromHookMeta({ session_id: S, transcript_path: main, agent_id: 'a1b2c388c35a' }), ARJ)
  // the path the hook gives
  assert.equal(subagentNameFromHookMeta({ session_id: S, agent_id: 'a1b2c388c35a', agent_transcript_path: path.join(subDir, 'agent-a1b2c388c35a.jsonl') }), ARJ)
  // meta not written yet, or a bad id: unknown
  assert.equal(subagentNameFromHookMeta({ session_id: S, transcript_path: main, agent_id: 'ffff00000000' }), null)
  assert.equal(subagentNameFromHookMeta({ session_id: S, transcript_path: main, agent_id: '../x' }), null)
  assert.equal(subagentNameFromHookMeta({ session_id: S, transcript_path: main }), null)
})
