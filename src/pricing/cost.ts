/**
 * What one turn cost, from what the backend counted and the price table in force — or why it is not charged
 * (S15.9, D-110, D-139).
 *
 * Pure arithmetic over integers, in one direction: counts × rates → micro-dollars. Nothing here estimates.
 * A turn is charged only when every number the sum needs is one the backend printed and one a table named;
 * otherwise it is **not charged**, with the reason, because D-110 bills a turn with no count at nothing — the
 * hirer never pays for a guess, and the agent's owner is the one with a reason to make the adapter report.
 *
 * ## The formula, so anyone can check it without Mind
 *
 *     uncached = input − (cache_read ?? 0) − (cache_write ?? 0)
 *     write1h  = cache_write_1h ?? 0                     (the part of cache_write written to the 1-hour cache)
 *     sum      = uncached × rate.input + cache_read × rate.cache_read
 *              + (cache_write − write1h) × rate.cache_write + write1h × rate.cache_write_1h
 *              + output × rate.output                                       (rates: µ$ per million tokens)
 *     cost     = (sum + 500000) // 1000000                                   (µ$, halves rounded up)
 *
 * `input` is the whole prompt side and the cache counts are parts of it (see `Usage`). A cache count is null
 * on a charged turn only when the backend never prints one (`not_printed`); then there is no part to take out
 * and none to price. A part whose count is above zero needs a rate — a null rate for a part this turn used
 * is a price nobody named, and the turn is not charged. One rounding per turn, after the sum, so a total over
 * rows is the plain sum of the rows' costs. BigInt inside, because tokens × rate can pass 2^53.
 *
 * ## A cache write is two prices (D-143)
 *
 * Anthropic prices a write to the 5-minute cache at 1.25× input and one to the 1-hour cache at 2×, and claude
 * says which it wrote (`usage.cache_creation`). The 1-hour part is priced at `cache_write_1h`, the rest of the
 * write at `cache_write`. With `write1h` 0 the sum is the formula before D-143 term for term, which is why a
 * row with no 1-hour write keeps the shape it had. A backend that never splits its writes (grok, ollama) has
 * `write1h` 0: its writes are one part at one rate, as before.
 *
 * A turn whose backend prints the split and did not print it this time, and which wrote to the cache, is not
 * charged (`usage-unsplit`) — not priced at the 5-minute rate as the lower bound. D-110 and D-139 bill what is
 * known and nothing that is not: the 5-minute rate would be a guess about which cache was written, and a guess
 * that can only fall one way is still a guess the hirer pays for. The owner, not the hirer, is the one who can
 * make the backend say (by running a CLI that prints the split).
 */

import type { Usage } from "../types.ts";
import { findPrice, rate1h, type PricesInForce, type Rates, type TableOrigin } from "./table.ts";

/**
 * Why a turn is not charged. The order is the order they are checked in, so a turn gets the most basic
 * reason that applies.
 *
 * - `not-recorded` — the line was written before Mind priced turns (S15.9). Nothing is priced after the
 *   fact: the table in force then is not known now.
 * - `usage-missing` — the backend printed no count this turn, or nobody has surveyed what it prints (D-110).
 * - `usage-unsplit` — there are counts, but not input and output apart (codex prints one total), or the cache
 *   parts are more than the input they are part of, or the turn wrote to the cache on a backend that says
 *   which cache it wrote and this time did not say (D-143).
 * - `model-unknown` — the line names no model the price can be looked up by: the backend ran its own default and
 *   did not say which, or it named more than one, or it was asked for an alias no table lists (D-142).
 * - `table-unusable` — the owner's price file is there and cannot be used; nothing is priced until it can.
 * - `price-unknown` — no table in force prices this model on this backend, or none prices a part this turn
 *   used, or the figure is too large for a signed report to hold.
 */
export type NotCharged =
  | "not-recorded"
  | "usage-missing"
  | "usage-unsplit"
  | "model-unknown"
  | "table-unusable"
  | "price-unknown";

export const NOT_CHARGED: readonly NotCharged[] = [
  "not-recorded",
  "usage-missing",
  "usage-unsplit",
  "model-unknown",
  "table-unusable",
  "price-unknown",
];

/** A turn's cost, and everything needed to check it: the rates applied, and the table they came from. */
export interface TurnCost {
  /** Micro-dollars: 1 is US$0.000001. */
  readonly usd_micros: number;
  /** The version of the table the rates came from. */
  readonly table: string;
  /**
   * That table's content digest (`tableDigest`): 16 hex characters that change with any price in it. A
   * version is only a name; this is what says which prices it named when the turn ran (PR #3 review).
   */
  readonly table_digest: string;
  readonly source: TableOrigin;
  /**
   * The rates applied, per part, in micro-dollars per million tokens — `cache_write_1h` among them only when
   * the turn wrote to the 1-hour cache (D-143, {@link appliedRates}).
   */
  readonly usd_micros_per_mtok: Rates;
}

/** What the ledger records: a cost, or null and the reason. Exactly one of the two is non-null. */
export type Charge =
  | { readonly cost: TurnCost; readonly not_charged: null }
  | { readonly cost: null; readonly not_charged: NotCharged };

/** The counts a charge is computed from: the four parts, and how much of the cache write was the 1-hour one. */
export interface PricedCounts {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number | null;
  readonly cache_write: number | null;
  /**
   * Of `cache_write`, the tokens written to the 1-hour cache, priced at `cache_write_1h` (D-143). Absent or 0:
   * none — the whole write is priced at `cache_write`, which is also what a backend that never splits its
   * writes gets. Never more than `cache_write`.
   */
  readonly cache_write_1h?: number;
}

/**
 * The part of a cache write priced at the 1-hour rate (D-143) — 0 for no write, and for a backend that never
 * splits one — or `usage-unsplit` when the backend prints the split, did not this turn, and there was a write.
 */
function oneHourPart(usage: Usage, cacheWrite: number | null, notPrinted: readonly string[]): number | "usage-unsplit" {
  if (cacheWrite === null || cacheWrite === 0) return 0;
  const oneHour = knownOneHourWrite(usage);
  if (oneHour !== null) return oneHour;
  if (notPrinted.includes("cache_write_5m") && notPrinted.includes("cache_write_1h")) return 0;
  return "usage-unsplit";
}

/**
 * The tokens a usage says were written to the 1-hour cache (D-143) — only when both parts of the split are
 * whole counts adding up to the write, as the exec layer writes them and a line is not trusted to — else null.
 * What pricing prices at the 1-hour rate, and what a report row carries as `cache_write_1h_tokens`.
 */
export function knownOneHourWrite(usage: Usage | undefined): number | null {
  const cacheWrite = usage?.cache_write ?? null;
  const fiveMinute = usage?.cache_write_5m ?? null;
  const oneHour = usage?.cache_write_1h ?? null;
  if (cacheWrite === null || fiveMinute === null || oneHour === null) return null;
  return fiveMinute + oneHour === cacheWrite ? oneHour : null;
}

/**
 * The counts to price, or why there are none. Reads the usage as recorded — no count is made up, and a null
 * cache count is taken as "no such part" only when the usage says the backend never prints one.
 */
export function pricedCounts(usage: Usage | undefined): PricedCounts | NotCharged {
  if (usage === undefined) return "not-recorded";
  if (usage.status !== "reported") return "usage-missing";
  if (usage.input === null || usage.output === null) return "usage-unsplit";
  const cacheRead = usage.cache_read ?? null;
  const cacheWrite = usage.cache_write ?? null;
  // A null the backend was expected to fill is a missing count, whatever the status says.
  const notPrinted = usage.not_printed ?? [];
  if ((cacheRead === null && !notPrinted.includes("cache_read")) || (cacheWrite === null && !notPrinted.includes("cache_write"))) {
    return "usage-missing";
  }
  if ((cacheRead ?? 0) + (cacheWrite ?? 0) > usage.input) return "usage-unsplit";
  const oneHour = oneHourPart(usage, cacheWrite, notPrinted);
  if (oneHour === "usage-unsplit") return oneHour;
  const counts = { input: usage.input, output: usage.output, cache_read: cacheRead, cache_write: cacheWrite };
  return oneHour === 0 ? counts : { ...counts, cache_write_1h: oneHour };
}

/** Micro-dollars for these counts at these rates, or undefined when a used part has no rate or it overflows. */
export function costOf(counts: PricedCounts, rates: Rates): number | undefined {
  const cacheRead = counts.cache_read ?? 0;
  const cacheWrite = counts.cache_write ?? 0;
  const oneHour = counts.cache_write_1h ?? 0;
  const uncached = counts.input - cacheRead - cacheWrite;
  if (uncached < 0 || oneHour < 0 || oneHour > cacheWrite) return undefined;
  const parts: readonly (readonly [number, number | null])[] = [
    [uncached, rates.input],
    [cacheRead, rates.cache_read],
    [cacheWrite - oneHour, rates.cache_write],
    [oneHour, rate1h(rates)],
    [counts.output, rates.output],
  ];
  let sum = 0n;
  for (const [tokens, rate] of parts) {
    if (tokens === 0) continue;
    if (rate === null) return undefined;
    sum += BigInt(tokens) * BigInt(rate);
  }
  const micros = (sum + 500_000n) / 1_000_000n;
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : undefined;
}

/**
 * The name a turn is priced by (D-142): the model it ran on, or — only when the backend said nothing at all
 * about which model it ran — the model Mind asked for, if a table in force lists exactly that name for this
 * backend. Otherwise none.
 *
 * Why the second is safe for money: the name must be a price table's own entry for this backend, letter for
 * letter. In the SHIPPED tables every entry is a full model id, so an alias such as `opus` is in none of them
 * and is never priced as `claude-opus-5` or anything else. The owner's own price file may list any valid name,
 * `opus` included; a turn asked for `opus` is then priced at the owner's own `opus` rate, which the row states
 * as `source: owner`, its digest, and "NOT checked" (PR #5 review). A CLI handed a full id either runs that model or fails; it has no other
 * model to fall back to, because Mind passes no fallback flag. And the rule never overrides what the
 * backend did say: a turn whose output named a different model is priced by that model, and one whose output
 * named two is not priced at all. The caller passes `requested` only in the silent case (`RecordingExec`).
 */
export function pricingModel(backend: string, ran: string | null, requested: string | null, prices: PricesInForce): string | null {
  if (ran !== null) return ran;
  if (requested === null || prices.owner.state === "unusable") return null;
  return findPrice(prices, backend, requested) === undefined ? null : requested;
}

/**
 * Price one turn against the tables in force when it began. Never throws.
 *
 * @param requested The model Mind asked for, passed **only** when the backend reported no model at all (see
 *   {@link pricingModel}). It prices the turn only when a table lists exactly that name for this backend.
 */
export function chargeTurn(
  usage: Usage | undefined,
  backend: string,
  model: string | null,
  prices: PricesInForce,
  requested: string | null = null,
): Charge {
  const counts = pricedCounts(usage);
  if (typeof counts === "string") return { cost: null, not_charged: counts };
  if (model === null && requested === null) return { cost: null, not_charged: "model-unknown" };
  if (prices.owner.state === "unusable") return { cost: null, not_charged: "table-unusable" };
  const priceBy = pricingModel(backend, model, requested, prices);
  if (priceBy === null) return { cost: null, not_charged: "model-unknown" };
  const found = findPrice(prices, backend, priceBy);
  if (found === undefined) return { cost: null, not_charged: "price-unknown" };
  const micros = costOf(counts, found.rates);
  if (micros === undefined) return { cost: null, not_charged: "price-unknown" };
  return {
    cost: { usd_micros: micros, table: found.table, table_digest: found.digest, source: found.origin, usd_micros_per_mtok: appliedRates(counts, found.rates) },
    not_charged: null,
  };
}

/**
 * The rates a cost carries: the four always, and `cache_write_1h` only when the turn wrote to the 1-hour cache
 * (D-143). The one it did not apply is left off so that every other line and row keeps the shape it had before
 * the split — the shape a market that has not caught up still reads.
 */
export function appliedRates(counts: PricedCounts, rates: Rates): Rates {
  const four = { input: rates.input, output: rates.output, cache_read: rates.cache_read, cache_write: rates.cache_write };
  return (counts.cache_write_1h ?? 0) > 0 ? { ...four, cache_write_1h: rate1h(rates) } : four;
}

/** Micro-dollars as dollars for a person to read: `$0.012345`. Exact for any size — a total is a BigInt. */
export function formatUsd(micros: number | bigint): string {
  const value = BigInt(micros);
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `$${value / 1_000_000n}.${fraction}`;
}

/** A rate per million tokens as dollars — `$3.00`, `$0.30`, `$0.075` — or `-` when the table has none. */
export function formatRate(rate: number | null): string {
  return rate === null ? "-" : formatUsd(rate).replace(/(\.\d\d\d*?)0+$/, "$1");
}
