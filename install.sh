#!/bin/sh
# Install the mind binary from a release. Needs no root, changes nothing outside the install directory.
#
#   curl --proto '=https' -fsSL https://github.com/bemindlabs/mind/releases/download/<tag>/install.sh | sh
#   sh install.sh --dry-run        say what would happen, change nothing
#   sh install.sh --uninstall      remove the binary (never your data: that is `mind erase`)
#
# Everything below is inside main(), and the last line of the file calls it: a download that is cut short
# runs nothing, because the call never arrives.

set -eu

# The first release that is signed. From this tag on, install.sh REFUSES an unsigned or unverifiable release
# (a signature it cannot check is not a pass). Older releases are checked by checksum alone, and it says so.
FIRST_SIGNED_TAG="v0.11.0"

usage() {
  cat <<'EOF'
install.sh — install the mind binary from a release; no root, nothing outside the install directory.

  sh install.sh [--dry-run] [--uninstall] [--help]

  MIND_VERSION            the release tag to install, like v0.11.0 (default: the newest release, prereleases included)
  MIND_INSTALL_DIR        where the binary goes (default: ~/.local/bin)
  MIND_REQUIRE_SIGNATURE  1 = refuse unless SHA256SUMS has a cosign signature that verifies (always so for
                          releases from the first signed one on)
  MIND_COSIGN_IDENTITY    regexp of the workflow identity that signs SHA256SUMS
  MIND_BASE_URL, MIND_API_URL, MIND_REPO   where releases come from (tests point these at file:// directories)

The release carries every binary as mind-<os>-<arch>. The binary is checked against SHA256SUMS BEFORE anything is installed: a mismatch, an unlisted file, a
missing list or an unknown version refuses and leaves the install directory as it was.
--uninstall removes the binary, never your data.
EOF
}

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# A tag is v<major>.<minor>.<patch> with an optional -/+/. suffix of letters, digits, dots and dashes: nothing else.
valid_tag() {
  case "$1" in
    "" | *[!0-9A-Za-z.+-]*) return 1 ;;
  esac
  printf '%s\n' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$'
}

# true when tag $1 is the same or later than tag $2, comparing major.minor.patch only
tag_at_or_after() {
  a="$(printf '%s' "$1" | sed 's/^v//; s/[-+].*//')"
  b="$(printf '%s' "$2" | sed 's/^v//; s/[-+].*//')"
  awk -v a="$a" -v b="$b" 'BEGIN { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'
}

hint() {
  say ""
  say "If mind later refuses to create its key because a parent directory is group-writable"
  say "(a umask of 0002 makes new directories so), run: chmod go-w <that directory>"
  um="$(umask)"
  # The second digit from the right is the group's: a group write bit is allowed when it is 0, 1, 4 or 5.
  g="$(printf '%s' "$um" | sed 's/.*\(.\)\(.\)$/\1/')"
  case "$g" in
    0 | 1 | 4 | 5) say "Your umask is $um, so directories you create are group-writable: use \`umask 022\` in the shell that runs mind, or chmod go-w the directory." ;;
  esac
}

# fetch URL OUT: 0 ok, 44 the file is not there (404, or a missing file://), 1 anything else. Errors are shown.
fetch() {
  proto="=https"
  [ -z "${MIND_BASE_URL:-}${MIND_API_URL:-}" ] || proto="=https,file"
  code="$(curl --proto "$proto" --proto-redir "=https" --silent --show-error --location --output "$2" --write-out '%{http_code}' "$1" 2>"$2.err")" && rc=0 || rc=$?
  case "$rc:$code" in
    0:200 | 0:000) rm -f "$2.err"; return 0 ;;
    37:* | 0:404) rm -f "$2.err"; return 44 ;;
    *) printf 'install.sh: could not fetch %s (curl exit %s, http %s)\n' "$1" "$rc" "$code" >&2; cat "$2.err" >&2; rm -f "$2.err"; return 1 ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "needs sha256sum or shasum to check the download"; fi
}

TMP=""
STAGE=""
cleanup() {
  [ -z "$STAGE" ] || rm -f "$STAGE"
  [ -z "$TMP" ] || rm -rf "$TMP"
}

# Clean up on any exit; on INT and TERM clean up and STOP (130 / 143), never carry on with the install.
arm_traps() {
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT
  trap 'cleanup; exit 143' TERM
}

main() {
  DRY=0
  UNINSTALL=0
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY=1 ;;
      --uninstall) UNINSTALL=1 ;;
      -h | --help) usage; return 0 ;;
      *) echo "install.sh: unknown option $arg (try --help)" >&2; return 2 ;;
    esac
  done

  REPO="${MIND_REPO:-bemindlabs/mind}"
  BASE="${MIND_BASE_URL:-https://github.com/$REPO/releases/download}"
  API="${MIND_API_URL:-https://api.github.com/repos/$REPO/releases}"
  [ -n "${MIND_INSTALL_DIR:-}" ] || [ -n "${HOME:-}" ] || die "HOME is not set; set MIND_INSTALL_DIR"
  DIR="${MIND_INSTALL_DIR:-${HOME:-}/.local/bin}"
  IDENTITY="${MIND_COSIGN_IDENTITY:-^https://github.com/bemindlabs/mind(-dev)?/\\.github/workflows/release\\.yml@refs/tags/v.*\$}"
  ISSUER="https://token.actions.githubusercontent.com"

  if [ "$(id -u)" = 0 ] && [ "${MIND_ALLOW_ROOT:-0}" != 1 ]; then
    die "run this as the user who will use mind, not as root: it installs under your home and needs no root. (MIND_ALLOW_ROOT=1 overrides.)"
  fi

  if [ "$UNINSTALL" = 1 ]; then
    if [ -e "$DIR/mind" ] || [ -L "$DIR/mind" ]; then
      if [ "$DRY" = 1 ]; then say "would remove $DIR/mind"; else rm -f "$DIR/mind"; say "removed $DIR/mind"; fi
    fi
    say "Your data was not touched. Removing it is \`mind erase\` (a typed phrase), not an uninstall."
    return 0
  fi

  command -v curl >/dev/null 2>&1 || die "needs curl"

  case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) die "no release build for $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "no release build for $(uname -m)" ;;
  esac

  VERSION="${MIND_VERSION:-}"
  if [ -n "$VERSION" ]; then
    case "$VERSION" in [0-9]*) VERSION="v$VERSION" ;; esac
    valid_tag "$VERSION" || die "MIND_VERSION must look like v0.11.0 (digits and dots, an optional -suffix); refusing that value. Nothing was downloaded."
  else
    TMP="$(mktemp -d "${TMPDIR:-/tmp}/mind-install.XXXXXX")"
    arm_traps
    fetch "$API" "$TMP/releases.json" || die "could not ask GitHub for the newest release; set MIND_VERSION=<tag>"
    VERSION="$(sed -n 's/.*"tag_name"[ ]*:[ ]*"\([^"]*\)".*/\1/p' "$TMP/releases.json" | head -n 1)"
    [ -n "$VERSION" ] || die "GitHub listed no release; set MIND_VERSION=<tag>"
    valid_tag "$VERSION" || die "GitHub answered a release tag that is not a version; refusing it. Nothing was downloaded."
  fi

  REQUIRE=0
  [ "${MIND_REQUIRE_SIGNATURE:-0}" != 1 ] || REQUIRE=1
  if tag_at_or_after "$VERSION" "$FIRST_SIGNED_TAG"; then REQUIRE=1; fi

  say "mind $VERSION for $OS/$ARCH"
  say "  from  $BASE/$VERSION"
  say "  to    $DIR/mind  (no root needed)"
  if [ "$REQUIRE" = 1 ]; then say "  the signature on SHA256SUMS is required"; fi
  if [ "$DRY" = 1 ]; then
    say "Dry run: nothing was downloaded or changed."
    hint
    return 0
  fi

  if [ -z "$TMP" ]; then
    TMP="$(mktemp -d "${TMPDIR:-/tmp}/mind-install.XXXXXX")"
    arm_traps
  fi

  fetch "$BASE/$VERSION/SHA256SUMS" "$TMP/SHA256SUMS" || die "$VERSION has no SHA256SUMS (or the version does not exist): nothing was checked, nothing was installed"

  ASSET="mind-$OS-$ARCH"
  rc=0
  fetch "$BASE/$VERSION/$ASSET" "$TMP/$ASSET" || rc=$?
  [ "$rc" != 44 ] || die "$VERSION has no $ASSET: nothing was installed"
  [ "$rc" = 0 ] || die "could not download $ASSET: nothing was installed"

  WANT="$(awk -v n="$ASSET" '{ f=$2; sub(/^\*/, "", f); if (f == n) { print $1; exit } }' "$TMP/SHA256SUMS")"
  [ -n "$WANT" ] || die "SHA256SUMS does not list $ASSET: not installed"
  GOT="$(sha256_of "$TMP/$ASSET")"
  [ "$GOT" = "$WANT" ] || die "checksum mismatch for $ASSET (got $(printf '%s' "$GOT" | cut -c1-12)…, the list says $(printf '%s' "$WANT" | cut -c1-12)…): not installed"
  say "checksum ok ($ASSET)"

  # The signature on SHA256SUMS. When it is required, anything short of a verified signature refuses.
  signed=0
  why=""
  if ! command -v cosign >/dev/null 2>&1; then
    why="cosign is not installed"
  else
    rc=0; fetch "$BASE/$VERSION/SHA256SUMS.sig" "$TMP/SHA256SUMS.sig" || rc=$?
    if [ "$rc" = 44 ]; then why="this release has no SHA256SUMS.sig"
    elif [ "$rc" != 0 ]; then why="SHA256SUMS.sig could not be fetched"
    else
      rc=0; fetch "$BASE/$VERSION/SHA256SUMS.pem" "$TMP/SHA256SUMS.pem" || rc=$?
      if [ "$rc" = 44 ]; then why="this release has no SHA256SUMS.pem"
      elif [ "$rc" != 0 ]; then why="SHA256SUMS.pem could not be fetched"
      elif cosign verify-blob --certificate-identity-regexp "$IDENTITY" --certificate-oidc-issuer "$ISSUER" \
        --signature "$TMP/SHA256SUMS.sig" --certificate "$TMP/SHA256SUMS.pem" "$TMP/SHA256SUMS" >/dev/null 2>"$TMP/cosign.err"; then
        signed=1
      else
        why="the signature does not verify for the release workflow ($(head -n 1 "$TMP/cosign.err"))"
      fi
    fi
  fi
  if [ "$signed" = 1 ]; then
    say "signature ok (cosign, the release workflow)"
  elif [ "$REQUIRE" = 1 ]; then
    die "a verified signature is required for $VERSION and there is none: $why. Not installed."
  else
    say "WARNING: the signature on SHA256SUMS was NOT checked ($why). The checksum comes from the same place as the file: it catches corruption, not a hostile release."
  fi

  mkdir -p "$DIR"
  STAGE="$(mktemp "$DIR/.mind-install.XXXXXX")"
  cp "$TMP/$ASSET" "$STAGE"
  chmod 755 "$STAGE"
  mv -f "$STAGE" "$DIR/mind"
  STAGE=""
  say "installed $DIR/mind"
  case ":$PATH:" in *":$DIR:"*) : ;; *) say "note: $DIR is not on your PATH" ;; esac
  hint
}

main "$@"
