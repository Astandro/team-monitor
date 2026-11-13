import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { TeamState } from '@/lib/team/types'
import { diffTeamStates, TeamSoundTracker } from './team-diff'

function base(): TeamState {
  return {
    meta: { title: 'Proyek' },
    stages: { s1: { label: 'Bangun', status: 'active' }, s2: { label: 'Uji', status: 'todo' } },
    tasks: {
      t01: { title: 'A', status: 'todo' },
      t02: { title: 'B', status: 'running' },
    },
    approvals: { D1: { title: 'Pilih', status: 'answered', answer: 'ya' } },
  }
}

function withTask(s: TeamState, id: string, status: string): TeamState {
  return { ...s, tasks: { ...s.tasks, [id]: { ...(s.tasks?.[id] ?? {}), title: id, status } } }
}

test('no change, no sound', () => {
  assert.deepEqual(diffTeamStates(base(), base()), [])
})

test('each task status change plays its own cue', () => {
  assert.deepEqual(diffTeamStates(base(), withTask(base(), 't01', 'running')), ['task_start'])
  assert.deepEqual(diffTeamStates(base(), withTask(base(), 't02', 'review')), ['task_review'])
  assert.deepEqual(diffTeamStates(base(), withTask(base(), 't02', 'done')), ['task_done'])
  assert.deepEqual(diffTeamStates(base(), withTask(base(), 't02', 'blocked')), ['task_blocked'])
  // back to todo is not an event
  assert.deepEqual(diffTeamStates(base(), withTask(base(), 't02', 'todo')), [])
})

test('a new task counts from nothing, a new todo task is silent', () => {
  assert.deepEqual(diffTeamStates(base(), withTask(base(), 't03', 'running')), ['task_start'])
  assert.deepEqual(diffTeamStates(base(), withTask(base(), 't03', 'todo')), [])
})

test('several tasks finishing at once play the chime once', () => {
  const next = withTask(withTask(base(), 't01', 'done'), 't02', 'done')
  assert.deepEqual(diffTeamStates(base(), next), ['task_done'])
})

test('a new open decision alerts; a new decision that is already answered does not', () => {
  const open: TeamState = { ...base(), approvals: { ...base().approvals, D2: { title: 'X', status: 'open' } } }
  assert.deepEqual(diffTeamStates(base(), open), ['decision_open'])
  const answered: TeamState = { ...base(), approvals: { ...base().approvals, D2: { title: 'X', status: 'answered' } } }
  assert.deepEqual(diffTeamStates(base(), answered), [])
})

test('an open decision getting answered plays the confirm tone, also when only the answer text arrives', () => {
  const open: TeamState = { ...base(), approvals: { D2: { title: 'X', status: 'open' } } }
  const answered: TeamState = { ...base(), approvals: { D2: { title: 'X', status: 'answered', answer: 'B' } } }
  assert.deepEqual(diffTeamStates(open, answered), ['decision_answered'])
  const overlaid: TeamState = { ...base(), approvals: { D2: { title: 'X', status: 'open', answer: 'B' } } }
  assert.deepEqual(diffTeamStates(open, overlaid), ['decision_answered'])
  // still open: nothing
  assert.deepEqual(diffTeamStates(open, open), [])
})

test('a stage turning done plays the pad, only on the change', () => {
  const done: TeamState = { ...base(), stages: { ...base().stages, s1: { label: 'Bangun', status: 'done' } } }
  assert.deepEqual(diffTeamStates(base(), done), ['stage_done'])
  assert.deepEqual(diffTeamStates(done, done), [])
})

test('mixed changes come most important first', () => {
  let next = withTask(base(), 't02', 'done')
  next = { ...next, approvals: { ...next.approvals, D2: { title: 'X', status: 'open' } } }
  next = { ...next, stages: { ...next.stages, s1: { status: 'done' } } }
  assert.deepEqual(diffTeamStates(base(), next), ['decision_open', 'stage_done', 'task_done'])
})

test('tracker: silent on the first payload, then plays changes', () => {
  const tr = new TeamSoundTracker()
  assert.deepEqual(tr.step('p1', null), [])
  assert.deepEqual(tr.step('p1', withTask(base(), 't02', 'done')), [])
  assert.deepEqual(tr.step('p1', withTask(base(), 't02', 'blocked')), ['task_blocked'])
  assert.deepEqual(tr.step('p1', withTask(base(), 't02', 'blocked')), [])
})

test('tracker: silent right after a project switch, even when the new project differs a lot', () => {
  const tr = new TeamSoundTracker()
  tr.step('p1', null)
  tr.step('p1', base())
  // switch: the hook first sees the new id with no state yet, then the first payload
  assert.deepEqual(tr.step('p2', null), [])
  assert.deepEqual(tr.step('p2', withTask(base(), 't02', 'done')), [])
  // switching with a state already present is silent too
  assert.deepEqual(tr.step('p1', withTask(base(), 't01', 'running')), [])
  assert.deepEqual(tr.step('p1', withTask(base(), 't01', 'review')), ['task_review'])
})

test('tracker: a payload without state keeps the last good baseline', () => {
  const tr = new TeamSoundTracker()
  tr.step('p1', base())
  assert.deepEqual(tr.step('p1', null), [])
  assert.deepEqual(tr.step('p1', withTask(base(), 't02', 'done')), ['task_done'])
})
