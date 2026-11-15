/*
 * Team Monitor service worker. It makes the app installable and shows a small offline page when a page load
 * cannot reach the monitor. It caches nothing: the monitor shows live data, and the app shell must always be the
 * current build (the static server sends no-cache for the same reason).
 *
 * Only GET page loads (navigations) are handled. API calls, the event streams and the login form POST go to the
 * network untouched, so login, CSRF and Origin checks see exactly what the browser sends.
 */
'use strict'

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Team Monitor (offline)</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a1a;color:#e5e7eb;font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box">
<main style="max-width:28rem;text-align:center">
<h1 style="font-size:1.25rem;margin:0 0 .5rem">Team Monitor is not reachable</h1>
<p style="margin:0 0 1.25rem;color:#9ca3af">Check your connection or whether the monitor is running, then try again.</p>
<a href="/" style="display:inline-block;padding:.6rem 1.2rem;border-radius:.5rem;background:#60a5fa;color:#0a0a1a;text-decoration:none;font-weight:600">Try again</a>
</main>
</body>
</html>`

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.mode !== 'navigate' || req.method !== 'GET') return
  event.respondWith(
    fetch(req).catch(() => new Response(OFFLINE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    })),
  )
})
