/** Default port of the standalone app. The extension's DEFAULT_RELAY_PORT (3001) is left alone;
 *  the standalone UI is same-origin and hooks find instances via discovery files, so this is free to differ. */
export const APP_DEFAULT_PORT = 3002

/** Parse CLI arguments. Keeps it simple — no dependencies. */
export function parseArgs(argv: string[]) {
  let port = APP_DEFAULT_PORT
  let open = true
  let verbose = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
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
`)
      process.exit(0)
    }
  }

  return { port, open, verbose }
}
