#!/usr/bin/env bash
# run-grok.sh <task-id> <trial> — SP-5 (D-097): one headless grok 1.0.40 turn on local-coder.
#
# grok runs from homes/grok/grok-env.sh: scrubbed env, isolated HOME/GROK_HOME (no xAI
# credentials), config.toml pointing the only model at LiteLLM http://127.0.0.1:10400/v1.
# Optional env: GROK_MAX_TURNS (default 20; set 2 to reproduce the mind registry argv).
set -u
S=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T=${1:?usage: run-grok.sh <task-id> <trial>}; N=${2:?usage: run-grok.sh <task-id> <trial>}
MT=${GROK_MAX_TURNS:-20}

read_task() { python3 -c 'import json,sys
t=[x for x in json.load(open(sys.argv[1])) if x["id"]==sys.argv[2]]
if not t: sys.exit("unknown task "+sys.argv[2])
print(t[0][sys.argv[3]],end="")' "$S/tasks.json" "$T" "$1"; }
MODE=$(read_task mode) || exit 2
PROMPT=$(read_task prompt) || exit 2

R=$S/runs/grok/$T-t$N
rm -rf "$R"; mkdir -p "$R/work"
cp -a "$S/fixture/." "$R/work/"
cd "$R/work" || exit 2

# key: loaded here, handed to grok only through env LITELLM_API_KEY (config env_key); never echoed
LITELLM_API_KEY=$(grep -oP '^LITELLM_MASTER_KEY=\K.*' "$HOME/.secrets/.env.litellm" | tr -d '"')
export LITELLM_API_KEY

ARGS=(-p "$PROMPT" --output-format json --max-turns "$MT")
if [ "$MODE" = ro ]; then
  # mind GROK_READONLY, verbatim
  ARGS+=(--tools read_file,grep,list_dir)
else
  # act: shell AND file edits each need an explicit allow rule. Without --allow Bash headless
  # auto-cancels the command; without --allow Edit/Write it auto-cancels search_replace/write
  # EVEN UNDER acceptEdits (1.0.40, init reports permissionMode "acceptEdits"; probed
  # _probe-edit-noallow vs _probe-edit-allow). Either way the turn ends "cancelled" with empty
  # text, exit 0. (Fix 2026-09-26: --allow Edit --allow Write added; T3/T5 t1 under the old
  # argv kept as runs/grok/_prefix-*.)
  # tool allowlist drops xAI-hosted/interactive extras (image_edit, send_feedback,
  # ask_user_question, scheduler_*, workflow, monitor)
  ARGS+=(--permission-mode acceptEdits --allow Bash --allow Edit --allow Write
         --tools read_file,search_replace,write,run_terminal_command,list_dir,grep,todo_write)
fi

t0=$(date +%s.%N)
timeout 600 strace -f -qq -e trace=connect -o ../connects.log \
  "$S/homes/grok/grok-env.sh" "${ARGS[@]}" > ../stdout.json 2> ../stderr.txt
EXIT=$?
SECS=$(python3 -c "import time;print(round(time.time()-$t0,1))")
unset LITELLM_API_KEY

# answer, transcript, meta, connect audit
python3 - "$R" "$S/homes/grok/.grok/sessions" "$SECS" "$EXIT" "$MT" "$MODE" <<'EOF'
import json, re, sys, os, glob, ipaddress
R, SESS, secs, ex, mt, mode = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
raw = open(f"{R}/stdout.json", errors="replace").read()
err = open(f"{R}/stderr.txt", errors="replace").read()
try:
    out = json.loads(raw)
except Exception:
    out = {}
reply = out.get("text")
if reply is None:
    reply = out.get("result", "")
open(f"{R}/answer.txt", "w").write((reply or "").strip() + "\n")

sid = out.get("sessionId")
upd = ""
if sid:
    hits = glob.glob(f"{SESS}/*/{sid}/updates.jsonl")
    if hits:
        upd = open(hits[0], errors="replace").read()
with open(f"{R}/transcript.log", "w") as f:
    f.write("== stdout (json) ==\n" + raw + "\n== stderr ==\n" + err + "\n== session updates.jsonl ==\n" + upd)

tools = [json.loads(l)["params"]["update"].get("title")
         for l in upd.splitlines()
         if '"sessionUpdate": "tool_call"' in l or '"sessionUpdate":"tool_call"' in l]
json.dump({"seconds": secs, "exit": ex, "max_turns": mt, "mode": mode,
           "stopReason": out.get("stopReason"), "num_turns": out.get("num_turns"),
           "sessionId": sid, "tool_calls": tools}, open(f"{R}/meta.json", "w"))

leaks, dns = [], []
for line in open(f"{R}/connects.log", errors="replace"):
    if " connect(" not in line:
        continue
    m4 = re.search(r'sa_family=AF_INET, sin_port=htons\((\d+)\), sin_addr=inet_addr\("([^"]+)"\)', line)
    m6 = re.search(r'sa_family=AF_INET6, sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "([^"]+)"', line)
    m = m4 or m6
    if not m:
        continue  # AF_UNIX / AF_UNSPEC / AF_NETLINK: not egress
    port, addr = int(m.group(1)), m.group(2)
    ip = ipaddress.ip_address(addr)
    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    if str(ip) == "127.0.0.53" and port == 53:
        dns.append(f"{ip}:{port}")
    elif not ip.is_loopback:
        leaks.append(f"{addr}:{port}")
json.dump({"leaks": leaks, "dns": dns}, open(f"{R}/connects.json", "w"))
EOF

GRADE=$("$S/check.sh" "$T" "$R/work" "$R/answer.txt")
python3 - "$R" "$T" "$N" "$GRADE" <<'EOF'
import json, sys
R, T, N, grade = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
g = json.loads(grade)
meta = json.load(open(f"{R}/meta.json")); c = json.load(open(f"{R}/connects.json"))
g.update({"cli": "grok", "task": T, "trial": N, "seconds": meta["seconds"], "exit": meta["exit"],
          "leaks": len(c["leaks"]), "dns": len(c["dns"]), "leak_targets": sorted(set(c["leaks"])),
          "max_turns": meta["max_turns"], "stopReason": meta["stopReason"],
          "num_turns": meta["num_turns"], "tool_calls": meta["tool_calls"]})
json.dump(g, open(f"{R}/result.json", "w"))
print(json.dumps(g))
EOF
