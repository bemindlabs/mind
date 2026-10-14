/**
 * grok's session log → the same record, and the join `S3.1 AC8` is about.
 *
 * ## The finding this file exists for
 *
 * SP-1 measured grok's 586 tool calls and found **zero** with a stated outcome —
 * until it noticed that all 565 `tool_completed` records, every one of which
 * carries an outcome, match a call **in a different file**. A reader that opens
 * one file at a time reports 0%; one that joins across the directory reports
 * 96.4%. That is the whole of AC8, and it is the reason {@link indexGrokLine}
 * is separate from the adapter and the seed runs two passes over the *whole*
 * directory rather than two passes per file.
 *
 * A reader that skipped the join would not have failed loudly. It would have
 * written 586 records saying `outcome: "unknown"`, and the owner would have
 * learned that grok never succeeds at anything.
 *
 * ## grok has no hook
 *
 * `grok --help` offers no hook mechanism, so there is no live door for this
 * vendor and there is no honest way to pretend otherwise: grok can be seeded
 * and cannot be captured. After one seed it goes quiet, and the next seed is a
 * *backfill* — which D-024 says is not the shape E3 takes. `seed.ts` makes that
 * explicit rather than letting a periodic re-run become a backfill wearing
 * another name.
 *
 * ## How much of this is measured
 *
 * The *shapes* were measured by SP-1: an event stream, 85.3% of it
 * `phase_changed`; calls are untyped objects carrying a name and arguments;
 * answers are `tool_completed` records carrying an outcome word. The exact
 * spelling of each key was deliberately **not** printed by that survey — its
 * second privacy guard withholds any key name seen in fewer than five files —
 * so this adapter accepts the handful of spellings the survey's own key lists
 * used, and a record that matches none of them is skipped and counted rather
 * than guessed at. The seed's report is how that shows up: if grok's share of
 * `no-action` is large, this file is the thing to re-measure.
 */

import type { Adapted, Adapter } from "../reader.ts";
import type { CaptureEvidence, CaptureOutcome, CaptureRecord } from "../record.ts";
import { CAPTURE_VERSION, NO_EVIDENCE } from "../record.ts";
import { kindOf, targetOf } from "./vocabulary.ts";

/** What pass 1 collects across the whole directory — the join AC8 requires. */
export interface GrokIndex {
  /** call id → did it fail. Absent means no `tool_completed` was found anywhere. */
  readonly outcomes: Map<string, boolean>;
  /** session id → how many records look like a person typing. */
  readonly humanTurns: Map<string, number>;
}

export function emptyGrokIndex(): GrokIndex {
  return { outcomes: new Map(), humanTurns: new Map() };
}

/** Keys a call id might be under, as SP-1's own list had them. */
const CALL_ID_KEYS: readonly string[] = [
  "tool_call_id",
  "toolCallId",
  "tool_use_id",
  "toolUseId",
  "call_id",
  "callId",
  "id",
];

/** Keys a session id might be under. */
const SESSION_KEYS: readonly string[] = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
];

/** Keys a timestamp might be under. */
const TIME_KEYS: readonly string[] = ["timestamp", "created_at", "createdAt", "time", "ts"];

/** Keys a call's arguments might be under. */
const ARG_KEYS: readonly string[] = ["arguments", "input", "parameters", "args", "params"];

/** Words a vendor uses for "it worked" and "it did not". */
const SUCCESS_WORDS: ReadonlySet<string> = new Set(["success", "succeeded", "ok", "completed", "complete"]);
const FAILURE_WORDS: ReadonlySet<string> = new Set([
  "error",
  "failed",
  "failure",
  "denied",
  "rejected",
  "cancelled",
  "canceled",
  "aborted",
  "interrupted",
  "timeout",
  "timed_out",
]);

function obj(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function first(raw: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const found = text(raw[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Every object inside a record, breadth-first and bounded.
 *
 * Bounded because a session log is a document of unknown provenance, and a
 * reader that can be made to hang by a deeply nested one is not a reader. The
 * budget is generous enough for grok's records, which SP-1 found to be shallow.
 */
function* nodes(value: unknown): Generator<Record<string, unknown>> {
  const queue: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }];
  let head = 0;
  let budget = 2000;

  while (head < queue.length && budget > 0) {
    const item = queue[head];
    head += 1;
    budget -= 1;
    if (item === undefined) return;
    if (item.depth > 10) continue;

    if (Array.isArray(item.node)) {
      for (const child of item.node) {
        if (typeof child === "object" && child !== null) queue.push({ node: child, depth: item.depth + 1 });
      }
      continue;
    }
    const node = obj(item.node);
    if (node === undefined) continue;
    yield node;
    for (const child of Object.values(node)) {
      if (typeof child === "object" && child !== null) queue.push({ node: child, depth: item.depth + 1 });
    }
  }
}

/** `"success"` → false (did not fail), `"denied"` → true, anything else → no opinion. */
function outcomeWord(value: unknown): boolean | undefined {
  const word = text(value)?.toLowerCase();
  if (word === undefined) return undefined;
  if (SUCCESS_WORDS.has(word)) return false;
  if (FAILURE_WORDS.has(word)) return true;
  return undefined;
}

/** Whether a node is an answer to a call, and what it said. */
function completionOf(node: Record<string, unknown>): { id: string; failed: boolean } | undefined {
  const type = text(node["type"]) ?? "";
  if (!type.endsWith("_completed") && !type.endsWith("_result") && type !== "tool_completed") {
    return undefined;
  }
  const id = first(node, CALL_ID_KEYS);
  if (id === undefined) return undefined;

  if (node["is_error"] === true || node["error"] != null) return { id, failed: true };
  if (node["is_error"] === false) return { id, failed: false };
  for (const key of ["outcome", "status", "result"] as const) {
    const said = outcomeWord(node[key]);
    if (said !== undefined) return { id, failed: said };
  }
  return undefined;
}

/** Whether a node is a request to run a tool. */
function callOf(node: Record<string, unknown>): { id: string; tool: string; args: unknown } | undefined {
  const tool = text(node["name"]) ?? text(node["tool_name"]) ?? text(node["tool"]);
  if (tool === undefined) return undefined;

  let args: unknown;
  for (const key of ARG_KEYS) {
    if (node[key] !== undefined) {
      args = node[key];
      break;
    }
  }
  if (args === undefined) return undefined;

  const id = first(node, CALL_ID_KEYS);
  if (id === undefined) return undefined;
  return { id, tool, args };
}

/** Does this record look like a person typing? */
function looksTyped(node: Record<string, unknown>): boolean {
  const role = text(node["role"]) ?? text(node["type"]);
  if (role !== "user" && role !== "user_message" && role !== "user_input") return false;
  const content = node["content"] ?? node["text"] ?? node["message"];
  if (typeof content === "string") return content !== "";
  return false;
}

/** Pass 1: fold one parsed record into the index, from any file in the directory. */
export function indexGrokLine(value: unknown, into: GrokIndex, session: string): void {
  for (const node of nodes(value)) {
    const completion = completionOf(node);
    if (completion !== undefined) into.outcomes.set(completion.id, completion.failed);
    if (looksTyped(node)) into.humanTurns.set(session, (into.humanTurns.get(session) ?? 0) + 1);
  }
}

/**
 * Pass 2: one grok record to zero or more capture records.
 *
 * @param session The session this file belongs to. Passed in because SP-1 found
 *   grok's records do not reliably carry one, and a fabricated id would make
 *   two unrelated sittings look like one. The caller uses the file's own name,
 *   which is what the vendor organises sessions by.
 */
export function grokSession(index: GrokIndex, now: string, session: string): Adapter {
  return (value: unknown): Adapted => {
    const root = obj(value);
    if (root === undefined) return { skip: "not-an-object" };

    const humanTurns = index.humanTurns.get(session) ?? 0;
    // 80% of grok's sessions have nobody in them — the highest of any vendor
    // SP-1 measured. Skipped and counted, never quietly folded in.
    if (humanTurns === 0) return { skip: "no-human-session" };

    const at = first(root, TIME_KEYS) ?? now;
    const project = text(root["cwd"]) ?? text(root["workspace"]) ?? "";
    const evidence: CaptureEvidence = { ...NO_EVIDENCE, humanTurnsInSession: humanTurns };
    const records: CaptureRecord[] = [];

    for (const node of nodes(root)) {
      const call = callOf(node);
      if (call === undefined) continue;

      const failed = index.outcomes.get(call.id);
      const outcome: CaptureOutcome = failed === undefined ? "unknown" : failed ? "failed" : "ok";
      const kind = kindOf(call.tool);

      records.push({
        v: CAPTURE_VERSION,
        key: `grok:tool:${call.id}`,
        at: Number.isNaN(Date.parse(at)) ? now : at,
        vendor: "grok",
        session: first(root, SESSION_KEYS) ?? session,
        project,
        kind,
        tool: call.tool,
        target: targetOf(kind, call.args, project),
        outcome,
        source: "seed",
        origin: "unknown",
        evidence,
      });
    }

    return { records };
  };
}
