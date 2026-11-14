/**
 * `team-monitor logout-all`: end every login session of the monitor (remote mode, also `--public-ui`).
 *
 * Works for a running or a stopped monitor and needs no restart: it empties `<home>/sessions.json` (keeping its
 * token binding); a running monitor notices that the file changed at its next session check (SessionStore.sync) and
 * drops every session it held, so the next request of any device goes to the login. Open event streams of those
 * sessions are closed by the session sweep (within a minute). The token is not changed: to make the old token
 * useless too, replace the token file and restart (docs/setup.md).
 */
import { logoutAll } from './auth'
import { teamHome } from './config'

export interface LogoutAllDeps {
  env?: NodeJS.ProcessEnv
  out?: (msg: string) => void
  err?: (msg: string) => void
}

export async function runLogoutAllCli(argv: string[], deps: LogoutAllDeps = {}): Promise<number> {
  const out = deps.out ?? console.log
  const err = deps.err ?? console.error
  if (argv.length) { err('Usage: team-monitor logout-all'); return 2 }
  const home = teamHome(deps.env ?? process.env)
  let stored: number | null
  try {
    stored = logoutAll(home)
  } catch (e) {
    err(`Cannot end the login sessions: ${(e as Error).message}`)
    return 1
  }
  if (stored === null) {
    out(`No login sessions stored in ${home}; nothing to end.`)
    return 0
  }
  out(`Ended ${stored} login session(s). A running monitor drops them at the next request (no restart needed); every device must log in again.`)
  return 0
}
