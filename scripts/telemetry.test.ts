import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createTelemetryClient, isTelemetryEnabled, TELEMETRY_ENDPOINT, TELEMETRY_PUBLISHABLE_KEY } from './telemetry'

function setup() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-tel-'))
}

const OPT_IN_ENV: NodeJS.ProcessEnv = { TEAM_MONITOR_TELEMETRY: 'true' }

function makeClient(dir: string, env?: NodeJS.ProcessEnv) {
  return createTelemetryClient({
    env,
    logDir: path.join(dir, 'telemetry'),
    installIdPath: path.join(dir, 'installation-id'),
    // Unroutable so tests never hit the real endpoint.
    endpoint: 'http://127.0.0.1:1',
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

test('hardcoded constants are present', () => {
  assert.match(TELEMETRY_ENDPOINT, /^https:\/\/.+\.supabase\.co$/)
  assert.match(TELEMETRY_PUBLISHABLE_KEY, /^sb_publishable_/)
})

test('isTelemetryEnabled: default (no env) is disabled', () => {
  assert.equal(isTelemetryEnabled({}), false)
})

test('isTelemetryEnabled: unrelated or non-truthy values stay disabled', () => {
  assert.equal(isTelemetryEnabled({ TEAM_MONITOR_TELEMETRY: '' }), false)
  assert.equal(isTelemetryEnabled({ TEAM_MONITOR_TELEMETRY: 'false' }), false)
  assert.equal(isTelemetryEnabled({ TEAM_MONITOR_TELEMETRY: 'maybe' }), false)
  // The old upstream flag alone is not an opt-in.
  assert.equal(isTelemetryEnabled({ AGENT_FLOW_TELEMETRY: 'true' }), false)
})

test('isTelemetryEnabled: TEAM_MONITOR_TELEMETRY=true opts in', () => {
  assert.equal(isTelemetryEnabled({ TEAM_MONITOR_TELEMETRY: 'true' }), true)
  assert.equal(isTelemetryEnabled({ TEAM_MONITOR_TELEMETRY: '1' }), true)
  assert.equal(isTelemetryEnabled({ TEAM_MONITOR_TELEMETRY: 'TRUE' }), true)
})

test('isTelemetryEnabled: legacy AGENT_FLOW_TELEMETRY=false disables even after opt-in', () => {
  assert.equal(isTelemetryEnabled({ TEAM_MONITOR_TELEMETRY: 'true', AGENT_FLOW_TELEMETRY: 'false' }), false)
  assert.equal(isTelemetryEnabled({ TEAM_MONITOR_TELEMETRY: 'true', AGENT_FLOW_TELEMETRY: '0' }), false)
  assert.equal(isTelemetryEnabled({ TEAM_MONITOR_TELEMETRY: 'true', AGENT_FLOW_TELEMETRY: 'disabled' }), false)
})

test('default env writes nothing to disk', async () => {
  const dir = setup()
  const client = makeClient(dir, {})
  await client.init()
  client.emit(baseEvent())
  await client.dispose()
  assert.equal(client.isEnabled(), false)
  assert.equal(fs.existsSync(path.join(dir, 'telemetry', 'events.jsonl')), false)
  assert.equal(fs.existsSync(path.join(dir, 'installation-id')), false)
})

test('isTelemetryEnabled: DO_NOT_TRACK=1 disables', () => {
  assert.equal(isTelemetryEnabled({ DO_NOT_TRACK: '1' }), false)
  assert.equal(isTelemetryEnabled({ DO_NOT_TRACK: 'true' }), false)
})

test('isTelemetryEnabled: DO_NOT_TRACK wins even when opted in', () => {
  assert.equal(isTelemetryEnabled({ TEAM_MONITOR_TELEMETRY: 'true', DO_NOT_TRACK: '1' }), false)
})

test('emit appends to JSONL when explicitly opted in', async () => {
  const dir = setup()
  const client = makeClient(dir, OPT_IN_ENV)
  await client.init()
  client.emit(baseEvent())
  await client.dispose()
  const jsonl = path.join(dir, 'telemetry', 'events.jsonl')
  const lines = fs.readFileSync(jsonl, 'utf-8').trim().split('\n')
  assert.equal(lines.length, 1)
  const e = JSON.parse(lines[0])
  assert.equal(e.v, 1)
  assert.equal(e.event_type, 'session_start')
  assert.match(e.installation_id, /^[0-9a-f-]{36}$/)
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/)
})

test('opted in but AGENT_FLOW_TELEMETRY=false writes nothing to disk', async () => {
  const dir = setup()
  const client = makeClient(dir, { ...OPT_IN_ENV, AGENT_FLOW_TELEMETRY: 'false' })
  await client.init()
  client.emit(baseEvent())
  await client.dispose()
  // No events log AND no install-id file — disabled means zero disk footprint.
  assert.equal(fs.existsSync(path.join(dir, 'telemetry', 'events.jsonl')), false)
  assert.equal(fs.existsSync(path.join(dir, 'installation-id')), false)
})

test('opted in but DO_NOT_TRACK=1 writes nothing to disk', async () => {
  const dir = setup()
  const client = makeClient(dir, { ...OPT_IN_ENV, DO_NOT_TRACK: '1' })
  await client.init()
  client.emit(baseEvent())
  await client.dispose()
  assert.equal(fs.existsSync(path.join(dir, 'telemetry', 'events.jsonl')), false)
  assert.equal(fs.existsSync(path.join(dir, 'installation-id')), false)
})

test('install-id persists across init calls', async () => {
  const dir = setup()
  const client1 = makeClient(dir, OPT_IN_ENV)
  await client1.init()
  client1.emit(baseEvent())
  await client1.dispose()
  const idPath = path.join(dir, 'installation-id')
  const id1 = fs.readFileSync(idPath, 'utf-8').trim()

  const client2 = makeClient(dir, OPT_IN_ENV)
  await client2.init()
  client2.emit(baseEvent())
  await client2.dispose()
  const lines = fs.readFileSync(path.join(dir, 'telemetry', 'events.jsonl'), 'utf-8').trim().split('\n')
  for (const line of lines) {
    assert.equal(JSON.parse(line).installation_id, id1)
  }
})

test('emit sanitizes session_id', async () => {
  const dir = setup()
  const client = makeClient(dir, OPT_IN_ENV)
  await client.init()
  client.emit({ ...baseEvent(), session_id: 'quote"backslash\\newline\n' })
  await client.dispose()
  const jsonl = path.join(dir, 'telemetry', 'events.jsonl')
  const e = JSON.parse(fs.readFileSync(jsonl, 'utf-8').trim())
  assert.equal(e.session_id, 'quotebackslashnewline')
})
