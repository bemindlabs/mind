/**
 * One line of the ledger, and the two properties the whole format rests on.
 *
 * The first is that a line is a line: a prompt with twenty newlines in it must
 * still occupy exactly one, or a crash mid-write would leave something that
 * parses as a complete record of a turn that did not finish.
 *
 * The second is that `content: "withheld"` is a fact rather than a label. If a
 * `--private` line could carry the text it claims not to have, the flag would
 * be documentation instead of a guarantee, and the owner would have no way to
 * tell the two apart by looking.
 */

import { describe, expect, test } from "bun:test";
import {
  byteLength,
  formatLine,
  LEDGER_VERSION,
  parseLine,
  type LedgerEntry,
} from "../../src/ledger/entry.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("example");

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    v: LEDGER_VERSION,
    kind: "turn",
    id: "11111111-1111-4111-8111-111111111111",
    turn: "22222222-2222-4222-8222-222222222222",
    at: "2026-09-21T10:00:00.000Z",
    subject: SUBJECT,
    backend: "ollama",
    model: "stub",
    content: "full",
    prompt: "hello",
    prompt_bytes: 5,
    text: "hi",
    text_bytes: 2,
    confidence: "confirmed",
    exit: null,
    duration_ms: 42,
    cost: null,
    identity: "system",
    soul_sha: "a".repeat(64),
    ...overrides,
  } as LedgerEntry;
}

describe("a ledger line", () => {
  test("round-trips through format and parse", () => {
    const original = entry();
    const parsed = parseLine(formatLine(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.entry).toEqual(original);
  });

  test("a multi-line prompt still occupies exactly one line", () => {
    const line = formatLine(entry({ prompt: "one\ntwo\nthree", prompt_bytes: 13 }));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);

    const parsed = parseLine(line);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.entry.prompt).toBe("one\ntwo\nthree");
  });

  test("byteLength counts UTF-8 bytes, not characters", () => {
    // The size of a `--private` prompt is recorded when its text is not, so
    // the number has to mean something a human could check with `wc -c`.
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("สวัสดี")).toBe(18);
  });

  test("a withheld line carrying text is refused, not accepted and trusted", () => {
    const bad = formatLine(entry({ content: "withheld" }));
    const parsed = parseLine(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("withheld");
  });

  test("a genuine withheld line keeps the sizes and drops the text", () => {
    const parsed = parseLine(
      formatLine(entry({ content: "withheld", prompt: null, text: null })),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.entry.prompt).toBeNull();
      expect(parsed.entry.text).toBeNull();
      expect(parsed.entry.prompt_bytes).toBe(5);
      // Nothing that could be reversed into the prompt. A sha256 of a short
      // prompt is guessable, so the format carries no digest of one — the
      // only hash in a line is of the soul, which is in git anyway.
      expect(Object.keys(parsed.entry).filter((key) => key.includes("sha"))).toEqual(["soul_sha"]);
    }
  });

  test("a line from before S15.9 — cost null, no reason — still parses, and is not read as charged", () => {
    // Every line written before turns were priced. D-023 kept money off the
    // line; D-110 put Mind's own arithmetic on it, with the table it came
    // from. The old lines stay readable, or `forget` could not delete them.
    const parsed = parseLine(formatLine(entry()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.entry.cost).toBeNull();
      expect(parsed.entry.not_charged).toBeUndefined();
    }
  });

  test.each([
    ["not JSON at all", "{nope", "not JSON"],
    ["an array", "[1,2]", "not a JSON object"],
    ["a future schema version", JSON.stringify({ ...entry(), v: 2 }), "schema version"],
    ["an unknown kind", JSON.stringify({ ...entry(), kind: "proposal" }), "unknown kind"],
    ["a subject that is not one", JSON.stringify({ ...entry(), subject: "Not A Subject" }), "subject"],
    ["a missing backend", JSON.stringify({ ...entry(), backend: "" }), "backend"],
    ["a bogus confidence", JSON.stringify({ ...entry(), confidence: "maybe" }), "confidence"],
    ["a bogus identity", JSON.stringify({ ...entry(), identity: "strong" }), "identity"],
    ["a non-numeric duration", JSON.stringify({ ...entry(), duration_ms: "42" }), "duration_ms"],
    ["a fractional byte count", JSON.stringify({ ...entry(), prompt_bytes: 1.5 }), "prompt_bytes"],
    ["a blank line", "   ", "blank"],
  ])("refuses %s, and says why", (_name, line, reason) => {
    const parsed = parseLine(line);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });
});

describe("a line's account of what the turn used", () => {
  const usage = { status: "reported", input: 15, output: 24, total: null } as const;

  test("round-trips, zeros included", () => {
    const parsed = parseLine(formatLine(entry({ usage })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.entry.usage).toEqual(usage);

    const zeros = parseLine(
      formatLine(entry({ usage: { status: "reported", input: 0, output: 0, total: 0 } })),
    );
    expect(zeros.ok).toBe(true);
    if (zeros.ok) expect(zeros.entry.usage?.input).toBe(0);
  });

  test("a line written before this field existed still parses (I-4)", () => {
    // This is the whole reason the field is optional on read. Every line in a
    // real ledger predates it. If `parseLine` refused them, `ledger show`
    // would count them as unreadable and `ledger forget` — which only deletes
    // lines it could read — would leave them on disk while reporting success.
    // A schema change is a strange way to take away the right to withdraw.
    const { usage: _omitted, ...withoutUsage } = entry({ usage });
    expect("usage" in withoutUsage).toBe(false);

    const parsed = parseLine(`${JSON.stringify(withoutUsage)}\n`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.entry.usage).toBeUndefined();
  });

  test("`unreported` and an absent field are two different facts", () => {
    // "written by a backend nobody has surveyed" is not "written before there
    // was anywhere to say so", and a reader has to be able to tell them apart.
    const unreported = parseLine(
      formatLine(entry({ usage: { status: "unreported", input: null, output: null, total: null } })),
    );
    expect(unreported.ok).toBe(true);
    if (unreported.ok) expect(unreported.entry.usage?.status).toBe("unreported");
  });

  test.each([
    ["a status nobody defined", { status: "free", input: null, output: null, total: null }, "usage status"],
    ["a quoted count", { status: "reported", input: "15", output: 24, total: null }, "usage.input"],
    ["a negative count", { status: "reported", input: 15, output: -1, total: null }, "usage.output"],
    ["a fractional count", { status: "reported", input: 15, output: 24, total: 1.5 }, "usage.total"],
    ["a usage that is not an object", "reported", "not an object"],
    ["a usage that is an array", [15, 24], "not an object"],
  ])("refuses %s, and says why", (_name, usageValue, reason) => {
    const parsed = parseLine(JSON.stringify({ ...entry(), usage: usageValue }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });
});

describe("a line's cost (S15.9, D-110, D-139)", () => {
  const cost = {
    usd_micros: 1_234,
    table: "2026-09-28",
    table_digest: "0123456789abcdef",
    source: "default",
    usd_micros_per_mtok: { input: 3_000_000, output: 15_000_000, cache_read: 300_000, cache_write: 3_750_000 },
  } as const;

  test("a charge round-trips, with its table and every rate it applied", () => {
    const parsed = parseLine(formatLine(entry({ cost, not_charged: null })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.entry.cost).toEqual(cost);
  });

  test("not charged is null and a reason — each reason round-trips", () => {
    for (const reason of ["usage-missing", "usage-unsplit", "model-unknown", "table-unusable", "price-unknown"] as const) {
      const parsed = parseLine(formatLine(entry({ cost: null, not_charged: reason })));
      expect(parsed.ok, reason).toBe(true);
    }
  });

  test("the cache counts and what a backend never prints round-trip", () => {
    const usage = { status: "reported", input: 90, output: 4, total: null, cache_read: 80, cache_write: 0, not_printed: ["cache_write"] } as const;
    const parsed = parseLine(formatLine(entry({ usage })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.entry.usage).toEqual(usage);
  });

  test("D-143: the split of a cache write and the 1-hour rate round-trip; a line from before them still reads", () => {
    const usage = { status: "reported", input: 310, output: 4, total: null, cache_read: 0, cache_write: 300, cache_write_5m: 100, cache_write_1h: 200, not_printed: [] } as const;
    const unknown = { ...usage, cache_write_5m: null, cache_write_1h: null } as const;
    const never = { ...unknown, not_printed: ["cache_write_5m", "cache_write_1h"] } as const;
    const oneHour = { ...cost, usd_micros_per_mtok: { ...cost.usd_micros_per_mtok, cache_write_1h: 6_000_000 } };
    for (const line of [entry({ usage, cost: oneHour, not_charged: null }), entry({ usage: unknown }), entry({ usage: never }), entry({ cost, not_charged: null })]) {
      const parsed = parseLine(formatLine(line));
      expect(parsed.ok, JSON.stringify(line.usage)).toBe(true);
      if (parsed.ok) expect(parsed.entry).toEqual(line);
    }
  });

  test.each([
    ["a cost in dollars as a number", 0.81, undefined, "cost is not null or"],
    ["a cost and a reason not to charge it", cost, "usage-missing", "not_charged must be null"],
    ["a cost with no reason field at all", cost, "absent", "not_charged must be null"],
    ["a null cost and a null reason", null, null, "gives no reason"],
    ["a reason nobody defined", null, "too-expensive", "unknown not_charged"],
    ["a fractional micro-dollar", { ...cost, usd_micros: 1.5 }, null, "usd_micros"],
    ["a table version with a newline", { ...cost, table: "a\nb" }, null, "cost.table"],
    ["a source nobody defined", { ...cost, source: "vendor" }, null, "cost.source"],
    ["a cost with no table digest", (({ table_digest: _d, ...rest }) => rest)(cost), null, "cost is not null or"],
    ["a table digest that is not 16 hex", { ...cost, table_digest: "ABCDEF0123456789" }, null, "cost.table_digest"],
    ["a rate missing", { ...cost, usd_micros_per_mtok: { input: 1, output: 1, cache_read: 1 } }, null, "usd_micros_per_mtok is not"],
    ["a negative rate", { ...cost, usd_micros_per_mtok: { ...cost.usd_micros_per_mtok, output: -1 } }, null, "usd_micros_per_mtok.output"],
    ["an extra field", { ...cost, vendor_quoted_usd: 0.81 }, null, "cost is not null or"],
    ["a rate nobody defined", { ...cost, usd_micros_per_mtok: { ...cost.usd_micros_per_mtok, cache_write_2h: 1 } }, null, "usd_micros_per_mtok is not"],
    ["a fractional 1-hour rate", { ...cost, usd_micros_per_mtok: { ...cost.usd_micros_per_mtok, cache_write_1h: 1.5 } }, null, "usd_micros_per_mtok.cache_write_1h"],
  ])("refuses %s, and says why", (_name, costValue, notCharged, reason) => {
    const base = { ...entry(), cost: costValue } as Record<string, unknown>;
    if (notCharged !== "absent") base["not_charged"] = notCharged;
    const parsed = parseLine(JSON.stringify(base));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });

  test.each([
    ["a quoted cache count", { status: "reported", input: 1, output: 1, total: null, cache_read: "1" }, "usage.cache_read"],
    ["a negative cache write", { status: "reported", input: 1, output: 1, total: null, cache_write: -1 }, "usage.cache_write"],
    ["a quoted 1-hour write", { status: "reported", input: 1, output: 1, total: null, cache_write: 1, cache_write_1h: "1" }, "usage.cache_write_1h"],
    ["a fractional 5-minute write", { status: "reported", input: 1, output: 1, total: null, cache_write: 1, cache_write_5m: 0.5 }, "usage.cache_write_5m"],
    ["a field nobody prints", { status: "reported", input: 1, output: 1, total: null, not_printed: ["dollars"] }, "not_printed"],
    ["not_printed that is not a list", { status: "reported", input: 1, output: 1, total: null, not_printed: "cache_read" }, "not_printed"],
  ])("refuses usage with %s", (_name, usageValue, reason) => {
    const parsed = parseLine(JSON.stringify({ ...entry(), usage: usageValue }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });
});
