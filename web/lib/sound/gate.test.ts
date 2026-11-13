import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { MAX_CUES_PER_BATCH, MIN_GAP_MS, QUIET_AFTER_RESET_MS, SESSION_START_SLACK_MS, SoundGate, startedSessions } from './gate'

test('tool starts in a burst play once per gap, not once per call', () => {
  const g = new SoundGate()
  const gap = MIN_GAP_MS.tool_start!
  assert.deepEqual(g.admit(['tool_start'], 1000), ['tool_start'])
  assert.deepEqual(g.admit(['tool_start'], 1000 + 10), [])
  assert.deepEqual(g.admit(['tool_start'], 1000 + gap - 1), [])
  assert.deepEqual(g.admit(['tool_start'], 1000 + gap), ['tool_start'])
})

test('the gap is per cue: a different cue still plays', () => {
  const g = new SoundGate()
  g.admit(['tool_start'], 1000)
  assert.deepEqual(g.admit(['tool_start', 'tool_error'], 1010), ['tool_error'])
})

test('a dropped cue does not push its own gap forward', () => {
  const g = new SoundGate()
  const gap = MIN_GAP_MS.tool_start!
  g.admit(['tool_start'], 0)
  g.admit(['tool_start'], gap - 1)
  assert.deepEqual(g.admit(['tool_start'], gap), ['tool_start'])
})

test('quiet window after reset drops replayed history, then sound comes back', () => {
  const g = new SoundGate()
  g.reset(5000)
  assert.deepEqual(g.admit(['agent_spawn', 'tool_start'], 5000), [])
  assert.deepEqual(g.admit(['tool_complete'], 5000 + QUIET_AFTER_RESET_MS - 1), [])
  assert.deepEqual(g.admit(['tool_complete'], 5000 + QUIET_AFTER_RESET_MS), ['tool_complete'])
})

test('a session power-up still plays inside the quiet window of its own switch', () => {
  const g = new SoundGate()
  g.reset(0)
  assert.deepEqual(g.admit(['session_start', 'agent_spawn'], 10), ['session_start'])
})

test('a batch is capped, most important first', () => {
  const g = new SoundGate()
  const out = g.admit(['tool_start', 'handoff', 'agent_spawn', 'tool_error', 'decision_open'], 0)
  assert.equal(out.length, MAX_CUES_PER_BATCH)
  assert.deepEqual(out, ['decision_open', 'tool_error', 'agent_spawn'])
})

test('sessions listed on load are not new, a session started later is', () => {
  const loadedAt = 100_000
  const seen = new Set<string>()
  const onLoad = [
    { id: 'a', startTime: loadedAt - 60_000 },
    { id: 'b', startTime: loadedAt - 3_600_000 },
  ]
  assert.deepEqual(startedSessions(seen, onLoad, loadedAt), [])
  for (const s of onLoad) seen.add(s.id)
  const later = [...onLoad, { id: 'c', startTime: loadedAt + 30_000 }]
  assert.deepEqual(startedSessions(seen, later, loadedAt), ['c'])
  seen.add('c')
  // the same session sent again (resume) is not a second power-up
  assert.deepEqual(startedSessions(seen, later, loadedAt), [])
})

test('clock skew between relay and phone is tolerated up to the slack', () => {
  const at = 100_000
  assert.deepEqual(startedSessions(new Set(), [{ id: 'x', startTime: at - SESSION_START_SLACK_MS }], at), ['x'])
  assert.deepEqual(startedSessions(new Set(), [{ id: 'x', startTime: at - SESSION_START_SLACK_MS - 1 }], at), [])
})
