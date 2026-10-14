#!/usr/bin/env python3
# session-summary.py <workdir> [needle...] — find the kimi session(s) for <workdir> in $W/home and summarize:
# profileName, tools_snapshot names, whether needles occur in the system prompt, tool calls/results, final text.
import json, sys, os
W = "<scratch>/s12.6/kimi"
H = f"{W}/home/.kimi-code"
wd = os.path.realpath(sys.argv[1]); needles = sys.argv[2:]
sess = [json.loads(l)["sessionDir"] for l in open(f"{H}/session_index.jsonl") if os.path.realpath(json.loads(l).get("workDir","")) == wd]
if not sess: print("NO SESSION for", wd); sys.exit()
for s in sess:
    print("session", os.path.basename(s))
    for l in open(f"{s}/agents/main/wire.jsonl"):
        try: d = json.loads(l)
        except Exception: continue
        t = d.get("type")
        if t == "profile.bind":
            sp = d.get("systemPrompt", "")
            print(f"  profile={d.get('profileName')} model={d.get('modelAlias')} sysprompt_len={len(sp)}")
            for n in needles: print(f"  sysprompt contains {n!r}: {n in sp}")
        elif t == "permission.set_mode": print("  permission mode:", d.get("mode"))
        elif t == "llm.tools_snapshot": print("  tools_snapshot:", [x.get("name") for x in d.get("tools", [])])
        elif t == "context.append_loop_event":
            e = d["event"]; et = e.get("type")
            if et == "tool.call": print("  CALL", e.get("name"), json.dumps(e.get("args"))[:220])
            elif et == "tool.result": print("   ->", json.dumps(e.get("result"))[:260])
            elif et == "content.part" and e.get("part", {}).get("type") == "text": print("  TEXT", json.dumps(e["part"].get("text"))[:300])
            elif et == "step.end": print("  step.end", e.get("finishReason"))
        elif "error" in (t or "").lower(): print("  ERR", str(d)[:300])
