#!/usr/bin/env bash
# run-codex.sh <task-id> <trial-number>  — SP-5 (D-097) runner for the codex CLI via LiteLLM/local-coder.
#
# Sandbox variant (env SP5_CODEX_SANDBOX):
#   mind (default) — mind's exact flags:
#       act: codex exec --skip-git-repo-check --sandbox workspace-write
#       ro : codex exec --skip-git-repo-check --sandbox read-only
#     On this host codex's bubblewrap sandbox cannot start (AppArmor
#     kernel.apparmor_restrict_unprivileged_userns=1 -> "bwrap: loopback: Failed RTM_NEWADDR"),
#     so every model shell command fails. Runs go to runs/codex/.
#   host — a variant that works on this host. Runs go to runs/codex-host/, cli="codex-host":
#       act: landlock-jail.py (writes only in the run dir, codex home, /dev; TCP connect only :10400)
#            + codex exec --skip-git-repo-check --sandbox danger-full-access
#       ro : landlock-jail.py (same) + codex exec --skip-git-repo-check --sandbox read-only
#            -c features.use_legacy_landlock=true   (codex's own Landlock read-only enforcement)
set -uo pipefail

SP=<scratch>/sp5
TASK=${1:?usage: run-codex.sh <task-id> <trial-number>}
TRIAL=${2:?usage: run-codex.sh <task-id> <trial-number>}
VARIANT=${SP5_CODEX_SANDBOX:-mind}
CODEX_HOME_ROOT=$SP/homes/codex
NODE_BIN=$HOME/.nvm/versions/node/v22.21.1/bin
CODEX_BIN=$NODE_BIN/codex

case $VARIANT in
  mind) CLI_LABEL=codex ;;
  host)  CLI_LABEL=codex-host ;;
  *) echo "unknown SP5_CODEX_SANDBOX=$VARIANT (mind|host)" >&2; exit 2 ;;
esac

# --- task lookup (prompt used verbatim) ---
MODE=$(python3 -c 'import json,sys; t={x["id"]:x for x in json.load(open(sys.argv[1]))}; print(t[sys.argv[2]]["mode"])' "$SP/tasks.json" "$TASK") \
  || { echo "unknown task $TASK" >&2; exit 2; }
PROMPT=$(python3 -c 'import json,sys; t={x["id"]:x for x in json.load(open(sys.argv[1]))}; sys.stdout.write(t[sys.argv[2]]["prompt"])' "$SP/tasks.json" "$TASK")

# --- fresh run dir (an existing one is moved aside, never deleted) ---
RUN=$SP/runs/$CLI_LABEL/$TASK-t$TRIAL
[ -e "$RUN" ] && mv "$RUN" "$RUN.prev-$(date +%Y%m%dT%H%M%S)"
mkdir -p "$RUN/work"
cp -a "$SP/fixture/." "$RUN/work/"
mkdir -p "$CODEX_HOME_ROOT/tmp"
cd "$RUN/work" || exit 2

# --- flags ---
if [ "$MODE" = ro ]; then SANDBOX_FLAGS=(--sandbox read-only); else SANDBOX_FLAGS=(--sandbox workspace-write); fi
PREFIX=()
if [ "$VARIANT" = host ]; then
  if [ "$MODE" = ro ]; then SANDBOX_FLAGS=(--sandbox read-only -c features.use_legacy_landlock=true)
  else SANDBOX_FLAGS=(--sandbox danger-full-access); fi
  PREFIX=(python3 "$SP/landlock-jail.py" --rw "$RUN" --rw "$CODEX_HOME_ROOT" --rw /dev --tcp-port 10400 --)
fi
CMD=("${PREFIX[@]}" "$CODEX_BIN" exec --skip-git-repo-check "${SANDBOX_FLAGS[@]}" --output-last-message ../answer.txt "$PROMPT")

# --- key: loaded into a variable, only ever passed via env ---
LITELLM_KEY=$(grep -oP '^LITELLM_MASTER_KEY=\K.*' "$HOME/.secrets/.env.litellm" | tr -d '"')
[ -n "$LITELLM_KEY" ] || { echo "LITELLM_MASTER_KEY not found" >&2; exit 2; }

START=$(date +%s.%N)
env -i \
  HOME="$CODEX_HOME_ROOT" CODEX_HOME="$CODEX_HOME_ROOT/.codex" TMPDIR="$CODEX_HOME_ROOT/tmp" \
  PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 TERM=dumb \
  LITELLM_API_KEY="$LITELLM_KEY" \
  timeout -k 15 600 strace -f -qq -e trace=connect -o ../connects.log "${CMD[@]}" \
  > ../transcript.log 2>&1 < /dev/null
EXIT=$?
END=$(date +%s.%N)
[ -f ../answer.txt ] || : > ../answer.txt

# flags as run (prompt elided)
FLAGS_STR="${CMD[*]:0:${#CMD[@]}-1} <prompt>"
FLAGS_STR=${FLAGS_STR//$SP/\$SP}

python3 - "$RUN" "$START" "$END" "$EXIT" "$CLI_LABEL" "$TASK" "$TRIAL" "$MODE" "$VARIANT" "$FLAGS_STR" <<'PY'
import json, sys
run, start, end, rc, cli, task, trial, mode, variant, flags = sys.argv[1:]
json.dump({"cli": cli, "task": task, "trial": int(trial), "mode": mode, "variant": variant,
           "seconds": round(float(end) - float(start), 2), "exit": int(rc), "cmd": flags},
          open(f"{run}/meta.json", "w"), indent=1)
PY

# --- secret hygiene: redact the key if it ever landed in a run file ---
SECRET_HITS=$(grep -rlF -- "$LITELLM_KEY" "$RUN" 2>/dev/null | wc -l)
if [ "$SECRET_HITS" -gt 0 ]; then
  grep -rlF -- "$LITELLM_KEY" "$RUN" | K="$LITELLM_KEY" xargs -r python3 -c '
import os, sys
k = os.environ["K"]
for p in sys.argv[1:]:
    b = open(p, "rb").read().replace(k.encode(), b"[REDACTED-LITELLM-KEY]"); open(p, "wb").write(b)'
fi
unset LITELLM_KEY

GRADE=$("$SP/check.sh" "$TASK" "$RUN/work" "$RUN/answer.txt")

python3 - "$RUN" "$GRADE" "$SECRET_HITS" <<'PY'
import json, re, sys
run, grade_line, secret_hits = sys.argv[1], sys.argv[2], int(sys.argv[3])
meta = json.load(open(f"{run}/meta.json"))
try:
    grade = json.loads(grade_line)
except Exception:
    grade = {"task": meta["task"], "pass": False, "why": f"grader output unparseable: {grade_line!r}"}

leaks = dns = unix = other = loop = 0
leak_dests = {}
for line in open(f"{run}/connects.log", errors="replace"):
    if "connect(" not in line or "sa_family=" not in line:
        continue
    fam = re.search(r"sa_family=(AF_\w+)", line).group(1)
    if fam == "AF_INET":
        ip = re.search(r'inet_addr\("([^"]+)"\)', line).group(1)
        port = int(re.search(r"sin_port=htons\((\d+)\)", line).group(1))
        if ip.startswith("127."):
            loop += 1
            if ip == "127.0.0.53" and port == 53:
                dns += 1
            continue
        dest = f"{ip}:{port}"
    elif fam == "AF_INET6":
        ip = re.search(r'inet_pton\(AF_INET6, "([^"]+)"', line).group(1)
        port = int(re.search(r"sin6_port=htons\((\d+)\)", line).group(1))
        if ip == "::1" or ip.startswith("::ffff:127."):
            loop += 1
            continue
        dest = f"[{ip}]:{port}"
    elif fam == "AF_UNIX":
        unix += 1
        continue
    else:  # AF_NETLINK, AF_UNSPEC (UDP disconnect) ... — kernel-local, not network egress
        other += 1
        continue
    leaks += 1
    leak_dests[dest] = leak_dests.get(dest, 0) + 1

transcript = open(f"{run}/transcript.log", errors="replace").read()
result = dict(grade)
result.update({
    "cli": meta["cli"], "task": meta["task"], "trial": meta["trial"],
    "seconds": meta["seconds"], "exit": meta["exit"], "leaks": leaks, "dns": dns,
    "variant": meta["variant"], "mode": meta["mode"],
    "leak_dests": leak_dests, "loopback_connects": loop, "unix_connects": unix,
    "sandbox_start_failures": transcript.count("bwrap: loopback: Failed RTM_NEWADDR")
                              + transcript.count("incompatible with --use-legacy-landlock"),
    "timed_out": meta["exit"] == 124, "secret_hits_redacted": secret_hits,
})
json.dump(result, open(f"{run}/result.json", "w"))
print(json.dumps(result))
PY
