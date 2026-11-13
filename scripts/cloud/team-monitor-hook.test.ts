/**
 * scripts/cloud/team-monitor-hook.sh and pack-release.sh (acceptance criterion 10): the hook installs from a local
 * tarball packed like the release (TEAM_MONITOR_TARBALL) when the pinned sha256 matches, and refuses a mismatching
 * or unsafe one with exit 0, one line and nothing started. The last test packs a real bundle of the app and lets
 * the hook start the real monitor (on a free port, never 3002) and stops it again.
 */
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { buildAppBundle, makeTmpDir, removeTmpDir, waitFor } from '../../app/src/team/test-helpers'

const HERE = __dirname
const HOOK = path.join(HERE, 'team-monitor-hook.sh')
const PACK = path.join(HERE, 'pack-release.sh')
const VERSION = '9.8.7-test'
const posix = process.platform !== 'win32'

const root = makeTmpDir()
after(() => removeTmpDir(root))
let n = 0

/** A copy of the hook with VERSION and SHA256 filled in, as a project would commit it. */
function pinnedHook(version: string, sha: string): string {
  const src = fs.readFileSync(HOOK, 'utf-8')
  assert.ok(src.includes('VERSION=""') && src.includes('SHA256=""'))
  const file = path.join(root, `hook-${++n}.sh`)
  fs.writeFileSync(file, src.replace('VERSION=""', `VERSION="${version}"`).replace('SHA256=""', `SHA256="${sha}"`))
  return file
}

/** A fake app (app.js records how it was started) packed by pack-release.sh. */
function packFake(): { tgz: string; sha: string; pin: string } {
  const dist = path.join(root, `dist-${++n}`)
  fs.mkdirSync(path.join(dist, 'webview'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'webview', 'index.html'), '<!doctype html>')
  fs.writeFileSync(path.join(dist, 'app.js'), [
    "const fs = require('fs')",
    "fs.writeFileSync(process.env.HOOK_TEST_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))",
    "console.log('team-monitor: fake cloud start')",
  ].join('\n'))
  const out = path.join(root, `out-${n}`)
  const r = spawnSync('sh', [PACK, out], { env: { ...process.env, TEAM_MONITOR_DIST: dist, TEAM_MONITOR_VERSION: VERSION }, encoding: 'utf-8' })
  assert.equal(r.status, 0, r.stderr)
  const tgz = path.join(out, `team-monitor-${VERSION}.tgz`)
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex')
  return { tgz, sha, pin: r.stdout }
}

function runHook(hook: string, env: Record<string, string>): { code: number | null; out: string; err: string } {
  const r = spawnSync('sh', [hook], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, encoding: 'utf-8', timeout: 30_000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function box() {
  const dir = path.join(root, `box-${++n}`)
  const home = path.join(dir, 'home')
  const project = path.join(dir, 'project')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(project)
  return { home, project, marker: path.join(dir, 'started.json'), apps: path.join(home, '.team-monitor', 'app') }
}

test('pack-release.sh writes the tarball, its .sha256 and the two pin lines', { skip: !posix }, () => {
  const { tgz, sha, pin } = packFake()
  assert.equal(fs.readFileSync(`${tgz}.sha256`, 'utf-8'), `${sha}  team-monitor-${VERSION}.tgz\n`)
  assert.equal(pin, `VERSION="${VERSION}"\nSHA256="${sha}"\n`)
  assert.equal(fs.readFileSync(tgz.replace(/\.tgz$/, '.pin.txt'), 'utf-8'), pin)
  const list = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf-8' }).stdout.split('\n').filter(Boolean)
  assert.ok(list.every((m) => m.startsWith(`team-monitor-${VERSION}/`)), list.join(','))
  assert.ok(list.includes(`team-monitor-${VERSION}/app.js`))
})

test('outside a cloud session the hook does nothing at all', { skip: !posix }, () => {
  const { sha, tgz } = packFake()
  const b = box()
  const r = runHook(pinnedHook(VERSION, sha), { HOME: b.home, TEAM_MONITOR_TARBALL: tgz, HOOK_TEST_OUT: b.marker })
  assert.deepEqual(r, { code: 0, out: '', err: '' })
  assert.equal(fs.existsSync(path.join(b.home, '.team-monitor')), false)
  assert.equal(fs.existsSync(b.marker), false)
})

test('a matching sha256 installs the release and runs cloud start for the project; a second run reuses it', { skip: !posix }, () => {
  const { sha, tgz } = packFake()
  const b = box()
  const hook = pinnedHook(VERSION, sha)
  const env = { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, TEAM_MONITOR_TARBALL: tgz, HOOK_TEST_OUT: b.marker }
  const r = runHook(hook, env)
  assert.equal(r.code, 0)
  assert.equal(r.err, '')
  assert.equal(r.out, 'team-monitor: fake cloud start\n')
  const dest = path.join(b.apps, VERSION)
  assert.ok(fs.existsSync(path.join(dest, 'app.js')))
  assert.ok(fs.existsSync(path.join(dest, 'webview', 'index.html')))
  assert.equal(fs.readFileSync(path.join(dest, '.sha256'), 'utf-8').trim(), sha)
  assert.deepEqual(JSON.parse(fs.readFileSync(b.marker, 'utf-8')).argv, ['cloud', 'start', '--project', b.project])
  assert.deepEqual(fs.readdirSync(b.apps), [VERSION], 'no temp folder left behind')
  assert.equal(fs.statSync(path.join(b.home, '.team-monitor')).mode & 0o777, 0o700)

  // Already unpacked: not unpacked again (a file added to it stays), started again; no tarball needed.
  fs.writeFileSync(path.join(dest, 'keep'), 'x')
  fs.unlinkSync(b.marker)
  const again = runHook(hook, { ...env, TEAM_MONITOR_TARBALL: path.join(root, 'missing.tgz'), TEAM_MONITOR_PORT: '4555' })
  assert.equal(again.code, 0)
  assert.equal(again.err, '')
  assert.ok(fs.existsSync(path.join(dest, 'keep')))
  assert.deepEqual(JSON.parse(fs.readFileSync(b.marker, 'utf-8')).argv, ['cloud', 'start', '--project', b.project, '--port', '4555'])

  // Without CLAUDE_PROJECT_DIR the current folder is the project.
  fs.unlinkSync(b.marker)
  const r3 = spawnSync('sh', [hook], { cwd: b.project, env: { PATH: process.env.PATH, HOME: b.home, CLAUDE_CODE_REMOTE: 'true', HOOK_TEST_OUT: b.marker }, encoding: 'utf-8' })
  assert.equal(r3.status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(b.marker, 'utf-8')).argv, ['cloud', 'start', '--project', fs.realpathSync(b.project)])
})

test('a mismatching sha256 is refused: exit 0, one line, nothing installed, nothing started', { skip: !posix }, () => {
  const { tgz } = packFake()
  const b = box()
  const r = runHook(pinnedHook(VERSION, 'a'.repeat(64)), { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, TEAM_MONITOR_TARBALL: tgz, HOOK_TEST_OUT: b.marker })
  assert.equal(r.code, 0)
  assert.equal(r.out, '')
  assert.equal(r.err.trim().split('\n').length, 1, r.err)
  assert.match(r.err, /^team-monitor: sha256 mismatch/)
  assert.deepEqual(fs.readdirSync(b.apps), [])
  assert.equal(fs.existsSync(b.marker), false)
})

test('unsafe archives are refused even with a matching sha256: absolute paths, "..", members outside the folder, links', { skip: process.platform !== 'linux' }, () => {
  const make = (name: string, build: (stage: string) => string[], extra: string[] = []) => {
    const stage = path.join(root, `stage-${++n}`)
    fs.mkdirSync(path.join(stage, `team-monitor-${VERSION}`), { recursive: true })
    fs.writeFileSync(path.join(stage, `team-monitor-${VERSION}`, 'app.js'), '')
    const members = build(stage)
    const tgz = path.join(root, `${name}-${n}.tgz`)
    const r = spawnSync('tar', ['-czf', tgz, ...extra, '-C', stage, ...members], { encoding: 'utf-8' })
    assert.equal(r.status, 0, r.stderr)
    return tgz
  }
  const top = `team-monitor-${VERSION}`
  const cases: Record<string, string> = {
    dotdot: make('dotdot', (s) => { fs.writeFileSync(path.join(s, 'evil'), 'x'); return [top, `${top}/../evil`] }, ['-P']),
    absolute: make('absolute', (s) => { const abs = path.join(s, 'abs-evil'); fs.writeFileSync(abs, 'x'); return [top, abs] }, ['-P']),
    outside: make('outside', (s) => { fs.writeFileSync(path.join(s, 'other.js'), 'x'); return [top, 'other.js'] }),
    symlink: make('symlink', (s) => { fs.symlinkSync('/etc/passwd', path.join(s, top, 'link')); return [top] }),
  }
  for (const [what, tgz] of Object.entries(cases)) {
    const b = box()
    const sha = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex')
    const r = runHook(pinnedHook(VERSION, sha), { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, TEAM_MONITOR_TARBALL: tgz, HOOK_TEST_OUT: b.marker })
    assert.equal(r.code, 0, what)
    assert.equal(r.err.trim().split('\n').length, 1, `${what}: ${r.err}`)
    assert.match(r.err, /members outside .* or links; not installed/, what)
    assert.deepEqual(fs.readdirSync(b.apps), [], what)
    assert.equal(fs.existsSync(b.marker), false, what)
  }
})

test('missing pins, a missing tarball or a failing download: one line, exit 0', { skip: !posix }, () => {
  const b = box()
  const env = { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, HOOK_TEST_OUT: b.marker }
  const noPin = runHook(HOOK, env)
  assert.equal(noPin.code, 0)
  assert.match(noPin.err, /^team-monitor: set VERSION/)
  const badSha = runHook(pinnedHook(VERSION, 'xyz'), env)
  assert.match(badSha.err, /^team-monitor: set SHA256/)
  const missing = runHook(pinnedHook(VERSION, 'b'.repeat(64)), { ...env, TEAM_MONITOR_TARBALL: path.join(root, 'nope.tgz') })
  assert.equal(missing.code, 0)
  assert.equal(missing.err.trim().split('\n').length, 1)
  assert.match(missing.err, /not found; not started/)
  // Download: a fake curl that fails (no network in tests)
  const bin = path.join(root, `bin-${++n}`)
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nexit 22\n', { mode: 0o755 })
  const dl = runHook(pinnedHook(VERSION, 'b'.repeat(64)), { ...env, PATH: `${bin}:${process.env.PATH}` })
  assert.equal(dl.code, 0)
  assert.equal(dl.err.trim().split('\n').length, 1)
  assert.match(dl.err, /download of https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v9\.8\.7-test\/team-monitor-9\.8\.7-test\.tgz failed/)
  assert.equal(fs.existsSync(b.marker), false)
  assert.deepEqual(fs.readdirSync(b.apps), [])
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p === 3002 ? p + 1 : p))
    })
  })
}

test('the real app, packed like a release, installed by the hook: cloud start starts the monitor', { skip: process.platform !== 'linux', timeout: 60_000 }, async () => {
  const dist = path.join(root, 'real-dist')
  buildAppBundle(dist)
  const out = path.join(root, 'real-out')
  const pack = spawnSync('sh', [PACK, out], { env: { ...process.env, TEAM_MONITOR_DIST: dist, TEAM_MONITOR_VERSION: VERSION }, encoding: 'utf-8' })
  assert.equal(pack.status, 0, pack.stderr)
  const sha = /SHA256="([0-9a-f]{64})"/.exec(pack.stdout)![1]
  const b = box()
  const port = await freePort()
  const env = { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, TEAM_MONITOR_TARBALL: path.join(out, `team-monitor-${VERSION}.tgz`), TEAM_MONITOR_PORT: String(port) }
  const app = path.join(b.apps, VERSION, 'app.js')
  try {
    const t0 = Date.now()
    const r = runHook(pinnedHook(VERSION, sha), env)
    assert.equal(r.code, 0, r.err)
    assert.ok(Date.now() - t0 < 10_000)
    assert.match(r.out, new RegExp(`^team-monitor: cloud mode, project project: monitor (started|still starting) on http://127\\.0\\.0\\.1:${port}; no hub \\(TEAM_MONITOR_HUB_URL not set\\)\\n$`))
    assert.equal(r.err, '')
    await waitFor(() => spawnSync(process.execPath, [app, 'cloud', 'status', '--port', String(port)], { env: { PATH: process.env.PATH, HOME: b.home } }).status === 0, 15_000, 300)
  } finally {
    const stop = spawnSync(process.execPath, [app, 'cloud', 'stop'], { env: { PATH: process.env.PATH, HOME: b.home }, encoding: 'utf-8' })
    assert.match(stop.stdout, /Monitor: (stopped|killed)/)
  }
})
