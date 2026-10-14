# D-151 / D-155 — a task's browser container and one Playwright MCP, on this machine (2026-10-05)

> **Revised after the independent review of PR #19 (FIX-FIRST, same day).** The review's findings, what changed and
> the re-run are in "Review of PR #19" at the end. Where this record and that section disagree, that section is the
> current state: the session log is gone, `browser_run_code_unsafe` is no longer served, and the MCP port now needs
> a token.

**What was proved:**
- `mind browser up` starts one task's container from an image built here: headless Chromium and the pinned
  Playwright MCP (`@playwright/mcp@0.0.83`, Playwright 1.64.0-alpha), as the owner's uid with no capabilities.
- Its MCP port is published on `127.0.0.1` only (`8931/tcp -> 127.0.0.1:30730`).
- The container reaches the task's allowed origin and nothing else, refused at three layers:
  - Playwright MCP's own origin list;
  - the egress proxy (403, logged);
  - the container's kernel firewall, which drops a socket opened around the proxy.
- A **real claude-local turn** (Claude Code on `local-coder` through LiteLLM, inside the D-118 fence) was handed
  only mind's MCP config. It opened the page, read a heading of random words, and could not open the forbidden
  page. Its fence had exactly one port more than usual: the container's.
- The opt-in cloud `claude` turn (`--model haiku`) did the same with the same config.
- The trace, screenshots, action log and egress log were in the subject's `personal/` directory.
- `mind stop` docker-killed the container.
- A process that started a browser as its owner and was SIGKILLed left an orphan that the next
  `mind browser status` ended.
- Nothing of the run's state root was left in `docker ps -a`.

**How:** `MIND_E2E_BROWSER=1 bun run e2e:browser` (`test/e2e/browser.e2e.ts`, outside `bun test`).
- `MIND_E2E_BROWSER_CLAUDE=1` adds the cloud claude case.
- The fenced turn runs in its own process (`test/e2e/support/browser-turn.ts`). The fence re-enters the running
  main as its helper, and under `bun test` the main is the test file. That script answers `__fence` and
  `__fence-supervisor` as `bin/mind.ts` does.

**Not reachable from `mind turn` yet.** `TurnRequest.browser` exists and `CliExec`/`LocalCliExec` honour it, but
nothing in the CLI sets it. The `operate` dial (D-153, PR `feat/e17-operate-dial`) decides when a turn gets it.

## Setup

- A temporary HOME, `XDG_STATE_HOME` and `XDG_DATA_HOME`, and the synthetic subject `e2e-browser`. No real agent or
  state root is touched.
- The LiteLLM key comes from the runner's `~/.secrets/.env.mind-litellm` (D-124), the same file as the other
  e2e files.
- The test serves two pages itself, from `Bun.serve` on the docker bridge's gateway address (looked up at run
  time) and an ephemeral port each:
  - **allowed**: an `<h1>` of random words, for example "Allowed basalt fjord garnet 3777";
  - **forbidden**: another random heading.
- Each server counts the requests it receives.
- The task allows exactly `http://host.docker.internal:<allowed port>`. `--add-host host.docker.internal:host-gateway`
  makes that name reach the test's server.

## Runs

| run | result | claude-local | cloud claude (haiku) |
|---|---|---|---|
| 1 | 3 fail — the fenced turn ran in-process and the fence re-entered the test file (the reason for `browser-turn.ts`); one assertion matched the echoed code; `--rm` removal raced `docker ps -a` | — | — |
| 2 | 1 fail — denied `CONNECT` lines were logged as `https://…`, though Playwright's request API tunnels http too; the proxy now logs `host:port` for a refused tunnel | confirmed, 18.5 s | — |
| 3 | 6/6 | confirmed | — |
| 4 | 6/6 (first run on the content-tagged image, built by `up` in 2.5 s from cache) | confirmed, 18.7 s | — |
| 5 | 7/7 | confirmed, 19.7 s | confirmed: `Allowed cobalt delta harbor 5030` |
| 6 | 6/6 | confirmed, 16.9 s | — |
| 7 | 6/6 | confirmed, 15.5 s | — |

- claude-local answered 7 of 7 turns, from run 2 on. Every answer had the form
  `ALLOWED: <the exact heading>` then `SECOND: BLOCKED`.
- The forbidden server counted 0 requests in every run.
- The allowed server counted exactly 1 request per turn: the model used the browser, not a guess.
- `leftAfter` was `[]` in every run.

## What each layer did (run 5's egress log, abridged)

```
{"decision":"start","origin":"http://127.0.0.1:3128","allowed":["http://host.docker.internal:<allowed>"]}
{"decision":"allow","origin":"http://host.docker.internal:<allowed>"}
{"decision":"deny","origin":"host.docker.internal:<forbidden>","reason":"not an allowed origin"}
{"decision":"deny","origin":"example.com:443","reason":"not an allowed origin"}
```

**`browser_navigate` to the forbidden origin**
- Refused by Playwright MCP: `net::ERR_BLOCKED_BY_CLIENT`.
- That list "does not serve as a security boundary" (its own `--help`), so the next two checks go around it.

**`browser_run_code_unsafe` with `page.context().request.get(<forbidden>)` and `get(https://example.com/)`**
- Both came back `403`, logged as `deny` above.
- This is the context's request API. It honours the proxy and not the origin list.

**`browser_run_code_unsafe` with Node's `fetch(<forbidden>)` from the MCP server's own process**
- It never used the proxy.
- The result was `FAILED TimeoutError`: the packet was dropped by the container's `OUTPUT` policy (owner-match: only
  the proxy's gid may leave).
- During the manual check before the e2e, `fetch("http://1.1.1.1/")` gave `UND_ERR_CONNECT_TIMEOUT` the same way.

## Recording and retention

`<XDG_DATA_HOME>/mind/<subject>/personal/browser/<task>/` holds:

| file | what it is |
|---|---|
| `trace/trace-NN-<ms>.trace`, `.network`, `trace/resources/`, `trace/screencast/*.jpeg` | A Playwright trace, one name per browser context. It is started once per context by `record.cjs` with `live: true`, so it is written as the task runs and survives a `docker kill`. It opens in `npx playwright show-trace`. |
| `screens/NNNN-<ms>.png` | A full-page screenshot after every page load (4 per run here). |
| `actions.jsonl` | The guard's log of every tool call, with each typed value replaced by its length. Playwright MCP's own session log (`--save-session`) is **off**: it wrote typed values in clear. |
| `session/` | The page snapshots Playwright MCP links from a navigation's answer (aria YAML; a password field's value is not in them). |
| `trace/<name>.stopped.txt` | Present when a context's trace was stopped before keystrokes into a password field; nothing after that moment is recorded for that context. |
| `egress.jsonl` | One line per proxy decision. |

**Retention.**
- mind deletes none of it on its own.
- It stays until the owner runs `mind erase` (the whole `personal/` directory goes) or deletes the directory.
- It is under `personal/` so that `erase` reaches it (I-4).
- S17.10 adds listing it in the erase dry run.
- Files are owned by the owner's uid (the browser runs as that uid), so the owner can always delete them. Files
  are 600 and directories 700 (the entrypoint's `umask 077`; checked over every file in the e2e).
- Video is off. Playwright MCP 0.0.83 records video only when the model asks (`browser_start_video`), and the
  trace's screencast frames already show each step.

## Per-vendor MCP wiring, measured locally (2026-10-05)

| vendor | version | how a server is given | the owner's own servers kept out? | here |
|---|---|---|---|---|
| claude / claude-local | 2.1.289 | `--mcp-config <configs...>` | yes: `--strict-mcp-config` | **wired** — `--mcp-config <file> --strict-mcp-config --allowedTools …,mcp__mind-browser`; proved on both |
| grok-local | 1.0.46 | no flag; `[mcp_servers.<name>] url = …` in `$GROK_HOME/config.toml` (`grok mcp add --transport http --scope user` writes exactly that) | yes (the home is mind's) | **refused** — see below |
| grok | 1.0.46 | the same file in the owner's `~/.grok`, which holds the login | no | refused |
| kimi | 2.1.1 | no flag in `--help`. From the binary's own MCP skill text: `$KIMI_CODE_HOME/mcp.json`, merged with the working directory's `.mcp.json` and `.kimi-code/mcp.json` | no strict switch | refused |
| codex | 0.155.1 | `-c mcp_servers.<name>.url="…"` | no. `codex mcp list` in a scratch `CODEX_HOME` with an owner-style server: `-c` *adds* ours beside it, and `-c mcp_servers={…}` merges too | refused, and codex cannot act here anyway (bwrap, D-121) |

**grok-local, measured with a real turn on `local-coder`** (outside mind, in a scratch home, with D-119's
`--disallowed-tools`):
- The model was told "a browser MCP server with 25 tools is connected" but saw no tool names.
- grok exposes MCP tools only through `search_tool`/`use_tool`, which D-119 removes at every level.
- So it fell back to `curl` against the page and never touched the container (the egress log had only `start`).
- In a real grok-local turn the D-118 fence would have stopped that `curl`, and the turn would have failed.
- Wiring grok means giving back `use_tool`. D-119 removed it because a level-1 turn used it to reach a shell.
  **That is a product decision about D-119**, so grok-local is refused with that reason rather than wired.

## Limits, said plainly

- **The token is the owner's.** It is in the task's record and the vendor's MCP config, both mode 600 under the
  state root. Anything running as the owner on this machine — a cloud turn's shell among them — can read it, as it
  can read the owner's other files. What the token closes is everything else: other local users, other containers,
  a page in the browser.
- **The tools a level approves are the turn's; the tools the container serves are fixed.** The guard refuses
  `browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload`, `browser_drop` and any tool it does not know,
  at every level. The turn's `operate` level (D-153, `min(operate, reach)`, now on `Restraint`) picks what claude
  pre-approves: 0 no browser, 1 look tools only (`LOOK_TOOLS`), 2 and 3 also click, type and submit.
- **Sensitive actions are held, not paused.** D-153's list (`src/decide/sensitive.ts`, bundled into the image as
  `sensitive.cjs`, a test pinning the two equal) is asked inside the container before every click, keystroke,
  select or upload, and an action it flags does not happen. There is no approval channel into a task yet, so
  "waits for a yes" means held with the reason given back to the model; an approval bound to the action, carried
  into the container, is the next step (with the task object, D-154). **This is a choice to confirm:** it makes
  logging in impossible inside a task until that channel exists.
- **Redaction knows what it is told.** A context's trace stops before any keystroke into a password field (which
  the list holds anyway), and the action log keeps no typed value at all. A secret typed into an ordinary text
  field the list does not flag is in that context's trace.
- **A CONNECT tunnel is judged by host and port.** Inside the TLS, the browser could name another site (SNI, Host)
  served from the same address — a CDN fronting several names is the real case — and the proxy cannot tell. The
  allowlist holds at "which address and port", not "which site on it".
- **A name with several addresses** is connected to at the first one resolved (the one that was checked), never
  resolved again; every address is checked against the private-range rule. Upstreams that do not connect in 15 s,
  or sit idle 5 minutes, are cut.
- **`host.docker.internal` is an explicit way to reach this machine.**
  - An allowlist naming `http://host.docker.internal:<port>` opens that port on the docker bridge's gateway, and
    only that port.
  - A public name that resolves to a private, loopback, link-local, CGNAT or multicast address is refused even when
    the name is allowed (DNS rebinding).
- **Chromium runs `--no-sandbox`** (Dockerfile). The container is the fence:
  - `--cap-drop ALL` with NET_ADMIN, SETUID, SETGID, KILL and SETPCAP added back for the entrypoint; after it, only
    docker-init (PID 1) and the root deadline keep any (the deadline: KILL, SETUID, SETGID, SETPCAP — no
    NET_ADMIN). Chromium, Playwright MCP, the guard, the proxy and the log writers have an empty bounding set
    (measured in the e2e, case 3);
  - `no-new-privileges`, a read-only root filesystem, tmpfs for `/tmp`, `/run` and `/home/browser`;
  - memory, pid and CPU limits;
  - one bind mount, the task's output directory.
- **The image is about 1.9 GB.**
  - Its tag includes a digest of `docker/browser/`, so an edited proxy or entrypoint means a new build, not a stale
    container.
  - It is built here and never pushed.
- **No orphans has a bound, not a guarantee of instant cleanup.** If nothing ever runs mind again, the
  container's own deadline ends it (`--ttl`, default 1800 s, at most 4 h); every `up` and `status` also ends a
  record past `startedAt + ttl + 60 s`, whoever owns it.

## Review of PR #19 (2026-10-05, FIX-FIRST) — what changed

| # | finding | fix | proved by |
|---|---|---|---|
| 1 HIGH | any container on the bridge could drive the browser and run code in it | (a) the container's `INPUT` policy is DROP; the guard's port is accepted from the bridge's gateway only, and loopback to the MCP server's own port only from the guard's uid. (b) a per-task 64-hex bearer token, checked in constant time by `guard.mjs` in front of Playwright MCP (now on the container's loopback, 8932), and sent by claude through the `headers` of its http MCP config (600); docker gets it as `--env MIND_TOKEN` with the value in its environment, never in an argv. (c) the guard serves an allowlist of 21 tools: run-code, evaluate and file tools are refused and hidden from `tools/list` | e2e 2: no token / wrong token 401 from this machine; from a second container on the bridge, **with** the token, 8931 and 8932 both `TimeoutError`; `tools/list` without them; calling them refused. `test/browser/guard.test.ts` |
| 2 MED | the TTL could be beaten from inside | `timeout` runs as root with KILL, SETUID, SETGID and SETPCAP only, outside the privilege drop; the sweep ends any record past `startedAt + ttl + 60 s`, owner or not | e2e 8: the browser's uid froze Playwright MCP with SIGSTOP and was refused (`Operation not permitted`) stopping the deadline; the 60 s container ended at 62 s |
| 3 MED | `erase` failed verification and left the container running | records and wiring moved under the subject (`browser/<subject>/`); a `browser` tree in the data map; `planErase` lists the subject's tasks and `commitErase` docker-kills them first; a refused kill counts as a failure | e2e 9: `erase --no-agent --yes` on a subject with a running browser exits 0, `erased-and-verified`, container gone. `test/erase/plan.test.ts` (clean, and a refused kill not clean) |
| 4 MED | credentials in clear in the recording; 644/755; one trace name | `umask 077` (files 600, dirs 700); one trace per context, named per context; after PR #18 merged, `classifyAction` runs inside the container before every element action and holds what D-153 lists (a password field among them), so the secret is never typed; the trace is also stopped before any password keystroke; the session log is off, the guard's action log records lengths only | e2e 5 (after rebase): typing into the password field and clicking "Pay now" were held (`credentials.value`, `credentials.field`; `payment.words`), typing into a search box was not; nothing was POSTed; the password is in none of the 44 files; every file 600, every directory 700. Before the rebase (R2–R4) the password was typed and reached the site, and was in none of the files then either |
| 5 MED | the wiring auto-allowed the whole server at any level | `browserWiring(vendor, hands, restraint)` takes the turn's **operate** level (D-153, added to `Restraint` from the merged dial): 0 refused, 1 look tools only, ≥ 2 adds act tools; tools approved one by one; run-code and file tools never; sensitive actions held in the container whatever is approved | `test/browser/mcp-config.test.ts`, `test/exec/cli-exec.test.ts`; e2e 6 at operate 1 |
| 6 LOW-MED | `up` ignored the brake | `browserUp` refuses while `STOP` exists | e2e 10, `test/cli/browser.test.ts` |
| 7 LOW | "every capability gone" was false (CapBnd `0x10c0`, root shells kept caps) | SETPCAP added so `setpriv --bounding-set` really cuts; no root shell stays as a parent (FIFOs instead of pipelines, `exec` in the forked child); the comments now tabulate who keeps what | e2e 3: every process but `docker-init` and `timeout` has `CapBnd 0`; `timeout` is `0x1e0` |
| 8 LOW | races between two `up` | records created with `wx`; "port is already allocated" moves to the next port | `test/browser/runtime.test.ts` |
| 9 LOW | proxy limits unwritten; no upstream timeout | written above and in `proxy.mjs`; 15 s connect, 5 min idle | — |

Container names now carry 8 hex of the state root's hash (`mind-browser-<hash>-<task>`), so two state roots
cannot collide on a docker name. The record schema is `mind/browser@2`.

**Re-run after the fixes** (11 cases; 12 with cloud claude):

| run | result | claude-local | cloud claude (haiku) |
|---|---|---|---|
| R1 | 10/11 — case 9 read the verdict from the wrong field of erase's `--json`; erase itself exited 0 | confirmed | — |
| R2 | 11/11 | confirmed, 14.4 s | — |
| R3 | 12/12 (case 3 now starts Chromium first: six `chrome-headless` processes, all `CapBnd 0`) | confirmed, 17.0 s | confirmed |
| R4 | 11/11 (docker's environment comes from the caller, not read ambiently) | confirmed, 20.3 s | — |
| R5 | 11/11 — rebased on PR #18/#20: operate-level wiring, `classifyAction` in the container | confirmed, 15.7 s | — |

claude-local answered 5 of 5 turns after the fixes, with look tools only. The password search covered
37–42 files per run, with 0 hits. The frozen browser's container ended at 62.0 s for a 60 s TTL in every run.
`leftAfter` was `[]` in every run.

## Re-review of PR #19 (at 75326dc) — what changed

The re-review confirmed the nine first-round fixes held under attack. It found one HIGH and two smaller items.

| # | finding | fix | proved by |
|---|---|---|---|
| 1 HIGH | `browser_navigate` (served at operate 1) took `javascript:` and `data:` URLs: page code ran past the evaluate ban; a `javascript:` URL filled a password and called `form.submit()`, and a `data:` page auto-posted to an allowed origin — nothing held, and the password landed in `actions.jsonl` and the traces | the guard refuses any `browser_navigate` / `browser_tabs` URL that is not `http:`, `https:` or exactly `about:blank`, before the server sees it; every URL in the action log is cut to its origin (`https://host/…`), and a refused scheme to its kind and length; defence in depth: `record.cjs` refuses `page.goto` for anything else too | e2e 4b: `javascript:document.title=…`, the `javascript:` login-and-submit, the auto-posting `data:` page and `browser_tabs new` with a `javascript:` URL — all refused; the title unchanged; nothing posted; the password is not in `actions.jsonl`. `test/browser/guard.test.ts` (eight schemes, origin-only logging) |
| 2 LOW-MED | the guard served all 21 tools to any token holder, so the level held only through claude's `--allowedTools` | the container's operate level is fixed at `up` (`--operate 1|2`, default 1, in the record, `MIND_OPERATE` to the guard): at 1 the guard serves the eight look tools only, in `tools/list` and on calls; a turn's wiring is capped at the container's level | e2e 4a: an operate-1 container lists exactly `LOOK_TOOLS`; `browser_click`, `browser_type`, `browser_fill_form` and `browser_press_key` with a valid token are refused. Unit tests hold the guard's LOOK equal to `LOOK_TOOLS` |
| 3 LOW | a neutral "Go" submit in a login form was not held | `classifyAction` gains `credentials.login-submit` (added to #18's floor with four examples): a click or Enter on a form's submit control, a submit, or typing that submits — in a form holding a password field — is credentials, whatever the button says, search-looking form or not. `record.cjs` reads `submitsForm` and `formHasPassword` from the page | `test/decide/sensitive.test.ts`; the bundle test keeps the container's copy equal |

Found on the way: `up` treated any HTTP answer as ready, but the guard answers (502) before Playwright MCP behind
it does. The first call of a fast caller then got the guard's 502 (it showed in e2e 4a). Readiness is now an
authorised request whose answer is neither 401 nor 502.

**Re-run** (13 cases): R6 was 11/13 — case 4a hit the readiness race, and case 7 then saw 4a's container still
up. R7 was **13/13**: claude-local confirmed (19.9 s) with the forbidden page blocked, `leftAfter` `[]`.

## Round-3 re-review (at 4d11a2a) — dialogs

**Finding (MEDIUM-HIGH):** `browser_handle_dialog` was never classified.
- A neutral "Show" button called `prompt('Enter your password')`. Accepted with `promptText`, it POSTed the
  password with nothing held, and the password was in the trace.
- A neutral "Next" button called `confirm('Delete your account permanently?')`. Accepted, it reached
  `POST /delete-account`.

**Fix (full, in `docker/browser/record.cjs`).** `Dialog.prototype.accept` is wrapped the first time a page opens a
dialog, which is before any `browser_handle_dialog` call can accept one. Accepting is described as a step for
D-153's list and classified:

| dialog type | treated as | held when |
|---|---|---|
| `prompt` | typing `promptText` into a field labelled with the dialog's message; its value class is inferred from the message (password, code, card, secret, email, text) | the list flags it: a password-like prompt via `credentials.value` and `credentials.field`. For password, OTP or secret prompts the trace is stopped first |
| `confirm`, and any type not known here | a `submit` whose text is the message: accepting commits whatever the page asked | always (`commit.submit`), with the message's own categories named in the reason (`delete.words` here) |
| `alert`, `beforeunload` | acknowledging, or leaving the page | never |

- A held dialog is **dismissed** rather than left open. Playwright MCP clears its modal state before calling
  `accept`, so a dialog left open would wedge the page.
- `dismiss` is never touched, so dismissing always works.
- **A cost said plainly:** every accepted `confirm` is held, whatever it says. With no approval channel into a task
  yet, an agent can dismiss a confirm but never accept one.

**Proof** (e2e 5b, run R8, 14/14):
- The password prompt and the delete confirm were held: `dialog-type` (`credentials.value`, `credentials.field`)
  and `dialog-submit` (`delete.words`, `commit.submit`).
- The page still answered a snapshot after each hold, and dismissing a confirm worked.
- A "Your name?" prompt accepted with "Alice" went through. The only POST the server saw was `/hello name=Alice`:
  no password, no delete.
- The password is in none of the recording's files.
- claude-local was confirmed (15.2 s), and `leftAfter` was `[]`.
