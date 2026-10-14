# S12.6 — probe records (2026-09-26)

Evidence for D-119 (grok), D-120 (kimi) and D-121 (codex): the registry fixes SP-5 found, measured on
`grok 1.0.40`, `kimi 2.0.2` and `codex-cli 0.155.1` against a local model (LiteLLM → vLLM qwen3.8-27b)
in isolated homes with no cloud credentials, every `connect()` counted with `strace`.

| dir | what |
|---|---|
| `grok/` | `log.md` — every argv and result line (76 runs); `run2.sh` runner, `summarize.py`, `tasks-x.json` (the `$?` and `rm` probes), `replycheck.ts` |
| `kimi/` | `log.md`; `readonly-agent.md` — the profile byte-for-byte as shipped in the registry; `run-probe.sh`, `session-summary.py` |
| `codex/` | `log.md`; `run1.sh`, `summarize.py` |
| `verify/` | the re-run through mind's own `CliExec` (`drive.ts`, `run-case.sh`) and the tampered profile used to check that a restrained turn rewrites it |

Paths are rewritten (`<scratch>`, `<repo>`, `~`/`$HOME`) — these are records, not scripts to run as they stand.
The fixture, grader and task list are SP-5's, in `../2026-09-26_sp5/`. Session transcripts, vendor homes
and the raw run directories were not kept: they hold model output and vendor state, not evidence the logs lack.
