#!/usr/bin/env bash
# run1.sh — one codex trial for S12.6 probes. Never prints or stores the LiteLLM key.
#
# env inputs:
#   NAME     run name (dir W/runs/NAME; an existing dir is moved aside, never deleted)
#   SANDBOX  read-only | workspace-write | danger-full-access
#   JAIL     1 = wrap codex in landlock-jail.py (--rw RUN --rw /dev --tcp-port 10400); 0 = no jail
#   HOMEDIR  CODEX home root to use (persistent across trials); empty = fresh copy of home-template inside RUN
#   PROMPT   the prompt
#   CANARY   1 = put MIND_PROBE_SECRET_KEY / MIND_PROBE_PLAIN (random) into the child env
# args: extra codex args placed right after `exec --skip-git-repo-check --sandbox X` (e.g. -c ...)
set -uo pipefail
W="${SCRATCH:?set SCRATCH}"/s12.6/codex
NODE_BIN=$HOME/.nvm/versions/node/v22.21.1/bin
: "${NAME:?}" "${SANDBOX:?}" "${PROMPT:?}"
JAIL=${JAIL:-0}; CANARY=${CANARY:-0}; HOMEDIR=${HOMEDIR:-}

RUN=$W/runs/$NAME
[ -e "$RUN" ] && mv "$RUN" "$RUN.prev-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$RUN/work"
cp -a "$W/fixture/." "$RUN/work/"
if [ -z "$HOMEDIR" ]; then cp -a "$W/home-template" "$RUN/home"; HOMEDIR=$RUN/home; fi
mkdir -p "$HOMEDIR/tmp"
(cd "$RUN/work" && find . -type f -printf '%P %s\n' | sort > "$RUN/ls-before.txt"; sha256sum * > "$RUN/sha-before.txt")
cp "$HOMEDIR/.codex/config.toml" "$RUN/config-before.toml"

PREFIX=()
JAIL_RW=("$RUN")
case "$HOMEDIR" in "$RUN"/*) ;; *) JAIL_RW+=("$HOMEDIR") ;; esac
if [ "$JAIL" = 1 ]; then
  PREFIX=(python3 "$W/landlock-jail.py")
  for d in "${JAIL_RW[@]}"; do PREFIX+=(--rw "$d"); done
  PREFIX+=(--rw /dev --tcp-port 10400 --)
fi
CMD=("${PREFIX[@]}" "$NODE_BIN/codex" exec --skip-git-repo-check --sandbox "$SANDBOX" "$@" --output-last-message "$RUN/answer.txt" "$PROMPT")

CAN_ENV=()
if [ "$CANARY" = 1 ]; then
  S=$(python3 -c 'import secrets;print("sk"+secrets.token_hex(12))'); P=$(python3 -c 'import secrets;print("pl"+secrets.token_hex(12))')
  printf 'MIND_PROBE_SECRET_KEY=%s\nMIND_PROBE_PLAIN=%s\n' "$S" "$P" > "$RUN/canaries.txt"
  CAN_ENV=(MIND_PROBE_SECRET_KEY="$S" MIND_PROBE_PLAIN="$P")
fi

LITELLM_KEY=$(grep -oP '^LITELLM_MASTER_KEY=\K.*' "$HOME/.secrets/.env.litellm" | tr -d '"')
[ -n "$LITELLM_KEY" ] || { echo "LITELLM_MASTER_KEY not found" >&2; exit 2; }

cd "$RUN/work" || exit 2
START=$(date +%s.%N)
env -i \
  HOME="$HOMEDIR" CODEX_HOME="$HOMEDIR/.codex" TMPDIR="$HOMEDIR/tmp" \
  PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb SHELL=/bin/bash \
  LITELLM_API_KEY="$LITELLM_KEY" "${CAN_ENV[@]}" \
  timeout -k 15 600 strace -f -qq -s 128 -e trace=connect,sendto -o "$RUN/connects.log" "${CMD[@]}" \
  > "$RUN/stdout.txt" 2> "$RUN/stderr.txt" < /dev/null
EXIT=$?
END=$(date +%s.%N)
cd "$W"

# secret hygiene: redact the key anywhere under RUN (and the persistent home, if outside RUN)
HITS=0
for d in "$RUN" "$HOMEDIR"; do
  while IFS= read -r f; do
    HITS=$((HITS+1))
    K="$LITELLM_KEY" python3 -c '
import os, sys
k = os.environ["K"].encode(); p = sys.argv[1]
b = open(p, "rb").read(); open(p, "wb").write(b.replace(k, b"[REDACTED-LITELLM-KEY]"))' "$f"
  done < <(grep -rlF -- "$LITELLM_KEY" "$d" 2>/dev/null | sort -u)
done
unset LITELLM_KEY

(cd "$RUN/work" && find . -type f -printf '%P %s\n' | sort > "$RUN/ls-after.txt")
[ -f "$RUN/answer.txt" ] || : > "$RUN/answer.txt"
cp "$HOMEDIR/.codex/config.toml" "$RUN/config-after.toml"

ARGV_STR="${CMD[*]}"; ARGV_STR=${ARGV_STR//$W/\$W}
python3 "$W/summarize.py" "$RUN" "$EXIT" "$START" "$END" "$HITS" "$HOMEDIR" "$ARGV_STR"
