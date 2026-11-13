import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { APP_DEFAULT_PORT, parseArgs } from './args'

test('default port is 3002 and the team options start empty', () => {
  assert.equal(APP_DEFAULT_PORT, 3002)
  const a = parseArgs([])
  assert.equal(a.port, 3002)
  assert.equal(a.open, true)
  assert.deepEqual(a.team, { projects: [], remote: false, hostAllow: [] })
})

test('--port still works next to the team flags', () => {
  assert.equal(parseArgs(['--port', '3810']).port, 3810)
  assert.equal(parseArgs(['-p', '99999']).port, 3002, 'out of range keeps the default')
})

test('--remote takes no value; --project and --host-allow repeat; --bind and --tailscale-bin take one', () => {
  const a = parseArgs([
    '--remote', '--project', '/a', '--no-open', '--project', '/b',
    '--bind', 'loopback', '--host-allow', 'mini', '--host-allow', 'x.example', '--tailscale-bin', '/opt/ts',
  ])
  assert.equal(a.open, false, '--remote did not swallow the next flag')
  assert.deepEqual(a.team, {
    projects: ['/a', '/b'],
    remote: true,
    bind: 'loopback',
    hostAllow: ['mini', 'x.example'],
    tailscaleBin: '/opt/ts',
  })
})

test('--remote directly before another flag does not consume it', () => {
  const a = parseArgs(['--remote', '--port', '3811'])
  assert.equal(a.team.remote, true)
  assert.equal(a.port, 3811)
})

test('a team flag without a value is ignored, not crashing', () => {
  const a = parseArgs(['--project'])
  assert.deepEqual(a.team.projects, [])
})
