import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  canOffboard,
  dropOffboardedEvents,
  finishedSubAgents,
  mapOffboardError,
  NOTHING_TO_OFFBOARD,
  offboardAgent,
  offboardAllFinished,
  offboardRows,
  parseOffboardedMessage,
} from './offboard'
import type { PostFetch } from './post'

test('only a finished sub-agent can be offboarded', () => {
  assert.equal(canOffboard({ isMain: false, state: 'complete' }), true)
  assert.equal(canOffboard({ isMain: true, state: 'complete' }), false)
  assert.equal(canOffboard({ isMain: false, state: 'thinking' }), false)
  assert.equal(canOffboard({ isMain: false, state: 'tool_calling' }), false)
  assert.equal(canOffboard(null), false)
})

test('finishedSubAgents lists finished sub-agents only', () => {
  const agents = new Map([
    ['orchestrator', { isMain: true, state: 'complete' }],
    ['Hiro (Frontend Engineer): a', { isMain: false, state: 'complete' }],
    ['Ren: b', { isMain: false, state: 'thinking' }],
    ['Aoi: c', { isMain: false, state: 'complete' }],
  ])
  assert.deepEqual(finishedSubAgents(agents), ['Hiro (Frontend Engineer): a', 'Aoi: c'])
})

test('dropOffboardedEvents removes events of those agents by name, agent or child', () => {
  const ev = [
    { type: 'agent_spawn', payload: { name: 'orchestrator' } },
    { type: 'agent_spawn', payload: { name: 'Hiro', parent: 'orchestrator' } },
    { type: 'subagent_dispatch', payload: { parent: 'orchestrator', child: 'Hiro' } },
    { type: 'tool_call_start', payload: { agent: 'Hiro' } },
    { type: 'tool_call_start', payload: { agent: 'orchestrator' } },
    { type: 'agent_complete', payload: { name: 'Hiro' } },
  ]
  const kept = dropOffboardedEvents(ev, ['Hiro'])
  assert.deepEqual(kept.map((e) => e.payload.name ?? e.payload.agent), ['orchestrator', 'orchestrator'])
  // nothing to drop: the same array comes back
  assert.equal(dropOffboardedEvents(ev, ['Nobody']), ev)
  assert.equal(dropOffboardedEvents(ev, []), ev)
})

test('parseOffboardedMessage reads the stream message and nothing else', () => {
  assert.deepEqual(parseOffboardedMessage({ type: 'agents-offboarded', sessionId: 's1', agents: ['A', 3, ''] }), {
    sessionId: 's1',
    agents: ['A'],
  })
  assert.equal(parseOffboardedMessage({ type: 'session-updated', sessionId: 's1' }), null)
  assert.equal(parseOffboardedMessage({ type: 'agents-offboarded', agents: [] }), null)
})

test('errors in plain text: 409 still running, 400 Orchestrator, 401 login', () => {
  assert.match(mapOffboardError(409, 'agent is still running').message, /masih jalan/)
  assert.equal(mapOffboardError(400, 'cannot offboard the orchestrator').message, 'Orchestrator nggak bisa di-offboard.')
  assert.match(mapOffboardError(400, 'agent missing').message, /agent missing/)
  assert.equal(mapOffboardError(401, '').kind, 'login')
})

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: Parameters<PostFetch>[1] }[] = []
  const fn: PostFetch = async (url, init) => {
    calls.push({ url, init })
    return { status, json: async () => body }
  }
  return { fn, calls }
}

test('offboardAgent and offboardAllFinished post to their endpoints with the answer headers', async () => {
  const one = fakeFetch(200, { ok: true, offboarded: [{ agent: 'Hiro' }], alreadyOffboarded: false })
  assert.deepEqual(await offboardAgent(one.fn, 's1', 'Hiro'), { ok: true, agents: ['Hiro'] })
  assert.equal(one.calls[0].url, '/api/team/offboard')
  assert.deepEqual(JSON.parse(one.calls[0].init.body), { session: 's1', agent: 'Hiro' })
  assert.equal(one.calls[0].init.headers['X-Team-Monitor'], '1')

  const all = fakeFetch(200, { ok: true, offboarded: [{ agent: 'A' }, { agent: 'B' }] })
  assert.deepEqual(await offboardAllFinished(all.fn, 's1'), { ok: true, agents: ['A', 'B'] })
  assert.equal(all.calls[0].url, '/api/team/offboard-all')
  assert.deepEqual(JSON.parse(all.calls[0].init.body), { session: 's1' })

  const none = await offboardAllFinished(fakeFetch(200, { ok: true, offboarded: [] }).fn, 's1')
  assert.deepEqual(none, { ok: false, kind: 'error', status: 200, message: NOTHING_TO_OFFBOARD })

  const busy = await offboardAgent(fakeFetch(409, { ok: false, error: 'agent is still running' }).fn, 's1', 'Ren')
  assert.equal(busy.ok, false)
  if (!busy.ok) assert.match(busy.message, /masih jalan/)
})

test('offboardRows: name, role, task and when; falls back to the node name', () => {
  const now = new Date(2026, 10, 13, 18, 0).getTime()
  const rows = offboardRows(
    [
      {
        session: 's',
        agent: 'Hiro (Frontend Engineer): tombol',
        name: 'Hiro',
        role: 'Frontend Engineer',
        task: 'tombol',
        finishedAt: new Date(2026, 10, 13, 14, 5).toISOString(),
        offboardedAt: new Date(2026, 10, 13, 14, 20).toISOString(),
      },
      { session: 's', agent: 'Kaito: server', role: null, task: null, finishedAt: null, offboardedAt: 'bad' },
    ],
    now,
  )
  assert.deepEqual(rows[0], {
    key: 's:Hiro (Frontend Engineer): tombol',
    name: 'Hiro',
    role: 'Frontend Engineer',
    task: 'tombol',
    when: 'Selesai 14.05 · Offboard 14.20',
  })
  assert.equal(rows[1].name, 'Kaito: server')
  assert.equal(rows[1].role, '')
  assert.equal(rows[1].when, '')
})
