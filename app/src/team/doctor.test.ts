import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { checkHooks, DoctorDeps, runDoctor, runDoctorCli, serveMappings } from './doctor'
import { addProject, saveConfig } from './projects'
import { CmdRunner, installService } from './service'
import { makeTmpDir, removeTmpDir } from './test-helpers'

const SERVE_OK = JSON.stringify({
  TCP: { 8443: { HTTPS: true } },
  Web: { 'mini.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3802' } } } },
})

test('serveMappings finds the https port that proxies to the monitor', () => {
  assert.deepEqual(serveMappings(SERVE_OK, 3802), ['8443'])
  assert.deepEqual(serveMappings(SERVE_OK, 3002), [])
  assert.deepEqual(serveMappings(JSON.stringify({ Web: { 'm.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }), 3000), ['443'])
  assert.deepEqual(serveMappings(JSON.stringify({ Web: { 'm.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:30020' } } } } }), 3002), [])
  assert.deepEqual(serveMappings('{}', 3802), [])
  assert.deepEqual(serveMappings('not json', 3802), [])
})

function settings(askHookFile: string, graph = true): string {
  const graphEntry = [{ hooks: [{ type: 'command', command: '"/n/node" "/u/.claude/agent-flow/hook.js"' }] }]
  const hooks: Record<string, unknown> = {}
  if (graph) for (const ev of ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']) hooks[ev] = [...graphEntry]
  hooks.PreToolUse = [...(hooks.PreToolUse as unknown[] ?? []), { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `"/n/node" "${askHookFile}"` }] }]
  return JSON.stringify({ hooks })
}

interface World { root: string; deps: DoctorDeps; home: string; proj: string; settingsFile: string; dist: string; serve: { json: string } }

/** Everything healthy: build, installed service, one project, serve mapping, token 0600, hooks. */
async function world(): Promise<World> {
  const root = makeTmpDir()
  const homedir = path.join(root, 'user')
  const home = path.join(homedir, '.team-monitor')
  const dist = path.join(root, 'checkout', 'app', 'dist')
  fs.mkdirSync(path.join(dist, 'webview'), { recursive: true })
  for (const f of ['app.js', 'ask-hook.js', 'webview/index.js', 'webview/index.css']) fs.writeFileSync(path.join(dist, f), '')
  const proj = path.join(root, 'web')
  fs.mkdirSync(proj)
  addProject(home, proj)
  fs.writeFileSync(path.join(home, 'token'), 'a'.repeat(64), { mode: 0o600 })
  const settingsFile = path.join(homedir, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, settings(path.join(dist, 'ask-hook.js')))
  const loaded = new Set<string>()
  const run: CmdRunner = (cmd, args) => {
    if (args[0] === 'print') return loaded.size ? { code: 0, stdout: 'state = running\npid = 99\n', stderr: '' } : { code: 113, stdout: '', stderr: '' }
    if (args[0] === 'bootstrap') loaded.add('x')
    return { code: 0, stdout: '', stderr: '' }
  }
  const serve = { json: SERVE_OK }
  const deps: DoctorDeps = {
    env: { TEAM_MONITOR_HOME: home }, platform: 'darwin', homedir, uid: 501, execPath: '/n/node',
    appJs: path.join(dist, 'app.js'), run, sleep: async () => {},
    runTailscale: (args) => args[0] === 'serve' ? serve.json : JSON.stringify({ Self: { DNSName: 'mini.tail1234.ts.net.' } }),
    probe: { portOpen: async () => true, health: async () => ({ ok: true, status: 200, projects: 1 }) },
    settingsFile, out: () => {}, err: () => {},
  }
  await installService({ port: 3802, remote: true, bind: 'loopback', hostAllow: [] }, deps)
  return { root, deps, home, proj, settingsFile, dist, serve }
}

const fails = async (deps: DoctorDeps) => (await runDoctor(deps)).filter((c) => c.level === 'fail').map((c) => c.what)

test('doctor: all good gives exit 0', async () => {
  const w = await world()
  try {
    const out: string[] = []
    assert.deepEqual(await fails(w.deps), [])
    assert.equal(await runDoctorCli([], { ...w.deps, out: (m) => out.push(m) }), 0)
    assert.equal(out[out.length - 1], '\nAll good.')
    assert.equal(await runDoctorCli(['--nope'], w.deps), 2)
  } finally {
    removeTmpDir(w.root)
  }
})

test('doctor: each broken piece is reported and gives exit 1', async () => {
  const w = await world()
  try {
    const expectFail = async (re: RegExp, deps: DoctorDeps = w.deps) => {
      const f = await fails(deps)
      assert.ok(f.some((m) => re.test(m)), `expected a failure matching ${re}, got ${JSON.stringify(f)}`)
      assert.equal(await runDoctorCli([], { ...deps, out: () => {} }), 1)
    }

    // Build
    fs.renameSync(path.join(w.dist, 'webview'), path.join(w.dist, 'webview-x'))
    await expectFail(/build incomplete.*webview/)
    fs.renameSync(path.join(w.dist, 'webview-x'), path.join(w.dist, 'webview'))

    // Service not loaded / not healthy
    await expectFail(/not running/, { ...w.deps, run: () => ({ code: 113, stdout: '', stderr: '' }) })
    await expectFail(/not healthy.*HTTP 500/, { ...w.deps, probe: { portOpen: async () => true, health: async () => ({ ok: false, status: 500, projects: null }) } })
    await expectFail(/port not listening/, { ...w.deps, probe: { portOpen: async () => false, health: async () => ({ ok: true, status: 200, projects: 1 }) } })

    // Project folder without .agent-team/
    fs.rmdirSync(path.join(w.proj, '.agent-team'))
    await expectFail(/\.agent-team\/ missing/)
    fs.mkdirSync(path.join(w.proj, '.agent-team'))

    // Missing project folder, no projects, broken config
    const cfg = path.join(w.home, 'config.json')
    const good = fs.readFileSync(cfg, 'utf-8')
    saveConfig(w.home, { projects: [{ id: 'gone', name: 'gone', path: path.join(w.root, 'gone') }] })
    await expectFail(/project gone .*folder missing/)
    saveConfig(w.home, {})
    await expectFail(/no projects/)
    fs.writeFileSync(cfg, '{broken')
    await expectFail(/config invalid/)
    fs.writeFileSync(cfg, good)

    // Tailscale serve mapping missing: prints the exact command
    w.serve.json = '{}'
    const out: string[] = []
    assert.equal(await runDoctorCli(['--https-port', '9443'], { ...w.deps, out: (m) => out.push(m) }), 1)
    assert.ok(out.some((l) => l.includes('fix: ') && l.includes('serve --bg --https=9443 http://127.0.0.1:3802')), out.join('\n'))
    await expectFail(/cannot read tailscale serve status/, { ...w.deps, runTailscale: () => { throw new Error('not running') } })
    w.serve.json = SERVE_OK

    // Token perms
    fs.chmodSync(path.join(w.home, 'token'), 0o644)
    await expectFail(/token file is 644/)
    fs.chmodSync(path.join(w.home, 'token'), 0o600)

    // Hooks
    fs.writeFileSync(w.settingsFile, settings(path.join(w.dist, 'ask-hook.js'), false))
    await expectFail(/graph hooks missing/)
    fs.writeFileSync(w.settingsFile, settings(path.join(w.root, 'old', 'ask-hook.js')))
    await expectFail(/points at a missing file/)

    // Back to all good
    fs.writeFileSync(w.settingsFile, settings(path.join(w.dist, 'ask-hook.js')))
    assert.deepEqual(await fails(w.deps), [])
  } finally {
    removeTmpDir(w.root)
  }
})

test('doctor: no service installed is a failure', async () => {
  const w = await world()
  try {
    fs.unlinkSync(path.join(w.home, 'service.json'))
    assert.ok((await fails(w.deps)).includes('service not installed'))
  } finally {
    removeTmpDir(w.root)
  }
})

test('checkHooks: missing settings and missing ask hook', () => {
  const root = makeTmpDir()
  try {
    assert.match(checkHooks(path.join(root, 'none.json'))[0].what, /missing/)
    const f = path.join(root, 's.json')
    fs.writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x agent-flow/hook.js' }] }] } }))
    const r = checkHooks(f)
    assert.ok(r.some((c) => c.level === 'fail' && /AskUserQuestion hook \(ask-hook\.js\) missing/.test(c.what)))
  } finally {
    removeTmpDir(root)
  }
})
