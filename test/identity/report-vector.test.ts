/**
 * A signed usage report, version 2, pinned for the platform's verifier (S16.4, platform PR #6) — S15.9, the
 * PR #3 review, and the binding of S15.4 step one (D-141).
 *
 * `test/fixtures/usage-report-v2.json` is exactly what `mind usage report --json --market
 * https://market.example --listing ts-reviewer` prints for the ledger lines below, signed with RFC 8032's
 * test-1 key (its public key is `test/fixtures/usage-report-v2.key`); `usage-report-v2-job.json` is the same
 * with `--job job_01`. Ed25519 is deterministic, so this test rebuilds each report from those lines and
 * requires the same bytes: a change to the row shape, the binding, the canonical JSON, the cost formula or the
 * table digest cannot pass quietly — it has to change the fixture, which the platform then sees.
 *
 * The rows are chosen to cover what a verifier has to get right:
 *
 * | row | what it pins |
 * |---|---|
 * | v2-claude | a charged claude row from the shipped table, every part used: 41850 µ$ exactly |
 * | v2-grok | grok's null cache-write rate with a cache-write count of 0 — still charged: 24000 µ$ |
 * | v2-ollama | a null-cache row (ollama prints none), priced from the owner's table with its digest, and a half rounded up: 1.5 → 2 µ$ |
 * | v2-haiku | a half rounded up on its own: 5 cache-read tokens at $0.10/MTok is 0.5 → 1 µ$ |
 * | v2-codex | not charged: one total, no parts (`usage-unsplit`) |
 *
 * Those two are priced from the shipped table `2026-09-28` — the default when they were made — and are
 * **byte-for-byte what they were before D-143**: their lines are rebuilt with that table named, and no row of
 * theirs wrote to the 1-hour cache, so none carries a field D-143 added. They still verify here, because this
 * build still carries `2026-09-28`, and the platform's copies of them still pass its own tests unchanged.
 *
 * `test/fixtures/usage-report-v2-split.json` (D-143) is priced from the table in force now, `2026-09-29`, with
 * the same key and binding, and pins what a verifier has to get right about a cache write split by cache:
 *
 * | row | what it pins |
 * |---|---|
 * | v2s-sonnet-split | 1,000 written to the 5-minute cache and 2,000 to the 1-hour one, each at its own rate: 46350 µ$; the row has `cache_write_1h_tokens` and its cost the rate `cache_write_1h` |
 * | v2s-haiku-1h | D-142's measured turn — every write to the 1-hour cache: 24047 µ$ (15155 at the 5-minute rate) |
 * | v2s-sonnet5-5m | a charged row from `2026-09-29` with only 5-minute writes: no new field, the shape a verifier from before D-143 reads |
 * | v2s-opus-unsplit | a write whose split claude did not print: not charged (`usage-unsplit`), and no split field |
 * | v2s-local-1h | the owner's own price with a 1-hour rate: charged, `owner`, NOT checked — 740 µ$ |
 * | v2s-owner-no1h | the owner's price with no 1-hour rate, and a 1-hour write: not charged (`price-unknown`), the split still on the row |
 *
 * To regenerate after a deliberate change: `MIND_WRITE_VECTOR=1 bun test test/identity/report-vector.test.ts`,
 * then say in the PR what changed, because the platform's copy has to change with it.
 */

import { describe, expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import { join, resolve } from "node:path";
import type { LedgerEntry } from "../../src/ledger/entry.ts";
import { costGroups, reportProblem, usagePayload, verifyUsageReport, type ReportBinding, type UsageReportPayload } from "../../src/identity/report.ts";
import { signEnvelope, verifyEnvelope } from "../../src/identity/sign.ts";
import { chargeTurn } from "../../src/pricing/cost.ts";
import { DEFAULT_PRICES, shippedTable, validatePriceTable, type PricesInForce, type PriceTable } from "../../src/pricing/table.ts";
import { subjectId, type Usage } from "../../src/types.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const REPORT = join(ROOT, "test", "fixtures", "usage-report-v2.json");
const REPORT_JOB = join(ROOT, "test", "fixtures", "usage-report-v2-job.json");
const REPORT_SPLIT = join(ROOT, "test", "fixtures", "usage-report-v2-split.json");
const KEY = join(ROOT, "test", "fixtures", "usage-report-v2.key");

/** Where the pinned reports are going (D-141 §2): one listing on one market, and in the second, one job. */
const BINDING: ReportBinding = { market: "https://market.example", listing: "ts-reviewer", job: null };
const BINDING_JOB: ReportBinding = { ...BINDING, job: "job_01" };

/** RFC 8032 §7.1, TEST 1 — the same seed `test/identity/sign.test.ts` pins. */
const RFC_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const rfcKey = () =>
  createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(RFC_SEED, "hex")]), format: "der", type: "pkcs8" });

/** The owner's table the ollama row is priced from: $0.10 in, $0.40 out per million tokens, no cache prices. */
const OWNER = (() => {
  const read = validatePriceTable({
    kind: "mind.price-table",
    v: 1,
    version: "vector-home-1",
    currency: "usd",
    unit: "micros-per-million-tokens",
    prices: [{ backend: "ollama", model: "qwen3:8b", input: 100_000, output: 400_000, cache_read: null, cache_write: null }],
  });
  if (!read.ok) throw new Error(read.reason);
  return read.table;
})();

/** The table the first two vectors were made from, when it was the default. */
const TABLE_0928: PriceTable = shippedTable("2026-09-28")!;
const PRICES: PricesInForce = { default: TABLE_0928, owner: { state: "ok", table: OWNER }, ownerPath: "/unused" };

/** Usage as claude writes it since D-143: every part, and the write split by cache — all 5-minute unless said. */
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

/** Usage as grok writes it: every part and its own total, and no split of a write — said so. */
const grokUsage = (fresh: number, cacheRead: number, cacheWrite: number, output: number, total: number): Usage => ({
  ...split(fresh, cacheRead, cacheWrite, output),
  total,
  cache_write_5m: null,
  cache_write_1h: null,
  not_printed: ["cache_write_5m", "cache_write_1h"],
});

/** One ledger line, priced the way RecordingExec prices it — so the vector is what a real turn would write. */
function line(n: number, name: string, backend: string, model: string | null, usage: Usage, prices: PricesInForce = PRICES, prefix = "v2"): LedgerEntry {
  const charge = chargeTurn(usage, backend, model, prices);
  return {
    v: 1,
    kind: "turn",
    id: `${prefix}-${name}`,
    turn: `${prefix}-turn-${n}`,
    at: `2026-09-2${n}T10:00:00.000Z`,
    subject: subjectId("vector"),
    backend,
    model,
    content: "withheld",
    prompt: null,
    prompt_bytes: 10,
    text: null,
    text_bytes: 10,
    confidence: "confirmed",
    exit: 0,
    duration_ms: 1000 + n,
    cost: charge.cost,
    not_charged: charge.not_charged,
    usage,
    identity: "system",
    soul_sha: null,
  };
}

const LINES: readonly LedgerEntry[] = [
  line(1, "claude", "claude", "claude-sonnet-4-6", split(1_200, 50_000, 3_000, 800)),
  line(2, "grok", "grok", "grok-4.7", grokUsage(10_000, 2_000, 0, 500, 12_500)),
  line(3, "ollama", "ollama", "qwen3:8b", {
    status: "reported",
    input: 11,
    output: 1,
    total: null,
    cache_read: null,
    cache_write: null,
    cache_write_5m: null,
    cache_write_1h: null,
    not_printed: ["cache_read", "cache_write", "cache_write_5m", "cache_write_1h"],
  }),
  line(4, "haiku", "claude", "claude-haiku-4-5", split(0, 5, 0, 0)),
  line(5, "codex", "codex", null, {
    status: "reported",
    input: null,
    output: null,
    total: 2243,
    cache_read: null,
    cache_write: null,
    cache_write_5m: null,
    cache_write_1h: null,
    not_printed: ["input", "output", "cache_read", "cache_write", "cache_write_5m", "cache_write_1h"],
  }),
];

/**
 * The owner's table the split vector's owner rows are priced from (D-143): a local model with a 1-hour rate, and
 * a subscription holder's zero price for a claude model written before D-143 — no 1-hour rate.
 */
const OWNER_SPLIT = (() => {
  const read = validatePriceTable({
    kind: "mind.price-table",
    v: 1,
    version: "vector-home-2",
    currency: "usd",
    unit: "micros-per-million-tokens",
    prices: [
      { backend: "claude-local", model: "local-coder", input: 100_000, output: 400_000, cache_read: 10_000, cache_write: 125_000, cache_write_1h: 200_000 },
      { backend: "claude", model: "claude-sonnet-4-5", input: 0, output: 0, cache_read: 0, cache_write: 0 },
    ],
  });
  if (!read.ok) throw new Error(read.reason);
  return read.table;
})();

const PRICES_NOW: PricesInForce = { default: DEFAULT_PRICES, owner: { state: "ok", table: OWNER_SPLIT }, ownerPath: "/unused" };

const splitLine = (n: number, name: string, backend: string, model: string, usage: Usage) => line(n, name, backend, model, usage, PRICES_NOW, "v2s");

const LINES_SPLIT: readonly LedgerEntry[] = [
  splitLine(1, "sonnet-split", "claude", "claude-sonnet-4-6", split(1_200, 50_000, 3_000, 800, 2_000)),
  splitLine(2, "haiku-1h", "claude", "claude-haiku-4-5", split(10, 0, 11_856, 65, 11_856)),
  splitLine(3, "sonnet5-5m", "claude", "claude-sonnet-5", split(100, 0, 1_000, 10)),
  splitLine(4, "opus-unsplit", "claude", "claude-opus-5-5", { ...split(10, 0, 500, 5), cache_write_5m: null, cache_write_1h: null }),
  splitLine(5, "local-1h", "claude-local", "local-coder", split(1_000, 0, 3_000, 100, 3_000)),
  splitLine(6, "owner-no1h", "claude", "claude-sonnet-4-5", split(10, 0, 400, 5, 300)),
];

/** As `usage report --json` prints it: one compact line (PR #3 review, R6). */
function build(binding: ReportBinding = BINDING, lines: readonly LedgerEntry[] = LINES): string {
  const { payload } = usagePayload(lines, {}, new Date("2026-09-28T00:00:00.000Z"), binding);
  return `${JSON.stringify(signEnvelope(payload, rfcKey()))}\n`;
}

describe("the pinned v2 usage report (for the platform's verifier)", () => {
  test("this build makes exactly the committed bytes, and they verify against the committed key", async () => {
    const made = build();
    const madeJob = build(BINDING_JOB);
    const madeSplit = build(BINDING, LINES_SPLIT);
    if (process.env["MIND_WRITE_VECTOR"] === "1") {
      await Bun.write(REPORT, made);
      await Bun.write(REPORT_JOB, madeJob);
      await Bun.write(REPORT_SPLIT, madeSplit);
      await Bun.write(KEY, `${(JSON.parse(made) as { publicKey: string }).publicKey}\n`);
    }
    const text = await Bun.file(REPORT).text();
    expect(made).toBe(text);
    expect(madeJob).toBe(await Bun.file(REPORT_JOB).text());
    expect(madeSplit).toBe(await Bun.file(REPORT_SPLIT).text());
    const key = (await Bun.file(KEY).text()).trim();
    expect(key).toBe("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo");
    const checked = verifyUsageReport(text, key);
    expect(checked.ok).toBe(true);
    expect(verifyUsageReport(madeSplit, key).ok).toBe(true);
    // D-143 left the first two as they were: nothing in them is new.
    for (const old of [text, madeJob]) {
      expect(old).not.toContain("cache_write_1h");
      expect(old).not.toContain("2026-09-29");
    }
    // One compact line, the binding before the rows, as `usage report --json` prints it.
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain('"binding":{"market":"https://market.example","listing":"ts-reviewer","job":null},"rows":[');
    expect(madeJob).toContain('"binding":{"market":"https://market.example","listing":"ts-reviewer","job":"job_01"},"rows":[');
  });

  test("the binding is held: the market and listing named pass, any other — or none — is not valid (D-141 §2)", async () => {
    const key = (await Bun.file(KEY).text()).trim();
    const text = await Bun.file(REPORT).text();
    const withJob = await Bun.file(REPORT_JOB).text();
    const pins = { market: "https://market.example", listing: "ts-reviewer" };
    for (const report of [text, withJob]) expect(verifyUsageReport(report, key, pins).ok).toBe(true);
    const payloadOf = (report: string) => {
      const checked = verifyUsageReport(report, key, pins);
      if (!checked.ok) throw new Error(checked.reason);
      return checked.payload;
    };
    expect(payloadOf(text).binding).toEqual(BINDING);
    expect(payloadOf(withJob).binding).toEqual(BINDING_JOB);
    // M3: one report, one listing. The same signed bytes are refused when held to anywhere else.
    const other = verifyUsageReport(text, key, { ...pins, listing: "ts-reviewer-2" });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toContain("another listing: ts-reviewer, not ts-reviewer-2");
    const market = verifyUsageReport(text, key, { ...pins, market: "https://market.example:8443" });
    expect(market.ok).toBe(false);
    if (!market.ok) expect(market.reason).toContain("another market");
    // A binding changed after signing is a payload changed after signing.
    const moved = verifyUsageReport(text.replace('"listing":"ts-reviewer"', '"listing":"ts-reviewer-2"'), key);
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.reason).toContain("signature does not match");
    // A canonical-number respelling keeps the signature valid — the canonical bytes are the same — and is
    // refused by the strict reader (D-141 §4). The platform's verifier must refuse it too.
    for (const respelled of [text.replace('"usd_micros":41850,', '"usd_micros":41850.0,'), text.replace('"usd_micros":41850,', '"usd_micros":4.185e4,')]) {
      expect(respelled).not.toBe(text);
      expect(verifyEnvelope(JSON.parse(respelled), key).ok).toBe(true);
      const read = verifyUsageReport(respelled, key);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.reason).toContain("fraction or an exponent");
    }
  });

  test("its rows are the cases a verifier has to get right, at the figures worked out by hand", async () => {
    const checked = verifyUsageReport(await Bun.file(REPORT).text(), (await Bun.file(KEY).text()).trim());
    if (!checked.ok) throw new Error(checked.reason);
    const payload: UsageReportPayload = checked.payload;
    expect(payload.v).toBe(2);
    expect(payload.rows.map((r) => [r.id, r.cost?.usd_micros ?? null, r.not_charged])).toEqual([
      // 1200×3000000 + 50000×300000 + 3000×3750000 + 800×15000000 = 41,850,000,000 → 41850
      ["v2-claude", 41_850, null],
      // 10000×2000000 + 2000×500000 + 0×(null) + 500×6000000 = 24,000,000,000 → 24000
      ["v2-grok", 24_000, null],
      // 11×100000 + 1×400000 = 1,500,000 → 1.5 → 2
      ["v2-ollama", 2, null],
      // 5×100000 = 500,000 → 0.5 → 1
      ["v2-haiku", 1, null],
      ["v2-codex", null, "usage-unsplit"],
    ]);
    const grok = payload.rows[1]!;
    expect(grok.cost!.usd_micros_per_mtok.cache_write).toBeNull();
    expect(grok.cache_write_tokens).toBe(0);
    const ollama = payload.rows[2]!;
    expect([ollama.cache_read_tokens, ollama.cache_write_tokens]).toEqual([null, null]);
    expect(ollama.cost).toMatchObject({ source: "owner", table: "vector-home-1", table_digest: OWNER.digest });
    expect(costGroups(payload.rows).map((g) => [g.backend, g.model, g.check])).toEqual([
      ["claude", "claude-haiku-4-5", "shipped"],
      ["claude", "claude-sonnet-4-6", "shipped"],
      ["grok", "grok-4.7", "shipped"],
      ["ollama", "qwen3:8b", "owner"],
    ]);
  });

  test("D-143: the split vector's rows, at the figures worked out by hand", async () => {
    const checked = verifyUsageReport(await Bun.file(REPORT_SPLIT).text(), (await Bun.file(KEY).text()).trim(), {
      market: "https://market.example",
      listing: "ts-reviewer",
    });
    if (!checked.ok) throw new Error(checked.reason);
    const rows = checked.payload.rows;
    expect(rows.map((r) => [r.id, r.cache_write_tokens, r.cache_write_1h_tokens ?? null, r.cost?.usd_micros ?? null, r.not_charged])).toEqual([
      // 1200×3000000 + 50000×300000 + 1000×3750000 + 2000×6000000 + 800×15000000 = 46,350,000,000 → 46350
      ["v2s-sonnet-split", 3_000, 2_000, 46_350, null],
      // 10×1000000 + 11856×2000000 + 65×5000000 = 24,047,000,000 → 24047
      ["v2s-haiku-1h", 11_856, 11_856, 24_047, null],
      // 100×2000000 + 1000×2500000 + 10×10000000 = 2,800,000,000 → 2800
      ["v2s-sonnet5-5m", 1_000, null, 2_800, null],
      ["v2s-opus-unsplit", 500, null, null, "usage-unsplit"],
      // 1000×100000 + 3000×200000 + 100×400000 = 740,000,000 → 740
      ["v2s-local-1h", 3_000, 3_000, 740, null],
      ["v2s-owner-no1h", 400, 300, null, "price-unknown"],
    ]);
    // The new fields only where a 1-hour write is: the 1-hour rate beside the 1-hour tokens, nowhere else.
    for (const row of rows) {
      expect("cache_write_1h_tokens" in row).toBe(row.cache_write_1h_tokens !== undefined);
      if (row.cost !== null) expect("cache_write_1h" in row.cost.usd_micros_per_mtok, row.id).toBe("cache_write_1h_tokens" in row);
    }
    expect(rows[0]!.cost!.usd_micros_per_mtok).toEqual({ input: 3_000_000, output: 15_000_000, cache_read: 300_000, cache_write: 3_750_000, cache_write_1h: 6_000_000 });
    expect(rows[2]!.cost!.usd_micros_per_mtok).toEqual({ input: 2_000_000, output: 10_000_000, cache_read: 200_000, cache_write: 2_500_000 });
    expect(Object.keys(rows[2]!)).toEqual(Object.keys(rows[3]!));
    expect(costGroups(rows).map((g) => [g.backend, g.model, g.table, g.check])).toEqual([
      ["claude", "claude-haiku-4-5", "2026-09-29", "shipped"],
      ["claude", "claude-sonnet-4-6", "2026-09-29", "shipped"],
      ["claude", "claude-sonnet-5", "2026-09-29", "shipped"],
      ["claude-local", "local-coder", "vector-home-2", "owner"],
    ]);
  });

  test("D-143: a verifier holds the split — every way to misstate it is refused", async () => {
    const checked = verifyUsageReport(await Bun.file(REPORT_SPLIT).text(), (await Bun.file(KEY).text()).trim());
    if (!checked.ok) throw new Error(checked.reason);
    const payload = checked.payload;
    const splitRow = payload.rows[0]!;
    const fiveMinute = payload.rows[2]!;
    const cost = splitRow.cost!;
    const { cache_write_1h: _rate, ...fourRates } = cost.usd_micros_per_mtok;
    // What `usage verify` runs on a signed payload, run on the payload itself: a signature changes none of it.
    const refused = (rows: readonly unknown[], why: string) => expect(reportProblem({ ...payload, rows }), why).toContain(why);
    // Priced as if every write were 5-minute: the 1-hour tokens are on the row, so the sum is not this.
    refused([{ ...splitRow, cost: { ...cost, usd_micros: 41_850, usd_micros_per_mtok: fourRates } }], "usd_micros_per_mtok is not exactly");
    refused([{ ...splitRow, cost: { ...cost, usd_micros: 41_850 } }], "its own counts at its own rates come to 46350");
    // The split dropped from the row, the 1-hour rate left in the cost.
    const { cache_write_1h_tokens: _tokens, ...dropped } = splitRow;
    refused([dropped], "is there only on a row with cache_write_1h_tokens");
    // A zero, more than the write, a fraction, a quoted count: not a part of the write.
    refused([{ ...splitRow, cache_write_1h_tokens: 0 }], "cache_write_1h_tokens is not a whole number of 1 or more");
    refused([{ ...splitRow, cache_write_1h_tokens: 1.5 }], "cache_write_1h_tokens is not a whole number of 1 or more");
    refused([{ ...splitRow, cache_write_1h_tokens: "2000" }], "cache_write_1h_tokens is not a whole number of 1 or more");
    refused([{ ...splitRow, cache_write_1h_tokens: 3_001 }], "more than cache_write_tokens");
    refused([{ ...splitRow, cache_write_tokens: null }], "more than cache_write_tokens");
    // The 1-hour rate on a row that wrote no 1-hour cache.
    const fiveCost = fiveMinute.cost!;
    refused([{ ...fiveMinute, cost: { ...fiveCost, usd_micros_per_mtok: { ...fiveCost.usd_micros_per_mtok, cache_write_1h: 4_000_000 } } }], "is there only on a row with");
    // The shipped table's 1-hour rate, understated — arithmetic right at the false rate.
    refused([{ ...splitRow, cost: { ...cost, usd_micros: 41_850, usd_micros_per_mtok: { ...fourRates, cache_write_1h: 3_750_000 } } }], "cache_write_1h at 6000000 µ$/MTok, not 3750000");
    // A 1-hour rate claimed from 2026-09-28, which has none.
    const old = shippedTable("2026-09-28")!;
    refused([{ ...splitRow, cost: { ...cost, table: old.version, table_digest: old.digest } }], "cache_write_1h at nothing, not 6000000");
    // Two 1-hour rates for one model from one table: which one is true is not knowable.
    const owned = { ...cost, source: "owner" as const, table: "home-1", table_digest: "00112233aabbccdd" };
    const cheaper = { ...owned, usd_micros: 41_850, usd_micros_per_mtok: { ...fourRates, cache_write_1h: 3_750_000 } };
    expect(reportProblem({ ...payload, rows: [{ ...splitRow, cost: owned }] })).toBeUndefined();
    refused([{ ...splitRow, cost: owned }, { ...splitRow, id: "twice", cost: cheaper }], "at two different sets of rates");
    // One row with the 1-hour rate and one without, from one table's one price, is one claim, not two:
    // 100×$3 + 1,000×$3.75 + 10×$15 per million tokens = 4,200 µ$.
    expect(reportProblem({ ...payload, rows: [splitRow, { ...fiveMinute, id: "5m", model: "claude-sonnet-4-6", cost: { ...fiveCost, usd_micros_per_mtok: fourRates, usd_micros: 4_200 } }] })).toBeUndefined();
  });
});

describe("what the engine emits is the fixture, byte for byte", () => {
  test("the signed bytes equal usage-report-v2.json, whose kind is mind.usage-report", async () => {
    const text = await Bun.file(REPORT).text();
    expect((JSON.parse(text) as { payload: { kind: string } }).payload.kind).toBe("mind.usage-report");
    expect(build()).toBe(text);
  });
});
