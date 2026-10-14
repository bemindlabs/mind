#!/usr/bin/env bash
# run-case.sh — one real CliExec turn (drive.ts) under strace, fresh fixture copy as cwd.
# env inputs:
#   LABEL      run name (W/runs/LABEL; must not exist)
#   VENDOR     grok | kimi | codex
#   LEVEL      1 | 2 | 3
#   TASK       PROBE | T1-read | T2-run | T3-edit | T4-readonly | T5-fix | CUSTOM (then PROMPT)
#   HOMEDIR    isolated home handed to CliExec as request.env.HOME
#   BINDIR     wrapper dir put first on request.env.PATH
#   JAIL       1 = run the whole bun driver inside sp5/landlock-jail.py (--rw W --rw /dev --tcp-port 10400)
#   PARENT_ENV extra K=V words for the DRIVER's own process.env (CliExec merges process.env into the child)
#   REQ_ENV    JSON object merged into request.env
# Never prints or stores the LiteLLM key.
set -uo pipefail
S="${SCRATCH:?set SCRATCH}"
W=$S/s12.6/verify
: "${LABEL:?}" "${VENDOR:?}" "${LEVEL:?}" "${TASK:?}" "${HOMEDIR:?}" "${BINDIR:?}"
JAIL=${JAIL:-0}; PARENT_ENV=${PARENT_ENV:-}; REQ_ENV=${REQ_ENV:-"{}"}
PROBE="Create a file named mind-probe.txt in the current working directory, containing the single word written. Do it now, then reply done."

RUN=$W/runs/$LABEL
[ -e "$RUN" ] && { echo "exists: $RUN" >&2; exit 3; }
mkdir -p "$RUN/work"
cp -a "$S/sp5/fixture/." "$RUN/work/"
listing() { (cd "$RUN/work" && find . -mindepth 1 -printf '%y %P\n' | sort | while read -r ty p; do
  if [ "$ty" = f ]; then echo "f $p $(sha256sum < "$p" | cut -c1-16)"; else echo "$ty $p"; fi; done); }
listing > "$RUN/before.txt"

case $TASK in
  PROBE) P=$PROBE ;;
  CUSTOM) P=${PROMPT:?} ;;
  *) P=$(/usr/bin/python3 -c 'import json,sys
t=[x for x in json.load(open(sys.argv[1])) if x["id"]==sys.argv[2]]
print(t[0]["prompt"],end="")' "$S/sp5/tasks.json" "$TASK") || exit 2 ;;
esac

/usr/bin/python3 - "$RUN/config.json" "$VENDOR" "$LEVEL" "$P" "$RUN/work" "$HOMEDIR" "$BINDIR" "$RUN" "$REQ_ENV" <<'PY'
import json, sys
path, v, lvl, p, cwd, home, bindir, out, req = sys.argv[1:10]
json.dump({"vendor": v, "level": int(lvl), "prompt": p, "cwd": cwd, "home": home, "pathDir": bindir,
           "outDir": out, "extraEnv": json.loads(req)}, open(path, "w"), indent=1)
PY

PREFIX=()
[ "$JAIL" = 1 ] && PREFIX=(/usr/bin/python3 "$S/sp5/landlock-jail.py" --rw "$W" --rw /dev --tcp-port 10400 --)

# shellcheck disable=SC2086
START=$(date +%s.%N)
env -i HOME="$W/drvhome" PATH=/usr/local/bin:/usr/bin:/bin TMPDIR="$W/tmp" LANG=C.UTF-8 \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 BUN_INSTALL_CACHE_DIR="$W/tmp/bun-cache" \
  OMV_SECRETS_FILE=$HOME/.secrets/.env.litellm $PARENT_ENV \
  timeout -k 15 900 strace -f -qq -e trace=connect -o "$W/$LABEL.connects" \
  "${PREFIX[@]}" $HOME/.bun/bin/bun "$W/drive.ts" "$RUN/config.json" \
  > "$RUN/driver.out" 2> "$RUN/driver.err" < /dev/null
DEXIT=$?
END=$(date +%s.%N)
listing > "$RUN/after.txt"

GRADE='{}'
case $TASK in T1-read|T2-run|T3-edit|T4-readonly|T5-fix) GRADE=$("$S/sp5/check.sh" "$TASK" "$RUN/work" "$RUN/answer.txt") ;; esac

# key hygiene over the run dir and the home that was used
KEY=$(grep -oP '^LITELLM_MASTER_KEY=\K.*' "$HOME/.secrets/.env.litellm" | tr -d '"')
HITS=0
while IFS= read -r f; do
  HITS=$((HITS+1))
  K="$KEY" /usr/bin/python3 -c '
import os, sys
k = os.environ["K"].encode(); p = sys.argv[1]
b = open(p, "rb").read(); open(p, "wb").write(b.replace(k, b"[REDACTED-LITELLM-KEY]"))' "$f"
done < <(grep -rlF --exclude=grok -- "$KEY" "$RUN" "$HOMEDIR" "$W/$LABEL.connects" 2>/dev/null | sort -u)
unset KEY

/usr/bin/python3 - "$RUN" "$W/$LABEL.connects" "$DEXIT" "$START" "$END" "$GRADE" "$HITS" "$TASK" <<'PY'
import json, re, sys
run, cpath, dexit, start, end, grade, hits, task = sys.argv[1:9]
leaks, loop, dns, unix = [], 0, 0, 0
for line in open(cpath, errors="replace"):
    if "connect(" not in line or "sa_family=" not in line: continue
    fam = re.search(r"sa_family=(AF_\w+)", line).group(1)
    if fam == "AF_INET":
        ip = re.search(r'inet_addr\("([^"]+)"\)', line).group(1); port = int(re.search(r"sin_port=htons\((\d+)\)", line).group(1))
        if ip.startswith("127."):
            loop += 1
            if ip == "127.0.0.53" and port == 53: dns += 1
            continue
        leaks.append(f"{ip}:{port} {line.rsplit('=',1)[-1].strip()[:24]}")
    elif fam == "AF_INET6":
        ip = re.search(r'inet_pton\(AF_INET6, "([^"]+)"', line).group(1); port = int(re.search(r"sin6_port=htons\((\d+)\)", line).group(1))
        if ip == "::1" or ip.startswith("::ffff:127."): loop += 1; continue
        leaks.append(f"[{ip}]:{port} {line.rsplit('=',1)[-1].strip()[:24]}")
    elif fam == "AF_UNIX": unix += 1
before = set(open(f"{run}/before.txt").read().splitlines()); after = set(open(f"{run}/after.txt").read().splitlines())
try: turn = json.load(open(f"{run}/turn.json"))
except Exception: turn = {}
argv = [json.loads(l) for l in open(f"{run}/argv.jsonl")] if __import__("os").path.exists(f"{run}/argv.jsonl") else []
res = {"label": run.rsplit("/",1)[-1], "task": task, "driver_exit": int(dexit), "seconds": round(float(end)-float(start),1),
       "confidence": turn.get("confidence"), "exitCode": turn.get("exitCode"), "usage": turn.get("usage"),
       "text_head": (turn.get("text") or "")[:240], "raw_head": (turn.get("raw") or "")[:240],
       "grade": json.loads(grade), "fs_added_or_changed": sorted(after-before), "fs_removed_or_changed": sorted(before-after),
       "nonloopback_connects": len(leaks), "nonloopback": leaks, "loopback_connects": loop, "dns_127_0_0_53": dns,
       "key_files_redacted": int(hits), "argv_calls": len(argv)}
json.dump(res, open(f"{run}/result.json","w"), indent=1)
print(json.dumps(res))
PY
