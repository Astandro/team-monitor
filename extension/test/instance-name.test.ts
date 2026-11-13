/**
 * Instance names (spec offboard-names item 2): "<Name> (<role>): <task>" in the Agent description becomes
 * `displayName`, `role` and `task` on the sub-agent's spawn payload; anything else keeps the old payload.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseInstanceName } from '../src/instance-name'
import { AgentEvent, emitSubagentSpawn } from '../src/protocol'
import { TranscriptParser, TranscriptParserDelegate } from '../src/transcript-parser'

describe('parseInstanceName', () => {
  it('splits name, role and task', () => {
    assert.deepEqual(parseInstanceName('Hiro (Frontend Engineer): Offboard button on the graph'), {
      displayName: 'Hiro', role: 'Frontend Engineer', task: 'Offboard button on the graph',
    })
  })

  it('splits at the first "):" only, so the task may hold colons and parentheses', () => {
    assert.deepEqual(parseInstanceName('Daichi (Backend Engineer): Offboard: sisi server (relay + store)'), {
      displayName: 'Daichi', role: 'Backend Engineer', task: 'Offboard: sisi server (relay + store)',
    })
  })

  it('tolerates extra spaces and collapses them in the role', () => {
    assert.deepEqual(parseInstanceName('  Mei  (  QA   Engineer ) :   review  '), {
      displayName: 'Mei', role: 'QA Engineer', task: 'review',
    })
  })

  it('accepts apostrophes, hyphens and non-Latin names', () => {
    assert.equal(parseInstanceName("O'Hara (Technical Writer): docs")?.displayName, "O'Hara")
    assert.equal(parseInstanceName('Jean-Luc (Software Architect): plan')?.displayName, 'Jean-Luc')
    assert.equal(parseInstanceName('Ōta (QA Engineer): x')?.displayName, 'Ōta')
    assert.equal(parseInstanceName('ひろ (Frontend Engineer): x')?.displayName, 'ひろ')
  })

  it('gives an empty task when nothing follows the colon', () => {
    assert.deepEqual(parseInstanceName('Ren (Backend Engineer):'), { displayName: 'Ren', role: 'Backend Engineer', task: '' })
  })

  it('refuses descriptions that are not instance names', () => {
    for (const d of [
      'Explore the codebase',                             // plain description
      'Hiro: build the panel',                            // no role
      'Hiro (Frontend Engineer) build the panel',         // no colon
      'Hiro Tanaka (Frontend Engineer): two words',       // more than one word before the role
      'hiro (Frontend Engineer): lower-case name',        // not a name
      'Hiro (): empty role',                              // empty role
      'Hiro (   ): blank role',                             // blank role
      'Hiro (123): role without letters',                 // role without letters
      'Hiro (Frontend (lead) Engineer): nested',          // nested parentheses
      'Fix bug (urgent: x): colon inside the parentheses', // two words, still refused
      `${'A'.repeat(41)} (QA Engineer): name too long`,
      `Hiro (${'r'.repeat(61)}): role too long`,
      '',
    ]) {
      assert.equal(parseInstanceName(d), null, d)
    }
    assert.equal(parseInstanceName(undefined), null)
    assert.equal(parseInstanceName(42), null)
  })

  it('accepts the length limits exactly', () => {
    assert.equal(parseInstanceName(`${'A'.repeat(40)} (QA Engineer): x`)?.displayName.length, 40)
    assert.equal(parseInstanceName(`Hiro (${'r'.repeat(60)}): x`)?.role.length, 60)
  })
})

function collector() {
  const events: AgentEvent[] = []
  return { events, emitter: { emit: (e: AgentEvent) => { events.push(e) }, elapsed: () => 0 } }
}

describe('emitSubagentSpawn with instance names', () => {
  it('adds displayName, role and the parsed task to agent_spawn; the node name stays the full description', () => {
    const { events, emitter } = collector()
    const desc = 'Hiro (Frontend Engineer): Offboard button'
    emitSubagentSpawn(emitter, 'orchestrator', desc, 'summary from the tool call', 's1')
    const spawn = events.find((e) => e.type === 'agent_spawn')!
    assert.deepEqual(spawn.payload, {
      name: desc, parent: 'orchestrator', task: 'Offboard button', displayName: 'Hiro', role: 'Frontend Engineer',
    })
    const dispatch = events.find((e) => e.type === 'subagent_dispatch')!
    assert.deepEqual(dispatch.payload, { parent: 'orchestrator', child: desc, task: 'summary from the tool call' })
  })

  it('keeps the given task when the description has no task part', () => {
    const { events, emitter } = collector()
    emitSubagentSpawn(emitter, 'orchestrator', 'Ren (Backend Engineer):', 'fallback task', 's1')
    const spawn = events.find((e) => e.type === 'agent_spawn')!
    assert.equal(spawn.payload.task, 'fallback task')
    assert.equal(spawn.payload.displayName, 'Ren')
  })

  it('leaves the payload as before for other descriptions', () => {
    const { events, emitter } = collector()
    emitSubagentSpawn(emitter, 'orchestrator', 'Explore the codebase', 'Explore the codebase', 's1')
    const spawn = events.find((e) => e.type === 'agent_spawn')!
    assert.deepEqual(spawn.payload, { name: 'Explore the codebase', parent: 'orchestrator', task: 'Explore the codebase' })
  })

  it('reaches the payload from a live Agent tool call in a transcript', () => {
    const events: AgentEvent[] = []
    const delegate: TranscriptParserDelegate = {
      emit: (e, sessionId) => { events.push(sessionId ? { ...e, sessionId } : e) },
      elapsed: () => 0,
      getSession: () => undefined,
      fireSessionLifecycle: () => {},
      emitContextUpdate: () => {},
    }
    const parser = new TranscriptParser(delegate)
    const line = JSON.stringify({
      type: 'assistant', uuid: 'u1',
      message: { role: 'assistant', model: 'claude-opus-5-5', content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'Daichi (Backend Engineer): Offboard store', prompt: 'do it' } },
      ] },
    })
    parser.processTranscriptLine(line, 'orchestrator', new Map(), new Set(), 's1')
    const spawn = events.find((e) => e.type === 'agent_spawn')
    assert.ok(spawn, 'agent_spawn emitted')
    assert.equal(spawn!.payload.displayName, 'Daichi')
    assert.equal(spawn!.payload.role, 'Backend Engineer')
    assert.equal(spawn!.payload.task, 'Offboard store')
    assert.equal(spawn!.payload.name, 'Daichi (Backend Engineer): Offboard store')
  })
})
