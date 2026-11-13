/**
 * Cloud mode (spec cloud section B): the monitor and the forwarder inside a Claude Code cloud container.
 *
 *   team-monitor cloud start [--project <path>] [--port <n>]   register the project, start the monitor (and the
 *                                                             forwarder when TEAM_MONITOR_HUB_URL is set), detached
 *   team-monitor cloud status [--port <n>]                    monitor health, hub, last successful post
 *   team-monitor cloud stop                                   stop the forwarder and the monitor started here
 *   team-monitor cloud forward --project <path> --port <n>    the forwarder itself (started by `cloud start`)
 *
 * `cloud start` runs from a SessionStart hook: it returns within 5 s, always exits 0 and prints one line. The
 * monitor and the forwarder run in their own session with stdio on log files in `<home>/cloud/` (0600), so they
 * never hold the hook's pipes open. Pid files (`monitor.json`, `forwarder.json`) plus a health check keep one of
 * each; a stale pid file (dead process, or a pid now used by another program) is replaced. A start lock serialises
 * two `cloud start` runs.
 */
import { spawn } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { APP_DEFAULT_PORT } from '../args'
import { ensureHome, expandHome, teamHome } from './config'
import { CLOUD_DIR, cloudDir, ensureCloudDir, Forwarder, ForwarderStatus, hubOrigin, MONITOR_FILE, STATUS_FILE } from './cloud-forwarder'
import { isPidAlive } from './heartbeat'
import { addProject } from './projects'
import { writeFileAtomic } from './service'

export const FORWARDER_FILE = 'forwarder.json'
export const SOURCE_ID_FILE = 'source-id'
export const MONITOR_LOG = 'monitor.log'
export const FORWARDER_LOG = 'forwarder.log'
const LOCK_FILE = 'start.lock'
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_LOG_BYTES = 5 * 1024 * 1024
/** `cloud start` answers within this (the spec allows 5 s). */
const START_BUDGET_MS = 4000

export { CLOUD_DIR }

// ─── Source id ──────────────────────────────────────────────────────────────

/** The cloud session id lowercased and reduced to the hub's sourceId pattern, or null when nothing is left. */
export function sourceIdFromSession(raw: string | undefined): string | null {
  if (!raw) return null
  const id = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64)
  return SOURCE_ID_RE.test(id) ? id : null
}

/** sourceId: from CLAUDE_CODE_REMOTE_SESSION_ID, else a random id kept in `<home>/cloud/source-id`. */
export function resolveSourceId(env: NodeJS.ProcessEnv, home: string): string {
  const fromEnv = sourceIdFromSession(env.CLAUDE_CODE_REMOTE_SESSION_ID)
  if (fromEnv) return fromEnv
  const file = path.join(ensureCloudDir(home), SOURCE_ID_FILE)
  try {
    const stored = fs.readFileSync(file, 'utf-8').trim()
    if (SOURCE_ID_RE.test(stored)) return stored
  } catch { /* first time */ }
  const id = `src-${crypto.randomBytes(8).toString('hex')}`
  writeFileAtomic(file, id + '\n', 0o600)
  return id
}

// ─── Pid files and processes ────────────────────────────────────────────────

export interface PidRecord { pid: number; startedAt: string; port: number; project?: string }

export function readPidFile(file: string): PidRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<PidRecord>
    if (typeof r.pid === 'number' && Number.isSafeInteger(r.pid) && r.pid > 0 && typeof r.startedAt === 'string' && typeof r.port === 'number') {
      return { pid: r.pid, startedAt: r.startedAt, port: r.port, ...(typeof r.project === 'string' ? { project: r.project } : {}) }
    }
  } catch { /* missing or broken */ }
  return null
}

/**
 * Is `pid` alive and one of ours? On Linux its command line must contain all of `marks` (a reused pid of another
 * program does not count). Where /proc is missing (macOS), alive is enough.
 */
export function isOurProcess(pid: number, marks: string[]): boolean {
  if (!isPidAlive(pid)) return false
  let cmdline: string
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
  } catch {
    return !fs.existsSync('/proc/self')
  }
  const args = cmdline.split('\0')
  return marks.every((m) => args.includes(m))
}

const MONITOR_MARKS = ['--cloud']
const FORWARDER_MARKS = ['cloud', 'forward']

/** GET /api/team/projects on loopback answers 200 with a project list. */
export function monitorHealthy(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/team/projects', method: 'GET', timeout: timeoutMs, agent: false,
      headers: { Host: `127.0.0.1:${port}`, Accept: 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => { if (chunks.length < 64) chunks.push(c) })
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { projects?: unknown }
          resolve(res.statusCode === 200 && Array.isArray(body.projects))
        } catch { resolve(false) }
      })
      res.on('error', () => resolve(false))
    })
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', () => resolve(false))
    req.end()
  })
}

/** Open a log file for a detached child (0600, append; rotated once at 5 MB). */
function openLog(file: string): number {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`)
  } catch { /* none yet */ }
  const fd = fs.openSync(file, 'a', 0o600)
  try { fs.fchmodSync(fd, 0o600) } catch { /* best effort */ }
  return fd
}

export interface CloudDeps {
  env?: NodeJS.ProcessEnv
  cwd?: string
  out?: (msg: string) => void
  err?: (msg: string) => void
  execPath?: string
  /** Node flags to repeat for the children (e.g. `--import tsx` when run from source). */
  execArgv?: string[]
  /** The app entry the children run (the bundle's app.js). */
  appEntry?: string
  sleep?: (ms: number) => Promise<void>
}

interface Ctx {
  env: NodeJS.ProcessEnv
  cwd: string
  out: (msg: string) => void
  err: (msg: string) => void
  execPath: string
  execArgv: string[]
  appEntry: string
  sleep: (ms: number) => Promise<void>
  home: string
}

function ctxOf(deps: CloudDeps): Ctx {
  const env = deps.env ?? process.env
  return {
    env,
    cwd: deps.cwd ?? process.cwd(),
    out: deps.out ?? console.log,
    err: deps.err ?? console.error,
    execPath: deps.execPath ?? process.execPath,
    execArgv: deps.execArgv ?? process.execArgv,
    appEntry: deps.appEntry ?? process.argv[1],
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    home: teamHome(env),
  }
}

/** Start `args` of the app fully detached: own session, no stdin, stdout and stderr on `logFile`. */
function spawnDetached(ctx: Ctx, args: string[], logFile: string, cwd: string): number {
  const fd = openLog(logFile)
  try {
    const child = spawn(ctx.execPath, [...ctx.execArgv, ctx.appEntry, ...args], {
      detached: true, stdio: ['ignore', fd, fd], cwd, env: ctx.env,
    })
    child.unref()
    if (!child.pid) throw new Error('the process did not start')
    return child.pid
  } finally {
    fs.closeSync(fd)
  }
}

/** A lock file held while one `cloud start` checks and starts processes; null when another holds it too long. */
async function acquireLock(ctx: Ctx, deadline: number): Promise<(() => void) | null> {
  const file = path.join(cloudDir(ctx.home), LOCK_FILE)
  const me = String(process.pid)
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600)
      fs.writeSync(fd, me)
      fs.closeSync(fd)
      return () => { try { if (fs.readFileSync(file, 'utf-8') === me) fs.unlinkSync(file) } catch { /* gone */ } }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let stale = false
    try {
      const pid = Number(fs.readFileSync(file, 'utf-8'))
      stale = !(pid > 0 && isPidAlive(pid)) || Date.now() - fs.statSync(file).mtimeMs > 15_000
    } catch { continue /* released meanwhile */ }
    if (stale) { try { fs.unlinkSync(file) } catch { /* someone else did */ } ; continue }
    if (Date.now() > deadline) return null
    await ctx.sleep(100)
  }
}

function parsePort(v: string | undefined): number | null {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

interface CommonArgs { project: string; port: number }

function parseCommon(argv: string[], ctx: Ctx): CommonArgs | string {
  let project = ctx.cwd
  let port = APP_DEFAULT_PORT
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--project' && next !== undefined) { project = path.resolve(ctx.cwd, expandHome(next)); i++ }
    else if (a === '--port' && next !== undefined) {
      const p = parsePort(next)
      if (p === null) return `--port must be a number from 1 to 65535`
      port = p; i++
    } else return `unknown argument ${a}`
  }
  return { project, port }
}

/** The hub URL from TEAM_MONITOR_HUB_URL (http or https), null when unset; throws when it is not a URL. */
export function hubUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  const raw = env.TEAM_MONITOR_HUB_URL?.trim()
  if (!raw) return null
  let u: URL
  try { u = new URL(raw) } catch { throw new Error('TEAM_MONITOR_HUB_URL is not a URL') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('TEAM_MONITOR_HUB_URL must start with https://')
  if (u.username || u.password) throw new Error('TEAM_MONITOR_HUB_URL must not contain a user name or password')
  return raw
}

// ─── cloud start ────────────────────────────────────────────────────────────

export async function cloudStart(argv: string[], deps: CloudDeps = {}): Promise<number> {
  const ctx = ctxOf(deps)
  const t0 = Date.now()
  const say = (msg: string) => ctx.out(`team-monitor: ${msg}`)
  try {
    const args = parseCommon(argv, ctx)
    if (typeof args === 'string') { say(`cloud start not run: ${args}`); return 0 }
    ensureHome(ctx.home)
    const dir = ensureCloudDir(ctx.home)
    let hubUrl: string | null = null
    let hubProblem: string | null = null
    try { hubUrl = hubUrlFromEnv(ctx.env) } catch (e) { hubProblem = (e as Error).message }

    const release = await acquireLock(ctx, t0 + 1000)
    if (!release) { say('another cloud start is running; nothing done'); return 0 }
    try {
      const project = addProject(ctx.home, args.project, undefined, ctx.cwd).project
      const url = `http://127.0.0.1:${args.port}`

      // Monitor: keep a healthy one, wait for one of ours that is starting, else start one.
      const monitorFile = path.join(dir, MONITOR_FILE)
      let monitor: string
      if (await monitorHealthy(args.port)) {
        monitor = `monitor running on ${url}`
      } else {
        const rec = readPidFile(monitorFile)
        let pid: number
        if (rec && rec.port === args.port && isOurProcess(rec.pid, MONITOR_MARKS)) {
          pid = rec.pid
          monitor = `monitor starting on ${url}`
        } else {
          pid = spawnDetached(ctx, ['--cloud', '--no-open', '--port', String(args.port)], path.join(dir, MONITOR_LOG), project.path)
          writeFileAtomic(monitorFile, JSON.stringify({ pid, startedAt: new Date().toISOString(), port: args.port, project: project.path }) + '\n', 0o600)
          monitor = `monitor started on ${url}`
        }
        let healthy = false
        while (Date.now() - t0 < START_BUDGET_MS - 1200) {
          await ctx.sleep(150)
          if (await monitorHealthy(args.port, 500)) { healthy = true; break }
          if (!isPidAlive(pid)) break
        }
        if (!healthy) {
          monitor = isPidAlive(pid)
            ? `monitor still starting on ${url} (log: ${path.join(dir, MONITOR_LOG)})`
            : `monitor did not start (log: ${path.join(dir, MONITOR_LOG)})`
        }
      }

      // Forwarder: only with a hub URL; one per home.
      let forwarder: string
      if (hubProblem) {
        forwarder = `no forwarder: ${hubProblem}`
      } else if (!hubUrl) {
        forwarder = 'no hub (TEAM_MONITOR_HUB_URL not set)'
      } else {
        const fwdFile = path.join(dir, FORWARDER_FILE)
        const rec = readPidFile(fwdFile)
        if (rec && isOurProcess(rec.pid, FORWARDER_MARKS)) {
          forwarder = `forwarder running to ${hubOrigin(hubUrl)}`
        } else {
          const pid = spawnDetached(ctx, ['cloud', 'forward', '--project', project.path, '--port', String(args.port)], path.join(dir, FORWARDER_LOG), project.path)
          writeFileAtomic(fwdFile, JSON.stringify({ pid, startedAt: new Date().toISOString(), port: args.port, project: project.path }) + '\n', 0o600)
          forwarder = `forwarder started to ${hubOrigin(hubUrl)}`
        }
      }
      say(`cloud mode, project ${project.id}: ${monitor}; ${forwarder}`)
    } finally {
      release()
    }
  } catch (e) {
    say(`cloud start failed: ${String((e as Error)?.message ?? e).split('\n')[0]}`)
  }
  return 0
}

// ─── cloud forward (the forwarder process) ──────────────────────────────────

export async function cloudForward(argv: string[], deps: CloudDeps = {}): Promise<number> {
  const ctx = ctxOf(deps)
  const args = parseCommon(argv, ctx)
  if (typeof args === 'string') { ctx.err(`cloud forward: ${args}`); return 2 }
  const hubUrl = hubUrlFromEnv(ctx.env)
  if (!hubUrl) { ctx.err('cloud forward: TEAM_MONITOR_HUB_URL is not set'); return 2 }
  ensureHome(ctx.home)
  const dir = ensureCloudDir(ctx.home)
  const fwdFile = path.join(dir, FORWARDER_FILE)
  const rec = readPidFile(fwdFile)
  if (rec && rec.pid !== process.pid && isOurProcess(rec.pid, FORWARDER_MARKS)) {
    ctx.out(`forwarder already running (pid ${rec.pid}); exiting`)
    return 0
  }
  writeFileAtomic(fwdFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port: args.port, project: args.project }) + '\n', 0o600)

  const project = addProject(ctx.home, args.project, undefined, ctx.cwd).project
  const sourceId = resolveSourceId(ctx.env, ctx.home)
  const fwd = new Forwarder({
    home: ctx.home, projectPath: project.path, project: { id: project.id, name: project.name },
    monitorPort: args.port, hubUrl, sourceId, env: ctx.env,
  })
  fwd.start()
  ctx.out(`${new Date().toISOString()} [forwarder] pid ${process.pid}: monitor 127.0.0.1:${args.port} -> ${hubOrigin(hubUrl)} as source ${sourceId}, project ${project.id}`)

  return new Promise<number>((resolve) => {
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void fwd.stop().finally(() => {
        const cur = readPidFile(fwdFile)
        if (cur?.pid === process.pid) { try { fs.unlinkSync(fwdFile) } catch { /* gone */ } }
        resolve(0)
      })
    }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
    process.on('SIGHUP', stop)
  })
}

// ─── cloud status / stop ────────────────────────────────────────────────────

export async function cloudStatus(argv: string[], deps: CloudDeps = {}): Promise<number> {
  const ctx = ctxOf(deps)
  const dir = cloudDir(ctx.home)
  const monRec = readPidFile(path.join(dir, MONITOR_FILE))
  const portArg = parseCommon(argv, ctx)
  const port = typeof portArg === 'string' ? APP_DEFAULT_PORT : (argv.includes('--port') ? portArg.port : monRec?.port ?? portArg.port)
  const healthy = await monitorHealthy(port)
  ctx.out(`Monitor: ${healthy ? 'healthy' : 'not answering'} on http://127.0.0.1:${port}${monRec && isOurProcess(monRec.pid, MONITOR_MARKS) ? ` (pid ${monRec.pid})` : ''}`)
  let hub: string | null = null
  try { hub = hubUrlFromEnv(ctx.env) } catch (e) { ctx.out(`Hub: ${(e as Error).message}`) }
  ctx.out(`Hub: ${hub ? hubOrigin(hub) : 'none (TEAM_MONITOR_HUB_URL not set)'}`)
  const fwdRec = readPidFile(path.join(dir, FORWARDER_FILE))
  const fwdUp = !!fwdRec && isOurProcess(fwdRec.pid, FORWARDER_MARKS)
  ctx.out(`Forwarder: ${fwdUp ? `running (pid ${fwdRec!.pid})` : 'not running'}`)
  let st: Partial<ForwarderStatus> = {}
  try { st = JSON.parse(fs.readFileSync(path.join(dir, STATUS_FILE), 'utf-8')) as ForwarderStatus } catch { /* never ran */ }
  if (st.sourceId) ctx.out(`Source: ${st.sourceId}`)
  ctx.out(`Last successful post: ${st.lastPostAt ?? 'never'}`)
  if (typeof st.queued === 'number') ctx.out(`Unsent: ${st.queued}${st.dropped ? `, dropped so far: ${st.dropped}` : ''}`)
  if (st.lastError) ctx.out(`Last error: ${st.lastError}`)
  return healthy ? 0 : 1
}

async function stopProcess(ctx: Ctx, file: string, marks: string[], what: string): Promise<string> {
  const rec = readPidFile(file)
  if (!rec || !isOurProcess(rec.pid, marks)) {
    try { fs.unlinkSync(file) } catch { /* none */ }
    return `${what}: not running`
  }
  try { process.kill(rec.pid, 'SIGTERM') } catch { /* gone */ }
  const end = Date.now() + 3000
  while (Date.now() < end && isPidAlive(rec.pid)) await ctx.sleep(100)
  let how = 'stopped'
  if (isPidAlive(rec.pid)) {
    try { process.kill(rec.pid, 'SIGKILL') } catch { /* gone */ }
    how = 'killed'
  }
  try { fs.unlinkSync(file) } catch { /* removed by the process */ }
  return `${what}: ${how} (pid ${rec.pid})`
}

export async function cloudStop(_argv: string[], deps: CloudDeps = {}): Promise<number> {
  const ctx = ctxOf(deps)
  const dir = cloudDir(ctx.home)
  ctx.out(await stopProcess(ctx, path.join(dir, FORWARDER_FILE), FORWARDER_MARKS, 'Forwarder'))
  ctx.out(await stopProcess(ctx, path.join(dir, MONITOR_FILE), MONITOR_MARKS, 'Monitor'))
  return 0
}

const USAGE = `Usage:
  team-monitor cloud start [--project <path>] [--port <n>]
  team-monitor cloud status [--port <n>]
  team-monitor cloud stop`

export async function runCloudCli(argv: string[], deps: CloudDeps = {}): Promise<number> {
  const [action, ...rest] = argv
  if (action === 'start') return cloudStart(rest, deps)
  if (action === 'forward') return cloudForward(rest, deps)
  if (action === 'status') return cloudStatus(rest, deps)
  if (action === 'stop') return cloudStop(rest, deps)
  ;(deps.err ?? console.error)(USAGE)
  return 2
}
