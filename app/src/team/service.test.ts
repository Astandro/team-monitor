import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  buildSpec, CmdRunner, installService, parseInstallArgs, Probe, readServiceRecord, renderPlist, renderSystemdUnit,
  resolveHostAllow, restartIfInstalled, runServiceCli, ServiceDeps, ServiceError, ServiceSpec, serviceStatus,
  statusLines, systemdQuote, uninstallService,
} from './service'
import { addProject } from './projects'
import { makeTmpDir, removeTmpDir } from './test-helpers'

const golden = (name: string) => fs.readFileSync(path.join(__dirname, 'testdata', name), 'utf-8')
const mode = (p: string) => fs.statSync(p).mode & 0o777

test('plist matches the golden file', () => {
  const spec: ServiceSpec = {
    platform: 'darwin', label: 'com.example.team-monitor', node: '/opt/node/bin/node',
    appJs: '/srv/team-monitor/app/dist/app.js', port: 3002, remote: true, bind: 'loopback',
    hostAllow: ['mini.tail1234.ts.net'], workingDirectory: '/Users/u/projects/web & co', home: '/Users/u',
    teamHome: '/Users/u/.team-monitor', logFile: '/Users/u/.team-monitor/team-monitor.log',
  }
  assert.equal(renderPlist(spec), golden('launchd.plist.golden'))
})

test('systemd unit matches the golden file', () => {
  const spec: ServiceSpec = {
    platform: 'linux', label: 'team-monitor', node: '/home/u/.nvm/node 24/bin/node',
    appJs: '/home/u/team-monitor/app/dist/app.js', port: 3002, remote: true, bind: 'loopback',
    hostAllow: ['box.tail1234.ts.net'], workingDirectory: '/home/u/projects/100%web', home: '/home/u',
    teamHome: '/home/u/.team-monitor', logFile: '/home/u/.team-monitor/team-monitor.log',
  }
  assert.equal(renderSystemdUnit(spec), golden('systemd.service.golden'))
})

test('systemd quoting escapes quotes, backslashes, % and $; line breaks are refused', () => {
  assert.equal(systemdQuote('a b"c\\d'), '"a b\\"c\\\\d"')
  assert.equal(systemdQuote('100%$HOME'), '100%%$$HOME')
  const spec = { platform: 'linux', label: 'x', node: '/n', appJs: '/a.js', port: 1, remote: false, hostAllow: [],
    workingDirectory: '/w\nExecStartPre=/bin/evil', home: '/h', teamHome: '/t', logFile: '/l' } as ServiceSpec
  assert.throws(() => renderSystemdUnit(spec), ServiceError)
  assert.throws(() => renderPlist({ ...spec, platform: 'darwin' }), ServiceError)
})

test('MagicDNS: detected when Tailscale answers, warned and skipped when not, --host-allow wins', () => {
  const warns: string[] = []
  const ok = () => JSON.stringify({ Self: { DNSName: 'Mini.Tail1234.ts.net.' } })
  assert.deepEqual(resolveHostAllow([], ok, (m) => warns.push(m)), ['mini.tail1234.ts.net'])
  assert.equal(warns.length, 0)
  const down = () => { throw new Error('Tailscale is stopped') }
  assert.deepEqual(resolveHostAllow([], down, (m) => warns.push(m)), [])
  assert.equal(warns.length, 1)
  assert.match(warns[0], /--host-allow/)
  assert.deepEqual(resolveHostAllow([], () => '{"Self":{}}', () => {}), [])
  let called = false
  assert.deepEqual(resolveHostAllow(['Box.ts.net.'], () => { called = true; return ok() }, () => {}), ['box.ts.net'])
  assert.equal(called, false, 'no detection when --host-allow is given')
  assert.throws(() => resolveHostAllow(['bad host'], ok, () => {}), ServiceError)
})

// ─── install / status / restart / uninstall with fake launchctl and systemctl ─────────────────────────────────

interface Env { root: string; homedir: string; home: string; appJs: string; calls: string[][]; deps: ServiceDeps; loaded: Set<string> }

function fakeEnv(platform: 'darwin' | 'linux', opts: { tailscale?: () => string; healthy?: boolean } = {}): Env {
  const root = makeTmpDir()
  const homedir = path.join(root, 'user')
  const home = path.join(homedir, '.team-monitor')
  const appJs = path.join(root, 'checkout', 'app', 'dist', 'app.js')
  fs.mkdirSync(path.dirname(appJs), { recursive: true })
  fs.writeFileSync(appJs, '')
  const calls: string[][] = []
  const loaded = new Set<string>()
  const run: CmdRunner = (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'launchctl') {
      const [verb, target, file] = args
      if (verb === 'print') {
        const label = target.split('/')[2]
        return loaded.has(label)
          ? { code: 0, stdout: `${target} = {\n\tstate = running\n\tpid = 4242\n}`, stderr: '' }
          : { code: 113, stdout: '', stderr: 'Could not find service' }
      }
      if (verb === 'bootout') { loaded.delete(target.split('/')[2]); return { code: 0, stdout: '', stderr: '' } }
      if (verb === 'bootstrap') {
        const label = /<key>Label<\/key>\s*<string>([^<]+)</.exec(fs.readFileSync(file, 'utf-8'))![1]
        if (loaded.has(label)) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
        loaded.add(label)
        return { code: 0, stdout: '', stderr: '' }
      }
      if (verb === 'kickstart') return { code: loaded.has(args[2].split('/')[2]) ? 0 : 113, stdout: '', stderr: '' }
    }
    if (cmd === 'systemctl') {
      if (args[1] === 'show') return { code: 0, stdout: 'LoadState=loaded\nActiveState=active\nMainPID=777\n', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 127, stdout: '', stderr: 'unexpected' }
  }
  const healthy = opts.healthy ?? true
  const probe: Probe = {
    portOpen: async () => healthy,
    health: async () => healthy ? { ok: true, status: 200, projects: 1 } : { ok: false, status: 0, projects: null },
  }
  const deps: ServiceDeps = {
    env: { TEAM_MONITOR_HOME: home }, platform, homedir, uid: 501, execPath: '/opt/node/bin/node', appJs,
    run, runTailscale: opts.tailscale ?? (() => JSON.stringify({ Self: { DNSName: 'mini.tail1234.ts.net.' } })),
    sleep: async () => {}, probe, out: () => {}, err: () => {},
  }
  return { root, homedir, home, appJs, calls, deps, loaded }
}

test('install on macOS: plist from the spec, bootstrap, private log and record, projects from config', async () => {
  const e = fakeEnv('darwin')
  try {
    const proj = path.join(e.root, 'web')
    fs.mkdirSync(proj)
    addProject(e.home, proj)
    const rec = await installService({ port: 3802, remote: true, bind: 'loopback', hostAllow: [] }, e.deps)
    const plistFile = path.join(e.homedir, 'Library', 'LaunchAgents', 'com.astandro.team-monitor.plist')
    assert.equal(rec.file, plistFile)
    const plist = fs.readFileSync(plistFile, 'utf-8')
    const { spec } = buildSpec({ port: 3802, remote: true, bind: 'loopback', hostAllow: [] }, e.deps)
    assert.equal(plist, renderPlist(spec))
    assert.match(plist, /<string>--host-allow<\/string>\s*<string>mini\.tail1234\.ts\.net<\/string>/)
    assert.match(plist, new RegExp(`<key>TEAM_MONITOR_HOME</key>\\s*<string>${e.home}</string>`))
    assert.match(plist, new RegExp(`<key>WorkingDirectory</key>\\s*<string>${proj}</string>`))
    assert.doesNotMatch(plist, /--project/)
    assert.ok(e.loaded.has('com.astandro.team-monitor'))
    assert.deepEqual(e.calls.filter((c) => c[1] === 'bootstrap'), [['launchctl', 'bootstrap', 'gui/501', plistFile]])
    assert.equal(mode(rec.logFile), 0o600)
    assert.equal(mode(path.join(e.home, 'service.json')), 0o600)
    assert.equal(mode(e.home), 0o700)
    assert.equal(readServiceRecord(e.home)?.port, 3802)
  } finally {
    removeTmpDir(e.root)
  }
})

test('install replaces a loaded service cleanly: bootout before bootstrap', async () => {
  const e = fakeEnv('darwin')
  try {
    e.loaded.add('com.astandro.team-monitor')
    await installService({ port: 3802, remote: false, hostAllow: [] }, e.deps)
    const verbs = e.calls.filter((c) => c[1] === 'bootout' || c[1] === 'bootstrap').map((c) => c[1])
    assert.deepEqual(verbs, ['bootout', 'bootstrap'])
    assert.doesNotMatch(fs.readFileSync(readServiceRecord(e.home)!.file, 'utf-8'), /--remote|--host-allow/)

    // A new label replaces the old one as well (never two services on one port).
    await installService({ port: 3802, remote: false, hostAllow: [], label: 'com.example.tm' }, e.deps)
    assert.deepEqual([...e.loaded], ['com.example.tm'])
    assert.equal(fs.existsSync(path.join(e.homedir, 'Library', 'LaunchAgents', 'com.astandro.team-monitor.plist')), false)
  } finally {
    removeTmpDir(e.root)
  }
})

test('install refuses unsafe or impossible setups and writes nothing', async () => {
  const e = fakeEnv('darwin', { tailscale: () => { throw new Error('not running') } })
  try {
    const bad = async (opts: Parameters<typeof installService>[0], re: RegExp) => {
      await assert.rejects(installService(opts, e.deps), re)
    }
    await bad({ port: 3802, remote: true, bind: '0.0.0.0', hostAllow: [] }, /never listens on 0\.0\.0\.0/)
    await bad({ port: 3802, remote: true, hostAllow: [] }, /--bind loopback/)
    await bad({ port: 3802, remote: true, bind: 'tailscale', hostAllow: [] }, /tailscale ip -4/)
    await bad({ port: 3802, remote: false, bind: 'loopback', hostAllow: [] }, /need --remote/)
    await bad({ port: 3802, remote: false, hostAllow: [], label: 'a/b' }, /--label/)
    await assert.rejects(installService({ port: 3802, remote: false, hostAllow: [] }, { ...e.deps, appJs: path.join(e.root, 'app.ts') }), /built app/)
    await assert.rejects(installService({ port: 3802, remote: false, hostAllow: [] }, { ...e.deps, platform: 'win32' }), /macOS/)
    const e2 = fakeEnv('darwin', { tailscale: () => '192.168.1.5\n' })
    try {
      await assert.rejects(installService({ port: 3802, remote: true, bind: 'tailscale', hostAllow: [] }, e2.deps), /not a Tailscale address/)
    } finally { removeTmpDir(e2.root) }
    assert.equal(fs.existsSync(path.join(e.homedir, 'Library')), false)
    assert.deepEqual(e.calls, [])
  } finally {
    removeTmpDir(e.root)
  }
})

test('install without MagicDNS still works and warns', async () => {
  const e = fakeEnv('darwin', { tailscale: () => { throw new Error('down') } })
  try {
    const warns: string[] = []
    const rec = await installService({ port: 3802, remote: true, bind: 'loopback', hostAllow: [] }, { ...e.deps, err: (m) => warns.push(m) })
    assert.deepEqual(rec.hostAllow, [])
    assert.doesNotMatch(fs.readFileSync(rec.file, 'utf-8'), /--host-allow/)
    assert.equal(warns.length, 1)
  } finally {
    removeTmpDir(e.root)
  }
})

test('install on Linux: unit file, daemon-reload, enable, restart, linger hint only printed', async () => {
  const e = fakeEnv('linux')
  try {
    const out: string[] = []
    const code = await runServiceCli(['install', '--port', '3803'], { ...e.deps, out: (m) => out.push(m) })
    assert.equal(code, 0)
    const file = path.join(e.homedir, '.config', 'systemd', 'user', 'team-monitor.service')
    assert.match(fs.readFileSync(file, 'utf-8'), /^Restart=always$/m)
    assert.deepEqual(e.calls.filter((c) => c[2] !== 'show').map((c) => c.slice(1).join(' ')), [
      '--user daemon-reload', '--user enable team-monitor.service', '--user restart team-monitor.service',
    ])
    assert.ok(out.some((l) => l.includes('loginctl enable-linger')))
    assert.ok(!e.calls.some((c) => c[0] === 'loginctl'))
    assert.deepEqual(await uninstallService(e.deps), [
      'Stopped and disabled team-monitor.service.', `Removed ${file}.`,
    ])
    assert.equal(fs.existsSync(file), false)
  } finally {
    removeTmpDir(e.root)
  }
})

test('status, restart and uninstall on macOS', async () => {
  const e = fakeEnv('darwin')
  try {
    assert.equal(statusLines(await serviceStatus(e.deps)).ok, false)
    assert.match(await restartIfInstalled(e.deps), /No service installed/)
    await installService({ port: 3802, remote: false, hostAllow: [] }, e.deps)

    const st = await serviceStatus(e.deps)
    const { lines, ok } = statusLines(st)
    assert.equal(ok, true)
    assert.ok(lines.some((l) => l.includes('pid 4242')))
    // The health route carries no project information (P-01): only its status.
    assert.ok(lines.some((l) => l === 'Health GET /healthz: 200 ok'), lines.join('\n'))

    assert.equal(statusLines(await serviceStatus({ ...e.deps, probe: { portOpen: async () => true, health: async () => ({ ok: false, status: 401, projects: null }) } })).ok, false)

    e.calls.length = 0
    assert.match(await restartIfInstalled(e.deps), /Restarted com\.astandro\.team-monitor/)
    assert.deepEqual(e.calls.filter((c) => c[1] === 'kickstart'), [['launchctl', 'kickstart', '-k', 'gui/501/com.astandro.team-monitor']])

    const out: string[] = []
    assert.equal(await runServiceCli(['uninstall'], { ...e.deps, out: (m) => out.push(m) }), 0)
    assert.equal(e.loaded.size, 0)
    assert.equal(fs.existsSync(path.join(e.homedir, 'Library', 'LaunchAgents', 'com.astandro.team-monitor.plist')), false)
    assert.equal(readServiceRecord(e.home), null)
    assert.equal(await runServiceCli(['status'], e.deps), 1)
  } finally {
    removeTmpDir(e.root)
  }
})

test('install exits 1 with the log path when the service never gets healthy', async () => {
  const e = fakeEnv('darwin', { healthy: false })
  try {
    const errs: string[] = []
    assert.equal(await runServiceCli(['install', '--port', '3804'], { ...e.deps, err: (m) => errs.push(m) }), 1)
    assert.ok(errs.some((l) => l.includes('team-monitor.log')))
  } finally {
    removeTmpDir(e.root)
  }
})

test('install argument parsing', () => {
  assert.deepEqual(parseInstallArgs(['--port', '3002', '--remote', '--bind', 'loopback', '--host-allow', 'a', '--host-allow', 'b']),
    { port: 3002, remote: true, bind: 'loopback', hostAllow: ['a', 'b'] })
  assert.equal(typeof parseInstallArgs(['--port', '0']), 'string')
  assert.equal(typeof parseInstallArgs(['--port']), 'string')
  assert.equal(typeof parseInstallArgs(['--wat', 'x']), 'string')
})
