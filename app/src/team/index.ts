/**
 * Wires the team monitor into the app server: project registry, state
 * watchers, and (opt-in) remote mode with token login.
 */
import type * as http from 'http'
import { LoginLimiter, loadOrCreateToken, SessionStore } from './auth'
import { buildRegistry, ensureHome, readAutoOffboardMinutes, readConfigProjects, teamHome } from './config'
import { createRequestHandler, RemoteAccess, TeamService } from './http'
import { INGEST_TOKEN_FILE, IngestService } from './ingest'
import { OffboardStore } from './offboard'
import { defaultTailscaleBin, makeTailscaleRunner, resolveRemoteConfig, TailscaleRunner } from './remote'

export interface TeamCliOptions {
  projects: string[]
  remote: boolean
  bind?: string
  hostAllow: string[]
  tailscaleBin?: string
  /** Hub intake for cloud sources (`--ingest`); off by default. */
  ingest?: boolean
  /** Started by `cloud start` (`--cloud`): with CLAUDE_CODE_REMOTE=true any Host header is accepted for GET/HEAD
   *  (still loopback only), so the cloud app's preview pane can show the UI; state-changing requests still need a
   *  loopback Host (the preview is view-only). Never with --remote or --ingest. */
  cloud?: boolean
}

export class CloudModeError extends Error {}

/** Accept any Host: only for a monitor started by cloud mode inside a cloud session. */
export function acceptsAnyHost(opts: Pick<TeamCliOptions, 'cloud' | 'remote' | 'ingest'>, env: NodeJS.ProcessEnv): boolean {
  return opts.cloud === true && !opts.remote && !opts.ingest && env.CLAUDE_CODE_REMOTE === 'true'
}

export interface TeamSetup {
  team: TeamService
  remote: RemoteAccess | null
  /** Hub intake (`--ingest`), or null when off. server.ts attaches the relay to it. */
  ingest: IngestService | null
  /** Address to listen on: 127.0.0.1, or the Tailscale IPv4 in remote mode. */
  listenHost: string
  /** Token file path when the token was created in this run, else null. */
  tokenFile: string | null
  createHandler: (fallback: (req: http.IncomingMessage, res: http.ServerResponse) => void) => http.RequestListener
  dispose: () => void
}

export interface SetupDeps {
  env?: NodeJS.ProcessEnv
  runTailscale?: TailscaleRunner
  log?: (msg: string) => void
  warn?: (msg: string) => void
  watcherTiming?: { debounceMs?: number; pollMs?: number }
}

/** Throws RemoteConfigError / TokenError with a user-facing message when remote mode cannot start safely. */
export function setupTeam(opts: TeamCliOptions, deps: SetupDeps = {}): TeamSetup {
  const env = deps.env ?? process.env
  const log = deps.log ?? console.log
  const warn = deps.warn ?? console.warn
  if (opts.cloud && (opts.remote || opts.ingest)) {
    throw new CloudModeError('--cloud (cloud mode in a container) cannot be combined with --remote or --ingest.')
  }
  const home = teamHome(env)
  ensureHome(home)
  const anyHost = acceptsAnyHost(opts, env)
  if (anyHost) log('Cloud mode: any Host header accepted for reads (GET/HEAD); state-changing requests need a loopback Host (listening on loopback only).')

  let remote: RemoteAccess | null = null
  let listenHost = '127.0.0.1'
  let tokenFile: string | null = null
  if (opts.remote) {
    const run = deps.runTailscale ?? makeTailscaleRunner(opts.tailscaleBin || defaultTailscaleBin(env))
    const config = resolveRemoteConfig({ bind: opts.bind, hostAllow: opts.hostAllow, run, warn })
    const tok = loadOrCreateToken(home)
    // Never printed: under the service stdout goes into the log file. The file is the only place it is kept.
    if (tok.created) {
      log(`Remote access token created in ${tok.file} (0600). Read it from that file on this machine, open /login on your phone and paste it.\n`)
    }
    const sessions = new SessionStore(home, tok.token)
    if (sessions.droppedForNewToken > 0) {
      log(`The access token changed: ${sessions.droppedForNewToken} old login session(s) ended. Log in again on each device.`)
    }
    remote = { config, token: tok.token, sessions, limiter: new LoginLimiter() }
    if (tok.created) tokenFile = tok.file
    listenHost = config.bindAddress
  } else if (opts.bind || opts.hostAllow.length) {
    warn('[team] --bind and --host-allow only apply with --remote; ignored.')
  }

  const projects = buildRegistry(readConfigProjects(home, warn), opts.projects)
  const team = new TeamService(projects, deps.watcherTiming)
  team.offboard = new OffboardStore(home, warn)
  team.autoOffboardMinutes = readAutoOffboardMinutes(home, warn)
  if (projects.length) log(`Team projects: ${projects.map((p) => p.id).join(', ')}`)

  let ingest: IngestService | null = null
  if (opts.ingest) {
    const tok = loadOrCreateToken(home, INGEST_TOKEN_FILE)
    // Never printed: only where it is.
    if (tok.created) {
      log(`Ingest token for cloud sources created in ${tok.file} (0600). Save its content as the network secret of the cloud environment.\n`)
    }
    const service = new IngestService({ home, token: tok.token, team, log: warn })
    const { removed, restored } = service.start()
    if (removed.length) log(`Removed ${removed.length} cloud mirror(s) idle for more than 24 hours (or beyond the source cap): ${removed.join(', ')}`)
    if (restored.length) log(`Cloud sources (stale until they report): ${restored.join(', ')}`)
    log('Hub intake on: /api/ingest/v1/* (ingest token required).')
    team.onDispose(() => service.dispose())
    ingest = service
  }

  return {
    team,
    remote,
    ingest,
    listenHost,
    tokenFile,
    createHandler: (fallback) => createRequestHandler({ team, remote, fallback, ingest, anyHost }),
    dispose: () => team.dispose(),
  }
}

/**
 * One plain line for a failed listen (no stack). When the token was created in
 * this run, say where it is: it was printed once and the file is kept.
 */
export function listenErrorMessage(err: NodeJS.ErrnoException, host: string, port: number, tokenFile: string | null): string {
  let msg: string
  if (err.code === 'EADDRINUSE') msg = `Cannot start: port ${port} on ${host} is already in use. Stop the other process or pass --port <number>.`
  else if (err.code === 'EADDRNOTAVAIL') msg = `Cannot start: address ${host} is not on this machine. Is Tailscale up?`
  else if (err.code === 'EACCES') msg = `Cannot start: no permission to listen on ${host}:${port}.`
  else msg = `Cannot start: cannot listen on ${host}:${port} (${err.code ?? err.message}).`
  if (tokenFile) msg += `\nThe new access token is kept in ${tokenFile} (it is never printed).`
  return msg
}
