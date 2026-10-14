#!/usr/bin/env bash
#
# Build mind-<version>.pkg — run this ON A MAC (pkgbuild, productbuild,
# lipo and codesign exist only there). D-056.
#
#   packaging/macos/build-pkg.sh [--arm64 <bin>] [--x64 <bin>]
#
# The two binaries are cross-compiled anywhere with `bun run build:macos`
# (they land in dist/). Without --arm64/--x64 this script looks there, and
# builds them itself if bun is on PATH and they are missing.
#
# Signing is optional and read from the environment, never from a file here:
#   MIND_APP_IDENTITY        "Developer ID Application: …"  → codesign the binary (hardened runtime)
#   MIND_INSTALLER_IDENTITY  "Developer ID Installer: …"    → sign the .pkg
#   MIND_NOTARY_PROFILE      a `xcrun notarytool store-credentials` profile → notarize + staple
# Without the first, the binary is signed ad hoc — enough for the Mac that
# built it; another Mac's Gatekeeper will ask before running an unnotarized pkg.
#
# What the package installs: /usr/local/bin/mind. Nothing else — no data, no daemon, no LaunchAgent, no other
# name for the command. After installing it opens Terminal with `mind setup` for the person logged in.
set -euo pipefail

# `setting APP_IDENTITY` is $MIND_APP_IDENTITY. Empty counts as unset. The lookup is `${!name}` because macOS ships
# bash 3.2.
setting() {
  local name="MIND_$1"
  printf '%s' "${!name:-}"
}

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
arm64="$root/dist/mind-darwin-arm64"
x64="$root/dist/mind-darwin-x64"
while [ $# -gt 0 ]; do
  case "$1" in
    --arm64) arm64="$2"; shift 2 ;;
    --x64) x64="$2"; shift 2 ;;
    *) echo "usage: $0 [--arm64 <bin>] [--x64 <bin>]" >&2; exit 2 ;;
  esac
done

app_identity="$(setting APP_IDENTITY)"
installer_identity="$(setting INSTALLER_IDENTITY)"
notary_profile="$(setting NOTARY_PROFILE)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-pkg.sh: pkgbuild and productbuild exist only on macOS; run this on a Mac." >&2
  exit 2
fi
for tool in pkgbuild productbuild lipo codesign; do
  command -v "$tool" >/dev/null || { echo "build-pkg.sh: $tool not found (install the Xcode command line tools)" >&2; exit 2; }
done

version="$(sed -n 's/^export const VERSION = "\(.*\)";$/\1/p' "$root/src/version.ts")"
[ -n "$version" ] || { echo "build-pkg.sh: could not read the version from src/version.ts" >&2; exit 1; }

if [ ! -f "$arm64" ] || [ ! -f "$x64" ]; then
  command -v bun >/dev/null || { echo "build-pkg.sh: $arm64 or $x64 is missing and bun is not on PATH to build them" >&2; exit 1; }
  (cd "$root" && bun run build:macos)
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/root/usr/local/bin" "$work/resources"

bin="$work/root/usr/local/bin/mind"
lipo -create "$arm64" "$x64" -output "$bin"
chmod 755 "$bin"

if [ -n "$app_identity" ]; then
  codesign --force --options runtime --timestamp --sign "$app_identity" "$bin"
else
  codesign --force --sign - "$bin"
fi
codesign --verify "$bin"
"$bin" --version | grep -qx "$version" || { echo "build-pkg.sh: the binary does not report $version" >&2; exit 1; }

cp "$here/resources/welcome.html" "$here/resources/conclusion.html" "$work/resources/"
cp "$root/LICENSE" "$work/resources/LICENSE.txt"
sed "s/@VERSION@/$version/g" "$here/distribution.xml" > "$work/distribution.xml"

pkgbuild \
  --root "$work/root" \
  --identifier com.bemindlabs.mind \
  --version "$version" \
  --install-location / \
  --scripts "$here/scripts" \
  "$work/mind-component.pkg"

out="$root/dist/mind-$version.pkg"
# `${sign[@]+…}` below, not `"${sign[@]}"`: macOS ships bash 3.2, where an
# empty array under `set -u` is an unbound variable.
sign=()
if [ -n "$installer_identity" ]; then sign=(--sign "$installer_identity"); fi
productbuild \
  --distribution "$work/distribution.xml" \
  --resources "$work/resources" \
  --package-path "$work" \
  ${sign[@]+"${sign[@]}"} \
  "$out"

if [ -n "$notary_profile" ]; then
  xcrun notarytool submit "$out" --keychain-profile "$notary_profile" --wait
  xcrun stapler staple "$out"
fi

echo "built $out"
if [ -z "$installer_identity" ]; then
  echo "  unsigned: open it with right-click → Open, or sign it (see the header of this script)."
fi
exit 0
