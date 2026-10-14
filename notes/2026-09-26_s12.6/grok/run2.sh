#!/usr/bin/env bash
# run.sh <label> <task-id|PROBE> <trial> [grok args after `-p <prompt> --output-format json`...]
# S12.6 grok measurement: one headless grok 1.0.40 turn on local-coder, from the isolated home
# copied from SP-5 (W/home). Fresh fixture copy per trial (PROBE = fresh EMPTY dir).
# Key: read from $HOME/.secrets/.env.litellm straight into the child's env (grok-env.sh passes
# only LITELLM_API_KEY through env -i). Never echoed, never on an argv, never on disk.
set -u
W=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LABEL=${1:?label}; T=${2:?task}; N=${3:?trial}; shift 3
PROBE="Create a file named mind-probe.txt in the current working directory, containing the single word written. Do it now, then reply done."

if [ "$T" = PROBE ]; then
  PROMPT=$PROBE
else
  PROMPT=$(python3 -c 'import json,sys
t=[x for f in (sys.argv[1],sys.argv[3]) for x in json.load(open(f)) if x["id"]==sys.argv[2]]
if not t: sys.exit("unknown task "+sys.argv[2])
print(t[0]["prompt"],end="")' "$W/tasks.json" "$T" "$W/tasks-x.json") || exit 2
fi

R=$W/runs/$LABEL-t$N
rm -rf "$R"; mkdir -p "$R/work"
[ "$T" != PROBE ] && cp -a "$W/fixture/." "$R/work/"
listing() { (cd "$R/work" && find . -mindepth 1 -printf '%y %P\n' | sort | while read -r ty p; do
  if [ "$ty" = f ]; then echo "f $p $(sha256sum < "$p" | cut -c1-16)"; else echo "$ty $p"; fi; done); }
listing > "$R/before.txt"

ARGS=(-p "$PROMPT" --output-format json "$@")
python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' grok "${ARGS[@]}" > "$R/argv.json"

cd "$R/work" || exit 2
LITELLM_API_KEY=$(grep -oP '^LITELLM_MASTER_KEY=\K.*' "$HOME/.secrets/.env.litellm" | tr -d '"')
export LITELLM_API_KEY
t0=$(date +%s.%N)
timeout 600 strace -f -qq -e trace=connect -o "$R/connects.log" \
  "$W/home/grok-env.sh" "${ARGS[@]}" > "$R/stdout.json" 2> "$R/stderr.txt"
EXIT=$?
SECS=$(python3 -c "import time;print(round(time.time()-$t0,1))")
unset LITELLM_API_KEY
cd "$W" || exit 2
listing > "$R/after.txt"

case $T in PROBE|X*) GRADE="{}";; *)
  python3 -c 'import json,sys
try: o=json.load(open(sys.argv[1]))
except Exception: o={}
r=o.get("text")
if r is None: r=o.get("result","")
open(sys.argv[2],"w").write((r or "").strip()+"\n")' "$R/stdout.json" "$R/answer.txt"
  GRADE=$("$W/check.sh" "$T" "$R/work" "$R/answer.txt");;
esac

python3 - "$R" "$W/home/.grok/sessions" "$SECS" "$EXIT" "$LABEL" "$T" "$N" "$GRADE" <<'EOF'
import json, re, sys, glob, ipaddress
R, SESS, secs, ex, label, task, trial, grade = sys.argv[1:9]
secs = float(secs); ex = int(ex); trial = int(trial)
raw = open(f"{R}/stdout.json", errors="replace").read()
try:
    out = json.loads(raw)
except Exception:
    out = {}
text = out.get("text"); ptr = "/text"
if text is None:
    text = out.get("result"); ptr = "/result" if text is not None else None
open(f"{R}/answer.txt", "w").write((text or "").strip() + "\n")
sid = out.get("sessionId")
upd = ""
if sid:
    hits = glob.glob(f"{SESS}/*/{sid}/updates.jsonl")
    if hits:
        upd = open(hits[0], errors="replace").read()
open(f"{R}/updates.jsonl", "w").write(upd)
tools, failed = [], []
for l in upd.splitlines():
    try:
        u = json.loads(l)["params"]["update"]
    except Exception:
        continue
    if u.get("sessionUpdate") == "tool_call":
        tools.append(u.get("title"))
    if u.get("sessionUpdate") == "tool_call_update" and u.get("status") == "failed":
        msg = ""
        for c in (u.get("content") or []):
            if isinstance(c, dict) and isinstance(c.get("content"), dict):
                msg = c["content"].get("text", "")
        failed.append(msg[:120])
leaks, dns = [], []
for line in open(f"{R}/connects.log", errors="replace"):
    if " connect(" not in line:
        continue
    m4 = re.search(r'sa_family=AF_INET, sin_port=htons\((\d+)\), sin_addr=inet_addr\("([^"]+)"\)', line)
    m6 = re.search(r'sa_family=AF_INET6, sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6, "([^"]+)"', line)
    m = m4 or m6
    if not m:
        continue
    port, addr = int(m.group(1)), m.group(2)
    ip = ipaddress.ip_address(addr)
    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    if str(ip) == "127.0.0.53" and port == 53:
        dns.append(f"{ip}:{port}")
    elif not ip.is_loopback:
        leaks.append(f"{addr}:{port}")
before = set(open(f"{R}/before.txt").read().splitlines())
after = set(open(f"{R}/after.txt").read().splitlines())
g = json.loads(grade)
if task == "PROBE":
    wrote = sorted(after - before)
    g = {"task": "PROBE", "pass": (not wrote) and bool((text or "").strip()),
         "why": ("nothing written" if not wrote else "WROTE " + " ".join(wrote)) +
                ("; answered" if (text or "").strip() else "; EMPTY answer")}
elif task == "X1-compound":
    ok = "EXIT: 1" in (text or "") and not failed
    g = {"task": task, "pass": ok, "why": ("compound command ran, answer has EXIT: 1" if ok else
         "compound command NOT run or answer lacks EXIT: 1; failed=" + "|".join(failed))}
elif task == "X2-rm":
    gone = not any(l.startswith("f data.bin ") for l in after)
    g = {"task": task, "pass": gone, "why": "data.bin removed" if gone else
         "data.bin still present; failed=" + "|".join(failed)}
u = out.get("usage") or {}
g.update({"label": label, "trial": trial, "seconds": secs, "exit": ex,
          "stopReason": out.get("stopReason"), "num_turns": out.get("num_turns"),
          "reply_ptr": ptr, "reply_len": len((text or "").strip()),
          "usage": {k: u.get(k) for k in ("input_tokens", "cache_read_input_tokens",
                    "cache_creation_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens")} if u else None,
          "top_keys": sorted(out.keys()),
          "leaks": len(leaks), "dns": len(dns), "leak_targets": sorted(set(leaks)),
          "fs_added": sorted(after - before), "fs_removed": sorted(before - after),
          "tool_calls": tools, "failed_tools": failed, "sessionId": sid})
json.dump(g, open(f"{R}/result.json", "w"))
print(json.dumps(g))
EOF
