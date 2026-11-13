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

## 4a. Ask in one step: `ask`

Instead of editing `approvals` by hand and starting `wait-answer` separately:

```sh
node ~/projects/team-monitor/app/dist/app.js ask --project ~/projects/my-app \
  --title "Nama repo" --question "Pakai nama apa?" --option alpha --option beta --recommended beta \
  --wait --timeout 3600
```

It adds the next free `D<n>` to `approvals` (`status: "open"`, `askedAt` now, `order` n) and prints the id. The id
is one above the highest `D<n>` already there (gaps are not reused) and never one that already has an answer file.
With `--wait` (run it with `run_in_background: true`) it then waits for the answer to that decision only and prints
it like `wait-answer` (answers to other decisions do not end it).

| Option | Meaning |
|---|---|
| `--project <path>` | Project folder (default: current directory). `.agent-team/state.json` is created if missing. |
| `--title`, `--question` | Required (max 200 and 4000 characters). |
| `--option <o>` | Repeatable, up to 20. No options means a free-text answer. |
| `--recommended <o>` | Must be one of the options. |
| `--json <file>` | Read `{"title", "question", "options", "recommended"}` from a file instead of the four flags above. Other fields (status, answer, ...) are ignored. |
| `--wait`, `--timeout <s>` | Wait for this decision's answer; `--timeout` needs `--wait`. |

Exit codes: `0` added (and answered, with `--wait`), `124` timeout, `2` bad usage, `1` `state.json` could not be
updated (broken JSON, larger than 1 MB, or it kept changing during five attempts).

The write is atomic: temp file in `.agent-team/`, fsync, then the file is read again and the rename happens only if
nobody changed it since it was read; otherwise it starts over on the new content, so a concurrent edit is kept. The
coordinator should still write `state.json` the same way (temp file + rename), or an edit made at the very same
moment as an `ask` can still be lost.

## 4b. AskUserQuestion hook (questions from the dialog go to the phone)

`app/dist/ask-hook.js` is a Claude Code `PreToolUse` hook for the `AskUserQuestion` tool. It reads the hook JSON from
stdin, finds the project for the session's `cwd` (the deepest registered project that contains it, else the nearest
folder at or above it with `.agent-team/`), and adds one open decision per question: title = the question's
`header` (or the question text when there is none), question = the text, options = the option labels, recommended =
the label that ends with `(Recommended)`, with that suffix removed. Option descriptions and `multiSelect` are not
carried over.

Install it in `~/.claude/settings.json` (merge into an existing `hooks.PreToolUse` list; keep other entries):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/projects/team-monitor/app/dist/ask-hook.js\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

If `node` comes from nvm or another version manager, use its absolute path (`which node`) instead of `node`.
Rebuild with `pnpm run build:app` after pulling, since the hook runs from `app/dist/`.

Mode, in `~/.team-monitor/config.json` (next to `projects`; read on every call, no restart needed):

- `"askHook": "redirect"` (default): the dialog is denied. Claude Code shows the agent the reason, which says the
  questions are now decisions `Dn..Dm`, to run `wait-answer --project <path>` in the background, and to put the
  questions in chat too. A dialog cannot be answered from the phone, so this is the mode that makes phone answers
  work.
- `"askHook": "mirror"`: the decisions are added and the dialog runs as usual (exit 0, no output). Answer in either
  place; an answer given in the dialog is not written back to the monitor, so record it in `state.json`.

To turn the hook off, remove the entry from `settings.json`.

The hook never blocks a dialog by accident: when no project is found, the input is not an `AskUserQuestion` call or
is malformed, or `state.json` cannot be updated, it exits 0 with no output and the dialog runs. It writes one line per
call (added ids, or why it skipped; no question text) to `~/.team-monitor/ask-hook.log` (0600, rotated to
`ask-hook.log.1` at 256 KB). Sessions in folders that are not team projects are untouched apart from that log line.

## 5. Phone access (remote mode)

- Behind `tailscale serve` (recommended, gives https): start with `--remote --bind loopback`, then run
  `tailscale serve --bg http://127.0.0.1:<port>`. Open `https://<machine>.<tailnet>.ts.net/login` on the phone.
  If port 443 is already used by another serve on that machine, pick another HTTPS port:
  `tailscale serve --bg --https=8443 http://127.0.0.1:<port>`, and open `https://<machine>.<tailnet>.ts.net:8443/login`.
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
