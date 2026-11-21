// Routing of the bridge's window messages (spec 0.9.8 item 6): a `session-removed` from the relay reaches the session
// listeners as ('removed', sessionId); a malformed one reaches nobody. node:test runs each file in its own process,
// so the window stub below does not leak into other tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'

type Handler = (e: { data: unknown }) => void
let handler: Handler | null = null
;(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (type: string, fn: Handler) => { if (type === 'message') handler = fn },
  removeEventListener: () => {},
}

async function bridge() {
  const mod = await import('./vscode-bridge')
  assert.ok(mod.vscodeBridge, 'bridge created when window exists')
  assert.ok(handler, 'bridge listens to window messages')
  return mod.vscodeBridge!
}

test('session-removed is routed to the session listeners as removed + id', async () => {
  const b = await bridge()
  const calls: [string, unknown][] = []
  const off = b.onSession((type, data) => calls.push([type, data]))
  handler!({ data: { type: 'session-removed', sessionId: 'cloud-s1' } })
  assert.deepEqual(calls, [['removed', 'cloud-s1']])
  off()
})

test('a malformed session-removed reaches no listener', async () => {
  const b = await bridge()
  const calls: [string, unknown][] = []
  const off = b.onSession((type, data) => calls.push([type, data]))
  handler!({ data: { type: 'session-removed' } })
  handler!({ data: { type: 'session-removed', sessionId: '' } })
  handler!({ data: { type: 'session-removed', sessionId: 42 } })
  assert.deepEqual(calls, [])
  off()
})

test('session-ended still arrives as ended (unchanged), before a removed for the same id', async () => {
  const b = await bridge()
  const calls: [string, unknown][] = []
  const off = b.onSession((type, data) => calls.push([type, data]))
  handler!({ data: { type: 'session-ended', sessionId: 'cloud-s1' } })
  handler!({ data: { type: 'session-removed', sessionId: 'cloud-s1' } })
  assert.deepEqual(calls.map(([t]) => t), ['ended', 'removed'])
  off()
})
