/**
 * Static file server for the pre-built webview assets.
 * Serves index.html, index.js, and index.css from app/dist/webview/.
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'

const WEBVIEW_DIR = path.join(__dirname, 'webview')

const HTML_SHELL = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team Monitor</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23111827'/%3E%3Cpath d='M32 17L17 44M32 17L47 44M17 44L47 44' stroke='%239ca3af' stroke-width='3' stroke-linecap='round'/%3E%3Ccircle cx='32' cy='17' r='7' fill='%2360a5fa'/%3E%3Ccircle cx='17' cy='44' r='7' fill='%23e5e7eb'/%3E%3Ccircle cx='47' cy='44' r='7' fill='%23e5e7eb'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="/index.css">
  <style>html, body { height: 100%; margin: 0; padding: 0; }</style>
</head>
<body class="font-sans antialiased" style="background: #0a0a1a;">
  <div id="root" style="height: 100%;"></div>
  <script src="/index.js"></script>
</body>
</html>`

export const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  // sound set v3 (copied flat into the webview folder by app/build.js)
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
}

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url || '/'

  if (url === '/' || url === '/index.html') {
    // no-cache: the bundle has a fixed name, so browsers must revalidate after every rebuild (phones kept old code).
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' })
    res.end(HTML_SHELL)
    return
  }

  // Only serve known asset files from the webview directory
  const basename = path.basename(url)
  const ext = path.extname(basename)
  const mime = MIME_TYPES[ext]

  if (!mime) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const filePath = path.join(WEBVIEW_DIR, basename)

  // Prevent path traversal
  if (!filePath.startsWith(WEBVIEW_DIR)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const content = fs.readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}
