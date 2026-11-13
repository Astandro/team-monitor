import { createRoot } from 'react-dom/client'
import { TeamApp } from './components/team-panel/team-app'
import './app/globals.css'

// Standalone CLI entry — no VS Code API. The team panel talks to /api/team/*, the graph connects to the relay via SSE.
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')
const root = createRoot(rootElement)
root.render(<TeamApp />)
