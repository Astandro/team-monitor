import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { MAX_STATE_BYTES, TeamSnapshot, TeamStateWatcher } from './state-watcher'
import { writeInboxMessage } from './chat'
import { HEARTBEAT_STALE_MS, writeHeartbeat } from './heartbeat'
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

// ─── Chat and watcher liveness (spec-chat) ──────────────────────────────────

const inbox = (project: string) => path.join(project, '.agent-team', 'inbox')

test('a new inbox message is pushed as an unread chat entry; recording it in state.json makes it read', withWatcher(async ({ project, w, events }) => {
  assert.deepEqual(w.snapshot().chat, [])
  const m = writeInboxMessage(inbox(project), 'halo', () => new Date('2026-11-13T02:00:00.000Z'))
  await waitFor(() => events.some((e) => e.chat.length === 1))
  assert.deepEqual(w.snapshot().chat, [{ id: m.id, from: 'owner', text: 'halo', t: m.sentAt, status: 'sent' }])

  writeState(project, sampleState({
    chat: {
      [m.id]: { from: 'owner', text: 'halo', t: m.sentAt, readAt: '2026-11-13T02:00:05.000Z' },
      r1: { from: 'sora', text: 'siap', t: '2026-11-13T02:00:06.000Z' },
    },
  }))
  await waitFor(() => w.snapshot().chat.length === 2)
  assert.deepEqual(w.snapshot().chat, [
    { id: m.id, from: 'owner', text: 'halo', t: m.sentAt, status: 'read', readAt: '2026-11-13T02:00:05.000Z' },
    { id: 'r1', from: 'sora', text: 'siap', t: '2026-11-13T02:00:06.000Z' },
  ])
  assert.equal(Object.prototype.hasOwnProperty.call(w.snapshot().state, 'chat'), false, 'chat is served once, outside state')
  assert.ok(w.rawState()!.chat, 'raw state keeps it')
}))

test('an inbox folder created after start is picked up', async () => {
  const root = makeTmpDir()
  const project = makeProject(root, 'p')
  const w = new TeamStateWatcher({ projectId: 'p', projectPath: project, debounceMs: 10, pollMs: 50 })
  w.start()
  try {
    // The inbox folder does not exist at start, so no watcher is attached to it yet.
    writeInboxMessage(inbox(project), 'lewat poll')
    await waitFor(() => w.snapshot().chat.length === 1)
  } finally {
    w.dispose()
    removeTmpDir(root)
  }
})

test('watcher: alive from the heartbeat; turns not alive by the poll when the beat goes stale', async () => {
  const root = makeTmpDir()
  const project = makeProject(root, 'p')
  const dir = path.join(project, '.agent-team')
  const clock = { t: Date.parse('2026-11-13T03:00:00.000Z') }
  const w = new TeamStateWatcher({
    projectId: 'p', projectPath: project, debounceMs: 10, pollMs: 50,
    heartbeat: { now: () => clock.t, pidAlive: () => true },
  })
  const events: TeamSnapshot[] = []
  w.onChange((s) => events.push(s))
  w.start()
  try {
    assert.deepEqual(w.snapshot().watcher, { alive: false, since: null })
    const startedAt = new Date(clock.t).toISOString()
    writeHeartbeat(dir, { pid: 1234, startedAt, beatAt: startedAt })
    await waitFor(() => w.snapshot().watcher.alive)
    assert.deepEqual(w.snapshot().watcher, { alive: true, since: startedAt })
    const n = events.length
    clock.t += HEARTBEAT_STALE_MS + 1
    // No file changes: only the poll can notice.
    await waitFor(() => !w.snapshot().watcher.alive)
    assert.deepEqual(w.snapshot().watcher, { alive: false, since: startedAt })
    assert.ok(events.length > n && !events[events.length - 1].watcher.alive, 'the change is pushed')
  } finally {
    w.dispose()
    removeTmpDir(root)
  }
})

test('no event is pushed when nothing changed', withWatcher(async ({ project, events }) => {
  const before = events.length // the initial load may have been delivered
  writeState(project, sampleState())
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(events.length, before)
}))
