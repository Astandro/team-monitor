/**
 * `team-monitor service install|status|restart|uninstall`: run the monitor as a per-user service that starts at
 * login and restarts after a crash or a reboot.
 *
 * macOS: a LaunchAgent (~/Library/LaunchAgents/<label>.plist, RunAtLoad + KeepAlive) loaded with
 * `launchctl bootstrap gui/<uid>`. Linux: a `systemd --user` unit with Restart=always.
 * Projects come from config.json (one service for every project). What was installed is recorded in
 * `<team home>/service.json`, so status/restart/uninstall/doctor and `project add` find it again.
 */
import { spawnSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { APP_DEFAULT_PORT } from '../args'
import { ensureHome, expandHome, teamHome } from './config'
import { loadConfig, storedProjects } from './projects'
import {
  defaultTailscaleBin, getTailscaleDNSName, getTailscaleIPv4, isTailnetIPv4, makeTailscaleRunner, TailscaleRunner,
} from './remote'

export const DEFAULT_LABEL = 'com.astandro.team-monitor'
export const DEFAULT_LINUX_UNIT = 'team-monitor'
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/

export type ServicePlatform = 'darwin' | 'linux'

export class ServiceError extends Error {}

export interface CmdResult { code: number; stdout: string; stderr: string }
/** Runs a command (launchctl, systemctl) without a shell. Injected in tests. */
export type CmdRunner = (cmd: string, args: string[]) => CmdResult

export const runCmd: CmdRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) return { code: 127, stdout: '', stderr: r.error.message }
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// ─── What the service runs ──────────────────────────────────────────────────

export interface ServiceSpec {
  platform: ServicePlatform
  label: string
  /** Absolute node binary (process.execPath at install time). */
  node: string
  /** Absolute app/dist/app.js. */
  appJs: string
  port: number
  remote: boolean
  bind?: 'loopback' | 'tailscale'
  hostAllow: string[]
  tailscaleBin?: string
  /** Hub intake for cloud sources (`--ingest`). */
  ingest?: boolean
  workingDirectory: string
  /** HOME and TEAM_MONITOR_HOME written into the service environment. */
  home: string
  teamHome: string
  logFile: string
}

export function programArguments(s: ServiceSpec): string[] {
  const args = [s.node, s.appJs, '--port', String(s.port), '--no-open']
  if (s.remote) args.push('--remote', '--bind', s.bind ?? 'loopback')
  for (const h of s.hostAllow) args.push('--host-allow', h)
  if (s.tailscaleBin) args.push('--tailscale-bin', s.tailscaleBin)
  if (s.ingest) args.push('--ingest')
  return args
}

export function servicePath(s: Pick<ServiceSpec, 'platform' | 'node'>): string {
  const dirs = [path.dirname(s.node)]
  if (s.platform === 'darwin') dirs.push('/opt/homebrew/bin')
  dirs.push('/usr/local/bin', '/usr/bin', '/bin')
  return [...new Set(dirs)].join(':')
}

export function serviceEnv(s: ServiceSpec): Array<[string, string]> {
  return [['PATH', servicePath(s)], ['HOME', s.home], ['TEAM_MONITOR_HOME', s.teamHome]]
}

function assertOneLine(values: string[]): void {
  for (const v of values) {
    if (/[\r\n\0]/.test(v)) throw new ServiceError(`a service value contains a line break: ${JSON.stringify(v)}`)
  }
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** LaunchAgent plist. Umask 63 = 0o077, so the log and anything the monitor creates is private. */
export function renderPlist(s: ServiceSpec): string {
  const args = programArguments(s)
  const env = serviceEnv(s)
  assertOneLine([...args, ...env.map((e) => e[1]), s.label, s.workingDirectory, s.logFile])
  const str = (v: string) => `<string>${xml(v)}</string>`
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${str(s.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    ${str(a)}`),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${str(s.workingDirectory)}`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.flatMap(([k, v]) => [`    <key>${k}</key>`, `    ${str(v)}`]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '  <key>StandardOutPath</key>',
    `  ${str(s.logFile)}`,
    '  <key>StandardErrorPath</key>',
    `  ${str(s.logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ]
  return lines.join('\n')
}

/** One systemd word: quoted when needed; `%` and `$` escaped so systemd does not expand them. */
export function systemdQuote(v: string): string {
  const esc = v.replace(/%/g, '%%').replace(/\$/g, '$$$$')
  if (/^[A-Za-z0-9_\-.\/:@=+,%$]+$/.test(esc)) return esc
  return `"${esc.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function renderSystemdUnit(s: ServiceSpec): string {
  const args = programArguments(s)
  const env = serviceEnv(s)
  assertOneLine([...args, ...env.map((e) => e[1]), s.label, s.workingDirectory, s.logFile])
  const pct = (v: string) => v.replace(/%/g, '%%')
  return [
    '[Unit]',
    'Description=Team Monitor (agent graph and team panel)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${args.map(systemdQuote).join(' ')}`,
    `WorkingDirectory=${pct(s.workingDirectory)}`,
    ...env.map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`),
    'UMask=0077',
    'Restart=always',
    'RestartSec=10',
    `StandardOutput=append:${pct(s.logFile)}`,
    `StandardError=append:${pct(s.logFile)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export function serviceFilePath(platform: ServicePlatform, label: string, home: string): string {
  return platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', `${label}.plist`)
    : path.join(home, '.config', 'systemd', 'user', `${label}.service`)
}

// ─── Record of what was installed ───────────────────────────────────────────

export interface ServiceRecord {
  platform: ServicePlatform
  label: string
  file: string
  port: number
  remote: boolean
  bind?: 'loopback' | 'tailscale'
  /** Address the server listens on (127.0.0.1, or the Tailscale IPv4 with --bind tailscale). */
  listenHost: string
  hostAllow: string[]
  tailscaleBin?: string
  /** Installed with `--ingest` (hub intake); doctor then checks the ingest token and the Funnel mapping. */
  ingest?: boolean
  appJs: string
  node: string
  logFile: string
  installedAt: string
}

export function serviceRecordFile(home: string): string {
  return path.join(home, 'service.json')
}

export function readServiceRecord(home: string): ServiceRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(serviceRecordFile(home), 'utf-8')) as ServiceRecord
    if (!r || typeof r !== 'object' || typeof r.label !== 'string' || typeof r.port !== 'number') return null
    if (r.platform !== 'darwin' && r.platform !== 'linux') return null
    return r
  } catch {
    return null
  }
}

/** Write a file through a temp file in the same folder (fsync, rename) with the given mode. */
export function writeFileAtomic(file: string, content: string, mode: number): void {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'wx', mode)
  try {
    try {
      fs.writeSync(fd, content)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* already gone */ }
    throw e
  }
}

// ─── Service manager calls ──────────────────────────────────────────────────

export interface ServiceDeps {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** The user's home (os.homedir()); the service file and HOME of the service follow it. */
  homedir?: string
  uid?: number
  execPath?: string
  /** Path of the running app.js (the built bundle). */
  appJs?: string
  run?: CmdRunner
  runTailscale?: TailscaleRunner
  sleep?: (ms: number) => Promise<void>
  probe?: Probe
  out?: (msg: string) => void
  err?: (msg: string) => void
}

export interface HealthResult { ok: boolean; status: number; projects: number | null; error?: string }
export interface Probe {
  portOpen: (host: string, port: number) => Promise<boolean>
  health: (host: string, port: number) => Promise<HealthResult>
}

export const realProbe: Probe = {
  portOpen: (host, port) => new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.setTimeout(1500, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  }),
  health: (host, port) => new Promise((resolve) => {
    const req = http.request({
      host, port, path: '/api/team/projects', method: 'GET', timeout: 3000,
      headers: { Host: `${host}:${port}`, Accept: 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => { if (chunks.length < 256) chunks.push(c) })
      res.on('end', () => {
        const status = res.statusCode ?? 0
        let projects: number | null = null
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { projects?: unknown }
          if (Array.isArray(body.projects)) projects = body.projects.length
        } catch { /* not JSON */ }
        resolve({ ok: status === 200 && projects !== null, status, projects })
      })
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', (e) => resolve({ ok: false, status: 0, projects: null, error: e.message }))
    req.end()
  }),
}

interface Ctx {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  homedir: string
  uid: number
  run: CmdRunner
  sleep: (ms: number) => Promise<void>
  probe: Probe
  out: (msg: string) => void
  err: (msg: string) => void
  teamHome: string
}

function ctxOf(deps: ServiceDeps): Ctx {
  const env = deps.env ?? process.env
  return {
    env,
    platform: deps.platform ?? process.platform,
    homedir: deps.homedir ?? os.homedir(),
    uid: deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0),
    run: deps.run ?? runCmd,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    probe: deps.probe ?? realProbe,
    out: deps.out ?? console.log,
    err: deps.err ?? console.error,
    teamHome: teamHome(env),
  }
}

function supportedPlatform(p: NodeJS.Platform): ServicePlatform {
  if (p === 'darwin' || p === 'linux') return p
  throw new ServiceError(`service commands support macOS (launchd) and Linux (systemd --user), not ${p}.`)
}

export interface ManagerState { loaded: boolean; running: boolean; pid: number | null; detail: string }

export function managerState(ctx: Pick<Ctx, 'run' | 'uid'>, platform: ServicePlatform, label: string): ManagerState {
  if (platform === 'darwin') {
    const r = ctx.run('launchctl', ['print', `gui/${ctx.uid}/${label}`])
    if (r.code !== 0) return { loaded: false, running: false, pid: null, detail: 'not loaded in launchd' }
    const pid = /^\s*pid = (\d+)/m.exec(r.stdout)
    const state = /^\s*state = (\S+)/m.exec(r.stdout)
    const p = pid ? Number(pid[1]) : null
    return { loaded: true, running: p !== null, pid: p, detail: `launchd state ${state ? state[1] : 'unknown'}` }
  }
  const r = ctx.run('systemctl', ['--user', 'show', `${label}.service`, '--property=LoadState,ActiveState,MainPID'])
  if (r.code !== 0) return { loaded: false, running: false, pid: null, detail: (r.stderr || 'systemctl failed').trim().split('\n')[0] }
  const kv = Object.fromEntries(r.stdout.split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join('=').trim()]))
  const pid = Number(kv.MainPID)
  const loaded = kv.LoadState === 'loaded'
  return {
    loaded,
    running: kv.ActiveState === 'active' && pid > 0,
    pid: pid > 0 ? pid : null,
    detail: `systemd ${kv.LoadState ?? '?'} / ${kv.ActiveState ?? '?'}`,
  }
}

function must(r: CmdResult, what: string): void {
  if (r.code !== 0) throw new ServiceError(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n')[0] || 'no output'}`)
}

async function launchdUnload(ctx: Ctx, label: string): Promise<boolean> {
  if (!managerState(ctx, 'darwin', label).loaded) return false
  ctx.run('launchctl', ['bootout', `gui/${ctx.uid}/${label}`])
  for (let i = 0; i < 40; i++) {
    if (!managerState(ctx, 'darwin', label).loaded) return true
    await ctx.sleep(250)
  }
  throw new ServiceError(`launchd still has ${label} loaded after bootout; try again in a few seconds.`)
}

async function launchdLoad(ctx: Ctx, file: string): Promise<void> {
  let last: CmdResult = { code: 1, stdout: '', stderr: '' }
  for (let i = 0; i < 4; i++) {
    last = ctx.run('launchctl', ['bootstrap', `gui/${ctx.uid}`, file])
    if (last.code === 0) return
    await ctx.sleep(1000) // "5: Input/output error" right after a bootout; it clears in a moment
  }
  must(last, 'launchctl bootstrap')
}

// ─── install ────────────────────────────────────────────────────────────────

export interface InstallOptions {
  port: number
  remote: boolean
  bind?: string
  hostAllow: string[]
  tailscaleBin?: string
  label?: string
  workspace?: string
  logFile?: string
  ingest?: boolean
}

/** First registered project that exists, else the team home. Hooks forward events only for sessions under it. */
export function defaultWorkspace(home: string): string {
  try {
    for (const p of storedProjects(loadConfig(home))) {
      if (!p.path) continue
      try {
        const real = fs.realpathSync(path.resolve(expandHome(p.path)))
        if (fs.statSync(real).isDirectory()) return real
      } catch { /* missing: try the next */ }
    }
  } catch { /* broken config: doctor reports it */ }
  return home
}

/**
 * Host name for --host-allow: the given ones, else the MagicDNS name detected now (the server detects it again at
 * every start, but at login Tailscale may not be up yet, so it is written into the service as well).
 */
export function resolveHostAllow(given: string[], run: TailscaleRunner, warn: (m: string) => void): string[] {
  const clean = given.map((h) => h.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean)
  for (const h of clean) if (!/^[a-z0-9.-]+$/.test(h)) throw new ServiceError(`--host-allow "${h}" is not a host name.`)
  if (clean.length) return [...new Set(clean)]
  const dns = getTailscaleDNSName(run)
  if (dns) return [dns]
  warn('MagicDNS name not found (is Tailscale up?). The service will only accept it if Tailscale is up when it ' +
    'starts; to make it permanent, install again with --host-allow <machine>.<tailnet>.ts.net')
  return []
}

export function buildSpec(opts: InstallOptions, deps: ServiceDeps = {}): { spec: ServiceSpec; listenHost: string } {
  const ctx = ctxOf(deps)
  const platform = supportedPlatform(ctx.platform)
  const label = opts.label ?? (platform === 'darwin' ? DEFAULT_LABEL : DEFAULT_LINUX_UNIT)
  if (!LABEL_RE.test(label)) throw new ServiceError(`--label "${label}" may only hold letters, digits, ".", "_" and "-".`)
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new ServiceError('--port must be 1-65535.')

  const appJs = path.resolve(deps.appJs ?? process.argv[1] ?? '')
  if (!/\.js$/.test(appJs) || !fs.existsSync(appJs)) {
    throw new ServiceError(`run this from the built app (node app/dist/app.js service install), not from ${appJs}. Build first: pnpm run build:app`)
  }
  const node = path.resolve(deps.execPath ?? process.execPath)

  let bind: 'loopback' | 'tailscale' | undefined
  let hostAllow: string[] = []
  let listenHost = '127.0.0.1'
  if (opts.remote) {
    if (opts.bind !== 'loopback' && opts.bind !== 'tailscale') {
      throw new ServiceError('--remote needs --bind loopback (behind tailscale serve) or --bind tailscale. The monitor never listens on 0.0.0.0.')
    }
    bind = opts.bind
    const run = deps.runTailscale ?? makeTailscaleRunner(opts.tailscaleBin || defaultTailscaleBin(ctx.env))
    if (bind === 'tailscale') {
      let ip: string
      try { ip = getTailscaleIPv4(run) } catch (e) { throw new ServiceError((e as Error).message) }
      if (!isTailnetIPv4(ip)) throw new ServiceError(`"tailscale ip -4" gave ${ip}, not a Tailscale address; refusing --bind tailscale.`)
      listenHost = ip
    }
    hostAllow = resolveHostAllow(opts.hostAllow, run, ctx.err)
  } else if (opts.bind || opts.hostAllow.length) {
    throw new ServiceError('--bind and --host-allow need --remote.')
  }

  const spec: ServiceSpec = {
    platform,
    label,
    node,
    appJs,
    port: opts.port,
    remote: opts.remote,
    bind,
    hostAllow,
    tailscaleBin: opts.tailscaleBin ? path.resolve(expandHome(opts.tailscaleBin)) : undefined,
    ...(opts.ingest ? { ingest: true } : {}),
    workingDirectory: opts.workspace ? path.resolve(expandHome(opts.workspace)) : defaultWorkspace(ctx.teamHome),
    home: ctx.homedir,
    teamHome: ctx.teamHome,
    logFile: opts.logFile ? path.resolve(expandHome(opts.logFile)) : path.join(ctx.teamHome, 'team-monitor.log'),
  }
  return { spec, listenHost }
}

export async function installService(opts: InstallOptions, deps: ServiceDeps = {}): Promise<ServiceRecord> {
  const ctx = ctxOf(deps)
  const { spec, listenHost } = buildSpec(opts, deps)
  ensureHome(ctx.teamHome)
  if (!fs.existsSync(spec.workingDirectory)) throw new ServiceError(`--workspace ${spec.workingDirectory} does not exist.`)

  // Log file: private before the service manager opens it.
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true, mode: 0o700 })
  fs.closeSync(fs.openSync(spec.logFile, 'a', 0o600))
  fs.chmodSync(spec.logFile, 0o600)

  const file = serviceFilePath(spec.platform, spec.label, ctx.homedir)
  fs.mkdirSync(path.dirname(file), { recursive: true })

  // A previous record with another label is replaced too, so two services never fight over the port.
  const prev = readServiceRecord(ctx.teamHome)
  if (spec.platform === 'darwin') {
    if (prev && prev.platform === 'darwin' && prev.label !== spec.label) {
      await launchdUnload(ctx, prev.label)
      try { fs.unlinkSync(prev.file) } catch { /* gone */ }
    }
    const was = await launchdUnload(ctx, spec.label)
    if (was) ctx.out(`Stopped the old ${spec.label}.`)
    writeFileAtomic(file, renderPlist(spec), 0o644)
    await launchdLoad(ctx, file)
  } else {
    if (prev && prev.platform === 'linux' && prev.label !== spec.label) {
      ctx.run('systemctl', ['--user', 'disable', '--now', `${prev.label}.service`])
      try { fs.unlinkSync(prev.file) } catch { /* gone */ }
    }
    writeFileAtomic(file, renderSystemdUnit(spec), 0o644)
    must(ctx.run('systemctl', ['--user', 'daemon-reload']), 'systemctl --user daemon-reload')
    must(ctx.run('systemctl', ['--user', 'enable', `${spec.label}.service`]), 'systemctl --user enable')
    must(ctx.run('systemctl', ['--user', 'restart', `${spec.label}.service`]), 'systemctl --user restart')
  }

  const record: ServiceRecord = {
    platform: spec.platform, label: spec.label, file, port: spec.port, remote: spec.remote, bind: spec.bind,
    listenHost, hostAllow: spec.hostAllow, tailscaleBin: spec.tailscaleBin, ...(spec.ingest ? { ingest: true } : {}), appJs: spec.appJs, node: spec.node, logFile: spec.logFile,
    installedAt: new Date().toISOString(),
  }
  writeFileAtomic(serviceRecordFile(ctx.teamHome), JSON.stringify(record, null, 2) + '\n', 0o600)
  return record
}

// ─── status / restart / uninstall ───────────────────────────────────────────

export interface ServiceStatus {
  record: ServiceRecord | null
  installed: boolean
  manager: ManagerState
  listening: boolean
  health: HealthResult
}

export async function serviceStatus(deps: ServiceDeps = {}): Promise<ServiceStatus> {
  const ctx = ctxOf(deps)
  const record = readServiceRecord(ctx.teamHome)
  const noHealth: HealthResult = { ok: false, status: 0, projects: null }
  if (!record) {
    return { record, installed: false, manager: { loaded: false, running: false, pid: null, detail: 'not installed' }, listening: false, health: noHealth }
  }
  const installed = fs.existsSync(record.file)
  const manager = managerState(ctx, record.platform, record.label)
  const listening = await ctx.probe.portOpen(record.listenHost, record.port)
  const health = listening ? await ctx.probe.health(record.listenHost, record.port) : noHealth
  return { record, installed, manager, listening, health }
}

export function statusLines(s: ServiceStatus): { lines: string[]; ok: boolean } {
  if (!s.record) return { lines: ['Service: not installed (team-monitor service install).'], ok: false }
  const r = s.record
  const lines = [
    `Service: ${r.label} (${r.platform === 'darwin' ? 'launchd' : 'systemd --user'}), file ${r.file}${s.installed ? '' : ' (MISSING)'}`,
    `Loaded: ${s.manager.loaded ? 'yes' : 'no'} (${s.manager.detail})${s.manager.pid ? `, pid ${s.manager.pid}` : ''}`,
    `Port ${r.port} on ${r.listenHost}: ${s.listening ? 'listening' : 'not listening'}`,
    `Health GET /api/team/projects: ${s.health.ok ? `200, ${s.health.projects} project(s)` : s.health.status ? `HTTP ${s.health.status}` : 'no answer'}`,
    `Log: ${r.logFile}`,
  ]
  return { lines, ok: s.installed && s.manager.loaded && s.manager.running && s.listening && s.health.ok }
}

export async function restartService(deps: ServiceDeps = {}): Promise<ServiceRecord> {
  const ctx = ctxOf(deps)
  const record = readServiceRecord(ctx.teamHome)
  if (!record) throw new ServiceError('no service installed (team-monitor service install).')
  if (record.platform === 'darwin') {
    if (managerState(ctx, 'darwin', record.label).loaded) {
      must(ctx.run('launchctl', ['kickstart', '-k', `gui/${ctx.uid}/${record.label}`]), 'launchctl kickstart')
    } else {
      await launchdLoad(ctx, record.file)
    }
  } else {
    must(ctx.run('systemctl', ['--user', 'restart', `${record.label}.service`]), 'systemctl --user restart')
  }
  return record
}

/** For `project add/remove`: restart when a service is installed, else say how to apply the change. */
export async function restartIfInstalled(deps: ServiceDeps = {}): Promise<string> {
  const ctx = ctxOf(deps)
  if (!readServiceRecord(ctx.teamHome)) {
    return 'No service installed: restart the monitor yourself to load the change (or: team-monitor service install).'
  }
  try {
    const r = await restartService(deps)
    return `Restarted ${r.label} so it loads the new project list.`
  } catch (e) {
    return `Could not restart the service: ${(e as Error).message}`
  }
}

export async function uninstallService(deps: ServiceDeps = {}, labelOverride?: string): Promise<string[]> {
  const ctx = ctxOf(deps)
  const platform = supportedPlatform(ctx.platform)
  const record = readServiceRecord(ctx.teamHome)
  const label = labelOverride ?? record?.label ?? (platform === 'darwin' ? DEFAULT_LABEL : DEFAULT_LINUX_UNIT)
  const file = record && record.label === label ? record.file : serviceFilePath(platform, label, ctx.homedir)
  const done: string[] = []
  if (platform === 'darwin') {
    if (await launchdUnload(ctx, label)) done.push(`Unloaded ${label} from launchd.`)
  } else {
    const r = ctx.run('systemctl', ['--user', 'disable', '--now', `${label}.service`])
    if (r.code === 0) done.push(`Stopped and disabled ${label}.service.`)
  }
  try { fs.unlinkSync(file); done.push(`Removed ${file}.`) } catch { /* not there */ }
  if (platform === 'linux') ctx.run('systemctl', ['--user', 'daemon-reload'])
  if (record && record.label === label) {
    try { fs.unlinkSync(serviceRecordFile(ctx.teamHome)) } catch { /* gone */ }
  }
  if (!done.length) done.push(`Nothing to remove: ${label} was not installed.`)
  return done
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  team-monitor service install [--port ${APP_DEFAULT_PORT}] [--remote --bind loopback|tailscale] [--host-allow <name>]...
                               [--tailscale-bin <path>] [--label <label>] [--workspace <path>] [--log <file>] [--ingest]
  team-monitor service status
  team-monitor service restart
  team-monitor service uninstall [--label <label>]`

export function parseInstallArgs(argv: string[]): InstallOptions | string {
  const o: InstallOptions = { port: APP_DEFAULT_PORT, remote: false, hostAllow: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    if (a === '--remote') { o.remote = true; continue }
    if (a === '--ingest') { o.ingest = true; continue }
    if (v === undefined) return `${a} needs a value`
    if (a === '--port') {
      const n = Number(v)
      if (!/^\d+$/.test(v) || n < 1 || n > 65535) return '--port must be 1-65535'
      o.port = n
    } else if (a === '--bind') o.bind = v
    else if (a === '--host-allow') o.hostAllow.push(v)
    else if (a === '--tailscale-bin') o.tailscaleBin = v
    else if (a === '--label') o.label = v
    else if (a === '--workspace') o.workspace = v
    else if (a === '--log') o.logFile = v
    else return `unknown option ${a}`
    i++
  }
  return o
}

export async function runServiceCli(argv: string[], deps: ServiceDeps = {}): Promise<number> {
  const ctx = ctxOf(deps)
  const [action, ...rest] = argv
  try {
    if (action === 'install') {
      const opts = parseInstallArgs(rest)
      if (typeof opts === 'string') { ctx.err(`${opts}\n${USAGE}`); return 2 }
      const rec = await installService(opts, deps)
      ctx.out(`Installed ${rec.label}: ${rec.file}`)
      ctx.out(`Runs: ${rec.node} ${rec.appJs} (port ${rec.port}${rec.remote ? `, remote, bind ${rec.bind}` : ''}${rec.hostAllow.length ? `, host-allow ${rec.hostAllow.join(' ')}` : ''}${rec.ingest ? ', ingest' : ''})`)
      ctx.out('Projects come from config.json (team-monitor project add <path>).')
      if (rec.platform === 'linux') {
        ctx.out('Hint: to start it at boot without a login, run once: loginctl enable-linger "$USER"')
      }
      let st: ServiceStatus | null = null
      for (let i = 0; i < 30; i++) {
        st = await serviceStatus(deps)
        if (st.health.ok) break
        await ctx.sleep(500)
      }
      const { lines, ok } = statusLines(st as ServiceStatus)
      for (const l of lines) ctx.out(l)
      if (!ok) ctx.err(`The service is installed but not healthy yet; see the log: ${rec.logFile}`)
      return ok ? 0 : 1
    }
    if (rest.length && action !== 'uninstall') { ctx.err(USAGE); return 2 }
    if (action === 'status') {
      const { lines, ok } = statusLines(await serviceStatus(deps))
      for (const l of lines) ctx.out(l)
      return ok ? 0 : 1
    }
    if (action === 'restart') {
      const rec = await restartService(deps)
      ctx.out(`Restarted ${rec.label}.`)
      return 0
    }
    if (action === 'uninstall') {
      let label: string | undefined
      if (rest.length === 2 && rest[0] === '--label') label = rest[1]
      else if (rest.length) { ctx.err(USAGE); return 2 }
      if (label !== undefined && !LABEL_RE.test(label)) { ctx.err('bad --label'); return 2 }
      for (const l of await uninstallService(deps, label)) ctx.out(l)
      return 0
    }
  } catch (e) {
    if (e instanceof ServiceError) { ctx.err(`Error: ${e.message}`); return 1 }
    throw e
  }
  ctx.err(USAGE)
  return 2
}
