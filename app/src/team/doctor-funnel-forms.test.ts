/**
 * Doctor and the start-up warning see two more forms of Tailscale Funnel (QA re-check, P-02 gaps 1 and 2):
 * - a foreground Funnel (`tailscale funnel <port>` without --bg): the mapping sits under a `Foreground` session;
 * - a TCP Funnel (`--tcp`, `--tls-terminated-tcp`): a `TCP` entry with `TCPForward` to the monitor port, which is a
 *   failure in every mode (raw TCP carries no forwarded headers, so internet requests look local).
 * The exact JSON of both forms was not verified against a real Tailscale, so several plausible shapes of the same
 * information are covered, plus malformed and deeply nested documents, plus a regression table for the shapes that
 * already worked.
 */
import { test, describe, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  Check, DoctorDeps, foregroundServeMappings, funnelChecks, funnelEntries, runDoctor, runDoctorCli, serveMappings, tcpFunnels,
} from './doctor'
import { funnelStartWarning } from './index'
import { addProject } from './projects'
import { CmdRunner, installService } from './service'
import { makeTmpDir, removeTmpDir } from './test-helpers'

const PORT = 3804
const H = 'machine.tailnet.ts.net'
const quiet = () => {}
const tgt = `http://127.0.0.1:${PORT}`
const ROOT = { '/': { Proxy: tgt } }
const INGEST = { '/api/ingest': { Proxy: `${tgt}/api/ingest` } }
/** The phone's tailnet-only mapping on 8443 (background), present in every fixture so remote mode has its serve line. */
const TAILNET = { TCP: { 8443: { HTTPS: true } }, Web: { [`${H}:8443`]: { Handlers: ROOT } } }
const j = (o: unknown) => JSON.stringify(o)
const fgSession = (cfg: Record<string, unknown>) => ({ ...TAILNET, Foreground: { 'sess-1': cfg } })

// ─── Fixtures: the two new forms, in several plausible shapes ───────────────

/** Gap 1: `tailscale funnel 3804` (foreground, whole app on 443). Shapes differ in where AllowFunnel sits. */
const FG_ROOT: Record<string, string> = {
  'AllowFunnel in the session': j(fgSession({ TCP: { 443: { HTTPS: true } }, Web: { [`${H}:443`]: { Handlers: ROOT } }, AllowFunnel: { [`${H}:443`]: true } })),
  'AllowFunnel only at top level': j({ ...fgSession({ TCP: { 443: { HTTPS: true } }, Web: { [`${H}:443`]: { Handlers: ROOT } } }), AllowFunnel: { [`${H}:443`]: true } }),
  'session without an id (config directly under Foreground)': j({ ...TAILNET, Foreground: { TCP: { 443: { HTTPS: true } }, Web: { [`${H}:443`]: { Handlers: ROOT } }, AllowFunnel: { [`${H}:443`]: true } } }),
  'sessions as an array, no HTTPS flag, host with root dot and capitals': j({ ...TAILNET, Foreground: [{ Web: { [`${H}:443`]: { Handlers: ROOT } }, AllowFunnel: { [`MACHINE.tailnet.ts.net.:443`]: true } }] }),
  'localhost target, HTTP flag instead of HTTPS': j(fgSession({ TCP: { 443: { HTTP: true } }, Web: { [`${H}:443`]: { Handlers: { '/': { Proxy: `http://localhost:${PORT}` } } } }, AllowFunnel: { [`${H}:443`]: true } })),
  'wrapped one level deeper than expected': j({ ...TAILNET, Status: { Foreground: { 's': { Web: { [`${H}:443`]: { Handlers: ROOT } }, AllowFunnel: { [`${H}:443`]: true } } } } }),
}
/** Gap 1 with only /api/ingest on Funnel in the foreground (`tailscale funnel --set-path /api/ingest ...`). */
const FG_INGEST = j(fgSession({ TCP: { 443: { HTTPS: true } }, Web: { [`${H}:443`]: { Handlers: INGEST } }, AllowFunnel: { [`${H}:443`]: true } }))

/** Gap 2: `tailscale funnel --tcp=443 tcp://127.0.0.1:3804` and variants. */
const TCP_FUNNEL: Record<string, string> = {
  'plain TCP, AllowFunnel at top level': j({ ...TAILNET, TCP: { ...TAILNET.TCP, 443: { TCPForward: `127.0.0.1:${PORT}` } }, AllowFunnel: { [`${H}:443`]: true } }),
  'TLS terminated (TerminateTLS), port 10000, localhost': j({ ...TAILNET, TCP: { ...TAILNET.TCP, 10000: { TCPForward: `localhost:${PORT}`, TerminateTLS: H } }, AllowFunnel: { [`${H}:10000`]: true } }),
  '[::1] target with a tcp:// scheme': j({ ...TAILNET, TCP: { ...TAILNET.TCP, 443: { TCPForward: `tcp://[::1]:${PORT}` } }, AllowFunnel: { [`${H}:443`]: true } }),
  'in a foreground session': j(fgSession({ TCP: { 443: { TCPForward: `127.0.0.1:${PORT}` } }, AllowFunnel: { [`${H}:443`]: true } })),
  'TCP keyed by host:port': j({ ...TAILNET, TCP: { ...TAILNET.TCP, [`${H}:443`]: { TCPForward: `127.0.0.1:${PORT}`, TerminateTLS: H } }, AllowFunnel: { [`${H}:443`]: true } }),
}

/** Not Funnel: tailnet-only forms of the same mappings. */
const TCP_TAILNET = j({ ...TAILNET, TCP: { ...TAILNET.TCP, 443: { TCPForward: `127.0.0.1:${PORT}` } } })
const FG_TAILNET = j({ Foreground: { 'sess-1': { TCP: { 443: { HTTPS: true } }, Web: { [`${H}:443`]: { Handlers: ROOT } } } } })
const TCP_FUNNEL_OTHER_PORT = j({ ...TAILNET, TCP: { ...TAILNET.TCP, 443: { TCPForward: '127.0.0.1:9999' } }, AllowFunnel: { [`${H}:443`]: true } })

/** Shapes that already worked (QA's table, Web at top level). */
const st = (web: Record<string, unknown>, funnel: string[] = []) => j({ Web: web, AllowFunnel: Object.fromEntries(funnel.map((k) => [k, true])) })
const TAILNET_ONLY = st({ [`${H}:8443`]: { Handlers: ROOT } })
const BG_ROOT = st({ [`${H}:8443`]: { Handlers: ROOT }, [`${H}:443`]: { Handlers: ROOT } }, [`${H}:443`])
const BG_INGEST = st({ [`${H}:8443`]: { Handlers: ROOT }, [`${H}:443`]: { Handlers: INGEST } }, [`${H}:443`])
const BG_SUBPATH = st({ [`${H}:8443`]: { Handlers: ROOT }, [`${H}:10000`]: { Handlers: { '/x': { Proxy: `http://localhost:${PORT}/api/team` } } } }, [`${H}:10000`])
const BG_OTHER_SERVICE = st({ [`${H}:8443`]: { Handlers: ROOT }, [`${H}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } }, [`${H}:443`])

// ─── Doctor harness: an installed service with the given flags, a fake tailscale ────────────────────────

type Mode = 'default' | 'remote' | 'remote --ingest' | 'remote --public-ui' | 'remote --public-ui --ingest'
const MODES: Mode[] = ['default', 'remote', 'remote --ingest', 'remote --public-ui', 'remote --public-ui --ingest']
const flagsOf = (m: Mode) => ({ remote: m !== 'default', ingest: m.includes('--ingest'), publicUi: m.includes('--public-ui') })

const EXPOSED_ROOT_443 = `the monitor is reachable from the internet: tailscale funnel makes / on ${H}:443 public (to 127.0.0.1:${PORT}) without --public-ui`
const EXPOSED_INGEST_443 = `the monitor is reachable from the internet: tailscale funnel makes /api/ingest on ${H}:443 public (to 127.0.0.1:${PORT}) without --public-ui`
const FG_FIX = 'turn that Funnel mapping off: stop the "tailscale funnel" command that runs it in the foreground (Ctrl+C in its terminal, or end that process)'
const SERVE_8443 = `tailscale serve maps https port 8443 to 127.0.0.1:${PORT} (tailnet only)`
const NO_INGEST = `no tailscale funnel mapping for /api/ingest to 127.0.0.1:${PORT}`
const INGEST_FIX = `tailscale funnel --bg --https=443 --set-path /api/ingest http://127.0.0.1:${PORT}/api/ingest`
const NO_ROOT = `--public-ui: no tailscale funnel mapping of the whole app (/ to 127.0.0.1:${PORT})`
const ROOT_FIX = `tailscale funnel --bg --https=443 http://127.0.0.1:${PORT}`
const NOT_PUBLIC = `no tailscale funnel mapping reaches 127.0.0.1:${PORT} (not public)`
const TOKEN_OK = 'ingest token file is 600'
const WHOLE_APP = (hp: string, ingest: boolean) => `tailscale funnel serves the whole app on ${hp} (public UI: the login is on the internet${ingest ? '; it also serves /api/ingest' : ''})`

describe('doctor: foreground and TCP Funnel (P-02 gaps 1 and 2)', () => {
  let root: string
  let home: string
  let deps: DoctorDeps
  const serve: { json: string | (() => string) } = { json: '{}' }

  async function install(m: Mode): Promise<void> {
    const f = flagsOf(m)
    await installService({ port: PORT, hostAllow: [], ...(f.remote ? { bind: 'loopback' } : {}), ...f }, deps)
  }
  /** Doctor's Tailscale lines (serve, Funnel, ingest token), as `LEVEL what | fix`. */
  const lines = async (): Promise<string[]> =>
    (await runDoctor(deps))
      .filter((c) => /funnel|serve|internet|ingest token/.test(c.what))
      .map((c: Check) => `${c.level.toUpperCase()} ${c.what}${c.fix && c.level !== 'ok' ? ` | ${c.fix}` : ''}`)
  const cli = async (): Promise<{ code: number; out: string[] }> => {
    const out: string[] = []
    const code = await runDoctorCli([], { ...deps, out: (s) => out.push(s) })
    return { code, out }
  }

  before(() => {
    root = makeTmpDir()
    home = path.join(root, 'user', '.team-monitor')
    const dist = path.join(root, 'dist')
    fs.mkdirSync(path.join(dist, 'webview'), { recursive: true })
    for (const f of ['app.js', 'ask-hook.js', 'webview/index.js', 'webview/index.css']) fs.writeFileSync(path.join(dist, f), '')
    const proj = path.join(root, 'web')
    fs.mkdirSync(path.join(proj, '.agent-team'), { recursive: true })
    addProject(home, proj)
    fs.writeFileSync(path.join(home, 'token'), 'a'.repeat(64), { mode: 0o600 })
    fs.writeFileSync(path.join(home, 'ingest-token'), 'b'.repeat(64), { mode: 0o600 })
    // Hooks present, so "All good." is reachable when the Funnel lines pass.
    const askHook = path.join(dist, 'ask-hook.js')
    const hook = (cmd: string) => [{ hooks: [{ type: 'command', command: cmd }] }]
    const settings = {
      hooks: {
        ...Object.fromEntries(['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'].map((e) => [e, hook('node /x/agent-flow/hook.js')])),
      },
    }
    ;(settings.hooks.PreToolUse as unknown[]).push({ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `node "${askHook}"` }] })
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings))
    const loaded = new Set<string>()
    const run: CmdRunner = (_cmd, args) => {
      if (args[0] === 'print') return loaded.size ? { code: 0, stdout: 'state = running\npid = 99\n', stderr: '' } : { code: 113, stdout: '', stderr: '' }
      if (args[0] === 'bootstrap') loaded.add('x')
      if (args[0] === 'bootout') loaded.clear()
      return { code: 0, stdout: '', stderr: '' }
    }
    deps = {
      env: { TEAM_MONITOR_HOME: home }, platform: 'darwin', homedir: path.join(root, 'user'), uid: 501, execPath: '/n/node',
      appJs: path.join(dist, 'app.js'), run, sleep: async () => {},
      runTailscale: (args) => {
        if (args[0] !== 'serve') return JSON.stringify({ Self: { DNSName: `${H}.` } })
        return typeof serve.json === 'function' ? serve.json() : serve.json
      },
      probe: { portOpen: async () => true, health: async () => ({ ok: true, status: 200 }) },
      settingsFile: path.join(root, 'settings.json'), out: quiet, err: quiet,
    }
  })
  after(() => removeTmpDir(root))

  test('the harness reaches "All good." with only the tailnet mapping (so the cases below fail for the Funnel alone)', async () => {
    for (const m of MODES.filter((x) => !x.includes('--public-ui'))) {
      await install(m)
      serve.json = m.includes('--ingest') ? BG_INGEST : TAILNET_ONLY
      const r = await cli()
      assert.equal(r.code, 0, `${m}\n${r.out.join('\n')}`)
      assert.equal(r.out[r.out.length - 1], '\nAll good.')
    }
  })

  // Gap 1: the whole app on a foreground Funnel, in every mode and every shape.
  const fgRootExpected: Record<Mode, string[]> = {
    'default': [`FAIL ${EXPOSED_ROOT_443} | ${FG_FIX}`],
    'remote': [`OK ${SERVE_8443}`, `FAIL ${EXPOSED_ROOT_443} | ${FG_FIX}`],
    'remote --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `FAIL ${NO_INGEST} | ${INGEST_FIX}`, `FAIL ${EXPOSED_ROOT_443} | ${FG_FIX}`],
    'remote --public-ui': [`OK ${SERVE_8443}`, `OK ${WHOLE_APP(`${H}:443`, false)}`],
    'remote --public-ui --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `OK ${WHOLE_APP(`${H}:443`, true)}`],
  }
  for (const m of MODES) {
    test(`gap 1, foreground Funnel of the whole app, ${m}: same result as a background one, "stop the command" advice`, async () => {
      await install(m)
      for (const [shape, json] of Object.entries(FG_ROOT)) {
        serve.json = json
        assert.deepEqual(await lines(), fgRootExpected[m], `${m} / ${shape}`)
        const r = await cli()
        assert.equal(r.code, m.includes('--public-ui') ? 0 : 1, `${m} / ${shape}\n${r.out.join('\n')}`)
        assert.ok(!r.out.some((l) => /serve maps https port 443/.test(l)), `never the tailnet "serve maps" line for the Funnel port: ${m} / ${shape}`)
        assert.ok(!r.out.some((l) => /--bg .*off|funnel --https=443 off/.test(l)), `no "off" command for a foreground Funnel: ${m} / ${shape}`)
      }
    })
  }

  test('gap 1, foreground Funnel of only /api/ingest: allowed with --ingest, exposure without, root missing with --public-ui', async () => {
    const expected: Record<Mode, string[]> = {
      'default': [`FAIL ${EXPOSED_INGEST_443} | ${FG_FIX}`],
      'remote': [`OK ${SERVE_8443}`, `FAIL ${EXPOSED_INGEST_443} | ${FG_FIX}`],
      'remote --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `OK tailscale funnel exposes /api/ingest on ${H}:443`],
      'remote --public-ui': [`OK ${SERVE_8443}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
      'remote --public-ui --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
    }
    for (const m of MODES) {
      await install(m)
      serve.json = FG_INGEST
      assert.deepEqual(await lines(), expected[m], m)
    }
  })

  // Gap 2: a TCP Funnel to the monitor port fails in every mode, --public-ui and --ingest included.
  for (const m of MODES) {
    test(`gap 2, TCP Funnel to the monitor port, ${m}: always a failure with the command that removes it`, async () => {
      await install(m)
      for (const [shape, json] of Object.entries(TCP_FUNNEL)) {
        serve.json = json
        const l = await lines()
        const tcp = l.filter((x) => x.startsWith('FAIL the monitor is reachable from the internet as raw TCP'))
        assert.equal(tcp.length, 1, `${m} / ${shape}\n${l.join('\n')}`)
        assert.match(tcp[0], /Raw TCP carries no forwarded headers, so requests from the internet look like requests made on this machine\. Never use a TCP Funnel \(--tcp, --tls-terminated-tcp\) for the monitor/)
        assert.match(tcp[0], new RegExp(`the monitor port ${PORT}\\.`))
        const fix = tcp[0].split(' | ')[1]
        if (shape.includes('foreground')) assert.equal(fix, 'stop the "tailscale funnel" command that runs it in the foreground (Ctrl+C in its terminal, or end that process)')
        else if (shape.includes('TLS')) assert.equal(fix, 'remove that TCP Funnel: tailscale funnel --tls-terminated-tcp=10000 off')
        else if (shape.includes('host:port')) assert.equal(fix, 'remove that TCP Funnel: tailscale funnel --tls-terminated-tcp=443 off')
        else assert.equal(fix, 'remove that TCP Funnel: tailscale funnel --tcp=443 off')
        assert.ok(!l.some((x) => x.startsWith('OK no tailscale funnel mapping reaches')), `${m} / ${shape}`)
        assert.ok(!l.some((x) => /serve maps https port (443|10000)/.test(x)), `${m} / ${shape}`)
        const r = await cli()
        assert.equal(r.code, 1, `${m} / ${shape}`)
        assert.ok(!r.out.includes('\nAll good.'))
      }
    })
  }

  test('gap 2 with --public-ui and its whole-app Funnel in place: the TCP Funnel is the one failure', async () => {
    const both = j({ ...JSON.parse(BG_ROOT), TCP: { 10000: { TCPForward: `127.0.0.1:${PORT}`, TerminateTLS: H } }, AllowFunnel: { [`${H}:443`]: true, [`${H}:10000`]: true } })
    for (const m of ['remote --public-ui', 'remote --public-ui --ingest'] as Mode[]) {
      await install(m)
      serve.json = both
      const fails = (await lines()).filter((x) => x.startsWith('FAIL'))
      assert.equal(fails.length, 1, m)
      assert.match(fails[0], new RegExp(`as raw TCP: tailscale funnel forwards TCP on port 10000 to 127\\.0\\.0\\.1:${PORT} \\(TLS terminated\\)`))
    }
  })

  test('not Funnel: a tailnet-only TCP forward or foreground serve is no failure and never the HTTPS "serve maps" line it is not', async () => {
    // Tailnet-only TCP forward next to the 8443 mapping: unchanged lines (the TCP forward is not an https mapping).
    for (const m of MODES) {
      await install(m)
      serve.json = TCP_TAILNET
      const l = await lines()
      assert.ok(!l.some((x) => x.startsWith('FAIL') && /raw TCP|reachable from the internet/.test(x)), `${m}\n${l.join('\n')}`)
      assert.ok(!l.some((x) => /serve maps https port 443/.test(x)), m)
      if (m === 'default') assert.deepEqual(l, [`OK ${NOT_PUBLIC}`])
      if (m === 'remote') assert.deepEqual(l, [`OK ${SERVE_8443}`, `OK ${NOT_PUBLIC}`])
    }
    // Only a foreground tailnet serve: said truthfully (it ends with its command), not a failure.
    await install('remote')
    serve.json = FG_TAILNET
    assert.deepEqual(await lines(), [
      `OK tailscale serve maps https port 443 to 127.0.0.1:${PORT} (tailnet only, in the foreground: it ends with the "tailscale serve" command that runs it)`,
      `OK ${NOT_PUBLIC}`,
    ])
    await install('default')
    assert.deepEqual(await lines(), [`OK ${NOT_PUBLIC}`])
    // A TCP Funnel to another port is not this monitor.
    for (const m of MODES.filter((x) => !x.includes('--public-ui') && !x.includes('--ingest'))) {
      await install(m)
      serve.json = TCP_FUNNEL_OTHER_PORT
      assert.ok(!(await lines()).some((x) => x.startsWith('FAIL')), m)
    }
  })

  // Regression: the shapes that already worked keep their exact lines.
  const OFF = (cmd: string) => `turn that Funnel mapping off: ${cmd}`
  const REGRESSION: Array<[string, string, Record<Mode, string[]>]> = [
    ['Funnel on / (background)', BG_ROOT, {
      'default': [`FAIL ${EXPOSED_ROOT_443} | ${OFF('tailscale funnel --https=443 off')}`],
      'remote': [`OK ${SERVE_8443}`, `FAIL ${EXPOSED_ROOT_443} | ${OFF('tailscale funnel --https=443 off')}`],
      'remote --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `FAIL ${NO_INGEST} | ${INGEST_FIX}`, `FAIL ${EXPOSED_ROOT_443} | ${OFF('tailscale funnel --https=443 off')}`],
      'remote --public-ui': [`OK ${SERVE_8443}`, `OK ${WHOLE_APP(`${H}:443`, false)}`],
      'remote --public-ui --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `OK ${WHOLE_APP(`${H}:443`, true)}`],
    }],
    ['Funnel on /api/ingest (background)', BG_INGEST, {
      'default': [`FAIL ${EXPOSED_INGEST_443} | ${OFF('tailscale funnel --https=443 --set-path /api/ingest off')}`],
      'remote': [`OK ${SERVE_8443}`, `FAIL ${EXPOSED_INGEST_443} | ${OFF('tailscale funnel --https=443 --set-path /api/ingest off')}`],
      'remote --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `OK tailscale funnel exposes /api/ingest on ${H}:443`],
      'remote --public-ui': [`OK ${SERVE_8443}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
      'remote --public-ui --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
    }],
    ['Funnel on a sub-path, other port', BG_SUBPATH, {
      'default': [`FAIL the monitor is reachable from the internet: tailscale funnel makes /x on ${H}:10000 public (to 127.0.0.1:${PORT}) without --public-ui | ${OFF('tailscale funnel --https=10000 --set-path /x off')}`],
      'remote': [`OK ${SERVE_8443}`, `FAIL the monitor is reachable from the internet: tailscale funnel makes /x on ${H}:10000 public (to 127.0.0.1:${PORT}) without --public-ui | ${OFF('tailscale funnel --https=10000 --set-path /x off')}`],
      'remote --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `FAIL ${NO_INGEST} | ${INGEST_FIX}`, `FAIL the monitor is reachable from the internet: tailscale funnel makes /x on ${H}:10000 public (to 127.0.0.1:${PORT}) without --public-ui | ${OFF('tailscale funnel --https=10000 --set-path /x off')}`],
      'remote --public-ui': [`OK ${SERVE_8443}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
      'remote --public-ui --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
    }],
    ['Funnel to another service (different port)', BG_OTHER_SERVICE, {
      'default': [`OK ${NOT_PUBLIC}`],
      'remote': [`OK ${SERVE_8443}`, `OK ${NOT_PUBLIC}`],
      'remote --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `FAIL ${NO_INGEST} | ${INGEST_FIX}`, `FAIL tailscale funnel makes / on ${H}:443 public (the UI and login must stay tailnet-only) | serve the UI on a port without Funnel (e.g. "tailscale serve --bg --https=8443 http://127.0.0.1:${PORT}") and keep only /api/ingest on the Funnel port`],
      'remote --public-ui': [`OK ${SERVE_8443}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
      'remote --public-ui --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
    }],
    ['tailnet-only serve', TAILNET_ONLY, {
      'default': [`OK ${NOT_PUBLIC}`],
      'remote': [`OK ${SERVE_8443}`, `OK ${NOT_PUBLIC}`],
      'remote --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `FAIL ${NO_INGEST} | ${INGEST_FIX}`],
      'remote --public-ui': [`OK ${SERVE_8443}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
      'remote --public-ui --ingest': [`OK ${SERVE_8443}`, `OK ${TOKEN_OK}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
    }],
    ['none', '{}', {
      'default': [`OK ${NOT_PUBLIC}`],
      'remote': [`FAIL tailscale serve has no tailnet-only mapping to 127.0.0.1:${PORT} | tailscale serve --bg --https=8443 http://127.0.0.1:${PORT}`, `OK ${NOT_PUBLIC}`],
      'remote --ingest': [`FAIL tailscale serve has no tailnet-only mapping to 127.0.0.1:${PORT} | tailscale serve --bg --https=8443 http://127.0.0.1:${PORT}`, `OK ${TOKEN_OK}`, `FAIL ${NO_INGEST} | ${INGEST_FIX}`],
      'remote --public-ui': [`FAIL ${NO_ROOT} | ${ROOT_FIX}`],
      'remote --public-ui --ingest': [`OK ${TOKEN_OK}`, `FAIL ${NO_ROOT} | ${ROOT_FIX}`],
    }],
  ]
  test('regression table: the shapes that already worked give the same lines in every mode', async () => {
    for (const m of MODES) {
      await install(m)
      for (const [name, json, expected] of REGRESSION) {
        serve.json = json
        assert.deepEqual(await lines(), expected[m], `${name} / ${m}`)
      }
    }
  })

  test('regression: unreadable status and no tailscale binary behave as before', async () => {
    const enoent = Object.assign(new Error('spawnSync tailscale ENOENT'), { code: 'ENOENT' })
    const down = () => { throw new Error('failed to connect to local tailscaled') }
    await install('default')
    serve.json = () => { throw enoent }
    assert.deepEqual(await lines(), [])
    serve.json = down
    assert.deepEqual(await lines(), ['WARN cannot read tailscale serve status (failed to connect to local tailscaled): not checked whether Funnel exposes the monitor'])
    await install('remote')
    assert.deepEqual(await lines(), [`FAIL cannot read tailscale serve status (failed to connect to local tailscaled) | is Tailscale up? then: tailscale serve --bg --https=8443 http://127.0.0.1:${PORT}`])
    await install('remote --public-ui')
    assert.deepEqual(await lines(), [
      `FAIL cannot read tailscale serve status (failed to connect to local tailscaled) | is Tailscale up? then: tailscale serve --bg --https=8443 http://127.0.0.1:${PORT}`,
      `FAIL cannot read tailscale serve status (failed to connect to local tailscaled) | is Tailscale up? then: ${ROOT_FIX}`,
    ])
  })
})

// ─── Start-up warning: same detection ───────────────────────────────────────

describe('start-up warning: foreground and TCP Funnel', () => {
  const ok = (json: string) => async () => json
  const FLAGS: Array<[string, { publicUi?: boolean; ingest?: boolean }]> = [
    ['no flags', {}], ['--ingest', { ingest: true }], ['--public-ui', { publicUi: true }], ['--public-ui --ingest', { publicUi: true, ingest: true }],
  ]

  test('gap 1: a foreground Funnel of the whole app warns without --public-ui, with the "stop the command" advice', async () => {
    for (const [shape, json] of Object.entries(FG_ROOT)) {
      for (const [name, flags] of FLAGS) {
        const w = await funnelStartWarning(PORT, flags, ok(json))
        if (flags.publicUi) { assert.deepEqual(w, [], `${shape} / ${name}`); continue }
        assert.deepEqual(w, [
          '',
          '!!! WARNING: this monitor is REACHABLE FROM THE INTERNET through Tailscale Funnel !!!',
          `!!! Funnel maps / on ${H}:443 (foreground) to 127.0.0.1:${PORT}, but the monitor was not started with --public-ui.`,
          '!!! Turn it off: stop the "tailscale funnel" command that runs it in the foreground (Ctrl+C in its terminal, or end that process)',
          '!!! (or, if a public UI is intended, run with --remote --bind loopback --public-ui). Check with: team-monitor doctor',
          '',
        ], `${shape} / ${name}`)
      }
    }
    // Only /api/ingest in the foreground: expected with --ingest, a warning without.
    assert.deepEqual(await funnelStartWarning(PORT, { ingest: true }, ok(FG_INGEST)), [])
    assert.notDeepEqual(await funnelStartWarning(PORT, {}, ok(FG_INGEST)), [])
  })

  test('gap 2: a TCP Funnel to the monitor port warns in every mode, --public-ui included', async () => {
    for (const [shape, json] of Object.entries(TCP_FUNNEL)) {
      for (const [name, flags] of FLAGS) {
        const w = await funnelStartWarning(PORT, flags, ok(json))
        const text = w.join('\n')
        assert.match(text, /REACHABLE FROM THE INTERNET through Tailscale Funnel/, `${shape} / ${name}`)
        assert.match(text, /!!! Funnel forwards raw TCP on .* no forwarded headers, so requests from the internet look like requests made on this machine\./, `${shape} / ${name}`)
        assert.match(text, /!!! Never use a TCP Funnel \(--tcp, --tls-terminated-tcp\) for the monitor\. Check with: team-monitor doctor/, `${shape} / ${name}`)
        assert.ok(!/not started with --public-ui/.test(text), `only the TCP Funnel is named: ${shape} / ${name}`)
      }
    }
    assert.deepEqual(await funnelStartWarning(PORT, {}, ok(TCP_FUNNEL['plain TCP, AllowFunnel at top level'])), [
      '',
      '!!! WARNING: this monitor is REACHABLE FROM THE INTERNET through Tailscale Funnel !!!',
      `!!! Funnel forwards raw TCP on port 443 to 127.0.0.1:${PORT}: no forwarded headers, so requests from the internet look like requests made on this machine.`,
      '!!! Turn it off: tailscale funnel --tcp=443 off',
      '!!! Never use a TCP Funnel (--tcp, --tls-terminated-tcp) for the monitor. Check with: team-monitor doctor',
      '',
    ])
  })

  test('no warning for tailnet-only forms; the old shapes warn exactly as before', async () => {
    for (const json of [TCP_TAILNET, FG_TAILNET, TCP_FUNNEL_OTHER_PORT, TAILNET_ONLY]) {
      for (const [name, flags] of FLAGS) assert.deepEqual(await funnelStartWarning(PORT, flags, ok(json)), [], `${json} / ${name}`)
    }
    assert.deepEqual(await funnelStartWarning(PORT, {}, ok(BG_ROOT)), [
      '',
      '!!! WARNING: this monitor is REACHABLE FROM THE INTERNET through Tailscale Funnel !!!',
      `!!! Funnel maps / on ${H}:443 to 127.0.0.1:${PORT}, but the monitor was not started with --public-ui.`,
      '!!! Turn it off: tailscale funnel --https=443 off',
      '!!! (or, if a public UI is intended, run with --remote --bind loopback --public-ui). Check with: team-monitor doctor',
      '',
    ])
    assert.deepEqual(await funnelStartWarning(PORT, { publicUi: true }, ok(BG_ROOT)), [])
    assert.deepEqual(await funnelStartWarning(PORT, { ingest: true }, ok(BG_INGEST)), [])
  })
})

// ─── Malformed and deeply nested documents ──────────────────────────────────

describe('malformed or deeply nested serve status: no crash, bounded depth', () => {
  const deep = (n: number, inner: string) => '{"a":'.repeat(n) + inner + '}'.repeat(n)
  const DOCS: string[] = [
    // Deep ones first: an unbounded recursive walk overflows the stack on them.
    deep(100_000, '1'),
    '['.repeat(100_000) + ']'.repeat(100_000),
    deep(100_000, j({ TCP: { 443: { TCPForward: `127.0.0.1:${PORT}` } }, AllowFunnel: { [`${H}:443`]: true } })),
    'null', '[]', '1', '"x"', 'true', '{', '', 'not json',
    j({ Foreground: null }), j({ Foreground: 'x' }), j({ Foreground: [null, 1, 'x', []] }),
    j({ TCP: { 443: { TCPForward: 5 } }, AllowFunnel: { [`${H}:443`]: true } }),
    j({ TCP: null, Web: null, AllowFunnel: 'x' }), j({ Web: { [`${H}:443`]: null } }), j({ Web: { [`${H}:443`]: { Handlers: [ROOT] } } }),
    j({ Web: { [`${H}:443`]: { Handlers: { '/': null } } }, AllowFunnel: [] }),
    j({ AllowFunnel: { [`${H}:443`]: { nested: true } } }),
  ]

  test('every reader and both checks survive every document', async () => {
    for (const doc of DOCS) {
      const label = doc.length > 80 ? `${doc.slice(0, 40)}... (${doc.length} chars)` : doc
      assert.doesNotThrow(() => funnelEntries(doc, PORT), label)
      assert.doesNotThrow(() => serveMappings(doc, PORT), label)
      assert.doesNotThrow(() => funnelChecks(PORT, 'tailscale', () => doc), label)
      await assert.doesNotReject(funnelStartWarning(PORT, {}, async () => doc), label)
      assert.doesNotThrow(() => foregroundServeMappings(doc, PORT), label)
      assert.doesNotThrow(() => tcpFunnels(doc, PORT), label)
    }
  })

  test('a mapping a few unexpected levels deep is still found; one deeper than any real status is not read', () => {
    const tcp = j({ TCP: { 443: { TCPForward: `127.0.0.1:${PORT}` } }, AllowFunnel: { [`${H}:443`]: true } })
    const fg = j({ x: { Foreground: { s: { Web: { [`${H}:443`]: { Handlers: ROOT } }, AllowFunnel: { [`${H}:443`]: true } } } } })
    for (const doc of [deep(10, tcp), deep(10, fg)]) {
      assert.deepEqual(funnelChecks(PORT, 'tailscale', () => doc).map((c) => c.level), ['fail'], 'found 10 levels down')
    }
    assert.deepEqual(funnelChecks(PORT, 'tailscale', () => deep(100_000, tcp)).map((c) => c.level), ['ok'], 'the walk stops at its depth limit')
  })
})
