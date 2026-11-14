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
import {
  foregroundStop, funnelEntries, funnelOffCommand, tcpFunnelOffCommand, tcpFunnels, tcpWhere, unexpectedFunnelExposure,
} from './doctor'
import {
  AsyncTailscaleRunner, defaultTailscaleBin, makeAsyncTailscaleRunner, makeTailscaleRunner, PUBLIC_UI_NEEDS,
  publicUiFunnelCommand, resolveRemoteConfig, TailscaleRunner,
} from './remote'

export { PUBLIC_UI_NEEDS, publicUiFunnelCommand }

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
  /** Public UI through Tailscale Funnel (`--public-ui`, Addendum G): only with `--remote --bind loopback`. The
   *  server behaves as in remote mode (login for everything but /login, /logout and the ingest routes); in addition
   *  the login limiter keys on the Funnel client address (publicClientKey) and logins are logged. Off by default. */
  publicUi?: boolean
}

export class CloudModeError extends Error {}
export class PublicUiError extends Error {}

/** Refuse `--public-ui` unless it comes with `--remote --bind loopback` (and not with `--cloud`). */
export function checkPublicUi(opts: Pick<TeamCliOptions, 'publicUi' | 'remote' | 'bind' | 'cloud'>): void {
  if (!opts.publicUi) return
  if (!opts.remote || (opts.bind ?? '').trim() !== 'loopback' || opts.cloud) throw new PublicUiError(PUBLIC_UI_NEEDS)
}

/** Start-up lines about where the UI can be reached in remote mode (printed by server.ts once listening). */
export function remoteBannerLines(remote: RemoteAccess | null, port: number, publicUi: boolean): string[] {
  if (!remote) return []
  if (publicUi) {
    const dns = remote.config.dnsName ?? '<machine>.<tailnet>.ts.net'
    return [
      'PUBLIC UI: this monitor is meant to be reachable from the INTERNET through Tailscale Funnel. Anyone with the',
      'access token can log in and see, answer, chat and offboard. Rotate the token file or run "logout-all" to end sessions.',
      `Funnel: run "${publicUiFunnelCommand(port)}" and open https://${dns}/login`,
      `On this machine too, log in through https://${dns}/login (Funnel or tailnet URL): http://127.0.0.1:${port} has no`,
      'client address, so every request there needs a login and its login is refused.',
    ]
  }
  if (remote.config.bindMode === 'loopback') {
    const dns = remote.config.dnsName ?? '<machine>.ts.net'
    return [
      `Remote mode behind tailscale serve: run "tailscale serve --bg http://127.0.0.1:${port}" and open https://${dns}/login`,
      `If port 443 is already used there: "tailscale serve --bg --https=8443 http://127.0.0.1:${port}" and open https://${dns}:8443/login`,
    ]
  }
  return [`Remote mode: open http://${remote.config.dnsName ?? remote.config.bindAddress}:${port}/login on your phone`]
}

/**
 * Start-up Funnel check of a monitor WITHOUT --public-ui (P-02/P-03): best effort (`tailscale serve status --json`,
 * short timeout); no binary, an error or unreadable output give no lines and never stop the start. When a Funnel
 * host:port (background or foreground) reaches this monitor on paths its flags do not allow (with --ingest: anything
 * but /api/ingest), or a TCP Funnel forwards to its port (in every mode, --public-ui included: raw TCP looks local),
 * the warning lines for the log and banner.
 */
export async function funnelStartWarning(
  port: number,
  flags: { publicUi?: boolean; ingest?: boolean },
  run: AsyncTailscaleRunner,
  bin = 'tailscale',
): Promise<string[]> {
  let json: string
  try { json = await run(['serve', 'status', '--json']) } catch { return [] }
  const exposed = flags.publicUi ? [] : unexpectedFunnelExposure(funnelEntries(json, port), flags)
  const tcp = tcpFunnels(json, port)
  if (!exposed.length && !tcp.length) return []
  const lines = ['', '!!! WARNING: this monitor is REACHABLE FROM THE INTERNET through Tailscale Funnel !!!']
  if (exposed.length) {
    const where = exposed.map((x) => `${x.paths.join(', ')} on ${x.hostPort}${x.foreground ? ' (foreground)' : ''}`).join('; ')
    lines.push(`!!! Funnel maps ${where} to 127.0.0.1:${port}, but the monitor was not started with --public-ui.`)
  }
  for (const t of tcp) {
    lines.push(`!!! Funnel forwards raw TCP on ${tcpWhere(t)} to ${t.target}${t.tls ? ' (TLS terminated)' : ''}${t.foreground ? ' (foreground)' : ''}: no forwarded headers, so requests from the internet look like requests made on this machine.`)
  }
  const cmds = [
    ...exposed.flatMap((x) => x.foreground ? [foregroundStop(bin)] : x.paths.map((m) => funnelOffCommand(x.hostPort, m, bin))),
    ...tcp.map((t) => t.foreground ? foregroundStop(bin) : tcpFunnelOffCommand(t, bin)),
  ]
  lines.push(`!!! Turn it off: ${[...new Set(cmds)].join(' ; ')}`)
  if (exposed.length) lines.push('!!! (or, if a public UI is intended, run with --remote --bind loopback --public-ui). Check with: team-monitor doctor')
  if (tcp.length) lines.push(`!!! Never use a TCP Funnel (--tcp, --tls-terminated-tcp) for the monitor.${exposed.length ? '' : ' Check with: team-monitor doctor'}`)
  lines.push('')
  return lines
}

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
  /** `--public-ui` is on (remote mode behind Funnel). */
  publicUi: boolean
  /** Cloud mode in a container (preview pane): the UI may be framed, so the static headers omit the framing ban. */
  frameable: boolean
  /** Start-up Funnel check (funnelStartWarning) for this monitor's flags: warning lines, or none. Never throws. */
  funnelWarning: (port: number) => Promise<string[]>
  createHandler: (fallback: (req: http.IncomingMessage, res: http.ServerResponse) => void) => http.RequestListener
  dispose: () => void
}

export interface SetupDeps {
  env?: NodeJS.ProcessEnv
  runTailscale?: TailscaleRunner
  log?: (msg: string) => void
  warn?: (msg: string) => void
  watcherTiming?: { debounceMs?: number; pollMs?: number }
  /** Server-side log of the request handler (login lines, error details); default console.error. */
  handlerLog?: (msg: string) => void
  /** Async tailscale CLI for the start-up Funnel check (injected in tests). */
  runTailscaleAsync?: AsyncTailscaleRunner
}

/** Throws RemoteConfigError / TokenError with a user-facing message when remote mode cannot start safely. */
export function setupTeam(opts: TeamCliOptions, deps: SetupDeps = {}): TeamSetup {
  const env = deps.env ?? process.env
  const log = deps.log ?? console.log
  const warn = deps.warn ?? console.warn
  if (opts.cloud && (opts.remote || opts.ingest)) {
    throw new CloudModeError('--cloud (cloud mode in a container) cannot be combined with --remote or --ingest.')
  }
  checkPublicUi(opts)
  const publicUi = opts.publicUi === true
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
  if (publicUi) log('Public UI on (--public-ui): login, UI and API are meant to be reachable from the internet through Tailscale Funnel.')

  return {
    team,
    remote,
    ingest,
    listenHost,
    tokenFile,
    publicUi,
    frameable: anyHost,
    funnelWarning: (port) => {
      const bin = opts.tailscaleBin || defaultTailscaleBin(env)
      const run = deps.runTailscaleAsync ?? makeAsyncTailscaleRunner(bin)
      return funnelStartWarning(port, { publicUi, ingest: opts.ingest === true }, run, bin).catch(() => [])
    },
    createHandler: (fallback) => createRequestHandler({ team, remote, fallback, ingest, anyHost, publicUi, ...(deps.handlerLog ? { log: deps.handlerLog } : {}) }),
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
