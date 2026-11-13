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
import { setupTeam, TeamCliOptions, TeamSetup } from './team'

interface ServerOptions {
  port: number
  openBrowser: boolean
  workspace: string
  verbose?: boolean
  team?: TeamCliOptions
}

export async function startServer(options: ServerOptions) {
  const { port, openBrowser, workspace } = options

  // Team monitor first: a refused remote setup must stop before anything starts.
  let teamSetup: TeamSetup
  try {
    teamSetup = setupTeam(options.team ?? { projects: [], remote: false, hostAllow: [] })
  } catch (e) {
    console.error(`Cannot start: ${(e as Error).message}`)
    process.exit(1)
  }

  const configDir = path.join(os.homedir(), '.agent-flow')
  const telemetry = createTelemetryClient({
    logDir: path.join(configDir, 'telemetry'),
    installIdPath: path.join(configDir, 'installation-id'),
  })
  await telemetry.init()

  const relay = await createRelay({ workspace, verbose: options.verbose, telemetry })

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

  server.listen(port, teamSetup.listenHost, () => {
    const url = `http://${teamSetup.listenHost}:${port}`
    console.log(`Server running at ${url}`)
    if (teamSetup.remote?.config.bindMode === 'loopback') {
      console.log(`Remote mode behind tailscale serve: run "tailscale serve --bg ${port}" and open https://${teamSetup.remote.config.dnsName ?? '<machine>.ts.net'}/login`)
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
