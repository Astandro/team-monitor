#!/bin/sh
# team-monitor for Claude Code cloud sessions: copy this file into your project (for example
# .claude/hooks/team-monitor-hook.sh), set VERSION and SHA256 below from the release you want (the release notes and
# the team-monitor-<version>.pin.txt asset list both lines), and call it from a SessionStart hook in the project's
# .claude/settings.json:
#
#   {"hooks": {"SessionStart": [{"hooks": [{"type": "command",
#     "command": "sh \"$CLAUDE_PROJECT_DIR/.claude/hooks/team-monitor-hook.sh\""}]}]}}
#
# In a cloud session (CLAUDE_CODE_REMOTE=true) it installs the pinned release into ~/.team-monitor/app/<version>/
# (downloaded once, sha256 checked before unpacking) and runs `cloud start`, which starts the monitor and, when
# TEAM_MONITOR_HUB_URL is set, the forwarder to your hub. Anywhere else it does nothing. It never fails the session:
# every problem prints one line on stderr and exits 0. The whole run (download, verify, unpack, cloud start) has a
# 45 s budget, well inside the 60 s SessionStart hook timeout; past it the hook stops what it is doing, removes its
# temp folder, prints one line and exits 0.
#
# TEAM_MONITOR_TARBALL=<file> uses a local tarball instead of the download (tests, or before a release exists).
# TEAM_MONITOR_PORT=<n> starts the monitor on another port than 3002.
# TEAM_MONITOR_HOOK_BUDGET=<seconds> lowers the 45 s budget (tests).

REPO="Astandro/team-monitor"
VERSION=""
SHA256=""

BUDGET=45        # seconds for the whole hook
START_RESERVE=8  # do not begin `cloud start` (own budget 4 s) with less time than this left

say() { printf 'team-monitor: %s\n' "$*" >&2; }

now() { date +%s; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else return 1
  fi
}

# Runs a command in the background and waits for it, so a TERM from the watchdog reaches the worker's trap at
# once (a trap waits for a foreground command to finish) and the trap can stop the command.
child=""
run() {
  "$@" &
  child=$!
  wait "$child"
  rc=$?
  child=""
  return "$rc"
}

tmp=""
apps=""
# Only ever removes a temp folder this hook made inside $apps.
cleanup() {
  case "$tmp" in
    "$apps"/.tmp.*) [ -n "$apps" ] && rm -rf "$tmp" ;;
  esac
  tmp=""
}

# Every member must be a regular file or a directory, without setuid, setgid or sticky bits (FIFOs, devices,
# symlinks and hardlinks are refused). `tar -tv` starts each line with the mode string in both GNU tar and bsdtar.
members_safe() {
  tar -tvzf "$1" 2>/dev/null | awk '
    { n++ }
    !/^[-d][r-][w-][x-][r-][w-][x-][r-][w-][x-] / { bad = 1 }
    END { exit (bad || n == 0) ? 1 : 0 }'
}

install_and_start() {
  case "$VERSION" in
    ''|*[!0-9A-Za-z.+-]*) say "set VERSION in $0 to a release version"; return 0 ;;
  esac
  case "$SHA256" in
    *[!0-9a-f]*|'') say "set SHA256 in $0 to the release's sha256 (64 lowercase hex)"; return 0 ;;
  esac
  if [ ${#SHA256} -ne 64 ]; then say "SHA256 in $0 must be 64 hex characters"; return 0; fi
  command -v node >/dev/null 2>&1 || { say "node not found; not started"; return 0; }
  command -v tar >/dev/null 2>&1 || { say "tar not found; not started"; return 0; }

  if [ -n "${TEAM_MONITOR_HOME:-}" ]; then home=$TEAM_MONITOR_HOME
  elif [ -n "${HOME:-}" ]; then home="$HOME/.team-monitor"
  else say "HOME is not set; not started"; return 0
  fi
  apps="$home/app"
  dest="$apps/$VERSION"
  name="team-monitor-$VERSION"
  mkdir -p "$apps" 2>/dev/null && chmod 700 "$home" 2>/dev/null || { say "cannot create $apps"; return 0; }

  # Temp folders of earlier runs that were killed (SIGKILL cannot be trapped) and are older than 10 minutes.
  for old in "$apps"/.tmp.*; do
    [ -d "$old" ] || continue
    if [ -n "$(find "$old" -prune -mmin +10 2>/dev/null)" ]; then rm -rf "$old"; fi
  done

  if [ -f "$dest/app.js" ] && [ "$(cat "$dest/.sha256" 2>/dev/null)" = "$SHA256" ]; then
    : # this version is already unpacked from a verified tarball
  else
    umask 022
    tmp=$(mktemp -d "$apps/.tmp.XXXXXX" 2>/dev/null) || { tmp=""; say "cannot create a temp folder in $apps"; return 0; }

    if [ -n "${TEAM_MONITOR_TARBALL:-}" ]; then
      tarball=$TEAM_MONITOR_TARBALL
      [ -f "$tarball" ] || { say "TEAM_MONITOR_TARBALL $tarball not found; not started"; cleanup; return 0; }
    else
      command -v curl >/dev/null 2>&1 || { say "curl not found; not started"; cleanup; return 0; }
      tarball="$tmp/$name.tgz"
      url="https://github.com/$REPO/releases/download/v$VERSION/$name.tgz"
      # One attempt (no retries) that leaves time for verify, unpack and cloud start; the next session retries.
      left=$((deadline - $(now) - START_RESERVE - 2))
      [ "$left" -ge 1 ] || left=1
      if ! run curl -fsSL --proto '=https' --connect-timeout 10 --max-time "$left" -o "$tarball" "$url" 2>/dev/null; then
        say "download of $url failed; not started"; cleanup; return 0
      fi
    fi

    sum=$(sha256_of "$tarball") || { say "no sha256sum or shasum; not started"; cleanup; return 0; }
    if [ "$sum" != "$SHA256" ]; then
      say "sha256 mismatch for $name.tgz (got $sum); not installed, not started"; cleanup; return 0
    fi

    # Every member must be inside team-monitor-<version>/: no absolute paths, no "..".
    list=$(tar -tzf "$tarball" 2>/dev/null) || { say "cannot read $name.tgz; not started"; cleanup; return 0; }
    bad=$(printf '%s\n' "$list" | while IFS= read -r m; do
      case "$m" in
        /*|..|../*|*/..|*/../*) echo x ;;
        "$name"|"$name"/|"$name"/*) ;;
        *) echo x ;;
      esac
    done)
    if [ -n "$bad" ]; then
      say "$name.tgz has members outside $name/; not installed, not started"; cleanup; return 0
    fi
    if ! members_safe "$tarball"; then
      say "$name.tgz has members that are not plain files or folders (links, devices, FIFOs, setuid/setgid/sticky); not installed, not started"
      cleanup; return 0
    fi

    # Owner and permission bits from the archive are not kept: files belong to the current user, umask 022.
    mkdir "$tmp/x" && run tar -x --no-same-owner --no-same-permissions -z -f "$tarball" -C "$tmp/x" 2>/dev/null \
      || { say "cannot unpack $name.tgz; not started"; cleanup; return 0; }
    # Belt and braces after unpacking: still only files and folders, then plain modes.
    if [ -n "$(find "$tmp/x" \( ! -type f ! -type d \) -o -perm -1000 -o -perm -2000 -o -perm -4000 2>/dev/null | head -n 1)" ]; then
      say "$name.tgz unpacked to something other than plain files and folders; not installed, not started"; cleanup; return 0
    fi
    chmod -R u=rwX,go=rX "$tmp/x" 2>/dev/null || { say "cannot set modes in $tmp; not started"; cleanup; return 0; }
    [ -f "$tmp/x/$name/app.js" ] || { say "$name.tgz has no app.js; not started"; cleanup; return 0; }
    printf '%s\n' "$SHA256" > "$tmp/x/$name/.sha256"
    if [ -e "$dest" ]; then mv "$dest" "$tmp/old" || { say "cannot replace $dest; not started"; cleanup; return 0; }; fi
    mv "$tmp/x/$name" "$dest" || { say "cannot move the release into $dest; not started"; cleanup; return 0; }
    cleanup
  fi

  if [ $((deadline - $(now))) -lt "$START_RESERVE" ]; then
    say "time budget of ${BUDGET}s nearly used up before cloud start; not started"; return 0
  fi
  project=${CLAUDE_PROJECT_DIR:-$(pwd)}
  if [ -n "${TEAM_MONITOR_PORT:-}" ]; then
    run node "$dest/app.js" cloud start --project "$project" --port "$TEAM_MONITOR_PORT" </dev/null || say "cloud start failed (exit $?)"
  else
    run node "$dest/app.js" cloud start --project "$project" </dev/null || say "cloud start failed (exit $?)"
  fi
  return 0
}

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

case "${TEAM_MONITOR_HOOK_BUDGET:-}" in
  ''|*[!0-9]*) ;;
  *) [ "$TEAM_MONITOR_HOOK_BUDGET" -ge 1 ] && [ "$TEAM_MONITOR_HOOK_BUDGET" -lt "$BUDGET" ] && BUDGET=$TEAM_MONITOR_HOOK_BUDGET ;;
esac
deadline=$(( $(now) + BUDGET ))

# The worker does the install and start; on TERM (from the watchdog or from this shell's trap) it stops the command
# it is waiting for, removes its temp folder and exits 124.
(
  trap '[ -n "$child" ] && kill -TERM "$child" 2>/dev/null; cleanup; exit 124' TERM HUP INT
  install_and_start
  exit 0
) &
worker=$!

# The watchdog ends the worker at the deadline. Its own stdio is /dev/null so it never holds the hook's output open.
(
  trap '[ -n "$s" ] && kill "$s" 2>/dev/null; exit 0' TERM
  s=""
  sleep "$BUDGET" &
  s=$!
  wait "$s"
  kill -TERM "$worker" 2>/dev/null
) </dev/null >/dev/null 2>&1 &
watchdog=$!

stop_all() {
  kill -TERM "$worker" 2>/dev/null && wait "$worker" 2>/dev/null
  kill -TERM "$watchdog" 2>/dev/null
  exit 0
}
trap stop_all TERM HUP INT

wait "$worker"
status=$?
kill -TERM "$watchdog" 2>/dev/null
if [ "$status" -eq 124 ]; then
  say "did not finish within ${BUDGET}s (download, verify, unpack or cloud start); stopped, not started"
fi
exit 0
