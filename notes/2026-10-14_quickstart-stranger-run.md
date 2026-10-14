# Quickstart, followed as a stranger (GL-04b), 2026-10-14

Who and what: an **automated reviewer** (Claude, not a human) followed `docs/quickstart.md` and the README install
section literally, on Linux x86-64, with a **local model** and no cloud model. The binary was the **published release
`v0.11.0-alpha`**, installed with its own `install.sh` (cosign 3.1.3 verified the signature). Nobody who is a person has done
this run; this note is evidence for GL-04b, not the human proof the item may still want.

## How the machine was made to look clean

- Everything ran under `env -i` with only `HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME` under a scratch
  directory, `TERM`, `LANG`, and a `PATH` of the scratch `bin` (mind, a symlink to the owner's cosign) plus a scratch
  copy of `/usr/bin` as symlinks **without** claude, codex, gemini, grok, kimi, copilot, node, bun, ollama and tailscale. The
  doctor confirmed `0 of 7 reachable` CLIs.
- Interactive steps (`mind setup`, `mind basis record`) ran in a real pseudo-terminal (tmux), typed by the reviewer.
- Model server: the machine's Ollama API on `127.0.0.1:11434`; model `gemma3:4b` (not `llama3.2:3b`, which is not pulled
  and was not run). `MIND_OLLAMA_MODEL=gemma3:4b` was exported as step 3 says. The `ollama` binary is not installed on this machine, so
  `ollama pull` / `ollama list` could not be run. That port is the owner's translating shim, not stock Ollama (see the
  "not run" rows).
- One deliberate deviation: `MIND_QDRANT_URL=http://127.0.0.1:1` was set for the whole run, so that `memory index` and
  `erase` could not touch the owner's real Qdrant at `:10300`. A stranger without Qdrant gets the same "Unable to connect"
  from the default address. `mind doctor` ignores that variable and did read the owner's store at `:10300` (a read-only listing of
  collection names; nothing was written).
- Web console: port 30781 only, loopback, stopped with Ctrl-C afterwards (checked: nothing listens). No other port was opened.
- Not touched: the real home, `~/.secrets`, `~/.ssh`, any real config. (One read-only `crontab -l` was run by mistake while
  looking for installed timers; its output was not used.)

## Step by step

Verdicts: **pass**, **doc fix** (the page was wrong or incomplete; fixed in this commit), **bug** (engine; not fixed,
see "Bugs"), **not run**. Time is wall clock of the command, on a warm model, not typing or reading time.

| # | Step | Command (as the page says, scratch paths elided) | Page expects | Actual | Time | Verdict |
|---|---|---|---|---|---|---|
| 1 | 1. What you need | `git config --global user.name/user.email` | git knows who you are; needs git, curl, sh, sha256sum | worked; but step 2 also needs **cosign**, which step 1 does not list | 0.1 s | doc fix |
| 2 | 2. Install | `curl -fsSLO https://github.com/bemindlabs/mind/releases/download/v0.11.0/install.sh` | the script | `curl: (22) ... 404`: the release is tagged `v0.11.0-alpha`, there is no `v0.11.0` | 0.5 s | doc fix |
| 3 | 2. Install | same, with `v0.11.0-alpha` | the script | downloaded | 0.8 s | pass |
| 4 | README dry run | `sh install.sh --dry-run` | `mind v0.11.0 for linux/x64`, URL `.../v0.11.0` | `mind v0.11.0-alpha for linux/x64`, URL `.../v0.11.0-alpha`, then the group-writable note | 0.2 s | doc fix |
| 5 | 2. Install | `MIND_VERSION=v0.11.0-alpha MIND_INSTALL_DIR=<scratch>/bin sh install.sh` | `checksum ok`, `signature ok (cosign, the release workflow)`, `installed ...` | exactly that | 7.6 s | pass |
| 6 | 2. Install | `mind --version` | `0.11.0` | `0.11.0` (the binary has no `-alpha` suffix; `mind update --check` says `latest published: v0.11.0-alpha`) | 0.05 s | pass (noted in doc) |
| 7 | README | `install.sh` with no `MIND_VERSION`; `--uninstall`; no cosign on PATH | picks newest incl. pre-release; removes only the binary; refuses without cosign | picked `v0.11.0-alpha`; `removed ...` and "Your data was not touched"; `a verified signature is required for v0.11.0-alpha ... cosign is not installed. Not installed.` | 8 s | pass (README sample said `for v0.11.0`: doc fix) |
| 8 | 3. Local model | `ollama pull llama3.2:3b`, `ollama list` | model pulled | `ollama: not found` (binary not installed; model served over HTTP) | - | not run |
| 9 | 3. Local model | `export MIND_OLLAMA_MODEL=gemma3:4b` | used when no model is named | used by the web chat and by `setup`'s egress judge line | - | pass |
| 10 | 4. Check | `mind doctor --no-version` | `ok daemon http://127.0.0.1:11434 · N model(s) pulled`, many `warn`, `engine ... not checked` | all as described (9 models), `ready`, exit 0 | 0.13 s | pass |
| 11 | 4. Check | `mind doctor` (with versions) | same | same, exit 0 | 0.14 s | pass |
| 12 | 4/Troubleshooting | `OLLAMA_HOST=http://127.0.0.1:1 mind doctor --no-version` | `FAIL daemon ... did not answer /api/tags`, exit 1 | exactly that, `not ready`, exit 1 | 0.1 s | pass |
| 13 | 5. Setup | `mind setup` | machine table (`ollama OK`, vendors `--`), seven questions | table as shown, seven questions with the stated defaults | - | pass |
| 14 | 5. Setup | the seven answers from the table | repository created, soul written and checked, Level 1 | created `.gitignore, soul/*, memory/README.md, consent/README.md, 2 hooks`, `3 prohibition(s) · 3 principle(s)`, level 1 | 0.2 s | pass |
| 15 | 5. Setup | first turn: "take the defaults, `ollama` and your model" | the model you pulled | offered `qwen3.8-ctx128:27b`, the **first** model Ollama lists, not `MIND_OLLAMA_MODEL` (a 27B on a machine with 4 GB of GPU free) | - | bug B3 + doc fix |
| 16 | 5. Setup | first turn with `gemma3:4b` | answer, `route:` line, `answered by ollama · identity arrived as system · <n>s` | exactly that, 1.4 s; then `Done.`, the commit line, an `egress judge: on by itself` line, a list of next commands | 1.4 s | pass |
| 17 | 5. Setup | after `Done.` | prompt returns | the prompt did **not** return; `mind` kept running and swallowed the next typed line until Ctrl-D | >60 s (until Ctrl-D) | bug B2 + doc fix |
| 18 | 5. Setup | `mind setup --no-turn` (second agent) | agent made, no turn | agent made; same hang until Ctrl-D | - | bug B2 |
| 19 | 5. Setup | `echo hi \| mind setup` | `setup ran out of input` | `mind: setup ran out of input at "In one line, what is it for?". Nothing more was done.` exit 1 | 0.1 s | pass |
| 20 | 5. Commit | `cd ~/agents/keeper && git add soul && git commit -m ...` | commit, with the guard notice | `2 staged file(s) passed 18 rules ...`, commit made | 0.1 s | pass |
| 21 | 6. Talk again | `mind --as ~/agents/keeper turn --backend ollama --model gemma3:4b --prompt "..."` | answer, `identity arrived as system` | "I am not a person; I am an AI agent." ... `answered by ollama ... 3.9s` | 4.0 s | pass |
| 22 | 6. Ledger | `mind ledger show --subject me` | one row | two rows (setup's turn and this one); columns as shown | 0.1 s | doc fix |
| 23 | 7a. Soul | write the doc's `role.md`, `mind soul check` | `keeper — keeps my notes ...`, `4 prohibition(s) · 3 principle(s)` | exactly that, exit 0 | 0.1 s | pass |
| 24 | 7b. Notes | the two `printf` lines | two files | made | - | pass |
| 25 | 7c. Basis | `mind basis record owner --subject me --uses memory`, type the phrase | `recorded <id>: owner for memory` | `recorded 446facd5: owner for memory` | - | pass |
| 26 | 7c. Basis | ingest with no basis (other subject) | `mind: no basis to take ... Nothing was read (S7.3).` | the message, exit 1; no terminal: `a basis is recorded at a terminal ...`, exit 1 | 0.1 s | pass |
| 27 | 7d. Ingest | `mind memory ingest ~/agents/keeper --from ~/notes --subject me --yes` | `2 new`, two `+` lines, `wrote 2 file(s)` | exactly that | 0.07 s | pass |
| 28 | 7d. Index | `mind memory index ...` | `2 file(s) · 2 piece(s)`, `full-text 2 piece(s)`, `vectors not built — Unable to connect` | exactly that | 0.12 s | pass |
| 29 | 7e. Ask | `mind turn ~/agents/keeper --subject me --backend ollama --model gemma3:4b --prompt "When is the VAT return due?"` | three `recall` lines, answer says the 15th | `vector half skipped`, `1 piece(s), 101/4500 char(s)`, `vat.md — Tax (... fts)`, "Dana, the VAT return ... due on the 15th" | 1.4 s | pass |
| 30 | 7e. Search | `mind memory search ~/agents/keeper --subject me "VAT"` | the hit, no model | `vat.md — Tax`, `fts 0.0164` | 0.1 s | pass |
| 31 | 8a. Trigger | write `soul/triggers.md`, commit | file accepted | accepted (my first copy had the code fence in it; that was my slip, not the page) | - | pass |
| 32 | 8b. Show | `mind triggers show $S --subject me` | `tidy-inbox every 1d last never · next due now` | that line, plus a one-sentence trailer | 0.1 s | pass |
| 33 | 8b. Tick | `mind triggers tick $S --subject me --backend ollama --model gemma3:4b` | `trigger tidy-inbox ... held at level 1`, a `mind-proposal`, `proposal <id> filed`, `nothing was done` | all of it (the model filed a proposal) | 3.9 s | pass |
| 34 | 8b. Tick again | `show`, then `tick` | `last <time> · next <a day later>`; `nothing is due` | exactly that | 0.1 s | pass |
| 35 | 8c. Decide | `proposal list`, `proposal show <id>`, `proposal decide <id> ... --approve` | list, details, `approved by ... Good for one turn, and for this action only` | exactly that | 0.1 s each | pass |
| 36 | 8d. Schedule | `mind triggers schedule $S --subject me` | systemd unit, timer, cron line, installs nothing | that; `Nothing was installed. Mind runs no daemon` | 0.1 s | pass |
| 37 | Next: web | `mind web ~/agents/keeper --subject me` | link with a one-time key, this computer only | prints `http://127.0.0.1:<port>/#t=<key>`; the **default port is 30701** (the page never says so; on this machine that is the owner's own service, so `--port 30781` was used) | - | doc fix |
| 38 | Web, over curl | `GET /` with and without the `x-mind-token` header; wrong key; wrong `Host` | page 200; API 401 without a key; 421 for a foreign host | `/` 200 (232 KB, `<title>Mind</title>`); `/api/agent` 401 without the key, `ok` with it; wrong key 401; foreign Host 421 | 0.01 s | pass |
| 39 | Web chat | `POST /api/turn {"prompt":"When is the VAT return due?"}` with the key | an answer from the agent with its recall | answered by ollama in 2.7 s, recall attached `vat.md`, one proposal filed. `notes` also says "so the turn goes to cloud" for an answer that was local | 2.7 s | pass (wording: bug B6) |
| 40 | Web, proposals and dial | refuse a proposal; set `write` to 2 then back to 1 | refused; dial changes; state shows it | CLI list confirms `refused` with the note; dial set and restored | 0.2 s | pass |
| 41 | Web, schedule | `GET /api/state` after step 31 | the trigger listed | `"triggers": []` although `mind triggers show` lists `tidy-inbox` | 0.05 s | bug B4 + doc fix |
| 42 | Staying current | `mind update --check` | says if a newer release exists | `mind 0.11.0 is the newest release (latest published: v0.11.0-alpha).` exit 0 | 0.5 s | pass |
| 43 | Thai half | `MIND_LANG=th` on `doctor`, `setup`, `backends`, `turn --help`, `soul check`, `ledger show`, `proposal list`, `memory search`, `autonomy show` | README: "Print the Thai half too" | Thai only in `autonomy show` (6 lines) | - | doc fix |
| 44 | Erase, with an index | `mind erase me --agent ~/agents/keeper --by me` (dry run) and with `--yes` | dry run lists what goes; `--yes` removes it | both **exit 1**: `Mind wrote vectors for this subject to ... and cannot reach it now ... Nothing was deleted and no certificate was issued.` The dry run does not show a plan to act on; there is no flag to get past it | 0.1 s | bug B1 + doc fix |
| 45 | Erase, marker removed by hand (to see the rest) | same, `--yes` | removes what it says | `erased-and-verified`: 9 files, 9 directories, 5 ledger lines gone, 0 hits. Left behind: `memory/imported/notes/*.md` (the copied notes), `autonomy.md`, `consent/README.md`, `memory/README.md`, `.gitignore` | 0.1 s | bug B5 + doc fix |
| 46 | Erase, nothing indexed | `mind erase other --agent ~/agents/second --by me --yes` | removes the subject | removed 2 files and 1 directory, state gone; verdict `erased-with-remainder`, exit 1, because the scaffold `consent/README.md` names the agent | 0.1 s | doc fix |
| 47 | Troubleshooting | `OLLAMA_HOST=http://127.0.0.1:1 mind turn ...` | `no backend answered ... ollama: unavailable (...unreachable ...)` | exactly that | 0.1 s | pass |
| 48 | Troubleshooting | a turn with no model named and none in the environment | `no backend answered · 0.0s · all 1 backend(s) missed · ollama: silent` | exactly that | 0.1 s | pass |
| 49 | Troubleshooting | a turn naming a model that does not exist | `HTTP 404 ... model "x" not found` in `--json` `evidence.raw` | **not reproducible here**: the local port is a shim that maps unknown names to another model and answered | - | not run |
| 50 | By hand (README) | `mind new third --subject third --dir ...`, `mind soul check`, `mind soul apply` | agent made; apply is a dry run, writes nothing | as described; `Nothing was written. Re-run with --apply`; no `~/.claude` or `~/.codex` was created | 0.3 s | pass |

Counts: 50 rows: **35 pass** (three of them with a note), **7 doc fix** only (rows 1, 2, 4, 22, 37, 43, 46), **6 bug**
(rows 15, 17, 18, 41, 44, 45; every one also needed a page change, B6 and B7 are minor and sit on passing rows) and **2 not
run** (8, 49). Literal instructions that did not give the promised result: row 2 (404), 15 (wrong model offered), 17
(`setup` does not return), 41 (the web schedule), 44 and 45 (`erase`), six in all. Everything else behaved as the page says.

## Can a stranger finish in the time the page claims?

Not yet, for two reasons that are not about time.

1. **Step 2 fails as written** (404 on the `v0.11.0` URL). A stranger stops there until they guess the real tag. Fixed in the
   page now.
2. **The last promise of the page, taking everything back out, cannot be kept** on a machine with no Qdrant, which is exactly
   the machine the page is written for: `mind erase` refuses (B1). The page now says so.

On time: all the Mind commands together took about 25 seconds of wall clock on a warm 4B model (install 8 s, the
three model turns 1.4 to 3.9 s, the rest under half a second). Typing the seven answers, writing the soul and trigger files,
and reading the output are what is left of "about half an hour"; the reviewer cannot measure those for a person, so the
claim stays an estimate and the page now says so. A cold model load and the model download (the page says "plus the model
download") were not measured: the model was already loaded.

## Bugs found (engine; not fixed here)

**B1. `mind erase` cannot run after `memory index` with no vector store (blocking for the quickstart).**
`memory index` writes a marker `state/mind/rag/<subject>/collection.json` *before* it tries the vector half, so a failed
connection ("vectors not built — Unable to connect") still leaves it; `erase` then refuses to certify because it cannot ask
the store (`src/memory/marker.ts`, `src/erase/plan.ts:615`). Dry run and `--yes` both exit 1, nothing is deleted, and there
is no flag to get past it. Reproduction, on a machine with no Qdrant at the address in use:
```
mind new k --subject s --dir d ; mkdir n ; echo hello > n/a.md
mind basis record owner --subject s --uses memory        # at a terminal; type: record basis for s
mind memory ingest d --from n --subject s --yes ; mind memory index d --subject s    # "vectors ... not built"
mind erase s --agent d --by me --yes ; echo $?            # 1: "Mind wrote vectors ... cannot reach it now"
```
Suggested direction: remove the marker when the first connection fails before any collection call, or let `erase` say "no
store answered and a marker exists" with an explicit `--no-vectors` acknowledgement.

**B2. `mind setup` does not exit at a terminal.** After `Done.` (with or without `--no-turn`) the process stays alive, reads
the next lines you type as input, and ends only on Ctrl-D. Piped input ends it normally. Cause is probably the stdin stream
held by `lineReader` in `bin/commands/setup.ts` (`Bun.stdin.stream()`), never released. Reproduction: run `mind setup
--no-turn` in a terminal, answer the seven questions, wait: the shell prompt never returns (`ps` shows `mind`).

**B3. `setup`'s offered model ignores `MIND_OLLAMA_MODEL`.** `bin/commands/setup.ts` uses `found.ollama?.[0]` (the first
name in `/api/tags`) as the default. With several models pulled, "take the defaults" starts a turn on whichever is listed first
(here a 27B). Reproduction: pull two models, `export MIND_OLLAMA_MODEL=<the second>`, run `mind setup`, look at `Which model? [...]`.

**B4. The web page's schedule shows nothing for triggers in `soul/`.** `bin/commands/web.ts` (the state builder, near
line 83) reads `triggers.md` from the repository root, while the page, `mind triggers` and the README all put it in `soul/`.
Reproduction: make `soul/triggers.md` as in step 8a, start `mind web <dir> --subject <id> --port <n>`, then
`curl -H "x-mind-token: <key>" http://127.0.0.1:<n>/api/state` shows `"triggers":[]`.

**B5. `mind erase` leaves the imported notes and calls it `erased-and-verified`.** The notes `mind memory ingest` copied
into `memory/imported/` are not part of any erase place and do not contain the subject id, so the search afterwards does not
see them; they stay in the agent directory (and in git, if committed). Reproduction: steps 27 and 45 above; `ls
d/memory/imported/notes` after the erase.

**B6 (minor, wording). Two messages that mislead.** (a) The web chat's `notes` field, for a turn that was answered by
ollama with `"local": true`, still says `route: Nothing is held back and the turn does not act, so the turn goes to cloud.`
(b) Refusing a proposal through `POST /api/proposals/<id>/refuse` answers `{"ok":true,"message":"Nothing has been refused for
this subject yet."}` although the refusal was recorded (the list shows it).

**B7 (minor). `mind doctor` and `mind memory index` read different Qdrant addresses.** `memory index` and `erase` use
`MIND_QDRANT_URL`; `doctor` only its `--qdrant` flag (default `:10300`). With the variable set to a dead port, `doctor` says
`ok store` while `index` says "Unable to connect".

## Doc fixes made in this commit

`docs/quickstart.md`: the provenance box now says an automated reviewer followed it with the published release and a local
model, and what was not run; cosign added to the requirements; the install URL uses `v0.11.0-alpha` and says why and what
`--version` prints; the model default of `setup` and the Ctrl-D problem are stated; the ledger shows two rows; the
`mind web` line names `--backend ollama`, the default port, and the empty schedule panel; the `mind erase` bullet says
what refuses and what it leaves; three rows added to the troubleshooting table; the time claim says how it was measured.
`README.md`: install section uses `v0.11.0-alpha` in every command, the dry-run sample is the recorded one, the "second
copy under the older name" claim is removed (the release has none), the error sample names the real tag, the Thai-half and
erase rows say what they cover, and `mind setup` mentions the Ctrl-D problem.
