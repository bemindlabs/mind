#!/usr/bin/env python3
"""summarize.py [prefix...] — one row per W/runs/*/result.json, plus each shell command and its fate."""
import glob, json, os, sys

W = os.path.dirname(os.path.abspath(__file__))
prefixes = sys.argv[1:]
rows = []
for f in sorted(glob.glob(f"{W}/runs/*/result.json"), key=os.path.getmtime):
    run = os.path.basename(os.path.dirname(f))
    if prefixes and not any(run.startswith(p) for p in prefixes):
        continue
    r = json.load(open(f))
    stderr = open(os.path.join(os.path.dirname(f), "stderr.txt"), errors="replace").read().strip()
    cmds = []
    status = {}
    for line in open(os.path.join(os.path.dirname(f), "updates.jsonl"), errors="replace"):
        try:
            u = json.loads(line)["params"]["update"]
        except Exception:
            continue
        if u.get("sessionUpdate") == "tool_call" and isinstance(u.get("rawInput"), dict) and "command" in u["rawInput"]:
            cmds.append((u.get("toolCallId"), u["rawInput"]["command"]))
        if u.get("sessionUpdate") == "tool_call_update" and u.get("status") in ("completed", "failed"):
            status[u.get("toolCallId")] = u["status"]
    print(f"{run:26} pass={str(r['pass']):5} exit={r['exit']} stop={r['stopReason']!s:9} turns={r['num_turns']!s:3} "
          f"{r['seconds']:6.1f}s reply={r['reply_ptr']}:{r['reply_len']} leaks={r['leaks']} dns={r['dns']} "
          f"fs+={len(r['fs_added'])} tools={','.join(r['tool_calls'])}")
    print(f"{'':26} why={r['why']!r} failed={r['failed_tools']} stderr={stderr[:80]!r}")
    for cid, c in cmds:
        print(f"{'':26}   $ {c!r} -> {status.get(cid, '?')}")
