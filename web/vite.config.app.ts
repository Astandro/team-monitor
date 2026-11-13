import { defineConfig } from 'vite'
import { createBuildConfig } from './vite.config.shared'

// TM_FIXTURE=1 builds a dev-only app that shows sample team data (web/lib/team/fixtures) instead of calling
// /api/team/*. A normal build bakes in "0", so the sample data is dropped from the bundle.
const fixture = process.env.TM_FIXTURE === '1' ? '1' : '0'

export default defineConfig(createBuildConfig({
  outDir: '../app/dist/webview',
  entry: 'app-entry.tsx',
  name: 'AgentFlowApp',
  define: {
    'process.env.NEXT_PUBLIC_DEMO': '"0"',
    'process.env.NEXT_PUBLIC_RELAY_PORT': '""',
    'process.env.AGENT_FLOW_STANDALONE': '"1"',
    'process.env.TEAM_MONITOR_FIXTURE': JSON.stringify(fixture),
  },
}))
