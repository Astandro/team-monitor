import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { createTelemetryClient, isTelemetryEnabled, TELEMETRY_ENDPOINT, TELEMETRY_PUBLISHABLE_KEY } from './telemetry'

// Team Monitor has no telemetry: these tests prove it is off whatever the env says.

function setup() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-tel-'))
}

function makeClient(dir: string, env: NodeJS.ProcessEnv, endpoint = 'http://127.0.0.1:1') {
  return createTelemetryClient({
    env,
    logDir: path.join(dir, 'telemetry'),
    installIdPath: path.join(dir, 'installation-id'),
    endpoint,
    apiKey: 'test',
  })
}

function baseEvent() {
  return {
    event_type: 'session_start' as const,
    session_id: 's-1',
    agent_flow_version: '0.0.1',
    os: 'darwin',
    arch: 'arm64',
  }
}

const ENVS: Array<[string, NodeJS.ProcessEnv]> = [
  ['default (no env)', {}],
  ['TEAM_MONITOR_TELEMETRY=true', { TEAM_MONITOR_TELEMETRY: 'true' }],
  ['TEAM_MONITOR_TELEMETRY=1', { TEAM_MONITOR_TELEMETRY: '1' }],
  ['TEAM_MONITOR_TELEMETRY=yes', { TEAM_MONITOR_TELEMETRY: 'yes' }],
  ['AGENT_FLOW_TELEMETRY=true', { AGENT_FLOW_TELEMETRY: 'true' }],
  ['opt-in plus AGENT_FLOW_TELEMETRY=false', { TEAM_MONITOR_TELEMETRY: 'true', AGENT_FLOW_TELEMETRY: 'false' }],
  ['opt-in plus DO_NOT_TRACK=1', { TEAM_MONITOR_TELEMETRY: 'true', DO_NOT_TRACK: '1' }],
]

test('endpoint and key constants are blank', () => {
  assert.equal(TELEMETRY_ENDPOINT, '')
  assert.equal(TELEMETRY_PUBLISHABLE_KEY, '')
})

test('isTelemetryEnabled is always false', () => {
  for (const [name, env] of ENVS) {
    assert.equal(isTelemetryEnabled(env), false, name)
  }
})

for (const [name, env] of ENVS) {
  test(`writes nothing to disk and is disabled: ${name}`, async () => {
    const dir = setup()
    const client = makeClient(dir, env)
    await client.init()
    client.emit(baseEvent())
    await client.dispose()
    assert.equal(client.isEnabled(), false)
    assert.equal(fs.existsSync(path.join(dir, 'telemetry', 'events.jsonl')), false)
    assert.equal(fs.existsSync(path.join(dir, 'installation-id')), false)
  })
}

test('makes no network call even when opted in and an endpoint is reachable', async () => {
  let hits = 0
  const server = http.createServer((_req, res) => {
    hits++
    res.writeHead(200)
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as { port: number }
    const dir = setup()
    const client = makeClient(dir, { TEAM_MONITOR_TELEMETRY: 'true' }, `http://127.0.0.1:${port}`)
    await client.init()
    client.emit(baseEvent())
    await client.dispose()
    assert.equal(hits, 0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
