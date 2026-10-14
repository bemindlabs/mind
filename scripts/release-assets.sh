#!/bin/sh
# Turn the built binaries of one release into the files that get published. Local, no network, no secret:
# the release workflow calls this, and `test/packaging/release-assets.test.ts` runs it on a fake dist directory.
#
#   sh scripts/release-assets.sh <dir>
#
# <dir> holds one binary per platform named mind-<os>-<arch> (for example mind-linux-x64), install.sh and the
# SBOM mind-sbom.spdx.json (so the SBOM is listed in SHA256SUMS and is covered by its signature). It
# writes ONE SHA256SUMS that lists every binary and install.sh, sorted. It refuses an empty directory, a file that is not named mind-<os>-<arch>, and a
# platform other than linux or darwin on x64 or arm64.

set -eu

dir="${1:-}"
[ -n "$dir" ] && [ -d "$dir" ] || { echo "release-assets.sh: give the directory of built binaries" >&2; exit 2; }

n=0
for f in "$dir"/mind-*; do
  [ -e "$f" ] || break
  name="$(basename "$f")"
  case "$name" in
    mind-sbom.spdx.json) continue ;;
    mind-linux-x64 | mind-linux-arm64 | mind-darwin-x64 | mind-darwin-arm64) : ;;
    *) echo "release-assets.sh: $name is not mind-<linux|darwin>-<x64|arm64>" >&2; exit 1 ;;
  esac
  [ -s "$f" ] || { echo "release-assets.sh: $name is empty" >&2; exit 1; }
  n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "release-assets.sh: no mind-<os>-<arch> binary in $dir" >&2; exit 1; }


cd "$dir"
files="$(ls | grep -E "^mind-(linux|darwin)-(x64|arm64)\$" | sort)"
for extra in install.sh mind-sbom.spdx.json; do
  [ ! -f "$extra" ] || files="$files
$extra"
done
echo "$files" | xargs sh -c 'if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi' _ > SHA256SUMS
echo "release-assets.sh: $n platform(s), $(grep -c . SHA256SUMS) line(s) in SHA256SUMS"
