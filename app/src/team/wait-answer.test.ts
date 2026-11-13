import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { writeAnswer } from './answers'
import { writeInboxMessage } from './chat'
import { readHeartbeat } from './heartbeat'
import { runWaitAnswerCli, waitForAnswer, WAIT_TIMEOUT_EXIT } from './wait-answer'
import { makeProject, makeTmpDir, removeTmpDir, sampleState, waitFor, writeState } from './test-helpers'

const answersDir = (p: string) => path.join(p, '.agent-team', 'answers')
const inboxDir = (p: string) => path.join(p, '.agent-team', 'inbox')
const teamDir = (p: string) => path.join(p, '.agent-team')
const send = (p: string, text: string, at?: string) => writeInboxMessage(inboxDir(p), text, at ? () => new Date(at) : undefined)
const markRead = (p: string, ...msgs: Array<{ id: string; sentAt: string }>) => writeState(p, sampleState({
  chat: Object.fromEntries(msgs.map((m) => [m.id, { from: 'owner', text: 'x', t: m.sentAt, readAt: m.sentAt }])),
}))

// ─── Chat messages (spec-chat) ──────────────────────────────────────────────

test('waitForAnswer with inbox wakes on a new message and returns every unread one', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const pending = waitForAnswer({ projectPath: project, timeoutMs: 5000, pollMs: 50, inbox: true })
    setTimeout(() => send(project, 'halo Sora'), 100)
    const r = await pending
    assert.equal(r?.kind, 'message')
    assert.match(r!.name, /^inbox\/[0-9]{13}-[0-9a-f]{12}\.json$/)
    assert.equal(JSON.parse(r!.content).text, 'halo Sora')
    assert.equal(r!.items.length, 1)
  } finally {
    removeTmpDir(root)
  }
})

test('an unread message is reported again by the next wait until state.json records it', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const a = send(project, 'satu', '2026-11-13T01:00:00.000Z')
    const b = send(project, 'dua', '2026-11-13T01:00:01.000Z')
    const r1 = await waitForAnswer({ projectPath: project, timeoutMs: 2000, pollMs: 50, inbox: true })
    assert.deepEqual(r1!.items.map((i) => JSON.parse(i.content).text), ['satu', 'dua'], 'all unread, oldest first')
    const r2 = await waitForAnswer({ projectPath: project, timeoutMs: 2000, pollMs: 50, inbox: true })
    assert.equal(r2!.items.length, 2, 'still unread: reported again')
    markRead(project, a)
    const r3 = await waitForAnswer({ projectPath: project, timeoutMs: 2000, pollMs: 50, inbox: true })
    assert.deepEqual(r3!.items.map((i) => JSON.parse(i.content).id), [b.id])
    markRead(project, a, b)
    assert.equal(await waitForAnswer({ projectPath: project, timeoutMs: 200, pollMs: 50, inbox: true }), null, 'all read: keeps waiting')
  } finally {
    removeTmpDir(root)
  }
})

test('a reply from sora with the same id does not count as read', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const a = send(project, 'satu')
    writeState(project, sampleState({ chat: { [a.id]: { from: 'sora', text: 'x', t: a.sentAt } } }))
    const r = await waitForAnswer({ projectPath: project, timeoutMs: 1000, pollMs: 50, inbox: true })
    assert.equal(r?.kind, 'message')
  } finally {
    removeTmpDir(root)
  }
})

test('--only-new ignores unread messages already there, but wakes on a new one', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    send(project, 'lama')
    let done = false
    const pending = waitForAnswer({ projectPath: project, timeoutMs: 5000, pollMs: 50, inbox: true, includePending: false })
      .then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(done, false)
    send(project, 'baru')
    const r = await pending
    assert.deepEqual(r!.items.map((i) => JSON.parse(i.content).text), ['baru'])
  } finally {
    removeTmpDir(root)
  }
})

test('without inbox (answers only, as ask --wait) a message never wakes the wait', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    send(project, 'sudah ada')
    const pending = waitForAnswer({ projectPath: project, timeoutMs: 400, pollMs: 50 })
    setTimeout(() => send(project, 'baru'), 100)
    assert.equal(await pending, null)
  } finally {
    removeTmpDir(root)
  }
})

test('a pending answer is reported before pending messages', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    send(project, 'pesan')
    writeAnswer(sampleState() as never, answersDir(project), 'D1', 'jawab')
    const r = await waitForAnswer({ projectPath: project, timeoutMs: 1000, pollMs: 50, inbox: true })
    assert.equal(r?.kind, 'answer')
    assert.equal(r?.name, 'D1.json')
  } finally {
    removeTmpDir(root)
  }
})

test('CLI prints inbox/<file> and the JSON for each message, keeps a heartbeat and ends it with the reason', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const out: string[] = []
    const pending = runWaitAnswerCli(['--project', project, '--timeout', '5', '--poll-ms', '50'], (s) => out.push(s), () => {})
    await waitFor(() => readHeartbeat(teamDir(project)) !== null)
    const running = readHeartbeat(teamDir(project))!
    assert.equal(running.pid, process.pid)
    assert.equal(running.endedAt, undefined)
    const m = send(project, 'baris satu\nbaris dua')
    assert.equal(await pending, 0)
    const lines = out.join('').split('\n')
    assert.equal(lines[0], `inbox/${path.basename(m.file)}`)
    assert.deepEqual(JSON.parse(lines.slice(1).join('\n')), { id: m.id, text: 'baris satu\nbaris dua', sentAt: m.sentAt })
    const ended = readHeartbeat(teamDir(project))!
    assert.equal(ended.reason, 'message')
    assert.equal(ended.startedAt, running.startedAt)
  } finally {
    removeTmpDir(root)
  }
})

test('CLI --answers-only: no heartbeat, messages do not wake it', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    send(project, 'x')
    const code = await runWaitAnswerCli(['--project', project, '--timeout', '0.3', '--poll-ms', '50', '--answers-only'], () => {}, () => {})
    assert.equal(code, WAIT_TIMEOUT_EXIT)
    assert.equal(fs.existsSync(path.join(teamDir(project), '.watcher')), false)
  } finally {
    removeTmpDir(root)
  }
})

test('CLI timeout ends the heartbeat with reason timeout', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    assert.equal(await runWaitAnswerCli(['--project', project, '--timeout', '0.2', '--poll-ms', '50'], () => {}, () => {}), WAIT_TIMEOUT_EXIT)
    assert.equal(readHeartbeat(teamDir(project))?.reason, 'timeout')
  } finally {
    removeTmpDir(root)
  }
})

test('CLI as a separate process: SIGTERM ends the heartbeat with reason signal', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const entry = path.join(__dirname, 'wait-answer-main.ts')
    const child = spawn(process.execPath, ['--import', 'tsx', entry, '--project', project, '--timeout', '20'], { stdio: 'ignore' })
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
    await waitFor(() => readHeartbeat(teamDir(project))?.pid === child.pid, 10_000)
    child.kill('SIGTERM')
    assert.equal(await exited, 143)
    const rec = readHeartbeat(teamDir(project))!
    assert.equal(rec.reason, 'signal')
    assert.equal(rec.pid, child.pid)
  } finally {
    removeTmpDir(root)
  }
})

// ─── Answers ────────────────────────────────────────────────────────────────

test('waitForAnswer resolves when a new answer file appears', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const pending = waitForAnswer({ projectPath: project, timeoutMs: 5000, pollMs: 50 })
    setTimeout(() => writeAnswer(sampleState() as never, answersDir(project), 'D1', 'ok'), 100)
    const r = await pending
    assert.ok(r)
    assert.equal(r!.name, 'D1.json')
    assert.equal(JSON.parse(r!.content).answer, 'ok')
  } finally {
    removeTmpDir(root)
  }
})

test('waitForAnswer resolves when an existing answer file changes, not before', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p', sampleState({ approvals: {} }))
    fs.mkdirSync(answersDir(project))
    const file = path.join(answersDir(project), 'D4.json')
    fs.writeFileSync(file, JSON.stringify({ answer: 'lama', answeredAt: 'x' }))
    let done = false
    const pending = waitForAnswer({ projectPath: project, timeoutMs: 5000, pollMs: 50 }).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(done, false, 'an old, recorded answer does not wake the coordinator')
    fs.writeFileSync(file, JSON.stringify({ answer: 'baru', answeredAt: 'y' }))
    const r = await pending
    assert.equal(JSON.parse(r!.content).answer, 'baru')
  } finally {
    removeTmpDir(root)
  }
})

test('waitForAnswer reports an unrecorded answer at once unless --only-new', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p') // D1 is open in state.json
    writeAnswer(sampleState() as never, answersDir(project), 'D1', 'sudah dijawab')
    const r = await waitForAnswer({ projectPath: project, timeoutMs: 2000, pollMs: 50 })
    assert.equal(r?.name, 'D1.json')
    const r2 = await waitForAnswer({ projectPath: project, timeoutMs: 200, pollMs: 50, includePending: false })
    assert.equal(r2, null)
  } finally {
    removeTmpDir(root)
  }
})

test('waitForAnswer ignores temp files and times out', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    fs.mkdirSync(answersDir(project))
    const pending = waitForAnswer({ projectPath: project, timeoutMs: 300, pollMs: 50 })
    fs.writeFileSync(path.join(answersDir(project), '.D1.json.abc.tmp'), '{}')
    fs.writeFileSync(path.join(answersDir(project), 'notes.txt'), 'x')
    const started = Date.now()
    assert.equal(await pending, null)
    assert.ok(Date.now() - started < 2000)
  } finally {
    removeTmpDir(root)
  }
})

test('CLI: bad usage exits 2, timeout exits 124', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const err: string[] = []
    assert.equal(await runWaitAnswerCli(['--bogus'], () => {}, (s) => err.push(s)), 2)
    assert.equal(await runWaitAnswerCli(['--project', path.join(root, 'missing')], () => {}, (s) => err.push(s)), 2)
    assert.equal(await runWaitAnswerCli(['--project', project, '--timeout', '0'], () => {}, (s) => err.push(s)), 2)
    assert.equal(await runWaitAnswerCli(['--project', project, '--timeout', '0.2', '--poll-ms', '50'], () => {}, (s) => err.push(s)), WAIT_TIMEOUT_EXIT)
  } finally {
    removeTmpDir(root)
  }
})

test('CLI as a separate process: exits 0 and prints the file name and content', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const entry = path.join(__dirname, 'wait-answer-main.ts')
    const child = spawn(process.execPath, ['--import', 'tsx', entry, '--project', project, '--timeout', '20', '--poll-ms', '50'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let errOut = ''
    child.stdout.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr.on('data', (c: Buffer) => { errOut += c.toString() })
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)))
    // Give the child time to start and take its baseline.
    await new Promise((r) => setTimeout(r, 1500))
    writeAnswer(sampleState() as never, answersDir(project), 'D1', 'dari proses lain')
    const code = await exited
    assert.equal(code, 0, errOut)
    const [name, ...rest] = out.trim().split('\n')
    assert.equal(name, 'D1.json')
    assert.equal(JSON.parse(rest.join('\n')).answer, 'dari proses lain')
  } finally {
    removeTmpDir(root)
  }
})
