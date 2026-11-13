import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { writeAnswer } from './answers'
import { runWaitAnswerCli, waitForAnswer, WAIT_TIMEOUT_EXIT } from './wait-answer'
import { makeProject, makeTmpDir, removeTmpDir, sampleState } from './test-helpers'

const answersDir = (p: string) => path.join(p, '.agent-team', 'answers')

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
