import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { writeAnswer } from './answers'
import { AskError, addApprovals, nextDecisionIds, runAskCli, validateApproval } from './ask'
import { WAIT_TIMEOUT_EXIT } from './wait-answer'
import { makeProject, makeTmpDir, removeTmpDir, sampleState, writeState } from './test-helpers'

const teamDir = (p: string) => path.join(p, '.agent-team')
const readState = (p: string) => JSON.parse(fs.readFileSync(path.join(teamDir(p), 'state.json'), 'utf-8'))
const q = { title: 'Nama', question: 'Pakai nama apa?', options: ['a', 'b'] }

test('nextDecisionIds: above the highest D<n>, gaps not reused, other keys ignored', () => {
  assert.deepEqual(nextDecisionIds({}, null, 1), ['D1'])
  assert.deepEqual(nextDecisionIds({ D1: {}, D3: {} }, null, 1), ['D4'])
  assert.deepEqual(nextDecisionIds({ D2: {}, D10: {}, D9: {} }, null, 2), ['D11', 'D12'])
  assert.deepEqual(nextDecisionIds({ D1: {}, X50: {}, D12a: {}, d40: {}, D00099999: {} }, null, 1), ['D2'])
})

test('nextDecisionIds skips ids that already have an answer file', () => {
  const root = makeTmpDir()
  try {
    const answers = path.join(root, 'answers')
    fs.mkdirSync(answers)
    fs.writeFileSync(path.join(answers, 'D4.json'), '{}')
    fs.writeFileSync(path.join(answers, 'D6.json'), '{}')
    assert.deepEqual(nextDecisionIds({ D3: {} }, answers, 3), ['D5', 'D7', 'D8'])
  } finally {
    removeTmpDir(root)
  }
})

test('nextDecisionIds refuses to go past D9999', () => {
  assert.throws(() => nextDecisionIds({ D9999: {} }, null, 1), AskError)
})

test('validateApproval trims, caps and checks recommended', () => {
  assert.deepEqual(validateApproval({ title: ' T ', question: ' Q ', options: [' x ', 'y'], recommended: 'x' }),
    { title: 'T', question: 'Q', options: ['x', 'y'], recommended: 'x' })
  assert.throws(() => validateApproval({ title: 'T', question: 'Q', options: ['x'], recommended: 'z' }), /one of the options/)
  assert.throws(() => validateApproval({ title: '', question: 'Q' }), /title is required/)
  assert.throws(() => validateApproval({ title: 'T', question: 'Q', options: 'x' }), /array/)
  assert.throws(() => validateApproval({ title: 'T', question: 'x'.repeat(4001) }), /longer/)
})

test('addApprovals writes open decisions, keeps the rest of state.json and leaves no temp file', () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p') // D1 open, D2 answered
    const ids = addApprovals(project, [q, { ...q, title: 'Dua', recommended: 'b' }], { now: () => new Date('2026-11-13T05:00:00.000Z') })
    assert.deepEqual(ids, ['D3', 'D4'])
    const s = readState(project)
    assert.equal(s.meta.title, 'Proyek uji')
    assert.equal(s.approvals.D2.status, 'answered')
    assert.deepEqual(s.approvals.D3, { title: 'Nama', question: 'Pakai nama apa?', options: ['a', 'b'], status: 'open', askedAt: '2026-11-13T05:00:00.000Z', order: 3 })
    assert.equal(s.approvals.D4.recommended, 'b')
    assert.equal(s.approvals.D4.order, 4)
    assert.deepEqual(fs.readdirSync(teamDir(project)), ['state.json'])
  } finally {
    removeTmpDir(root)
  }
})

test('addApprovals keeps a concurrent change made just before its rename', () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    let calls = 0
    const ids = addApprovals(project, [q], {
      beforeCommit: (attempt) => {
        calls++
        if (attempt === 0) {
          // The coordinator writes state.json between our read and our rename, adding D3 and a task.
          writeState(project, sampleState({
            tasks: { t9: { title: 'baru' } },
            approvals: { ...(sampleState().approvals as object), D3: { title: 'x', question: 'y', options: [], status: 'open', order: 3 } },
          }))
        }
      },
    })
    assert.equal(calls, 2)
    assert.deepEqual(ids, ['D4'])
    const s = readState(project)
    assert.equal(s.tasks.t9.title, 'baru')
    assert.equal(s.approvals.D3.title, 'x')
    assert.equal(s.approvals.D4.title, 'Nama')
    assert.deepEqual(fs.readdirSync(teamDir(project)), ['state.json'], 'the discarded temp file is removed')
  } finally {
    removeTmpDir(root)
  }
})

test('addApprovals gives up when state.json keeps changing, without temp files or a write', () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    let n = 0
    assert.throws(() => addApprovals(project, [q], {
      maxAttempts: 3,
      beforeCommit: () => writeState(project, sampleState({ meta: { title: `v${++n}` } })),
    }), /kept changing/)
    assert.equal(readState(project).meta.title, 'v3')
    assert.equal(readState(project).approvals.D3, undefined)
    assert.deepEqual(fs.readdirSync(teamDir(project)), ['state.json'])
  } finally {
    removeTmpDir(root)
  }
})

test('addApprovals creates state.json when missing and refuses a broken one', () => {
  const root = makeTmpDir()
  try {
    const fresh = path.join(root, 'fresh')
    fs.mkdirSync(fresh)
    assert.deepEqual(addApprovals(fresh, [q]), ['D1'])
    assert.equal(readState(fresh).approvals.D1.status, 'open')

    const broken = makeProject(root, 'broken', '{"approvals": ')
    assert.throws(() => addApprovals(broken, [q]), /not valid JSON/)
    assert.equal(fs.readFileSync(path.join(teamDir(broken), 'state.json'), 'utf-8'), '{"approvals": ')
    assert.deepEqual(fs.readdirSync(teamDir(broken)), ['state.json'])
  } finally {
    removeTmpDir(root)
  }
})

test('ask CLI: prints the new id; bad usage exits 2', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const out: string[] = []
    const err: string[] = []
    const code = await runAskCli(['--project', project, '--title', 'Warna', '--question', 'Biru atau hijau?', '--option', 'biru', '--option', 'hijau', '--recommended', 'hijau'], (s) => out.push(s), (s) => err.push(s))
    assert.equal(code, 0, err.join(''))
    assert.equal(out.join(''), 'D3\n')
    assert.deepEqual(readState(project).approvals.D3.options, ['biru', 'hijau'])
    assert.equal(readState(project).approvals.D3.recommended, 'hijau')

    assert.equal(await runAskCli(['--project', project, '--title', 'x'], () => {}, () => {}), 2)
    assert.equal(await runAskCli(['--project', project, '--title', 'x', '--question', 'y', '--option', 'a', '--recommended', 'z'], () => {}, () => {}), 2)
    assert.equal(await runAskCli(['--project', project, '--title', 'x', '--question', 'y', '--timeout', '5'], () => {}, () => {}), 2)
    assert.equal(await runAskCli(['--project', path.join(root, 'missing'), '--title', 'x', '--question', 'y'], () => {}, () => {}), 2)
    assert.equal(await runAskCli(['--bogus'], () => {}, () => {}), 2)
    assert.equal(readState(project).approvals.D4, undefined, 'failed calls add nothing')
  } finally {
    removeTmpDir(root)
  }
})

test('ask CLI --json reads a full approval object', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const file = path.join(root, 'q.json')
    fs.writeFileSync(file, JSON.stringify({ title: 'Dari file', question: 'Lanjut?', options: ['ya', 'tidak'], recommended: 'ya', status: 'answered' }))
    const out: string[] = []
    assert.equal(await runAskCli(['--project', project, '--json', file], (s) => out.push(s), () => {}), 0)
    assert.equal(out.join(''), 'D3\n')
    const a = readState(project).approvals.D3
    assert.equal(a.title, 'Dari file')
    assert.equal(a.status, 'open', 'status from the file is ignored')
    assert.equal(await runAskCli(['--project', project, '--json', file, '--title', 'x'], () => {}, () => {}), 2)
    fs.writeFileSync(file, '{nope')
    assert.equal(await runAskCli(['--project', project, '--json', file], () => {}, () => {}), 2)
  } finally {
    removeTmpDir(root)
  }
})

test('ask CLI --wait exits on the answer to its own decision only', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p') // D1 is open
    const answers = path.join(teamDir(project), 'answers')
    const out: string[] = []
    const err: string[] = []
    let done = false
    const pending = runAskCli(['--project', project, '--title', 'T', '--question', 'Q', '--wait', '--timeout', '10', '--poll-ms', '50'], (s) => out.push(s), (s) => err.push(s))
      .then((c) => { done = true; return c })
    await new Promise((r) => setTimeout(r, 200))
    writeAnswer(readState(project), answers, 'D1', 'jawaban lain')
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(done, false, 'an answer to another decision does not end the wait')
    writeAnswer(readState(project), answers, 'D3', 'jawaban saya')
    assert.equal(await pending, 0, err.join(''))
    const lines = out.join('').trim().split('\n')
    assert.equal(lines[0], 'D3')
    assert.equal(lines[1], 'D3.json')
    assert.equal(JSON.parse(lines.slice(2).join('\n')).answer, 'jawaban saya')
  } finally {
    removeTmpDir(root)
  }
})

test('ask CLI --wait times out with 124', async () => {
  const root = makeTmpDir()
  try {
    const project = makeProject(root, 'p')
    const err: string[] = []
    assert.equal(await runAskCli(['--project', project, '--title', 'T', '--question', 'Q', '--wait', '--timeout', '0.2', '--poll-ms', '50'], () => {}, (s) => err.push(s)), WAIT_TIMEOUT_EXIT)
    assert.match(err.join(''), /No answer to D3/)
  } finally {
    removeTmpDir(root)
  }
})
