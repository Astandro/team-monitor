/**
 * Combined HTTP server: serves the visualizer UI and streams events via SSE.
 * Reuses the extension's hook server, transcript parser, and session watcher.
 */
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { exec, execFile } from 'child_process'

import { createRelay } from '../../scripts/relay'
import { createTelemetryClient } from '../../scripts/telemetry'
import { serveStatic } from './static'
import { listenErrorMessage, TeamSetup } from './team'
import { AutoOffboarder } from './team/auto-offboard'

interface ServerOptions {
  port: number
  openBrowser: boolean
  workspace: string
  verbose?: boolean
  /** Built by app.ts before ensureSetup(), so a refused remote setup writes nothing. */
  teamSetup: TeamSetup
}

export async function startServer(options: ServerOptions) {
  const { port, openBrowser, workspace, teamSetup } = options

  const configDir = path.join(os.homedir(), '.agent-flow')
  const telemetry = createTelemetryClient({
    logDir: path.join(configDir, 'telemetry'),
    installIdPath: path.join(configDir, 'installation-id'),
  })
  await telemetry.init()

  // The graph follows the registered projects, not only the start folder (spec graph-theme item 3)
  const relay = await createRelay({
    workspace, verbose: options.verbose, telemetry,
    projects: () => teamSetup.team.graphProjects(),
    // Offboarded agents stay off the graph stream (spec offboard-names item 1)
    offboarded: teamSetup.team.offboard ?? undefined,
    autoOffboardMinutes: teamSetup.team.autoOffboardMinutes,
  })
  teamSetup.team.graph = relay.graph

  // Finished sub-agents leave the graph by themselves after autoOffboardMinutes (spec ui-cleanup item 6). The
  // first sweep runs now, before anyone connects: agents whose deadline passed while the server was down go first.
  const autoOffboard = teamSetup.team.offboard
    ? new AutoOffboarder(teamSetup.team.offboard, relay.graph, teamSetup.team.autoOffboardMinutes)
    : null
  const caughtUp = autoOffboard?.start() ?? []
  if (caughtUp.length) console.log(`Auto offboarded ${caughtUp.length} finished agent(s) whose ${teamSetup.team.autoOffboardMinutes} minutes had passed.`)

  // The team handler runs the Host check first (loopback only, as upstream, or
  // the remote allow-list), then login and /api/team/*, then this fallback.
  const server = http.createServer(teamSetup.createHandler((req, res) => {
    // SSE endpoint
    if (req.url === '/events') {
      return relay.handleSSE(req, res)
    }

    // Static files (UI)
    if (req.method === 'GET') {
      return serveStatic(req, res)
    }

    res.writeHead(404)
    res.end('Not found')
  }))

  // Port taken or address not on this machine: one plain line, no stack.
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(listenErrorMessage(err, teamSetup.listenHost, port, teamSetup.tokenFile))
    autoOffboard?.stop()
    teamSetup.dispose()
    relay.dispose()
    process.exit(1)
  })

  server.listen(port, teamSetup.listenHost, () => {
    const url = `http://${teamSetup.listenHost}:${port}`
    console.log(`Server running at ${url}`)
    if (teamSetup.remote?.config.bindMode === 'loopback') {
      const dns = teamSetup.remote.config.dnsName ?? '<machine>.ts.net'
      console.log(`Remote mode behind tailscale serve: run "tailscale serve --bg http://127.0.0.1:${port}" and open https://${dns}/login`)
      console.log(`If port 443 is already used there: "tailscale serve --bg --https=8443 http://127.0.0.1:${port}" and open https://${dns}:8443/login`)
    } else if (teamSetup.remote) {
      console.log(`Remote mode: open http://${teamSetup.remote.config.dnsName ?? teamSetup.listenHost}:${port}/login on your phone`)
    }
    console.log('Waiting for agent events...\n')

    if (openBrowser) {
      openURL(url)
    }
  })

  // Cleanup on exit. Idempotent — repeat signals (Ctrl+C spam, SIGTERM+SIGHUP,
  // etc.) would otherwise emit duplicate session_end events and race the
  // telemetry sync loop against itself.
  let shuttingDown = false
  function cleanup() {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    autoOffboard?.stop()
    teamSetup.dispose()
    relay.dispose()
    void telemetry.dispose().finally(() => process.exit(0))
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  // SIGHUP fires when the controlling terminal closes (SSH session drops, tmux
  // pane killed). Without a handler, Node's default behavior is to terminate
  // without running cleanup — so session_end never flushes.
  process.on('SIGHUP', cleanup)
}

function openURL(url: string) {
  if (process.platform === 'win32') {
    // 'start' is a shell builtin on Windows — must use exec, not execFile
    exec(`start "" "${url}"`)
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(cmd, [url], () => {})
  }
}
