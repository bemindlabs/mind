/**
 * The usage report S15.8 signs (S15.4 minimum, D-106, D-110): per model delivery, from the ledger, and
 * nothing that was said.
 *
 * The leak test does not check a list of forbidden fields — that list would be as incomplete as the ledger is
 * young. It plants a different canary in every string a ledger line carries (prompt, answer, subject, soul
 * hash, a peer's name, a chat user's id) and requires that none of them appears anywhere in the signed
 * envelope, and it holds a row to exactly the fields the report names.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvelope, signEnvelope } from "../../src/identity/sign.ts";
import { generateKeyPairSync } from "node:crypto";
import {
  buildUsageReport,
  checkUsageReport,
  costGroups,
  isIsoInstant,
  isModelBackend,
  isModelName,
  printable,
  reportProblem,
  reportRows,
  USAGE_ROW_FIELDS,
  usagePayload,
  usageRow,
  usageTotals,
  USAGE_REPORT_KIND,
  verifyUsageReport,
} from "../../src/identity/report.ts";
import { append, ledgerDir, type LedgerEntry, type LedgerEnv } from "../../src/ledger/index.ts";
import { DEFAULT_PRICES } from "../../src/pricing/table.ts";
import { subjectId, type Usage } from "../../src/types.ts";

const SUBJECT = subjectId("canary-subject-7q2");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

let serial = 0;

/** A ledger line with a canary in every text field it has. */
function line(backend: string, at: string, usage?: Usage, withheld = false): LedgerEntry {
  serial++;
  return {
    v: 1,
    kind: "turn",
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    turn: `11111111-0000-4000-8000-${String(serial).padStart(12, "0")}`,
    at,
    subject: SUBJECT,
    backend,
    model: backend === "ollama" ? null : "some-model",
    content: withheld ? "withheld" : "full",
    prompt: withheld ? null : `CANARY-PROMPT-${serial}`,
    prompt_bytes: 987_654 + serial,
    text: withheld ? null : `CANARY-ANSWER-${serial}`,
    text_bytes: 876_543 + serial,
    confidence: "confirmed",
    exit: 0,
    duration_ms: 1200,
    cost: null,
    ...(usage === undefined ? {} : { usage }),
    identity: "system",
    soul_sha: "CANARYSOULSHA0000",
  };
}

const reported = (input: number | null, output: number | null): Usage => ({ status: "reported", input, output, total: null });

/** Sonnet 4.6's list price, as the shipped table has it. */
const SONNET = { input: 3_000_000, output: 15_000_000, cache_read: 300_000, cache_write: 3_750_000 };

/** A priced line, as RecordingExec writes one since S15.9: counts split, a cost and the rates behind it. */
function charged(at: string): LedgerEntry {
  const usage: Usage = { status: "reported", input: 80_953, output: 4, total: null, cache_read: 0, cache_write: 80_951, not_printed: [] };
  return {
    ...line("claude", at, usage),
    model: "claude-sonnet-4-6",
    cost: { usd_micros: 303_632, table: DEFAULT_PRICES.version, table_digest: DEFAULT_PRICES.digest, source: "default", usd_micros_per_mtok: SONNET },
    not_charged: null,
  };
}

describe("a row is named fields, and only model turns are rows", () => {
  test("exactly the report's fields, copied — never a text field, a size or the subject", () => {
    const entry = line("claude", "2026-09-20T10:00:00.000Z", reported(108_921, 2_624));
    const row = usageRow(entry)!;
    expect(Object.keys(row)).toEqual([...USAGE_ROW_FIELDS]);
    expect(row).toEqual({
      id: entry.id,
      turn: entry.turn,
      at: entry.at,
      duration_ms: 1200,
      backend: "claude",
      model: "some-model",
      input_tokens: 108_921,
      output_tokens: 2_624,
      cache_read_tokens: null,
      cache_write_tokens: null,
      usage: "reported",
      // Written before S15.9: never priced, and not priced now.
      cost: null,
      not_charged: "not-recorded",
    });
  });

  test("S15.9: a priced line's row carries the cache counts, the cost, and the table and rates it came from", () => {
    const entry = charged("2026-09-20T10:00:00.000Z");
    const row = usageRow(entry)!;
    expect(Object.keys(row)).toEqual([...USAGE_ROW_FIELDS]);
    expect(row).toMatchObject({
      input_tokens: 80_953,
      cache_read_tokens: 0,
      cache_write_tokens: 80_951,
      output_tokens: 4,
      cost: { usd_micros: 303_632, table: DEFAULT_PRICES.version, table_digest: DEFAULT_PRICES.digest, source: "default", usd_micros_per_mtok: SONNET },
      not_charged: null,
    });
    // Copied by name, not handed on: the row's cost is not the line's object.
    expect(row.cost).not.toBe(entry.cost);
    expect(row.cost!.usd_micros_per_mtok).not.toBe(entry.cost!.usd_micros_per_mtok);
    // A line not charged keeps its reason.
    expect(usageRow({ ...line("ollama", "2026-09-20T10:00:00.000Z", reported(1, 1)), not_charged: "price-unknown" })!.not_charged).toBe("price-unknown");
  });

  test("D-143: a line that wrote to the 1-hour cache gives its row that part, after cache_write_tokens; no other line does", () => {
    const usage: Usage = { status: "reported", input: 3_010, output: 5, total: null, cache_read: 0, cache_write: 3_000, cache_write_5m: 1_000, cache_write_1h: 2_000, not_printed: [] };
    const rates = { ...SONNET, cache_write_1h: 6_000_000 };
    // 10×$3 + 1,000×$3.75 + 2,000×$6 + 5×$15 per million tokens = 30 + 3,750 + 12,000 + 75 = 15,855 µ$.
    const cost = { usd_micros: 15_855, table: DEFAULT_PRICES.version, table_digest: DEFAULT_PRICES.digest, source: "default" as const, usd_micros_per_mtok: rates };
    const split = { ...line("claude", "2026-09-20T10:00:00.000Z", usage), model: "claude-sonnet-4-6", cost, not_charged: null };
    const row = usageRow(split)!;
    expect(Object.keys(row)).toEqual([...USAGE_ROW_FIELDS.slice(0, 10), "cache_write_1h_tokens", ...USAGE_ROW_FIELDS.slice(10)]);
    expect(row.cache_write_1h_tokens).toBe(2_000);
    expect(row.cost!.usd_micros_per_mtok).toEqual(rates);
    expect(row.cost!.usd_micros_per_mtok).not.toBe(rates);
    // All 5-minute, the split unknown, or the split not adding up: no field, and exactly the row's old shape.
    for (const other of [
      { ...usage, cache_write_5m: 3_000, cache_write_1h: 0 },
      { ...usage, cache_write_5m: null, cache_write_1h: null },
      { ...usage, cache_write_5m: 5, cache_write_1h: 2_000 },
    ]) {
      expect(Object.keys(usageRow(line("claude", "2026-09-20T10:00:00.000Z", other))!), JSON.stringify(other)).toEqual([...USAGE_ROW_FIELDS]);
    }
    // Not charged, the split is still a count the row carries.
    const unpriced = usageRow({ ...line("claude", "2026-09-20T10:00:00.000Z", usage), not_charged: "price-unknown" })!;
    expect([unpriced.cache_write_1h_tokens, unpriced.cost]).toEqual([2_000, null]);
    // A line that says it priced the 1-hour part at the 5-minute rate does not check, and is left out.
    const cheap = { ...split, cost: { ...cost, usd_micros: 11_355, usd_micros_per_mtok: SONNET } };
    expect(usageRow(cheap)).toBeUndefined();
    const totals = usageTotals([row, unpriced]);
    expect([totals.cacheWrite, totals.cacheWrite1h]).toEqual([6_000n, 4_000n]);
    // One claim with a row that applied the 1-hour rate and one that did not: one group, showing the rate.
    expect(costGroups([usageRow(charged("2026-09-20T11:00:00.000Z"))!, row])).toMatchObject([{ model: "claude-sonnet-4-6", rows: 2, rates }]);
  });

  test("D-142: a row names the model its price was looked up by — the requested name only on a line it priced", () => {
    // Charged while claude named no model: the requested name was exactly the table's, and priced the line. The
    // row must name it, or no reader could check the rates against the shipped table.
    const byRequest = { ...charged("2026-09-20T10:00:00.000Z"), model: null, model_requested: "claude-sonnet-4-6" };
    // `usageRow` returns a row only when every check a reader makes passes — the shipped table's rates for this
    // backend and model among them — so a defined row is one `usage verify` accepts.
    const row = usageRow(byRequest);
    expect(row?.model).toBe("claude-sonnet-4-6");
    const { payload, facts } = usagePayload([byRequest], {}, new Date("2026-09-21T00:00:00.000Z"));
    expect(payload.rows.map((r) => r.model)).toEqual(["claude-sonnet-4-6"]);
    expect(facts.costRefused).toBe(0);
    // The model the backend reported wins over the request, as it did when the line was priced.
    expect(usageRow({ ...charged("2026-09-20T10:00:00.000Z"), model_requested: "sonnet" })!.model).toBe("claude-sonnet-4-6");
    // Not charged: the request is not a model the backend ran, and the row does not say it is.
    const asked = { ...line("claude", "2026-09-20T10:00:00.000Z", reported(1, 1)), model: null, model_requested: "opus", not_charged: "model-unknown" as const };
    expect(usageRow(asked)!.model).toBeNull();
    // A line from before D-142 has no request at all, and reads as it did.
    expect(usageRow(line("claude", "2026-09-20T10:00:00.000Z", reported(1, 1)))!.model).toBe("some-model");
  });

  test("S15.9: a line whose cost does not follow from its own counts is left out, never signed", () => {
    const entry = charged("2026-09-20T10:00:00.000Z");
    const inflated = { ...entry, cost: { ...entry.cost!, usd_micros: 999_999 } };
    const pathModel = { ...entry, model: "/home/someone/model.gguf" };
    expect(usageRow(inflated)).toBeUndefined();
    expect(usageRow(pathModel)).toBeUndefined();
    const { payload, facts } = usagePayload([inflated, entry], {}, new Date(0));
    expect(payload.rows.length).toBe(1);
    // Counted as a cost that did not check, with the reason — not as a line with a bad id (PR #3 review, R5).
    expect(facts.unshapely).toBe(0);
    expect(facts.costRefused).toBe(1);
    expect(facts.costReasons[0]).toContain(`line ${entry.id}.cost.usd_micros is 999999, and its own counts at its own rates come to 303632`);
  });

  test("messages are not model turns: an A2A peer and a chat user never reach the report", () => {
    expect(isModelBackend("claude")).toBe(true);
    expect(isModelBackend("claude-local")).toBe(true);
    expect(isModelBackend("ollama")).toBe(true);
    for (const backend of ["a2a:in:fleet", "a2a:out:fleet", "chat:telegram:in:CANARY-USER-9", "", "Claude", "a b", "x".repeat(65)]) {
      expect(isModelBackend(backend), backend).toBe(false);
    }
  });

  test("no canary from any text field survives into the signed envelope", () => {
    const entries = [
      line("claude", "2026-09-20T10:00:00.000Z", reported(100, 20)),
      line("ollama", "2026-09-21T10:00:00.000Z"),
      line("codex", "2026-09-22T10:00:00.000Z", { status: "missing", input: 50, output: null, total: null }, true),
      line("a2a:in:CANARY-PEER-3", "2026-09-22T11:00:00.000Z"),
      line("chat:telegram:in:CANARY-USER-4", "2026-09-22T12:00:00.000Z"),
    ];
    const { payload, facts } = usagePayload(entries, {}, new Date("2026-09-28T00:00:00.000Z"));
    expect(facts.notModel).toBe(2);
    expect(payload.rows.length).toBe(3);
    const text = JSON.stringify(signEnvelope(payload, generateKeyPairSync("ed25519").privateKey));
    for (const needle of ["CANARY", SUBJECT, "987654", "987655", "876543", "876544", "prompt", "text_bytes", "soul_sha"]) {
      expect(text, needle).not.toContain(needle);
    }
    for (const row of payload.rows) expect(Object.keys(row)).toEqual([...USAGE_ROW_FIELDS]);
  });
});

describe("unknown is null, never zero", () => {
  test("no usage at all, an unsurveyed backend, a missing half — each null, and said which", () => {
    const rows = [
      usageRow(line("claude", "2026-09-20T10:00:00.000Z"))!,
      usageRow(line("copilot", "2026-09-20T10:00:00.000Z", { status: "unreported", input: null, output: null, total: null }))!,
      usageRow(line("codex", "2026-09-20T10:00:00.000Z", { status: "missing", input: 50, output: null, total: null }))!,
      usageRow(line("ollama", "2026-09-20T10:00:00.000Z", reported(0, 0)))!,
    ];
    expect(rows.map((r) => [r.input_tokens, r.output_tokens, r.usage])).toEqual([
      [null, null, "not-recorded"],
      [null, null, "unreported"],
      [50, null, "missing"],
      // A zero the backend printed is a real zero.
      [0, 0, "reported"],
    ]);
    expect(usageTotals(rows)).toEqual({
      rows: 4,
      input: 50n,
      output: 0n,
      cacheRead: 0n,
      cacheWrite: 0n,
      cacheWrite1h: 0n,
      withoutInput: 2,
      withoutOutput: 3,
      unknownFrom: ["claude", "codex", "copilot"],
      usdMicros: 0n,
      usdMicrosChecked: 0n,
      charged: 0,
      // None of them was priced when it was written, so none is priced now.
      notCharged: [["not-recorded", 4]],
    });
  });

  test("S15.9: money is summed over charged rows only, and the rest are counted by reason", () => {
    const rows = [
      usageRow(charged("2026-09-20T10:00:00.000Z"))!,
      usageRow(charged("2026-09-20T11:00:00.000Z"))!,
      usageRow({ ...line("codex", "2026-09-20T12:00:00.000Z", { status: "reported", input: null, output: null, total: 9 }), not_charged: "usage-unsplit" })!,
      usageRow({ ...line("ollama", "2026-09-20T13:00:00.000Z", reported(5, 5)), not_charged: "price-unknown" })!,
      usageRow({ ...line("ollama", "2026-09-20T14:00:00.000Z", reported(5, 5)), not_charged: "price-unknown" })!,
    ];
    const totals = usageTotals(rows);
    expect(totals.usdMicros).toBe(2n * 303_632n);
    // Both at the shipped table's rates: all of it checked.
    expect(totals.usdMicrosChecked).toBe(2n * 303_632n);
    expect(totals.charged).toBe(2);
    expect(totals.cacheWrite).toBe(2n * 80_951n);
    expect(totals.notCharged).toEqual([
      ["usage-unsplit", 1],
      ["price-unknown", 2],
    ]);
  });
});

describe("the payload", () => {
  test("says what it is, when it was made and over what window", () => {
    const since = new Date("2026-09-01T00:00:00.000Z");
    const { payload } = usagePayload([], { since }, new Date("2026-09-28T00:00:00.000Z"));
    expect(payload).toEqual({ kind: USAGE_REPORT_KIND, v: 2, generated_at: "2026-09-28T00:00:00.000Z", since: "2026-09-01T00:00:00.000Z", until: null, binding: null, rows: [] });
  });

  test("from a real ledger on disk, over a window, counting what it left out", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-usage-report-"));
    scratch.push(home);
    const env: LedgerEnv = { home, env: { XDG_STATE_HOME: join(home, "state") }, now: () => new Date("2026-09-28T00:00:00.000Z") };
    await append(env, line("claude", "2026-08-31T23:00:00.000Z", reported(1, 1)));
    await append(env, line("claude", "2026-09-10T10:00:00.000Z", reported(10, 2)));
    await append(env, line("a2a:in:peer", "2026-09-11T10:00:00.000Z"));
    await appendFile(join(ledgerDir(env, SUBJECT), "2026-09.jsonl"), "{half a line\n");

    const { payload, facts } = await buildUsageReport(env, SUBJECT, { since: new Date("2026-09-01T00:00:00.000Z") });
    expect(payload.rows.map((r) => r.input_tokens)).toEqual([10]);
    expect(payload.since).toBe("2026-09-01T00:00:00.000Z");
    expect(payload.generated_at).toBe("2026-09-28T00:00:00.000Z");
    expect(facts).toEqual({ notModel: 1, unshapely: 0, costRefused: 0, costReasons: [], conflicting: 0, modelWithheld: 0, unreadable: 1, foreign: 0 });
  });
});

describe("every string has a shape — the producer's side (M2, info items)", () => {
  test("a model that is a path is sent as null and counted; a model's name, with or without an org, is kept", () => {
    const withModel = (model: string | null) => ({ ...line("claude", "2026-09-20T10:00:00.000Z", reported(1, 1)), model });
    for (const name of ["some-model", "qwen3.8:27b", "cyankiwi/Qwen3.8-27B-AWQ-INT4", "claude-opus-4@20260901", "gpt-5.1+preview"]) {
      expect(usageRow(withModel(name))!.model, name).toBe(name);
    }
    const paths = ["/home/someone/models/secret.gguf", "~/models/x.gguf", "./x.gguf", "../x", "a/b/c", "has space", "with\u001b[8m", ".hidden", "x".repeat(129)];
    for (const path of paths) expect(usageRow(withModel(path))!.model, path).toBeNull();
    const { payload, facts } = usagePayload([withModel("/home/someone/models/secret.gguf"), withModel("ok-model")], {}, new Date(0));
    expect(facts.modelWithheld).toBe(1);
    expect(JSON.stringify(payload)).not.toContain("someone");
  });

  test("a fractional duration is rounded, a negative or huge one is null — and the report still signs (no crash)", () => {
    const withDuration = (duration_ms: number | null) => ({ ...line("claude", "2026-09-20T10:00:00.000Z", reported(1, 1)), duration_ms });
    expect([1.5, 1.4, 0, -1, null, 2 ** 60].map((d) => usageRow(withDuration(d))!.duration_ms)).toEqual([2, 1, 0, null, null, null]);
    const { payload } = usagePayload([withDuration(1.5)], {}, new Date(0));
    expect(() => signEnvelope(payload, generateKeyPairSync("ed25519").privateKey)).not.toThrow();
  });

  test("a line whose ids have no row's shape is left out and counted, never cleaned up into a row", () => {
    const bad = [
      { ...line("claude", "2026-09-20T10:00:00.000Z"), id: "\u001b]0;pwned\u0007" },
      { ...line("claude", "2026-09-20T10:00:00.000Z"), turn: "turn\nIt is the key you named." },
      { ...line("claude", "2026-09-20T10:00:00.000Z"), at: "not a time" },
    ];
    for (const entry of bad) expect(usageRow(entry)).toBeUndefined();
    const { payload, facts } = usagePayload([...bad, line("claude", "2026-09-20T10:00:00.000Z")], {}, new Date(0));
    expect(payload.rows.length).toBe(1);
    expect(facts.unshapely).toBe(3);
  });

  test("`at` is written the one way a reader accepts", () => {
    expect(usageRow(line("claude", "2026-09-20T10:00:00Z"))!.at).toBe("2026-09-20T10:00:00.000Z");
    expect(isIsoInstant("2026-09-20T10:00:00.000Z")).toBe(true);
    expect(isIsoInstant("2026-09-20T10:00:00Z")).toBe(true);
    for (const bad of ["2026-09-20", "2026-13-40T10:00:00Z", "2026-09-20T10:00:00+07:00", "yesterday", 5, null]) expect(isIsoInstant(bad), String(bad)).toBe(false);
    expect(isModelName("a/b")).toBe(true);
  });
});

describe("reading a report back", () => {
  const { payload } = usagePayload(
    [line("claude", "2026-09-20T10:00:00.000Z", reported(3, 4)), line("ollama", "2026-09-20T11:00:00.000Z"), charged("2026-09-20T12:00:00.000Z")],
    {},
    new Date(0),
  );
  const key = generateKeyPairSync("ed25519").privateKey;
  const envelope = signEnvelope(payload, key);
  const text = JSON.stringify(envelope);

  test("a well-formed payload gives its rows", () => {
    expect(reportRows(JSON.parse(JSON.stringify(payload)))).toEqual(payload.rows);
    expect(reportProblem(payload)).toBeUndefined();
  });

  test("anything else gives nothing to sum, and says why", () => {
    const row = payload.rows[0]!;
    const bad: unknown[] = [
      null,
      "text",
      { ...payload, kind: "something-else" },
      // S15.8's shape, never released: its rows lack the S15.9 fields, and it is not read as if it had them.
      { ...payload, v: 1 },
      { ...payload, v: 3 },
      { ...payload, extra: 1 },
      { ...payload, generated_at: "yesterday" },
      { ...payload, since: 7 },
      { ...payload, rows: "none" },
      { ...payload, rows: [null] },
      { ...payload, rows: [[row]] },
      { ...payload, rows: [{ ...row, prompt: "x" }] },
      { ...payload, rows: [{ ...row, id: "a b" }] },
      { ...payload, rows: [{ ...row, at: "soon" }] },
      { ...payload, rows: [{ ...row, input_tokens: "12" }] },
      { ...payload, rows: [{ ...row, output_tokens: -1 }] },
      { ...payload, rows: [{ ...row, duration_ms: 1.5 }] },
      { ...payload, rows: [{ ...row, model: 7 }] },
      { ...payload, rows: [{ ...row, model: "/home/someone/x" }] },
      { ...payload, rows: [{ ...row, backend: null }] },
      { ...payload, rows: [{ ...row, backend: "chat:telegram:in:someone" }] },
      { ...payload, rows: [{ ...row, usage: "free" }] },
      { ...payload, rows: [{ ...row, cache_read_tokens: -1 }] },
      { ...payload, rows: [{ ...row, not_charged: "too-dear" }] },
      { ...payload, rows: [{ ...row, not_charged: null }] },
      // S15.9: a cost is exactly its fields, and exactly what its own counts at its own rates come to.
      ...costTampering(),
    ];
    for (const value of bad) {
      expect(reportRows(value), JSON.stringify(value)?.slice(0, 80)).toBeUndefined();
      expect(reportProblem(value)).toBeString();
    }
  });

  test("a report of the mind kind is read, and with another version is refused", () => {
    expect(USAGE_REPORT_KIND).toBe("mind.usage-report");
    const same = { ...payload, kind: USAGE_REPORT_KIND };
    expect(reportProblem(same)).toBeUndefined();
    expect(reportRows(JSON.parse(JSON.stringify(same)))).toEqual(payload.rows);
    expect(reportProblem({ ...same, v: 1 })).toContain("version 1 is not 2");
  });

  test("a refusal prints the current kind", () => {
    expect(reportProblem({ ...payload, kind: "something-else" })).toContain(`not ${USAGE_REPORT_KIND}`);
  });

  /** Every way a charged row's cost can be wrong while still looking like one. */
  function costTampering(): unknown[] {
    const priced = payload.rows.find((r) => r.cost !== null)!;
    const cost = priced.cost!;
    const withRow = (row: Record<string, unknown>) => ({ ...payload, rows: [row] });
    return [
      withRow({ ...priced, cost: { ...cost, usd_micros: cost.usd_micros + 1 } }),
      withRow({ ...priced, cost: { ...cost, usd_micros: 0.5 } }),
      withRow({ ...priced, cost: { ...cost, usd_micros: null } }),
      withRow({ ...priced, cost: { ...cost, usd_micros_per_mtok: { ...cost.usd_micros_per_mtok, output: 1 } } }),
      withRow({ ...priced, cost: { ...cost, usd_micros_per_mtok: { ...cost.usd_micros_per_mtok, output: 1.5 } } }),
      withRow({ ...priced, cost: { ...cost, usd_micros_per_mtok: { input: 1, output: 1, cache_read: 1 } } }),
      withRow({ ...priced, cost: { ...cost, usd_micros_per_mtok: [1, 2, 3, 4] } }),
      withRow({ ...priced, cost: { ...cost, table: "a b" } }),
      withRow({ ...priced, cost: { ...cost, source: "vendor" } }),
      withRow({ ...priced, cost: { ...cost, vendor_quoted_usd: 1 } }),
      withRow({ ...priced, cost: [cost] }),
      withRow({ ...priced, not_charged: "price-unknown" }),
      withRow({ ...priced, output_tokens: priced.output_tokens! + 1 }),
      withRow({ ...priced, cache_write_tokens: 0 }),
      withRow({ ...priced, usage: "missing" }),
      withRow({ ...priced, model: null }),
      withRow({ ...priced, input_tokens: null }),
    ];
  }

  test("M2: a row labelled with a shipped table is held to that table — rates, model and digest", () => {
    const priced = payload.rows.find((r) => r.cost !== null)!;
    const cost = priced.cost!;
    const tenfold = Object.fromEntries(Object.entries(cost.usd_micros_per_mtok).map(([k, v]) => [k, v === null ? null : v * 10])) as typeof SONNET;
    // Ten times the shipped rates, with the arithmetic done right at those rates: the label is what is false.
    const inflated = { ...priced, cost: { ...cost, usd_micros: 3_036_323, usd_micros_per_mtok: tenfold } };
    expect(reportProblem({ ...payload, rows: [inflated] })).toContain("which prices claude-sonnet-4-6 input at 3000000 µ$/MTok, not 30000000");
    // A model the shipped table has no price for.
    expect(reportProblem({ ...payload, rows: [{ ...priced, model: "claude-sonnet-9" }] })).toContain("has no price for claude · claude-sonnet-9");
    // The right rates under a digest that is not the shipped table's.
    expect(reportProblem({ ...payload, rows: [{ ...priced, cost: { ...cost, table_digest: "0000000000000000" } }] })).toContain(`whose digest is ${DEFAULT_PRICES.digest}`);
    // A version and digest this build does not carry, and the owner's rates under the owner's digest: nothing
    // to hold them to — valid, and grouped as unchecked.
    const unknownVersion = { ...priced, cost: { ...cost, table: "2031-01-01", table_digest: "0123456789abcdef" } };
    const owner = { ...priced, cost: { ...cost, source: "owner" as const, table: "home-1", table_digest: "00112233aabbccdd", usd_micros_per_mtok: tenfold, usd_micros: 3_036_323 } };
    expect(reportProblem({ ...payload, rows: [unknownVersion, owner] })).toBeUndefined();
    expect(costGroups([priced, unknownVersion, owner]).map((g) => [g.source, g.table, g.check])).toEqual([
      ["default", DEFAULT_PRICES.version, "shipped"],
      ["default", "2031-01-01", "unknown-default"],
      ["owner", "home-1", "owner"],
    ]);
    // The producer never writes such a row either: a ledger line claiming shipped rates it does not have is left out.
    const line = charged("2026-09-20T13:00:00.000Z");
    expect(usageRow({ ...line, cost: { ...line.cost!, usd_micros: 3_036_323, usd_micros_per_mtok: tenfold } })).toBeUndefined();
  });

  test("R2: the shipped digest binds the shipped labels — an invented version or an owner label on it is refused", () => {
    const priced = payload.rows.find((r) => r.cost !== null)!;
    const cost = priced.cost!;
    const tenfold = Object.fromEntries(Object.entries(cost.usd_micros_per_mtok).map(([k, v]) => [k, v === null ? null : v * 10])) as typeof SONNET;
    const at10 = { ...cost, usd_micros: 3_036_323, usd_micros_per_mtok: tenfold };
    // Before: both of these passed as "NOT checked", carrying the shipped table's digest at ten times its rates.
    const invented = { ...priced, cost: { ...at10, table: "2031-01-01" } };
    expect(reportProblem({ ...payload, rows: [invented] })).toContain(`carries the digest of the shipped table ${DEFAULT_PRICES.version} and names table 2031-01-01`);
    const ownerLabel = { ...priced, cost: { ...at10, source: "owner" as const } };
    expect(reportProblem({ ...payload, rows: [ownerLabel] })).toContain(`carries the digest of the shipped table ${DEFAULT_PRICES.version} and says the owner set its rates`);
    const ownerRenamed = { ...priced, cost: { ...cost, source: "owner" as const, table: "home-1" } };
    expect(reportProblem({ ...payload, rows: [ownerRenamed] })).toContain("says the owner set its rates");
    // The shipped digest under `default` and its own version is still exactly the check M2 made.
    expect(reportProblem({ ...payload, rows: [priced] })).toBeUndefined();
  });

  test("R3: one table cannot price one model twice, or be two versions — the report is refused, the producer drops them", () => {
    const priced = payload.rows.find((r) => r.cost !== null)!;
    const own = { ...priced.cost!, source: "owner" as const, table: "home-1", table_digest: "00112233aabbccdd" };
    const a = { ...priced, id: "a", cost: own };
    const cheaper = { ...SONNET, input: 1_000_000 };
    // 2×1000000 + 80951×3750000 + 4×15000000 = 303,628,250,000 → 303628
    const b = { ...priced, id: "b", cost: { ...own, usd_micros: 303_628, usd_micros_per_mtok: cheaper } };
    expect(reportProblem({ ...payload, rows: [a] })).toBeUndefined();
    expect(reportProblem({ ...payload, rows: [b] })).toBeUndefined();
    expect(reportProblem({ ...payload, rows: [a, b] })).toContain("at two different sets of rates");
    expect(reportProblem({ ...payload, rows: [a, { ...a, id: "c", cost: { ...own, table: "home-2" } }] })).toContain("by more than one version or source");
    // The producer: both lines of the disagreeing claim are left out and counted; the rest stay.
    const line = charged("2026-09-20T13:00:00.000Z");
    const ownLine = (id: string, rates: typeof SONNET, micros: number) => ({ ...line, id, cost: { ...line.cost!, source: "owner" as const, table: "home-1", table_digest: "00112233aabbccdd", usd_micros: micros, usd_micros_per_mtok: rates } });
    const made = usagePayload([ownLine("x1", SONNET, 303_632), ownLine("x2", cheaper, 303_628), line], {}, new Date(0));
    expect(made.payload.rows.map((r) => r.id)).toEqual([line.id]);
    expect(made.facts.conflicting).toBe(2);
    expect(reportProblem(made.payload)).toBeUndefined();
  });

  test("R4: the checked part of the money is the shipped-table part", () => {
    const priced = payload.rows.find((r) => r.cost !== null)!;
    const owned = { ...priced, id: "o", cost: { ...priced.cost!, source: "owner" as const, table: "home-1", table_digest: "00112233aabbccdd" } };
    const unknown = { ...priced, id: "u", cost: { ...priced.cost!, table: "2031-01-01", table_digest: "0123456789abcdef" } };
    const totals = usageTotals([priced, owned, unknown]);
    expect(totals.usdMicros).toBe(3n * 303_632n);
    expect(totals.usdMicrosChecked).toBe(303_632n);
  });

  test("cost groups: one per claimed price, summed exactly, with not-charged rows and model-less rows left out", () => {
    const a = usageRow(charged("2026-09-20T10:00:00.000Z"))!;
    const b = usageRow(charged("2026-09-20T11:00:00.000Z"))!;
    const loose = usageRow({ ...line("ollama", "2026-09-20T12:00:00.000Z", reported(5, 5)), not_charged: "price-unknown" })!;
    const groups = costGroups([a, b, loose]);
    expect(groups.length).toBe(1);
    expect(groups[0]).toEqual({
      source: "default",
      table: DEFAULT_PRICES.version,
      table_digest: DEFAULT_PRICES.digest,
      backend: "claude",
      model: "claude-sonnet-4-6",
      rates: SONNET,
      rows: 2,
      usdMicros: 607_264n,
      check: "shipped",
    });
    // Rows whose model is gone cannot say what was claimed; a verified report never has one charged, but the
    // grouping does not assume it.
    expect(costGroups([{ ...a, model: null }])).toEqual([]);
    // The same model at different rates is two claims, not one.
    const other = { ...a, cost: { ...a.cost!, source: "owner" as const, table: "home-1" } };
    expect(costGroups([a, other]).length).toBe(2);
  });

  test("S15.9: a charged row is re-checked from its own counts and rates, and a correct one passes", () => {
    const priced = payload.rows.find((r) => r.cost !== null)!;
    expect(priced.cost!.usd_micros).toBe(303_632);
    expect(reportProblem({ ...payload, rows: [priced] })).toBeUndefined();
    const problem = reportProblem({ ...payload, rows: [{ ...priced, cost: { ...priced.cost!, usd_micros: 1 } }] });
    expect(problem).toContain("its own counts at its own rates come to 303632");
    expect(reportProblem({ ...payload, rows: [{ ...priced, cache_write_tokens: 90_000 }] })).toContain("no price");
  });

  test("valid only against the key it should be signed by; consistent is a different answer", () => {
    const own = signEnvelope(payload, key).publicKey;
    expect(verifyUsageReport(text, own).ok).toBe(true);
    expect(checkUsageReport(text).ok).toBe(true);
    const stranger = signEnvelope(payload, generateKeyPairSync("ed25519").privateKey).publicKey;
    const wrong = verifyUsageReport(text, stranger);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain("different key");
    expect(verifyUsageReport(text, "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").ok).toBe(false);
    expect(verifyUsageReport("not json", own).ok).toBe(false);
    // A consistent envelope whose payload is not a usage report is not one.
    expect(checkUsageReport(JSON.stringify(signEnvelope({ kind: "other" }, key))).ok).toBe(false);
  });

  test("M2: the reviewer's payloads — a fake line and a hiding escape, an OSC title, a cursor-up — are refused even self-signed", () => {
    const hostile = [
      { ...payload, generated_at: "2026-09-28T00:00:00.000Z\nIt is the key you named.\u001b[8m" },
      { ...payload, since: "\u001b[1A\u001b[2Kvalid — signed by ed25519 key 0000000000000000" },
      { ...payload, rows: [{ ...payload.rows[0]!, backend: "\u001b]0;pwned\u0007" }] },
      { ...payload, rows: [{ ...payload.rows[0]!, model: "m\u202eodel" }] },
      { ...payload, rows: [{ ...payload.rows[0]!, id: "id\u0085" }] },
    ];
    for (const value of hostile) {
      const signed = JSON.stringify(signEnvelope(value, key));
      const checked = checkUsageReport(signed);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(printable(checked.reason)).not.toMatch(/[\u001b\u0007\u0085\u202e]/);
    }
  });

  test("L5: a duplicate member name is refused — the rows JSON.parse would keep are not the rows another reader sees", () => {
    const decoy = JSON.stringify([{ ...payload.rows[0]!, input_tokens: 999_999 }]);
    const doubled = text.replace('"rows":', `"rows":${decoy},"rows":`);
    // JSON.parse keeps the last `rows` — the signed ones — so a parse-then-verify would say yes.
    expect(checkEnvelope(JSON.parse(doubled)).ok).toBe(true);
    const checked = checkUsageReport(doubled);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain("duplicate member name");
    expect(checkUsageReport(text.replace('"kind":', '"kind":"x","kind":')).ok).toBe(false);
  });

  test("printable escapes C0, C1, DEL, bidi and line separators, and leaves the rest alone", () => {
    expect(printable("a\u001b[8mb\u0007c\u007fd\u0085e\u202ef\u2066g\u2028h")).toBe("a\\u{1b}[8mb\\u{7}c\\u{7f}d\\u{85}e\\u{202e}f\\u{2066}g\\u{2028}h");
    expect(printable("café ✓ 😀 plain")).toBe("café ✓ 😀 plain");
  });
});
