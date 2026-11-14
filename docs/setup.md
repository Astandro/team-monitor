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
   This is tailnet only, and the default. For a laptop without Tailscale see "public UI" below.
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
  403 and changes nothing (no event, state, rename or `seq`), and its outbox is not shown. When the source is
  removed (24 hours of silence, or eviction at the source cap) the binding is kept in
  `~/.team-monitor/ingest-tombstones.json` (0600, hashes only, atomic writes) for 30 days after the removal: another
  key is still refused and the real key re-creates the source. At most 10,000 entries; beyond that the oldest are
  dropped and those source ids bind to whichever key comes first again. A new container with the same session id
  is refused until its old binding expires.
- Routes, matched exactly on the raw request path: `POST /api/ingest/v1/events` (512 KB, 500 messages),
  `PUT /api/ingest/v1/state` (1 MB), `GET /api/ingest/v1/outbox?sourceId=&after=&wait=0-25` (long poll for answers
  and chat messages). With `--ingest`, any other path starting with `/api/ingest` in any letter case (also sibling
  names such as `/api/ingestX/...`, a trailing slash, other versions), and any path with a dot segment, an encoded
  dot, slash or backslash or a backslash, is answered 400 before any other handler (token or not) and never
  reaches the UI or the team API. Without `--ingest` such paths behave as before.
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
  active session of a live source is never evicted, and a source id without a binding may evict a source with a
  bound key only once that has been stale for 10 minutes. If not enough can be evicted the hub answers 503 with
  `Retry-After: 30` and registers nothing for the request (the forwarder logs it and retries). Messages the hub accepts but ignores are counted in `ignored`; the forwarder
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
  token file and the Funnel mapping, and fails if Funnel would also make the UI public. With `--public-ui` (below)
  the one Funnel mapping of the whole app also serves `/api/ingest` instead.

## Laptop without Tailscale: public UI through Funnel (`--public-ui`)

The default stays tailnet only: the UI and the login are on `tailscale serve`, reachable from your own devices.
For a device that cannot run Tailscale, `--public-ui` puts the whole UI on Tailscale Funnel, on the public
internet. Off by default; it is accepted only together with `--remote --bind loopback` (otherwise the monitor does
not start and says so in one line).

- **What it exposes.** The login page, at `https://<machine>.<tailnet>.ts.net/login`, to anyone on the internet.
  After login a device has full access, as on the tailnet: graph, team panel, answering decisions, chat,
  offboarding. **Anyone who has the token can steer the team from the internet.** Without a session nothing but
  `/login`, `/logout` (and, with `--ingest`, the three ingest routes, which need the ingest token) answers: every
  page, asset, icon, sound, `/events` and API route gives a redirect to `/login` or 401 and no data.
- **Turn it on.** `tm service install --port 3002 --remote --bind loopback --public-ui` (add `--ingest` if you use
  the hub intake), then once: `tailscale funnel --bg --https=443 http://127.0.0.1:3002`. That one mapping serves the
  whole app (with `--ingest` also `/api/ingest`; no separate `--set-path` mapping is needed). The phone's
  `tailscale serve` mapping on 8443 can stay. Use the command `tm doctor` prints; it uses your monitor port.
- **Check.** `tm doctor` (or `tm doctor --public-ui [--port <n>]` without a service) passes when Funnel maps `/` to
  the monitor and prints the exact command when not. Without `--public-ui`, a UI on Funnel stays a failure when
  `--ingest` is on, as before.
- **Limits and log.** 5 wrong tokens in 15 minutes from one address, then 429 for that address only (the address
  is the one Funnel reports; an IPv6 client counts by its /64). Every failed, refused and successful login is
  logged in `~/.team-monitor/team-monitor.log` with that address, at most one line per kind and address per
  minute, never the token. The session cookie is `Secure; HttpOnly; SameSite=Strict`; sessions last 30 days.
- **Drop all sessions.** `tm logout-all` ends every login session at once, also while the monitor runs (no
  restart): the next request of each device goes to the login page; open live views close within a minute.
- **Rotate the token** (lost device, token seen by someone): `rm ~/.team-monitor/token && tm service restart`. A
  new token is created (read it from the file; it is never printed) and every session made with the old one ends.
- **Turn it off.** `tailscale funnel --https=443 off` (or `tailscale funnel reset`, which also removes an ingest
  mapping), then install the service again without `--public-ui`.

## Service commands

| Command | What it does |
|---|---|
| `tm service status` | Loaded, pid, port listening, `GET /api/team/projects` on loopback. Exit 0 when healthy. |
| `tm service restart` | `launchctl kickstart -k` / `systemctl --user restart`. |
| `tm service uninstall [--label <l>]` | Unloads, removes the plist/unit and `service.json`. Keeps the log, config and token. |
| `tm project add <path> [--name <n>]` / `remove <id>` / `list` | Edit `config.json`; add/remove restart the service. |
| `tm logout-all` | Ends every login session (running or stopped monitor, no restart). Devices must log in again. |

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
