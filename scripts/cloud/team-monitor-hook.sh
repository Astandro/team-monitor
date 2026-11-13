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
# every problem prints one line on stderr and exits 0.
#
# TEAM_MONITOR_TARBALL=<file> uses a local tarball instead of the download (tests, or before the repo is public).
# TEAM_MONITOR_PORT=<n> starts the monitor on another port than 3002.

REPO="Astandro/team-monitor"
VERSION=""
SHA256=""

say() { printf 'team-monitor: %s\n' "$*" >&2; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else return 1
  fi
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

  if [ -f "$dest/app.js" ] && [ "$(cat "$dest/.sha256" 2>/dev/null)" = "$SHA256" ]; then
    : # this version is already unpacked from a verified tarball
  else
    tmp=$(mktemp -d "$apps/.tmp.XXXXXX" 2>/dev/null) || { say "cannot create a temp folder in $apps"; return 0; }
    # Only ever removes the temp folder made just above.
    cleanup() { case "$tmp" in "$apps"/.tmp.*) rm -rf "$tmp" ;; esac; }

    if [ -n "${TEAM_MONITOR_TARBALL:-}" ]; then
      tarball=$TEAM_MONITOR_TARBALL
      [ -f "$tarball" ] || { say "TEAM_MONITOR_TARBALL $tarball not found; not started"; cleanup; return 0; }
    else
      command -v curl >/dev/null 2>&1 || { say "curl not found; not started"; cleanup; return 0; }
      tarball="$tmp/$name.tgz"
      url="https://github.com/$REPO/releases/download/v$VERSION/$name.tgz"
      if ! curl -fsSL --retry 2 --connect-timeout 10 --max-time 120 -o "$tarball" "$url" 2>/dev/null; then
        say "download of $url failed; not started"; cleanup; return 0
      fi
    fi

    sum=$(sha256_of "$tarball") || { say "no sha256sum or shasum; not started"; cleanup; return 0; }
    if [ "$sum" != "$SHA256" ]; then
      say "sha256 mismatch for $name.tgz (got $sum); not installed, not started"; cleanup; return 0
    fi

    # Every member must be inside team-monitor-<version>/: no absolute paths, no "..", no links.
    list=$(tar -tzf "$tarball" 2>/dev/null) || { say "cannot read $name.tgz; not started"; cleanup; return 0; }
    bad=$(printf '%s\n' "$list" | while IFS= read -r m; do
      case "$m" in
        /*|..|../*|*/..|*/../*) echo x ;;
        "$name"|"$name"/|"$name"/*) ;;
        *) echo x ;;
      esac
    done)
    links=$(tar -tvzf "$tarball" 2>/dev/null | cut -c1 | grep -c '^[lh]')
    if [ -n "$bad" ] || [ "$links" != "0" ]; then
      say "$name.tgz has members outside $name/ or links; not installed, not started"; cleanup; return 0
    fi

    mkdir "$tmp/x" && tar -xzf "$tarball" -C "$tmp/x" 2>/dev/null || { say "cannot unpack $name.tgz; not started"; cleanup; return 0; }
    [ -f "$tmp/x/$name/app.js" ] || { say "$name.tgz has no app.js; not started"; cleanup; return 0; }
    printf '%s\n' "$SHA256" > "$tmp/x/$name/.sha256"
    if [ -e "$dest" ]; then mv "$dest" "$tmp/old" || { say "cannot replace $dest; not started"; cleanup; return 0; }; fi
    mv "$tmp/x/$name" "$dest" || { say "cannot move the release into $dest; not started"; cleanup; return 0; }
    cleanup
  fi

  project=${CLAUDE_PROJECT_DIR:-$(pwd)}
  if [ -n "${TEAM_MONITOR_PORT:-}" ]; then
    node "$dest/app.js" cloud start --project "$project" --port "$TEAM_MONITOR_PORT" </dev/null || say "cloud start failed (exit $?)"
  else
    node "$dest/app.js" cloud start --project "$project" </dev/null || say "cloud start failed (exit $?)"
  fi
  return 0
}

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
install_and_start
exit 0
