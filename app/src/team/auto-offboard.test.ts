/**
 * Auto offboarding after `autoOffboardMinutes` (spec ui-cleanup item 6), on a fake clock: no real waiting.
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { AutoOffboarder, MAX_SWEEP_GAP_MS, autoOffboardDue, type AutoOffboardClock } from './auto-offboard'
import { OFFBOARD_FILE, OffboardStore, offboardAgent } from './offboard'
import {
  AUTO_OFFBOARD_DEFAULT_MINUTES, buildRegistry, readAutoOffboardMinutes, readConfigProjects,
} from './config'
import { GraphAgents, type AutoOffboardGraph } from '../../../scripts/graph-agents'
import type { AgentEvent } from '../../../extension/src/protocol'
import { makeTmpDir, removeTmpDir } from './test-helpers'
import { setupTeam } from './index'

const S = '7e23e8af-0000-4000-8000-0000000000bb'
const S2 = '7e23e8af-0000-4000-8000-0000000000cc'
const HIRO = 'Hiro (Frontend Engineer): panel'
const REN = 'Ren (Backend Engineer): store'
const MEI = 'Mei (QA Engineer): review'
const MIN = 60_000
const T0 = Date.parse('2026-11-13T03:00:00.000Z')

/** A clock whose timers run only when the test moves time forward. */
class FakeClock implements AutoOffboardClock {
  t = T0
  private seq = 0
  timers = new Map<number, { at: number; fn: () => void; delay: number }>()
  now = () => this.t
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn, delay: ms }); return id }
  clearTimeout = (h: unknown) => { this.timers.delete(h as number) }
  /** Delays of the timers waiting now. */
  pending(): number[] { return [...this.timers.values()].map((x) => x.delay) }
  /** When the waiting timers fire. */
  dueTimes(): number[] { return [...this.timers.values()].map((x) => x.at) }
  /** Move to `to`, running every timer due on the way, in order. */
  advanceTo(to: number): void {
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | null = null
      for (const e of this.timers) if (e[1].at <= to && (!first || e[1].at < first[1].at)) first = e
      if (!first) break
      this.timers.delete(first[0])
      this.t = Math.max(this.t, first[1].at)
      first[1].fn()
    }
    this.t = to
  }
}

/** The relay's graph over a registry: sessions, announcements, and change notices like broadcastEvent sends. */
function fakeGraph(g: GraphAgents) {
  const announced: Array<{ session: string; agents: string[] }> = []
  const listeners = new Set<() => void>()
  const view: AutoOffboardGraph = {
    agents: (sid) => g.agents(sid),
    sessionProject: (sid) => (sid === S ? 'proj' : null),
    announceOffboarded: (session, agents) => { announced.push({ session, agents }) },
    sessions: () => [S, S2],
    onAgentsChanged: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
  const emit = (type: AgentEvent['type'], payload: Record<string, unknown>, at: number, sid = S) => {
    g.observe({ time: 0, type, payload, sessionId: sid }, at)
    for (const fn of [...listeners]) fn()
  }
  return { view, announced, emit, listeners }
}

function team(clock: FakeClock) {
  const g = new GraphAgents()
  const fg = fakeGraph(g)
  fg.emit('agent_spawn', { name: 'orchestrator', isMain: true, task: 'Proyek' }, T0 - 10 * MIN)
  fg.emit('agent_spawn', { name: HIRO, parent: 'orchestrator', task: 'panel', displayName: 'Hiro', role: 'Frontend Engineer' }, T0 - 9 * MIN)
  fg.emit('agent_spawn', { name: REN, parent: 'orchestrator', task: 'store', displayName: 'Ren', role: 'Backend Engineer' }, T0 - 8 * MIN)
  fg.emit('agent_spawn', { name: MEI, parent: 'orchestrator', task: 'review', displayName: 'Mei', role: 'QA Engineer' }, T0 - 7 * MIN)
  fg.emit('agent_complete', { name: HIRO }, T0)
  fg.emit('agent_complete', { name: REN }, T0 + 10 * MIN)
  clock.t = T0 + 10 * MIN
  return { g, ...fg }
}

let home: string
let logs: string[]
beforeEach(() => { home = makeTmpDir(); logs = [] })
afterEach(() => {
  try { fs.chmodSync(home, 0o700) } catch { /* fine */ }
  removeTmpDir(home)
})

describe('AutoOffboarder', () => {
  test('offboards a finished agent at its deadline, not a millisecond before, with reason "auto"', () => {
    const clock = new FakeClock()
    const { view, announced } = team(clock)
    const store = new OffboardStore(home)
    const auto = new AutoOffboarder(store, view, 60, { clock, log: (m) => logs.push(m) })
    try {
      assert.deepEqual(auto.start(), [], 'nothing due at start')
      clock.advanceTo(T0 + 60 * MIN - 1)
      assert.deepEqual(auto.sweep(), [], 'a sweep 1 ms before the deadline takes nobody')
      assert.equal(store.isOffboarded(S, HIRO), false, 'not before the deadline')
      clock.advanceTo(T0 + 60 * MIN)
      assert.deepEqual(store.get(S, HIRO), {
        session: S, agent: HIRO, project: 'proj', name: 'Hiro', role: 'Frontend Engineer', task: 'panel',
        finishedAt: '2026-11-13T03:00:00.000Z', offboardedAt: '2026-11-13T04:00:00.000Z', reason: 'auto',
      })
      assert.deepEqual(announced, [{ session: S, agents: [HIRO] }], 'open streams are told')
      assert.equal(store.isOffboarded(S, REN), false, 'Ren finished later')
      assert.equal(store.isOffboarded(S, MEI), false, 'Mei is running')
      clock.advanceTo(T0 + 70 * MIN)
      assert.equal(store.get(S, REN)?.reason, 'auto')
      clock.advanceTo(T0 + 1000 * MIN)
      assert.equal(store.isOffboarded(S, MEI), false, 'a running agent is never auto offboarded')
      assert.equal(store.isOffboarded(S, 'orchestrator'), false, 'nor the Orchestrator')
      // Saved: a new store from disk (a restart) knows the reason.
      assert.equal(new OffboardStore(home).get(S, HIRO)?.reason, 'auto')
    } finally { auto.stop() }
  })

  test('sleeps until the next deadline, at most a minute at a time', () => {
    const clock = new FakeClock()
    const { view } = team(clock)
    const auto = new AutoOffboarder(new OffboardStore(home), view, 60, { clock })
    try {
      auto.start()
      assert.deepEqual(clock.pending(), [MAX_SWEEP_GAP_MS])
      clock.advanceTo(T0 + 60 * MIN - 30_000)
      assert.deepEqual(clock.dueTimes(), [T0 + 60 * MIN], 'the last wait ends exactly at the deadline')
      clock.advanceTo(T0 + 60 * MIN)
      assert.deepEqual(clock.dueTimes(), [T0 + 60 * MIN + MAX_SWEEP_GAP_MS], 'then Ren, a minute at a time')
    } finally { auto.stop() }
    assert.deepEqual(clock.pending(), [], 'stop clears the timer')
  })

  test('an agent that runs again before its deadline is kept, and its clock starts again when it finishes', () => {
    const clock = new FakeClock()
    const { view, emit } = team(clock)
    const store = new OffboardStore(home)
    const auto = new AutoOffboarder(store, view, 60, { clock })
    try {
      auto.start()
      clock.advanceTo(T0 + 30 * MIN)
      emit('agent_spawn', { name: HIRO, parent: 'orchestrator', task: 'panel', displayName: 'Hiro', role: 'Frontend Engineer' }, clock.t)
      clock.advanceTo(T0 + 61 * MIN)
      assert.equal(store.isOffboarded(S, HIRO), false, 'running at the old deadline')
      emit('agent_complete', { name: HIRO }, T0 + 61 * MIN)
      clock.advanceTo(T0 + 121 * MIN - 1)
      assert.equal(store.isOffboarded(S, HIRO), false, 'the clock restarted at the new finish')
      clock.advanceTo(T0 + 121 * MIN)
      assert.equal(store.get(S, HIRO)?.finishedAt, new Date(T0 + 61 * MIN).toISOString())
      assert.equal(store.get(S, HIRO)?.reason, 'auto')
    } finally { auto.stop() }
  })

  test('catch-up at start: agents whose deadline passed while the server was down go at once', () => {
    const clock = new FakeClock()
    const { view, announced } = team(clock)
    clock.t = T0 + 65 * MIN // server comes back: Hiro is 65 minutes done, Ren 55
    const store = new OffboardStore(home)
    const auto = new AutoOffboarder(store, view, 60, { clock })
    try {
      const caught = auto.start()
      assert.deepEqual(caught.map((r) => [r.agent, r.reason, r.offboardedAt]), [[HIRO, 'auto', new Date(T0 + 65 * MIN).toISOString()]])
      assert.deepEqual(announced, [{ session: S, agents: [HIRO] }])
      assert.equal(store.isOffboarded(S, REN), false)
      assert.deepEqual(clock.pending(), [MAX_SWEEP_GAP_MS], 'Ren is next, a minute at a time')
      clock.advanceTo(T0 + 70 * MIN - 1)
      assert.equal(store.isOffboarded(S, REN), false)
      clock.advanceTo(T0 + 70 * MIN)
      assert.equal(store.isOffboarded(S, REN), true)
    } finally { auto.stop() }
  })

  test('a manual offboard first wins: the record stays "manual" and nothing is announced twice', () => {
    const clock = new FakeClock()
    const { view, announced } = team(clock)
    const store = new OffboardStore(home)
    offboardAgent(store, view, { session: S, agent: HIRO }, () => new Date(clock.t))
    const auto = new AutoOffboarder(store, view, 60, { clock })
    try {
      auto.start()
      clock.advanceTo(T0 + 200 * MIN)
      assert.equal(store.get(S, HIRO)?.reason, 'manual')
      assert.deepEqual(announced.map((a) => a.agents), [[HIRO], [REN]])
    } finally { auto.stop() }
  })

  test('the configured interval is used', () => {
    const clock = new FakeClock()
    const { view } = team(clock)
    clock.t = T0
    const store = new OffboardStore(home)
    const auto = new AutoOffboarder(store, view, 1, { clock })
    try {
      auto.start()
      clock.advanceTo(T0 + MIN - 1)
      assert.equal(store.isOffboarded(S, HIRO), false)
      clock.advanceTo(T0 + MIN)
      assert.equal(store.isOffboarded(S, HIRO), true, 'one minute after it finished')
    } finally { auto.stop() }
  })

  test('a sub-agent change wakes it at once (a session attached with old finished agents)', () => {
    const clock = new FakeClock()
    const { view, emit } = team(clock)
    const store = new OffboardStore(home)
    const auto = new AutoOffboarder(store, view, 60, { clock })
    try {
      auto.start()
      emit('agent_spawn', { name: 'Old (QA Engineer): x', parent: 'orchestrator', task: 'x' }, T0 - 300 * MIN, S2)
      emit('agent_complete', { name: 'Old (QA Engineer): x' }, T0 - 200 * MIN, S2)
      assert.deepEqual(clock.pending(), [0])
      clock.advanceTo(clock.t)
      assert.equal(store.get(S2, 'Old (QA Engineer): x')?.project, null)
      assert.equal(store.isOffboarded(S2, 'Old (QA Engineer): x'), true)
    } finally { auto.stop() }
  })

  test('stop unsubscribes from the graph', () => {
    const clock = new FakeClock()
    const { view, listeners } = team(clock)
    const auto = new AutoOffboarder(new OffboardStore(home), view, 60, { clock })
    auto.start()
    assert.equal(listeners.size, 1)
    auto.stop()
    assert.equal(listeners.size, 0)
  })

  test('a failed save is logged and retried; nothing is announced until it is saved', () => {
    const clock = new FakeClock()
    const { view, announced } = team(clock)
    clock.t = T0 + 65 * MIN
    const store = new OffboardStore(home)
    fs.chmodSync(home, 0o500)
    const auto = new AutoOffboarder(store, view, 60, { clock, log: (m) => logs.push(m) })
    try {
      assert.deepEqual(auto.start(), [])
      assert.equal(store.isOffboarded(S, HIRO), false)
      assert.deepEqual(announced, [])
      assert.equal(logs.length, 1)
      assert.match(logs[0], /auto offboard could not save 1 agent/)
      fs.chmodSync(home, 0o700)
      clock.advanceTo(clock.t + MAX_SWEEP_GAP_MS)
      assert.equal(store.get(S, HIRO)?.reason, 'auto')
      assert.deepEqual(announced, [{ session: S, agents: [HIRO] }])
    } finally { auto.stop() }
  })

  test('autoOffboardDue: only finished sub-agents with a finish time', () => {
    const base = { name: 'x', isMain: false, status: 'finished' as const, spawnedAt: 0, finishedAt: 1000 }
    assert.equal(autoOffboardDue(base, 60 * MIN), 1000 + 60 * MIN)
    assert.equal(autoOffboardDue({ ...base, status: 'running' }, MIN), null)
    assert.equal(autoOffboardDue({ ...base, isMain: true }, MIN), null)
    assert.equal(autoOffboardDue({ ...base, finishedAt: undefined }, MIN), null)
  })
})

describe('store reason', () => {
  test('records saved before the field existed read as "manual"; a bad reason is skipped', () => {
    fs.writeFileSync(path.join(home, OFFBOARD_FILE), JSON.stringify({
      version: 1,
      sessions: {
        [S]: {
          [HIRO]: { project: 'proj', name: 'Hiro', role: null, task: null, finishedAt: null, offboardedAt: '2026-11-13T02:00:00.000Z' },
          [REN]: { project: 'proj', name: 'Ren', role: null, task: null, finishedAt: null, offboardedAt: '2026-11-13T02:00:00.000Z', reason: 'auto' },
          [MEI]: { project: 'proj', name: 'Mei', role: null, task: null, finishedAt: null, offboardedAt: '2026-11-13T02:00:00.000Z', reason: 'bored' },
        },
      },
    }))
    const store = new OffboardStore(home, (m) => logs.push(m))
    assert.equal(store.get(S, HIRO)?.reason, 'manual')
    assert.equal(store.get(S, REN)?.reason, 'auto')
    assert.equal(store.isOffboarded(S, MEI), false)
    assert.equal(logs.length, 1, 'one malformed entry reported')
  })
})

describe('autoOffboardMinutes in config.json', () => {
  const write = (v: unknown) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(v))

  test('default 60 without a file or without the key; a valid value is used', () => {
    assert.equal(readAutoOffboardMinutes(home, (m) => logs.push(m)), 60)
    assert.equal(AUTO_OFFBOARD_DEFAULT_MINUTES, 60)
    write({ projects: [] })
    assert.equal(readAutoOffboardMinutes(home, (m) => logs.push(m)), 60)
    write({ projects: [], autoOffboardMinutes: 1 })
    assert.equal(readAutoOffboardMinutes(home, (m) => logs.push(m)), 1)
    write({ autoOffboardMinutes: 10080 })
    assert.equal(readAutoOffboardMinutes(home, (m) => logs.push(m)), 10080)
    assert.deepEqual(logs, [])
  })

  test('invalid values are reported and the default is used', () => {
    for (const bad of [0, -5, 1.5, 10081, '30', null, true, [60]]) {
      write({ autoOffboardMinutes: bad })
      const before = logs.length
      assert.equal(readAutoOffboardMinutes(home, (m) => logs.push(m)), 60, `value ${JSON.stringify(bad)}`)
      assert.equal(logs.length, before + 1, `value ${JSON.stringify(bad)} reported`)
    }
  })

  test('a config with only the setting has no projects and no warning', () => {
    write({ autoOffboardMinutes: 5 })
    assert.deepEqual(buildRegistry(readConfigProjects(home, (m) => logs.push(m)), []), [])
    assert.deepEqual(logs, [])
  })

  test('setupTeam reads it into the team service', () => {
    const tmHome = path.join(home, 'tm-home')
    fs.mkdirSync(tmHome)
    fs.writeFileSync(path.join(tmHome, 'config.json'), JSON.stringify({ autoOffboardMinutes: 7 }))
    const setup = setupTeam({ projects: [], remote: false, hostAllow: [] }, { env: { TEAM_MONITOR_HOME: tmHome }, log: () => {}, warn: () => {} })
    try {
      assert.equal(setup.team.autoOffboardMinutes, 7)
    } finally { setup.dispose() }
  })
})

describe('finishedAt on the completion event', () => {
  const ev = (type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent => ({ time: 0, type, payload, sessionId: S })

  test('a sub-agent completion carries finishedAt and autoOffboardAt; others are unchanged', () => {
    const g = new GraphAgents()
    g.observe(ev('agent_spawn', { name: 'orchestrator', isMain: true }))
    g.observe(ev('agent_spawn', { name: HIRO, parent: 'orchestrator' }))
    const done = ev('agent_complete', { name: HIRO })
    assert.deepEqual(g.annotateCompletion(done, T0, 60 * MIN).payload, {
      name: HIRO, finished: true, finishedAt: '2026-11-13T03:00:00.000Z', autoOffboardAt: '2026-11-13T04:00:00.000Z',
    })
    assert.deepEqual(done.payload, { name: HIRO }, 'the original event is not changed')
    assert.deepEqual(g.annotateCompletion(done, T0).payload, { name: HIRO, finished: true, finishedAt: '2026-11-13T03:00:00.000Z' }, 'no interval: no deadline')
    const main = ev('agent_complete', { name: 'orchestrator' })
    assert.equal(g.annotateCompletion(main, T0, MIN), main)
    const unknown = ev('agent_complete', { name: 'Nobody' })
    assert.equal(g.annotateCompletion(unknown, T0, MIN), unknown)
    const spawn = ev('agent_spawn', { name: HIRO })
    assert.equal(g.annotateCompletion(spawn, T0, MIN), spawn)
  })

  test('runningSubagents lists the running sub-agents a session end finishes, never the Orchestrator', () => {
    const g = new GraphAgents()
    g.observe(ev('agent_spawn', { name: 'orchestrator', isMain: true }))
    g.observe(ev('agent_spawn', { name: HIRO, parent: 'orchestrator' }))
    g.observe(ev('agent_spawn', { name: REN, parent: 'orchestrator' }))
    g.observe(ev('agent_complete', { name: HIRO }))
    assert.deepEqual(g.runningSubagents(S), [REN])
    assert.deepEqual(g.runningSubagents('other'), [])
    g.observe(ev('agent_complete', { name: REN, sessionEnded: true }))
    assert.deepEqual(g.runningSubagents(S), [])
    assert.equal(g.agent(S, REN)?.status, 'finished')
  })
})
