# Setup: new machine / new project

One monitor serves every project. It runs as a per-user service that starts at login, restarts after a crash
(10 s throttle) and comes back after a reboot. Projects come from `~/.team-monitor/config.json`; there is no
per-project service. Below, `tm` stands for `node ~/projects/team-monitor/app/dist/app.js`.

## New machine / new project in 6 steps

1. **Build.** `git clone` the repo to `~/projects/team-monitor`, then in it:
   `npx -y pnpm@10 install --frozen-lockfile && npx -y pnpm@10 run build:app`.
   The service runs this build with the node that ran the install (absolute path), so after an update just
   rebuild and run `tm service restart`.
2. **Register the project(s).** `tm project add ~/projects/<repo> --name "<Name>"` for each. It creates
   `.agent-team/`, adds it to `.git/info/exclude`, and restarts the service if one is installed. A new project on a
   machine that already has the service needs only this step plus step 6.
3. **Install the service.** `tm service install --port 3002 --remote --bind loopback`
   - macOS: writes `~/Library/LaunchAgents/com.astandro.team-monitor.plist` and loads it with `launchctl bootstrap`;
     an existing one with the same label (or the one recorded in `~/.team-monitor/service.json`) is booted out first.
   - Linux: writes `~/.config/systemd/user/team-monitor.service` (`Restart=always`) and enables it. To start it at
     boot without logging in, run once yourself: `loginctl enable-linger "$USER"` (printed, not run).
   - The MagicDNS name is read from `tailscale status --json` now and written into the service as `--host-allow`,
     so the phone URL works even when Tailscale comes up after the monitor at login. Pass `--host-allow <name>` to
     set it yourself (needed if Tailscale is down during the install; the install warns).
   - The monitor never listens on 0.0.0.0: `--bind loopback` (behind `tailscale serve`) or `--bind tailscale`
     (only when `tailscale ip -4` gives a Tailscale address; refused otherwise).
   - Log: `~/.team-monitor/team-monitor.log` (0600; `--log <file>` to change). Other options: `--label`,
     `--tailscale-bin`, `--workspace` (see "Hook events" below).
4. **Phone access.** Once per machine: `tailscale serve --bg --https=8443 http://127.0.0.1:3002` (use 443 if
   nothing else serves it). The access token is in `~/.team-monitor/token`; open
   `https://<machine>.<tailnet>.ts.net:8443/login` on the phone and paste it. `tailscale serve --bg` survives reboots.
5. **Claude Code hooks.** The graph hooks are written into `~/.claude/settings.json` by the monitor at start. Add
   the AskUserQuestion hook by hand (snippet in `docs/coordinator.md` section 4b).
6. **Check.** `tm doctor`: build, service loaded and healthy, config, each project folder and `.agent-team/`, the
   `tailscale serve` mapping (prints the exact command if missing; `--https-port <p>` if not 8443), token file
   0600, hooks. Exit 0 = all good. It changes nothing.

## Hub intake for cloud sessions (`--ingest`)

Off by default. With `--ingest` (also `tm service install ... --ingest`, which writes the flag into the service) the
monitor accepts relay messages and team state from cloud containers on `/api/ingest/v1/*` and shows them as cloud
sessions and projects (`origin: "cloud"`). Full setup lives in `docs/cloud.md`; the hub side in short:

- Token: `~/.team-monitor/ingest-token` (64 hex, 0600), created at the first start with `--ingest` and printed only
  then. Every ingest request needs `Authorization: Bearer <it>`, also from loopback. The login token and the
  session cookie do not open ingest routes; the ingest token opens nothing else. Wrong tokens: 401, then 429.
- Routes: `POST /api/ingest/v1/events` (512 KB, 500 messages), `PUT /api/ingest/v1/state` (1 MB),
  `GET /api/ingest/v1/outbox?sourceId=&after=&wait=0-25` (long poll for answers and chat messages).
- Mirrors: `~/.team-monitor/remote/<sourceId>/.agent-team/`, registered at runtime as project `cloud-<sourceId>`
  (never written to `config.json`). A source silent for 60 s is `stale`; mirrors idle for 7 days are removed at start.
- Funnel: expose only `/api/ingest`, on a port the UI does not use:
  `tailscale funnel --bg --https=443 --set-path /api/ingest http://127.0.0.1:3002/api/ingest`. The UI and login
  stay on `tailscale serve` (8443, tailnet only). `tm doctor` (or `tm doctor --ingest` without a service) checks the
  token file and the Funnel mapping, and fails if Funnel would also make the UI public.

## Service commands

| Command | What it does |
|---|---|
| `tm service status` | Loaded, pid, port listening, `GET /api/team/projects` on loopback. Exit 0 when healthy. |
| `tm service restart` | `launchctl kickstart -k` / `systemctl --user restart`. |
| `tm service uninstall [--label <l>]` | Unloads, removes the plist/unit and `service.json`. Keeps the log, config and token. |
| `tm project add <path> [--name <n>]` / `remove <id>` / `list` | Edit `config.json`; add/remove restart the service. |

Config changes are applied by a restart, not by watching the file: the server reads `config.json` once at start.
`project add`/`remove` do the restart for you; after a hand edit run `tm service restart`.

## Hook events and the working folder

Claude Code hooks forward live events (permission prompts, tool starts) only to a monitor whose working folder
contains the session's folder. The service's working folder is the first project in `config.json` at install time
(or `--workspace <path>`). Sessions in the other projects still show in the graph from their transcripts; they just
miss the hook-only events. Re-run `service install` after changing which project should get them.

## After a reboot

Nothing to start by hand. In the new Claude Code session run `tm doctor`, then start the coordinator's
`wait-answer` watcher again (`docs/coordinator.md` section 0).
