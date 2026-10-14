/**
 * claude's own transcript → the same record the hook produces.
 *
 * This is the seed half of `S3.1 AC1`: one schema, one pipe, two doors. It
 * exists because seven weeks of history are already on disk and reading them
 * costs five seconds (SP-1 §7) — and it is deliberately a *one-off*, because
 * those seven weeks are vendor retention rather than a base anything can be
 * built on, which is the whole of D-024.
 *
 * ## What SP-1 measured, and what this does with it
 *
 * - **Tool calls are `tool_use` blocks inside `message.content`**, answered by
 *   `tool_result` blocks in a following record, with ids on both sides. So the
 *   outcome for a call is in a *different record* from the call, which is why
 *   {@link ClaudeIndex} exists and the seed runs two passes.
 * - **5.3% of records appear in more than one file**, because a resumed session
 *   replays what came before. The key is the `tool_use` block's own id, so the
 *   reader's de-duplication (`S3.1 AC7`) removes the replay — and the *same*
 *   key the hook mints, so seeding after capturing adds only what was not
 *   already captured.
 * - **44% of claude's sessions have no human turn in them at all.** That is
 *   fleet work, and learning from it would teach the agent the habits of the
 *   agents. Those sessions are skipped and counted, never silently dropped.
 * - **15.4% of records are sub-agent work** (`isSidechain`). Same reasoning,
 *   same treatment.
 *
 * ## `origin` after the fact
 *
 * Every seeded record is `origin: "unknown"`, without exception. The evidence
 * that would decide it — who authored the turn — is the field the hook reads
 * from a live payload and the transcript does not contain. "A human typed
 * somewhere in this session" is a *session* fact and is recorded as
 * `humanTurnsInSession`; turning it into `owner-prompted` per action would be
 * the invention `S3.2 AC3` exists to prevent.
 */

import type { Adapted, Adapter } from "../reader.ts";
import type { CaptureEvidence, CaptureOutcome, CaptureRecord } from "../record.ts";
import { CAPTURE_VERSION, NO_EVIDENCE } from "../record.ts";
import { kindOf, targetOf } from "./vocabulary.ts";

/** What pass 1 collects, so pass 2 can answer questions the line itself cannot. */
export interface ClaudeIndex {
  /** `tool_use` id → did it fail. Absent means the transcript never said. */
  readonly outcomes: Map<string, boolean>;
  /** session id → how many records look like a person typing. */
  readonly humanTurns: Map<string, number>;
}

/** An empty index, which is also what a one-pass caller would get. */
export function emptyClaudeIndex(): ClaudeIndex {
  return { outcomes: new Map(), humanTurns: new Map() };
}

function obj(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The blocks of `message.content`, or an empty list when there is no array there. */
function blocksOf(raw: Record<string, unknown>): readonly Record<string, unknown>[] {
  const message = obj(raw["message"]);
  const content = message?.["content"];
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const item of content) {
    const block = obj(item);
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

/**
 * Did a person type this record?
 *
 * The same rule SP-1 used, and the same upper bound it reported: a `user`
 * record whose content holds text rather than a tool result. Hook output and
 * injected system text arrive as user records too, so this over-counts, and
 * SP-1 §5 says so in the same words.
 */
function looksTyped(raw: Record<string, unknown>): boolean {
  const message = obj(raw["message"]);
  const role = text(message?.["role"]) ?? text(raw["type"]);
  if (role !== "user") return false;
  if (raw["isMeta"] === true || raw["isCompactSummary"] === true) return false;

  const content = message?.["content"];
  if (typeof content === "string") return content !== "";

  let sawText = false;
  for (const block of blocksOf(raw)) {
    // A tool result is the harness answering itself, not a person.
    if (block["type"] === "tool_result") return false;
    if (block["type"] === "text") sawText = true;
  }
  return sawText;
}

/**
 * Pass 1: fold one parsed record into the index.
 *
 * Deliberately separate from the adapter rather than a mode of it. A pass that
 * both indexed and emitted would have to decide what to do about a call whose
 * answer is still ahead of it, and every available answer to that is a guess.
 */
export function indexClaudeLine(value: unknown, into: ClaudeIndex): void {
  const raw = obj(value);
  if (raw === undefined) return;

  const session = text(raw["sessionId"]);
  if (session !== undefined && looksTyped(raw)) {
    into.humanTurns.set(session, (into.humanTurns.get(session) ?? 0) + 1);
  }

  for (const block of blocksOf(raw)) {
    if (block["type"] !== "tool_result") continue;
    const id = text(block["tool_use_id"]);
    if (id === undefined) continue;
    const failed = block["is_error"];
    if (typeof failed === "boolean") into.outcomes.set(id, failed);
  }
}

/**
 * Pass 2: one transcript record to zero or more capture records.
 *
 * @param index What pass 1 saw across the whole directory.
 * @param now Used only for a record whose own timestamp is unreadable — 16.1%
 *   of claude's records carry none (SP-1 §6), and most of those are attachments
 *   and hook records that carry no action either. A record with an action and
 *   no time is stamped with the time of the seed and is still honest about
 *   being a seed, because `source` says so.
 */
export function claudeTranscript(index: ClaudeIndex, now: string): Adapter {
  return (value: unknown): Adapted => {
    const raw = obj(value);
    if (raw === undefined) return { skip: "not-an-object" };

    if (raw["isSidechain"] === true) return { skip: "sidechain" };
    if (raw["isMeta"] === true) return { skip: "meta" };
    if (raw["isCompactSummary"] === true) return { skip: "compact-summary" };

    const session = text(raw["sessionId"]);
    if (session === undefined) return { skip: "no-session" };

    // The fleet's work, not the owner's. Skipped and counted — 44% of claude's
    // sessions, measured, and the single largest thing standing between E3 and
    // learning the habits of agents.
    const humanTurns = index.humanTurns.get(session) ?? 0;
    if (humanTurns === 0) return { skip: "no-human-session" };

    const at = text(raw["timestamp"]) ?? now;
    const project = text(raw["cwd"]) ?? "";
    const evidence: CaptureEvidence = { ...NO_EVIDENCE, humanTurnsInSession: humanTurns };

    const records: CaptureRecord[] = [];

    if (looksTyped(raw)) {
      const uuid = text(raw["uuid"]);
      if (uuid !== undefined) {
        records.push(
          seeded({
            key: `claude:prompt:${uuid}`,
            at,
            session,
            project,
            kind: "prompt",
            tool: "",
            target: "",
            outcome: "unknown",
            evidence,
          }),
        );
      }
    }

    for (const block of blocksOf(raw)) {
      if (block["type"] !== "tool_use") continue;
      const id = text(block["id"]);
      const tool = text(block["name"]);
      if (id === undefined || tool === undefined) continue;

      const failed = index.outcomes.get(id);
      const outcome: CaptureOutcome =
        failed === undefined ? "unknown" : failed ? "failed" : "ok";
      const kind = kindOf(tool);

      records.push(
        seeded({
          key: `claude:tool:${id}`,
          at,
          session,
          project,
          kind,
          tool,
          target: targetOf(kind, block["input"], project),
          outcome,
          evidence,
        }),
      );
    }

    return { records };
  };
}

/** Fill in the fields every seeded claude record shares. */
function seeded(parts: {
  readonly key: string;
  readonly at: string;
  readonly session: string;
  readonly project: string;
  readonly kind: CaptureRecord["kind"];
  readonly tool: string;
  readonly target: string;
  readonly outcome: CaptureOutcome;
  readonly evidence: CaptureEvidence;
}): CaptureRecord {
  return {
    v: CAPTURE_VERSION,
    key: parts.key,
    at: parts.at,
    vendor: "claude",
    session: parts.session,
    project: parts.project,
    kind: parts.kind,
    tool: parts.tool,
    target: parts.target,
    outcome: parts.outcome,
    source: "seed",
    // Never derived. See the file header: the evidence is not in the file.
    origin: "unknown",
    evidence: parts.evidence,
  };
}
