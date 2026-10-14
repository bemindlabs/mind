# S12.6 codex probe log — 2026-09-26

Vendor: codex-cli 0.155.1 (~/.nvm/versions/node/v22.21.1/bin/codex). Host kernel 7.0.0-31-generic, kernel.apparmor_restrict_unprivileged_userns=1.
W = <scratch>/s12.6/codex
Key handling: LITELLM_MASTER_KEY grepped from $HOME/.secrets/.env.litellm into a shell variable, passed only as env LITELLM_API_KEY to the child. Shown below as <KEY>.

## Setup
- cp -a sp5/homes/codex -> W/home-template ; cp -a sp5/fixture -> W/fixture ; cp landlock-jail.py check.sh expected.json tasks.json -> W/
- W/home-template/.codex/config.toml: removed [features] (plugins/remote_plugin/apps/shell_snapshot), [shell_environment_policy], all [projects.*]. Kept: model/provider/litellm, approval_policy=never, check_for_update_on_startup=false, web_search=disabled, analytics/feedback off, otel none, history none.
- rm -rf W/home-template/.codex/sessions/* (SP-5 rollouts; copy only, sp5 untouched)

## C1 — syntax (no model call needed)
Env for all C1 commands: env -i HOME=$W/c1/home CODEX_HOME=$W/c1/home/.codex TMPDIR=$W/c1/home/tmp PATH=<node>:/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TERM=dumb
- `codex --help` -> c1/../c1-codex-help.txt rc=0. Root options include -c/--config, --enable/--disable <FEATURE> ("Equivalent to -c features.<name>=false"), --strict-config, -s/--sandbox, -p/--profile, --dangerously-bypass-*.
- `codex exec --help` -> c1-codex-exec-help.txt rc=0. exec ALSO takes -c, --enable/--disable, --strict-config, plus exec-only: --ephemeral ("Run without persisting session files to disk"), --ignore-user-config ("Do not load $CODEX_HOME/config.toml; auth still uses CODEX_HOME"), --ignore-rules, --json, -o/--output-last-message.
- `codex features list` (template home, no [features]) -> features-list-default.txt rc=0: apps=true plugins=true remote_plugin=true shell_snapshot=true (all "stable"), shell_snapshot_v2=false (under development), unified_exec=true, hooks=true, plugin_sharing=true, use_legacy_landlock=false (deprecated).
- A `codex -c features.plugins=false -c features.shell_snapshot=false features list` rc=0 -> plugins=false shell_snapshot=false (root-level -c reaches the subcommand)
- B `codex features -c features.plugins=false -c features.shell_snapshot=false list` rc=0 -> same
- C `codex features --disable plugins --disable shell_snapshot list` rc=0 -> same
- D `codex -c features.no_such_feature_xyz=false features list` rc=0 -> SILENTLY ACCEPTED (typo in a -c feature name is not an error without --strict-config)
- E `codex features --disable no_such_feature_xyz list` rc=1 "Error: Unknown feature flag: no_such_feature_xyz" -> --disable fails closed on unknown names
- F `codex -c features.plugins='"false"' features list` rc=1 "failed to load bootstrap configuration" (string instead of bool rejected)
- G `codex features --disable plugin_hooks list` rc=0 (a feature at stage "removed" is still accepted by --disable)
- H `codex exec --strict-config --skip-git-repo-check --sandbox read-only -c features.plugins=false -c features.shell_snapshot=false -c features.remote_plugin=false -c features.apps=false -c model_providers.litellm.base_url="http://127.0.0.1:9/v1" ... "Reply with the single word ok."` (dead model port on purpose, LITELLM_API_KEY=dummy) rc=124 after 90s of "Reconnecting... waiting for network" -> strict-config ACCEPTED all four feature keys (got past config load). 0 non-loopback connects (strict-ok.connects).
- I same + `-c no_such_top_key_xyz=1` rc=124 -> strict-config did NOT reject an unknown TOP-LEVEL -c key
- J same + `-c features.no_such_feature_xyz=false` rc=1 "Error loading config.toml: unknown configuration field `features.no_such_feature_xyz` in -c/--config override" -> strict-config DOES validate features.* in -c
- Owner-config copy (cp ~/.codex/config.toml -> $W/c1/ownercfg-home/.codex/config.toml; no auth.json copied):
  - `codex features list` -> plugins=true remote_plugin=true apps=true shell_snapshot=true unified_exec=true
  - `codex -c features.plugins=false -c features.shell_snapshot=false features list` -> plugins=false shell_snapshot=false: argv -c beats the owner's explicit `shell_snapshot = true`
  - `codex --strict-config features list` rc=1 "`--strict-config` is not supported for `codex features`"
  - jailed (`landlock-jail.py --rw $W/c1 --rw /dev --tcp-port 10400 --`) `codex exec --strict-config --skip-git-repo-check --sandbox read-only -c features.plugins=false -c features.shell_snapshot=false "Reply with the single word ok."` rc=124 (timeout 45): banner printed (model gpt-5.6-sol, provider openai) -> owner config PASSES --strict-config. 176 non-loopback connect attempts, all to the OpenAI model endpoint (Cloudflare 162.159.140.245 / 172.66.0.243 / 2606:4700:7::f3 / 2a06:98c1:58::f3, :443 and :65535 UDP-probe) — all TCP denied by the jail; no auth present. Not plugin traffic.
  - copied owner cfg byte-identical after runs (codex did not rewrite it).

## C4 — owner ~/.codex/config.toml (read only; names/booleans only)
- top-level keys: approvals_reviewer(=user), model(=gpt-5.6-sol), model_reasoning_effort, personality
- [features]: unified_exec = true, shell_snapshot = true  (shell_snapshot EXPLICITLY on; plugins/remote_plugin/apps NOT set -> defaults true)
- [shell_environment_policy]: ABSENT -> codex defaults (inherit=all; per SP-5's saved source ignore_default_excludes defaults to TRUE, i.e. no *KEY*/*SECRET*/*TOKEN* filtering) — measured in C3
- [plugins]: ABSENT · [mcp_servers]: ABSENT · [apps]/[marketplaces]/[hooks]: ABSENT · [projects.*]: 16 entries · [tui], [notice] present · no *.config.toml profiles
- ~/.codex/plugins/ exists (cache/ from 2026-06-16, .remote-plugin-install-staging/ 2026-09-09) -> plugins have been fetched on this account
- ~/.codex/shell_snapshots/: 1 file (2026-09-25, 9003 B, mode 600) with 73 export/declare lines; 3 exported NAMES match KEY|TOKEN|SECRET|PASSWORD (count only; values not read/printed) -> the snapshot persists the parent env, secrets included, to disk

## C2 — plugins egress (read-only sandbox, no jail, strace -f -qq -s 128 -e trace=connect,sendto)
Runner: W/run1.sh (fresh fixture copy per trial; env -i HOME/CODEX_HOME=<home> TMPDIR PATH LANG TERM SHELL=/bin/bash LITELLM_API_KEY=<KEY>; timeout -k 15 600). Persistent home per arm (W/homes/c2a, W/homes/c2b, copies of home-template) so trial 2 shows steady state.
argv (a): codex exec --skip-git-repo-check --sandbox read-only --output-last-message $W/runs/<run>/answer.txt "Reply with the single word ok."
argv (b): codex exec --skip-git-repo-check --sandbox read-only -c features.plugins=false --output-last-message ... "Reply with the single word ok."
- c2a-noflag-t1: exit 0, 10.5 s, answer "ok", 7 non-loopback connect(): 20.205.243.166:443 (github.com) x2 TCP, 172.64.155.209:443 (chatgpt.com, Cloudflare) x1 TCP, UDP address-selection probes :65535 to 104.18.32.47, 172.64.155.209, [2a06:98c1:3101::6812:202f] (ENETUNREACH), [2606:4700:4408::ac40:9bd1] (ENETUNREACH). DNS queries seen via sendto: chatgpt.com x2 (git's resolver not visible in sendto). 0 files written in work. config.toml unchanged.
- c2a-noflag-t2 (same home): exit 0, 5.8 s, "ok", 6 non-loopback: github :443 x1, chatgpt.com :443 x1, same 4 UDP probes. 
- => matches SP-5 (~7/run). Real TCP egress per run = 2-3 (github plugins repo + chatgpt.com); the rest are UDP connect() for RFC 6724 source selection (no payload) but still count under the SP-5 metric.
- c2b-plugins-off-t1: exit 0, 7.7 s, "ok", 0 non-loopback connects, 0 DNS, 0 files.
- c2b-plugins-off-t2 (same home): exit 0, 2.7 s, "ok", 0 non-loopback, 0 DNS, 0 files.
- => features.plugins=false ALONE gives 0 non-loopback connects (features.remote_plugin and features.apps left at default true). Caveat: this home has no ChatGPT auth; remote_plugin/apps may add traffic only when auth.json is present (not testable here without owner creds).
- c2c-disable-plugins-t1: argv `codex exec --skip-git-repo-check --sandbox read-only --disable plugins --output-last-message ... "Reply with the single word ok."` (fresh persistent home W/homes/c2c) exit 0, 6.5 s, "ok", 0 non-loopback, 0 DNS -> `exec --disable plugins` == `exec -c features.plugins=false`.

## C3 — shell env canaries (jail + danger-full-access)
argv: python3 $W/landlock-jail.py --rw $W/runs/<run> --rw /dev --tcp-port 10400 -- codex exec --skip-git-repo-check --sandbox danger-full-access <ARM FLAGS> --output-last-message $W/runs/<run>/answer.txt "Run the shell command `env | grep MIND_PROBE` in the current directory and reply with exactly what it printed, or the word nothing if it printed nothing."
env: as C2 + MIND_PROBE_SECRET_KEY=sk<24 hex random> MIND_PROBE_PLAIN=pl<24 hex random> (per-trial values in runs/<run>/canaries.txt). Fresh home per trial (copy of home-template in runs/<run>/home, no [shell_environment_policy] => codex default policy).
Arms (all carry -c features.plugins=false so the jail's TCP block does not interfere; only the env knobs differ):
  c3a: (snapshot default on)                                  
  c3b: -c features.shell_snapshot=false
  c3c: -c features.shell_snapshot=false -c shell_environment_policy.ignore_default_excludes=false   (extra arm)
  c3d: (snapshot on) -c shell_environment_policy.ignore_default_excludes=false                    (extra arm: does the snapshot bypass the policy?)
Evidence is read from the rollout jsonl (function_call_output) in runs/<run>/home/.codex/sessions, not from the model's prose.

### C3 raw outcomes (from result.json; canary = where the random value was found)
- c3a-snapshot-on-t1: exit 0, 24.1 s, non-loopback 0, tool calls [('exec_command', '{"cmd": "env | grep MIND_PROBE"}')], SECRET_KEY in real tool output=True, PLAIN in real tool output=True, snapshot files left in home=0, config.toml changed=True, files written in work=[]
- c3a-snapshot-on-t2: exit 0, 23.7 s, non-loopback 0, tool calls [('exec_command', '{"cmd": "env | grep MIND_PROBE"}')], SECRET_KEY in real tool output=True, PLAIN in real tool output=True, snapshot files left in home=0, config.toml changed=True, files written in work=[]
- c3b-snapshot-off-t1: exit 0, 7.5 s, non-loopback 0, tool calls [('exec_command', '{"cmd": "env | grep MIND_PROBE"}')], SECRET_KEY in real tool output=True, PLAIN in real tool output=True, snapshot files left in home=0, config.toml changed=True, files written in work=[]
- c3b-snapshot-off-t2: exit 0, 18.3 s, non-loopback 0, tool calls [('exec_command', '{"cmd": "env | grep MIND_PROBE", "workdir": "<scratch>/s12.6/codex/runs/c3b-snapshot-off-t2/work"}')], SECRET_KEY in real tool output=True, PLAIN in real tool output=True, snapshot files left in home=0, config.toml changed=True, files written in work=[]
- c3c-snapoff-defexcl-t1: exit 0, 10.5 s, non-loopback 0, tool calls [('exec_command', '{"cmd": "env | grep MIND_PROBE"}')], SECRET_KEY in real tool output=False, PLAIN in real tool output=True, snapshot files left in home=0, config.toml changed=True, files written in work=[]
- c3c-snapoff-defexcl-t2: exit 0, 13.0 s, non-loopback 0, tool calls [('exec_command', '{"cmd": "env | grep MIND_PROBE", "workdir": "<scratch>/s12.6/codex/runs/c3c-snapoff-defexcl-t2/work"}')], SECRET_KEY in real tool output=False, PLAIN in real tool output=True, snapshot files left in home=0, config.toml changed=True, files written in work=[]
- c3d-snapon-defexcl-t1: exit 0, 18.4 s, non-loopback 0, tool calls [('exec_command', '{"cmd": "env | grep MIND_PROBE"}')], SECRET_KEY in real tool output=True, PLAIN in real tool output=True, snapshot files left in home=0, config.toml changed=True, files written in work=[]
- c3a/c3b/c3c/c3d all: config.toml gained `[projects."<run>/work"] trust_level = "trusted"` (codex exec wrote to $CODEX_HOME/config.toml under danger-full-access; the read-only C2 runs did not).
- c3a: $CODEX_HOME/shell_snapshots/ created but EMPTY after a clean exit (canary not found on disk afterwards). Codex also echoes the command output (incl. canaries) to stderr ("exec ... succeeded in 0ms: MIND_PROBE_...").
- C3 reading: default policy (no [shell_environment_policy]) passes *KEY* vars to the shell with snapshot ON (a, 2/2) and OFF (b, 2/2). ignore_default_excludes=false hides the *KEY* canary only when snapshot is OFF (c, 2/2); with snapshot ON it is visible again (d, 1/1) -> the snapshot bypasses the policy (SP-5 finding 2 reproduced), and snapshot=false alone does NOT hide secrets under the default policy (new).
## C1 addendum (no model; dead port 127.0.0.1:9; timeout 20 => rc 124 means config accepted)
- K `codex exec --strict-config ... --disable plugins -c shell_environment_policy.ignore_default_excludez=false` rc=124 -> strict-config does NOT catch a typo inside the shell_environment_policy table
- L same without --strict-config rc=124 -> silently accepted
- M `codex exec --skip-git-repo-check --sandbox read-only --disable plugins --disable shell_snapshot -c shell_environment_policy.ignore_default_excludes=false ...` rc=124 -> proposed set parses
- N `codex exec ... --disable no_such_feature_xyz ...` rc=1 "Error: Unknown feature flag: no_such_feature_xyz" -> exec-level --disable fails closed too

## Batch 2 (sequential; argv in each runs/<run>/result.json "argv", key never on argv)
- c3d-snapon-defexcl-t2: -c features.plugins=false -c shell_environment_policy.ignore_default_excludes=false, danger-full-access in jail: exit 0, 18.5 s, 0 non-loopback, SECRET_KEY in real tool output = TRUE, PLAIN = true -> snapshot bypass of the policy 2/2.
- c3e-proposed-disableform-t1: --disable plugins --disable shell_snapshot -c shell_environment_policy.ignore_default_excludes=false, danger-full-access in jail: exit 0, 8.6 s, 0 non-loopback, SECRET_KEY = FALSE, PLAIN = true, config.toml gained trust entry.
- c3f-L1-legacyll-default-t1: --sandbox read-only -c features.plugins=false -c features.use_legacy_landlock=true (a level-1 sandbox that CAN start here), in jail: exit 0, 23.3 s, 0 non-loopback, exec_command `env | grep MIND_PROBE` ran, SECRET_KEY = TRUE, PLAIN = true, config.toml NOT changed -> the env hazard applies at level 1 wherever the sandbox can start.
- c3h-L1-legacyll-proposed-t1: --sandbox read-only -c features.plugins=false -c features.shell_snapshot=false -c shell_environment_policy.ignore_default_excludes=false -c features.use_legacy_landlock=true, in jail: exit 0, 9.2 s, 0 non-loopback, SECRET_KEY = FALSE, PLAIN = true.
- c3g-L1-bwrap-default-t1: mind's exact level-1 form on this host: jail + codex exec --skip-git-repo-check --sandbox read-only -c features.plugins=false (snapshot default on, default policy): exit 0, 100.8 s, 0 non-loopback; 3 exec_command calls (`env | grep MIND_PROBE`, a variant, `echo hello`) ALL returned "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"; neither canary in any tool output; answer honestly says the command never ran. shell_snapshots/ dir created (snapshot machinery still runs at level 1). tokens used 6,122.
- w1-workspace-write-trust-t1: jail + codex exec --skip-git-repo-check --sandbox workspace-write -c features.plugins=false "Reply with the single word ok.": exit 0, 3.9 s, "ok", 0 non-loopback; config.toml gained `[projects."<run>/work"] trust_level = "trusted"` -> the trust write happens at workspace-write too (not at read-only: C2, c3f, c3g, c3h, c5-T1 all unchanged).
- c5-T1-read-L1-legacyll-proposed-t1: jail + codex exec --skip-git-repo-check --sandbox read-only -c features.plugins=false -c features.shell_snapshot=false -c shell_environment_policy.ignore_default_excludes=false -c features.use_legacy_landlock=true <T1 prompt>: exit 0, 5.8 s, answer 55305, check.sh {"task":"T1-read","pass":true,"why":"answer has 55305"}; 1 call `cat config.yaml`; 0 non-loopback; 0 files written; stderr still has "tokens used" / 1,823.
  (mind's exact level-1 argv cannot pass T1 on this host with or without the flags: bwrap cannot start — see c3g and SP-5 codex arm T1 0/3. use_legacy_landlock=true is the SP-5 host-arm workaround.)
- c5-T3-edit-L3-proposed-t1: jail + codex exec --skip-git-repo-check --sandbox danger-full-access -c features.plugins=false -c features.shell_snapshot=false -c shell_environment_policy.ignore_default_excludes=false <T3 prompt>: exit 0, 18.6 s, "done", check.sh {"task":"T3-edit","pass":true,"why":"notes.txt exactly edited"}; calls `cat -A notes.txt`, `sed -i 's/^status: draft$/status: final/' notes.txt && cat -A notes.txt`; 0 non-loopback; stderr "tokens used" / 2,805; config.toml gained trust entry.
- w2-workspace-write-ephemeral-t1: as w1 + --ephemeral: exit 0, 8.4 s, "ok", 0 rollout files written, BUT config.toml still gained the trust entry -> --ephemeral does not stop the trust write.
- Owner ~/.codex/config.toml [projects.*]: 16 entries, all trust_level=trusted; 3 paths contain the product name, 6 contain /workspaces/ (cannot tell which were written by mind turns vs the owner's own codex use).
- Key hygiene: key_redactions = 0 in every run (the LiteLLM key value was never found in any file under W/runs or W/homes after any run).
- Final sweep: grep -rlF <KEY> over all of W -> 0 files (key never on disk in W). sp5/ not written.
