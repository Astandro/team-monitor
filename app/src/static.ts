/**
 * Static file server for the pre-built webview assets.
 * Serves index.html, index.js, and index.css from app/dist/webview/.
 *
 * Every response (the app shell, each asset, and the 403/404 answers) carries the protective headers of
 * staticHeaders(): a CSP that allows exactly what the built UI loads, no framing (except in cloud mode, whose
 * preview pane frames the page), nosniff and a referrer policy.
 */
import * as crypto from 'crypto'
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'

const WEBVIEW_DIR = path.join(__dirname, 'webview')

/** The shell's only inline style (hashed into the CSP; no style attributes in the shell). */
const SHELL_STYLE = 'html, body { height: 100%; margin: 0; padding: 0; } body { background: #0a0a1a; } #root { height: 100%; }'

const HTML_SHELL = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team Monitor</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23111827'/%3E%3Cpath d='M32 17L17 44M32 17L47 44M17 44L47 44' stroke='%239ca3af' stroke-width='3' stroke-linecap='round'/%3E%3Ccircle cx='32' cy='17' r='7' fill='%2360a5fa'/%3E%3Ccircle cx='17' cy='44' r='7' fill='%23e5e7eb'/%3E%3Ccircle cx='47' cy='44' r='7' fill='%23e5e7eb'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/index.css">
  <style>${SHELL_STYLE}</style>
</head>
<body class="font-sans antialiased">
  <div id="root"></div>
  <script src="/index.js"></script>
</body>
</html>`

const SHELL_STYLE_HASH = `'sha256-${crypto.createHash('sha256').update(SHELL_STYLE, 'utf-8').digest('base64')}'`

/**
 * CSP of the app (P-06), from what the build loads (app/dist/webview: one script, one stylesheet, the sound files):
 * - script-src 'self': /index.js only (no inline script, no eval: the bundle needs neither);
 * - style-src 'self' + the hash of the shell's one <style>: /index.css (React sets element styles through the
 *   CSSOM, which CSP does not restrict);
 * - img-src 'self' data:: the shell's data: favicon and the data:image/svg+xml images the graph draws on its canvas;
 * - connect-src 'self': fetch of /api/team/*, the sound files (fetched, then decoded by Web Audio) and the
 *   EventSource streams /events and /api/team/events;
 * - no fonts (system fonts only), media, workers, objects or frames; base-uri and form-action locked.
 */
export function appCsp(frameable: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' ${SHELL_STYLE_HASH}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    ...(frameable ? [] : ["frame-ancestors 'none'"]),
  ].join('; ')
}

/**
 * Protective headers of the app shell and every static asset. `frameable` (cloud mode only: the app's preview pane
 * embeds the page in a frame) drops X-Frame-Options and frame-ancestors and keeps the rest.
 *
 * Referrer-Policy is `same-origin` on the shell, not `no-referrer`: with `no-referrer` on the document, browsers send
 * `Origin: null` on the app's own POSTs (answers, chat, offboarding), which the same-origin check refuses (same reason
 * as on the login page). It still sends no referrer to any other origin. Assets get `no-referrer`.
 */
export function staticHeaders(opts: { frameable?: boolean; document?: boolean } = {}): Record<string, string> {
  return {
    'Content-Security-Policy': appCsp(opts.frameable === true),
    ...(opts.frameable ? {} : { 'X-Frame-Options': 'DENY' }),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': opts.document ? 'same-origin' : 'no-referrer',
  }
}

export const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  // sound set v3 (copied flat into the webview folder by app/build.js)
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
}

export interface StaticOptions {
  /** Cloud mode (preview pane frames the page): no framing ban. */
  frameable?: boolean
}

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, opts: StaticOptions = {}) {
  const url = req.url || '/'
  const plain = staticHeaders({ frameable: opts.frameable })

  if (url === '/' || url === '/index.html') {
    // no-cache: the bundle has a fixed name, so browsers must revalidate after every rebuild (phones kept old code).
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...staticHeaders({ frameable: opts.frameable, document: true }) })
    res.end(HTML_SHELL)
    return
  }

  // Only serve known asset files from the webview directory
  const basename = path.basename(url)
  const ext = path.extname(basename)
  const mime = MIME_TYPES[ext]

  if (!mime) {
    res.writeHead(404, plain)
    res.end('Not found')
    return
  }

  const filePath = path.join(WEBVIEW_DIR, basename)

  // Prevent path traversal
  if (!filePath.startsWith(WEBVIEW_DIR)) {
    res.writeHead(403, plain)
    res.end('Forbidden')
    return
  }

  try {
    const content = fs.readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', ...plain })
    res.end(content)
  } catch {
    res.writeHead(404, plain)
    res.end('Not found')
  }
}
