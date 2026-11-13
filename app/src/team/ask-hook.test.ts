import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { findProjectFor, parseHookInput, readAskHookMode, runAskHook } from './ask-hook'
import { makeProject, makeTmpDir, removeTmpDir } from './test-helpers'

const readState = (p: string) => JSON.parse(fs.readFileSync(path.join(p, '.agent-team', 'state.json'), 'utf-8'))

function hookInput(cwd: string, questions: unknown[], toolName = 'AskUserQuestion'): string {
  return JSON.stringify({
    session_id: 's1',
    transcript_path: '/tmp/x.jsonl',
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { questions },
    tool_use_id: 'toolu_1',
  })
}

const oneQuestion = [{
  question: 'Which framework?',
  header: 'Framework',
  multiSelect: false,
  options: [{ label: 'React', description: 'lib' }, { label: 'Vue (Recommended)', description: 'progressive' }],
}]

const twoQuestions = [
  ...oneQuestion,
  { question: 'Deploy now?', header: 'Deploy', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
]

/** Home with a config, a registered project and its state; returns paths and an env pointing at the temp home. */
function setup(root: string, config: Record<string, unknown> = {}) {
  const project = makeProject(root, 'proj')
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { mode: 0o700 })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ projects: [{ path: project }], ...config }))
  return { project, home, env: { TEAM_MONITOR_HOME: home } as NodeJS.ProcessEnv }
}

test('parseHookInput: one question, header as title, "(Recommended)" stripped', () => {
  const r = parseHookInput(hookInput('/work', oneQuestion))
  assert.deepEqual(r, {
    cwd: '/work',
    questions: [{ title: 'Framework', question: 'Which framework?', options: ['React', 'Vue'], recommended: 'Vue' }],
  })
})

test('parseHookInput: several questions, no recommended, missing header falls back to the question', () => {
  const r = parseHookInput(hookInput('/work', [
    ...twoQuestions,
    { question: 'Anything else?', options: [{ label: 'no (recommended) ' }, { label: 'yes' }, { label: '' }, {}] },
  ]))!
  assert.equal(r.questions.length, 3)
  assert.deepEqual(r.questions[1], { title: 'Deploy', question: 'Deploy now?', options: ['Yes', 'No'] })
  assert.equal(r.questions[1].recommended, undefined)
  assert.deepEqual(r.questions[2], { title: 'Anything else?', question: 'Anything else?', options: ['no', 'yes'], recommended: 'no' })
})

test('parseHookInput: other tools are ignored, malformed input throws', () => {
  assert.equal(parseHookInput(hookInput('/work', oneQuestion, 'Bash')), null)
  assert.throws(() => parseHookInput('not json'))
  assert.throws(() => parseHookInput('null'))
  assert.throws(() => parseHookInput(hookInput('relative/dir', oneQuestion)))
  assert.throws(() => parseHookInput(hookInput('/work', [])))
  assert.throws(() => parseHookInput(hookInput('/work', [{ header: 'x', options: [] }])))
})

test('findProjectFor: registered project containing cwd, else nearest .agent-team folder', () => {
  const root = makeTmpDir()
  try {
    const { project, home } = setup(root)
    const deep = path.join(project, 'src', 'a')
    fs.mkdirSync(deep, { recursive: true })
    assert.equal(findProjectFor(deep, home), project)
    assert.equal(findProjectFor(project, home), project)

    const other = makeProject(root, 'other')
    const otherDeep = path.join(other, 'x')
    fs.mkdirSync(otherDeep)
    assert.equal(findProjectFor(otherDeep, home), other)

    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    assert.equal(findProjectFor(plain, home), null)
    assert.equal(findProjectFor(path.join(root, 'missing'), home), null)
    // A sibling whose name starts with the project's name is not inside it.
    const sibling = path.join(root, 'proj-2')
    fs.mkdirSync(sibling)
    assert.equal(findProjectFor(sibling, home), null)
  } finally {
    removeTmpDir(root)
  }
})

test('readAskHookMode: default redirect, mirror when configured, unknown values fall back', () => {
  const root = makeTmpDir()
  try {
    assert.equal(readAskHookMode(path.join(root, 'nohome')), 'redirect')
    assert.equal(readAskHookMode(setup(root, { askHook: 'mirror' }).home), 'mirror')
    fs.writeFileSync(path.join(root, 'home', 'config.json'), JSON.stringify({ askHook: 'loud' }))
    assert.equal(readAskHookMode(path.join(root, 'home')), 'redirect')
  } finally {
    removeTmpDir(root)
  }
})

test('redirect mode: adds one decision per question and returns a valid PreToolUse deny', () => {
  const root = makeTmpDir()
  try {
    const { project, env } = setup(root)
    const r = runAskHook(hookInput(path.join(project), twoQuestions), { env, waitCommand: 'node /x/app.js wait-answer' })
    assert.equal(r.code, 0)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput'])
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    const reason: string = out.hookSpecificOutput.permissionDecisionReason
    assert.match(reason, /D3\.\.D4/)
    // --answers-only: an agent that asked must not be woken by (or report liveness for) the owner's chat.
    assert.ok(reason.includes(`node /x/app.js wait-answer --project "${project}" --answers-only`), reason)
    assert.match(reason, /run_in_background/)

    const s = readState(project)
    assert.equal(s.approvals.D3.title, 'Framework')
    assert.equal(s.approvals.D3.recommended, 'Vue')
    assert.equal(s.approvals.D3.status, 'open')
    assert.equal(s.approvals.D4.question, 'Deploy now?')
  } finally {
    removeTmpDir(root)
  }
})

test('mirror mode: adds the decisions, prints nothing, exit 0', () => {
  const root = makeTmpDir()
  try {
    const { project, env } = setup(root, { askHook: 'mirror' })
    const r = runAskHook(hookInput(project, oneQuestion), { env })
    assert.deepEqual(r, { code: 0, stdout: '' })
    assert.equal(readState(project).approvals.D3.title, 'Framework')
  } finally {
    removeTmpDir(root)
  }
})

test('silent exit 0 with a 0600 log line when there is no project or the input is bad', () => {
  const root = makeTmpDir()
  try {
    const { project, home, env } = setup(root)
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    const before = fs.readFileSync(path.join(project, '.agent-team', 'state.json'), 'utf-8')
    assert.deepEqual(runAskHook(hookInput(plain, oneQuestion), { env }), { code: 0, stdout: '' })
    assert.deepEqual(runAskHook('{garbage', { env }), { code: 0, stdout: '' })
    assert.deepEqual(runAskHook('', { env }), { code: 0, stdout: '' })
    assert.deepEqual(runAskHook(hookInput(project, oneQuestion, 'Bash'), { env }), { code: 0, stdout: '' })
    // Broken state.json in the project: no write, no block.
    fs.writeFileSync(path.join(project, '.agent-team', 'state.json'), '{"approvals":')
    assert.deepEqual(runAskHook(hookInput(project, oneQuestion), { env }), { code: 0, stdout: '' })
    assert.equal(fs.readFileSync(path.join(project, '.agent-team', 'state.json'), 'utf-8'), '{"approvals":')
    assert.notEqual(before, '')

    const log = path.join(home, 'ask-hook.log')
    const text = fs.readFileSync(log, 'utf-8')
    assert.match(text, /no team project/)
    assert.match(text, /bad hook input \(not valid JSON\)/)
    assert.ok(!text.includes('garbage'), 'the log never quotes the hook input')
    assert.match(text, /state\.json is not valid JSON/)
    assert.equal(fs.statSync(log).mode & 0o777, 0o600)
  } finally {
    removeTmpDir(root)
  }
})

test('hook entry as a separate process: reads stdin, prints the deny JSON, exit 0', async () => {
  const root = makeTmpDir()
  try {
    const { project, home } = setup(root)
    const entry = path.join(__dirname, 'ask-hook-main.ts')
    const run = (input: string) => new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', entry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TEAM_MONITOR_HOME: home },
      })
      let out = ''
      child.stdout.on('data', (c: Buffer) => { out += c.toString() })
      child.on('exit', (code) => resolve({ code, out }))
      child.stdin.end(input)
    })
    const r = await run(hookInput(project, oneQuestion))
    assert.equal(r.code, 0)
    assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny')
    assert.equal(readState(project).approvals.D3.title, 'Framework')
    const bad = await run('nope')
    assert.deepEqual(bad, { code: 0, out: '' })
  } finally {
    removeTmpDir(root)
  }
})
