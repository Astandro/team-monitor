import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { LoginLimiter, loadOrCreateToken, SessionStore, TokenError, tokenMatches, SESSION_TTL_MS } from './auth'
import { listenErrorMessage, setupTeam } from './index'
import {
  assertSafeBindAddress, hostName, isAllowedRemoteHost, isTailnetIPv4, RemoteConfigError, resolveRemoteConfig, TailscaleRunner,
} from './remote'
import { makeTmpDir, removeTmpDir } from './test-helpers'

const DNS_STATUS = JSON.stringify({ Self: { DNSName: 'Mini.tail1234.ts.net.' } })

function fakeTailscale(ip: string, status = DNS_STATUS): TailscaleRunner & { calls: string[][] } {
  const calls: string[][] = []
  const run = ((args: string[]) => {
    calls.push(args)
    if (args[0] === 'ip') return `${ip}\n`
    if (args[0] === 'status') return status
    throw new Error('unexpected')
  }) as TailscaleRunner & { calls: string[][] }
  run.calls = calls
  return run
}

const quiet = () => {}
const TOKEN_A = 'ab'.repeat(32)
const TOKEN_B = 'cd'.repeat(32)

test('isTailnetIPv4 accepts only 100.64.0.0/10', () => {
  for (const ip of ['100.64.0.0', '100.101.102.103', '100.127.255.255']) assert.equal(isTailnetIPv4(ip), true, ip)
  for (const ip of ['100.63.255.255', '100.128.0.0', '10.0.0.1', '192.168.1.5', '100.64.0.256', '100.64.0', 'fd7a::1']) {
    assert.equal(isTailnetIPv4(ip), false, ip)
  }
})

test('assertSafeBindAddress refuses all-interfaces and non-tailnet addresses', () => {
  for (const a of ['0.0.0.0', '::', '[::]', '', '192.168.1.5', '10.1.2.3', '100.128.0.1', 'localhost', '::1']) {
    assert.throws(() => assertSafeBindAddress(a), RemoteConfigError, a)
  }
  assert.doesNotThrow(() => assertSafeBindAddress('127.0.0.1'))
  assert.doesNotThrow(() => assertSafeBindAddress('100.101.102.103'))
})

test('--bind tailscale binds to the address from "tailscale ip -4"', () => {
  const run = fakeTailscale('100.101.102.103')
  const cfg = resolveRemoteConfig({ bind: 'tailscale', hostAllow: [], run, warn: quiet })
  assert.equal(cfg.bindAddress, '100.101.102.103')
  assert.deepEqual(run.calls[0], ['ip', '-4'])
  assert.equal(cfg.dnsName, 'mini.tail1234.ts.net', 'trailing dot removed, lowercase')
  assert.deepEqual([...cfg.allowedHosts].sort(), ['100.101.102.103', 'mini', 'mini.tail1234.ts.net'])
  assert.equal(isAllowedRemoteHost('mini:3002', cfg), true, 'short MagicDNS name')
  assert.equal(isAllowedRemoteHost('mini.evil:3002', cfg), false)
})

test('--bind tailscale refuses what tailscale returns when it is not a tailnet IPv4', () => {
  for (const ip of ['0.0.0.0', '::', '192.168.1.20', '127.0.0.1']) {
    assert.throws(() => resolveRemoteConfig({ bind: 'tailscale', hostAllow: [], run: fakeTailscale(ip), warn: quiet }), RemoteConfigError, ip)
  }
  assert.throws(() => resolveRemoteConfig({ bind: 'tailscale', hostAllow: [], run: fakeTailscale(''), warn: quiet }), /no address/)
  const failing: TailscaleRunner = () => { throw new Error('ENOENT') }
  assert.throws(() => resolveRemoteConfig({ bind: 'tailscale', hostAllow: [], run: failing, warn: quiet }), /tailscale ip -4/)
})

test('--bind with an explicit unsafe address or no --bind is refused', () => {
  const run = fakeTailscale('100.101.102.103')
  for (const bind of ['0.0.0.0', '::', '192.168.1.5', 'all']) {
    assert.throws(() => resolveRemoteConfig({ bind, hostAllow: [], run, warn: quiet }), RemoteConfigError, bind)
  }
  assert.throws(() => resolveRemoteConfig({ bind: undefined, hostAllow: [], run, warn: quiet }), /--bind/)
})

test('--bind loopback binds 127.0.0.1 and still accepts the tailnet names', () => {
  const cfg = resolveRemoteConfig({ bind: 'loopback', hostAllow: ['Extra.Example.'], run: fakeTailscale('100.101.102.103'), warn: quiet })
  assert.equal(cfg.bindAddress, '127.0.0.1')
  assert.deepEqual([...cfg.allowedHosts].sort(), ['100.101.102.103', 'extra.example', 'mini', 'mini.tail1234.ts.net'])
  const noTs: TailscaleRunner = () => { throw new Error('not installed') }
  const cfg2 = resolveRemoteConfig({ bind: 'loopback', hostAllow: [], run: noTs, warn: quiet })
  assert.equal(cfg2.bindAddress, '127.0.0.1')
  assert.equal(cfg2.allowedHosts.size, 0)
  assert.throws(() => resolveRemoteConfig({ bind: 'loopback', hostAllow: ['bad host/'], run: noTs, warn: quiet }), RemoteConfigError)
})

test('remote Host check: loopback names, tailnet names and extras only', () => {
  const cfg = resolveRemoteConfig({ bind: 'loopback', hostAllow: ['extra.example'], run: fakeTailscale('100.101.102.103'), warn: quiet })
  for (const h of ['127.0.0.1:3001', 'localhost', '[::1]:3001', '100.101.102.103:3001', 'mini.tail1234.ts.net', 'MINI.tail1234.ts.net.', 'extra.example:8443']) {
    assert.equal(isAllowedRemoteHost(h, cfg), true, h)
  }
  for (const h of [undefined, '', 'evil.example', 'mini.tail1234.ts.net.evil.example', '100.101.102.104', 'a b', 'extra.example:x', '[::2]']) {
    assert.equal(isAllowedRemoteHost(h, cfg), false, String(h))
  }
  assert.equal(hostName('[::1]:80'), '[::1]')
})

test('token: created once with 0600 and 64 hex chars, then reused', () => {
  const home = makeTmpDir()
  try {
    const first = loadOrCreateToken(home)
    assert.equal(first.created, true)
    assert.match(first.token, /^[0-9a-f]{64}$/)
    assert.equal(fs.statSync(first.file).mode & 0o777, 0o600)
    const second = loadOrCreateToken(home)
    assert.equal(second.created, false)
    assert.equal(second.token, first.token)
  } finally {
    removeTmpDir(home)
  }
})

test('token: wider permissions are fixed to 0600; a bad token file is refused', () => {
  const home = makeTmpDir()
  try {
    const { file } = loadOrCreateToken(home)
    fs.chmodSync(file, 0o644)
    loadOrCreateToken(home)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    fs.writeFileSync(file, 'short')
    assert.throws(() => loadOrCreateToken(home), TokenError)
    fs.unlinkSync(file)
    fs.mkdirSync(file)
    assert.throws(() => loadOrCreateToken(home), TokenError)
  } finally {
    removeTmpDir(home)
  }
})

test('setupTeam never prints the token (only the file path on first creation; stdout ends up in the service log)', () => {
  const home = makeTmpDir()
  const env = { TEAM_MONITOR_HOME: path.join(home, 'tm') }
  const run = fakeTailscale('100.101.102.103')
  try {
    const logs1: string[] = []
    const s1 = setupTeam({ projects: [], remote: true, bind: 'loopback', hostAllow: [] }, { env, runTailscale: run, log: (m) => logs1.push(m), warn: quiet })
    s1.dispose()
    const token = fs.readFileSync(path.join(env.TEAM_MONITOR_HOME, 'token'), 'utf-8').trim()
    assert.ok(!logs1.some((l) => l.includes(token)), 'not printed on first run either')
    assert.ok(logs1.some((l) => l.includes(path.join(env.TEAM_MONITOR_HOME, 'token'))), 'the file path is printed on first run')
    assert.equal(fs.statSync(env.TEAM_MONITOR_HOME).mode & 0o777, 0o700, 'home is 0700')
    assert.equal(s1.listenHost, '127.0.0.1')

    const logs2: string[] = []
    const s2 = setupTeam({ projects: [], remote: true, bind: 'loopback', hostAllow: [] }, { env, runTailscale: run, log: (m) => logs2.push(m), warn: quiet })
    s2.dispose()
    assert.ok(!logs2.some((l) => l.includes(token)), 'not printed again')
  } finally {
    removeTmpDir(home)
  }
})

test('setupTeam refuses unsafe binds before creating a token', () => {
  const home = makeTmpDir()
  const env = { TEAM_MONITOR_HOME: path.join(home, 'tm') }
  try {
    assert.throws(
      () => setupTeam({ projects: [], remote: true, bind: '0.0.0.0', hostAllow: [] }, { env, runTailscale: fakeTailscale('100.101.102.103'), log: quiet, warn: quiet }),
      /never listens on all interfaces/,
    )
    assert.throws(
      () => setupTeam({ projects: [], remote: true, bind: 'tailscale', hostAllow: [] }, { env, runTailscale: fakeTailscale('0.0.0.0'), log: quiet, warn: quiet }),
      RemoteConfigError,
    )
    assert.equal(fs.existsSync(path.join(env.TEAM_MONITOR_HOME, 'token')), false)
    const local = setupTeam({ projects: [], remote: false, hostAllow: [] }, { env, log: quiet, warn: quiet })
    assert.equal(local.listenHost, '127.0.0.1')
    assert.equal(local.remote, null)
    local.dispose()
  } finally {
    removeTmpDir(home)
  }
})

test('tokenMatches compares exactly', () => {
  const t = 'ab'.repeat(32)
  assert.equal(tokenMatches(t, t), true)
  assert.equal(tokenMatches(t.slice(0, -1) + 'c', t), false)
  assert.equal(tokenMatches(t + 'a', t), false)
  assert.equal(tokenMatches('', t), false)
})

test('sessions: stored hashed, survive a restart, expire', () => {
  const home = makeTmpDir()
  let now = 1_000_000
  try {
    const s = new SessionStore(home, TOKEN_A, () => now)
    const id = s.create()
    assert.equal(s.isValid(id), true)
    assert.equal(s.isValid(id + 'x'), false)
    assert.equal(s.isValid(undefined), false)
    const file = fs.readFileSync(path.join(home, 'sessions.json'), 'utf-8')
    assert.ok(!file.includes(id), 'the session id itself is not stored')
    assert.ok(!file.includes(TOKEN_A), 'the token itself is not stored')
    assert.equal(fs.statSync(path.join(home, 'sessions.json')).mode & 0o077, 0)
    assert.equal(new SessionStore(home, TOKEN_A, () => now).isValid(id), true, 'survives a restart')
    now += SESSION_TTL_MS + 1
    assert.equal(s.isValid(id), false, 'expired')
  } finally {
    removeTmpDir(home)
  }
})

test('sessions: a new token ends every stored session', () => {
  const home = makeTmpDir()
  try {
    const s = new SessionStore(home, TOKEN_A)
    const id = s.create()
    const rotated = new SessionStore(home, TOKEN_B)
    assert.equal(rotated.isValid(id), false, 'issued under the old token')
    assert.equal(rotated.droppedForNewToken, 1)
    assert.equal(new SessionStore(home, TOKEN_A).isValid(id), false, 'dropped for good, not just hidden')
  } finally {
    removeTmpDir(home)
  }
})

test('setupTeam: deleting the token file and restarting ends phone sessions', () => {
  const home = makeTmpDir()
  const env = { TEAM_MONITOR_HOME: path.join(home, 'tm') }
  const opts = { projects: [], remote: true, bind: 'loopback', hostAllow: [] }
  const deps = { env, runTailscale: fakeTailscale('100.101.102.103'), log: quiet, warn: quiet }
  try {
    const s1 = setupTeam(opts, deps)
    const id = s1.remote!.sessions.create()
    s1.dispose()
    const s2 = setupTeam(opts, deps)
    assert.equal(s2.remote!.sessions.isValid(id), true, 'same token: still logged in')
    s2.dispose()
    fs.unlinkSync(path.join(env.TEAM_MONITOR_HOME, 'token'))
    const logs: string[] = []
    const s3 = setupTeam(opts, { ...deps, log: (m) => logs.push(m) })
    assert.equal(s3.remote!.sessions.isValid(id), false, 'new token: logged out')
    assert.ok(logs.some((l) => l.includes('1 old login session')))
    s3.dispose()
  } finally {
    removeTmpDir(home)
  }
})

test('login limiter: blocks after 5 failures per client, frees up, no global cap', () => {
  let now = 0
  const l = new LoginLimiter(5, 60_000, () => now)
  for (let i = 0; i < 4; i++) l.fail('a')
  assert.equal(l.retryAfter('a'), 0)
  l.fail('a')
  assert.ok(l.retryAfter('a') > 0)
  assert.equal(l.retryAfter('b'), 0)
  now += 60_001
  assert.equal(l.retryAfter('a'), 0, 'window passed')
  for (let i = 0; i < 100; i++) l.fail(`c${i}`)
  assert.equal(l.retryAfter('fresh'), 0, 'failures of other clients never block a new one')
})

test('login limiter: stale clients are pruned and the map is bounded', () => {
  let now = 0
  const l = new LoginLimiter(5, 60_000, () => now, 50)
  for (let i = 0; i < 40; i++) l.fail(`old${i}`)
  assert.equal(l.size, 40)
  now += 60_001
  l.fail('new')
  assert.equal(l.size, 1, 'clients whose failures left the window are dropped')
  for (let i = 0; i < 200; i++) l.fail(`burst${i}`)
  assert.ok(l.size <= 50, `bounded, got ${l.size}`)
})

test('listenErrorMessage: one plain line per cause, keeps the token location when it was just created', () => {
  const err = (code: string) => Object.assign(new Error(`listen ${code}`), { code })
  assert.match(listenErrorMessage(err('EADDRINUSE'), '127.0.0.1', 3002, null), /^Cannot start: port 3002 on 127\.0\.0\.1 is already in use/)
  assert.match(listenErrorMessage(err('EADDRNOTAVAIL'), '100.64.0.9', 3002, null), /100\.64\.0\.9 is not on this machine/)
  const withToken = listenErrorMessage(err('EADDRINUSE'), '127.0.0.1', 3002, '/x/token')
  assert.match(withToken, /kept in \/x\/token/)
  assert.doesNotMatch(listenErrorMessage(err('EADDRINUSE'), '127.0.0.1', 3002, null), /token/)
  assert.doesNotMatch(withToken, /\n\s+at /, 'no stack')
})

test('setupTeam reports tokenFile only when the token was created in this run', () => {
  const home = makeTmpDir()
  const env = { TEAM_MONITOR_HOME: path.join(home, 'tm') }
  const opts = { projects: [], remote: true, bind: 'loopback', hostAllow: [] }
  const deps = { env, runTailscale: fakeTailscale('100.101.102.103'), log: quiet, warn: quiet }
  try {
    const s1 = setupTeam(opts, deps)
    assert.equal(s1.tokenFile, path.join(env.TEAM_MONITOR_HOME, 'token'))
    s1.dispose()
    const s2 = setupTeam(opts, deps)
    assert.equal(s2.tokenFile, null)
    s2.dispose()
  } finally {
    removeTmpDir(home)
  }
})
