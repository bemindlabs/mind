/**
 * A usage report: what the agent's turns used, one row per model delivery, ready to sign (S15.4 minimum,
 * S15.8, D-106, D-110) — and the checks a report must pass when it is read back.
 *
 * Built from the ledger and from nothing else, and built by **copying named fields into a new object** —
 * never by deleting fields from a ledger line. A line holds the prompt and the answer verbatim (`prompt`,
 * `text`) and their sizes; a report that started from the line and removed what should not go would send
 * whatever field the ledger grows next. So the row below lists what goes, and a field the ledger adds later
 * goes nowhere until somebody adds it here — `test/identity/report.test.ts` holds the row to exactly these
 * names and plants a canary in every text field of the line.
 *
 * What a row carries: the line's and the turn's ids (random UUIDs, so a reader can see a row counted twice),
 * when it started and how long it took, which backend and model received it, the tokens the backend printed —
 * input, output, and the cache reads and writes inside that input — and what the turn cost (S15.9). What it
 * never carries: the prompt, the answer, their byte sizes, the soul, anything recalled from memory, the
 * subject id, any path.
 *
 * ## The schema, version 2 (S15.9, D-139)
 *
 * `{kind, v: 2, generated_at, since, until, binding, rows}`, where `kind` is {@link USAGE_REPORT_KIND}, and each row exactly:
 *
 * | field | value |
 * |---|---|
 * | `id`, `turn` | the ledger line's id and its turn's id |
 * | `at` | ISO-8601 UTC instant the prompt left |
 * | `duration_ms` | whole milliseconds, or null |
 * | `backend`, `model` | a plain backend id; a model's name, or null — the backend's own default, unnamed |
 * | `input_tokens` | the whole prompt side, cache included, or null |
 * | `output_tokens` | or null |
 * | `cache_read_tokens`, `cache_write_tokens` | the parts of `input_tokens` read from and written to the vendor's cache, or null |
 * | `cache_write_1h_tokens` | **only on a row whose turn wrote to the 1-hour cache** (D-143): the part of `cache_write_tokens` that went there, 1 or more |
 * | `usage` | `reported`, `missing`, `unreported` or `not-recorded` — see below |
 * | `cost` | null, or `{usd_micros, table, table_digest, source, usd_micros_per_mtok}` |
 * | `not_charged` | null when `cost` is not; otherwise why it is (`src/pricing/cost.ts`) |
 *
 * **Money is integers of a named unit.** `usd_micros` is US micro-dollars — 1 is $0.000001 — and every rate
 * in `usd_micros_per_mtok` (`input`, `output`, `cache_read`, `cache_write`, each a whole number or null) is
 * micro-dollars per million tokens. Integers because the canonical JSON the report is signed over allows no
 * fractions (D-138). `table` is the version of the price table the rates came from and `source` is
 * `default` (shipped in Mind) or `owner` (the agent's owner's own file). A charged row that has
 * `cache_write_1h_tokens` has a fifth rate, `cache_write_1h`, and no other row has it (D-143).
 *
 * **Every cost can be re-checked from its own row**, and `usage verify` does: with `uncached = input_tokens −
 * cache_read_tokens − cache_write_tokens` (a null cache count is a part the backend never prints, and counts
 * as nothing) and `write1h = cache_write_1h_tokens` (0 when the row has none), `usd_micros = (uncached × input
 * + cache_read_tokens × cache_read + (cache_write_tokens − write1h) × cache_write + write1h × cache_write_1h
 * + output_tokens × output + 500000) // 1000000`. A row whose cost is not that number is refused, however it
 * is signed. A charged row's `usage` is `reported` and its input and output are counts; a part above zero
 * has a rate.
 *
 * **Why the 1-hour fields are there only when used (D-143).** v2 had not been released when they were added,
 * but a market (platform migration 0006) already reads v2 rows with exactly the fields above, and refuses a
 * row with one more. With `write1h` 0 the formula is the one before D-143 term for term, so a row with no
 * 1-hour write carries nothing new and every such report stays one that market takes; a row with one is new
 * money arithmetic, and a market that cannot do it must refuse it rather than recompute it wrong. One
 * spelling each way: a row never carries `cache_write_1h_tokens: 0`, and a cost never carries the 1-hour rate
 * it did not apply.
 *
 * **No totals are signed.** A total is the sum of the rows' `usd_micros` and counts, and `usage report` and
 * `usage verify` print it from the rows; a signed total beside them could only ever disagree with them.
 *
 * ## Where the report is going: `binding` (S15.4 step one, D-141 §2)
 *
 * `binding` is null, or exactly `{market, listing, job}`: the market's origin (`scheme://host[:port]`, the
 * rule in `shapes.ts`), the listing's slug on it, and the job's id there or null. It is signed with the rows,
 * so a report made for one listing cannot be counted at another, nor at another market (platform PR #6
 * review, M3) — the platform takes a report only when `binding` names its own origin and that listing. A
 * report with `binding: null` is for its own machine: `usage report` without `--market` and `--listing`
 * makes one, and a market refuses it. The field is always there, null or not, so no reader can mistake an
 * unbound report for an older shape. `usage verify --market --listing` holds a report to both; without
 * them it prints the binding and says it was not checked.
 *
 * v2 had not been released when `binding` was added, so it is still v2 and a v2 report without it is refused.
 *
 * ## Only model turns
 *
 * The ledger also records messages — A2A (`a2a:in:<peer>`) and chat (`chat:<platform>:<direction>:<user>`) —
 * and those backends name a peer or a person. A row is a model turn only if its backend is a plain id (`claude`,
 * `ollama`, `claude-local`); anything with a `:` or any other shape is left out and counted, so a new kind of
 * line is kept out until someone decides it belongs rather than let in until someone notices.
 *
 * ## Unknown is null, never zero
 *
 * Every count is exactly what the ledger holds: a number the backend printed, or null. A line written before
 * usage was recorded has no `usage` at all and its row says `usage: "not-recorded"`; a backend nobody has
 * surveyed says `unreported`; one whose count went missing says `missing`. Under `reported`, a null count is
 * one the backend never prints (ollama prints no cache counts; codex prints one total and no parts). None of
 * them is 0, because 0 is a count — and D-110 bills a turn without a count at nothing, which only works if a
 * missing count is visibly missing. The same goes for money: a turn that cannot be priced has `cost: null`
 * and a reason, never a cost of 0 and never an estimate; a line from before S15.9 says `not-recorded`.
 *
 * ## Every string has a shape (S15.8 security review, M2 and the info items)
 *
 * A report is printed on somebody's terminal — the owner's, and a verifier's — so no string in it may carry a
 * control character, an escape sequence or a bidi override. Each field has a shape, the producer writes only
 * rows that have it, and a reader refuses a report with any string outside it:
 *
 * - `id`, `turn`, `cost.table` — letters, digits and `._:-`, up to 128. A ledger line whose ids are not
 *   (hand-edited, or written by something else) is left out and counted, never cleaned up into a row — and so
 *   is one whose cost does not follow from its own counts and rates.
 * - `at`, `generated_at`, `since`, `until` — an ISO-8601 UTC instant (`YYYY-MM-DDTHH:MM:SS[.fff]Z`), or null
 *   for an open end. The producer writes `at` through `toISOString`.
 * - `backend` — a plain id, the rule above.
 * - `model` — the name the row's price was looked up by: the model the backend ran, or, on a row charged while a
 *   vendor CLI named no model, the name Mind asked for, which a price table listed exactly (D-142). A row that
 *   is not charged never names a model the backend was only asked for.
 *   A model's *name*: `name` or `org/name`, each part letters, digits and `._:@+-` starting with a
 *   letter or digit, up to 128. `--model` can be a path to a local weights file; a value with more than one
 *   `/`, a leading `/`, `.` or `~`, a space or anything else a name does not have is sent as **null**, and the
 *   report says how many rows that happened to. The choice is to refuse rather than to take a basename,
 *   because the last part of a path is still a name somebody chose, and a report is not the place to guess
 *   which names are private.
 * - `duration_ms` — a whole number of milliseconds or null. The ledger allows any finite number there; a
 *   fraction is rounded, and a negative or unsafe one is null, rather than crashing the signer.
 *
 * {@link printable} escapes anything outside printable text before it is shown, whether or not it passed.
 */

import type { LedgerEntry, LedgerEnv, QueryRange } from "../ledger/index.ts";
import { query } from "../ledger/store.ts";
import { costOf, knownOneHourWrite, NOT_CHARGED, type NotCharged, type TurnCost } from "../pricing/cost.ts";
import {
  ALL_RATE_FIELDS,
  copyRates,
  MAX_RATE,
  RATE_1H,
  rate1h,
  RATE_FIELDS,
  shippedByDigest,
  shippedTable,
  TABLE_DIGEST,
  type Rates,
  type TableOrigin,
} from "../pricing/table.ts";
import type { SubjectId } from "../types.ts";
import { isIsoInstant, isJobId, isListingSlug, isModelBackend, isModelName, isSafeId, marketOriginProblem } from "./shapes.ts";
import { checkEnvelope, publicKeyProblem, verifyEnvelope, type SignedEnvelope } from "./sign.ts";
import { parseJsonStrict } from "./strict-json.ts";

export { isIsoInstant, isModelBackend, isModelName, printable } from "./shapes.ts";

/** The `kind` of the signed payload. */
export const USAGE_REPORT_KIND = "mind.usage-report";
/** 2 since S15.9: rows gained the cache counts, `cost` and `not_charged`. Version 1 was never released. */
export const USAGE_REPORT_VERSION = 2;

export type RowUsage = "reported" | "missing" | "unreported" | "not-recorded";
const ROW_USAGES = new Set<string>(["reported", "missing", "unreported", "not-recorded"]);

/** One model delivery. Every field is named here, and nothing else goes. */
export interface UsageRow {
  readonly id: string;
  readonly turn: string;
  readonly at: string;
  readonly duration_ms: number | null;
  readonly backend: string;
  readonly model: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  /** Of `cache_write_tokens`, what went to the 1-hour cache — present only when that is 1 or more (D-143). */
  readonly cache_write_1h_tokens?: number;
  readonly usage: RowUsage;
  readonly cost: TurnCost | null;
  readonly not_charged: NotCharged | null;
}

/**
 * The fields every row has, in the order a reader meets them — what the test holds a row to. One more,
 * {@link ROW_1H_FIELD}, only on a row whose turn wrote to the 1-hour cache (D-143).
 */
export const USAGE_ROW_FIELDS: readonly (keyof UsageRow)[] = [
  "id",
  "turn",
  "at",
  "duration_ms",
  "backend",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "usage",
  "cost",
  "not_charged",
];

/** The row field a turn that wrote to the 1-hour cache adds, after `cache_write_tokens` (D-143). */
export const ROW_1H_FIELD = "cache_write_1h_tokens";

/** The fields of a row's `cost`. */
const COST_FIELDS = ["usd_micros", "table", "table_digest", "source", "usd_micros_per_mtok"];

const PAYLOAD_FIELDS = ["binding", "generated_at", "kind", "rows", "since", "until", "v"];

/** The market, listing and job a report is for (D-141 §2). Signed with the rows. */
export interface ReportBinding {
  /** The market's origin, `scheme://host[:port]`. */
  readonly market: string;
  /** The listing's slug on that market. */
  readonly listing: string;
  /** The job's id on that market, or null when the report is for no one job. */
  readonly job: string | null;
}

const BINDING_FIELDS = ["job", "listing", "market"];

/** What `usage verify --market --listing` holds a report's binding to. */
export interface BindingPins {
  readonly market: string;
  readonly listing: string;
}

export interface UsageReportPayload {
  readonly kind: string;
  readonly v: typeof USAGE_REPORT_VERSION;
  readonly generated_at: string;
  /** The window asked for, or null for an open end. */
  readonly since: string | null;
  readonly until: string | null;
  /** Where the report is going, or null: for this machine, and refused by a market. */
  readonly binding: ReportBinding | null;
  readonly rows: readonly UsageRow[];
  readonly [name: string]: unknown;
}

/** What the report left out or changed — for the person running it, not part of what is signed. */
export interface ReportFacts {
  /** Ledger lines that are messages (A2A, chat) or otherwise not a model turn. */
  readonly notModel: number;
  /** Model turns whose ids have no row's shape — left out rather than cleaned up. */
  readonly unshapely: number;
  /**
   * Model turns whose cost does not check — against its own counts and rates, or against the shipped table
   * it names — left out rather than signed (PR #3 review, R5), with the first few reasons.
   */
  readonly costRefused: number;
  readonly costReasons: readonly string[];
  /** Charged turns that claim two prices from one table (one digest), left out: which one is true is unknown. */
  readonly conflicting: number;
  /** Rows whose model value was not a model's name, sent as null. */
  readonly modelWithheld: number;
  readonly unreadable: number;
  readonly foreign: number;
}

function wholeMs(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

/** A line's cost as a row's: each field named, the rates too — never the line's object handed on. */
function rowCost(cost: TurnCost): TurnCost {
  return {
    usd_micros: cost.usd_micros,
    table: cost.table,
    table_digest: cost.table_digest,
    source: cost.source,
    usd_micros_per_mtok: copyRates(cost.usd_micros_per_mtok),
  };
}

/** A line as a row, or why it is not one: its shape, or its cost (and then the reason, for the person). */
type RowFor = { readonly row: UsageRow } | { readonly dropped: "shape" } | { readonly dropped: "cost"; readonly why: string };

/**
 * One ledger line as a row — by naming each field, never by removing some — or undefined when its ids have no
 * row's shape, or its cost is one {@link rowProblem} would refuse. A model value that is not a model's name
 * becomes null; a charged line whose model is not one is left out, since its price was looked up by that name.
 */
export function usageRow(entry: LedgerEntry): UsageRow | undefined {
  const made = rowFor(entry);
  return "row" in made ? made.row : undefined;
}

/**
 * The model a line's row names (D-142): the model it ran on, or — on a line charged while its vendor CLI named no
 * model — the requested name, which a price table listed exactly and priced it by. A charged row must name the
 * model its rates belong to, or no reader can check them; an uncharged line's request is not a model it ran.
 */
function rowModel(entry: LedgerEntry): string | null {
  return entry.model ?? (entry.cost === null ? null : (entry.model_requested ?? null));
}

function rowFor(entry: LedgerEntry): RowFor {
  if (!isSafeId(entry.id) || !isSafeId(entry.turn) || !isModelBackend(entry.backend)) return { dropped: "shape" };
  const at = Date.parse(entry.at);
  if (Number.isNaN(at)) return { dropped: "shape" };
  const usage = entry.usage;
  const named = rowModel(entry);
  const model = named !== null && isModelName(named) ? named : null;
  const cost = entry.cost === null ? null : rowCost(entry.cost);
  // D-143: there only when the turn wrote to the 1-hour cache, so every other row keeps its old shape.
  const oneHour = knownOneHourWrite(usage);
  const row: UsageRow = {
    id: entry.id,
    turn: entry.turn,
    at: new Date(at).toISOString(),
    duration_ms: wholeMs(entry.duration_ms),
    backend: entry.backend,
    model,
    input_tokens: usage?.input ?? null,
    output_tokens: usage?.output ?? null,
    cache_read_tokens: usage?.cache_read ?? null,
    cache_write_tokens: usage?.cache_write ?? null,
    ...(oneHour !== null && oneHour > 0 ? { cache_write_1h_tokens: oneHour } : {}),
    usage: usage?.status ?? "not-recorded",
    cost,
    // A line from before S15.9 has neither a cost nor a reason: it was never priced, and is not priced now.
    not_charged: cost === null ? (entry.not_charged ?? "not-recorded") : null,
  };
  const verdict = rowVerdict(row, `line ${entry.id}`);
  if (verdict === undefined) return { row };
  return verdict.kind === "cost" ? { dropped: "cost", why: verdict.why } : { dropped: "shape" };
}

/**
 * The payload for these lines. Pure: the caller gives the clock, the window and where the report is going.
 *
 * @throws {Error} when `binding` is not one {@link bindingProblem} passes — the command checks it first, so
 *   this is a bug in the caller, never a report signed with a binding no reader would accept.
 */
export function usagePayload(
  entries: readonly LedgerEntry[],
  range: QueryRange,
  now: Date,
  binding: ReportBinding | null = null,
): { readonly payload: UsageReportPayload; readonly facts: Omit<ReportFacts, "unreadable" | "foreign"> } {
  const bindingBad = bindingProblem(binding);
  if (bindingBad !== undefined) throw new Error(`a report cannot be bound so: ${bindingBad}`);
  const model = entries.filter((entry) => isModelBackend(entry.backend));
  const made: UsageRow[] = [];
  let modelWithheld = 0;
  let unshapely = 0;
  const costReasons: string[] = [];
  let costRefused = 0;
  for (const entry of model) {
    const result = rowFor(entry);
    if ("dropped" in result) {
      if (result.dropped === "shape") unshapely++;
      else {
        costRefused++;
        if (costReasons.length < 3) costReasons.push(result.why);
      }
      continue;
    }
    if (rowModel(entry) !== null && result.row.model === null) modelWithheld++;
    made.push(result.row);
  }
  // Rows that claim two prices from one table: neither is signed, since which one is true is not knowable here.
  const { rows: conflicted } = conflicts(made);
  const rows = made.filter((_, index) => !conflicted.has(index));
  return {
    payload: {
      kind: USAGE_REPORT_KIND,
      v: USAGE_REPORT_VERSION,
      generated_at: now.toISOString(),
      since: range.since?.toISOString() ?? null,
      until: range.until?.toISOString() ?? null,
      // Copied by name, like a row: never the caller's object handed on.
      binding: binding === null ? null : { market: binding.market, listing: binding.listing, job: binding.job },
      rows,
    },
    facts: {
      notModel: entries.length - model.length,
      unshapely,
      costRefused,
      costReasons,
      conflicting: conflicted.size,
      modelWithheld,
    },
  };
}

/**
 * Charged rows no single price table could have priced (PR #3 review, R3). A digest is one table's content, so
 * under one digest there is one version and one source, and one set of rates per backend and model. Rows that
 * disagree on any of those are named — every row of the disagreeing claim — with the first disagreement said.
 */
function conflicts(rows: readonly UsageRow[]): { readonly rows: ReadonlySet<number>; readonly why?: string } {
  const labels = new Map<string, Set<string>>();
  const prices = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) => map.set(key, (map.get(key) ?? new Set()).add(value));
  // The 1-hour rate apart (D-143): only the rows that wrote to that cache carry it, so a row without it says
  // nothing about it — but two rows of one claim that do carry it must agree.
  const oneHourPrices = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.cost === null) continue;
    add(labels, row.cost.table_digest, JSON.stringify([row.cost.table, row.cost.source]));
    const rates = row.cost.usd_micros_per_mtok;
    const claim = JSON.stringify([row.cost.table_digest, row.backend, row.model]);
    add(prices, claim, JSON.stringify(RATE_FIELDS.map((f) => rates[f])));
    if (RATE_1H in rates) add(oneHourPrices, claim, JSON.stringify(rate1h(rates)));
  }
  const badDigests = [...labels].filter(([, seen]) => seen.size > 1).map(([digest]) => digest);
  const badClaims = [...new Set([...prices, ...oneHourPrices].filter(([, seen]) => seen.size > 1).map(([claim]) => claim))];
  const hit = new Set<number>();
  for (const [index, row] of rows.entries()) {
    if (row.cost === null) continue;
    const claim = JSON.stringify([row.cost.table_digest, row.backend, row.model]);
    if (badDigests.includes(row.cost.table_digest) || badClaims.includes(claim)) hit.add(index);
  }
  if (badDigests.length > 0) {
    return { rows: hit, why: `rows name the price table with digest ${badDigests[0]} by more than one version or source — one table has one of each` };
  }
  if (badClaims.length > 0) {
    const [digest, backend, model] = JSON.parse(badClaims[0]!) as [string, string, string];
    return { rows: hit, why: `rows price ${backend} · ${model} from the table with digest ${digest} at two different sets of rates — one table has one price per model` };
  }
  return { rows: hit };
}

/** Read this subject's ledger over the window and make the payload. Writes nothing. */
export async function buildUsageReport(
  env: LedgerEnv,
  subject: SubjectId,
  range: QueryRange,
  binding: ReportBinding | null = null,
): Promise<{ readonly payload: UsageReportPayload; readonly facts: ReportFacts }> {
  const read = await query(env, subject, range);
  const { payload, facts } = usagePayload(read.entries, range, env.now(), binding);
  return { payload, facts: { ...facts, unreadable: read.unreadable, foreign: read.foreign } };
}

/**
 * Sums of what exists, and how many rows had none — so a total is never read as complete. Money is summed
 * over the charged rows only; a row that is not charged adds nothing, and is counted by its reason.
 *
 * Every sum is a BigInt (PR #3 review): each row is a safe integer, and a sum of them need not be, so a total
 * is exact however many rows there are, and printed as the digits it is.
 */
export interface UsageTotals {
  readonly rows: number;
  readonly input: bigint;
  readonly output: bigint;
  readonly cacheRead: bigint;
  readonly cacheWrite: bigint;
  /** Of {@link cacheWrite}, what rows say went to the 1-hour cache (D-143). */
  readonly cacheWrite1h: bigint;
  readonly withoutInput: number;
  readonly withoutOutput: number;
  /** Backends with at least one row lacking a count, for the sentence that says so. */
  readonly unknownFrom: readonly string[];
  /** US micro-dollars over the charged rows. */
  readonly usdMicros: bigint;
  /**
   * The part of {@link usdMicros} whose rates are a shipped table's, checked (PR #3 review, R4). The rest —
   * rates the owner set, or a shipped version this build does not carry — is the agent's word.
   */
  readonly usdMicrosChecked: bigint;
  readonly charged: number;
  /** Rows not charged, per reason, in {@link NOT_CHARGED}'s order. */
  readonly notCharged: readonly (readonly [NotCharged, number])[];
}

export function usageTotals(rows: readonly UsageRow[]): UsageTotals {
  let input = 0n;
  let output = 0n;
  let cacheRead = 0n;
  let cacheWrite = 0n;
  let cacheWrite1h = 0n;
  let withoutInput = 0;
  let withoutOutput = 0;
  let usdMicros = 0n;
  let usdMicrosChecked = 0n;
  let charged = 0;
  const unknownFrom = new Set<string>();
  const why = new Map<NotCharged, number>();
  for (const row of rows) {
    if (row.input_tokens === null) withoutInput++;
    else input += BigInt(row.input_tokens);
    if (row.output_tokens === null) withoutOutput++;
    else output += BigInt(row.output_tokens);
    cacheRead += BigInt(row.cache_read_tokens ?? 0);
    cacheWrite += BigInt(row.cache_write_tokens ?? 0);
    cacheWrite1h += BigInt(row.cache_write_1h_tokens ?? 0);
    if (row.input_tokens === null || row.output_tokens === null) unknownFrom.add(row.backend);
    if (row.cost !== null) {
      usdMicros += BigInt(row.cost.usd_micros);
      if (rateCheck(row.cost) === "shipped") usdMicrosChecked += BigInt(row.cost.usd_micros);
      charged++;
    } else if (row.not_charged !== null) {
      why.set(row.not_charged, (why.get(row.not_charged) ?? 0) + 1);
    }
  }
  return {
    rows: rows.length,
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    withoutInput,
    withoutOutput,
    unknownFrom: [...unknownFrom].sort(),
    usdMicros,
    usdMicrosChecked,
    charged,
    notCharged: NOT_CHARGED.filter((reason) => why.has(reason)).map((reason) => [reason, why.get(reason)!] as const),
  };
}

/**
 * How far a group of charged rows' rates can be checked by whoever reads the report (PR #3 review, M2).
 *
 * - `shipped` — the rows say `default` and name a table version this build carries, and their rates and
 *   digest are that table's for that backend and model. A row that says so and is not is refused outright,
 *   so a group in a report that passed is always this.
 * - `unknown-default` — the rows say `default` and name a version this build does not carry: the rates are
 *   the agent's claim about a table the reader cannot see from here.
 * - `owner` — the agent's owner set the rates. Nothing outside the owner's machine can confirm them; the
 *   digest says only that every row in the group was priced from the same content.
 */
export type RateCheck = "shipped" | "unknown-default" | "owner";

/** Which of the three a cost is. Only meaningful for a row that passed {@link reportProblem}. */
export function rateCheck(cost: TurnCost): RateCheck {
  if (cost.source === "owner") return "owner";
  return shippedTable(cost.table) === undefined ? "unknown-default" : "shipped";
}

/** Charged rows that share a price: one source, table, digest, backend, model and set of rates. */
export interface CostGroup {
  readonly source: TableOrigin;
  readonly table: string;
  readonly table_digest: string;
  readonly backend: string;
  readonly model: string;
  readonly rates: Rates;
  readonly rows: number;
  readonly usdMicros: bigint;
  readonly check: RateCheck;
}

/**
 * The charged rows grouped by what they claim — so a hirer reads "12 rows of claude-opus-5 at the shipped
 * 2026-09-28 rates" or "40 rows at rates the owner set", with the rates shown, rather than one sum that
 * hides which kind of claim it is made of. Sorted by source, table, backend, model.
 */
export function costGroups(rows: readonly UsageRow[]): readonly CostGroup[] {
  const groups = new Map<string, { -readonly [K in keyof CostGroup]: CostGroup[K] }>();
  for (const row of rows) {
    const cost = row.cost;
    if (cost === null || row.model === null) continue;
    const rates = cost.usd_micros_per_mtok;
    const key = JSON.stringify([cost.source, cost.table, cost.table_digest, row.backend, row.model, RATE_FIELDS.map((f) => rates[f])]);
    const found = groups.get(key);
    if (found !== undefined) {
      found.rows++;
      found.usdMicros += BigInt(cost.usd_micros);
      // The 1-hour rate is carried only by the rows that applied it (D-143); the group shows it once one did.
      if (RATE_1H in rates && !(RATE_1H in found.rates)) found.rates = copyRates(rates);
      continue;
    }
    groups.set(key, {
      source: cost.source,
      table: cost.table,
      table_digest: cost.table_digest,
      backend: row.backend,
      model: row.model,
      rates: copyRates(rates),
      rows: 1,
      usdMicros: BigInt(cost.usd_micros),
      check: rateCheck(cost),
    });
  }
  const order = (g: CostGroup) => [g.source, g.table, g.backend, g.model, g.table_digest].join("\u0000");
  return [...groups.values()].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

function countOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

const sameFields = (value: object, fields: readonly string[]) => Object.keys(value).sort().join(",") === [...fields].sort().join(",");

/** Why a charged row's cost is not one, or undefined — its shape, and that it follows from the row's own counts. */
function costProblem(r: Record<string, unknown>, at: string): string | undefined {
  const cost = r["cost"];
  if (typeof cost !== "object" || cost === null || Array.isArray(cost) || !sameFields(cost, COST_FIELDS)) {
    return `${at}.cost is not null or exactly {${COST_FIELDS.join(", ")}}`;
  }
  const c = cost as Record<string, unknown>;
  if (r["not_charged"] !== null) return `${at} has a cost and a reason it is not charged`;
  if (!countOrNull(c["usd_micros"]) || c["usd_micros"] === null) return `${at}.cost.usd_micros is not a whole number of micro-dollars`;
  if (!isSafeId(c["table"])) return `${at}.cost.table is not a price table version`;
  if (typeof c["table_digest"] !== "string" || !TABLE_DIGEST.test(c["table_digest"])) return `${at}.cost.table_digest is not 16 hex characters`;
  if (c["source"] !== "default" && c["source"] !== "owner") return `${at}.cost.source is not default or owner`;
  const rates = c["usd_micros_per_mtok"];
  // The four rates — and the 1-hour write rate exactly when the row has 1-hour write tokens (D-143): one
  // spelling each way, so a row without them keeps the shape a market from before D-143 reads.
  const oneHour = ROW_1H_FIELD in r;
  const fields = oneHour ? ALL_RATE_FIELDS : RATE_FIELDS;
  if (typeof rates !== "object" || rates === null || Array.isArray(rates) || !sameFields(rates, fields)) {
    return `${at}.cost.usd_micros_per_mtok is not exactly {${fields.join(", ")}}` +
      (oneHour ? ` — the row wrote to the 1-hour cache` : ` — ${RATE_1H} is there only on a row with ${ROW_1H_FIELD}`);
  }
  for (const field of fields) {
    const rate = (rates as Record<string, unknown>)[field];
    if (!countOrNull(rate) || (rate as number) > MAX_RATE) return `${at}.cost.usd_micros_per_mtok.${field} is not a whole number of micro-dollars or null`;
  }
  // The re-check: a charged row is one whose counts were all there, and whose cost is what they come to.
  if (r["usage"] !== "reported" || r["input_tokens"] === null || r["output_tokens"] === null || r["model"] === null) {
    return `${at} is charged without reported input and output counts and a model`;
  }
  const expected = costOf(
    {
      input: r["input_tokens"] as number,
      output: r["output_tokens"] as number,
      cache_read: r["cache_read_tokens"] as number | null,
      cache_write: r["cache_write_tokens"] as number | null,
      ...(oneHour ? { cache_write_1h: r[ROW_1H_FIELD] as number } : {}),
    },
    rates as Rates,
  );
  if (expected !== c["usd_micros"]) {
    return `${at}.cost.usd_micros is ${String(c["usd_micros"])}, and its own counts at its own rates come to ${expected === undefined ? "no price" : String(expected)}`;
  }
  return shippedProblem(r, c, rates as Rates, at);
}

/**
 * A row that says its rates are the shipped table's — by version or by digest — checked against that table
 * when this build carries it (PR #3 review, M2 and R2). Without this a row labelled `default`, `2026-09-28`
 * at ten times the shipped rates verified: the arithmetic was right and the label was the agent's word. A
 * version and digest this build does not carry cannot be checked here, and `costGroups` says so instead.
 */
function shippedProblem(r: Record<string, unknown>, c: Record<string, unknown>, rates: Rates, at: string): string | undefined {
  // Named by version as `default`, or carrying a shipped table's digest whatever else it says (R2): a digest
  // is the table's content, so a row with the shipped digest under an invented version, or labelled as the
  // owner's, is claiming the shipped prices and is held to every one of its labels.
  const table = (c["source"] === "default" ? shippedTable(c["table"] as string) : undefined) ?? shippedByDigest(c["table_digest"] as string);
  if (table === undefined) return undefined;
  const claim = `the shipped table ${table.version}`;
  if (c["source"] !== "default") return `${at}.cost carries the digest of ${claim} and says the owner set its rates`;
  if (c["table"] !== table.version) return `${at}.cost carries the digest of ${claim} and names table ${String(c["table"])}`;
  if (c["table_digest"] !== table.digest) return `${at}.cost names ${claim}, whose digest is ${table.digest}, not ${String(c["table_digest"])}`;
  const entry = table.entries.find((e) => e.backend === r["backend"] && e.model === r["model"]);
  if (entry === undefined) return `${at}.cost names ${claim}, which has no price for ${String(r["backend"])} · ${String(r["model"])}`;
  for (const field of RATE_FIELDS) {
    if (rates[field] !== entry[field]) {
      return `${at}.cost names ${claim}, which prices ${String(r["model"])} ${field} at ${String(entry[field])} µ$/MTok, not ${String(rates[field])}`;
    }
  }
  // D-143: a table from before the split has no 1-hour rate, and a row that claims one from it is refused.
  if (RATE_1H in rates && rate1h(rates) !== rate1h(entry)) {
    return `${at}.cost names ${claim}, which prices ${String(r["model"])} ${RATE_1H} at ${String(rate1h(entry) ?? "nothing")}${
      rate1h(entry) === null ? "" : " µ$/MTok"}, not ${String(rate1h(rates))}`;
  }
  return undefined;
}

/** Why this is not a row, or undefined. */
function rowProblem(row: unknown, index: number): string | undefined {
  return rowVerdict(row, `rows[${index}]`)?.why;
}

/** Why this is not a row, and whether it is the row's shape or its cost that is wrong. */
function rowVerdict(row: unknown, at: string): { readonly kind: "shape" | "cost"; readonly why: string } | undefined {
  const why = shapeProblem(row, at);
  if (why !== undefined) return { kind: "shape", why };
  const r = row as Record<string, unknown>;
  const cost = r["cost"] === null ? notChargedProblem(r, at) : costProblem(r, at);
  return cost === undefined ? undefined : { kind: "cost", why: cost };
}

function notChargedProblem(r: Record<string, unknown>, at: string): string | undefined {
  return (NOT_CHARGED as readonly unknown[]).includes(r["not_charged"]) ? undefined : `${at}.not_charged is not one of ${NOT_CHARGED.join(", ")}`;
}

/** Everything about a row but its cost. */
function shapeProblem(row: unknown, at: string): string | undefined {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return `${at} is not an object`;
  const r = row as Record<string, unknown>;
  if (!sameFields(row, ROW_1H_FIELD in r ? [...USAGE_ROW_FIELDS, ROW_1H_FIELD] : USAGE_ROW_FIELDS)) return `${at} does not have exactly a row's fields`;
  for (const field of ["id", "turn"]) if (!isSafeId(r[field])) return `${at}.${field} is not an id`;
  if (!isIsoInstant(r["at"])) return `${at}.at is not an ISO-8601 UTC instant`;
  if (typeof r["backend"] !== "string" || !isModelBackend(r["backend"])) return `${at}.backend is not a plain backend id`;
  if (r["model"] !== null && (typeof r["model"] !== "string" || !isModelName(r["model"]))) return `${at}.model is not a model's name or null`;
  for (const field of ["duration_ms", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]) {
    if (!countOrNull(r[field])) return `${at}.${field} is not a whole number or null`;
  }
  if (!ROW_USAGES.has(r["usage"] as string)) return `${at}.usage is not one of ${[...ROW_USAGES].join(", ")}`;
  // D-143: a part of the cache write, 1 or more (never a 0 — a row with no 1-hour write does not carry it).
  if (ROW_1H_FIELD in r) {
    const oneHour = r[ROW_1H_FIELD];
    if (typeof oneHour !== "number" || !Number.isSafeInteger(oneHour) || oneHour < 1) return `${at}.${ROW_1H_FIELD} is not a whole number of 1 or more`;
    if (typeof r["cache_write_tokens"] !== "number" || oneHour > r["cache_write_tokens"]) return `${at}.${ROW_1H_FIELD} is more than cache_write_tokens, which it is a part of`;
  }
  return undefined;
}

/** Why this is not a report's binding — null, or exactly `{market, listing, job}` in their shapes — or undefined. */
export function bindingProblem(binding: unknown): string | undefined {
  if (binding === null) return undefined;
  if (typeof binding !== "object" || Array.isArray(binding) || !sameFields(binding, BINDING_FIELDS)) {
    return `binding is not null or exactly {${BINDING_FIELDS.join(", ")}}`;
  }
  const b = binding as Record<string, unknown>;
  const market = marketOriginProblem(b["market"]);
  if (market !== undefined) return `binding.market ${market}`;
  if (!isListingSlug(b["listing"])) return "binding.listing is not a listing's slug";
  if (b["job"] !== null && !isJobId(b["job"])) return "binding.job is not a job's id or null";
  return undefined;
}

/**
 * Why a report bound so is not the one `pins` asks for, or undefined. Market and listing are both held, and
 * a report bound to nothing never matches: it was made for its own machine.
 */
export function bindingMismatch(binding: ReportBinding | null, pins: BindingPins): string | undefined {
  if (binding === null) return "it is bound to no market — it was made for its own machine, and no market takes it";
  if (binding.market !== pins.market) return `it is bound to another market: ${binding.market}, not ${pins.market}`;
  if (binding.listing !== pins.listing) return `it is bound to another listing: ${binding.listing}, not ${pins.listing}`;
  return undefined;
}

/** Why this payload is not a usage report this version reads, or undefined. */
export function reportProblem(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "the payload is not an object";
  const p = payload as Record<string, unknown>;
  if (p["kind"] !== USAGE_REPORT_KIND) return `the payload is of kind ${JSON.stringify(p["kind"])}, not ${USAGE_REPORT_KIND}`;
  if (p["v"] !== USAGE_REPORT_VERSION) return `the report's version ${JSON.stringify(p["v"])} is not ${USAGE_REPORT_VERSION}`;
  if (!sameFields(p, PAYLOAD_FIELDS)) return `a report has exactly the fields ${PAYLOAD_FIELDS.join(", ")}`;
  if (!isIsoInstant(p["generated_at"])) return "generated_at is not an ISO-8601 UTC instant";
  for (const field of ["since", "until"]) if (p[field] !== null && !isIsoInstant(p[field])) return `${field} is not an ISO-8601 UTC instant or null`;
  const binding = bindingProblem(p["binding"]);
  if (binding !== undefined) return binding;
  if (!Array.isArray(p["rows"])) return "rows is not a list";
  for (const [index, row] of (p["rows"] as unknown[]).entries()) {
    const problem = rowProblem(row, index);
    if (problem !== undefined) return problem;
  }
  return conflicts(p["rows"] as UsageRow[]).why;
}

/** The rows of a usage-report payload, if it is one in every field — or undefined. */
export function reportRows(payload: unknown): readonly UsageRow[] | undefined {
  return reportProblem(payload) === undefined ? ((payload as UsageReportPayload).rows) : undefined;
}

export type ReportCheck =
  | { readonly ok: true; readonly envelope: SignedEnvelope; readonly payload: UsageReportPayload }
  | { readonly ok: false; readonly reason: string };

/**
 * Consistent: the text parses strictly (no duplicate names, integers in one spelling), the envelope's own key
 * signed its payload, the payload is a usage report in every field — and, when `pins` are given, it is bound
 * to exactly that market and listing. **Not** a verdict on whose key signed it — anyone can make a key.
 * `usage verify` exits non-zero on this answer alone (review L4); {@link verifyUsageReport} is the one that
 * can say yes.
 */
export function checkUsageReport(text: string, pins?: BindingPins): ReportCheck {
  const parsed = parseJsonStrict(text);
  if (!parsed.ok) return { ok: false, reason: `not JSON a signature can be checked over: ${parsed.reason}` };
  const checked = checkEnvelope(parsed.value);
  if (!checked.ok) return checked;
  const problem = reportProblem(checked.envelope.payload);
  if (problem !== undefined) return { ok: false, reason: `not a usage report this version reads: ${problem}` };
  const payload = checked.envelope.payload as UsageReportPayload;
  const mismatch = pins === undefined ? undefined : bindingMismatch(payload.binding, pins);
  if (mismatch !== undefined) return { ok: false, reason: mismatch };
  return { ok: true, envelope: checked.envelope, payload };
}

/** Valid: {@link checkUsageReport}, and signed by exactly `expectedPublicKey`. Never throws. */
export function verifyUsageReport(text: string, expectedPublicKey: string, pins?: BindingPins): ReportCheck {
  const problem = publicKeyProblem(expectedPublicKey);
  if (problem !== undefined) return { ok: false, reason: `the key to check against is not usable: ${problem}` };
  const checked = checkUsageReport(text, pins);
  if (!checked.ok) return checked;
  const verified = verifyEnvelope(checked.envelope, expectedPublicKey);
  return verified.ok ? checked : verified;
}
