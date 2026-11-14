# Cloud sessions: show a Claude Code cloud project in your local monitor

A Claude Code cloud session runs in a container. With this setup the container runs its own small monitor plus a
forwarder, and your local monitor (the "hub") shows that session like a local one: graph, team panel, decisions
and chat. Nothing to start by hand per session.

```
cloud container                                          your machine (hub)
  Claude Code session
  monitor (127.0.0.1:3002) -> forwarder --HTTPS--> Tailscale Funnel --> monitor --ingest  /api/ingest
                              ^                    (path /api/ingest only)        |
                              +---- outbox long poll: answers and chat <----------+
```

The container posts events and team state to the hub. Your answers to decisions and your chat messages are
collected by the hub; the forwarder fetches them (long poll) and writes them into the project's `.agent-team/`, so
`wait-answer` in the container works as in a local run. Below, `tm` stands for
`node ~/projects/team-monitor/app/dist/app.js`, as in `docs/setup.md`.

## 1. Hub setup (once per machine)

1. **Update and rebuild.** In the clone: `git pull`, then
   `npx -y pnpm@10 install --frozen-lockfile && npx -y pnpm@10 run build:app`.
2. **Start the monitor with `--ingest`.** With the service (see `docs/setup.md`): run the install again with the
   flag added, for example `tm service install --port 3002 --remote --bind loopback --ingest`. Without a service:
   `node app/dist/app.js --ingest`. `--ingest` is off by default; while it is off every `/api/ingest` path
   answers 404.
3. **The ingest token.** At the first start with `--ingest` the monitor creates `~/.team-monitor/ingest-token`
   (64 hex characters, mode 0600). The start prints only the file name, never the token. Do not print, paste or
   commit it. You need its content once, in step 3 below; copy it without showing it (for example
   `pbcopy < ~/.team-monitor/ingest-token` on macOS). It is not the login token (`~/.team-monitor/token`).
4. **Funnel.** The cloud network cannot reach your tailnet, so one path is made public with Tailscale Funnel:
   `tailscale funnel --bg --https=443 --set-path /api/ingest http://127.0.0.1:3002/api/ingest`.
   Only `/api/ingest` is public, and every request there needs the ingest token. The UI and the login stay on
   `tailscale serve` (tailnet only), on another port (8443 in `docs/setup.md`). If the UI is on 443, `doctor`
   suggests `--https=8443` for Funnel instead. Use the command `doctor` prints; it also uses your monitor port if
   it is not 3002.
   With the public UI (`--public-ui`, see `docs/setup.md`) the whole app is on Funnel instead:
   `tailscale funnel --bg --https=443 http://127.0.0.1:3002` also serves `/api/ingest`, so skip the `--set-path`
   command. The default stays as above: only `/api/ingest` public, the UI tailnet only.
5. **Check.** `tm doctor` (with the service installed with `--ingest`) or `tm doctor --ingest [--port <n>]`. It
   checks the token file (0600) and the Funnel mapping. It fails if the Funnel port also serves other paths, which
   would make the UI public. With `--public-ui` (on the service, or `tm doctor --ingest --public-ui`) it expects the
   one mapping of the whole app instead and does not fail because the UI is public. Exit 0 = all good.

The Funnel host name is `<machine>.<tailnet>.ts.net` (with `:<port>` if you did not use 443). You need it below.

## 2. Cloud environment setup (once per environment)

In the settings of the Claude Code cloud environment that your projects use:

1. **Allowed host.** Add `<machine>.<tailnet>.ts.net` to the environment's allowed network hosts (host name only).
2. **Network secret.** Save the content of the ingest token file as a network secret for that host, sent as
   `Authorization: Bearer <token>`. The platform proxy adds it to requests to that host, so the token never enters
   the container: the forwarder sends the placeholder `Bearer team-monitor-network-secret` and the proxy replaces
   it. Do not put the token in an environment variable of the environment (the forwarder would use
   `TEAM_MONITOR_INGEST_TOKEN` if it were set; that variable is only for tests).
3. **Hub URL variable.** Set `TEAM_MONITOR_HUB_URL=https://<machine>.<tailnet>.ts.net` (add `:<port>` if Funnel is
   not on 443). Only `http://` or `https://`, no user name or password, no path. Without this variable the monitor
   still starts in the container, but nothing is forwarded.

A changed environment applies to new sessions.

## 3. Per-project setup (once per project)

1. Copy `scripts/cloud/team-monitor-hook.sh` from this repository into the project, for example to
   `.claude/hooks/team-monitor-hook.sh`.
2. Pin a release in the copy. Take `VERSION` and `SHA256` from the release page (the release notes show both lines;
   the release also has a `team-monitor-<version>.pin.txt` with them):

   ```sh
   VERSION="1.2.3"
   SHA256="<64 lowercase hex>"
   ```
3. Add the hook to the project's `.claude/settings.json`:

   ```json
   {
     "hooks": {
       "SessionStart": [
         { "hooks": [ { "type": "command", "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/team-monitor-hook.sh\"" } ] }
       ]
     }
   }
   ```
4. Commit both files.

What the hook does, only when `CLAUDE_CODE_REMOTE=true` (in a local session it exits at once, silently):
downloads `team-monitor-<VERSION>.tgz` from the repository's GitHub release `v<VERSION>` (needs `curl`, `tar` and
`node` in the container), checks its sha256 against your pin before unpacking, unpacks it to
`~/.team-monitor/app/<VERSION>/` (once; later sessions reuse it), then runs `cloud start` for the project. It
refuses archives with anything but plain files and folders. It has a 45 s budget, and every problem prints one line
and exits 0, so it never blocks the session.

`cloud start` registers the project (creates `.agent-team/`, adds it to `.git/info/exclude`), starts the monitor
detached on 127.0.0.1:3002 unless one is already healthy, and, if `TEAM_MONITOR_HUB_URL` is set, the forwarder. It
returns in about 4 s at most, always exits 0 and prints one line. Logs are in
`~/.team-monitor/cloud/monitor.log` and `forwarder.log` in the container. One container serves one project.

## 4. Check that it works

In the cloud session:

```sh
node ~/.team-monitor/app/<VERSION>/app.js cloud status
```

```
Monitor: healthy on http://127.0.0.1:3002 (pid 123)
Hub: https://<machine>.<tailnet>.ts.net
Forwarder: running (pid 124)
Source: <session id>
Last successful post: 2026-01-01T10:00:00.000Z
Unsent: 0
```

Good: monitor healthy, forwarder running, a `Last successful post` time and no `Last error` line. `never` means
nothing was posted yet. Exit code is 0 when the monitor answers, else 1. `cloud stop` stops the forwarder and the
monitor.

In the hub UI the session appears next to your local ones, with a **Cloud** marker on its tab and on the project
entry. Each cloud session is its own project entry (named after the project folder). When the container stops
reporting for 60 s, the entry and its sessions show **Terputus** and keep the last data; they come back by
themselves when the container reports again. The app's preview pane of a cloud session can show the container's
monitor, but it is view-only: the monitor refuses every changing request (answers, chat) that does not come with a
loopback Host. Answer and chat in the hub.

## 5. Security model

- **Ingest token.** One shared secret for every container of the environment. Every ingest request needs it
  (`Authorization: Bearer`), also from loopback. The login token and the session cookie do not open ingest routes;
  the ingest token opens nothing else. Wrong tokens get 401; after 5 in 15 minutes from one client, 429 (a correct
  token still works). Behind Funnel the client is the last `X-Forwarded-For` entry.
- **Source key.** Each container makes its own 32-byte key (`~/.team-monitor/cloud/source-key`, 0600) and sends it
  in `X-Team-Monitor-Source-Key`. The hub binds the key's hash to the source id (derived from the cloud session id)
  on the first accepted request and keeps it across hub restarts. Any request for that source with another key
  gets 403, changes nothing, and its outbox is not shown. When the hub removes a source (source cap, or 24 hours
  silent), the binding stays in `~/.team-monitor/ingest-tombstones.json` (0600, hashes only) for 30 days: another
  key is still refused, and the real key is accepted again (the source is created anew). At most 10,000 such
  entries are kept; beyond that the oldest are dropped, and those source ids are free again for whichever key
  comes first, like a source id never seen.
- **A token holder** (any process in a cloud session of the environment, because the proxy adds the token to every
  request to the hub host) can: add up to 100 sources of its own, show fake sessions and team state under them
  (content is size-capped and shape-checked, shown escaped), and claim a source id that no container has used yet,
  which then refuses the real container (403). It cannot: read or write a source it does not hold the key of,
  read answers or chat of other sources, open the UI, the login or the team API, or make the hub write outside
  `~/.team-monitor/remote/<sourceId>/`.
- **Routes.** Matched exactly on the raw path (as sent, without the query string): `POST /api/ingest/v1/events`,
  `PUT /api/ingest/v1/state`, `GET /api/ingest/v1/outbox`. On a hub with `--ingest`, any other path that starts
  with `/api/ingest` in any letter case (also `/api/ingestX/...`, `/api/ingest-x`, other versions, a trailing
  slash), and any path anywhere with a `.` or `..` segment, an encoded dot, slash or backslash (`%2e`, `%2f`,
  `%5c`, also double-encoded) or a backslash, gets 400 before any other handler, with or without the token.
  Browsers never send such paths, so the UI is not affected. Ingest routes skip the Host check, because Funnel
  sends the public host name; the token is checked first. Without `--ingest` nothing changes (`/api/ingest`: 404).
- **Size limits.** Events post: 512 KB, 500 messages. State: 1 MB. One event: 64 KB. JSON nesting: 32 levels.
  Over a limit: 413 (size) or 400 (shape, nesting, one big event). Answer files 16 KB, chat files 32 KB.
- **Buffers.** The hub keeps at most 5,000 events per cloud session, 4 MB per session, 16 MB per source and 128 MB
  for all cloud sessions together (bytes of events as JSON). Over the 128 MB the oldest events go first from
  sessions of stale sources, then from ended sessions, then from the largest live session buffers; a new event is
  never refused for it. A new viewer's replay carries at most 32 MB of cloud events. At most 200 cloud sessions and 100
  sources. At the cap the hub evicts ended sessions and sessions of stale sources (stale longest first) and then
  the longest-stale source with its mirror; a live source or an active session of a live source is never evicted.
  A source id the hub has no binding for may only evict a source with a bound key once that source has been stale
  for 10 minutes (a source id coming back with its own key may evict any stale source). If nothing can be evicted,
  the post gets 503 with `Retry-After: 30`, registers nothing (no project, no key binding), and the forwarder
  retries. At most 64 outbox long polls at once (503, `Retry-After: 5`).
- **Hub log.** A refused ingest request (wrong token or source key, capacity, too many polls, a failed write) is
  logged at most once per minute per kind of refusal and client or source, with the number of lines left out on
  the next one; at most 10 such lines per kind per minute in all. Bad paths and bad bodies are not logged.
- **Mirrors.** The hub writes a source's state to `~/.team-monitor/remote/<sourceId>/.agent-team/` and registers
  it at runtime as project `cloud-<sourceId>` (not in `config.json`). A source silent for 60 s is stale; a source
  silent for 24 hours is removed with its mirror; its key binding is kept for 30 days more (see Source key).
- **Public UI (`--public-ui`, off by default).** Only with `--remote --bind loopback`. The login page and, after
  login, the whole UI with full access (answers, chat, offboarding) are on the internet: anyone with the login
  token (`~/.team-monitor/token`) can steer the team. Without a session only `/login`, `/logout` and the three
  ingest routes answer; everything else gets a redirect to `/login` or 401 and no data. The ingest token still
  opens only the ingest routes, and the login token or a session never opens them. Logins are limited to 5 wrong
  tokens per 15 minutes per client address (the last `X-Forwarded-For` entry, which Funnel's local proxy writes;
  other forwarded headers are ignored; IPv6 by /64) and logged without the token. End all sessions with
  `tm logout-all`; rotate the token by deleting the file and restarting (`docs/setup.md`).
- **Host in cloud mode.** The container's monitor binds 127.0.0.1 only. When started by `cloud start` with
  `CLAUDE_CODE_REMOTE=true` it accepts any Host header for read requests (GET, HEAD), so the preview pane can load
  it. Every changing request still needs a loopback Host. `--cloud` cannot be combined with `--remote` or
  `--ingest`. Outside cloud mode nothing changes.
- **The container side.** The forwarder keeps at most 5,000 unsent messages (oldest dropped, one log line) and
  retries with 1 s to 30 s backoff. It never logs the token or the source key.

## 6. Known limits

- A crash between the hub applying a post and the forwarder saving its acknowledgement can show some events twice
  on the hub.
- Events written while the container's monitor was down (for example between its stop and restart) can be missing
  on the hub.
- A new container that reuses a session id gets a new source key and is refused (403) until the hub forgets the
  old binding: 30 days after it removed the source (which happens 24 hours after the source's last request, or
  earlier at the source cap). There is no command to forget a source.
- A cloud source can claim a session id before a local session with that id exists; the list then shows it twice.
- `cloud stop` sends SIGKILL after 3 s, which can cut a post in flight (see the first point).
- A hub restart loses the events it held in memory. The forwarder notices the new hub (epoch), and sends the
  sessions and their history again; while the container is down or the hub is unreachable they stay lost.
- One container serves one project; a project added while the container's monitor already runs is picked up at the
  monitor's next start.
- With the 128 MB hub-wide cap a busy source can push older history of other sessions out of the hub's memory
  (the containers keep their own copy; a hub restart brings it back).
- Over a proxy, the TLS name check of a hub given by IP address is wrong; use a host name (Funnel gives one).
- `cloud status` can show a `Last error` of a loop that has already recovered.
- The hook was tested on Linux only; macOS (bsdtar, `shasum`) is untested. The end-to-end test runs on Linux only.
  The release workflow has not run yet.
- The hook's budget is 45 s. A download that does not finish in that time is stopped and tried again next session.

Not verified in real use yet: that the cloud network reaches the Funnel host; that the platform proxy replaces the
placeholder with the network secret; that `--set-path /api/ingest` strips the mount before proxying (the command
assumes it does, so the target is `.../api/ingest`); that the preview pane renders the monitor; and the download
from the release URL (it needs a public repository and a tag).

## 7. Troubleshooting

Run `cloud status` in the container first. The forwarder log is `~/.team-monitor/cloud/forwarder.log`.

| You see | Cause and fix |
|---|---|
| `cloud start` line: `no hub (TEAM_MONITOR_HUB_URL not set)` | The variable is missing in the environment. Set it (section 2) and start a new session. |
| `no forwarder: TEAM_MONITOR_HUB_URL ...` | The URL is not valid: it must start with `https://` (or `http://`), without user name or password. |
| `monitor did not start` or `still starting` | Read `~/.team-monitor/cloud/monitor.log` in the container. |
| Hook: `set VERSION in ...` or `set SHA256 in ...` | Pin the release in the project's copy of the hook (section 3). |
| Hook: `download of <url> failed` | The release or tag does not exist (yet), or the container cannot reach github.com. |
| Hook: `sha256 mismatch` | The pin does not match the release file. Copy both lines again from the release page. |
| Hook: `did not finish within 45s` | Nothing was started. The next session tries again. |
| `Last error: ... proxy refused the tunnel (HTTP 403)` | The hub host is not in the environment's allowed hosts. |
| `Last error: ... HTTP 401 (ingest token required)` | Wrong or missing token: the network secret is not set for the exact hub host, is not `Authorization: Bearer`, or the token file was replaced. Save the current token file content as the secret. |
| HTTP 429 `too many failed attempts` | Five wrong tokens in 15 minutes from one client. Fix the secret; the correct token works at once. |
| HTTP 403 `... source key ...` | The hub has this source id bound to another container's key (a new container with the same session id). The binding lasts until 30 days after the hub removed the old source (section 6). |
| HTTP 409 `the hub restarted` | The forwarder handles it: it sends its sessions and history again. Only in the log (`the hub restarted: ...`). |
| HTTP 413, or `hub refused N message(s) ... dropped` | A body was over a limit (section 5). The forwarder drops that batch and counts it under `refused` in `cloud status`; it does not retry it. |
| HTTP 503 with `Retry-After` | The hub is at capacity (not enough ended or stale sessions or sources to evict) or has too many open polls. The forwarder waits (`Retry-After`) and retries. |
| HTTP 404 | The hub was not started with `--ingest`, or the Funnel mapping points to the wrong path. Run `tm doctor --ingest`. |
| HTTP 400 `not an ingest route` | The hub URL has a path. Use only `https://<host>`. |
| `TLS to the hub failed` or `proxy connection failed` | The container cannot reach the hub. Run `tm doctor` on the hub: it shows whether the Funnel mapping and the monitor are in place. |
| `Last successful post: never`, no error | No session activity yet. Start a prompt in the session. |
| Project shows `Terputus` in the hub | The container has been silent for 60 s: the session ended, the forwarder is not running, or the hub is not reachable. |
| `Ignored by the hub: N` | The hub refuses messages about sessions it already has from another source. |
