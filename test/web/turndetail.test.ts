/** D-194 — a turn read back from `mind ledger show --json --content`: only what the ledger holds, nothing estimated. */

import { describe, expect, test } from "bun:test";
import { turnDetailFrom } from "../../src/web/turndetail.ts";
import { routeSentence } from "../../src/web/turninfo.ts";

const ID = "11111111-2222-3333-4444-555555555555";
const when = (iso: string) => `at ${iso}`;
const line = (extra: Record<string, unknown>) => ({
  id: ID, at: "2026-10-20T01:00:00.000Z", backend: "claude", model: "claude-opus-5-5", model_requested: "opus", content: "full",
  prompt: "q", text: "a", confidence: "confirmed", identity: "system", duration_ms: 2500, cost: null, ...extra,
});
const show = (...entries: unknown[]) => JSON.stringify({ subject: "x", entries });

describe("turnDetailFrom", () => {
  test("a reported turn carries route, usage, duration and the ledger's own price", () => {
    const usage = { status: "reported", input: 12, output: 34, total: 46, cache_read: 5, cache_write: null };
    const t = turnDetailFrom(show(line({ usage, cost: { usd_micros: 1234, table: "v1" } })), ID, when)!;
    expect(t).toMatchObject({ asked: "q", answer: "a", backend: "claude", model: "claude-opus-5-5", modelRequested: "opus", when: "at 2026-10-20T01:00:00.000Z", content: "full" });
    expect(t.route).toBe("answered by claude · identity arrived as system · 2.5s");
    expect(t.usage).toEqual({ input: 12, output: 34, cached: 5, total: 46 });
    expect(t.durationMs).toBe(2500);
    expect(t.costUsdMicros).toBe(1234);
  });

  test("a count the backend did not print stays absent, never 0; usage with no count is absent whole", () => {
    const partial = turnDetailFrom(show(line({ usage: { status: "reported", input: 3, output: null, total: null, cache_read: null } })), ID, when)!;
    expect(partial.usage).toEqual({ input: 3 });
    const none = turnDetailFrom(show(line({ usage: { status: "unreported", input: null, output: null, total: null, cache_read: null } })), ID, when)!;
    expect("usage" in none).toBe(false);
    expect("costUsdMicros" in none).toBe(false);
    const zero = turnDetailFrom(show(line({ usage: { input: 0 } })), ID, when)!;
    expect(zero.usage).toEqual({ input: 0 });
  });

  test("a line from before usage, price and duration existed has none of them", () => {
    const { usage: _u, cost: _c, duration_ms: _d, ...old } = line({}) as Record<string, unknown>;
    const t = turnDetailFrom(show(old), ID, when)!;
    for (const key of ["usage", "durationMs", "costUsdMicros"]) expect(key in t).toBe(false);
    expect(t.route).toBe("answered by claude · identity arrived as system · ?");
  });

  test("withheld text, an unanswered turn, and a model that is null", () => {
    const t = turnDetailFrom(show(line({ content: "withheld", prompt: null, text: null, confidence: "failed", model: null, model_requested: undefined })), ID, when)!;
    expect(t).toMatchObject({ asked: null, answer: null, content: "withheld", model: null, modelRequested: null });
    expect(t.route).toBe("no backend answered · 2.5s");
  });

  test("not found, other ids, and output that is not JSON are all undefined", () => {
    expect(turnDetailFrom(show(line({ id: "other" })), ID, when)).toBeUndefined();
    expect(turnDetailFrom("not json", ID, when)).toBeUndefined();
    expect(turnDetailFrom("[]", ID, when)).toBeUndefined();
    expect(turnDetailFrom(JSON.stringify({ entries: "x" }), ID, when)).toBeUndefined();
    expect(turnDetailFrom(show(null, 3, { id: ID }), ID, when)).toBeUndefined();
  });
});

describe("routeSentence", () => {
  test("is the sentence `mind turn` prints, with the trail when there is one", () => {
    expect(routeSentence({ answeredBy: "ollama", identity: "none", durationMs: 1200, trail: "claude: unavailable" })).toBe("answered by ollama · identity arrived as none · 1.2s · missed: claude: unavailable");
    expect(routeSentence({ answeredBy: null, identity: "none", durationMs: null, trail: "x" })).toBe("no backend answered · ? · x");
  });
});
