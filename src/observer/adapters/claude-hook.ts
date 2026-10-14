/**
 * claude's hook payload → Mind's record. The door D-024 exists for.
 *
 * ## Measured, not remembered
 *
 * Every field name below was read off the installed binary
 * (`~/.local/share/claude/versions/2.1.278`) rather than recalled, and the same
 * reading is written into `docs/cli-matrix.md` beside the version it came from,
 * next to the usage table that was measured the same way. The rule is the one
 * that table already states: these things move between releases, and when they
 * move the failures are silent.
 *
 * What the reading settled, and what it changed in the plan:
 *
 * - The fields on every payload are `session_id`, `transcript_path`, `cwd`, and
 *   optionally `prompt_id`, `permission_mode`, `agent_id`, `agent_type`,
 *   `effort`. **There is no timestamp**, which is why `at` is an argument here:
 *   the clock at the moment the hook fires is the time of the action.
 * - `UserPromptSubmit` carries `prompt` and an optional `source` — the vendor's
 *   own word for who authored the turn. This is far better evidence than w4's
 *   plan expected to have, and `origin.ts` explains exactly how far it goes.
 * - `PostToolUse` carries `tool_name`, `tool_input`, `tool_response`,
 *   `tool_use_id`, and optionally `duration_ms` and `mcp_server`.
 * - **A tool that fails does not fire `PostToolUse` at all.** It fires
 *   `PostToolUseFailure`, with `error` instead of `tool_response`. A denied
 *   permission fires `PermissionDenied`. The plan for w4 asked only for
 *   `UserPromptSubmit` and `PostToolUse`, which would have recorded a world in
 *   which nothing the owner does ever fails — and `outcome` would have been a
 *   column of `ok` that meant "this reader cannot see failures". So the
 *   failure event is read too, and the snippet asks for it.
 *
 * `PreToolUse` is still not asked for. It runs before every tool call and adds
 * latency to all of them, it cannot know the outcome, and the owner already has
 * a hook on that event.
 *
 * ## What this adapter refuses to carry
 *
 * `prompt` is present in the payload and is never read. `tool_response` is
 * present and is never read except to decide `ok` (and it is not even needed
 * for that — the event name says it). `S3.1 AC5` is "metadata and event, not a
 * copy of the transcript", and this is the one place where keeping the copy
 * would have been a single field access.
 */

import type { Adapted, Adapter } from "../reader.ts";
import type { CaptureEvidence, CaptureRecord } from "../record.ts";
import { CAPTURE_VERSION } from "../record.ts";
import { deriveOrigin, type SessionState } from "../origin.ts";
import { kindOf, targetOf } from "./vocabulary.ts";

/**
 * The events `observe hook --print` asks for, and the only ones this reads.
 *
 * One list, used by the snippet and by the adapter, so a snippet cannot ask for
 * an event nothing reads and a reader cannot expect one nothing sends.
 */
export const CLAUDE_HOOK_EVENTS: readonly string[] = [
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
];

/** The version this file's field names were read off. Printed beside the snippet. */
export const CLAUDE_HOOK_MEASURED = "claude 2.1.278, 2026-09-21";

/**
 * The settings fragment that would connect this reader — printed, never written.
 *
 * Mind does not edit another program's configuration. Not because it would be
 * hard, but because connecting a recorder to your own tools is the owner's act;
 * a program that wired itself in would have made the consent this directory
 * asks for a formality. So this returns a string, and what happens to it is
 * somebody else's decision: paste it into `settings.json`, or hand it to
 * `claude --settings "$(…)"` for one session and change no file at all —
 * measured on 2.1.278, that flag takes "a settings JSON file or a JSON string".
 *
 * The matcher is omitted rather than set to `"*"`: the field is optional in the
 * schema and an absent one means every tool, which is what this wants, and
 * guessing at the wildcard's spelling would be a guess with a silent failure
 * mode — a hook that matches nothing looks exactly like a hook that is working.
 */
export function claudeHookSnippet(command: string): string {
  const entry = { hooks: [{ type: "command", command }] };
  const hooks: Record<string, unknown[]> = {};
  for (const event of CLAUDE_HOOK_EVENTS) hooks[event] = [entry];
  return JSON.stringify({ hooks }, null, 2);
}

function obj(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The session a payload belongs to, so its state can be loaded before adapting. */
export function hookSession(value: unknown): string | undefined {
  const raw = obj(value);
  return raw === undefined ? undefined : text(raw["session_id"]);
}

/** The event name, so the caller can decide whether to write session state back. */
export function hookEvent(value: unknown): string | undefined {
  const raw = obj(value);
  return raw === undefined ? undefined : text(raw["hook_event_name"]);
}

/**
 * The session state a prompt payload leaves behind.
 *
 * Returns `undefined` for anything that is not a prompt, so the caller writes a
 * file only when there is something new to remember — a tool event that changed
 * nothing should not rewrite a session file on every tool call.
 */
export function nextSessionState(
  value: unknown,
  previous: SessionState,
  at: string,
): SessionState | undefined {
  const raw = obj(value);
  if (raw === undefined || raw["hook_event_name"] !== "UserPromptSubmit") return undefined;
  return {
    promptSource: text(raw["source"]) ?? null,
    permissionMode: text(raw["permission_mode"]) ?? previous.permissionMode,
    humanTurns: previous.humanTurns + 1,
    lastPromptAt: at,
  };
}

/**
 * Build the adapter for one hook firing.
 *
 * `at` and `session` are arguments rather than things this file goes and finds,
 * for the reason every other env in Mind is an argument: a reader that read
 * the clock and the disk by itself could not be tested against a fixed one.
 */
export function claudeHook(options: {
  readonly at: string;
  readonly session: SessionState;
}): Adapter {
  return (value: unknown): Adapted => {
    const raw = obj(value);
    if (raw === undefined) return { skip: "not-an-object" };

    const event = text(raw["hook_event_name"]);
    if (event === undefined) return { skip: "no-event" };
    if (!CLAUDE_HOOK_EVENTS.includes(event)) return { skip: `event:${event}` };

    const session = text(raw["session_id"]);
    if (session === undefined) return { skip: "no-session" };

    const project = text(raw["cwd"]) ?? "";
    const subagent = text(raw["agent_id"]) !== undefined;
    // The payload's own mode wins over the session's remembered one: a tool
    // that ran under `bypassPermissions` did so whatever mode the prompt was
    // typed in.
    const permissionMode = text(raw["permission_mode"]) ?? options.session.permissionMode;

    if (event === "UserPromptSubmit") {
      const evidence: CaptureEvidence = {
        promptSource: text(raw["source"]) ?? null,
        permissionMode,
        subagent,
        humanTurnsInSession: options.session.humanTurns + 1,
      };
      const key = text(raw["prompt_id"]) ?? `${session}:${options.at}`;
      return {
        records: [
          record({
            key: `claude:prompt:${key}`,
            at: options.at,
            session,
            project,
            kind: "prompt",
            // Nothing. Not the prompt, not its length, not a hash of it: a
            // short prompt is guessable from its hash, which is the same
            // reasoning `--private` uses in the ledger.
            tool: "",
            target: "",
            outcome: "unknown",
            evidence,
          }),
        ],
      };
    }

    const tool = text(raw["tool_name"]);
    if (tool === undefined) return { skip: "no-tool" };
    const id = text(raw["tool_use_id"]);
    if (id === undefined) return { skip: "no-tool-id" };

    const evidence: CaptureEvidence = {
      promptSource: options.session.promptSource,
      permissionMode,
      subagent,
      humanTurnsInSession: options.session.humanTurns,
    };
    const kind = kindOf(tool);

    return {
      records: [
        record({
          // The same key the seed mints for this call, so importing history
          // after capturing does not double-count what is already here (AC7).
          key: `claude:tool:${id}`,
          at: options.at,
          session,
          project,
          kind,
          tool,
          target: targetOf(kind, raw["tool_input"], project),
          outcome: event === "PostToolUseFailure" ? "failed" : "ok",
          evidence,
        }),
      ],
    };
  };
}

/** Fill in the fields every hook record shares. */
function record(parts: {
  readonly key: string;
  readonly at: string;
  readonly session: string;
  readonly project: string;
  readonly kind: CaptureRecord["kind"];
  readonly tool: string;
  readonly target: string;
  readonly outcome: CaptureRecord["outcome"];
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
    source: "hook",
    origin: deriveOrigin(parts.evidence),
    evidence: parts.evidence,
  };
}
