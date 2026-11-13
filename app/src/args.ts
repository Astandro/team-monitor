import type { TeamCliOptions } from './team'

/** Default port of the standalone app. The extension's DEFAULT_RELAY_PORT (3001) is left alone;
 *  the standalone UI is same-origin and hooks find instances via discovery files, so this is free to differ. */
export const APP_DEFAULT_PORT = 3002

/** Parse CLI arguments. Keeps it simple — no dependencies. */
export function parseArgs(argv: string[]) {
  let port = APP_DEFAULT_PORT
  let open = true
  let verbose = false
  const team: TeamCliOptions = { projects: [], remote: false, hostAllow: [] }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (parseTeamArg(arg, argv[i + 1], team)) {
      if (arg !== '--remote') i++
    } else if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10)
      if (!isNaN(n) && n > 0 && n < 65536) port = n
      i++
    } else if (arg === '--no-open') {
      open = false
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: team-monitor [options]

Options:
  -p, --port <number>  Port for the server (default: ${APP_DEFAULT_PORT})
  --no-open            Don't open the browser automatically
  -v, --verbose        Show detailed event logs
  -h, --help           Show this help message

Team monitor:
  --project <path>     Watch <path>/.agent-team (repeatable; also ~/.team-monitor/config.json)
  --remote             Remote (Tailscale) mode: token login required
  --bind <mode>        With --remote: "tailscale" (Tailscale IPv4) or "loopback" (behind tailscale serve)
  --host-allow <name>  With --remote: extra accepted Host name (repeatable)
  --tailscale-bin <p>  Path to the tailscale CLI
  wait-answer ...      Wait for a decision answer or a chat message (see docs/coordinator.md)
  ask ...              Add an open decision D<n> to state.json, optionally --wait for it

Setup (see docs/setup.md):
  project add <path> [--name <n>] | project remove <id> | project list
  service install [--port <n>] [--remote --bind loopback] [--host-allow <name>] | service status|restart|uninstall
  doctor               Check build, service, projects, tailscale serve, token, hooks (exit 0 = all good)
`)
      process.exit(0)
    }
  }

  return { port, open, verbose, team }
}

/** Team monitor flags. True when `arg` was one of them (`next` is consumed, except for --remote). */
export function parseTeamArg(arg: string, next: string | undefined, team: TeamCliOptions): boolean {
  if (arg === '--remote') { team.remote = true; return true }
  if (next === undefined) return false
  if (arg === '--project') { team.projects.push(next); return true }
  if (arg === '--bind') { team.bind = next; return true }
  if (arg === '--host-allow') { team.hostAllow.push(next); return true }
  if (arg === '--tailscale-bin') { team.tailscaleBin = next; return true }
  return false
}
