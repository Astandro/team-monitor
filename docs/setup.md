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

- Token: `~/.team-monitor/ingest-token` (64 hex, 0600), created at the first start with `--ingest`. It is never
  printed (the start prints only the file path; read the file to set the network secret). Every ingest request
  needs `Authorization: Bearer <it>`, also from loopback. The login token and the session cookie do not open
  ingest routes; the ingest token opens nothing else. Wrong tokens: 401, then 429. (The remote-mode login token in
  `~/.team-monitor/token` is not printed either.)
- Source key: every ingest request also needs `X-Team-Monitor-Source-Key: <64 hex>`, the container's own secret.
  The forwarder creates it at its first start (32 random bytes in `<container team home>/cloud/source-key`, 0600,
  never logged). The hub binds the key's sha256 to the `sourceId` on the first accepted request and keeps it in the
  mirror's `source.json`, so it survives a hub restart. A request for that `sourceId` with another or no key gets
  403 and changes nothing (no event, state, rename or `seq`), and its outbox is not shown. The binding goes away
  with the mirror (24 hours of silence, or eviction at the source cap); a new container with the same session id
  is refused until then.
- Routes, matched exactly on the raw request path: `POST /api/ingest/v1/events` (512 KB, 500 messages),
  `PUT /api/ingest/v1/state` (1 MB), `GET /api/ingest/v1/outbox?sourceId=&after=&wait=0-25` (long poll for answers
  and chat messages). Any other path under `/api/ingest` (dot segments, encoded dots, slashes or backslashes, a
  trailing slash, other versions) is answered 400 there and never reaches the UI or the team API.
- Epoch: every authenticated ingest response carries `X-Team-Monitor-Hub-Epoch` (random per hub start). The
  forwarder sends the epoch it knows on each events post; after a hub restart that post gets 409 and nothing is
  applied. When the forwarder sees a new epoch (on any reply) it resends `session-started` for its sessions and
  their buffered history, so running and idle sessions come back with label, prompt and history.
- Limits: JSON nested deeper than 32 levels: 400. One event larger than 64 KB as JSON: 400 for the batch (the
  forwarder drops such an event on its own first, with a log line). Buffered events per cloud session 4 MB, per
  source 16 MB and for all cloud sessions together 128 MB (oldest dropped, like the 5,000-event cap; over the
  128 MB first from sessions of stale sources, then from ended sessions, then from the largest live buffers, and a
  new event is never refused for it); a new viewer's replay carries at most 32 MB of cloud events (newest sessions
  and events first). Real events are a few hundred bytes.
- Capacity: 200 cloud sessions and 100 sources. At the cap, ended sessions and sessions of stale sources are
  evicted (stale longest first), and the longest-stale source is removed with its mirror. A live source or an
  active session of a live source is never evicted: if everything is live the hub answers 503 with `Retry-After`
  (the forwarder logs it and retries). Messages the hub accepts but ignores are counted in `ignored`; the forwarder
  logs them and `cloud status` shows the count. More than 64 outbox long polls at once: 503 with `Retry-After: 5`.
- Hub log: refused ingest requests are logged at most once per minute per kind and client or source (the next line
  says how many were left out), and at most 10 lines per kind per minute in all, so a client in a loop cannot fill
  `team-monitor.log`.
- Mirrors: `~/.team-monitor/remote/<sourceId>/.agent-team/`, registered at runtime as project `cloud-<sourceId>`
  (never written to `config.json`). A source silent for 60 s is `stale`; a source silent for 24 hours is removed
  with its mirror (at start and while running).
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
