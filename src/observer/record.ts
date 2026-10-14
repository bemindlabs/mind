/**
 * The one shape a captured action has, whichever door it came in through.
 *
 * ## Why there is a schema here at all
 *
 * D-024 turned E3 from a dig into a capture: claude keeps seven weeks and grok
 * keeps eleven days, so the record written at the moment something happens is
 * the only copy there will ever be. That makes this file the narrowest part of
 * the whole story — everything an owner will ever be able to ask about their
 * own behaviour has to fit through it, and everything that fits through it is
 * something they will later have to be able to delete.
 *
 * So the schema is deliberately small, and the two halves of that smallness are
 * different decisions:
 *
 * - **What is here** is what `S3.2 AC2` asks for: when, which project, what
 *   kind, what target, did it work. Plus the field the transcripts cannot give
 *   at all (`origin`), which is the entire reason D-024 moved this to a hook.
 * - **What is not here** is prompt text, tool output, file contents, and diffs.
 *   `S3.1 AC5` says metadata and event, not a copy of the transcript. A
 *   capture that held the text would be a second transcript in a directory the
 *   owner believes holds counters.
 *
 * ## `target`, and the decision that shrank it
 *
 * The plan for w4 proposed keeping a command's whole line, capped at 512
 * characters, with the pre-commit secret scan as the safety net. The owner
 * decided otherwise, and the reasoning is worth keeping next to the code: a
 * command line is where secrets and personal data most often sit — a header
 * carrying a token, a path carrying somebody's name, a prompt passed as an
 * argument — and `SCAN_BLIND_SPOTS` (src/guard/scan.ts) states in its own first
 * line that no rule there can see personal data written as prose. Leaning on it
 * would have been leaning on something whose documentation says it does not
 * hold.
 *
 * So `target` is split by kind instead:
 *
 * | kind | what is kept |
 * |---|---|
 * | `file-edit` | the path, relative to the project root — the real behavioural signal S3.2 AC2 wants |
 * | `command` | the program name and its first subcommand: `git commit`, `docker restart` |
 * | `tool`, `prompt` | nothing. The tool's own name is already in `tool` |
 *
 * That is a trade, not a free win: resolution is exchanged for a smaller leak
 * surface, and anyone who needs full argv has to design a separate consent for
 * it rather than getting it as a side effect of this one. {@link CAPTURE_LIMITS}
 * in `consent.ts` says so where an owner will read it.
 */

import { basename, isAbsolute, relative } from "node:path";

/** Schema version, written on every line. A line from another version is skipped, not guessed at. */
export const CAPTURE_VERSION = 1;

/**
 * The vendors a capture may come from — a closed union, which is `S3.1 AC6`.
 *
 * SP-1 measured codex at 53% extraction (bar was 60%) and kimi at no tool calls
 * at all, so neither is seeded. Writing that as a union rather than as a runtime
 * check means `--vendor codex` is a `tsc` error at every call site that names a
 * vendor literally, and a usage error at the one place a string arrives from a
 * command line.
 */
export type CaptureVendor = "claude" | "grok" | "mind";

/** The engine's own vendor word: the recorder itself, naming the turns it ran through `mind turn`. */
const OWN_VENDOR: CaptureVendor = "mind";

/** The key of a turn's record is this and the turn's id, `<vendor>:prompt:<turn id>`. */
export const TURN_KEY_PREFIX = `${OWN_VENDOR}:prompt:`;

/**
 * Every vendor, for a usage message and for iteration. One copy of the list.
 *
 * The engine's own name is the third member since D-032 and is not a vendor anybody is
 * *read from*: it is the recorder itself, naming the turns it ran through
 * `mind turn`. It sits in this union because a record needs a namespace for
 * its key and a word for where it came from, and inventing a parallel field
 * for one value would have given every reader two places to look. The union
 * stays closed (S3.1 AC6) — naming the engine as `--vendor` on a seed is still a usage error,
 * because there is no history on disk to seed from; see {@link SEED_VENDORS}.
 */
export const CAPTURE_VENDORS: readonly CaptureVendor[] = ["claude", "grok", OWN_VENDOR];

/** The vendors a seed may read history from — the two with files on disk. */
export const SEED_VENDORS: readonly CaptureVendor[] = ["claude", "grok"];

/** True when a string from a command line is one of them, without widening the type. */
export function isCaptureVendor(value: string): value is CaptureVendor {
  return (CAPTURE_VENDORS as readonly string[]).includes(value);
}

/** True when a vendor has history on disk a seed could read. The engine's own name never does. */
export function isSeedVendor(value: string): value is CaptureVendor {
  return (SEED_VENDORS as readonly string[]).includes(value);
}

/**
 * What happened, in the three kinds `S3.2 AC1` kept plus the one that frames them.
 *
 * `prompt` carries no text (see the file header). It is recorded because it is
 * the evidence that a human turn happened in this session at all, which is the
 * only structural handle SP-1 §5 found on "whose behaviour is this".
 */
export type CaptureKind = "prompt" | "file-edit" | "command" | "tool";

/**
 * Did it work.
 *
 * `unknown` is kept apart from `failed` for the reason `Confidence.silent` is
 * kept apart from `failed` in `src/types.ts`: "the vendor did not say" and "the
 * vendor said it failed" need different fixes, and collapsing them invents a
 * result nobody reported.
 */
export type CaptureOutcome = "ok" | "failed" | "unknown";

/**
 * Which door the record came through.
 * `turn` is `mind turn` recording itself (D-032): the one door where Mind
 * is the program that ran the action rather than a hook watching somebody
 * else's. It carries no tool calls — a local turn has none — so a record
 * through this door is always a `prompt`.
 */
export type CaptureSource = "hook" | "seed" | "turn";

/**
 * Who set this action going — the field `S3.2 AC3` needs and no transcript has.
 *
 * `unknown` is never folded into `owner-prompted`, the same way `silent` is
 * never folded into `failed`. An agent that learned the fleet's habits as the
 * owner's would be exactly the failure AC3 exists to prevent, and the safe
 * direction when the evidence is absent is to say so.
 */
export type CaptureOrigin = "owner-prompted" | "unattended" | "subagent" | "unknown";

/**
 * What was on the record when `origin` was derived, kept so the derivation can
 * be argued with later.
 *
 * Every field is evidence rather than a verdict. `promptSource` is the vendor's
 * own word for who authored the turn (claude 2.1.278 writes `user`, `sdk`,
 * `system`, `loop_wakeup`, `schedule_wakeup` or `poll_event`); `permissionMode`
 * is the mode the tool ran under. Both are strings rather than unions on
 * purpose: a vendor adding a seventh word should land here as that word, not as
 * a parse failure that loses the record.
 */
export interface CaptureEvidence {
  /** The vendor's own account of who authored the turn, or null where it said nothing. */
  readonly promptSource: string | null;
  /** The permission mode in force, or null. */
  readonly permissionMode: string | null;
  /** The event fired from inside a subagent. */
  readonly subagent: boolean;
  /** Human turns seen in this session so far — a count, never the text. */
  readonly humanTurnsInSession: number;
}

/** The evidence of a record that carried none. Every field says "nobody said". */
export const NO_EVIDENCE: CaptureEvidence = Object.freeze({
  promptSource: null,
  permissionMode: null,
  subagent: false,
  humanTurnsInSession: 0,
});

/** One thing that happened, as Mind will remember it. */
export interface CaptureRecord {
  /** Schema version. */
  readonly v: number;
  /**
   * Identity of the event, `vendor:kind:id`.
   *
   * `S3.1 AC7`: 5.3% of claude's transcript records appear in more than one
   * file, because a resumed session replays what came before. An action counted
   * twice is a preference invented, so every reader de-duplicates on this and
   * the hook and the seed produce the *same* key for the same tool call —
   * which is what makes seeding after capturing safe.
   */
  readonly key: string;
  /** When, ISO-8601. */
  readonly at: string;
  readonly vendor: CaptureVendor;
  /** The vendor's session id, so records can be grouped without the text. */
  readonly session: string;
  /** The working directory the action happened in. */
  readonly project: string;
  readonly kind: CaptureKind;
  /** The tool's name as the vendor spells it, or `""` for a prompt. */
  readonly tool: string;
  /** See the file header. Never a whole command line, never file contents. */
  readonly target: string;
  readonly outcome: CaptureOutcome;
  readonly source: CaptureSource;
  readonly origin: CaptureOrigin;
  readonly evidence: CaptureEvidence;
}

/**
 * Exactly what a capture keeps and what it refuses, in the words `observe
 * enable` prints and hashes.
 *
 * This list *is* the consent. It is hashed into `consent.json`, and a release
 * that changes a line here changes the hash, which stops capture until the
 * owner has been shown the new list and agreed to it again. That is the whole
 * mechanism: consent to a sentence, not consent to a program.
 */
export const CAPTURE_FIELDS: readonly string[] = [
  "kept: when it happened, to the second.",
  "kept: the working directory the action happened in — which is a path under your home directory.",
  "kept: the vendor's session id, so two actions can be known to belong to one sitting.",
  "kept: the kind — a prompt you typed, a file edited, a command run, or another tool call.",
  "kept: the tool's name as the vendor spells it (Read, Bash, Edit …).",
  "kept: for a file edit, the file's path relative to the project directory.",
  "kept: for a command, the program name and its first subcommand only — `git commit`, never the " +
    "rest of the line.",
  "kept: whether it succeeded, failed, or the vendor did not say.",
  "kept: whether you appear to have asked for it, a schedule or a script did, or a subagent did — " +
    "and the vendor's own word for who authored the turn, which is the evidence behind that.",
  "kept: a turn you ran with `mind turn` itself — that it happened, its id, which backend answered, " +
    "and whether a terminal was attached when you ran it. Never the prompt.",
  "not kept: the text of anything you typed. A prompt is recorded as having happened, without a " +
    "word of it.",
  "not kept: anything a tool printed, anything a file contained, and any diff.",
  "not kept: the rest of a command line — arguments, flags, URLs, environment assignments.",
  "not kept: anything at all from codex, gemini, copilot or kimi. Only claude and grok are read.",
];

// ---------------------------------------------------------------------------
// target, per kind
// ---------------------------------------------------------------------------

/** Longest `target` any record may carry. A path longer than this is truncated, not dropped. */
export const TARGET_MAX = 256;

/** A subcommand is a bare word: no slash, no dot, no leading dash, nothing that could be a path. */
const SUBCOMMAND = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * A command line reduced to a program and a subcommand.
 *
 * `basename` on the program for the same reason the rest of the line is
 * dropped: `/home/<someone>/bin/deploy` names a person, and `deploy` is the
 * part that is a fact about behaviour. The second word is kept only when it
 * looks like vocabulary — `git commit`, `docker restart` — so a path, a flag or
 * a URL in that position is discarded rather than trimmed.
 *
 * Deliberately not a shell parser. `cd x && git push` reduces to `cd`, which
 * understates the action; that is stated in `CAPTURE_LIMITS` rather than fixed
 * by guessing at an operator's precedence, because a wrong guess here keeps the
 * *second* half of a line, which is the half this function exists to drop.
 */
export function commandTarget(command: string): string {
  const words = command.trim().split(/\s+/).filter((word) => word !== "");
  const program = words[0];
  if (program === undefined) return "";

  const name = basename(program);
  const next = words[1];
  if (next === undefined || !SUBCOMMAND.test(next)) return clamp(name);
  return clamp(`${name} ${next}`);
}

/**
 * A file path, relative to the project it was edited in.
 *
 * Relative because that is the behavioural signal — "this person edits
 * `src/observer/`" is about them, "`/home/<someone>/…`" is about their machine.
 * A path outside the project keeps its `../` prefix rather than being hidden:
 * an edit outside the project is a real thing that happened, and reporting it
 * as if it were inside would be worse than reporting where it was.
 */
export function fileTarget(path: string, project: string): string {
  if (path === "") return "";
  if (project === "" || !isAbsolute(path)) return clamp(path);
  return clamp(relative(project, path));
}

/** Cut to {@link TARGET_MAX}, marking that something was cut. */
function clamp(value: string): string {
  return value.length <= TARGET_MAX ? value : `${value.slice(0, TARGET_MAX - 1)}…`;
}

// ---------------------------------------------------------------------------
// Reading a line back
// ---------------------------------------------------------------------------

/** A parsed record, or the one-word reason it was skipped. Never throws. */
export type ParsedRecord =
  | { readonly ok: true; readonly record: CaptureRecord }
  | { readonly ok: false; readonly reason: string };

const KINDS: readonly string[] = ["prompt", "file-edit", "command", "tool"];
const OUTCOMES: readonly string[] = ["ok", "failed", "unknown"];
const SOURCES: readonly string[] = ["hook", "seed", "turn"];
const ORIGINS: readonly string[] = ["owner-prompted", "unattended", "subagent", "unknown"];

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function word(value: unknown, allowed: readonly string[]): string | undefined {
  const text = str(value);
  return text !== undefined && allowed.includes(text) ? text : undefined;
}

/**
 * One JSON line to a record, or a reason.
 *
 * Returns rather than throws, and the reason is a fixed word rather than the
 * exception's message: `JSON.parse` quotes the input it choked on, so a
 * parse-error message is a capture excerpt wearing a diagnostic's clothes. That
 * rule came out of SP-1 (guard 3) and applies with more force here, because
 * these lines are the owner's own.
 */
export function parseRecord(line: string): ParsedRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reason: "unparsable" };
  }
  return fromValue(value);
}

/** The same validation over an already-parsed value. */
export function fromValue(value: unknown): ParsedRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "not-an-object" };
  }
  const raw = value as Record<string, unknown>;

  if (raw["v"] !== CAPTURE_VERSION) return { ok: false, reason: "wrong-version" };

  const key = str(raw["key"]);
  const at = str(raw["at"]);
  const vendor = str(raw["vendor"]);
  const session = str(raw["session"]);
  const project = str(raw["project"]);
  const kind = word(raw["kind"], KINDS);
  const tool = str(raw["tool"]);
  const target = str(raw["target"]);
  const outcome = word(raw["outcome"], OUTCOMES);
  const source = word(raw["source"], SOURCES);
  const origin = word(raw["origin"], ORIGINS);

  if (key === undefined || key === "") return { ok: false, reason: "no-key" };
  if (at === undefined || Number.isNaN(Date.parse(at))) return { ok: false, reason: "no-time" };
  if (vendor === undefined || !isCaptureVendor(vendor)) return { ok: false, reason: "vendor" };
  if (
    session === undefined ||
    project === undefined ||
    kind === undefined ||
    tool === undefined ||
    target === undefined ||
    outcome === undefined ||
    source === undefined ||
    origin === undefined
  ) {
    return { ok: false, reason: "shape" };
  }

  return {
    ok: true,
    record: {
      v: CAPTURE_VERSION,
      key,
      at,
      vendor,
      session,
      project,
      kind: kind as CaptureKind,
      tool,
      target,
      outcome: outcome as CaptureOutcome,
      source: source as CaptureSource,
      origin: origin as CaptureOrigin,
      evidence: evidenceOf(raw["evidence"]),
    },
  };
}

/**
 * Evidence, where a line carried it.
 *
 * A missing block is still a valid line — the ledger takes the same view of its
 * own optional fields (`src/ledger/entry.ts`), and for the same reason: a
 * record written by an older release is evidence about behaviour, and refusing
 * it over a field that did not exist then loses the thing being kept.
 */
function evidenceOf(value: unknown): CaptureEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_EVIDENCE;
  const raw = value as Record<string, unknown>;
  const turns = raw["humanTurnsInSession"];
  return {
    promptSource: str(raw["promptSource"]) ?? null,
    permissionMode: str(raw["permissionMode"]) ?? null,
    subagent: raw["subagent"] === true,
    humanTurnsInSession:
      typeof turns === "number" && Number.isSafeInteger(turns) && turns >= 0 ? turns : 0,
  };
}

/** One record as the one line that will be appended. Ends with a newline. */
export function formatRecord(record: CaptureRecord): string {
  return `${JSON.stringify(record)}\n`;
}
