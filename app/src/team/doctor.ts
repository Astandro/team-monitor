/**
 * `team-monitor doctor`: one look at everything the monitor needs after a reboot or on a new machine.
 * Read-only: it never changes Tailscale, the service or ~/.claude/settings.json; it prints the fix instead.
 * Exit code 0 when every check passes, 1 otherwise.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { teamHome } from './config'
import { HEALTH_PATH } from './http'
import { loadConfig, ProjectError, storedProjects } from './projects'
import { defaultTailscaleBin, makeTailscaleRunner, publicUiFunnelCommand, TailscaleRunner } from './remote'
import { readServiceRecord, ServiceDeps, serviceStatus } from './service'

export type CheckLevel = 'ok' | 'fail' | 'warn'
export interface Check { level: CheckLevel; what: string; fix?: string }

export interface DoctorDeps extends ServiceDeps {
  /** Tailscale CLI for `serve status --json` (injected in tests). */
  runTailscale?: TailscaleRunner
  /** ~/.claude/settings.json (read only). */
  settingsFile?: string
  httpsPort?: number
  /** Run the hub intake checks even when the installed service has no --ingest (`doctor --ingest`). */
  ingest?: boolean
  /** Monitor port for the intake checks when no service is installed (`doctor --port`). */
  port?: number
  /** Run the public UI checks even when the installed service has no --public-ui (`doctor --public-ui`). */
  publicUi?: boolean
}

const DEFAULT_HTTPS_PORT = 8443

/**
 * The https ports `tailscale serve` maps to 127.0.0.1:<port> / localhost:<port> on the TAILNET only, from
 * `serve status --json`. A host:port with Funnel on (`AllowFunnel`) is public and never counted here (P-02): it is
 * reported by the Funnel checks instead.
 */
export function serveMappings(statusJson: string, port: number): string[] {
  let data: unknown
  try { data = JSON.parse(statusJson) } catch { return [] }
  const allowFunnel = data && typeof data === 'object' ? (data as { AllowFunnel?: unknown }).AllowFunnel : undefined
  const isFunnel = (hostPort: string | null) =>
    hostPort !== null && !!allowFunnel && typeof allowFunnel === 'object' && (allowFunnel as Record<string, unknown>)[hostPort] === true
  const found = new Set<string>()
  const targetRe = new RegExp(`^(?:https?://)?(?:127\\.0\\.0\\.1|localhost)?:?${port}/?$`)
  const walk = (node: unknown, webKey: string | null) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'AllowFunnel') continue
      if (k === 'Proxy' && typeof v === 'string' && targetRe.test(v.trim())) {
        if (isFunnel(webKey)) continue
        const m = webKey ? /:(\d+)$/.exec(webKey) : null
        found.add(m ? m[1] : webKey ?? '?')
      } else {
        walk(v, /^[^/]+:\d+$/.test(k) ? k : webKey)
      }
    }
  }
  walk(data, null)
  return [...found]
}

export const INGEST_MOUNT = '/api/ingest'
const FUNNEL_PORTS = [443, 8443, 10000]

export interface FunnelEntry {
  /** `<host>:<https port>` key of the serve config. */
  hostPort: string
  /** AllowFunnel is on for it (public internet). */
  funnel: boolean
  /** It has a /api/ingest handler proxying to this monitor. */
  ingest: boolean
  /** Its `/` handler proxies to the root of this monitor (the whole app; `--public-ui`). Also listed in `others`. */
  root: boolean
  /** Its other mount paths (anything else on a Funnel port is public too). */
  others: string[]
  /** Every mount path whose handler proxies to this monitor's port (any target path), the ingest mount included. */
  mine: string[]
}

/** Per https host:port of `tailscale serve status --json`: Funnel on or off, the ingest mount, other mounts. */
export function funnelEntries(statusJson: string, port: number): FunnelEntry[] {
  let data: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>; AllowFunnel?: Record<string, unknown> }
  try { data = JSON.parse(statusJson) } catch { return [] }
  if (!data || typeof data !== 'object') return []
  const targetRe = new RegExp(`^(?:https?://)?(?:127\\.0\\.0\\.1|localhost):${port}(?:/api/ingest)?/?$`)
  const rootRe = new RegExp(`^(?:https?://)?(?:127\\.0\\.0\\.1|localhost):${port}/?$`)
  const anyPathRe = new RegExp(`^(?:https?://)?(?:127\\.0\\.0\\.1|localhost|\\[::1\\])?:?${port}(?:[/?#].*)?$`, 'i')
  const out: FunnelEntry[] = []
  for (const [hostPort, web] of Object.entries(data.Web ?? {})) {
    const handlers = web && typeof web === 'object' && web.Handlers && typeof web.Handlers === 'object' ? web.Handlers : {}
    let ingest = false
    let root = false
    const others: string[] = []
    const mine: string[] = []
    for (const [mount, h] of Object.entries(handlers)) {
      const proxy = h && typeof h.Proxy === 'string' ? h.Proxy.trim() : ''
      if (mount.replace(/\/$/, '') === INGEST_MOUNT && targetRe.test(proxy)) ingest = true
      else others.push(mount)
      if (mount === '/' && rootRe.test(proxy)) root = true
      if (proxy && anyPathRe.test(proxy)) mine.push(mount)
    }
    out.push({ hostPort, funnel: data.AllowFunnel?.[hostPort] === true, ingest, root, others, mine })
  }
  return out
}

/** One Funnel host:port that reaches this monitor on paths its flags do not allow. */
export interface FunnelExposure { hostPort: string; paths: string[] }

/**
 * The mounts of this monitor (port `port`) on Funnel-enabled host:ports that are NOT expected for the given flags
 * (P-02/P-03): with `publicUi` nothing is unexpected (the whole app is meant to be public); with `ingest` only, every
 * mount except exactly `/api/ingest`; otherwise every mount. Used by doctor and by the start-up warning.
 */
export function unexpectedFunnelExposure(entries: FunnelEntry[], flags: { publicUi?: boolean; ingest?: boolean }): FunnelExposure[] {
  if (flags.publicUi) return []
  const out: FunnelExposure[] = []
  for (const e of entries) {
    if (!e.funnel) continue
    const paths = e.mine.filter((m) => !(flags.ingest && m.replace(/\/$/, '') === INGEST_MOUNT && e.ingest))
    if (paths.length) out.push({ hostPort: e.hostPort, paths })
  }
  return out
}

/** The command that turns one Funnel mount off: `tailscale funnel --https=<port> [--set-path <path>] off`. */
export function funnelOffCommand(hostPort: string, mount: string, bin = 'tailscale'): string {
  const quoted = bin.includes(' ') ? `"${bin}"` : bin
  const p = /:(\d+)$/.exec(hostPort)?.[1] ?? '443'
  return mount === '/' ? `${quoted} funnel --https=${p} off` : `${quoted} funnel --https=${p} --set-path ${mount} off`
}

/** One doctor FAIL per exposed host:port: reachable from the internet, where, and the exact command(s) to stop it. */
export function exposureChecks(exposed: FunnelExposure[], port: number, bin: string): Check[] {
  return exposed.map((x) => ({
    level: 'fail' as const,
    what: `the monitor is reachable from the internet: tailscale funnel makes ${x.paths.join(', ')} on ${x.hostPort} public (to 127.0.0.1:${port}) without --public-ui`,
    fix: `turn that Funnel mapping off: ${x.paths.map((m) => funnelOffCommand(x.hostPort, m, bin)).join(' ; ')}`,
  }))
}

/** The Funnel port doctor suggests: the first one Funnel allows that the tailnet UI (`--https-port`) does not use. */
function funnelPortFor(uiHttpsPort: number): number {
  return FUNNEL_PORTS.find((p) => p !== uiHttpsPort) ?? 10000
}

function ingestTokenCheck(home: string): Check {
  const tokenFile = path.join(home, 'ingest-token')
  const m = modeOf(tokenFile)
  if (m === null) return { level: 'fail', what: `ingest token file ${tokenFile} missing`, fix: 'it is created when the monitor starts with --ingest: team-monitor service restart' }
  if ((m & 0o077) !== 0) return { level: 'fail', what: `ingest token file is ${m.toString(8)}, should be 600`, fix: `chmod 600 "${tokenFile}"` }
  return { level: 'ok', what: 'ingest token file is 600' }
}

/**
 * Doctor checks for `--public-ui` (Addendum G): ONE Funnel mapping of the whole app (`/` -> http://127.0.0.1:<port>)
 * on a Funnel port. Missing: fail with the exact command. A public UI is the point here, so other mounts on the
 * Funnel port are not a failure, and with `ingest` the same mapping serves /api/ingest (no `--set-path` mapping is
 * asked for). A tailnet-only `tailscale serve` mapping (e.g. the phone's on 8443) is never flagged.
 */
export function publicUiChecks(port: number, uiHttpsPort: number, bin: string, run: TailscaleRunner, ingest: boolean): Check[] {
  const cmd = publicUiFunnelCommand(port, funnelPortFor(uiHttpsPort), bin)
  let entries: FunnelEntry[]
  try {
    entries = funnelEntries(run(['serve', 'status', '--json']), port)
  } catch (e) {
    return [{ level: 'fail', what: `cannot read tailscale serve status (${(e as Error).message.split('\n')[0]})`, fix: `is Tailscale up? then: ${cmd}` }]
  }
  const roots = entries.filter((e) => e.funnel && e.root)
  if (!roots.length) {
    return [{ level: 'fail', what: `--public-ui: no tailscale funnel mapping of the whole app (/ to 127.0.0.1:${port})`, fix: cmd }]
  }
  const where = roots.map((e) => e.hostPort).join(', ')
  return [{
    level: 'ok',
    what: `tailscale funnel serves the whole app on ${where} (public UI: the login is on the internet${ingest ? `; it also serves ${INGEST_MOUNT}` : ''})`,
  }]
}

/** Doctor checks for the hub intake: ingest token file 0600, and a Funnel mapping that exposes only /api/ingest. */
export function ingestChecks(home: string, port: number, uiHttpsPort: number, bin: string, run: TailscaleRunner): Check[] {
  const checks: Check[] = [ingestTokenCheck(home)]

  const funnelPort = funnelPortFor(uiHttpsPort)
  const quoted = bin.includes(' ') ? `"${bin}"` : bin
  const cmd = `${quoted} funnel --bg --https=${funnelPort} --set-path ${INGEST_MOUNT} http://127.0.0.1:${port}${INGEST_MOUNT}`
  let entries: FunnelEntry[]
  try {
    entries = funnelEntries(run(['serve', 'status', '--json']), port)
  } catch (e) {
    checks.push({ level: 'fail', what: `cannot read tailscale serve status (${(e as Error).message.split('\n')[0]})`, fix: `is Tailscale up? then: ${cmd}` })
    return checks
  }
  const exposed = entries.filter((e) => e.funnel && e.ingest)
  if (!exposed.length) {
    checks.push({ level: 'fail', what: `no tailscale funnel mapping for ${INGEST_MOUNT} to 127.0.0.1:${port}`, fix: cmd })
  } else {
    checks.push({ level: 'ok', what: `tailscale funnel exposes ${INGEST_MOUNT} on ${exposed.map((e) => e.hostPort).join(', ')}` })
  }
  // Any other path of this monitor on a Funnel port: the monitor is reachable from the internet (P-02).
  checks.push(...exposureChecks(unexpectedFunnelExposure(entries, { ingest: true }), port, bin))
  // Other services' paths on the same Funnel port (as before).
  for (const e of entries.filter((x) => x.funnel)) {
    const foreign = e.others.filter((m) => !e.mine.includes(m))
    if (!foreign.length) continue
    checks.push({
      level: 'fail',
      what: `tailscale funnel makes ${foreign.join(', ')} on ${e.hostPort} public (the UI and login must stay tailnet-only)`,
      fix: `serve the UI on a port without Funnel (e.g. "${quoted} serve --bg --https=${uiHttpsPort} http://127.0.0.1:${port}") and keep only ${INGEST_MOUNT} on the Funnel port`,
    })
  }
  return checks
}

/** A runner that runs each distinct command once (doctor reads `serve status` in more than one step). */
function memoRunner(run: TailscaleRunner): TailscaleRunner {
  const seen = new Map<string, { out?: string; err?: unknown }>()
  return (args) => {
    const k = args.join('\0')
    let r = seen.get(k)
    if (!r) {
      try { r = { out: run(args) } } catch (e) { r = { err: e } }
      seen.set(k, r)
    }
    if ('err' in r) throw r.err
    return r.out as string
  }
}

/**
 * Funnel check without --public-ui and without --ingest (P-02/P-03): no path of this monitor may be on a
 * Funnel-enabled host:port. No `tailscale` binary: nothing to check (no line). Status unreadable: a warning (unless
 * `reportUnreadable` is false because another step already failed on it).
 */
export function funnelChecks(port: number, bin: string, run: TailscaleRunner, reportUnreadable = true): Check[] {
  let json: string
  try {
    json = run(['serve', 'status', '--json'])
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || !reportUnreadable) return []
    return [{ level: 'warn', what: `cannot read tailscale serve status (${(e as Error).message.split('\n')[0]}): not checked whether Funnel exposes the monitor` }]
  }
  const exposed = unexpectedFunnelExposure(funnelEntries(json, port), {})
  if (exposed.length) return exposureChecks(exposed, port, bin)
  return [{ level: 'ok', what: `no tailscale funnel mapping reaches 127.0.0.1:${port} (not public)` }]
}

/** The `ask-hook.js` path inside a hook command (quoted or not), or null. */
function askHookPath(command: string): string | null {
  const m = /"([^"]*ask-hook\.js)"|(\S*ask-hook\.js)/.exec(command)
  return m ? (m[1] ?? m[2]) : null
}

export function checkHooks(settingsFile: string): Check[] {
  let settings: { hooks?: Record<string, unknown> }
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')) as typeof settings
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
    return [{
      level: 'fail',
      what: `Claude Code settings ${settingsFile} ${missing ? 'missing' : 'cannot be read as JSON'}`,
      fix: 'start the monitor once (it writes the graph hooks), then add the AskUserQuestion hook (docs/coordinator.md 4b)',
    }]
  }
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const commands = (event: string, matcher?: string): string[] => {
    const list = Array.isArray(hooks[event]) ? hooks[event] as Array<Record<string, unknown>> : []
    return list
      .filter((e) => matcher === undefined || e?.matcher === matcher)
      .flatMap((e) => Array.isArray(e?.hooks) ? e.hooks as Array<Record<string, unknown>> : [])
      .map((h) => typeof h?.command === 'string' ? h.command : '')
  }
  const out: Check[] = []
  const graphEvents = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop']
  const missingGraph = graphEvents.filter((ev) => !commands(ev).some((c) => c.includes('agent-flow/hook.js')))
  out.push(missingGraph.length
    ? { level: 'fail', what: `graph hooks missing in ${settingsFile} for ${missingGraph.join(', ')}`, fix: 'restart the monitor (it writes them at start): team-monitor service restart' }
    : { level: 'ok', what: 'graph hooks present in Claude Code settings' })
  const ask = commands('PreToolUse', 'AskUserQuestion').map(askHookPath).filter((p): p is string => !!p)
  if (!ask.length) {
    out.push({ level: 'fail', what: 'AskUserQuestion hook (ask-hook.js) missing in Claude Code settings', fix: 'add the snippet from docs/coordinator.md section 4b' })
  } else if (!ask.some((p) => fs.existsSync(p))) {
    out.push({ level: 'fail', what: `AskUserQuestion hook points at a missing file: ${ask[0]}`, fix: 'build the app (pnpm run build:app) or fix the path in the hook' })
  } else {
    out.push({ level: 'ok', what: 'AskUserQuestion hook present' })
  }
  return out
}

function modeOf(file: string): number | null {
  try { return fs.statSync(file).mode & 0o777 } catch { return null }
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<Check[]> {
  const env = deps.env ?? process.env
  const home = teamHome(env)
  const homedir = deps.homedir ?? os.homedir()
  const checks: Check[] = []
  const record = readServiceRecord(home)

  // 1. Build present (the one the service runs, else the one running this command).
  const appJs = record?.appJs ?? path.resolve(deps.appJs ?? process.argv[1] ?? '')
  const dist = path.dirname(appJs)
  // index.html is generated by static.ts; the build writes index.js and index.css.
  const missing = ['app.js', 'ask-hook.js', path.join('webview', 'index.js'), path.join('webview', 'index.css')].filter((f) => !fs.existsSync(path.join(dist, f)))
  checks.push(missing.length
    ? { level: 'fail', what: `build incomplete in ${dist}: missing ${missing.join(', ')}`, fix: 'npx -y pnpm@10 run build:app (in the team-monitor checkout)' }
    : { level: 'ok', what: `build present in ${dist}` })

  // 2-3. Service loaded and healthy.
  const st = await serviceStatus(deps)
  if (!st.record) {
    checks.push({ level: 'fail', what: 'service not installed', fix: 'node <checkout>/app/dist/app.js service install --remote --bind loopback' })
  } else {
    const r = st.record
    if (!st.installed) checks.push({ level: 'fail', what: `service file missing: ${r.file}`, fix: 'run service install again' })
    if (!st.manager.loaded || !st.manager.running) {
      checks.push({ level: 'fail', what: `service ${r.label} not running (${st.manager.detail})`, fix: `team-monitor service restart; log: ${r.logFile}` })
    } else {
      checks.push({ level: 'ok', what: `service ${r.label} running, pid ${st.manager.pid}` })
    }
    checks.push(st.health.ok
      ? { level: 'ok', what: `healthy: GET http://${r.listenHost}:${r.port}${HEALTH_PATH} 200` }
      : { level: 'fail', what: `not healthy on ${r.listenHost}:${r.port} (${st.listening ? `HTTP ${st.health.status}` : 'port not listening'})`, fix: `see the log: ${r.logFile}` })
  }

  // 4-5. Config and project folders.
  try {
    const projects = storedProjects(loadConfig(home))
    if (!projects.length) {
      checks.push({ level: 'fail', what: `no projects in ${path.join(home, 'config.json')}`, fix: 'team-monitor project add <path>' })
    } else {
      checks.push({ level: 'ok', what: `config valid, ${projects.length} project(s)` })
    }
    for (const p of projects) {
      const label = `project ${p.id || '(no id)'} (${p.path || 'no path'})`
      let isDir = false
      try { isDir = !!p.path && fs.statSync(p.path).isDirectory() } catch { isDir = false }
      if (!isDir) { checks.push({ level: 'fail', what: `${label}: folder missing`, fix: `team-monitor project remove ${p.id || p.path}` }); continue }
      let hasDir = false
      try { hasDir = fs.statSync(path.join(p.path, '.agent-team')).isDirectory() } catch { hasDir = false }
      checks.push(hasDir
        ? { level: 'ok', what: `${label}: .agent-team/ present` }
        : { level: 'fail', what: `${label}: .agent-team/ missing`, fix: `team-monitor project add ${p.path}` })
    }
  } catch (e) {
    if (!(e instanceof ProjectError)) throw e
    checks.push({ level: 'fail', what: `config invalid: ${e.message}` })
  }

  // Flags, port and the tailscale CLI for steps 6 and 8. `serve status` is read once per run.
  const ingestOn = !!(record?.ingest || deps.ingest)
  const publicUiOn = !!(record?.publicUi || deps.publicUi)
  const monitorPort = record?.port ?? deps.port ?? 3002
  const bin = record?.tailscaleBin || defaultTailscaleBin(env)
  const run = memoRunner(deps.runTailscale ?? makeTailscaleRunner(bin))

  // 6. Tailscale serve mapping on the tailnet (remote mode behind serve only). A Funnel host:port is never counted
  //    here (it is public: step 8). With --public-ui the Funnel root mapping serves the tailnet too, so a missing
  //    tailnet-only mapping is not a failure there.
  if (record?.remote && record.bind === 'loopback') {
    const httpsPort = deps.httpsPort ?? DEFAULT_HTTPS_PORT
    const cmd = `${bin.includes(' ') ? `"${bin}"` : bin} serve --bg --https=${httpsPort} http://127.0.0.1:${record.port}`
    try {
      const ports = serveMappings(run(['serve', 'status', '--json']), record.port)
      if (ports.length) checks.push({ level: 'ok', what: `tailscale serve maps https port ${ports.join(', ')} to 127.0.0.1:${record.port} (tailnet only)` })
      else if (!publicUiOn) checks.push({ level: 'fail', what: `tailscale serve has no tailnet-only mapping to 127.0.0.1:${record.port}`, fix: cmd })
    } catch (e) {
      checks.push({ level: 'fail', what: `cannot read tailscale serve status (${(e as Error).message.split('\n')[0]})`, fix: `is Tailscale up? then: ${cmd}` })
    }
  }

  // 7. Home and token file permissions.
  const homeMode = modeOf(home)
  if (homeMode !== null && (homeMode & 0o077) !== 0) {
    checks.push({ level: 'fail', what: `${home} is ${homeMode.toString(8)}, should be 700`, fix: `chmod 700 "${home}"` })
  }
  if (record?.remote) {
    const tokenFile = path.join(home, 'token')
    const m = modeOf(tokenFile)
    if (m === null) checks.push({ level: 'fail', what: `token file ${tokenFile} missing`, fix: 'it is created when the monitor starts in remote mode: team-monitor service restart' })
    else if ((m & 0o077) !== 0) checks.push({ level: 'fail', what: `token file is ${m.toString(8)}, should be 600`, fix: `chmod 600 "${tokenFile}"` })
    else checks.push({ level: 'ok', what: 'token file is 600' })
  }

  // 8. Funnel, in every mode (P-02/P-03).
  //    --public-ui (on the service, or doctor --public-ui): the whole-app mapping is expected (it also serves
  //    /api/ingest); the ingest token file is still checked when ingest is on.
  //    --ingest only: token file and exactly the /api/ingest mount on Funnel.
  //    Neither: any path of this monitor on a Funnel host:port fails, with the command that turns it off.
  const uiHttpsPort = deps.httpsPort ?? DEFAULT_HTTPS_PORT
  if (publicUiOn) {
    if (ingestOn) checks.push(ingestTokenCheck(home))
    checks.push(...publicUiChecks(monitorPort, uiHttpsPort, bin, run, ingestOn))
  } else if (ingestOn) {
    checks.push(...ingestChecks(home, monitorPort, uiHttpsPort, bin, run))
  } else {
    // A failure to read the status was already reported by step 6 in remote mode behind serve.
    checks.push(...funnelChecks(monitorPort, bin, run, !(record?.remote && record.bind === 'loopback')))
  }

  // 9. Claude Code hooks (read only).
  checks.push(...checkHooks(deps.settingsFile ?? path.join(homedir, '.claude', 'settings.json')))
  return checks
}

export async function runDoctorCli(argv: string[], deps: DoctorDeps = {}): Promise<number> {
  const out = deps.out ?? console.log
  const err = deps.err ?? console.error
  let httpsPort = deps.httpsPort
  let ingest = deps.ingest
  let publicUi = deps.publicUi
  let port = deps.port
  const portArg = (v: string | undefined) => /^\d+$/.test(v ?? '') && Number(v) >= 1 && Number(v) <= 65535
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--https-port' && portArg(argv[i + 1])) {
      httpsPort = Number(argv[++i])
    } else if (argv[i] === '--port' && portArg(argv[i + 1])) {
      port = Number(argv[++i])
    } else if (argv[i] === '--ingest') {
      ingest = true
    } else if (argv[i] === '--public-ui') {
      publicUi = true
    } else {
      err('Usage: team-monitor doctor [--https-port <port for tailscale serve, default 8443>] [--ingest] [--public-ui] [--port <monitor port>]')
      return 2
    }
  }
  const checks = await runDoctor({ ...deps, httpsPort, ingest, port, publicUi })
  for (const c of checks) {
    out(`${c.level === 'ok' ? 'OK  ' : c.level === 'warn' ? 'WARN' : 'FAIL'}  ${c.what}`)
    if (c.fix && c.level !== 'ok') out(`      fix: ${c.fix}`)
  }
  const failed = checks.filter((c) => c.level === 'fail').length
  out(failed ? `\n${failed} problem(s).` : '\nAll good.')
  return failed ? 1 : 0
}
