# D-149 capability survey — actions, tasks and computer use, per backend and model (2026-10-04)

D-149 (the owner, 2026-10-04): *"agi agent ต้อง actions ได้ สั่งงานได้ computer use จาก backend และ model ที่ใช้ และรองรับได้"*.
This note is research and contains no code. It has four parts:

1. what each backend on this machine can do, measured here;
2. what the vendors' APIs offer, with sources;
3. where a computer-use runtime could live;
4. a capability matrix, then the decisions the owner needs to make, **one at a time**, and a phased backlog.

The proof that the agent acts today is `notes/2026-10-04_e2e-actions.md`.

**Machine:** Linux kernel 7.0 (Landlock ABI 8, seccomp user-notify), `kernel.apparmor_restrict_unprivileged_userns=1`, no
`DISPLAY`, one RTX A6000 with 41.8 of 46 GB in use (vLLM `local-coder` ≈ 33.5 GB, D-117).
Google Chrome, Firefox and `Xvfb` are installed. `xdotool`, x11vnc and Playwright's browsers are not.

---

## 1. Measured on this machine

### 1.1 Vendor CLIs

Versions and flags come from `--help` on 2026-10-04. "e2e" is the result in the proof record.

| CLI | version | tools it acts with | headless permission flags | sandbox | MCP | browser / desktop | image input | what mind sends at level 2 | e2e at level 2 |
|---|---|---|---|---|---|---|---|---|---|
| claude | 2.1.289 | Read/Write/Edit/Bash/WebFetch/WebSearch, subagents | `-p`; `--permission-mode acceptEdits\|auto\|bypassPermissions\|dontAsk\|plan\|manual`; `--allowedTools`/`--disallowedTools`; `--tools`; `--permission-prompts none`; `--restricted`; `--max-budget-usd`; `--dangerously-skip-permissions` | none in `--help` | yes (`mcp`, `--mcp-config`, `--strict-mcp-config`). mind turns it off (D-047) | `--chrome` drives the user's real Chrome through the extension. Desktop control is a macOS-only MCP and does not work with `-p` (§2.1) | the Read tool opens image files; `--input-format stream-json` takes content blocks | `acceptEdits` + `--allowedTools Bash,WebFetch,WebSearch` (D-047) | ✅ act · run · stop (haiku) |
| claude-local | same binary → LiteLLM `local-coder` | same, but no WebFetch/WebSearch | same | **Landlock + seccomp fence** (D-118, D-124) | turned off | none | the model takes images (§1.2) | `acceptEdits` + `--allowedTools Bash` inside the fence | ✅ act · run · fence · stop |
| grok | 1.0.40 | shell, edit, web search/fetch, subagents | `-p`; `--permission-mode …`; `--always-approve`; `--allow`/`--deny`; `--tools`/`--disallowed-tools`; `--max-turns` | `--sandbox <PROFILE>` (`GROK_SANDBOX`), not measured | yes (`grok mcp`). mind turns it off (D-119 hardening) | none native | `--prompt-json` content blocks (not measured) | `--always-approve` (D-119) | ✅ act · run · stop |
| grok-local | same → `local-coder` | same, with web turned off | same | **fence** | turned off | none | the model takes images | `--always-approve` inside the fence | ✅ act · run · fence · stop |
| kimi | 2.1.1 | shell, edit, FetchURL, subagents | `-p`; `--yolo`; `--auto`; `--agent`/`--agent-file`; `--add-dir`; `--plan` | none in `--help` | yes (`[mcp.client]` in its config) | none native | not in `--help` | nothing: in 2.0.2 print mode forced `auto` (measured); on 2.1.1 it still acts (e2e) | ✅ act · run · stop · ❌ propose (finding 3) |
| codex | 0.155.1 | shell, apply_patch | `exec`; `--sandbox read-only\|workspace-write\|danger-full-access`; `--approve-for-me`; `--dangerously-bypass-approvals-and-sandbox`; `--ephemeral`; `--ignore-user-config` | bwrap. **It cannot start here** because AppArmor restricts unprivileged user namespaces | yes (`codex mcp`) | the CLI has no computer use; that is in the desktop app only (§2.2) | `-i/--image` | `--sandbox workspace-write` (D-047). It writes `trust_level` into the operator's config (D-121) | not run (would change that config); level 1 answered "Unable." |
| copilot | 0.0.367 | shell, write, built-in `github-mcp-server` | `-p`; `--allow-all-tools`; `--allow-tool`/`--deny-tool`; `--allow-all-paths`; `--add-dir`; `--disallow-temp-dir` | path verification only | yes (`--additional-mcp-config`; GitHub's own example is Playwright) | none native | not in `--help` | **nothing**: `--allow-all-tools` is sent only with the level-1 deny list | ❌ cannot act (finding 4) |
| gemini | 0.38.2 | shell, edit, web | `-p`; `--approval-mode default\|auto_edit\|yolo\|plan`; `-y`; policy engine | `-s/--sandbox` (docker/podman) | yes (`gemini mcp`) | an opt-in `browser_agent` subagent (§2.3) | `@file` (vendor docs, not measured) | nothing (no grant) | ⛔ the account is ineligible (vendor side) |
| ollama | API 0.32.13 | **none** | — | — | — | — | the model (qwen3.8) does | — | ✅ now says it cannot act (fix 2) |

What this table means for D-149:

- **Acting works today on five routes: claude, grok, kimi, claude-local and grok-local.** The local two run inside
  the kernel fence. All five passed a real write, a real command and a real stop.
- **codex, copilot and gemini cannot act here, and none of them is refused plainly.** codex's sandbox cannot start.
  copilot has no grant. gemini's account is ineligible. Engine work is in §5, phase A.
- **Every CLI except ollama supports MCP.** That makes MCP the one mechanism through which mind can give the same
  browser to every CLI backend. mind turns MCP off today (D-047, D-119), on purpose, because MCP was a way out of
  the machine that the dial never controlled.
- **No CLI offers computer use that is both headless and Linux.** claude's `--chrome` needs a desktop Chrome with the
  extension and a claude.ai login. Claude Code's desktop control is macOS-only and does not work with `-p`. Codex
  computer use lives in the desktop app.

### 1.2 Local models through LiteLLM (127.0.0.1:10400)

`/v1/models` (read with the master key, from a script that never printed it) lists 10 aliases over four real
models. `local-coder`, `local-chat`, `local-reason`, `local-vision`, `local-chat-th`, `local-chat-voice` and `auto`
all go to `hosted_vllm/qwen3.8-27b`. `local-chat-fast` is `ollama_chat/typhoon-4b`, `gemma4` is
`ollama_chat/gemma4`, and `local-embed` is `ollama/bge-m3`. Every route is local. No route declares
`supports_function_calling` or `supports_vision`, so both were measured. The measurement used mind's own virtual
key, which can reach only `local-coder` (D-124):

| probe on `local-coder` | result |
|---|---|
| one tool (`get_weather(city)`), asked about Bangkok | `finish_reason: tool_calls`, `get_weather({"city": "Bangkok"})`, 1.4 s |
| a 48×48 PNG as a `data:` URI, left half red and right half blue: "name the two colours" | "Red Blue", 141 prompt tokens, 2.1 s |

**So the one local model does tool calls and reads images.** Those are the two ingredients of a screenshot → action
loop. Not measured: how accurately it grounds clicks on real UI screenshots (that is a different skill from naming
colours), how it handles large screenshots, and the other three models. `vLLM --allowed-media-domains` points at a
domain that does not exist (D-124), so screenshots must be sent as `data:` URIs. That suits a loop mind runs
itself.

---

## 2. Vendor APIs (web research, 2026-10-04)

### 2.1 Anthropic

- **Computer use:** the `computer_toolset_20260801` toolset has been GA since 2026-08-19 on the Claude API and
  Google Cloud, with no beta header. It has 17 member tools (`screenshot`, `left_click`, `type`, `zoom` …) and
  batched actions. Models: Fable 5 / 5.1, Mythos 5 / 5.1, Opus 5 / 5.5, Sonnet 5 / 5.5 and Opus 4.8. The older
  `computer_20251124` (beta `computer-use-2025-11-24`) covers Opus 4.5–4.7 and Sonnet 4.6, and is all that Bedrock,
  Foundry and Claude Platform on AWS offer. Opus 5.5 rejects `computer_20251124` with a 400.
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool> ·
  <https://platform.claude.com/docs/en/release-notes/overview>
- **Browser use:** `browser_toolset_20260801` is GA on the Claude API and Google Cloud. It works from the
  accessibility tree, with element refs, forms and tabs (27 tools plus 4 opt-in).
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool>
- **Who hosts the environment:** you do. Neither toolset is available in Managed Agents.
- **Claude Code:** `claude --chrome` drives Claude in Chrome. It needs a Pro/Max/Team/Enterprise plan and a
  `/login`, does not work with an API key or `setup-token`, and does not work in WSL.
  <https://code.claude.com/docs/en/chrome>. Desktop control is a built-in `computer-use` MCP, in research preview,
  macOS-only in the CLI, Pro/Max only, and **not available with `-p`**. <https://code.claude.com/docs/en/computer-use>.
  The documented way to give the Agent SDK a browser is Playwright MCP.
- **For mind:** the API tools need an API key, and mind drives subscription CLIs. They fit BYOK (D-109) and a
  loop mind runs itself; they do not fit `CliExec`.

### 2.2 OpenAI

- **Responses API:** the computer tool is GA (`{"type":"computer"}`), and each `computer_call` carries a batch of
  `actions[]`. You run the browser (Playwright) or the desktop yourself. `computer-use-preview` was retired on
  2026-07-23. <https://developers.openai.com/api/docs/guides/tools-computer-use> ·
  <https://developers.openai.com/api/docs/deprecations>
- **Hosted browser (new, 2026-09-29):** the Agents API `computer_use` tool with
  `environment.type: "openai_hosted"`. It is in beta (`OpenAI-Beta: agents=v1`), and the user approves each new
  origin. <https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use>
- **Codex:** computer use and the browser extension are in the ChatGPT/Codex **desktop app** (macOS/Windows). Neither
  page mentions the CLI. <https://learn.chatgpt.com/docs/computer-use>
- Could not confirm: the full list of models that accept the GA `computer` tool, and whether
  `pending_safety_checks` still exists. The GA guide says only to confirm consequential actions and to treat what is
  on screen as untrusted.

### 2.3 Google

- **Gemini API:** `"type": "computer_use"` with `ENVIRONMENT_BROWSER`, `_DESKTOP` or `_MOBILE`. It is still a
  preview capability, and its safety decision `require_confirmation` comes with policies you can switch off.
  Models: `gemini-3.8-flash` (recommended), 3.7/3.5 flash and 3 flash preview. `gemini-2.5-computer-use-preview`
  was shut down on 2026-07-28. <https://ai.google.dev/gemini-api/docs/computer-use> ·
  <https://ai.google.dev/gemini-api/docs/deprecations>
- **Hosted sandbox:** a containerized browser with CDP/Playwright access and a VNC view, on Google's agent platform.
  <https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/sandbox/computer-use>
- **Gemini CLI:** an opt-in `browser_agent` subagent built on chrome-devtools-mcp (accessibility tree), with an
  optional visual model and a headless mode. <https://geminicli.com/docs/core/subagents/>. None of it can be used
  here while the account is ineligible.

### 2.4 Open source, for local models

- **Playwright MCP** (`@playwright/mcp`): accessibility snapshots by default, so a **text-only** model can browse.
  `--caps=vision` adds coordinate clicks, and it has `--headless` and a choice of browser.
  <https://github.com/microsoft/playwright-mcp>. Codex, Gemini, Kimi, Grok and Copilot CLIs all take MCP servers
  (Copilot's docs use Playwright as their example).
  <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers>
- **browser-use** (Python): any OpenAI-compatible endpoint (so LiteLLM), with `use_vision` for screenshots.
  <https://docs.browser-use.com/open-source/supported-models>. Adding it would bring Python into mind, which
  has none by design (D-004, D-076).
- **UI-TARS-1.5-7B** (Apache-2.0, open weights) and **UI-TARS-desktop** (local/remote computer and browser
  operators, vLLM provider): <https://github.com/bytedance/UI-TARS> ·
  <https://github.com/bytedance/UI-TARS-desktop>. **OpenCUA** 7B/32B/72B (MIT, vLLM ≥ 0.12; 72B scores 45% on
  OSWorld-Verified): <https://github.com/xlang-ai/OpenCUA>. **Agent S3** (Apache-2.0, 72.6% on OSWorld, can ground
  with UI-TARS): <https://github.com/simular-ai/agent-s>. **Qwen3-VL** operates PC and mobile GUIs:
  <https://qwen.ai/blog?id=qwen3-vl>.
- **On this GPU,** a second model for grounding (7B is about 16 GB at fp16, about 6 GB at 4-bit) does not fit
  beside vLLM's ≈ 33.5 GB until vLLM sleeps (`/sleep` returns about 30 GB, the way media-gen already uses it). The
  27B model that is already loaded reads images (§1.2), and should be measured on UI grounding first.

---

## 3. Where a computer-use runtime could live on this server (headless Linux)

| | A. Browser only: headless Chromium in a container | B. A full virtual desktop: Xvfb + WM + xdotool + noVNC in a container | C. The owner's Mac |
|---|---|---|---|
| reaches | websites and web apps (most of what an owner means by "use the computer") | any Linux GUI app | the owner's real apps, files and logged-in sessions |
| models that can drive it | **every CLI backend through Playwright MCP**, including text-only ones (accessibility snapshot). Vision is optional | only vision models with a screenshot → action loop: the vendor APIs (BYOK) or a local VLM | the same as B, plus the vendors' own Mac apps (Claude Code's computer-use MCP, the Codex app) |
| isolation | a container per task (as D-108 does for market jobs), started from a fresh profile; the container is the boundary. Chromium's own sandbox needs user namespaces, which AppArmor restricts here, so it runs `--no-sandbox` inside the container or under Playwright's seccomp profile | the same container boundary, with a bigger surface (X server, WM, apps) | **none that mind controls**: no Landlock on macOS, and the agent acts as the owner |
| egress | the container's own network, with all traffic through an allowlist proxy that lets through only the task's origins and logs every host. Denied = blocked, which matches D-118's spirit | the same | the owner's full network and accounts |
| personal data | page text can be screened like any prompt (D-048); screenshots cannot, so vision on cloud models should be limited to allowlisted origins | every step is a screenshot, which the text-only egress screen (D-048) cannot read; anything personal on screen reaches a cloud model. A local VLM avoids that | the worst case: the screen *is* the owner's private data (I-6) |
| how the owner watches live | Playwright screenshots, or a CDP screencast, streamed to a "Watch" panel on `mind web` and the app | noVNC in the web page (view-only by default) | screen sharing, outside mind |
| recording and audit | a Playwright trace (DOM snapshots, screenshots, network) plus an action log per task, kept under `personal/` so `erase` reaches it (I-4); ledger lines for every model turn | video (ffmpeg on Xvfb) plus the action log | a vendor app's own log, or nothing |
| kill switch | `mind stop` also runs `docker kill` on the task's container (the run record names it); the brake prevents the next one | the same | stopping must cross machines (tailnet); a dropped link fails open |
| first slice | about 7 days | +5–7 days after A | spike first; about 10+ days |

---

## 4. Capability matrix (backend × model)

✅ works, proven by e2e · 🟡 possible but not wired · ❌ not supported here · ⛔ unavailable · M = through an MCP
server mind would hand the CLI · L = through a loop mind would run itself.

| backend | model measured | act (write files) | run (commands) | browser | desktop computer use | vision |
|---|---|---|---|---|---|---|
| claude-local | `local-coder` (qwen3.8-27b) | ✅ in the fence | ✅ in the fence | 🟡 M; the fence needs one more loopback port for the browser | 🟡 L (the model passes the tool-call and image probes) | ✅ model probe |
| grok-local | `local-coder` | ✅ in the fence | ✅ in the fence | 🟡 M | 🟡 L | ✅ model probe |
| claude | `claude-haiku-4-5` (the CLI default and opus/sonnet were not run) | ✅ | ✅ | 🟡 M · `--chrome` needs a desktop Chrome, so ❌ on this server | ❌ in the CLI here (macOS-only, no `-p`) · 🟡 L through the API toolset with BYOK | ✅ (the Read tool opens images) |
| grok | `grok-4.6-build` / `grok-4.7-build` | ✅ | ✅ | 🟡 M | ❌ | 🟡 `--prompt-json` (not measured) |
| kimi | the CLI default (not reported) | ✅ | ✅ | 🟡 M | ❌ | not in `--help` |
| codex | — | ❌ here (bwrap) | ❌ here | 🟡 M | ❌ in the CLI · 🟡 L through the OpenAI computer tool with BYOK | `-i` (not measured) |
| copilot | — | ❌ no grant (finding 4) | ❌ | 🟡 M | ❌ | not in `--help` |
| gemini | — | ⛔ account | ⛔ | 🟡 `browser_agent` | 🟡 L through the Gemini API with BYOK | — |
| ollama | `qwen3.8:27b` | ❌ no tools; now says so | ❌ | ❌ | 🟡 L (the same weights as `local-coder`) | ✅ |

Read across, the matrix says: **acting is solved on five routes, the browser is one MCP step away on every CLI,
and desktop control on this server means a loop mind runs itself.**

---

## 5. Decisions for the owner — one at a time, in this order

Each decision lists its options, a recommendation and the effort. The later ones depend on the earlier ones; ask
them in order.

### Decision 1 — which surface "computer use" targets first

| option | pro | con |
|---|---|---|
| **A. Browser** (headless Chromium in a container on this server) | covers most real tasks (web apps, forms, dashboards, admin consoles); works for **every CLI backend** through Playwright MCP, including the local model without vision; cheap per step (text snapshots, not screenshots); outcomes are easy to verify in an e2e (a test page the test serves); headless works today | no desktop apps; some sites fight automation; logging in to real accounts needs a credential decision |
| B. A virtual desktop (Xvfb/noVNC container) | any Linux GUI app; matches "computer use" literally; the vendor CU APIs target it | needs a vision model at every step (slower, costlier); a cloud model sees every pixel (D-048 cannot screen images); a bigger surface; harder to verify |
| C. The owner's Mac | the owner's real apps and sessions; what "my agent uses my computer" often means | the highest risk: real accounts, irreversible actions, prompt injection acting as the owner; no fence mind controls; the kill switch crosses machines |

**Recommendation: A**, built behind a "surface" seam so that B can follow. C waits until a spike shows a credible
fence. Effort: A ≈ 7 days for a working browser (S17.7–S17.8), ≈ 11 with the dial and the watch view (all of
phase C); B +5–7; C needs a spike first.

### Decision 2 — where it runs

| option | pro | con |
|---|---|---|
| **A. A container per task on this server** (the pattern of D-108) | a clean profile each time; egress allowlist; recording; `docker kill` as the kill switch; personal data stays on this machine | sessions that need the owner's login must be given credentials explicitly; Chromium needs `--no-sandbox` inside the container (AppArmor userns) |
| B. The user's machine (Mac/PC app) | real sessions, no credential hand-over | mind has no fence there; the kill switch and audit depend on another machine being reachable |
| C. A and B together | flexibility | twice the safety work before either is safe |

**Recommendation: A.** Effort is included in decision 1's estimate.

### Decision 3 — the dial and approval for computer actions

| option | pro | con |
|---|---|---|
| **A. A new category `operate` (browser/screen), with effective level = min(operate, reach)**: 1 = look and propose; 2 = act only on the task's allowlisted origins, recorded and reported (like D-043); 3 = act anywhere (typed phrase, D-042). A fixed list of sensitive actions (payment, sending a message or email, deleting, entering credentials, accepting terms) **always pauses for a yes**, at every level. An approval binds to the specific action (closes finding 6) and is spent once (D-144) | readable; reuses what the owner knows; the always-pause list matches what Anthropic, OpenAI and Google all ask for | one more category to explain; the sensitive list must be kept up to date |
| B. Reuse `reach` (≥ 2 = may operate the browser) | no new concept | too coarse: the reach that allows a shell would also allow the browser; nothing pauses on a payment |
| C. Approval per task: the owner approves a plan with its origins once, and the agent acts within it | one yes per task | the plan drifts from what happens; one approval covers many irreversible steps |

**Recommendation: A.** Effort about 2–3 days, including binding approvals to the action.

### Decision 4 — how "สั่งงานได้" works: multi-step tasks, progress, channels

Today a "task" is one `turn`: one CLI process, cut off at **120 s** (finding 7), with no plan, no progress and no
resume. Triggers wake level-1 turns (D-054). A2A messages land in an inbox and never run by themselves (D-063).

| option | pro | con |
|---|---|---|
| **A. A task object in the engine**: `mind task new\|show\|stop` with a persisted plan, a step log and a budget (time, turns, tokens). Each step is an ordinary `turn` (ledger, dial, fence, egress, stop all still apply). The web page, the app and Telegram call the same command (the principle of D-086) | one path for every channel; it can resume after a crash; progress is visible everywhere; `stop` reaches it | the most engine work |
| B. Hand long tasks to vendor-native background sessions (`claude --bg`, the Codex cloud) | little engine work | tied to one vendor; it runs outside mind's dial, ledger, fence and egress screen, which defeats I-6 and D-149 |
| C. Keep single turns, raise the timeout and stream output | the smallest change | no plan, progress or resume; one stuck process per task |

**Recommendation: A.** The channels come in order: CLI + web + app first (one API), then Telegram, while A2A and
triggers may only *propose* a task. Effort about 6–8 days.

### Decision 5 — how the agent gets its hands on the browser

| option | pro | con |
|---|---|---|
| **A. mind hands every CLI one MCP server, Playwright MCP, pointed at the task's browser container**, through mind's own config (`--mcp-config <mind file>` plus `--strict-mcp-config` for claude, and the equivalent for the others). The owner's own MCP servers stay off, so D-047's intent holds. For the local chain, the fence grants exactly one more loopback port | one mechanism for all six CLIs and both local routes; text-only models work; no API keys | re-opens MCP, which needs a careful per-vendor config like D-119/D-121; the MCP server sees the page, so its own egress must also be fenced |
| B. The vendors' computer-use APIs (Anthropic toolset, OpenAI `computer`, Gemini `computer_use`) with BYOK keys | the strongest models at computer use; desktop-capable | needs API keys (subscription logins do not work); a loop mind must write per vendor; screenshots go to the cloud |
| C. mind's own loop over LiteLLM `local-coder` (tools and images measured, §1.2) | fully local; I-6 holds; works for the desktop too | grounding accuracy is unmeasured; mind owns a new agent loop (D-002 said "only if the CLIs cannot") |

**Recommendation: A for the browser now, C for the desktop later, B only for owners who bring keys.** A is about
3 days on top of decision 1.

---

## 6. Backlog proposal — E17 "Act, take tasks, use the computer" (D-149)

The rule for the whole epic: **every story's acceptance criteria include a real-backend e2e** in
`test/e2e/*.e2e.ts`. The e2e runs the real CLI or model, and checks the real outcome (a file, a process, a server
that received a request, a ledger line), on every backend that claims the capability. Every backend that does not
claim it gets an e2e proving it refuses plainly. Stubs count only as unit tests.

**Phase A — honest actions on today's backends (≈ 4–5 days, no new capability)**

| # | story | days | acceptance criteria |
|---|---|---|---|
| S17.1 | A capability table in the engine (backend × model → act, run, browser, desktop, vision), shown by `mind backends` and `doctor`. A turn that needs a capability its backend lacks is refused with a reason (codex when bwrap cannot start; ollama at level ≥ 2; gemini when ineligible) | 2 | AC1: the table matches `actions.e2e.ts` for every backend here · AC2: **e2e** codex/ollama/copilot at level 2 are refused with the reason, and nothing is spent · AC3: claude, grok, kimi and both local routes still pass write/run/stop |
| S17.2 | copilot gets a level-2 grant (decided like D-119) | 0.5 | AC1: **e2e** copilot write-l2, run-l2 and stop pass · AC2: level 1 still writes 0 |
| S17.3 | The level-1 propose instruction reaches vendors without a system flag (codex, kimi, copilot, gemini), or level 1 is refused on them (owner decision) | 1 | AC1: **e2e** kimi propose-l1 files a proposal, or is refused with a reason |
| S17.4 | `turn --proposal` runs only what was approved: the approved `what` becomes the prompt (or a mismatch is refused) | 1 | AC1: **e2e** an approval for X cannot run Y · AC2: approve-once still passes on every acting backend |

**Phase B — tasks (≈ 6–8 days)**

| # | story | days | acceptance criteria |
|---|---|---|---|
| S17.5 | `mind task new\|show\|stop\|list`: a persisted plan, a step log and a budget; each step is a `turn`; resumes after a crash; no 120 s ceiling per task (each step keeps its own timeout) | 4 | AC1: **e2e** a 3-step task (write → run → verify) completes on claude-local and claude, with a progress line per step · AC2: **e2e** `mind stop` mid-task ends the current step, and no later step starts · AC3: the ledger has a line per step, tied to the task id |
| S17.6 | Channels: web and app (`/api/tasks`), Telegram `/task`; triggers and A2A only *propose* tasks | 3 | AC1: **e2e** a task created through the web API runs on a real backend and its progress shows in `/api/state` · AC2: **e2e** an A2A message never starts a task without a yes |

**Phase C — browser (≈ 9–11 days; decisions 1, 2, 3, 5)**

| # | story | days | acceptance criteria |
|---|---|---|---|
| S17.7 | A browser container per task: headless Chromium, a fresh profile, an egress allowlist proxy, a Playwright trace, `docker kill` from `mind stop` | 4 | AC1: **e2e** the agent opens a page this test serves, fills a form and submits, and the test's server receives the exact value · AC2: **e2e** a non-allowlisted origin is blocked at the proxy and logged · AC3: **e2e** `stop` kills the container |
| S17.8 | Browser hands for every CLI through Playwright MCP (mind's own config only), plus one fence grant for the local chain | 3 | AC1: **e2e** S17.7's form task passes on claude-local, grok-local, claude, grok and kimi, and each backend not wired is refused plainly · AC2: the owner's own MCP servers are still not loaded (checked like D-119) |
| S17.9 | The `operate` dial, the always-pause list, and approvals bound to the action | 2 | AC1: **e2e** level 1 proposes the click and does not click · AC2: **e2e** a "pay" or "send" button pauses for a yes at level 3 |
| S17.10 | Watch and audit: a live screenshot stream on the web and in the app; recordings under `personal/`, which `erase` reaches | 2 | AC1: **e2e** a running task's screenshots appear in the page · AC2: `erase` removes its recordings, and the dry run lists them |

**Phase D — desktop (≈ 5–7 days; after phase C)**

| # | story | days | acceptance criteria |
|---|---|---|---|
| S17.11 | A virtual desktop container (Xvfb, WM, xdotool, noVNC) and mind's own screenshot → action loop over LiteLLM `local-coder`; BYOK vendor CU APIs as an option | 5 | AC1: **e2e** the local model opens a desktop app in the container and makes a change the test can read back · AC2: grounding accuracy is measured on a fixed set and recorded in `notes/` · AC3: screenshots never leave the machine on the local route |

**Phase E — the owner's Mac:** a spike (SP-6) first. Can a Mac-side runner be fenced, stopped from here, and
audited? A negative result is a successful spike.

**Order:** A → B → C → D, with E as a spike only. Phase A can start now: it targets all six e2e failures of
2026-10-04 (copilot ×4, kimi and codex at level 1).
