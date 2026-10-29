# S22.1 — what each vendor CLI says when the quota is gone

Date 2026-10-27. Engine at `80ef979`. CLIs: claude 2.1.311, codex 0.164.0, kimi 2.1.1, copilot 0.0.367, gemini 0.64.0, opencode 1.18.31.
Method: read the logs and transcripts these CLIs already wrote on this machine. No quota was exhausted on purpose, no prompt was sent, and no personal text is quoted: samples have times, ids and URLs removed.

## Result

| CLI | Seen for real | Signal | Reset time given? | Where it comes out | Label |
|---|---|---|---|---|---|
| claude | 249 records | Transcript line with `error: "rate_limit"`, `apiErrorStatus: 429`, `isApiErrorMessage: true`. Text: `You've hit your session limit · resets <time> (<tz>)` or `You've hit your weekly limit · resets <date>, <time> (<tz>)`. Each record also carries `quotaLimits`: `status: "rejected"`, `resetsAt` (epoch s), `rateLimitType` (`seven_day`, session), `overageStatus`. 155 session-limit, 90 weekly-limit. | **Yes**, structured (`resetsAt`) and in the text | transcript; the headless exit path **not measured** | measured (transcript) |
| codex | 4 events | `task_complete` event with `error.message` starting `You've hit your usage limit.` Before the wall, every event carries `rate_limits`: `primary` (window 300 min) and `secondary` (10080 min), each `used_percent` and `resets_at` (epoch s), plus `credits.has_credits`. | **Yes**, structured, and a warning ahead of time (`used_percent`) | session file; headless exit code **not measured** | measured (session file) |
| gemini | 97 lines | `RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade ...` | Not in the text sampled | log | measured (log) |
| copilot | 16 lines | API error body `{"error":{"message":"You have no quota","code":"quota_exceeded"}}`. Also `quotaSnapshots.premium_interactions` in its own events. | Not seen | `~/.copilot/logs` | measured (log) |
| kimi | 0 | Log has 63 lines and none about a limit. | unknown | unknown | **not observed** |
| opencode | 0 | No log directory; state is in `opencode.db`, not read. The limit would be the upstream provider's (OpenRouter), not opencode's. | unknown | unknown | **not observed** |
| GLM (claude CLI to z.ai), Qwen (opencode to OpenRouter), grok | 0 | Not run on this machine. | unknown | unknown | **not observed** |

## What this means for S22.2

1. **Two kinds of exhaustion, two different waits.** claude and codex both separate a short window (about 5 hours) from a weekly one, and both give the reset as an epoch time. The classifier must keep `until` from the vendor, not guess a fixed cooldown. gemini and copilot give no time: they need a default back-off, shortest first.
2. **codex warns before it fails** (`used_percent`), claude does not in the lines read. A cooldown that only reacts to the failure wastes one turn per vendor per window; reading codex's percentage lets the fleet move a bot before the wall. Optional, not part of S22.2's first cut.
3. **A 429 is not always quota.** The same status carries a transient rate limit (claude marks one with `apiErrorIsTransient`). The classifier keys on the text and `rateLimitType`, not the status alone, or a busy second becomes an hour of cooldown.
4. **`authentication_failed` is a third class** (10 claude records). It must not be retried on a timer: the owner has to log in again.
5. **Claude's records are transcript lines, not what `claude -p` prints.** How a headless turn exits when limited is unmeasured for claude and codex. The fixtures for S22.2 can come from these samples, but the exit code and the stderr/stdout split need one real run per CLI, which costs a turn at the wall. Until then the classifier is "believed", as gemini's read-only flag is.

## Not measured, and why

- The headless exit path of every CLI. Reaching it means spending the quota, which the owner did not ask for.
- kimi, opencode, GLM, Qwen, grok: no sample on this machine. S22.3 must add a real run for GLM and Qwen once they exist.
- Per-CLI model and resume flags (the second half of S22.1 AC3): `kimi -S/-c/-m`, `copilot --resume/--continue/--model`, `claude --resume`, `codex resume`, `gemini -m` appear in each `--help`; their behaviour under a handoff was not run.
