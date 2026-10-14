/**
 * What a turn cost, or why it is not charged (S15.9, D-110, D-139).
 *
 * The formula is small enough to state in a comment and important enough to pin with numbers a person can
 * redo by hand: counts × rates in micro-dollars per million tokens, one rounding, halves up. The reasons are
 * pinned one by one, because each is a turn a hirer is not billed for — and the order matters: a turn gets
 * the most basic reason that applies.
 */

import { describe, expect, test } from "bun:test";
import { appliedRates, chargeTurn, costOf, formatRate, formatUsd, knownOneHourWrite, NOT_CHARGED, pricedCounts, pricingModel } from "../../src/pricing/cost.ts";
import { DEFAULT_PRICES, PRICE_TABLE_KIND, shippedTable, validatePriceTable, type PricesInForce, type Rates } from "../../src/pricing/table.ts";
import type { Usage } from "../../src/types.ts";

const SHIPPED: PricesInForce = { default: DEFAULT_PRICES, owner: { state: "absent" }, ownerPath: "/x" };

/** Usage the way claude writes it since D-143: every part printed, and the write split by cache (all 5-minute unless said). */
const split = (fresh: number, cacheRead: number, cacheWrite: number, output: number, oneHour = 0): Usage => ({
  status: "reported",
  input: fresh + cacheRead + cacheWrite,
  output,
  total: null,
  cache_read: cacheRead,
  cache_write: cacheWrite,
  cache_write_5m: cacheWrite - oneHour,
  cache_write_1h: oneHour,
  not_printed: [],
});

/** Usage the way grok writes it: every part printed, and no split of the write — said so (D-143). */
const grokUsage = (fresh: number, cacheRead: number, cacheWrite: number, output: number): Usage => ({
  ...split(fresh, cacheRead, cacheWrite, output),
  cache_write_5m: null,
  cache_write_1h: null,
  not_printed: ["cache_write_5m", "cache_write_1h"],
});

const SONNET: Rates = { input: 3_000_000, output: 15_000_000, cache_read: 300_000, cache_write: 3_750_000 };
const SONNET_1H: Rates = { ...SONNET, cache_write_1h: 6_000_000 };

describe("the counts a charge is computed from", () => {
  test("each way a usage cannot be priced has its own reason", () => {
    expect(pricedCounts(undefined)).toBe("not-recorded");
    expect(pricedCounts({ status: "missing", input: 5, output: null, total: null })).toBe("usage-missing");
    expect(pricedCounts({ status: "unreported", input: null, output: null, total: null })).toBe("usage-missing");
    // codex: one total, and every part not printed.
    expect(
      pricedCounts({ status: "reported", input: null, output: null, total: 2243, cache_read: null, cache_write: null, not_printed: ["input", "output", "cache_read", "cache_write"] }),
    ).toBe("usage-unsplit");
    // Cache parts larger than the input they are part of do not add up.
    expect(pricedCounts({ ...split(0, 0, 0, 1), input: 5, cache_read: 10 })).toBe("usage-unsplit");
    // A null cache count nobody said is never printed is a missing one — as on a line from before S15.9.
    expect(pricedCounts({ status: "reported", input: 15, output: 24, total: null })).toBe("usage-missing");
    expect(pricedCounts({ ...split(1, 0, 0, 1), cache_write: null })).toBe("usage-missing");
  });

  test("a count the backend never prints is no part at all, and the rest is priced", () => {
    const ollama: Usage = { status: "reported", input: 15, output: 24, total: null, cache_read: null, cache_write: null, not_printed: ["cache_read", "cache_write"] };
    expect(pricedCounts(ollama)).toEqual({ input: 15, output: 24, cache_read: null, cache_write: null });
  });

  test("D-143: the 1-hour part of a write is kept apart; none, or a backend that never splits, is no part", () => {
    expect(pricedCounts(split(1, 0, 300, 1, 200))).toEqual({ input: 301, output: 1, cache_read: 0, cache_write: 300, cache_write_1h: 200 });
    // All 5-minute, or no write at all: exactly the counts before D-143.
    expect(pricedCounts(split(1, 0, 300, 1))).toEqual({ input: 301, output: 1, cache_read: 0, cache_write: 300 });
    expect(pricedCounts(split(1, 0, 0, 1))).toEqual({ input: 1, output: 1, cache_read: 0, cache_write: 0 });
    // grok says it prints no split: its write is one part, priced at cache_write, as before.
    expect(pricedCounts(grokUsage(1, 0, 5, 1))).toEqual({ input: 6, output: 1, cache_read: 0, cache_write: 5 });
  });

  test("D-143: a write whose split the backend prints and did not print is not charged — never priced as all 5-minute", () => {
    const unsplit: Usage = { ...split(1, 0, 300, 1), cache_write_5m: null, cache_write_1h: null };
    expect(pricedCounts(unsplit)).toBe("usage-unsplit");
    // A line from before D-143 has no split at all, and is the same unknown.
    const { cache_write_5m: _a, cache_write_1h: _b, ...older } = split(1, 0, 300, 1);
    expect(pricedCounts(older)).toBe("usage-unsplit");
    // A split that does not add up to the write is not one.
    expect(pricedCounts({ ...split(1, 0, 300, 1, 200), cache_write_5m: 50 })).toBe("usage-unsplit");
    // Only one of the two listed as never printed is not "never splits".
    expect(pricedCounts({ ...unsplit, not_printed: ["cache_write_1h"] })).toBe("usage-unsplit");
    // No write, nothing to split: the unknown split costs nothing and hides nothing.
    expect(pricedCounts({ ...split(1, 0, 0, 1), cache_write_5m: null, cache_write_1h: null })).toEqual({ input: 1, output: 1, cache_read: 0, cache_write: 0 });
    expect(knownOneHourWrite(unsplit)).toBeNull();
    expect(knownOneHourWrite(split(1, 0, 300, 1, 200))).toBe(200);
    expect(knownOneHourWrite(undefined)).toBeNull();
  });
});

describe("the formula", () => {
  test("the measured claude turn of D-023, at Sonnet 4.6's list price, by hand", () => {
    // 2 fresh, 80,951 written to the cache, 0 read, 4 out:
    // 2×3,000,000 + 80,951×3,750,000 + 4×15,000,000 = 303,632,250,000 → /1e6 = 303,632.25 → 303,632 µ$.
    const counts = pricedCounts(split(2, 0, 80_951, 4));
    if (typeof counts === "string") throw new Error(counts);
    expect(costOf(counts, SONNET)).toBe(303_632);
  });

  test("D-110's evidence: pricing the cache apart is what keeps the overhead off the hirer", () => {
    // A turn of 108,921 input tokens, nearly all of it cache reads, and 2,624 out.
    const counts = pricedCounts(split(921, 108_000, 0, 2_624));
    if (typeof counts === "string") throw new Error(counts);
    const apart = costOf(counts, SONNET)!;
    const allAsInput = costOf({ ...counts, cache_read: 0 }, SONNET)!;
    expect(apart).toBe(74_523); // 921×3 + 108,000×0.3 + 2,624×15 = 2,763 + 32,400 + 39,360 µ$
    expect(allAsInput).toBeGreaterThan(apart * 4);
  });

  test("D-143: the 1-hour write at its own rate — D-142's measured haiku turn, under both shipped tables", () => {
    // 10 fresh, 11,856 written to the 1-hour cache, 65 out (the counts of the turns D-142 and D-143 measured).
    const counts = pricedCounts(split(10, 0, 11_856, 65, 11_856));
    if (typeof counts === "string") throw new Error(counts);
    const haiku = DEFAULT_PRICES.entries.find((e) => e.model === "claude-haiku-4-5")!;
    // 10×$1 + 11,856×$2 + 65×$5 per million tokens = 10 + 23,712 + 325 = 24,047 µ$.
    expect(costOf(counts, haiku)).toBe(24_047);
    // 2026-09-28 has no 1-hour rate: that turn now has no price there, rather than the 5-minute one.
    const before = shippedTable("2026-09-28")!.entries.find((e) => e.model === "claude-haiku-4-5")!;
    expect(costOf(counts, before)).toBeUndefined();
    // What it used to be charged, all at 5 minutes — 8,892 µ$ short: 10 + 14,820 + 325 = 15,155.
    expect(costOf({ ...counts, cache_write_1h: 0 }, before)).toBe(15_155);
  });

  test("D-143: a write split both ways prices each part at its own rate", () => {
    // 1,200 fresh, 50,000 read, 1,000 to 5 minutes and 2,000 to 1 hour, 800 out, at Sonnet 4.6:
    // 3,600 + 15,000 + 3,750 + 12,000 + 12,000 = 46,350 µ$.
    const counts = pricedCounts(split(1_200, 50_000, 3_000, 800, 2_000));
    if (typeof counts === "string") throw new Error(counts);
    expect(costOf(counts, SONNET_1H)).toBe(46_350);
    // A 1-hour part with no 1-hour rate has no price; more 1-hour than the write is not a count.
    expect(costOf(counts, SONNET)).toBeUndefined();
    expect(costOf(counts, { ...SONNET_1H, cache_write_1h: null })).toBeUndefined();
    expect(costOf({ ...counts, cache_write_1h: 3_001 }, SONNET_1H)).toBeUndefined();
    expect(costOf({ ...counts, cache_write_1h: -1 }, SONNET_1H)).toBeUndefined();
  });

  test("one rounding per turn, after the sum, halves up", () => {
    const rates: Rates = { input: 1, output: 0, cache_read: null, cache_write: null };
    const at = (input: number) => costOf({ input, output: 0, cache_read: null, cache_write: null }, rates);
    expect(at(499_999)).toBe(0);
    expect(at(500_000)).toBe(1);
    expect(at(1_499_999)).toBe(1);
    expect(at(1_500_000)).toBe(2);
  });

  test("a part used with no rate has no price; a part not used needs none", () => {
    const grok: Rates = { input: 2_000_000, output: 6_000_000, cache_read: 500_000, cache_write: null };
    expect(costOf({ input: 10, output: 1, cache_read: 0, cache_write: 0 }, grok)).toBe(26);
    expect(costOf({ input: 10, output: 1, cache_read: 0, cache_write: 3 }, grok)).toBeUndefined();
    expect(costOf({ input: 10, output: 1, cache_read: null, cache_write: null }, grok)).toBe(26);
  });

  test("a price of 0 is a price: the owner saying a turn is free", () => {
    const free: Rates = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    expect(costOf({ input: 1_000_000, output: 1_000_000, cache_read: 5, cache_write: 5 }, free)).toBe(0);
  });

  test("more than a signed report's integers can hold is no price; a negative remainder is none either", () => {
    const huge: Rates = { input: 1_000_000_000_000, output: 1_000_000_000_000, cache_read: null, cache_write: null };
    expect(costOf({ input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER, cache_read: null, cache_write: null }, huge)).toBeUndefined();
    expect(costOf({ input: 1, output: 0, cache_read: 5, cache_write: null }, SONNET)).toBeUndefined();
  });
});

describe("charging a turn", () => {
  test("a claude turn on a model the shipped table names is charged, from the default table", () => {
    const charge = chargeTurn(split(2, 0, 80_951, 4), "claude", "claude-sonnet-4-6", SHIPPED);
    expect(charge).toEqual({
      cost: { usd_micros: 303_632, table: DEFAULT_PRICES.version, table_digest: DEFAULT_PRICES.digest, source: "default", usd_micros_per_mtok: SONNET },
      not_charged: null,
    });
  });

  test("the reasons come in order: no usage before no model before no table before no price", () => {
    const broken: PricesInForce = { ...SHIPPED, owner: { state: "unusable", reason: "x" } };
    expect(chargeTurn(undefined, "claude", null, broken).not_charged).toBe("not-recorded");
    expect(chargeTurn({ status: "missing", input: null, output: null, total: null }, "claude", null, broken).not_charged).toBe("usage-missing");
    expect(chargeTurn(split(1, 0, 0, 1), "claude", null, broken).not_charged).toBe("model-unknown");
    expect(chargeTurn(split(1, 0, 0, 1), "claude", "claude-sonnet-4-6", broken).not_charged).toBe("table-unusable");
    expect(chargeTurn(split(1, 0, 0, 1), "claude", "opus", SHIPPED).not_charged).toBe("price-unknown");
    // grok has no cache-write price: a turn that wrote to the cache is not charged, one that did not is.
    expect(chargeTurn(grokUsage(1, 0, 5, 1), "grok", "grok-4.7", SHIPPED).not_charged).toBe("price-unknown");
    expect(chargeTurn(grokUsage(1, 0, 0, 1), "grok", "grok-4.7", SHIPPED).cost?.source).toBe("default");
    // D-143: an unknown split is a usage reason, and comes before any table or price is looked at.
    expect(chargeTurn({ ...split(1, 0, 5, 1), cache_write_1h: null }, "claude", "claude-sonnet-4-6", broken).not_charged).toBe("usage-unsplit");
  });

  test("D-143: a cost carries the 1-hour rate only when the turn wrote to the 1-hour cache", () => {
    const oneHour = chargeTurn(split(1_200, 50_000, 3_000, 800, 2_000), "claude", "claude-sonnet-4-6", SHIPPED);
    expect(oneHour.cost).toEqual({
      usd_micros: 46_350,
      table: DEFAULT_PRICES.version,
      table_digest: DEFAULT_PRICES.digest,
      source: "default",
      usd_micros_per_mtok: SONNET_1H,
    });
    // All 5-minute: the four rates, exactly as a line before D-143 carried them.
    const fiveMinute = chargeTurn(split(1_200, 50_000, 3_000, 800), "claude", "claude-sonnet-4-6", SHIPPED);
    expect(fiveMinute.cost?.usd_micros).toBe(41_850);
    expect(Object.keys(fiveMinute.cost!.usd_micros_per_mtok)).toEqual(["input", "output", "cache_read", "cache_write"]);
    expect(appliedRates({ input: 1, output: 1, cache_read: 0, cache_write: 0 }, SONNET_1H)).toEqual(SONNET);
    expect(appliedRates({ input: 1, output: 1, cache_read: 0, cache_write: 1, cache_write_1h: 1 }, SONNET)).toEqual({ ...SONNET, cache_write_1h: null });
  });

  test("D-143: an owner's price with no 1-hour rate charges a 5-minute write and not a 1-hour one", () => {
    const own = validatePriceTable({
      kind: PRICE_TABLE_KIND,
      v: 1,
      version: "home-1",
      currency: "usd",
      unit: "micros-per-million-tokens",
      prices: [{ backend: "claude-local", model: "local-coder", input: 1_000, output: 2_000, cache_read: 100, cache_write: 1_250 }],
    });
    if (!own.ok) throw new Error(own.reason);
    const prices: PricesInForce = { ...SHIPPED, owner: { state: "ok", table: own.table } };
    expect(chargeTurn(split(1_000, 0, 1_000, 1_000), "claude-local", "local-coder", prices).cost?.source).toBe("owner");
    expect(chargeTurn(split(1_000, 0, 1_000, 1_000, 1), "claude-local", "local-coder", prices)).toEqual({ cost: null, not_charged: "price-unknown" });
  });

  test("a charge is a cost and no reason; not charged is a reason and no cost — never both, never neither", () => {
    const usages = [undefined, split(1, 0, 0, 1), { status: "missing", input: null, output: null, total: null } as Usage];
    for (const usage of usages) {
      for (const model of [null, "claude-sonnet-4-6", "unknown-model"]) {
        const charge = chargeTurn(usage, "claude", model, SHIPPED);
        expect((charge.cost === null) !== (charge.not_charged === null)).toBe(true);
        if (charge.not_charged !== null) expect(NOT_CHARGED).toContain(charge.not_charged);
      }
    }
  });
});

describe("money for a person to read", () => {
  test("micro-dollars as dollars, and a rate trimmed to the cents it needs", () => {
    expect(formatUsd(303_632)).toBe("$0.303632");
    expect(formatUsd(12_000_001)).toBe("$12.000001");
    expect(formatUsd(0)).toBe("$0.000000");
    // A total is a BigInt, and past 2^53 it is still printed as the digits it is.
    expect(formatUsd(2n ** 60n)).toBe("$1152921504606.846976");
    expect([3_000_000, 300_000, 75_000, 12_500_000, 1].map(formatRate)).toEqual(["$3.00", "$0.30", "$0.075", "$12.50", "$0.000001"]);
    expect(formatRate(null)).toBe("-");
  });
});

describe("D-142 — which name a turn is priced by", () => {
  const usage = split(1_000, 0, 0, 100);

  test("the model the backend ran, whatever was asked; else an exact table name that was asked; else none", () => {
    expect(pricingModel("claude", "claude-sonnet-4-6", "opus", SHIPPED)).toBe("claude-sonnet-4-6");
    expect(pricingModel("claude", null, "claude-sonnet-4-6", SHIPPED)).toBe("claude-sonnet-4-6");
    // An alias is in no table, and is never priced as the model it may resolve to.
    for (const alias of ["opus", "sonnet", "haiku", "fable", "claude-sonnet", "Claude-Sonnet-4-6", "claude-sonnet-4-6 "]) {
      expect(pricingModel("claude", null, alias, SHIPPED), alias).toBeNull();
    }
    // Exact for this backend: grok's name asked of claude is no price.
    expect(pricingModel("claude", null, "grok-4.7", SHIPPED)).toBeNull();
    expect(pricingModel("claude", null, null, SHIPPED)).toBeNull();
    // Nothing is looked up while the owner's file cannot be used.
    expect(pricingModel("claude", null, "claude-sonnet-4-6", { ...SHIPPED, owner: { state: "unusable", reason: "x" } })).toBeNull();
  });

  test("chargeTurn prices a requested name only as pricingModel allows, at that name's own rates", () => {
    const byRequest = chargeTurn(usage, "claude", null, SHIPPED, "claude-sonnet-4-6");
    // 1,000 × $3.00 + 100 × $15.00 per million tokens = 4,500 µ$.
    expect(byRequest.cost?.usd_micros).toBe(4_500);
    expect(byRequest.cost?.usd_micros_per_mtok).toEqual(SONNET);
    expect(chargeTurn(usage, "claude", null, SHIPPED, "sonnet")).toEqual({ cost: null, not_charged: "model-unknown" });
    expect(chargeTurn(usage, "claude", null, SHIPPED)).toEqual({ cost: null, not_charged: "model-unknown" });
    // A count missing is still the more basic reason.
    expect(chargeTurn(undefined, "claude", null, SHIPPED, "claude-sonnet-4-6").not_charged).toBe("not-recorded");
    expect(chargeTurn(usage, "claude", null, { ...SHIPPED, owner: { state: "unusable", reason: "x" } }, "claude-sonnet-4-6").not_charged).toBe("table-unusable");
  });
});
