/**
 * "Did the owner ask for this, or did the machine decide?" — the one field
 * D-024 moved E3 for, and the exact size of the answer.
 *
 * ## Why this is not in the transcripts
 *
 * `S3.2 AC3` asks for the owner's actions separated from the AI's own
 * initiative. SP-1 measured whether that separation exists on disk and it does
 * not: every tool call in every transcript was issued by a model, and whether a
 * person asked for it lives in prose. The only structural handle available
 * afterwards is "did a human type in this session at all", which removes 44% of
 * claude's sessions and 80% of grok's — the fleet's work, not the owner's.
 *
 * At the moment of the action there is more. Measured on claude 2.1.278 (see
 * `docs/cli-matrix.md`), a `UserPromptSubmit` hook payload carries a `source`
 * field whose values are the vendor's own account of who authored the turn:
 *
 * - `user` — submitted from the interactive composer;
 * - `sdk` — the non-interactive entry point, which is `claude -p` and the Agent
 *   SDK, and therefore every fleet launcher on this machine;
 * - `loop_wakeup`, `schedule_wakeup`, `system`, `poll_event` — machine-injected
 *   turns of one kind or another.
 *
 * That is a far better signal than the plan for w4 expected to have, and it is
 * still a claim by the vendor about its own entry point rather than evidence
 * that a person was at the keyboard. The vendor's own schema adds that payloads
 * may omit the field entirely while it rolls out.
 *
 * ## The rule, and the one thing it refuses to do
 *
 * `unknown` is never folded into `owner-prompted`. It is the same shape as
 * `silent` in ADR 0001 and `UsageStatus.unreported` in `src/types.ts`: the
 * honest report of "nobody said" is its own value, because an agent that
 * learned the fleet's habits as its owner's would be precisely the failure
 * `S3.2 AC3` exists to prevent, and it would look like success.
 *
 * ## Why session state exists, and why it is a file
 *
 * Each hook firing is its own process. A `PostToolUse` payload says nothing
 * about who asked — the `source` was on the `UserPromptSubmit` that came before
 * it, in a process that has already exited. So the prompt's evidence is written
 * to a small file keyed by session, and the tool events read it back.
 *
 * The file lives *inside* the observer directory, which is what makes
 * `observe purge` and `mind erase` reach it without either of them being
 * taught about it (I-4).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";
import type { CaptureEvidence, CaptureOrigin } from "./record.ts";

/** The directory session state lives in, under the observer directory. */
export const SESSIONS_DIR = "sessions";

/**
 * Prompt sources that mean a machine authored the turn.
 *
 * `user` is deliberately absent: it is the only value that means the other
 * thing, and listing the machine values rather than the human one means a word
 * a future release adds lands in `unknown` instead of in `owner-prompted`.
 */
const MACHINE_SOURCES: readonly string[] = [
  "sdk",
  "system",
  "loop_wakeup",
  "schedule_wakeup",
  "poll_event",
];

/** The one prompt source that claims a person was at the keyboard. */
const HUMAN_SOURCE = "user";

/**
 * Who set this going, from the evidence and nothing else.
 *
 * Pure, and in this order on purpose. A subagent's work is the fleet's however
 * the session started, so that test comes first; the vendor's own word comes
 * second; and everything else is `unknown`, including a session where a human
 * has typed at some point but the vendor said nothing about *this* turn.
 */
export function deriveOrigin(evidence: CaptureEvidence): CaptureOrigin {
  if (evidence.subagent) return "subagent";
  if (evidence.promptSource === HUMAN_SOURCE) return "owner-prompted";
  if (evidence.promptSource !== null && MACHINE_SOURCES.includes(evidence.promptSource)) {
    return "unattended";
  }
  return "unknown";
}

/** What one session has shown so far. Counters and one vendor word; never text. */
export interface SessionState {
  /** The vendor's `source` word from the most recent prompt, or null. */
  readonly promptSource: string | null;
  /** The permission mode last seen, or null. */
  readonly permissionMode: string | null;
  /** How many prompts this session has seen. A count, never a word of them. */
  readonly humanTurns: number;
  /** When the last prompt arrived, ISO-8601, or null. */
  readonly lastPromptAt: string | null;
}

/** A session nothing is known about yet. */
export const NO_SESSION: SessionState = Object.freeze({
  promptSource: null,
  permissionMode: null,
  humanTurns: 0,
  lastPromptAt: null,
});

/**
 * Where one session's state goes.
 *
 * The file is named by a hash of the session id rather than by the id itself.
 * Not for secrecy — the directory is the owner's own and mode 0700 — but
 * because a session id is a value from outside this program, and a value from
 * outside this program has no business being concatenated into a path. A hash
 * cannot contain `..` or a separator.
 */
export function sessionStatePath(observerPath: string, session: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(session);
  return join(observerPath, SESSIONS_DIR, `${hasher.digest("hex").slice(0, 32)}.json`);
}

/**
 * Read a session's state back.
 *
 * A missing or unreadable file is {@link NO_SESSION} rather than an error: a
 * tool event that arrives before any prompt — a session resumed from before
 * capture was enabled, say — is a real case, and it means "nothing is known",
 * which is exactly what that value says.
 */
export async function loadSessionState(path: string): Promise<SessionState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return NO_SESSION;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The message would quote the file. There is nothing to say that is safe.
    return NO_SESSION;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_SESSION;

  const raw = value as Record<string, unknown>;
  const turns = raw["humanTurns"];
  return {
    promptSource: typeof raw["promptSource"] === "string" ? raw["promptSource"] : null,
    permissionMode: typeof raw["permissionMode"] === "string" ? raw["permissionMode"] : null,
    humanTurns: typeof turns === "number" && Number.isSafeInteger(turns) && turns >= 0 ? turns : 0,
    lastPromptAt: typeof raw["lastPromptAt"] === "string" ? raw["lastPromptAt"] : null,
  };
}

/**
 * Write a session's state.
 *
 * A whole-file write rather than an append, because this is the one piece of
 * capture that is a *current value* rather than a record of something that
 * happened — and it is small enough that a torn write costs one session's
 * evidence and nothing else. {@link loadSessionState} reads a torn file as
 * `NO_SESSION`, which degrades to `unknown` rather than to a wrong answer.
 *
 * **It creates no directory**, and that is load-bearing rather than tidy. A
 * `mkdir(..., { recursive: true })` here would rebuild the observer tree that
 * `observe purge` had just removed — a hook quietly undoing a deletion, which
 * is the one thing I-4 cannot survive. The directory is made once, by
 * `observe enable`, which has the `CaptureNotice` that permits it. When it is
 * gone this write fails, and a failed write is the correct outcome: there is no
 * consent either, because consent lived in the same directory.
 */
export async function saveSessionState(path: string, state: SessionState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state)}\n`, { mode: STATE_FILE_MODE });
}

/** Create the session directory. Called only where a {@link CaptureNotice} was required. */
export async function ensureSessionsDir(observerPath: string): Promise<string> {
  const dir = join(observerPath, SESSIONS_DIR);
  await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
  return dir;
}
