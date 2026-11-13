import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { MAX_STATE_BYTES, TeamSnapshot, TeamStateWatcher } from './state-watcher'
import { makeProject, makeTmpDir, removeTmpDir, sampleState, waitFor, writeState } from './test-helpers'

function withWatcher(fn: (ctx: { project: string; w: TeamStateWatcher; events: TeamSnapshot[] }) => Promise<void>, pollMs = 60_000) {
  return async () => {
    const root = makeTmpDir()
    const project = makeProject(root, 'proj')
    const w = new TeamStateWatcher({ projectId: 'proj', projectPath: project, debounceMs: 20, pollMs })
    const events: TeamSnapshot[] = []
    w.onChange((s) => events.push(s))
    w.start()
    // macOS FSEvents can drop changes made in the first moments after a watch starts.
    await new Promise((r) => setTimeout(r, 100))
    try {
      await fn({ project, w, events })
    } finally {
      w.dispose()
      removeTmpDir(root)
    }
  }
}

const title = (s: TeamSnapshot | undefined) => (s?.state?.meta as { title?: string } | undefined)?.title

test('watcher loads state.json on start', withWatcher(async ({ w }) => {
  const snap = w.snapshot()
  assert.equal(snap.project, 'proj')
  assert.equal(snap.error, null)
  assert.equal(title(snap), 'Proyek uji')
}))

test('a change to state.json pushes a new snapshot (fs.watch)', withWatcher(async ({ project, events }) => {
  writeState(project, sampleState({ meta: { title: 'Baru' } }))
  await waitFor(() => events.some((e) => title(e) === 'Baru'))
}))

test('the poll picks up a change when fs.watch is not available', async () => {
  const root = makeTmpDir()
  // No .agent-team yet: fs.watch cannot attach, only the poll can see it appear.
  const project = path.join(root, 'late')
  fs.mkdirSync(project)
  const w = new TeamStateWatcher({ projectId: 'late', projectPath: project, debounceMs: 10, pollMs: 50 })
  const events: TeamSnapshot[] = []
  w.onChange((s) => events.push(s))
  w.start()
  try {
    assert.equal(w.snapshot().state, null)
    fs.mkdirSync(path.join(project, '.agent-team'))
    writeState(project, sampleState({ meta: { title: 'Muncul' } }))
    await waitFor(() => events.some((e) => title(e) === 'Muncul'))
  } finally {
    w.dispose()
    removeTmpDir(root)
  }
})

test('bad JSON keeps the last good state and sets error', withWatcher(async ({ project, w, events }) => {
  writeState(project, '{"meta": oops')
  await waitFor(() => events.some((e) => e.error !== null))
  const snap = w.snapshot()
  assert.match(snap.error ?? '', /not valid JSON/)
  assert.equal(title(snap), 'Proyek uji', 'last good state is kept')

  writeState(project, sampleState({ meta: { title: 'Pulih' } }))
  await waitFor(() => w.snapshot().error === null && title(w.snapshot()) === 'Pulih')
}))

test('a JSON array is refused like bad JSON', withWatcher(async ({ project, w }) => {
  writeState(project, '[1,2]')
  await waitFor(() => w.snapshot().error !== null)
  assert.equal(title(w.snapshot()), 'Proyek uji')
}))

test('state.json over 1 MB is refused and the last good state kept', withWatcher(async ({ project, w }) => {
  const big = JSON.stringify(sampleState({ meta: { title: 'Besar', pad: 'x'.repeat(MAX_STATE_BYTES) } }))
  writeState(project, big)
  await waitFor(() => w.snapshot().error !== null)
  assert.match(w.snapshot().error ?? '', /larger than/)
  assert.equal(title(w.snapshot()), 'Proyek uji')
}))

test('state.json just under the cap still loads', withWatcher(async ({ project, w }) => {
  const base = JSON.stringify(sampleState({ meta: { title: 'Pas', pad: '' } }))
  const pad = 'x'.repeat(MAX_STATE_BYTES - base.length)
  writeState(project, sampleState({ meta: { title: 'Pas', pad } }))
  await waitFor(() => title(w.snapshot()) === 'Pas')
  assert.equal(w.snapshot().error, null)
}))

test('answer files are overlaid on open approvals only', withWatcher(async ({ project, w, events }) => {
  const answers = path.join(project, '.agent-team', 'answers')
  fs.mkdirSync(answers)
  fs.writeFileSync(path.join(answers, 'D1.json'), JSON.stringify({ answer: 'pakai a', answeredAt: '2026-11-13T01:00:00.000Z' }))
  fs.writeFileSync(path.join(answers, 'D2.json'), JSON.stringify({ answer: 'timpa', answeredAt: '2026-11-13T01:00:00.000Z' }))
  fs.writeFileSync(path.join(answers, 'D9.json'), JSON.stringify({ answer: 'tidak ada', answeredAt: 'x' }))
  fs.writeFileSync(path.join(answers, 'notes.json'), JSON.stringify({ answer: 'abaikan', answeredAt: 'x' }))

  await waitFor(() => events.some((e) => (e.state?.approvals as Record<string, { status: string }>).D1.status === 'answered'))
  const approvals = w.snapshot().state!.approvals as Record<string, Record<string, unknown>>
  assert.deepEqual(
    { status: approvals.D1.status, answer: approvals.D1.answer, answeredAt: approvals.D1.answeredAt },
    { status: 'answered', answer: 'pakai a', answeredAt: '2026-11-13T01:00:00.000Z' },
  )
  assert.equal(approvals.D1.title, 'Pilih nama', 'other fields survive')
  assert.equal(approvals.D2.answer, 'ya', 'an already answered decision is not overwritten')
  assert.equal(approvals.D9, undefined, 'answers for unknown decisions are not invented')

  const raw = w.rawState()!.approvals as Record<string, { status: string }>
  assert.equal(raw.D1.status, 'open', 'raw state is not mutated')
  const onDisk = JSON.parse(fs.readFileSync(path.join(project, '.agent-team', 'state.json'), 'utf-8'))
  assert.equal(onDisk.approvals.D1.status, 'open', 'state.json is never rewritten')
}))

test('no event is pushed when nothing changed', withWatcher(async ({ project, events }) => {
  const before = events.length // the initial load may have been delivered
  writeState(project, sampleState())
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(events.length, before)
}))
