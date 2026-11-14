/**
 * Cloud mode pieces that run in-process: the Host check in cloud mode (acceptance criterion 8), the refused flag
 * combinations, `--cloud` parsing, and the sourceId.
 */
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import { parseArgs } from '../args'
import { resolveSourceId, sourceIdFromSession, SOURCE_ID_FILE } from './cloud'
import { cloudDir } from './cloud-forwarder'
import { acceptsAnyHost, CloudModeError, setupTeam, TeamCliOptions } from './index'
import { listen, makeTmpDir, removeTmpDir, request } from './test-helpers'

const root = makeTmpDir()
after(() => removeTmpDir(root))
let n = 0

async function hostCheck(opts: Partial<TeamCliOptions>, env: NodeJS.ProcessEnv): Promise<{ foreign: number; loopback: number }> {
  const home = path.join(root, `h${++n}`)
  const setup = setupTeam({ projects: [], remote: false, hostAllow: [], ...opts }, { env: { ...env, TEAM_MONITOR_HOME: home }, log: () => {}, warn: () => {} })
  const srv = await listen(setup.createHandler((_req, res) => { res.writeHead(200); res.end('ui') }))
  try {
    const foreign = await request(srv.port, { path: '/', headers: { Host: 'preview-1234.cloud.example' } })
    const loopback = await request(srv.port, { path: '/api/team/projects' })
    return { foreign: foreign.status, loopback: loopback.status }
  } finally {
    setup.dispose()
    await srv.close()
  }
}

test('criterion 8: in cloud mode a foreign Host gets 200; outside cloud mode it still gets 403', async () => {
  assert.deepEqual(await hostCheck({ cloud: true }, { CLAUDE_CODE_REMOTE: 'true' }), { foreign: 200, loopback: 200 })
  // not started by cloud mode, or not in a cloud session: unchanged
  assert.deepEqual(await hostCheck({}, { CLAUDE_CODE_REMOTE: 'true' }), { foreign: 403, loopback: 200 })
  assert.deepEqual(await hostCheck({ cloud: true }, {}), { foreign: 403, loopback: 200 })
  assert.deepEqual(await hostCheck({ cloud: true }, { CLAUDE_CODE_REMOTE: '1' }), { foreign: 403, loopback: 200 })
})

test('cloud mode: a foreign Host is for safe reads only; every state-changing request needs a loopback Host', async () => {
  const home = path.join(root, `h${++n}`)
  const project = path.join(root, 'cloudproj')
  fs.mkdirSync(path.join(project, '.agent-team'), { recursive: true })
  const setup = setupTeam({ projects: [project], remote: false, hostAllow: [], cloud: true }, {
    env: { CLAUDE_CODE_REMOTE: 'true', TEAM_MONITOR_HOME: home }, log: () => {}, warn: () => {},
  })
  const srv = await listen(setup.createHandler((_req, res) => { res.writeHead(200); res.end('ui') }))
  try {
    const evil = 'evil.example'
    // Reads with the preview's (any) Host: UI, /events-like fallback, read-only API, HEAD.
    assert.equal((await request(srv.port, { path: '/', headers: { Host: evil } })).status, 200)
    assert.equal((await request(srv.port, { method: 'HEAD', path: '/', headers: { Host: evil } })).status, 200)
    assert.equal((await request(srv.port, { path: '/api/team/projects', headers: { Host: evil } })).status, 200)
    // Writes with a foreign Host, even with matching Origin and X-Team-Monitor (the QA repro): 403, nothing written.
    const write = (p: string, body: unknown, host: string) => request(srv.port, {
      method: 'POST', path: p, body: JSON.stringify(body),
      headers: { Host: host, Origin: `http://${host}`, 'X-Team-Monitor': '1', 'Content-Type': 'application/json' },
    })
    const id = path.basename(project)
    for (const [p, body] of [
      ['/api/team/message', { project: id, text: 'dari halaman asing' }], ['/api/team/answer', { project: id, id: 'D1', answer: 'b' }],
      ['/api/team/offboard', { session: '5a6b7c8d-0000-4000-8000-000000000001', agent: 'x' }], ['/api/team/offboard-all', { session: '5a6b7c8d-0000-4000-8000-000000000001' }],
    ] as const) {
      assert.equal((await write(p, body, evil)).status, 403, p)
    }
    assert.equal((await request(srv.port, { method: 'PUT', path: '/', headers: { Host: evil } })).status, 403)
    assert.ok(!fs.existsSync(path.join(project, '.agent-team', 'inbox')), 'no chat message written')
    // The container's own tools (loopback Host) still write.
    const local = await write('/api/team/message', { project: id, text: 'dari kontainer' }, `127.0.0.1:${srv.port}`)
    assert.equal(local.status, 200, local.body)
  } finally {
    setup.dispose()
    await srv.close()
  }
})

test('cloud mode still listens on loopback only, and is refused with --remote or --ingest', () => {
  const home = path.join(root, 'refuse')
  const env = { TEAM_MONITOR_HOME: home, CLAUDE_CODE_REMOTE: 'true' }
  const setup = setupTeam({ projects: [], remote: false, hostAllow: [], cloud: true }, { env, log: () => {} })
  assert.equal(setup.listenHost, '127.0.0.1')
  setup.dispose()
  assert.throws(() => setupTeam({ projects: [], remote: false, hostAllow: [], cloud: true, ingest: true }, { env }), CloudModeError)
  assert.throws(() => setupTeam({ projects: [], remote: true, hostAllow: [], cloud: true }, { env }), /cannot be combined with --remote or --ingest/)
  assert.equal(acceptsAnyHost({ cloud: true, remote: true }, env), false)
  assert.equal(acceptsAnyHost({ cloud: true, remote: false, ingest: true }, env), false)
})

test('--cloud is parsed as a team flag; --port still works', () => {
  const a = parseArgs(['--cloud', '--no-open', '--port', '4100'])
  assert.equal(a.team.cloud, true)
  assert.equal(a.port, 4100)
  assert.equal(a.open, false)
  assert.equal(parseArgs([]).team.cloud, undefined)
})

test('sourceId: from the cloud session id, reduced to the hub pattern; else a random id kept in the home', () => {
  assert.equal(sourceIdFromSession('session_01AbCdEfGh23JkLmNoPq'), 'session-01abcdefgh23jklmnopq')
  assert.equal(sourceIdFromSession('__Abc..def__'), 'abc-def-')
  assert.equal(sourceIdFromSession('x'.repeat(100)), 'x'.repeat(64))
  assert.equal(sourceIdFromSession('___'), null)
  assert.equal(sourceIdFromSession(''), null)
  assert.equal(sourceIdFromSession(undefined), null)
  for (const raw of ['session_01AbCdEfGh23JkLmNoPq', '-a', 'Ä€b/c']) {
    const id = sourceIdFromSession(raw)
    if (id !== null) assert.match(id, /^[a-z0-9][a-z0-9-]{0,63}$/)
  }

  const home = path.join(root, 'src-home')
  fs.mkdirSync(home)
  assert.equal(resolveSourceId({ CLAUDE_CODE_REMOTE_SESSION_ID: 'session_ABC' }, home), 'session-abc')
  const a = resolveSourceId({}, home)
  assert.match(a, /^src-[0-9a-f]{16}$/)
  assert.equal(resolveSourceId({ CLAUDE_CODE_REMOTE_SESSION_ID: '***' }, home), a, 'kept across runs')
  assert.equal(fs.statSync(path.join(cloudDir(home), SOURCE_ID_FILE)).mode & 0o777, 0o600)
})
