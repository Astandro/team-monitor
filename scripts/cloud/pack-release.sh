#!/bin/sh
# Pack the built app (app/dist) the way the release workflow does:
#   <out>/team-monitor-<version>.tgz         one top folder, team-monitor-<version>/, holding app/dist's files
#   <out>/team-monitor-<version>.tgz.sha256  "<sha256>  team-monitor-<version>.tgz"
#   <out>/team-monitor-<version>.pin.txt     the two lines a project pins in team-monitor-hook.sh
# and prints the two pin lines.
#
# Usage: scripts/cloud/pack-release.sh [out-dir]       (default: dist/release in the repo, git-ignored)
# Env:   TEAM_MONITOR_DIST     folder to pack instead of app/dist (tests)
#        TEAM_MONITOR_VERSION  version instead of app/package.json's
# Build first: pnpm run build:app
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
dist=${TEAM_MONITOR_DIST:-$repo/app/dist}
out=${1:-$repo/dist/release}
version=${TEAM_MONITOR_VERSION:-$(node -e 'process.stdout.write(String(require(process.argv[1]).version))' "$repo/app/package.json")}

case "$version" in
  ''|*[!0-9A-Za-z.+-]*) echo "pack-release: bad version '$version'" >&2; exit 1 ;;
esac
if [ ! -f "$dist/app.js" ]; then
  echo "pack-release: $dist/app.js not found (run pnpm run build:app first)" >&2
  exit 1
fi

name="team-monitor-$version"
mkdir -p "$out"
out=$(cd "$out" && pwd)

stage=$(mktemp -d "${TMPDIR:-/tmp}/tm-pack.XXXXXX")
cleanup() {
  case "$stage" in
    "${TMPDIR:-/tmp}"/tm-pack.*) rm -rf "$stage" ;;
  esac
}
trap cleanup EXIT INT TERM

mkdir "$stage/$name"
cp -R "$dist/." "$stage/$name/"
# No symlinks in the archive (the hook refuses them).
if [ -n "$(find "$stage/$name" -type l | head -n 1)" ]; then
  echo "pack-release: $dist contains symlinks; refusing to pack" >&2
  exit 1
fi
(cd "$stage" && COPYFILE_DISABLE=1 tar -czf "$out/$name.tgz" "$name")

if command -v sha256sum >/dev/null 2>&1; then
  sum=$(sha256sum "$out/$name.tgz" | cut -d' ' -f1)
else
  sum=$(shasum -a 256 "$out/$name.tgz" | cut -d' ' -f1)
fi
printf '%s  %s\n' "$sum" "$name.tgz" > "$out/$name.tgz.sha256"
printf 'VERSION="%s"\nSHA256="%s"\n' "$version" "$sum" > "$out/$name.pin.txt"

cat "$out/$name.pin.txt"
