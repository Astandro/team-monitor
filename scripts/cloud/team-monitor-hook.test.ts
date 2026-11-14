/**
 * scripts/cloud/team-monitor-hook.sh and pack-release.sh (acceptance criterion 10): the hook installs from a local
 * tarball packed like the release (TEAM_MONITOR_TARBALL) when the pinned sha256 matches, and refuses a mismatching
 * or unsafe one with exit 0, one line and nothing started. The last test packs a real bundle of the app and lets
 * the hook start the real monitor (on a free port, never 3002) and stops it again.
 */
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import * as zlib from 'zlib'
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
    assert.match(r.err, what === 'symlink' ? /not plain files or folders .*; not installed/ : /members outside .*; not installed/, what)
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

// ---- F-14: archive members that are not plain files/folders, setuid bits, foreign owners -------------------------

/** One ustar header (+ padded body), written by hand so FIFOs, devices and setuid members need no root to create. */
function tarEntry(o: { name: string; type: string; mode: number; uid?: number; gid?: number; body?: string; link?: string }): Buffer {
  const body = Buffer.from(o.body ?? '')
  const h = Buffer.alloc(512)
  const put = (s: string, off: number, len: number) => { h.write(s, off, Math.min(len, Buffer.byteLength(s)), 'utf8') }
  const oct = (v: number, off: number, len: number) => put(v.toString(8).padStart(len - 1, '0') + '\0', off, len)
  put(o.name, 0, 100)
  oct(o.mode, 100, 8)
  oct(o.uid ?? 0, 108, 8)
  oct(o.gid ?? 0, 116, 8)
  oct(o.type === '0' ? body.length : 0, 124, 12)
  oct(Math.floor(Date.now() / 1000), 136, 12)
  h.fill(0x20, 148, 156)
  put(o.type, 156, 1)
  put(o.link ?? '', 157, 100)
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  put('someone', 265, 32)
  put('somegroup', 297, 32)
  oct(o.type === '3' || o.type === '4' ? 1 : 0, 329, 8)
  oct(o.type === '3' || o.type === '4' ? 3 : 0, 337, 8)
  let sum = 0
  for (const b of h) sum += b
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512)
  return Buffer.concat(o.type === '0' ? [h, body, pad] : [h])
}

const TOP = `team-monitor-${VERSION}`

/** A gzipped tarball of the given entries (a top folder and app.js first unless the entries say otherwise). */
function craftTgz(label: string, entries: Parameters<typeof tarEntry>[0][]): { tgz: string; sha: string } {
  const data = zlib.gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]))
  const tgz = path.join(root, `${label}-${++n}.tgz`)
  fs.writeFileSync(tgz, data)
  return { tgz, sha: crypto.createHash('sha256').update(data).digest('hex') }
}

const appJs = (extra: Partial<Parameters<typeof tarEntry>[0]> = {}) => ({
  name: `${TOP}/app.js`, type: '0', mode: 0o644,
  body: "require('fs').writeFileSync(process.env.HOOK_TEST_OUT, JSON.stringify({ argv: process.argv.slice(2) }))\n",
  ...extra,
})

test('F-14: members that are not plain files or folders, or carry setuid/setgid/sticky bits, are refused before anything is unpacked', { skip: !posix }, () => {
  const dir = { name: `${TOP}/`, type: '5', mode: 0o755 }
  const cases: Record<string, Parameters<typeof tarEntry>[0][]> = {
    fifo: [dir, appJs(), { name: `${TOP}/pipe`, type: '6', mode: 0o644 }],
    chardev: [dir, appJs(), { name: `${TOP}/tty`, type: '3', mode: 0o666 }],
    blockdev: [dir, appJs(), { name: `${TOP}/disk`, type: '4', mode: 0o660 }],
    hardlink: [dir, appJs(), { name: `${TOP}/hard`, type: '1', mode: 0o644, link: `${TOP}/app.js` }],
    symlink: [dir, appJs(), { name: `${TOP}/soft`, type: '2', mode: 0o777, link: 'app.js' }],
    setuid: [dir, appJs(), { name: `${TOP}/su`, type: '0', mode: 0o4755, body: 'x' }],
    setgid: [dir, appJs({ mode: 0o2755 })],
    sticky: [{ ...dir, mode: 0o1777 }, appJs()],
  }
  for (const [what, entries] of Object.entries(cases)) {
    const { tgz, sha } = craftTgz(what, entries)
    const b = box()
    const r = runHook(pinnedHook(VERSION, sha), { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, TEAM_MONITOR_TARBALL: tgz, HOOK_TEST_OUT: b.marker })
    assert.equal(r.code, 0, what)
    assert.equal(r.out, '', what)
    assert.equal(r.err.trim().split('\n').length, 1, `${what}: ${r.err}`)
    assert.match(r.err, /not plain files or folders .*; not installed, not started/, what)
    assert.deepEqual(fs.readdirSync(b.apps), [], `${what}: nothing unpacked, no temp folder`)
    assert.equal(fs.existsSync(b.marker), false, what)
  }
})

test('F-14: installed files belong to the current user with plain modes, whatever owner and modes the archive names', { skip: !posix }, () => {
  const { tgz, sha } = craftTgz('owners', [
    { name: `${TOP}/`, type: '5', mode: 0o777, uid: 4321, gid: 4321 },
    appJs({ mode: 0o600, uid: 4321, gid: 4321 }),
    { name: `${TOP}/webview/`, type: '5', mode: 0o700, uid: 4321, gid: 4321 },
    { name: `${TOP}/webview/index.html`, type: '0', mode: 0o666, uid: 4321, gid: 4321, body: '<!doctype html>' },
    { name: `${TOP}/tool.sh`, type: '0', mode: 0o777, uid: 4321, gid: 4321, body: '#!/bin/sh\n' },
  ])
  const b = box()
  const r = runHook(pinnedHook(VERSION, sha), { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, TEAM_MONITOR_TARBALL: tgz, HOOK_TEST_OUT: b.marker })
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
  assert.ok(fs.existsSync(b.marker), 'started')
  const dest = path.join(b.apps, VERSION)
  const want: Record<string, number> = { '.': 0o755, 'app.js': 0o644, webview: 0o755, 'webview/index.html': 0o644, 'tool.sh': 0o755 }
  for (const [rel, mode] of Object.entries(want)) {
    const st = fs.statSync(path.join(dest, rel))
    assert.equal(st.mode & 0o7777, mode, `${rel} mode ${(st.mode & 0o7777).toString(8)}`)
    if (process.getuid) assert.equal(st.uid, process.getuid(), `${rel} owner`)
    if (process.getgid) assert.equal(st.gid, process.getgid(), `${rel} group`)
  }
})

// ---- F-19: one overall time budget, no retry storm, temp folder removed on timeout or kill ------------------------

/** A fake curl: records its pid and arguments, then hangs (or, with CURL_COPY, sleeps CURL_SLEEP s and "downloads"). */
function fakeCurlBin(): string {
  const bin = path.join(root, `bin-${++n}`)
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'curl'), [
    '#!/bin/sh',
    'printf "%s\\n" "$$" > "$CURL_PID"',
    'printf "%s\\n" "$@" > "$CURL_ARGS"',
    'if [ -n "${CURL_COPY:-}" ]; then',
    '  sleep "$CURL_SLEEP"; prev=""; out=""',
    '  for a in "$@"; do [ "$prev" = "-o" ] && out=$a; prev=$a; done',
    '  cp "$CURL_COPY" "$out"; exit 0',
    'fi',
    'exec sleep 30',
  ].join('\n') + '\n', { mode: 0o755 })
  return bin
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')) } catch { return true }
}

function readPid(file: string): number { return Number(fs.readFileSync(file, 'utf-8').trim()) }

test('F-19: a hanging download is stopped at the time budget: one line, exit 0, no temp folder, curl gone, nothing started', { skip: !posix, timeout: 40_000 }, async () => {
  const b = box()
  const bin = fakeCurlBin()
  const pidFile = path.join(root, `curl-pid-${++n}`)
  const argsFile = path.join(root, `curl-args-${n}`)
  const env = { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, HOOK_TEST_OUT: b.marker, PATH: `${bin}:${process.env.PATH}`, CURL_PID: pidFile, CURL_ARGS: argsFile, TEAM_MONITOR_HOOK_BUDGET: '2' }
  const t0 = Date.now()
  const r = spawnSync('sh', [pinnedHook(VERSION, 'b'.repeat(64))], { env, encoding: 'utf-8', timeout: 20_000 })
  const took = Date.now() - t0
  try {
    assert.ok(took < 8_000, `took ${took} ms`)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr)
    assert.match(r.stderr, /^team-monitor: did not finish within 2s .*not started\n$/)
    assert.deepEqual(fs.readdirSync(b.apps), [], 'temp folder removed')
    assert.equal(fs.existsSync(b.marker), false)
    await waitFor(() => !alive(readPid(pidFile)), 3_000, 100)
  } finally {
    if (fs.existsSync(pidFile) && alive(readPid(pidFile))) process.kill(readPid(pidFile), 'SIGKILL')
  }
})

test('F-19: curl gets one attempt with a max time inside the budget (no retries)', { skip: !posix }, () => {
  const { sha, tgz } = packFake()
  const b = box()
  const bin = fakeCurlBin()
  const argsFile = path.join(root, `curl-args-${++n}`)
  const env = { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, HOOK_TEST_OUT: b.marker, PATH: `${bin}:${process.env.PATH}`, CURL_PID: path.join(root, `p-${n}`), CURL_ARGS: argsFile, CURL_COPY: tgz, CURL_SLEEP: '0' }
  const r = runHook(pinnedHook(VERSION, sha), env)
  assert.equal(r.code, 0)
  assert.equal(r.err, '')
  assert.ok(fs.existsSync(b.marker), 'started')
  const args = fs.readFileSync(argsFile, 'utf-8').split('\n')
  assert.ok(!args.some((a) => a.startsWith('--retry')), args.join(' '))
  const maxTime = Number(args[args.indexOf('--max-time') + 1])
  assert.ok(maxTime >= 1 && maxTime <= 40, `--max-time ${maxTime}`)
  assert.ok(args.includes('--connect-timeout'))
})

test('F-19: a hook killed with SIGTERM stops the download and removes its temp folder', { skip: !posix, timeout: 30_000 }, async () => {
  const b = box()
  const bin = fakeCurlBin()
  const pidFile = path.join(root, `curl-pid-${++n}`)
  const env = { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, HOOK_TEST_OUT: b.marker, PATH: `${bin}:${process.env.PATH}`, CURL_PID: pidFile, CURL_ARGS: path.join(root, `a-${n}`) }
  const child = spawn('sh', [pinnedHook(VERSION, 'b'.repeat(64))], { env, stdio: 'ignore' })
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
  try {
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8').trim() !== '', 10_000, 50)
    assert.equal(fs.readdirSync(b.apps).filter((f) => f.startsWith('.tmp.')).length, 1, 'temp folder exists while downloading')
    child.kill('SIGTERM')
    await exited
    await waitFor(() => !alive(readPid(pidFile)), 3_000, 100)
    assert.deepEqual(fs.readdirSync(b.apps), [], 'temp folder removed')
    assert.equal(fs.existsSync(b.marker), false)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    if (fs.existsSync(pidFile) && alive(readPid(pidFile))) process.kill(readPid(pidFile), 'SIGKILL')
  }
})

test('F-19: with too little of the budget left after the download, cloud start is not begun', { skip: !posix, timeout: 30_000 }, () => {
  const { sha, tgz } = packFake()
  const b = box()
  const bin = fakeCurlBin()
  const env = { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, HOOK_TEST_OUT: b.marker, PATH: `${bin}:${process.env.PATH}`, CURL_PID: path.join(root, `p-${++n}`), CURL_ARGS: path.join(root, `a-${n}`), CURL_COPY: tgz, CURL_SLEEP: '3', TEAM_MONITOR_HOOK_BUDGET: '9' }
  const r = runHook(pinnedHook(VERSION, sha), env)
  assert.equal(r.code, 0)
  assert.equal(r.out, '')
  assert.equal(r.err.trim().split('\n').length, 1, r.err)
  assert.match(r.err, /budget of 9s nearly used up before cloud start; not started/)
  assert.equal(fs.existsSync(b.marker), false)
  assert.deepEqual(fs.readdirSync(b.apps).filter((f) => f.startsWith('.tmp.')), [])
})

test('F-19: temp folders left by a killed run (older than 10 minutes) are removed; a fresh one is left alone', { skip: !posix }, () => {
  const { sha, tgz } = packFake()
  const b = box()
  fs.mkdirSync(b.apps, { recursive: true })
  const stale = path.join(b.apps, '.tmp.stale1')
  const fresh = path.join(b.apps, '.tmp.fresh1')
  fs.mkdirSync(stale)
  fs.writeFileSync(path.join(stale, 'part.tgz'), 'x')
  fs.mkdirSync(fresh)
  const old = new Date(Date.now() - 20 * 60_000)
  fs.utimesSync(stale, old, old)
  const r = runHook(pinnedHook(VERSION, sha), { HOME: b.home, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: b.project, TEAM_MONITOR_TARBALL: tgz, HOOK_TEST_OUT: b.marker })
  assert.equal(r.code, 0)
  assert.equal(r.err, '')
  assert.deepEqual(fs.readdirSync(b.apps).sort(), ['.tmp.fresh1', VERSION])
})

// ---- F-13: release workflow: least privilege, pinned actions, exact pnpm ------------------------------------------

test('F-13: release.yml builds with a read-only token, only the release job writes, actions pinned to SHAs, pnpm exact', () => {
  const yml = fs.readFileSync(path.join(HERE, '..', '..', '.github', 'workflows', 'release.yml'), 'utf-8')
  const lines = yml.split('\n')
  // Top-level permissions are read-only.
  assert.match(yml, /^permissions:\n {2}contents: read\n/m)
  // Split into jobs (two-space indented keys under `jobs:`).
  const jobsAt = lines.indexOf('jobs:')
  assert.ok(jobsAt > 0)
  const jobs: Record<string, string> = {}
  let cur = ''
  for (const line of lines.slice(jobsAt + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (m) { cur = m[1]; jobs[cur] = ''; continue }
    if (cur) jobs[cur] += line + '\n'
  }
  assert.deepEqual(Object.keys(jobs).sort(), ['build', 'release'])
  assert.match(jobs.build, /permissions:\n\s+contents: read\n/)
  assert.doesNotMatch(jobs.build, /write/)
  assert.match(jobs.release, /permissions:\n\s+contents: write/)
  assert.match(jobs.release, /needs: build/)
  // The release job runs no repository code: no checkout, no node/pnpm/npx/sh, only the artifact and gh release.
  assert.doesNotMatch(jobs.release, /actions\/checkout|pnpm|npx|node |sh scripts/)
  assert.match(jobs.release, /actions\/download-artifact@/)
  assert.match(jobs.release, /gh release create/)
  // Checkout does not keep the token.
  const checkouts = jobs.build.split(/\n(?=\s+- )/).filter((s) => s.includes('actions/checkout@'))
  assert.equal(checkouts.length, 1)
  assert.match(checkouts[0], /persist-credentials: false/)
  // Every action is pinned to a full commit SHA with its version in a comment.
  const uses = lines.filter((l) => /^\s*-?\s*uses:/.test(l))
  assert.ok(uses.length >= 4)
  for (const u of uses) assert.match(u, /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, u)
  // pnpm is pinned to an exact version and never floats.
  const pnpm = yml.match(/pnpm@[^\s"']+/g) ?? []
  assert.ok(pnpm.length >= 1)
  for (const p of pnpm) assert.match(p, /^pnpm@\d+\.\d+\.\d+$/, p)
  assert.doesNotMatch(yml, /npx -y pnpm@\d+\s/)
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
