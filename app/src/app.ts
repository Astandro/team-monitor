/**
 * Team Monitor — standalone web app for visualizing AI agent orchestration.
 *
 * Starts a local server that:
 *   1. Receives events from agent hooks
 *   2. Watches JSONL transcript files for active sessions
 *   3. Serves the visualizer UI and streams events via SSE
 *   4. Opens the browser automatically
 *
 * Usage: team-monitor [--port <number>] [--no-open]
 */
import { parseArgs } from './args'
import { ensureSetup } from '../../scripts/setup'
import { startServer } from './server'
import { setupTeam, TeamSetup } from './team'
import { runWaitAnswerCli } from './team/wait-answer'

if (process.argv[2] === 'wait-answer') {
  // Coordinator helper: no hooks setup, no server.
  runWaitAnswerCli(process.argv.slice(3)).then(
    (code) => process.exit(code),
    (e) => { console.error(e); process.exit(2) },
  )
} else {
  const args = parseArgs(process.argv.slice(2))

  console.log('Team Monitor\n')

  // Team monitor first: a refused remote setup (unsafe --bind, bad token file)
  // must stop before ensureSetup() writes hooks or anything listens.
  let teamSetup: TeamSetup
  try {
    teamSetup = setupTeam(args.team)
  } catch (e) {
    console.error(`Cannot start: ${(e as Error).message}`)
    process.exit(1)
  }

  // Ensure hooks are configured
  ensureSetup()

  // Start the server
  startServer({
    port: args.port,
    openBrowser: args.open,
    workspace: process.cwd(),
    verbose: args.verbose,
    teamSetup,
  })
}
