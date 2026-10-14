/**
 * Types every layer shares.
 *
 * The one rule this file exists to enforce: **anything that touches a
 * subject's data carries that subject's id in its type** (S0.1 AC4, D-003,
 * D-011). Mind wears identities rather than having one, so "which identity
 * is this for?" can never be answered by ambient state — a global, a cwd, a
 * currently-worn variable. If a function reads or writes memory, renders a
 * soul, or runs a turn, the subject is an argument, and the compiler says so.
 *
 * That is also what keeps I-3 (identities never bleed) checkable rather than
 * aspirational: a leak needs a `SubjectId` to have been passed, and every call
 * site that passes one is greppable.
 */

/**
 * A list with something in it, said in the type rather than checked at run time.
 *
 * odd2 found several checkers whose wrong answer was reachable only through an
 * empty list — `every` and `some` over nothing, two sorted lists joined and
 * compared as `"" === ""`, a fallback chain of no backends. Each of those could
 * be closed with an `if (list.length === 0) throw`, and every one of those would
 * be a check somebody can delete as redundant, in a state nothing can reach
 * today, with no test that goes red when they do.
 *
 * So the state is closed at the compiler instead. `DERIVATIONS = []` does not
 * typecheck; neither does `verifySoul(soul, [], …)`. There is nothing to delete
 * as redundant, the failure arrives at `npm run typecheck` rather than in
 * somebody's terminal, and the probes that pin these holes are written with
 * `@ts-expect-error` — which goes red the day the type is widened back.
 *
 * `readonly [T, ...T[]]` rather than a branded array: an array literal with one
 * element satisfies it with no constructor call, so the ordinary way to write
 * one of these lists is also the way that typechecks.
 */
export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * Narrow a list that came from outside — argv, a file, a `filter`.
 *
 * The one place a run-time check belongs: at the edge where a list whose length
 * nothing guaranteed becomes one whose length the type does. `undefined` rather
 * than a throw, so the caller writes what the empty case means — which is
 * usually a documented default (`--backend ,,,` falling back to
 * `PHASE_A_BACKENDS`) and not an error.
 */
export function nonEmpty<T>(items: readonly T[]): NonEmpty<T> | undefined {
  if (items.length === 0) return undefined;
  // `items[0]` is asserted rather than tested: the length is the evidence, and
  // a second test here would be a second answer to the same question. A list of
  // one `undefined` is a list with something in it.
  const [first, ...rest] = items;
  return [first as T, ...rest];
}

/** Map a non-empty list to a non-empty list, keeping the promise through it. */
export function mapNonEmpty<T, U>(items: NonEmpty<T>, fn: (item: T, index: number) => U): NonEmpty<U> {
  const [first, ...rest] = items;
  return [fn(first, 0), ...rest.map((item, index) => fn(item, index + 1))];
}

/**
 * Identity of a subject — the person or role an agent is wearing.
 *
 * Branded so a bare string cannot be mistaken for one. Construct through
 * {@link subjectId} so the shape is validated once, at the edge.
 */
export type SubjectId = string & { readonly __brand: "SubjectId" };

const SUBJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Validate and brand a subject id.
 *
 * Lowercase, dash/underscore, at most 64 chars: it becomes a directory name
 * and a git-safe path segment, so the alphabet is deliberately narrow.
 *
 * @throws {TypeError} when the value could not be a directory name.
 */
export function subjectId(value: string): SubjectId {
  if (!SUBJECT_ID_PATTERN.test(value)) {
    throw new TypeError(
      `invalid subject id ${JSON.stringify(value)}: expected ${SUBJECT_ID_PATTERN}`,
    );
  }
  return value as SubjectId;
}

/** True when `value` is a well-formed subject id, without throwing. */
export function isSubjectId(value: unknown): value is SubjectId {
  return typeof value === "string" && SUBJECT_ID_PATTERN.test(value);
}

/**
 * Data the owner's, carried in a box the type system will not open by itself.
 *
 * ADR 0002 §5 left "the shape of the `personal` flag" to S3.5, and the shape
 * is the whole decision. A brand — `string & { __personal: true }` — was the
 * obvious move and is the wrong one: a branded string is still a `string`, so
 * `backend.run({ prompt: flagged })` would compile, and the flag would be
 * decoration on the one call it exists to stop.
 *
 * So this is a box rather than a brand. `Personal<string>` is not a `string`
 * and cannot be passed anywhere a `string` is wanted; the only way to a value
 * is {@link unwrapPersonal}, which is a word a reviewer can search for and an
 * AST gate refuses outside two named files — `src/exec/local.ts`, which is the
 * door, and the gate's own `test/guard/personal-type.test.ts`. The same gate
 * refuses `as LocalBackend` and `as Personal`, because a cast would turn the
 * check below off in one keystroke with nothing in review to catch the eye.
 *
 * This file is *not* on that list, and the two functions below that read
 * `[CARRIED]` are the reason it does not need to be. {@link unwrapPersonal} is
 * the word the gate permits by name, and {@link countPersonal} is the other way
 * out — a way that cannot carry text at all. See its own comment for what that
 * buys and what it does not.
 *
 * ## What this proves, and what it does not
 *
 * It proves that a `Personal<T>` reaches `ExecBackend.run` only through code
 * that unwrapped it on purpose — `runPersonal` in `src/exec/local.ts` is the
 * one place in the engine that does. It does **not** track the value
 * afterwards: once unwrapped, the string is a string, and no JavaScript type
 * system follows it into a template literal or a `JSON.stringify`. The flag is
 * a gate at one door, not a taint that survives the room.
 */
const CARRIED: unique symbol = Symbol("mind.personal");

/** A value flagged `personal` (D-010, I-6). Opaque: see {@link unwrapPersonal}. */
export interface Personal<T> {
  readonly [CARRIED]: T;
}

/**
 * Put a value in the box.
 *
 * Deliberately unrestricted — flagging *more* data as personal is never the
 * unsafe direction, and a constructor that argued about it would tempt callers
 * into not flagging at all. The restriction is on the way out.
 */
export function flagPersonal<T>(value: T): Personal<T> {
  return Object.freeze({ [CARRIED]: value });
}

/**
 * Take the value back out.
 *
 * Every call is a decision that this particular destination is allowed to see
 * the owner's data, and every call site is greppable by this name on purpose.
 */
export function unwrapPersonal<T>(value: Personal<T>): T {
  return value[CARRIED];
}

/** True when `value` came out of {@link flagPersonal}, without unwrapping it. */
export function isPersonal(value: unknown): value is Personal<unknown> {
  return typeof value === "object" && value !== null && CARRIED in value;
}

// ---------------------------------------------------------------------------
// Counting inside the box
// ---------------------------------------------------------------------------

/**
 * How one part of a tally key is obtained from a string field.
 *
 * Generic operations on a string, and deliberately nothing that knows any
 * schema: `month` is the first seven characters of an ISO-8601 instant (a year
 * and a month), `day` the first ten (a date — S3.4 weighs interest by how
 * recent it is), and `first-word` is everything before the first space. Each
 * exists so that a *coarser* thing than the field can be counted; none can
 * widen what a key may contain, because a key is only ever looked up (see
 * {@link countPersonal}).
 */
export type CountTake = "whole" | "month" | "day" | "first-word";

/** One part of a tally key: a word from the caller's own source, or a field of the item. */
export type CountPart =
  | { readonly literal: string }
  | { readonly field: string; readonly take?: CountTake };

/** The parts of one key, joined with `|`. */
export interface CountKey {
  readonly parts: readonly CountPart[];
}

/** One thing to count per item, and where to count it when the key is not known. */
export interface CountTally {
  readonly key: CountKey;
  /**
   * Where an item whose composed key is *known and not in the vocabulary* is
   * counted.
   *
   * Absent means "not counted at all", which is the right answer for a record
   * the summary is not about. Present means a named bucket — `…|tool|other` —
   * so that a reader can see there were more than the ones named. An item whose
   * key could not be composed at all does not reach it; see {@link countPersonal}.
   */
  readonly otherwise?: CountKey;
}

/**
 * Count what is in the box, and let only the counts out.
 *
 * ## Why this shape, and not a combinator that takes a function
 *
 * The obvious door was `mapPersonal(value, fn)` — compute inside, keep the
 * result boxed — and the owner refused it, for a reason worth keeping next to
 * the code: a combinator that takes a function is a hole with a guard on it.
 * The function decides what comes back, an AST rule can see the call site but
 * not the body, and the closure it is written inside can copy the value to an
 * outer variable without ever saying `unwrapPersonal`. A check that has to be
 * clever is a check somebody will out-clever.
 *
 * So this takes **no function**. The caller supplies two things, both from
 * outside the box:
 *
 * - `tallies` — *data* describing how to compose a key from an item's string
 *   fields: literal words from the caller's own source, plus `field`/`take`
 *   pairs that read one field and may reduce it (`{@link CountTake}`);
 * - `vocabulary` — every key that may appear in the result.
 *
 * The one-sentence proof obligation: **every key in the output came from
 * `vocabulary`, and every value is a count this function did.** A composed key
 * is *looked up* in the vocabulary and never inserted, so no string from inside
 * the box can become a key — not a path, not a project name, not a session id.
 * A `Personal<string[]>` smuggled in yields the vocabulary with zeros, because
 * an item that is not an object has no field to read.
 *
 * ## What this does not prove
 *
 * Nothing here says a count is harmless. An integer is a channel, and whoever
 * writes the tallies chooses what the integers are about — which is a decision
 * in review, not a property of this function. `ACTIONS_LIMITS`
 * (`src/observer/actions.ts`) states that where an owner will read it. What is
 * bounded is the *vocabulary of keys* and the *type of values*, and that is
 * bounded by construction rather than by filtering.
 */
export function countPersonal<K extends string>(
  value: Personal<readonly unknown[]>,
  tallies: readonly CountTally[],
  vocabulary: readonly K[],
): Record<K, number> {
  // Seeded from the vocabulary, so a key that was never seen reports 0 rather
  // than being absent: "nothing happened" and "this release stopped counting
  // it" are different facts, and only one of them is true.
  const counted = new Map<string, number>();
  for (const word of vocabulary) counted.set(word, 0);

  for (const item of value[CARRIED]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const fields = item as Record<string, unknown>;

    for (const tally of tallies) {
      // A key that could not be composed at all means this item is not the shape
      // the tally is about, and it is counted nowhere — not even under
      // `otherwise`, which then keeps its tighter meaning: *the value was read,
      // and it is not one of the named ones*.
      const composed = composeKey(tally.key, fields);
      if (composed === undefined) continue;
      const key = counted.has(composed)
        ? composed
        : tally.otherwise === undefined
          ? undefined
          : composeKey(tally.otherwise, fields);
      if (key === undefined) continue;
      const before = counted.get(key);
      if (before === undefined) continue;
      counted.set(key, before + 1);
    }
  }

  // `fromEntries` rather than assignment into a literal: it creates own
  // properties for every key, so a vocabulary word that collides with something
  // on `Object.prototype` lands as data instead of hitting a setter.
  return Object.fromEntries(counted) as Record<K, number>;
}

/**
 * The key an item would be counted under — a lookup value, never a result.
 *
 * `undefined` when a part names a field the item does not hold as a string. A
 * number where a word was expected means this item is not the shape the tally
 * is about, and inventing `"undefined"` as a key would count it as if it were.
 */
function composeKey(key: CountKey, fields: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const part of key.parts) {
    if ("literal" in part) {
      parts.push(part.literal);
      continue;
    }
    const raw = fields[part.field];
    if (typeof raw !== "string") return undefined;
    parts.push(takePart(raw, part.take ?? "whole"));
  }
  return parts.join("|");
}

/** One field, reduced as the tally asked. */
function takePart(value: string, how: CountTake): string {
  // "2026-09-21T10:00:00.000Z" → "2026-09". A value that is not a timestamp
  // yields its first seven characters, which will not be in any vocabulary.
  if (how === "month") return value.slice(0, 7);
  // "2026-09-21T10:00:00.000Z" → "2026-09-21" (S3.4): still coarser than the
  // instant, and only ever looked up in a vocabulary of dates the caller wrote.
  if (how === "day") return value.slice(0, 10);
  if (how === "first-word") return value.split(" ")[0] ?? "";
  return value;
}

/**
 * How confident Mind is about something it reports.
 *
 * Deliberately four levels rather than a boolean. The failure this whole
 * project exists to catch is the *silent* one — a CLI that exits 0 having
 * done nothing — and a boolean cannot tell "it answered wrongly" apart from
 * "it answered nothing at all". Collapsing these to pass/fail throws away the
 * only signal that distinguishes a broken identity from a broken pipe.
 */
export type Confidence =
  /** Observed working, with evidence attached. */
  | "confirmed"
  /** Evidence is partial or indirect — believe it, but say so. */
  | "partial"
  /** Observed not working, with evidence attached. */
  | "failed"
  /** Nothing came back at all: empty output, or success with no content.
   *  Never report this as a failure of the *content* — it is a failure to
   *  have run. */
  | "silent";

/**
 * Whether a backend's own account of what a turn used could be read.
 *
 * Three states rather than a number-or-null, for the same reason `silent` is
 * kept apart from `failed`: "this backend never prints a count" and "this
 * backend prints a count and this time there was none" need different fixes,
 * and a bare `null` cannot tell them apart. The second is how a vendor changing
 * its output shape looks from in here — quiet, and indistinguishable from a
 * cheap turn unless the format says so.
 */
export type UsageStatus =
  /** Every number this backend is known to print was read. A vendor-printed
   *  `0` is a real zero and belongs here, not in `missing`. */
  | "reported"
  /** The backend has a channel Mind knows about, and at least one number was
   *  not in it — a turn that died before the summary, or a shape that moved. */
  | "missing"
  /** Nobody reported. This backend has no channel Mind knows of, which is a
   *  statement about Mind's survey and not about the backend. */
  | "unreported";

/**
 * A count a backend may print about a turn — the four that are priced apart (D-110), and the two a cache
 * write splits into where the vendor prices a 5-minute and a 1-hour write differently (D-143).
 */
export type UsageField = "input" | "output" | "cache_read" | "cache_write" | "cache_write_5m" | "cache_write_1h";

/** The six, in the order a reader meets them. */
export const USAGE_FIELDS: readonly UsageField[] = ["input", "output", "cache_read", "cache_write", "cache_write_5m", "cache_write_1h"];

/** The two parts of a cache write (D-143) — what a backend that never splits its writes lists in `not_printed`. */
export const CACHE_WRITE_SPLIT: readonly UsageField[] = ["cache_write_5m", "cache_write_1h"];

/**
 * What one turn used, in tokens the backend itself printed.
 *
 * Tokens, never the vendor's money. A vendor's own `total_cost_usd` is an API
 * list price that a subscription holder never pays (measured 2026-09-21: a
 * two-character answer was quoted at $0.81, all of it cache), and a local
 * model's `0` would be a claim that electricity and a GPU-hour are free — so no
 * figure a vendor prints in a currency is read, here or anywhere (D-023). What
 * a turn *costs* is Mind's own arithmetic over these counts and a price table
 * the ledger line names (S15.9, D-110, D-139): the counts are the measurement,
 * the table is the claim, and the line keeps them apart.
 *
 * Every number here was *read*, never derived. `total` is set only where the
 * vendor printed a total of its own; Mind does not add `input` to `output`,
 * because two vendors' tokenizers do not count the same thing.
 *
 * The cache counts are **parts of `input`**, not additions to it — `input`
 * stays the whole prompt side (D-023 §4), so a reader written before S15.9
 * still reads the same number. What is priced as plain input is what is left:
 * `input − cache_read − cache_write`, which for the vendors that split them is
 * exactly the field they print first (claude's and grok's `input_tokens`).
 */
export interface Usage {
  readonly status: UsageStatus;
  /**
   * Prompt-side tokens, as the backend counts them.
   *
   * Where a vendor splits this across several fields — fresh input, cache
   * writes, cache reads — it is their sum, and it is `null` unless *every*
   * part was found. A partial sum is worse than no number: claude's
   * `input_tokens` alone reported 2 for a turn that sent about 81,000.
   */
  readonly input: number | null;
  /** Completion-side tokens, as the backend counts them. */
  readonly output: number | null;
  /** A total the backend printed itself. Never Mind's arithmetic. */
  readonly total: number | null;
  /**
   * Of `input`, the tokens the vendor served from its prompt cache (S15.9).
   *
   * **Optional on read** for the reason `LedgerEntry.usage` is: lines written
   * before S15.9 do not carry it and must still parse. Every usage written
   * since carries both cache counts, as a number or as `null` — and a `null`
   * says why in {@link not_printed} or in `status`, never by being a 0.
   */
  readonly cache_read?: number | null;
  /** Of `input`, the tokens the vendor wrote into its prompt cache (S15.9). */
  readonly cache_write?: number | null;
  /**
   * Of `cache_write`, the tokens written to the vendor's 5-minute cache and to its 1-hour cache (D-143) —
   * Anthropic prices the two at 1.25× and 2× input, so a write priced as one part is priced wrong whenever
   * the 1-hour cache was written.
   *
   * **Optional on read**, like the cache counts: lines written before D-143 do not carry them. Every usage
   * written since carries both, as numbers or as `null`, and never one without the other. Numbers only when
   * the backend printed both and they add up to `cache_write` exactly — a split that does not add up is a
   * shape that moved, and is kept as unknown rather than as a wrong number. A `null` says why: listed in
   * {@link not_printed} (a backend that never splits its writes — grok, ollama, codex), or not listed, which
   * is a backend that prints the split and did not this turn. The second is not a missing count — `status`
   * does not change for it — but a turn that wrote to the cache with its split unknown is not charged
   * (`usage-unsplit`), because which rate applies is exactly what is not known.
   */
  readonly cache_write_5m?: number | null;
  readonly cache_write_1h?: number | null;
  /**
   * The counts this backend never prints, as surveyed — so their `null` is a
   * fact about the backend and not about this turn (S15.9).
   *
   * The reason a null count carries. A count that *is* printed and was not
   * there this time is `missing` in `status`; a count in this list is null on
   * every turn the backend runs, and the status can still be `reported`. Absent
   * when nobody has surveyed the backend (`unreported`): then nothing is known
   * about what it prints, which is not the same as knowing it prints nothing.
   */
  readonly not_printed?: readonly UsageField[];
}

/** The usage of a backend Mind has not surveyed. Every count null; the status says why. */
export const UNREPORTED_USAGE: Usage = Object.freeze({
  status: "unreported",
  input: null,
  output: null,
  total: null,
  cache_read: null,
  cache_write: null,
  cache_write_5m: null,
  cache_write_1h: null,
});

/**
 * A token count, or null when the value is not one.
 *
 * Narrow on purpose, and shared by the exec layer that reads vendors and the
 * ledger layer that reads lines back, so both refuse the same things. A string
 * `"123"` is not a count: a vendor that starts quoting its numbers has changed
 * shape, and the honest report of that is `missing` rather than a number Mind
 * coerced into existence. Negative and fractional are refused for the same
 * reason — neither is a thing a tokenizer can produce.
 */
export function tokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** A unit of evidence a human can check without trusting Mind. */
export interface Evidence {
  /** What produced this, e.g. a backend id. */
  readonly source: string;
  /** Exactly what was asked, verbatim. */
  readonly prompt?: string;
  /** Exactly what came back, verbatim and untruncated where possible. */
  readonly raw: string;
  /** Wall-clock duration of the observation, in milliseconds. */
  readonly durationMs?: number;
  /** Process exit code, when the observation was a subprocess. */
  readonly exitCode?: number;
  /**
   * What the turn used, when the backend said so.
   *
   * Optional because not every producer of an `Evidence` ran a turn — a
   * fallback chain that reached no backend at all has nothing to report and
   * says nothing rather than reporting zeros.
   */
  readonly usage?: Usage;
  /**
   * What a vendor CLI was asked to run and what it says it ran (D-142).
   *
   * Set by `CliExec` on every result, and by nothing else: ollama and the
   * local CLIs run the model Mind hands them by construction, so their
   * ledger line names that model without asking. Absent means "this backend
   * does not answer the question", never "the default".
   */
  readonly model?: TurnModel;
}

/**
 * The model of one vendor CLI turn, split into the two facts the ledger keeps
 * apart (D-142): the name Mind put on the command line, and the names the
 * CLI's own output says it ran.
 *
 * They are different claims. `opus` on the command line is an alias the vendor
 * resolves; `claude-opus-5-5` in its output is what it resolved to. Only the
 * second is the model the turn ran on, and only a name of that kind may price
 * the turn — except a requested name that exactly names a price-table entry,
 * and then only when the output named nothing at all (`src/pricing/cost.ts`).
 */
export interface TurnModel {
  /** The model Mind passed on the CLI's command line, or null when it named none (the vendor's own default). */
  readonly requested: string | null;
  /**
   * Every model the output names, in the order printed: the vendor's canonical
   * name where it gives one, else the id it called. `null` stands for a name
   * that is not a model name's shape — kept as a slot, so a turn that named two
   * models is never read as one. Empty when the output names none: a vendor
   * nobody measured, or a turn that ended before its summary.
   */
  readonly reported: readonly (string | null)[];
}
