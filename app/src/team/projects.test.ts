import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { buildRegistry, readConfigProjects } from './config'
import { addProject, gitExcludeFile, listProjects, ProjectError, removeProject, runProjectCli } from './projects'
import { makeTmpDir, removeTmpDir } from './test-helpers'

const mode = (p: string) => fs.statSync(p).mode & 0o777
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>

function setup(): { root: string; home: string; repo: string } {
  const root = makeTmpDir()
  const home = path.join(root, 'home')
  const repo = path.join(root, 'My App')
  fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true })
  return { root, home, repo }
}

test('project add: config 0600 in a 0700 home, .agent-team/ created, excluded once, other keys kept', () => {
  const { root, home, repo } = setup()
  try {
    fs.mkdirSync(home, { mode: 0o755 })
    fs.chmodSync(home, 0o755)
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ askHook: 'mirror', autoOffboardMinutes: 30 }), { mode: 0o644 })
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n*.log')
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')

    const r = addProject(home, repo, 'My App web')
    assert.equal(r.added, true)
    assert.deepEqual(r.project, { id: 'my-app', name: 'My App web', path: repo })
    assert.equal(r.agentTeamCreated, true)
    assert.ok(fs.statSync(path.join(repo, '.agent-team')).isDirectory())

    const cfg = path.join(home, 'config.json')
    assert.equal(mode(home), 0o700)
    assert.equal(mode(cfg), 0o600)
    const data = readJson(cfg)
    assert.equal(data.askHook, 'mirror')
    assert.equal(data.autoOffboardMinutes, 30)
    assert.deepEqual(data.projects, [{ id: 'my-app', name: 'My App web', path: repo }])
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), [], 'no temp file left')

    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8')
    assert.match(exclude, /\*\.log\n# team monitor state \(local only\)\n\.agent-team\/\n$/)
    assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf-8'), 'node_modules/\n', 'tracked .gitignore untouched')

    // Again: idempotent, nothing appended twice, no second entry.
    const again = addProject(home, path.join(repo, '.', ''))
    assert.equal(again.added, false)
    assert.equal(again.exclude.added, false)
    assert.equal(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8'), exclude)
    assert.equal((readJson(cfg).projects as unknown[]).length, 1)

    // The server's registry reads what was written.
    assert.deepEqual(buildRegistry(readConfigProjects(home, () => {}), []).map((p) => [p.id, p.name, p.path]), [['my-app', 'My App web', repo]])
  } finally {
    removeTmpDir(root)
  }
})

test('project add: unique ids, a missing folder or a file is refused, non-git folders are fine', () => {
  const { root, home } = setup()
  try {
    for (const d of ['a/web', 'b/web']) fs.mkdirSync(path.join(root, d), { recursive: true })
    assert.equal(addProject(home, path.join(root, 'a/web')).project.id, 'web')
    const second = addProject(home, path.join(root, 'b/web'))
    assert.equal(second.project.id, 'web-2')
    assert.equal(second.exclude.file, null)
    assert.throws(() => addProject(home, path.join(root, 'missing')), ProjectError)
    fs.writeFileSync(path.join(root, 'file'), '')
    assert.throws(() => addProject(home, path.join(root, 'file')), /not a folder/)
    assert.throws(() => addProject(home, path.join(root, 'a/web'), '  '), /--name/)
    assert.equal(listProjects(home).length, 2)
  } finally {
    removeTmpDir(root)
  }
})

test('project add: a git worktree (.git file) uses the main repo info/exclude', () => {
  const { root, home, repo } = setup()
  try {
    const wt = path.join(root, 'wt')
    const gitDir = path.join(repo, '.git', 'worktrees', 'wt')
    fs.mkdirSync(gitDir, { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n')
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`)
    assert.equal(gitExcludeFile(path.join(wt, 'sub')), path.join(repo, '.git', 'info', 'exclude'))
    const r = addProject(home, path.join(wt, 'sub'))
    assert.equal(r.exclude.added, true)
    assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8'), /^# team monitor state \(local only\)\n\.agent-team\/\n$/)
  } finally {
    removeTmpDir(root)
  }
})

test('a broken config.json is refused and left byte for byte; the project folder is not touched', () => {
  const { root, home, repo } = setup()
  try {
    fs.mkdirSync(home, { mode: 0o700 })
    const cfg = path.join(home, 'config.json')
    for (const bad of ['{nope', '[]', '{"projects": {}}']) {
      fs.writeFileSync(cfg, bad)
      assert.throws(() => addProject(home, repo), ProjectError)
      assert.throws(() => removeProject(home, 'x'), ProjectError)
      assert.equal(fs.readFileSync(cfg, 'utf-8'), bad)
    }
    assert.equal(fs.existsSync(path.join(repo, '.agent-team')), false)
  } finally {
    removeTmpDir(root)
  }
})

test('a failed write leaves the old config.json and no temp file', () => {
  const { root, home, repo } = setup()
  try {
    addProject(home, repo)
    const cfg = path.join(home, 'config.json')
    const before = fs.readFileSync(cfg, 'utf-8')
    const other = path.join(root, 'other')
    fs.mkdirSync(other)
    fs.chmodSync(home, 0o500) // temp file cannot be created
    try {
      assert.throws(() => addProject(home, other))
    } finally {
      fs.chmodSync(home, 0o700)
    }
    assert.equal(fs.readFileSync(cfg, 'utf-8'), before)
    assert.deepEqual(fs.readdirSync(home), ['config.json'])
  } finally {
    removeTmpDir(root)
  }
})

test('project remove by id or path keeps the others and the .agent-team folder', () => {
  const { root, home, repo } = setup()
  try {
    const other = path.join(root, 'other')
    fs.mkdirSync(other)
    addProject(home, repo)
    addProject(home, other)
    assert.equal(removeProject(home, 'my-app').path, repo)
    assert.deepEqual(listProjects(home).map((p) => p.id), ['other'])
    assert.equal(removeProject(home, other).id, 'other')
    assert.deepEqual(listProjects(home), [])
    assert.ok(fs.existsSync(path.join(repo, '.agent-team')))
    assert.throws(() => removeProject(home, 'nope'), /no project "nope"/)
    assert.equal(mode(path.join(home, 'config.json')), 0o600)
  } finally {
    removeTmpDir(root)
  }
})

test('project CLI: restarts the service only when something changed; exit codes', async () => {
  const { root, home, repo } = setup()
  try {
    const out: string[] = []
    let restarts = 0
    const deps = {
      env: { TEAM_MONITOR_HOME: home }, out: (m: string) => out.push(m), err: (m: string) => out.push(m),
      restartService: async () => { restarts++; return 'restarted' },
    }
    assert.equal(await runProjectCli(['add', repo, '--name', 'My App'], deps), 0)
    assert.equal(restarts, 1)
    assert.equal(await runProjectCli(['add', repo], deps), 0)
    assert.equal(restarts, 1, 'already registered: no restart')
    assert.equal(await runProjectCli(['add', repo, '--no-restart', '--name', 'X'], deps), 0)
    assert.equal(restarts, 1)
    out.length = 0
    assert.equal(await runProjectCli(['list'], deps), 0)
    assert.deepEqual(out, [`my-app\tX\t${repo}`])
    assert.equal(await runProjectCli(['remove', 'my-app'], deps), 0)
    assert.equal(restarts, 2)
    assert.equal(await runProjectCli(['remove', 'my-app'], deps), 1)
    assert.equal(await runProjectCli(['add'], deps), 2)
    assert.equal(await runProjectCli(['add', repo, '--bogus'], deps), 2)
  } finally {
    removeTmpDir(root)
  }
})
