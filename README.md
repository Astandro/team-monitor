# Team Monitor

Team Monitor is a modified version of Agent Flow by Simon Patole (https://github.com/patoles/agent-flow), licensed under the Apache License 2.0. Agent Flow is a trademark of Simon Patole; this project is not affiliated with or endorsed by the Agent Flow project.

Team monitor for Astandro's agentic team: a live agent graph (Claude Code and Codex sessions) plus team, tasks and decisions.

Compatible with agent-flow hooks: the hook discovery directory (`~/.claude/agent-flow`), the hook markers written into `~/.claude/settings.json` and the `~/.agent-flow` config directory keep their original names, so an existing agent-flow hook setup keeps working.

## Install and run

From a clone of this repository:

```bash
npx -y pnpm@10 install
npx -y pnpm@10 run build:app
node app/dist/app.js
```

Or from a GitHub release: download `team-monitor-<version>.tgz`, check it against its `.sha256`, unpack it and run `node team-monitor-<version>/app.js`.

The app opens in your browser and starts a local server on port 3002 (the VS Code extension and dev relay still use 3001, which upstream agent-flow also uses, so both can run side by side). Start a Claude Code session in another terminal and events stream in as they happen.

Options:
- `--port <number>`: change the server port (default: 3002)
- `--no-open`: do not open the browser automatically
- `--verbose`: show detailed event logs

On first start the app configures Claude Code hooks (see below). To do it by hand: `npx -y pnpm@10 run setup` (add `-- --force` to reconfigure).

More: `docs/setup.md` (service and phone access), `docs/coordinator.md` (team state, decisions, chat), `docs/cloud.md` (Claude Code cloud sessions in your local monitor).

## How it works

- Claude Code hooks: a small hook script at `~/.claude/agent-flow/hook.js` forwards each hook event to the running server over loopback HTTP. Discovery files in `~/.claude/agent-flow/` tell the script which instance to talk to; it handles dead instances.
- Transcript watching: the server also tails Claude Code transcripts (`~/.claude/projects/`) and Codex rollouts (`~/.codex/sessions/**/rollout-*.jsonl`, respects `CODEX_HOME`).
- Streaming: the UI receives events over SSE. Multiple sessions show as tabs; the canvas is an interactive node graph with timeline and transcript panels.
- JSONL log: point the VS Code setting `agentVisualizer.eventLogPath` at a `.jsonl` file to watch it.

Runtime selection: by default both Claude Code and Codex are watched. Set the `AGENT_FLOW_RUNTIME` environment variable to `claude` or `codex` to watch only one. For non-default Codex installs set `CODEX_HOME`.

## Development

```bash
npx -y pnpm@10 install
npx -y pnpm@10 run setup        # configure Claude Code hooks (one-time)
npx -y pnpm@10 run dev          # web app + event relay
```

| Script | Description |
|--------|-------------|
| `run dev:demo` | Start with demo/mock data |
| `run dev:relay` | Run the event relay server standalone |
| `run build:app` | Build the standalone app into `app/dist/` |
| `run build:webview` | Build the webview assets |
| `run build:extension` | Build the VS Code extension |
| `run test` | Root tests (scripts, app, web) |

Requirements: Node.js 20+, Claude Code CLI. The VS Code extension in `extension/` is kept building but is not the main way to run this.

## Telemetry

None. Team Monitor does not collect or send usage data, and there is no setting to turn it on: nothing is written to disk and no network call is made, whatever environment variables are set. The upstream endpoint and key were removed from `scripts/telemetry.ts`.

## Uninstalling the VS Code extension

The extension's uninstall script removes agent-flow hooks from your Claude Code settings and deletes `~/.claude/agent-flow/`. That directory is shared with upstream agent-flow, so uninstalling the extension also removes the hooks of any agent-flow install on the same machine. Re-run `npx -y pnpm@10 run setup` afterwards if you still need them.

## License

Apache 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Upstream trademark policy is kept in [TRADEMARK.md](TRADEMARK.md) for reference. The `extension/` folder carries upstream Agent Flow's own licence file, [extension/LICENSE](extension/LICENSE) (MIT), unchanged.
