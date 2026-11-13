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
on the Mac with `cat ~/.team-monitor/token`. To revoke all phone sessions, delete `~/.team-monitor/sessions.json`
and restart; to rotate the token, delete `~/.team-monitor/token` and restart.

On macOS the CLI is found at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; override with
`--tailscale-bin <path>` or `TEAM_MONITOR_TAILSCALE_BIN`. Extra Host names: `--host-allow <name>`.
