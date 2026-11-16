# Coordinator side: team state, decision answers and chat

The monitor reads `<project>/.agent-team/` and never writes `state.json`. The coordinator owns that file; the
monitor only writes answers to `<project>/.agent-team/answers/<Dn>.json` and the owner's chat messages to
`<project>/.agent-team/inbox/<sentAt ms>-<id>.json`.

## 0. After a reboot or a power cut

The monitor runs as a service (`docs/setup.md`) and comes back by itself. In the new Claude Code session:

1. Run `node ~/projects/team-monitor/app/dist/app.js doctor`. Exit 0 means build, service, projects, `tailscale serve`
   mapping, token and hooks are fine; otherwise each `FAIL` line has a `fix:` line under it.
2. Start the chat/answer watcher again (section 3, `run_in_background: true`): the old `wait-answer` died with the
   old session, and the phone shows "Sora lagi nggak aktif" until it runs.
3. Answers and chat messages sent while the watcher was down are on disk; the first `wait-answer` reports them at
   once.

## 1. Register the project

```sh
node ~/projects/team-monitor/app/dist/app.js project add ~/projects/my-app --name "My App"
```

This writes `~/.team-monitor/config.json` (atomically, 0600; override the folder with `TEAM_MONITOR_HOME`), creates
`<project>/.agent-team/` and adds `.agent-team/` to the repo's `.git/info/exclude` (the tracked `.gitignore` is never
changed). The running monitor reads `config.json` only at start, so `project add` and `project remove <id>` restart
the installed service right away (`--no-restart` to skip; without a service, restart the monitor yourself).
`project list` shows what is registered. The config file format, if you edit it by hand:

```json
{"projects": [{"id": "my-app", "name": "My App", "path": "/Users/me/projects/my-app"}]}
```

`id` is optional (default: slug of the folder name, made unique). Folders that do not exist are skipped. A one-off
run can also take `--project <path>` (repeatable) instead.

## 2. Write state.json atomically

Write `.agent-team/state.json` (data contract: see the team-monitor README) to a temp file in the same folder and
rename it over the old one. The monitor picks the change up within about 100 ms (fs.watch) or 3 s (poll), caps the
file at 1 MB, and keeps showing the last good state (with an error) if the JSON is broken.

A decision is answerable only while `approvals.<Dn>.status` is `"open"` and no `answers/<Dn>.json` exists yet.

While a decision is open, the graph shows **"Butuh jawaban owner"** on the node of the agent that asked: red dashed
ring, ripples, a warning triangle, a blinking "Butuh jawaban" tag and a background loop sound, until it is answered.
Name the asker in the optional `approvals.<Dn>.agent` (a key of `agents`, or the name or nick written there, e.g.
`"agent": "Leif"`); without it, or when that agent has no node on the graph, the coordinator's node shows it. The
`ask` command does not set `agent`; add it by hand when a sub-agent asked.

### 2a. Instance names (D22/D23)

- Coordinator: put `"coordinator": {"name": "Sora", "role": "Orchestrator"}` in `meta` (name required, at most 60
  characters; role optional, default "Orchestrator"). The graph's main node shows it; a change is picked up within
  about a second. Every session of the project shows the same coordinator, since it comes from the project's file.
  The monitor also accepts what coordinators often write instead: `meta.coordinator` as a plain string, fields under
  `meta.run` (the artifact monitor's `meta/run` document; a field set directly on `meta` wins), or no coordinator at
  all but an agent with `"desk": "coordinator"` (its `nick` is the name). The documented shape stays the preferred one.
- Sub-agents: start the Agent `description` with `<Name> (<role>): <task>`, e.g.
  `Hiro (Frontend Engineer): offboard button`. Name = one word starting with a capital letter (at most 40
  characters), role = the full standard role without parentheses (at most 60), then a colon. Anything else is shown
  as before (the whole description as the node name).
- Finished sub-agents can be offboarded from the UI; the list is kept in `~/.team-monitor/offboarded.json`
  (written by the monitor only; transcripts are never touched).
- A finished sub-agent nobody offboarded is offboarded by the server `autoOffboardMinutes` after it finished
  (`~/.team-monitor/config.json`, whole number 1-10080, default 60, read at start), listed with reason "auto". A
  sub-agent that runs again before then is kept and its clock restarts. When a session ends (no transcript writes
  for 5 minutes), its sub-agents still running count as finished.

## 3. Wait for an answer or a chat message (background shell task)

Run this with `run_in_background: true`. It exits when an answer or an owner's chat message arrives, so its
completion wakes the coordinator (chat details and the full loop: section 3a):

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
| `--only-new` | Ignore answers and messages already on disk. |
| `--answers-only` | Answers only, as before chat existed: messages do not end it and no heartbeat is written. Use it for any wait that is not the coordinator's one chat watcher (a sub-agent, the `ask` hook's redirect). |

Exit codes: `0` answer or message, `124` timeout, `2` bad usage or missing project folder. `130`/`143`/`129` when
stopped by SIGINT/SIGTERM/SIGHUP.

By default an answer file that is already on disk for a decision still `open` in `state.json` is reported at
once, and so is every unread chat message. That way nothing sent while no wait was running is missed. It also
means the coordinator must record the answer (section 4) or the message (section 3a) before waiting again, or the
same thing is reported again. When both are pending, the answer comes first.

## 3a. Chat with the owner (spec-chat)

The owner types in the monitor's chat panel (phone or Mac). The monitor writes one file per message:

```
<project>/.agent-team/inbox/1763010129883-3fa9c2e17b04.json
{"id": "3fa9c2e17b04", "text": "Sora, tolong cek PR-nya", "sentAt": "2026-11-13T05:02:09.883Z"}
```

`id` is 12 hex characters; `text` is 1 to 4000 characters, line breaks kept. The monitor never edits or deletes
inbox files; leave them in place (they are the record of what was sent).

`wait-answer` (without `--answers-only`) ends on a message and prints, for every unread message, oldest first:

```
inbox/1763010129883-3fa9c2e17b04.json
{
  "id": "3fa9c2e17b04",
  "text": "Sora, tolong cek PR-nya",
  "sentAt": "2026-11-13T05:02:09.883Z"
}
```

**Read / unread.** A message is unread until `state.json` has `chat.<id>` with `"from": "owner"`. The panel shows
"Terkirim" while unread and "Dibaca Sora" once it is recorded.

**The loop** (one chat watcher per project, always running while the session is alive):

1. Start the watcher with `run_in_background: true` (no timeout, or a long one):
   `node ~/projects/team-monitor/app/dist/app.js wait-answer --project ~/projects/my-app`
2. When it ends, read its output:
   - `D<n>.json` + JSON: an answer. Record it (section 4).
   - one or more `inbox/<file>` + JSON: messages. For each, copy it into `state.json` (atomic write, section 2):
     `"chat": {"<id>": {"from": "owner", "text": "<text>", "t": "<sentAt>", "readAt": "<now ISO>"}}`.
     That marks it "Dibaca Sora" in the panel at once.
   - exit `124` (timeout): nothing arrived.
3. Start the watcher again right away (step 1), before doing the work the message asks for, so the next message is
   not missed and the panel keeps saying Sora is listening.
4. Treat the message like a chat message from the owner. Reply in the thread by adding to `state.json`:
   `"chat": {"<reply id>": {"from": "sora", "text": "<reply, plain text, line breaks allowed>", "t": "<now ISO>"}}`.
   Use your own ids for replies (for example `r001`, `r002`); never reuse a message id. Answer in the terminal too
   if the owner is there.

Keep `chat` entries in `state.json` (the 1 MB cap applies; trim old entries to stay well under it). The panel shows
`chat` sorted by `t`; an entry without `from` or `text` is not shown.

**"Sora lagi nggak aktif".** While it waits, `wait-answer` keeps `.agent-team/.watcher`:
`{"pid", "startedAt", "beatAt"}`, rewritten every 10 s. When it ends it adds `"endedAt"` and `"reason"`
(`message`, `answer`, `timeout`, `signal` or `error`). The panel says Sora is listening while a watcher is running
(beat younger than 30 s and the process alive), and for 5 minutes after one ended with `message`, `answer` or
`timeout` (Sora is handling it and starts the next watcher). Otherwise (no watcher ever, stopped by a signal,
killed, stale) it says "Sora lagi nggak aktif, pesan disimpan". So: always restart the watcher within 5 minutes
of a wake (step 3), and do not run a second chat watcher next to it. A sub-agent or anything else that waits for
answers uses `--answers-only` and leaves `.watcher` alone.

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
it like `wait-answer` (answers to other decisions and chat messages do not end it; it writes no heartbeat).

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
  questions are now decisions `Dn..Dm`, to run `wait-answer --project <path> --answers-only` in the background, and to put the
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
(`http://<machine>:3002` works when MagicDNS is on), plus `--host-allow <name>` extras.

Failed logins: 5 per client per 15 minutes, then 429 with `Retry-After`. There is no global cap, so other devices
cannot lock the owner out. The client is the socket address for direct connections, and the last
`X-Forwarded-For` entry (the one `tailscale serve` sets) behind `tailscale serve`.

On macOS the CLI is found at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; override with
`--tailscale-bin <path>` or `TEAM_MONITOR_TAILSCALE_BIN`.
