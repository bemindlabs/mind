#!/usr/bin/env bash
# run-kimi.sh <task-id> <trial-number> — SP-5 (D-097) trial runner for Kimi Code CLI 2.0.2
# against local-coder (qwen3.8-27b on vLLM) via LiteLLM http://127.0.0.1:10400/v1.
#
# Isolation: env -i, HOME + KIMI_CODE_HOME under sp5/homes/kimi (no Moonshot creds).
# kimi-exec.sh loads the key into env LITELLM_API_KEY inside the child (never on argv,
# never on disk); config.toml uses api_key_env = "LITELLM_API_KEY".
# act mode : kimi -p <prompt> --output-format text   (print mode forces "Never Ask"/auto
#            permission internally; --auto/--yolo are rejected together with -p)
# ro  mode : kimi -p <prompt> --agent plan --output-format text
#            (--plan/--auto/--yolo error out with -p, but the built-in "plan" agent profile
#            is selectable by argv and ships only FetchURL/Glob/Grep/Read — no Bash, Edit,
#            Write; its system prompt says "read-only planning agent". Fixed by the measuring
#            agent after T4-readonly-t1 ran without it; old runner kept as run-kimi.sh.orig-noroflag.)
set -uo pipefail

S=<scratch>/sp5
TASK=${1:?usage: run-kimi.sh <task-id> <trial-number>}
TRIAL=${2:?usage: run-kimi.sh <task-id> <trial-number>}
CLI=kimi

MODE=$(python3 -c 'import json,sys; t=[x for x in json.load(open(sys.argv[1])) if x["id"]==sys.argv[2]]; print(t[0]["mode"] if t else "")' "$S/tasks.json" "$TASK")
PROMPT=$(python3 -c 'import json,sys; t=[x for x in json.load(open(sys.argv[1])) if x["id"]==sys.argv[2]]; print(t[0]["prompt"] if t else "", end="")' "$S/tasks.json" "$TASK")
[ -n "$MODE" ] && [ -n "$PROMPT" ] || { echo "unknown task: $TASK" >&2; exit 2; }

RUN=$S/runs/$CLI/$TASK-t$TRIAL
[ -e "$RUN" ] && { echo "run dir already exists (no retries/overwrites): $RUN" >&2; exit 3; }
mkdir -p "$RUN/work"
cp -a "$S/fixture/." "$RUN/work/"
cd "$RUN/work" || exit 4

case $MODE in
  act) FLAGS=(--output-format text) ;;
  ro)  FLAGS=(--agent plan --output-format text) ;;   # read-only tool set (FetchURL/Glob/Grep/Read)
  *)   echo "bad mode: $MODE" >&2; exit 2 ;;
esac

H=$S/homes/kimi

start=$(date +%s.%N)
timeout 600 strace -f -qq -e trace=connect -o ../connects.log \
  env -i \
    HOME="$H" \
    KIMI_CODE_HOME="$H/.kimi-code" \
    XDG_CONFIG_HOME="$H/.config" XDG_CACHE_HOME="$H/.cache" XDG_DATA_HOME="$H/.local/share" \
    OWNER_HOME="$HOME" PATH="$HOME/.kimi-code/bin:/usr/local/bin:/usr/bin:/bin" \
    LANG="${LANG:-C.UTF-8}" TERM=dumb NO_COLOR=1 \
    KIMI_DISABLE_TELEMETRY=1 \
    KIMI_CODE_NO_AUTO_UPDATE=1 \
    KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START=0 \
  /bin/bash "$S/kimi-exec.sh" -p "$PROMPT" "${FLAGS[@]}" \
  > ../stdout.txt 2> ../stderr.txt < /dev/null
EXIT=$?
end=$(date +%s.%N)

python3 - "$RUN" "$start" "$end" "$EXIT" "$MODE" "$TASK" "$TRIAL" "$CLI" "${FLAGS[*]}" <<'PY'
import json, re, sys
run, start, end, exit_code, mode, task, trial, cli, flags = sys.argv[1:10]
secs = round(float(end) - float(start), 2)
out = open(f"{run}/stdout.txt", encoding="utf-8", errors="replace").read()
err = open(f"{run}/stderr.txt", encoding="utf-8", errors="replace").read()

# transcript = full stdout + stderr
with open(f"{run}/transcript.log", "w") as f:
    f.write("===== stdout =====\n" + out + "\n===== stderr =====\n" + err)

# final reply = last assistant block on stdout. Text mode renders each assistant
# block as "• <text>" with continuation lines indented by two spaces.
lines = out.splitlines()
starts = [i for i, l in enumerate(lines) if l.startswith("• ") or l == "•"]
if starts:
    block = lines[starts[-1]:]
    block[0] = block[0][2:] if block[0].startswith("• ") else block[0][1:]
    block = [block[0]] + [l[2:] if l.startswith("  ") else l for l in block[1:]]
    answer = "\n".join(block).strip()
else:
    answer = out.strip()
with open(f"{run}/answer.txt", "w") as f:
    f.write(answer + ("\n" if answer else ""))

json.dump({"cli": cli, "task": task, "trial": int(trial), "mode": mode,
           "argv": f"kimi -p <prompt> {flags}", "readonly_flag": "--agent plan" if mode == "ro" else "n/a",
           "seconds": secs, "exit": int(exit_code)},
          open(f"{run}/meta.json", "w"))

# connect() audit
leaks, dns, leak_addrs = 0, 0, []
for l in open(f"{run}/connects.log", errors="replace"):
    if "connect(" not in l:
        continue
    m4 = re.search(r'sa_family=AF_INET, sin_port=htons\((\d+)\), sin_addr=inet_addr\("([\d.]+)"\)', l)
    m6 = re.search(r'sa_family=AF_INET6, sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "([^"]+)"', l)
    if m4:
        port, addr = int(m4.group(1)), m4.group(2)
        if addr == "127.0.0.53" and port == 53:
            dns += 1
        if not addr.startswith("127."):
            leaks += 1; leak_addrs.append(f"{addr}:{port}")
    elif m6:
        port, addr = int(m6.group(1)), m6.group(2).lower()
        loop = addr == "::1" or re.match(r"^::ffff:127\.", addr) is not None
        if not loop:
            leaks += 1; leak_addrs.append(f"[{addr}]:{port}")
    # AF_UNIX / AF_UNSPEC / AF_NETLINK are local — not leaks
with open(f"{run}/leaks.txt", "w") as f:
    f.write("\n".join(leak_addrs) + ("\n" if leak_addrs else ""))
json.dump({"seconds": secs, "exit": int(exit_code), "leaks": leaks, "dns": dns}, open(f"{run}/.audit.json", "w"))
PY

GRADE=$("$S/check.sh" "$TASK" "$RUN/work" "$RUN/answer.txt")
python3 - "$RUN" "$GRADE" "$CLI" "$TASK" "$TRIAL" <<'PY'
import json, sys
run, grade, cli, task, trial = sys.argv[1:6]
try:
    g = json.loads(grade)
except Exception:
    g = {"task": task, "pass": False, "why": f"grader output unparseable: {grade[:200]}"}
a = json.load(open(f"{run}/.audit.json"))
res = {**g, "cli": cli, "task": task, "trial": int(trial),
       "seconds": a["seconds"], "exit": a["exit"], "leaks": a["leaks"], "dns": a["dns"]}
json.dump(res, open(f"{run}/result.json", "w"))
PY
rm -f "$RUN/.audit.json"
cat "$RUN/result.json"; echo
