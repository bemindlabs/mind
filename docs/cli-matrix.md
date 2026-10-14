# CLI matrix

What each AI CLI actually does, read off its own `--help`. Nothing here is
recalled; every row was run. `src/exec/registry.ts` encodes the same facts in
a form the code uses — this file is the human-readable half.

**These differences move between releases**, and when they move, the failures
they cause are silent. Re-measure before trusting a row.

Measured 2026-09-20 against: `claude 2.1.278` · `grok 1.0.24` ·
`codex 0.153.4` · `gemini 0.38.2` · `copilot 0.0.367` · `kimi 2.0.2`.
Six CLIs were surveyed; a seventh the backlog names (agy) was not.

> ⚠ **Drift recorded since:** claude 2.1.280 no longer sends the hook's `source` field and adds
> `effort` to `PostToolUse` (`.scrum/decisions.md`, D-036 and `notes/`), and the soul-verify probes
> of 2026-09-23 ran against claude 2.1.280 · codex 0.155.1 · grok 1.0.40 · copilot 0.0.367 ·
> kimi 2.0.2 (gemini was not measurable on the test account). A full re-measure of this table is
> still owed; the rows below are the 2026-09-20 readings.

Re-measured 2026-09-21 for the read-only section below, and two of them had
moved already: `grok 1.0.40` and `codex 0.155.1`. The grok row in *Built-in
tool names* is the 1.0.40 reading; the rest of that column is from the first
survey.

Re-measured 2026-09-26 for S12.6 (D-119 → D-121) against `grok 1.0.40`, `kimi 2.0.2` and
`codex 0.155.1`, on a local model through LiteLLM in isolated homes, every connection counted
with `strace`, then re-run through Mind's own `CliExec`. The probe logs are in
`notes/2026-09-26_s12.6/`; what they showed is in
[§ S12.6](#s126-what-the-2026-09-26-probes-changed) below and in the registry's comments.

## How to re-measure

```sh
for c in claude grok codex gemini copilot kimi; do
  "$c" --help </dev/null > "help-$c.txt" 2>&1
  "$c" --version </dev/null 2>&1 | head -1
done
```

Read the files. Do not infer a flag from another vendor's spelling of it — the
table below exists because that inference is wrong more often than it is right.

## Invocation

| | claude | grok | codex | gemini | copilot | kimi |
|---|---|---|---|---|---|---|
| headless | `-p/--print` | `-p/--single` | `exec` (subcommand) | `-p/--prompt` | `-p/--prompt` | `-p/--prompt` |
| output formats | `text`, `json`, `stream-json` | `plain`, `json`, `streaming-json`, `streaming-messages-json` | text (stdout = final, stderr = progress) | `text`, `json`, `stream-json` | `--stream on\|off`, `-s` silent | `text`, `stream-json` |
| model flag | `--model` | `-m/--model` | `-m/--model` | `-m/--model` | `--model` (fixed enum) | `-m/--model` |
| turn cap | `--max-turns` | `--max-turns` (headless only) | — | in settings | — | — |
| approval / sandbox | `--permission-mode default\|acceptEdits\|plan\|bypassPermissions` | same + `auto`, `dontAsk` | `--sandbox read-only\|workspace-write\|danger-full-access` + `--ask-for-approval` | `--approval-mode default\|auto_edit\|yolo\|plan` | `--allow-all-tools`, `--allow-tool`, `--deny-tool` | `-y/--yolo`, `--auto`, `--plan` |
| tool filter | `--allowedTools` / `--disallowedTools` / `--tools` | `--tools` / `--disallowed-tools` / `--allow` / `--deny` | — (sandbox only) | `--allowed-tools` (deprecated) | `--allow-tool kind(arg)` | — |
| has `doctor` | yes | yes | yes | no | no | yes |

## Identity: how a soul reaches the model

The column that matters most, and the reason Mind exists.

| | system-prompt flag | file it reads | strength |
|---|---|---|---|
| claude | `--append-system-prompt` (append) · `--system-prompt` (replace) | `~/.claude/CLAUDE.md` | **system** |
| grok | `--rules` (append) · `--system-prompt-override` (replace) | `~/.claude/CLAUDE.md` | **system** |
| codex | — | `$CODEX_HOME/AGENTS.md` | user |
| gemini | — | `~/.gemini/GEMINI.md` | user |
| copilot | — | `AGENTS.md` **in the working directory** | user |
| kimi | — | `AGENTS.md` **in the working directory** — and, measured 2026-09-26, `$KIMI_CODE_HOME/AGENTS.md`, which the registry does not write yet | user |

Two consequences:

1. **The file is the only universal channel.** Two of six accept a flag; all
   six read a file. So Mind writes files and uses flags as an optimisation.
2. **The channels are not equally strong.** A flag lands the identity as a
   system prompt. A file lands it as user-level instructions, which a model may
   weigh less. Mind does not promise equal results across backends — it
   measures how far the identity got.

Note that `grok` reads another vendor's file by design and documents it as
compatibility. That means an identity written for `claude` already reaches
`grok` with no setup — and is exactly why it should not be relied on: it is a
courtesy, switchable with one environment variable, not a contract.

`copilot` has **no home-scoped file at all**. An identity reaches it per
project or not at all. That is a vendor limitation Mind reports; it cannot fix
it. `kimi` was listed here too until 2026-09-26, when a probe showed 2.0.2 also
reading `$KIMI_CODE_HOME/AGENTS.md` (default `~/.kimi-code/AGENTS.md`); the
registry still names only the project file, because writing the home one would
put a soul into every kimi session on the machine (D-120, open).

## Built-in tool names

Copying an allowlist from one vendor to another does not work. These are the
names each CLI actually accepts.

| CLI | names |
|---|---|
| claude | `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `Task`, `WebFetch`, `WebSearch` |
| grok (1.0.40) | `read_file`, `search_replace`, `grep`, `list_dir`, `run_terminal_command`, `web_search`, `web_fetch`, `todo_write`, `spawn_subagent`, `memory_search` |
| codex | `apply_patch`, and the shell as `exec_command` on 0.155.1 with `features.unified_exec` on (the default); earlier readings saw `unified_exec` or `shell` |
| gemini | `read_file`, `write_file`, `replace`, `run_shell_command`, `list_directory`, `glob`, `search_file_content`, `web_fetch`, `google_web_search`, `save_memory`, `read_many_files` |
| copilot | kinds, not tools: `shell(cmd:*)`, `write`, `<mcp-server>(tool)` |
| kimi | `Read`, `Glob`, `Grep`, `FetchURL`, `Bash`, … — named in an agent profile's front matter (`--agent-file`), not on the argv |

**grok renamed two of these between 1.0.24 and 1.0.40** — `run_terminal_cmd` →
`run_terminal_command`, `task` → `spawn_subagent` — and accepts an unknown name
in `--tools` / `--disallowed-tools` without a word. See the read-only section
below for what that cost.

## Traps — each one costs a debugging session

These all fail by **exiting 0**. None of them prints an error.

1. **grok, `--permission-mode plan` in headless.** Plans the work, waits for
   an approval nobody will give, exits 0 having changed nothing.
2. **grok, a tool call nobody approves.** In headless it is *cancelled*, not
   refused, and the cancel ends the whole turn with exit 0 — `text` empty or
   holding the one sentence the model said first. Looks like a short answer; is
   a half-run. Once blamed on a missing `--max-turns`; measured 2026-09-26, the
   cap is innocent (with none, a fix-and-test task finished 3/3) and the cause
   is approval. `--allow Bash` does not cover `rm` or anything using `$?`; only
   `--always-approve` does (D-119).
3. **grok, tool ids are not display names — and they move.** `run_terminal_cmd`
   not `bash` at 1.0.24; `run_terminal_command` at 1.0.40. The vendor's own
   documentation ships several spellings in different tables. A filter written
   against the wrong one silently matches nothing, and an unknown name in
   `--tools` is accepted with exit 0 rather than rejected. This is not a
   hypothetical: Mind's deny list named two tools that no longer existed, and
   a probe wrote a file straight through it.
4. **grok, large prompts truncate in the middle.** Head and tail arrive, the
   centre does not. Detect it by asking two questions at once — one about the
   very end of the prompt, one about the whole — and comparing.
5. **codex, tool names follow a feature flag.** On 0.155.1 with
   `features.unified_exec` on (the default) every shell call is `exec_command`;
   earlier readings saw `unified_exec` or `shell`. Same binary, different name.
6. **copilot, `--no-custom-instructions`** disables the only identity channel
   there is.
7. **gemini's instruction file is shared.** The CLI writes its own auto-saved
   memories into the same file an identity would occupy.
8. **kimi, `--plan` cannot be combined with `-p`.** The one flag that sounds
   like it would make a headless turn read-only exits 1 before the turn starts:
   `Cannot combine --prompt with --plan`. A wrapper that adds it to look safe
   gets no turn at all. `--agent <name>` and `--agent-file <path>` *can* be
   combined with it — the 2026-09-21 survey missed them — and the second is
   what Mind uses (D-120).
9. **Session-start hooks inject context no file check can see.** Several of
   these CLIs let a user's settings run a command at session start and prepend
   its output to the context. A second identity can therefore be in front of
   the model before Mind's prompt arrives, with nothing on disk to show for
   it. The consequence for `soul verify`: an identity probe must ask for a
   *distinctive fact of the soul under test* ("what do your instructions call
   the user?"), never a floating "who are you?" — the second is unattributable
   on any machine configured this way, and it is the question everyone reaches
   for first.

The general lesson, and Mind's premise: **an AI CLI usually fails silently.**
A task reported as finished may have produced an empty file. That is why a turn
result here distinguishes `silent` from `failed`, and why `soul verify` asks
the model questions instead of checking that a file exists.

## Read-only: what stops a turn from writing

**Measured 2026-09-21**, one real turn per CLI in a fresh temporary directory,
each told: *create a file named `probe.txt` here containing the word `written`;
do it now*. The directory was listed afterwards. `src/exec/registry.ts` encodes
the same rows as `VendorSpec.readOnly`, and `mind backends` prints the
`writes?` column from it.

None of these CLIs is read-only by default. Every turn Mind starts is an
agent with a shell and a file-writing tool, and the only thing between it and
the working directory is the flag in this table.

| CLI | version | mechanism Mind passes | probe wrote | evidence |
|---|---|---|---|---|
| claude | `2.1.278` | `--tools ""` — the empty allow list | nothing | measured |
| codex | `0.155.1` | `--sandbox read-only` | nothing (*"the workspace is read-only"*) | measured |
| grok | `1.0.40` | `--tools read_file,grep,list_dir` — allow list | nothing (*"I don't have a write tool"*) | measured |
| copilot | `0.0.367` | `--deny-tool shell --deny-tool write` | nothing | measured |
| gemini | `0.38.2` | `--approval-mode plan` | **not measurable here** — the CLI refused to authenticate (`IneligibleTierError`, a tier being retired) | vendor's own `--help` only |
| kimi | `2.0.2` | `--agent-file ~/.local/state/mind/vendors/kimi/readonly-agent.md` — a profile Mind writes, tools `Read`, `Glob`, `Grep` | nothing (7/7 in the probe, 2026-09-26, and 3/3 through `CliExec`, one after the file was tampered with — on a local model in an isolated home; `MIND_REAL_READONLY=1` not yet re-run) | measured — before 2026-09-26: **none**, and the plain turn wrote `probe.txt` |

**Read-only is not cannot-read.** The column above says what a turn may *change*. Every row except claude keeps a
read tool or a shell that runs read commands, as you: grok `read_file,grep,list_dir`, kimi `Read`, `Glob`, `Grep`,
codex commands under `--sandbox read-only`, gemini `plan`, copilot everything but `shell` and `write`. They can open any
file your user can open and send it to the vendor, and the egress screen sees only the prompt Mind sends (EEA-01,
EXEC-04). `mind backends` says so on every run, derived from the registry; [what a turn can read and
write](fence.md) has the rest, and the local CLIs' read fence.

Four findings, each of which looked like a detail first:

1. **grok's deny list had stopped matching.** It named `run_terminal_cmd` and
   `task`; 1.0.40 calls them `run_terminal_command` and `spawn_subagent`. The
   flag was still in the argv and the test still passed. The probe wrote a
   file. **A deny list fails open** — a renamed tool comes back — so the
   registry holds an *allow* list here: a drifted name there costs the turn a
   tool rather than returning one.
2. **kimi had nothing to pass — until 2026-09-26.** No tool filter, no
   sandbox; `-y/--yolo` and `--auto` only loosen, and `--plan` is refused
   together with `-p`. The plain headless turn wrote the file, and the registry
   declared `readOnly.kind: "none"`. The survey had missed `--agent-file`: a
   profile whose front matter names the only tools a turn gets. Mind now
   writes one before every restrained turn (D-120). A plain `-p` turn is still
   the 25-tool agent with a shell, and **any fallback chain elsewhere that lands
   on this CLI without the profile still inherits that**.
3. **grok's `--sandbox` is not an argv mechanism.** It names a profile defined
   in a config file, and refuses to start when it cannot build its bubblewrap
   plan. Out of scope here, which is why the tool list does the work.
4. **copilot needs `--allow-all-tools` to run headless at all.** The denials
   outrank it — the probe confirmed that — but the flag is declared in the
   registry as a loosening one rather than left sitting in an argv.

## S12.6: what the 2026-09-26 probes changed

Measured on a local model through LiteLLM in isolated homes, every `connect()` counted.

| CLI | before | after | what decided it |
|---|---|---|---|
| grok | `--max-turns 2`, **no grant** at levels 2–3 | `--max-turns 20`; `--always-approve` at 2–3; `--disallowed-tools search_tool,use_tool,…` and the Claude/Cursor compat switches (`GROK_CLAUDE_HOOKS_ENABLED=0`, …) at every level; usage read from `/usage/*`; a turn not ending `end_turn` is `silent` | no grant: the first shell call cancelled, exit 0 (0/2). `--allow` rules: silent cancels on `rm`, `$?` and 3/11 multi-step runs. `--always-approve`: fix-and-test 14/14 (+1/1 as `bypassPermissions`), `$?` 7/7, `rm` 3/3. A level-1 turn tried to reach a shell through `use_tool` (1/3 — stopped only because nobody approved it, which ended the turn silently) until the meta-tools were removed (4/4 clean). On the owner's home `grok inspect` listed 5 Claude hooks and 7 MCP servers active until the compat switches were set; hooks inside Claude *plugins* have no switch and stay. |
| kimi | `none` — refused at level 1 | `--agent-file` with Read, Glob, Grep | the built-in `plan` fetched a web page and was replaceable by a repository's `plan.md` that wrote a file; the Mind profile: 0 writes 7/7, 0 requests 4/4, still answers 2/2. |
| codex | nothing at any level | `--disable plugins --disable shell_snapshot --disable apps --disable remote_plugin -c shell_environment_policy.ignore_default_excludes=false` at every level | default: github.com and chatgpt.com contacted before the turn (2/2, in a home with no ChatGPT sign-in); a `*KEY*` canary reached the model's shell with the snapshot on **and** with it off under the default policy. With the plugin and snapshot switches: 0 non-loopback connects in that home, canary hidden (4/4). `apps` and `remote_plugin` act only under a sign-in and were not measured. On a cloud config the turn itself still reaches the model's endpoint. |

Also found, and written into the registry's traps rather than fixed here: a codex turn at
workspace-write or danger-full-access appends a `trusted` project entry to `$CODEX_HOME/config.toml`;
only environment names holding KEY, SECRET or TOKEN are filtered from codex's shell; kimi also reads
`$KIMI_CODE_HOME/AGENTS.md` (the registry still lists only `./AGENTS.md`).

What no flag in this table reaches: MCP servers and session-start hooks
configured in the operator's own vendor settings. They add tools and context to
a turn before Mind's argv is read (trap 9 above). `readonlyLimits()` says so
on every run; nothing here closes it.

### How to re-measure

```sh
MIND_REAL_READONLY=1 bun test test/exec/readonly.real.test.ts
```

Opt-in because it spends one real turn per reachable CLI. It fails when a
vendor and the registry disagree **in either direction** — a declared
mechanism that let a file through, or a vendor declared unguarded that
suddenly refuses. The second is a failure on purpose: a hole that has quietly
closed is still a line frightening somebody in `mind backends`.

## Usage: what each CLI says a turn cost

**Measured 2026-09-21**, one real turn each, on this machine. `src/exec/registry.ts`
encodes the same rows as `VendorSpec.usage`. Re-measure when a vendor bumps — a
field that moves turns every line Mind writes into `missing`, silently.

| CLI | version measured | stream | fields | Mind reads |
|---|---|---|---|---|
| claude | `2.1.278` | stdout (the reply JSON) | `usage.input_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.output_tokens` — plus `cache_creation`, `inference_geo`, `iterations`, `output_tokens_details`, `server_tool_use`, `service_tier`, `speed` | the three input fields **summed**, and `output_tokens`; since S15.9 also the two cache fields apart, as `cache_read` and `cache_write`; since D-143 (measured on `2.1.283`) also `usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`, as `cache_write_5m` and `cache_write_1h` — kept only when they add up to `cache_write` |
| codex | `0.153.4` | **stderr** (stdout holds the answer) | a line reading `tokens used`, the figure on the line after it, thousands separated (`2,243`) | that figure, as `total`; input, output, both cache counts and the split of a write are null and listed in `not_printed` |
| ollama | `0.32.13` | HTTP response body | `prompt_eval_count`, `eval_count`, plus `total_duration`, `prompt_eval_duration`, `eval_duration`, `load_duration` | both counts; no cache field exists, so both cache counts and the split of a write are null and listed in `not_printed` |
| grok | `1.0.40` | stdout (`--output-format json`) | `usage.input_tokens` (uncached, per the vendor's docs), `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, `usage.output_tokens`, `usage.reasoning_tokens`, `usage.total_tokens` | the three input fields **summed**, `output_tokens`, `total_tokens`, and since S15.9 the two cache fields apart — present on 76 of 76 local-model runs, cache fields always 0 there (S12.6). `reasoning_tokens` is not read: `total_tokens` equalled input + output on every run. No split of a write: `cache_write_5m`/`cache_write_1h` are null and listed in `not_printed` |
| claude-local · grok-local | as claude · grok | as claude · grok | the same JSON, served through LiteLLM from the local model | as claude · grok (S12.1 runs the real CLIs) |
| gemini · copilot · kimi | — | — | **not surveyed** — Mind runs them with text output, which carries no counts | nothing — reported as `unreported`, every count null |

Three things the measurement settled, each of which looks like a detail and is not:

1. **claude's `input_tokens` alone is not the input.** A turn that sent roughly
   81,000 tokens reported `input_tokens: 2`, with 80,951 under
   `cache_creation_input_tokens` and 0 under cache read. Reading the first field
   is off by four orders of magnitude and looks like an unusually cheap turn.
   Mind sums all three, and reports `input: null` if any one of them is absent
   — a partial sum is the same bug wearing a different number.
2. **codex prints its count on the stream it does not answer on.** Any wrapper
   that keeps stderr only when stdout came back empty — which is the obvious way
   to keep a failure's reason — throws the count away on exactly the turns that
   used tokens.
3. **No vendor's money is read.** The same claude response carried
   `total_cost_usd: 0.80962` for a two-character answer, nearly all of it the
   list price of a cache write a subscription holder is never billed for. ollama
   has no cost or `usd` field at all, which is the evidence that writing `0`
   there would be Mind adding something the daemon never said. Both are
   dropped, and neither is kept under another name. What a turn costs is
   Mind's own arithmetic over the counts above and a dated price table
   (`mind usage prices`, S15.9, D-139); a turn with a count missing is not
   charged at all (D-110).
4. **Which cache a claude write went to changes its price** (D-143). Anthropic
   prices a 5-minute write at 1.25× input and a 1-hour write at 2×, and claude
   says which in `usage.cache_creation`. A turn measured on 2.1.283 wrote all
   11,856 of its cache tokens to the 1-hour cache; priced as 5-minute it was
   8,892 µ$ short. `modelUsage` carries no split, only `cacheCreationInputTokens`.

### How to re-measure

```sh
claude -p "Reply with exactly ok" --output-format json --tools "" | jq '{usage, has_cost: has("total_cost_usd")}'
# D-143: the split of a cache write, and that it adds up to the write
claude -p "Reply with exactly ok" --output-format json --tools "" | jq '.usage | {cache_creation_input_tokens, cache_creation}'
codex exec --skip-git-repo-check --sandbox read-only "Reply with exactly ok" 2>&1 >/dev/null | tail -5
curl -s localhost:11434/api/chat -d '{"model":"<small model>","stream":false,"messages":[{"role":"user","content":"ok"}]}' | jq 'del(.message)'
```

Or, against the code rather than by eye:

```sh
MIND_REAL_USAGE=1 MIND_REAL_MODEL=<model> bun test test/exec/usage.real.test.ts
```

That test is opt-in because each case spends a real turn. A `missing` from it
means the vendor moved and this table is out of date.

## Model: how each CLI takes one, and which one it says it ran (D-142)

**Read 2026-09-28** off each CLI's `--help`, and measured with one real turn where the
output names a model. `src/exec/registry.ts` encodes the same rows as `VendorSpec.model`,
and every `headlessArgv` builds the flag from it.

| CLI | version | flag (`--help`) | names it documents | output names the model it ran |
|---|---|---|---|---|
| claude | `2.1.283` | `--model <model>` — an alias (`fable`, `opus`, `sonnet`) or a full name | the three aliases, and `haiku` (resolved by the measured turn) | **yes** — `modelUsage`, one key per model called: the dated API id (`claude-haiku-4-5-20251001`), with `canonicalModel` (`claude-haiku-4-5`) inside |
| grok | `1.0.40` | `-m, --model <MODEL>` — "Model ID to use" | none (`grok models` asks the account) | **yes** — `modelUsage`, keyed by the id the CLI sent (`local-coder` on a `grok-local` turn); no canonical field. Not yet seen against xAI |
| codex | `0.155.1` | `-m, --model <MODEL>` (`codex exec --help`) | none | no — text output |
| gemini | `0.38.2` | `-m, --model` | none | no — run with text output |
| copilot | `0.0.367` | `--model <model>`, a fixed list of choices | the twelve choices it prints | no — `-s` output |
| kimi | `2.0.2` | `-m, --model <model>` — an alias from the owner's `config.toml` | none (the aliases are the owner's) | no — text output |
| claude-local · grok-local | as claude · grok | — | — | Mind runs them on `local-coder` only; they take no model |

What Mind does with it:

1. **A model is one backend's.** `turn --backend claude --model opus` hands claude
   `--model opus`, as one argument after the flag. In a chain of several, a bare `--model`
   is the ollama step's (as it always was) and `--model claude=opus,ollama=qwen3:8b` gives
   each named step its own; no model reaches a step it was not chosen for.
2. **A name is checked before it goes on argv**: 1–128 characters, starting with a letter
   or digit, then letters, digits and `._:@+/[]-` only. A backend that takes no model is
   refused one; nothing runs on its default instead.
3. **The ledger's `model` is what the output named**, the canonical name where there is
   one; `model_requested` is what was asked for. Two names in the output are no single
   model. A turn is priced by the model it ran, or by the requested name only when the
   output named none and a price table lists exactly that name for that backend — so an
   alias is never priced.

### How to re-measure

```sh
claude -p "Reply with the single word: ok" --output-format json --tools "" \
  --setting-sources project,local --strict-mcp-config --no-session-persistence \
  --model haiku | jq '{modelUsage: (.modelUsage | map_values({canonicalModel}))}'
for cli in claude grok gemini copilot kimi; do $cli --help | grep -i -A2 -- '--model'; done
codex exec --help | grep -i -A1 -- '--model'
```

## Hooks: what a capture actually receives

**Measured 2026-09-21** against `claude 2.1.278` (see the drift note at the top: 2.1.280 dropped
`source`), by reading the hook input
schema out of the installed binary
(`~/.local/share/claude/versions/2.1.278`) rather than recalling it.
`src/observer/adapters/claude-hook.ts` encodes the same rows.
Re-measure when the vendor bumps — a field that moves turns every record Mind
writes into a skip, silently.

Only **claude** has a hook mechanism. `grok --help` offers none, so grok can be
seeded from its session files and never captured live; codex, gemini, copilot
and kimi are out of E3's scope entirely (S3.1 AC6).

### Every payload

| field | present |
|---|---|
| `session_id`, `transcript_path`, `cwd` | always |
| `prompt_id` | after the first user input of the process lifetime |
| `permission_mode` | optional |
| `agent_id` | **only inside a subagent** — the field to test for that, not `agent_type` |
| `agent_type` | inside a subagent, or on the main thread of an `--agent` session |
| `effort` | tool-use-context hooks, on models with an effort parameter |

**There is no timestamp on any of them.** The time of an action is the clock at
the moment the hook fires, which is why `claudeHook()` takes `at` as an
argument.

### The three events Mind asks for

| event | extra fields |
|---|---|
| `UserPromptSubmit` | `prompt`, `source?`, `session_title?` |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms?`, `mcp_server?` |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `error`, `is_interrupt?`, `duration_ms?` |

Three readings that changed the design, each of which would have been a silent
wrong answer if assumed:

1. **A failing tool does not fire `PostToolUse` at all.** It fires
   `PostToolUseFailure`, and a denied permission fires `PermissionDenied`. A
   capture that asked only for `PostToolUse` would have written a world in
   which nothing the owner does ever fails — `outcome` a column of `ok` that
   really meant "this reader cannot see failures".
2. **`UserPromptSubmit.source` says who authored the turn**, as one of `user`,
   `sdk`, `system`, `loop_wakeup`, `schedule_wakeup`, `poll_event`. `user` is
   the interactive composer and `sdk` is `claude -p` and the Agent SDK — which
   is what every fleet launcher uses. This is the field `S3.2 AC3` needs and no
   transcript contains. The vendor's own schema adds that payloads may omit it
   while it rolls out, so an absent `source` is `origin: unknown` and is never
   folded into `owner-prompted`.
3. **Exit codes are a lever on the owner's session, not a status report.** On
   `UserPromptSubmit`, exit 0 means *stdout is shown to Claude* — injected into
   the context of the turn that is starting — and exit 2 blocks the prompt and
   erases it. On `PostToolUse`, exit 2 shows stderr to the model. So
   `mind observe capture` prints nothing on stdout and exits 0 on every path,
   including its own failures, and `test/cli/observe.test.ts` asserts both
   against the real binary.

`PreToolUse` is deliberately not asked for: it runs before every tool call and
adds latency to all of them, and it cannot know the outcome.

### How to re-measure

Without spending a turn, straight off the binary:

```sh
python3 - "$(readlink -f "$(command -v claude)")" <<'PY'
import re, sys
data = open(sys.argv[1], "rb").read()
for m in re.finditer(rb"hook_event_name\s*:\s*R\(\"(UserPromptSubmit|PostToolUse|PostToolUseFailure)\"\)[^\x00]{0,400}", data):
    print(m.group(0).decode("utf-8", "replace"), "\n")
PY
```

Or with a turn, in a throwaway `HOME`, which also proves the wiring:

```sh
H=$(mktemp -d); OUT=$H/events.jsonl
HOME=$H claude -p "run: echo hi" --settings "$(mind observe hook --print --subject example \
  | sed "s|mind observe capture[^\"]*|cat >> $OUT|")"
jq -r '.hook_event_name, (keys|join(" "))' "$OUT"
```

## Auth and config locations

Useful for a health check; none of it is uniform.

| CLI | config | credentials |
|---|---|---|
| claude | `~/.claude/settings.json`, `~/.claude.json` | separate file; records an expiry |
| grok | `~/.grok/config.toml` | separate file; no expiry recorded |
| codex | `~/.codex/config.toml` | separate file; records last refresh |
| gemini | `~/.gemini/settings.json` | separate file; records an expiry |
| copilot | `~/.copilot/config.json` | **mixed into the config file** |
| kimi | `~/.kimi-code/config.toml` | credentials dir, **plus keys inside the config file** |

A cross-CLI health check cannot assume "config" and "secret" are different
files. For two of six they are the same file.

Home-directory overrides, where a vendor offers one: `CODEX_HOME`, `GROK_HOME`.
