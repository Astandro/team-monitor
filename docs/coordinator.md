# Coordinator side: team state and decision answers

The monitor reads `<project>/.agent-team/` and never writes `state.json`. The coordinator owns that file; the
monitor only writes answers to `<project>/.agent-team/answers/<Dn>.json`.

## 1. Register the project

Either pass it on the command line (repeatable):

```sh
node ~/projects/team-monitor/app/dist/app.js --project ~/projects/my-app
```

or list it in `~/.team-monitor/config.json` (override the folder with `TEAM_MONITOR_HOME`):

```json
{"projects": [{"id": "my-app", "name": "My App web", "path": "~/projects/my-app"}]}
```

`id` is optional (default: slug of the folder name, made unique). Folders that do not exist are skipped. Restart the
monitor after editing the config. Add `.agent-team/` to the project's `.gitignore`.

## 2. Write state.json atomically

Write `.agent-team/state.json` (data contract: see the team-monitor README) to a temp file in the same folder and
rename it over the old one. The monitor picks the change up within about 100 ms (fs.watch) or 3 s (poll), caps the
file at 1 MB, and keeps showing the last good state (with an error) if the JSON is broken.

A decision is answerable only while `approvals.<Dn>.status` is `"open"` and no `answers/<Dn>.json` exists yet.

## 3. Wait for an answer (background shell task)

Run this with `run_in_background: true`. It exits when an answer arrives, so its completion wakes the coordinator:

```sh
node ~/projects/team-monitor/app/dist/app.js wait-answer --project ~/projects/my-app --timeout 3600
```

Without a build (dev), from the team-monitor checkout:

```sh
cd ~/projects/team-monitor && node --import tsx app/src/team/wait-answer-main.ts --project ~/projects/my-app --timeout 3600
```

Output on success (exit code 0): the file name on the first line, then the file content:

```
D3.json
{
  "answer": "pakai opsi B",
  "answeredAt": "2026-11-13T04:42:09.883Z"
}
```

| Option | Meaning |
|---|---|
| `--project <path>` | Project folder (default: current directory). |
| `--timeout <s>` | Give up after this many seconds: exit code 124, message on stderr. Omit to wait forever. |
| `--only-new` | Ignore answers already on disk. |

Exit codes: `0` answer, `124` timeout, `2` bad usage or missing project folder.

By default an answer file that is already on disk for a decision still `open` in `state.json` is reported at
once. That way an answer given while no wait was running is never missed. It also means the coordinator must
record the answer before waiting again, or the same answer is reported again.

## 4. Record the answer

After reading the answer, update `state.json` yourself: set `approvals.<Dn>.status` to `"answered"` and copy `answer`
and `answeredAt`. Leave the answer file in place (it is the record of what was answered on the screen). Then start
the next wait if other decisions are still open.

## 5. Phone access (remote mode)

- Behind `tailscale serve` (recommended, gives https): start with `--remote --bind loopback`, then run
  `tailscale serve --bg <port>`. Open `https://<machine>.<tailnet>.ts.net/login` on the phone.
- Direct on the Tailscale address: `--remote --bind tailscale` (binds only to the address from `tailscale ip -4`).
  Plain http; the cookie then has no `Secure` flag.

On the first remote start the token is created in `~/.team-monitor/token` (0600) and printed once. Read it again
on the Mac with `cat ~/.team-monitor/token`. If the server then fails to listen (port taken, address not on this
machine), the token file is kept and the error message says where it is.

Lost phone, or the token leaked: rotate it. Stop the monitor, delete `~/.team-monitor/token`, start it again. A new
token is created and printed, and every login session issued under the old token ends at that start (sessions are
bound to the token; the start-up log says how many were ended). Log in again on each device with the new token.
To end all sessions but keep the token, stop the monitor, delete `~/.team-monitor/sessions.json`, and start it.
Logging out (`POST /logout`) ends that session at once, including its open live streams; an expired session's
streams are closed within a minute.

Accepted Host names in remote mode: loopback names, the Tailscale IP, the MagicDNS name and its short form
(`http://my-machine:3002` works when MagicDNS is on), plus `--host-allow <name>` extras.

Failed logins: 5 per client per 15 minutes, then 429 with `Retry-After`. There is no global cap, so other devices
cannot lock the owner out. The client is the socket address for direct connections, and the last
`X-Forwarded-For` entry (the one `tailscale serve` sets) behind `tailscale serve`.

On macOS the CLI is found at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; override with
`--tailscale-bin <path>` or `TEAM_MONITOR_TAILSCALE_BIN`.
