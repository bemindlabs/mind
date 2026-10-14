#!/usr/bin/env bash
# SP-5 (D-097) runner for the Claude Code CLI driving local-coder (qwen3.8-27b on vLLM) through LiteLLM :10400.
# usage: run-claude.sh <task-id> <trial-number>
#   FORCE=1 run-claude.sh ...   replaces an existing run dir (otherwise an existing run is never overwritten)
# Writes runs/claude/<task>-t<trial>/{work/,answer.txt,transcript.log,connects.log,meta.json,session.jsonl,result.json}
# and prints result.json. The LiteLLM key is read at run time and only ever lives in the CLI's environment.
set -uo pipefail

SP5=<scratch>/sp5
CLAUDE_BIN=$HOME/.local/bin/claude
CLI=claude

[ $# -eq 2 ] || { echo "usage: $0 <task-id> <trial-number>" >&2; exit 2; }
TASK=$1; TRIAL=$2
[[ $TRIAL =~ ^[0-9]+$ ]] || { echo "trial must be a number" >&2; exit 2; }
TRIAL=$((10#$TRIAL))

MODE=$(jq -er --arg id "$TASK" '.[] | select(.id == $id) | .mode' "$SP5/tasks.json") || { echo "unknown task: $TASK" >&2; exit 2; }
PROMPT=$(jq -er --arg id "$TASK" '.[] | select(.id == $id) | .prompt' "$SP5/tasks.json") || { echo "no prompt for $TASK" >&2; exit 2; }

case $MODE in
  act) MODE_FLAGS=(--permission-mode acceptEdits --allowedTools Bash,WebFetch,WebSearch) ;;
  ro)  MODE_FLAGS=(--tools "") ;;
  *)   echo "bad mode '$MODE' for $TASK" >&2; exit 2 ;;
esac

RUN=$SP5/runs/$CLI/$TASK-t$TRIAL
if [ -e "$RUN" ]; then
  [ "${FORCE:-0}" = 1 ] || { echo "run dir exists: $RUN (set FORCE=1 to replace)" >&2; exit 3; }
  rm -rf -- "$RUN"
fi
mkdir -p "$RUN/work"
cp -a "$SP5/fixture/." "$RUN/work/"

# Isolated env (CLAUDE_ENV array): HOME/CLAUDE_CONFIG_DIR/TMPDIR under homes/claude, LiteLLM base URL, every model var = local-coder.
# shellcheck source=/dev/null
source "$SP5/homes/claude/env.sh"
KEY=$(grep -oP '^LITELLM_MASTER_KEY=\K.*' $HOME/.secrets/.env.litellm | tr -d '"')
[ -n "$KEY" ] || { echo "LiteLLM key not found" >&2; exit 4; }

VERSION=$("$CLAUDE_BIN" --version 2>/dev/null | head -1)
START_ISO=$(date -Is); T0=$(date +%s.%N)
cd "$RUN/work" || exit 5
(
  # Drop every inherited exported variable (parent Claude session vars, cloud creds, ...), then export only the isolated env.
  while read -r v; do unset "$v" 2>/dev/null; done < <(compgen -e)
  export "${CLAUDE_ENV[@]}"
  export ANTHROPIC_AUTH_TOKEN="$KEY"   # via export, never on a command line
  exec timeout 600 strace -f -qq -e trace=connect -o ../connects.log \
    "$CLAUDE_BIN" -p "$PROMPT" --strict-mcp-config "${MODE_FLAGS[@]}" --output-format text \
    < /dev/null > ../answer.txt 2> ../stderr.log
)
EXIT=$?
SECS=$(python3 -c "import time,sys; print(round(time.time()-float(sys.argv[1]),2))" "$T0")
END_ISO=$(date -Is)
cd "$RUN" || exit 5

# transcript.log = full stdout + stderr of the CLI
{ echo "### stdout"; cat answer.txt; echo; echo "### stderr"; cat stderr.log; } > transcript.log
rm -f stderr.log

# Keep the CLI's own session log (tool calls + results) for analysis.
SLUG=$(printf '%s' "$RUN/work" | sed 's#[^A-Za-z0-9]#-#g')
SESS=$(ls -t "$SP5/homes/claude/.claude/projects/$SLUG"/*.jsonl 2>/dev/null | head -1)
[ -n "$SESS" ] && cp "$SESS" session.jsonl

# Never let the key reach an output file.
KEY_HITS=0
for f in answer.txt transcript.log connects.log session.jsonl; do
  [ -f "$f" ] || continue
  if grep -qF -f <(printf '%s\n' "$KEY") "$f"; then
    KEY_HITS=$((KEY_HITS + 1))
    python3 -c "import sys; p=sys.argv[1]; k=sys.stdin.read().strip(); s=open(p,errors='surrogateescape').read(); open(p,'w',errors='surrogateescape').write(s.replace(k,'[REDACTED]'))" "$f" < <(printf '%s\n' "$KEY")
  fi
done
unset KEY

jq -n --arg cli "$CLI" --arg task "$TASK" --argjson trial "$TRIAL" --arg mode "$MODE" --arg version "$VERSION" \
      --argjson seconds "$SECS" --argjson exit "$EXIT" --arg started "$START_ISO" --arg ended "$END_ISO" \
      --argjson key_hits "$KEY_HITS" \
      '{cli:$cli, task:$task, trial:$trial, mode:$mode, version:$version, seconds:$seconds, exit:$exit,
        timed_out:($exit==124), started:$started, ended:$ended, key_redactions:$key_hits}' > meta.json

# connect() audit: leak = AF_INET/AF_INET6 destination outside 127.0.0.0/8, ::1, ::ffff:127.0.0.0/104.
CONN=$(python3 - connects.log <<'PY'
import json, re, sys, ipaddress
leaks, dns, loop, unix, other = [], 0, 0, 0, []
for line in open(sys.argv[1], errors="replace"):
    if "connect(" not in line or "resumed>" in line.split("connect(")[0]:
        continue
    fam = re.search(r"sa_family=(AF_[A-Z0-9]+)", line)
    fam = fam.group(1) if fam else "?"
    if fam == "AF_UNIX":
        unix += 1; continue
    if fam in ("AF_INET", "AF_INET6"):
        a = re.search(r'inet_addr\("([^"]+)"\)', line) or re.search(r'inet_pton\(AF_INET6, "([^"]+)"', line)
        p = re.search(r"sin6?_port=htons\((\d+)\)", line)
        addr, port = (a.group(1) if a else "?"), (p.group(1) if p else "?")
        try:
            ip = ipaddress.ip_address(addr)
            if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped: ip = ip.ipv4_mapped
            is_loop = ip.is_loopback
        except ValueError:
            is_loop = False
        if is_loop:
            loop += 1
            if addr.endswith("127.0.0.53") and port == "53": dns += 1
        else:
            leaks.append(f"{addr}:{port}")
    else:
        other.append(fam)
print(json.dumps({"leaks": len(leaks), "dns": dns, "leak_dests": sorted(set(leaks)),
                  "loopback_connects": loop, "unix_connects": unix, "other_family_connects": other}))
PY
)

printf "%s\n" "$CONN" > connects.summary.json

GRADE=$("$SP5/check.sh" "$TASK" "$RUN/work" "$RUN/answer.txt" | tail -1)
echo "$GRADE" | jq -e . >/dev/null 2>&1 || GRADE=$(jq -nc --arg t "$TASK" --arg raw "$GRADE" '{task:$t, pass:false, why:("grader output unparsable: "+$raw)}')

jq -n --argjson g "$GRADE" --argjson c "$CONN" --slurpfile m meta.json \
  '$g + {cli:$m[0].cli, task:$m[0].task, trial:$m[0].trial, seconds:$m[0].seconds, exit:$m[0].exit,
         leaks:$c.leaks, dns:$c.dns, leak_dests:$c.leak_dests}' > result.json
cat result.json
