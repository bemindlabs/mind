/**
 * One line of the ledger: what it says, and the longer list of what it does not.
 *
 * The ledger is the most sensitive thing Mind writes. A soul is a claim about
 * an identity and can be read by anyone the owner shows it to; a ledger is the
 * actual conversation, and by S8.2 and S9.1 it will hold messages sent to other
 * people. So the shape below is chosen by subtraction — the question asked of
 * every candidate field was not "is this useful?" but "would losing control of
 * this line matter more with it than without it?".
 *
 * **One line per prompt that really reached a backend**, not per turn. A chain
 * where `claude` is silent and `ollama` answers writes two lines under one
 * `turn` id, because the fact S2.2 exists to record — and the fact I-6 turns on
 * — is *who received this text*, and two backends did. A backend reported
 * `unavailable` never received it and gets no line.
 *
 * What is deliberately absent, and why:
 *
 * - **The soul text.** Already in git, where the owner can read it. A second
 *   copy out here is a second copy to find and delete. `soul_sha` says which
 *   version was worn, which is the only part a later reader needs.
 * - **`evidence.raw`.** A vendor's raw stdout/stderr carries account emails,
 *   session ids, absolute paths and occasionally a token in an error message —
 *   and duplicates `text` when the turn worked at all.
 * - **`env` and `cwd`.** One may hold secrets; the other is a path on this
 *   machine, which D-021 keeps out of anything Mind writes on its own.
 * - **hostname, username, absolute paths.** Same reason, and none of them are
 *   needed to answer "what did this agent do?".
 *
 * And what is **not** filtered: the prompt is stored exactly as it was typed.
 * Mind does not scan it for secrets and does not promise to. The honest tool
 * for a prompt that must not be kept is `--private`, which does not write it in
 * the first place — see {@link LedgerContent}.
 *
 * Field names are `snake_case` while the rest of the codebase is `camelCase`.
 * That is on purpose: this is a wire format an owner is expected to read with
 * `jq` and nothing else (AC5, as amended), so it follows the conventions of
 * JSON on disk rather than of the program that happens to write it.
 */

import type { NotCharged, TurnCost } from "../pricing/cost.ts";
import { NOT_CHARGED } from "../pricing/cost.ts";
import { ALL_RATE_FIELDS, RATE_1H, RATE_FIELDS, MAX_RATE, TABLE_DIGEST } from "../pricing/table.ts";
import { isSafeId } from "../identity/shapes.ts";
import type { Confidence, Usage } from "../types.ts";
import { isSubjectId, tokenCount, USAGE_FIELDS, type SubjectId } from "../types.ts";

/** Schema version carried in every line, so a reader never has to guess. */
export const LEDGER_VERSION = 1;

/**
 * Whether this line kept what was said.
 *
 * `withheld` is what `--private` writes: the turn still happened and is still
 * auditable — time, backend, exit, duration and sizes are all there — but the
 * text is not on disk and never was.
 *
 * There is deliberately **no hash of a withheld prompt**. A sha256 looks like
 * anonymisation and is not: a short prompt, a password, a name, an account
 * number are all recoverable from a digest by anyone willing to guess. Storing
 * one would be a claim of privacy the format cannot keep.
 */
export type LedgerContent = "full" | "withheld";

/** How the identity reached the backend that answered. Mirrors `IdentityStrength`. */
export type LedgerIdentity = "system" | "user" | "none";

/** One prompt, one backend, one delivery. */
export interface LedgerEntry {
  readonly v: typeof LEDGER_VERSION;
  /**
   * What this line records. Only `turn` exists at S2.2; S5.2 (proposals) and
   * S8.2 (messages) add their own, which is why the field is here from the
   * start rather than being bolted on with a v2.
   */
  readonly kind: "turn";
  /** Unique per line. */
  readonly id: string;
  /** Shared by every line one `mind turn` produced. */
  readonly turn: string;
  /** ISO 8601 UTC, taken before the prompt was sent. */
  readonly at: string;
  /** Whose turn this was. Never implicit (I-3, D-003). */
  readonly subject: SubjectId;
  /** Which backend received the prompt. */
  readonly backend: string;
  /**
   * The model this turn ran on, as far as it is known — or null (S15.9, D-142).
   *
   * For a vendor CLI, the model its own output named (claude's and grok's `modelUsage`), never the name Mind
   * asked for: `opus` is an alias, and what it resolved to is the fact. Null when the output named none, or
   * named more than one. For ollama, the model Mind handed the daemon, which serves exactly that tag; for a
   * local CLI, `local-coder`, the only model it is set up to run. This is the name a line is priced by.
   */
  readonly model: string | null;
  /**
   * The model Mind asked this backend for, or null when it asked for none and the backend ran its own
   * default (D-142). Marked apart from {@link model} because a request is not a result: a vendor CLI resolves
   * an alias, and may say nothing about what it resolved it to.
   *
   * **Optional on read**, as {@link usage} is: lines from before D-142 lack it and must still parse. Every
   * model turn written since carries it. It prices a line only when the output named no model at all and the
   * name is exactly one a price table in force lists for this backend (`src/pricing/cost.ts`).
   */
  readonly model_requested?: string | null;
  readonly content: LedgerContent;
  /** Verbatim, or null under `--private`. */
  readonly prompt: string | null;
  /** Size of the prompt in UTF-8 bytes, recorded even when the text is not. */
  readonly prompt_bytes: number;
  /** Verbatim, or null under `--private`. */
  readonly text: string | null;
  readonly text_bytes: number;
  readonly confidence: Confidence;
  /** Process exit code when there was a process, null otherwise. */
  readonly exit: number | null;
  readonly duration_ms: number | null;
  /**
   * What the turn cost, or `null`: **not charged** (S15.9, D-110, D-139).
   *
   * This field was null by decision (D-023): the only money on offer was a vendor's own quote — claude's
   * `total_cost_usd` put $0.81 on a two-character answer, the list price of a cache write a subscription
   * holder is never billed for — and a line carried nothing that said whose price it was. It is still never
   * the vendor's figure. It is Mind's arithmetic over {@link usage} and a price table, and it carries the
   * table's version and content digest, whether the price was the shipped default or the owner's own, and
   * every rate it applied — so the claim is checkable, and whose claim it is is written next to it.
   *
   * `usd_micros` is an integer count of US micro-dollars (1 = $0.000001), because it goes into a signed
   * report whose canonical JSON allows integers only (D-138). Null whenever any number the sum needs is
   * missing, and {@link not_charged} says which — never 0, which would be a claim the turn was free, and
   * never an estimate. Every line written before S15.9 is null here, and message lines (A2A, chat) always
   * are: they are not model turns.
   */
  readonly cost: TurnCost | null;
  /**
   * Why {@link cost} is null — or null when it is not (S15.9).
   *
   * **Optional on read**, for the reason {@link usage} is: every line from before S15.9 lacks it and must
   * still parse, and a reader that finds nothing here is looking at a line written before turns were priced
   * (the report calls it `not-recorded`). Every model turn written since carries it.
   */
  readonly not_charged?: NotCharged | null;
  /**
   * What the turn used, in tokens the backend itself printed.
   *
   * **Optional on read, always written.** Every line Mind writes from now on
   * carries it; every line written before this task does not, and those lines
   * still have to parse. If this were required, `parseLine` would reject them,
   * `ledger show` would count them as unreadable, and `ledger forget` — which
   * only deletes lines it could read — would leave them on disk while
   * reporting success. That is I-4 broken by a schema change, which is a
   * strange way to lose the owner's right to withdraw their own data.
   *
   * A reader that finds nothing here is looking at a line from before the
   * counts existed; `status: "unreported"` is a line that was written after,
   * by a backend nobody has surveyed. The two are not the same fact.
   */
  readonly usage?: Usage;
  readonly identity: LedgerIdentity;
  /** sha256 of the rendered soul, so a reader knows which version was worn. */
  readonly soul_sha: string | null;
}

/** Bytes a string occupies as UTF-8 — the size a `--private` line still records. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Serialise one entry as one line.
 *
 * `JSON.stringify` escapes every newline inside a string, so a prompt that
 * spans twenty lines still lands as one — which is what makes the file
 * append-only in the sense that matters: a partially written line can never be
 * mistaken for a complete one.
 */
export function formatLine(entry: LedgerEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

/** A line read back: either an entry, or the reason it could not be one. */
export type ParsedLine =
  | { readonly ok: true; readonly entry: LedgerEntry }
  | { readonly ok: false; readonly reason: string };

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

const CONFIDENCES = new Set(["confirmed", "partial", "failed", "silent"]);
const IDENTITIES = new Set(["system", "user", "none"]);
const USAGE_STATUSES = new Set(["reported", "missing", "unreported"]);

/**
 * Why this line's `usage` could not be read back, or undefined when it can.
 *
 * Absence is not a problem: see {@link LedgerEntry.usage}. Anything present is
 * validated with the same rule the exec layer used to write it, so a line
 * carrying `"123"` or `-1` is rejected here rather than handed on as a count.
 */
function usageProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "usage is present but is not an object";
  }
  const usage = value as Record<string, unknown>;
  if (!USAGE_STATUSES.has(usage["status"] as string)) {
    return `unknown usage status ${JSON.stringify(usage["status"])}`;
  }
  for (const field of ["input", "output", "total"]) {
    if (usage[field] !== null && tokenCount(usage[field]) === null) {
      return `usage.${field} is not a whole token count or null`;
    }
  }
  // S15.9's fields and D-143's split: absent on older lines, a count or null on newer ones.
  for (const field of ["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"]) {
    if (usage[field] !== undefined && usage[field] !== null && tokenCount(usage[field]) === null) {
      return `usage.${field} is not a whole token count or null`;
    }
  }
  const notPrinted = usage["not_printed"];
  if (
    notPrinted !== undefined &&
    (!Array.isArray(notPrinted) || !notPrinted.every((field) => (USAGE_FIELDS as readonly unknown[]).includes(field)))
  ) {
    return `usage.not_printed is not a list of ${USAGE_FIELDS.join(", ")}`;
  }
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/**
 * Why this line's `cost` and `not_charged` cannot be read back, or undefined (S15.9).
 *
 * A cost is exactly its five fields and its four rates (five on a turn that wrote to the 1-hour cache,
 * D-143), every figure a whole number — the shape the report copies into a signed row — and exactly one of
 * `cost` and `not_charged` says something. A line that claims a cost with a reason not to charge it, or a
 * reason with no cost missing, is not a line anything can bill.
 */
function costProblem(cost: unknown, notCharged: unknown): string | undefined {
  if (notCharged !== undefined && notCharged !== null && !(NOT_CHARGED as readonly unknown[]).includes(notCharged)) {
    return `unknown not_charged ${JSON.stringify(notCharged)}`;
  }
  if (cost === null) {
    return notCharged === null ? "cost is null and not_charged gives no reason" : undefined;
  }
  if (!isRecord(cost) || !sameKeys(cost, ["usd_micros", "table", "table_digest", "source", "usd_micros_per_mtok"])) {
    return "cost is not null or {usd_micros, table, table_digest, source, usd_micros_per_mtok}";
  }
  if (notCharged !== null) return "cost is present, so not_charged must be null";
  if (tokenCount(cost["usd_micros"]) === null) return "cost.usd_micros is not a whole number of micro-dollars";
  if (!isSafeId(cost["table"])) return "cost.table is not a price table version";
  if (typeof cost["table_digest"] !== "string" || !TABLE_DIGEST.test(cost["table_digest"])) return "cost.table_digest is not 16 hex characters";
  if (cost["source"] !== "default" && cost["source"] !== "owner") return `unknown cost.source ${JSON.stringify(cost["source"])}`;
  const rates = cost["usd_micros_per_mtok"];
  // The four, and the 1-hour write rate beside them on a turn that wrote to the 1-hour cache (D-143).
  if (!isRecord(rates) || !(sameKeys(rates, RATE_FIELDS) || sameKeys(rates, ALL_RATE_FIELDS))) {
    return `cost.usd_micros_per_mtok is not {${RATE_FIELDS.join(", ")}} or that and ${RATE_1H}`;
  }
  for (const field of Object.keys(rates)) {
    const rate = rates[field];
    if (rate !== null && (tokenCount(rate) === null || (rate as number) > MAX_RATE)) {
      return `cost.usd_micros_per_mtok.${field} is not a whole number of micro-dollars or null`;
    }
  }
  return undefined;
}

/**
 * Read one line back, validating rather than trusting.
 *
 * A half-written line is an ordinary thing to find here: the process can be
 * killed between the `write` and the `fsync`. So a bad line is a *result*, not
 * an exception — {@link parseLine} says why, and the caller counts them and
 * reports the count rather than pretending the file was clean.
 */
export function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed === "") return { ok: false, reason: "blank line" };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (cause) {
    return { ok: false, reason: `not JSON (${String(cause)})` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "not a JSON object" };
  }

  const value = raw as Record<string, unknown>;
  if (value["v"] !== LEDGER_VERSION) {
    return { ok: false, reason: `unknown schema version ${JSON.stringify(value["v"])}` };
  }
  if (value["kind"] !== "turn") {
    return { ok: false, reason: `unknown kind ${JSON.stringify(value["kind"])}` };
  }
  for (const field of ["id", "turn", "at", "backend"]) {
    if (typeof value[field] !== "string" || value[field] === "") {
      return { ok: false, reason: `${field} is missing or not a non-empty string` };
    }
  }
  if (!isSubjectId(value["subject"])) {
    return { ok: false, reason: `subject ${JSON.stringify(value["subject"])} is not a subject id` };
  }
  if (value["content"] !== "full" && value["content"] !== "withheld") {
    return { ok: false, reason: `unknown content ${JSON.stringify(value["content"])}` };
  }
  if (!CONFIDENCES.has(value["confidence"] as string)) {
    return { ok: false, reason: `unknown confidence ${JSON.stringify(value["confidence"])}` };
  }
  if (!IDENTITIES.has(value["identity"] as string)) {
    return { ok: false, reason: `unknown identity ${JSON.stringify(value["identity"])}` };
  }
  for (const field of ["model", "prompt", "text", "soul_sha"]) {
    if (!isStringOrNull(value[field])) return { ok: false, reason: `${field} is not a string or null` };
  }
  // D-142's field: absent on older lines, a string or null on newer ones.
  if (value["model_requested"] !== undefined && !isStringOrNull(value["model_requested"])) {
    return { ok: false, reason: "model_requested is not a string or null" };
  }
  for (const field of ["exit", "duration_ms"]) {
    if (!isFiniteNumberOrNull(value[field])) {
      return { ok: false, reason: `${field} is not a finite number or null` };
    }
  }
  const costReason = costProblem(value["cost"], value["not_charged"]);
  if (costReason !== undefined) return { ok: false, reason: costReason };
  for (const field of ["prompt_bytes", "text_bytes"]) {
    if (typeof value[field] !== "number" || !Number.isInteger(value[field])) {
      return { ok: false, reason: `${field} is not a whole number` };
    }
  }
  const usageReason = usageProblem(value["usage"]);
  if (usageReason !== undefined) return { ok: false, reason: usageReason };
  // The one cross-field rule: a withheld line must not carry the text it says
  // it withheld. Without this, `content` would be a label instead of a fact.
  if (value["content"] === "withheld" && (value["prompt"] !== null || value["text"] !== null)) {
    return { ok: false, reason: "content is withheld but prompt or text is present" };
  }

  return { ok: true, entry: value as unknown as LedgerEntry };
}
