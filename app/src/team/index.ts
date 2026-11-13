/**
 * Wires the team monitor into the app server: project registry, state
 * watchers, and (opt-in) remote mode with token login.
 */
import type * as http from 'http'
import { LoginLimiter, loadOrCreateToken, SessionStore } from './auth'
import { buildRegistry, ensureHome, readConfigProjects, teamHome } from './config'
import { createRequestHandler, RemoteAccess, TeamService } from './http'
import { defaultTailscaleBin, makeTailscaleRunner, resolveRemoteConfig, TailscaleRunner } from './remote'

export interface TeamCliOptions {
  projects: string[]
  remote: boolean
  bind?: string
  hostAllow: string[]
  tailscaleBin?: string
}

export interface TeamSetup {
  team: TeamService
  remote: RemoteAccess | null
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
  const home = teamHome(env)
  ensureHome(home)

  let remote: RemoteAccess | null = null
  let listenHost = '127.0.0.1'
  let tokenFile: string | null = null
  if (opts.remote) {
    const run = deps.runTailscale ?? makeTailscaleRunner(opts.tailscaleBin || defaultTailscaleBin(env))
    const config = resolveRemoteConfig({ bind: opts.bind, hostAllow: opts.hostAllow, run, warn })
    const tok = loadOrCreateToken(home)
    if (tok.created) {
      log(`Remote access token (shown only this once, saved in ${tok.file}):\n\n  ${tok.token}\n`)
      log('Open /login on your phone and paste it. To see it again later, read that file on this machine.\n')
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
  if (projects.length) log(`Team projects: ${projects.map((p) => p.id).join(', ')}`)

  return {
    team,
    remote,
    listenHost,
    tokenFile,
    createHandler: (fallback) => createRequestHandler({ team, remote, fallback }),
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
  if (tokenFile) msg += `\nThe new access token is kept in ${tokenFile}; it is not printed again.`
  return msg
}
