import { createRoot } from 'react-dom/client'
import { TeamApp } from './components/team-panel/team-app'
import './app/globals.css'

// Standalone CLI entry — no VS Code API. The team panel talks to /api/team/*, the graph connects to the relay via SSE.
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')
const root = createRoot(rootElement)
root.render(<TeamApp />)

// Installable app (PWA): the service worker only adds an offline page and caches nothing. Not in a frame (the
// cloud preview pane) and only where the browser allows workers (HTTPS or localhost).
if ('serviceWorker' in navigator && window.isSecureContext && window.top === window) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* not installable here; the app works the same */ })
  })
}
