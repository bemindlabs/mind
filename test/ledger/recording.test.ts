/**
 * The wrapper that turns a delivered prompt into a line.
 *
 * The property worth testing is not "a turn is recorded" — it is **which**
 * turns are. A backend the chain decided was unavailable never saw the text
 * and must leave no line; a backend that was asked and went silent did see it
 * and must leave one. Getting that backwards would make the ledger answer the
 * question "which backend answered?" when the question I-6 asks is "which
 * backend received this?".
 *
 * The fallback case is exercised with the real `FallbackExec` rather than a
 * mock of one, because the whole claim is about how the two compose.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Availability, ExecBackend, TurnRequest, TurnResult } from "../../src/exec/backend.ts";
import { FallbackExec } from "../../src/exec/fallback.ts";
import { messageEntry } from "../../src/a2a/message.ts";
import { chatEntry, type ChatMessage } from "../../src/connectors/chat.ts";
import {
  append,
  canAppend,
  ledgerDir,
  LedgerLocked,
  LOCK_TIMING,
  query,
  RecordingExec,
  type LedgerEnv,
  type RecordingOptions,
} from "../../src/ledger/index.ts";
import { DEFAULT_PRICES, validatePriceTable, type PricesInForce, type PriceTable } from "../../src/pricing/table.ts";
import { subjectId, type Usage } from "../../src/types.ts";
import { RESTRAINED } from "../support/restraint.ts";

const SUBJECT = subjectId("example");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeEnv(): Promise<LedgerEnv> {
  const root = await mkdtemp(join(tmpdir(), "mind-recording-"));
  scratch.push(root);
  return {
    home: root,
    env: { XDG_STATE_HOME: join(root, "state") },
    now: () => new Date("2026-09-21T10:00:00.000Z"),
  };
}

/** A backend with no subprocess and no socket, scripted per test. */
class Fake implements ExecBackend {
  readonly kind = "cli" as const;
  readonly display: string;
  calls = 0;

  constructor(
    readonly id: string,
    private readonly outcome: Partial<TurnResult> & { readonly available?: boolean },
    readonly identityStrength: "system" | "user" | "none" = "system",
  ) {
    this.display = `${id} (fake)`;
  }

  async available(): Promise<Availability> {
    const ok = this.outcome.available ?? true;
    return { ok, detail: ok ? `${this.id}: ready` : `${this.id}: not on PATH` };
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    this.calls++;
    return {
      backend: this.id,
      text: this.outcome.text ?? `answer from ${this.id}`,
      confidence: this.outcome.confidence ?? "confirmed",
      identityStrength: this.identityStrength,
      evidence: {
        source: this.id,
        prompt: request.prompt,
        raw: `raw from ${this.id}`,
        durationMs: 11,
        exitCode: 0,
        ...this.outcome.evidence,
      },
    };
  }
}

/** The shipped table and no owner file — what a turn on a fresh machine is priced against. */
const SHIPPED: PricesInForce = { default: DEFAULT_PRICES, owner: { state: "absent" }, ownerPath: "/nowhere/prices.json" };

/** An owner's table pricing the local model `stub` on ollama: $0.10 in, $0.40 out per million tokens. */
const OWN: PriceTable = (() => {
  const read = validatePriceTable({
    kind: "mind.price-table",
    v: 1,
    version: "home-1",
    currency: "usd",
    unit: "micros-per-million-tokens",
    prices: [{ backend: "ollama", model: "stub", input: 100_000, output: 400_000, cache_read: null, cache_write: null }],
  });
  if (!read.ok) throw new Error(read.reason);
  return read.table;
})();
const OWNED: PricesInForce = { ...SHIPPED, owner: { state: "ok", table: OWN } };

/** Usage as ollama writes it since S15.9: two counts, and no cache count, said so. */
const ollamaUsage = (input: number, output: number): Usage => ({
  status: "reported",
  input,
  output,
  total: null,
  cache_read: null,
  cache_write: null,
  not_printed: ["cache_read", "cache_write"],
});

let nextId = 0;
function options(ledger: LedgerEnv, overrides: Partial<RecordingOptions> = {}): RecordingOptions {
  return {
    ledger,
    turnId: "turn-1",
    newId: () => `line-${++nextId}`,
    content: "full",
    model: "stub",
    prices: SHIPPED,
    soulSha: "b".repeat(64),
    onWriteFailure: (error) => {
      throw error;
    },
    ...overrides,
  };
}

describe("RecordingExec", () => {
  test("reports the wrapped backend's own identity, so a route line reads the same", async () => {
    const env = await makeEnv();
    const inner = new Fake("claude", {}, "user");
    const wrapped = new RecordingExec(inner, options(env));

    expect(wrapped.id).toBe("claude");
    expect(wrapped.display).toBe("claude (fake)");
    expect(wrapped.kind).toBe("cli");
    expect(wrapped.identityStrength).toBe("user");
    expect((await wrapped.available()).detail).toBe("claude: ready");
  });

  test("a readiness probe is not a turn and writes nothing", async () => {
    const env = await makeEnv();
    await new RecordingExec(new Fake("claude", {}), options(env)).available();
    expect((await query(env, SUBJECT)).entries).toEqual([]);
  });

  test("one run, one line, carrying what was asked and what came back", async () => {
    const env = await makeEnv();
    const wrapped = new RecordingExec(new Fake("ollama", {}), options(env));
    await wrapped.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "canary-7f3a", system: "soul text" });

    const { entries } = await query(env, SUBJECT);
    expect(entries.length).toBe(1);
    const line = entries[0]!;
    expect(line.backend).toBe("ollama");
    expect(line.prompt).toBe("canary-7f3a");
    expect(line.text).toBe("answer from ollama");
    expect(line.confidence).toBe("confirmed");
    expect(line.duration_ms).toBe(11);
    expect(line.exit).toBe(0);
    expect(line.model).toBe("stub");
    expect(line.soul_sha).toBe("b".repeat(64));
    // The backend reported nothing, so the line says so in the state that
    // means "nobody has surveyed this one" — never a zero — and a turn with no
    // count is not charged (D-110).
    expect(line.usage).toEqual({ status: "unreported", input: null, output: null, total: null, cache_read: null, cache_write: null, cache_write_5m: null, cache_write_1h: null });
    expect(line.cost).toBeNull();
    expect(line.not_charged).toBe("usage-missing");
    // The soul text itself is in git; only its hash is out here.
    expect(JSON.stringify(line)).not.toContain("soul text");
    // The vendor's raw output is not copied: it duplicates `text` and can
    // carry account ids, paths and tokens from an error message.
    expect(JSON.stringify(line)).not.toContain("raw from ollama");
  });

  test("--private records the turn without the words, and without a digest of them", async () => {
    const env = await makeEnv();
    const wrapped = new RecordingExec(new Fake("ollama", {}), options(env, { content: "withheld" }));
    await wrapped.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "canary-7f3a", system: "soul" });

    const line = (await query(env, SUBJECT)).entries[0]!;
    expect(line.content).toBe("withheld");
    expect(line.prompt).toBeNull();
    expect(line.text).toBeNull();
    expect(line.prompt_bytes).toBe(11);
    expect(line.text_bytes).toBeGreaterThan(0);
    // Still auditable: when, who, how long, how it went.
    expect(line.backend).toBe("ollama");
    expect(line.duration_ms).toBe(11);
    expect(JSON.stringify(line)).not.toContain("canary-7f3a");
  });

  test("a backend that went silent still received the prompt, and still gets a line", async () => {
    const env = await makeEnv();
    const claude = new RecordingExec(
      new Fake("claude", { confidence: "silent", text: "" }),
      options(env),
    );
    const ollama = new RecordingExec(new Fake("ollama", {}), options(env));
    const missing = new RecordingExec(new Fake("codex", { available: false }), options(env));

    const chain = new FallbackExec([claude, missing, ollama]);
    const result = await chain.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "canary-7f3a", system: "soul" });
    expect(result.text).toBe("answer from ollama");

    const { entries } = await query(env, SUBJECT);
    // Two lines, not one and not three. `claude` was handed the text and said
    // nothing; `codex` was never asked; `ollama` answered.
    expect(entries.map((e) => e.backend).sort()).toEqual(["claude", "ollama"]);
    expect(entries.every((e) => e.turn === "turn-1")).toBe(true);
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
    expect(entries.find((e) => e.backend === "claude")!.confidence).toBe("silent");
  });

  test("a chain that never reaches a backend writes no line at all", async () => {
    const env = await makeEnv();
    const chain = new FallbackExec([
      new RecordingExec(new Fake("claude", { available: false }), options(env)),
      new RecordingExec(new Fake("ollama", { available: false }), options(env)),
    ]);
    const result = await chain.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "canary-7f3a", system: "soul" });

    expect(result.confidence).toBe("silent");
    expect((await query(env, SUBJECT)).entries).toEqual([]);
  });

  test("the counts a backend reported land on the line", async () => {
    const env = await makeEnv();
    const usage = { status: "reported", input: 15, output: 24, total: null } as const;
    const wrapped = new RecordingExec(
      new Fake("ollama", { evidence: { source: "ollama", raw: "raw", usage } }),
      options(env),
    );
    await wrapped.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "canary-7f3a", system: "soul" });

    const line = (await query(env, SUBJECT)).entries[0]!;
    expect(line.usage).toEqual(usage);
    // A usage from before S15.9's shape says nothing about the cache: its null
    // cache counts are not declared as never printed, so it is not priced.
    expect(line.cost).toBeNull();
    expect(line.not_charged).toBe("usage-missing");
  });

  test("S15.9: a turn with its counts and a price is charged, and the line says by which table and at which rates", async () => {
    const env = await makeEnv();
    const wrapped = new RecordingExec(
      new Fake("ollama", { evidence: { source: "ollama", raw: "raw", usage: ollamaUsage(1_000_000, 250_000) } }),
      options(env, { prices: OWNED }),
    );
    await wrapped.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "canary-7f3a", system: "soul" });

    const line = (await query(env, SUBJECT)).entries[0]!;
    // 1M × $0.10 + 0.25M × $0.40 = $0.20 = 200000 micro-dollars.
    expect(line.cost).toEqual({
      usd_micros: 200_000,
      table: "home-1",
      table_digest: OWN.digest,
      source: "owner",
      usd_micros_per_mtok: { input: 100_000, output: 400_000, cache_read: null, cache_write: null },
    });
    expect(line.not_charged).toBeNull();
    // Not the vendor's money: no field of it names a vendor price.
    expect(JSON.stringify(line)).not.toMatch(/total_cost|vendor/);
  });

  test("S15.9: a model nobody priced is not charged — never 0, never a neighbour's price", async () => {
    const env = await makeEnv();
    const usage = ollamaUsage(10, 5);
    const run = async (overrides: Partial<RecordingOptions>, request: Partial<TurnRequest> = {}) => {
      await new RecordingExec(new Fake("ollama", { evidence: { source: "ollama", raw: "raw", usage } }), options(env, overrides)).run({
        restraint: RESTRAINED,
        subject: SUBJECT,
        prompt: "p",
        ...request,
      });
      return (await query(env, SUBJECT)).entries.at(-1)!;
    };
    // The shipped table prices no local model.
    expect((await run({})).not_charged).toBe("price-unknown");
    // The backend's own default, which it does not name.
    expect((await run({ model: null, prices: OWNED })).not_charged).toBe("model-unknown");
    // The owner's file is there and broken: nothing is priced, the default is not used instead.
    expect((await run({ prices: { ...OWNED, owner: { state: "unusable", reason: "x" } } })).not_charged).toBe("table-unusable");
    // A model named in the request is the one the backend received, and the one priced.
    const named = await run({ model: null, prices: OWNED }, { model: "stub" });
    expect(named.model).toBe("stub");
    // 10 × 100000 + 5 × 400000 µ$ per million tokens = 3 µ$.
    expect(named.cost?.usd_micros).toBe(3);
    expect(named.not_charged).toBeNull();
  });

  test("D-143: a claude turn's 1-hour cache write is priced at its own rate on the line; an unknown split is not charged", async () => {
    const env = await makeEnv();
    const record = async (usage: Usage) => {
      await new RecordingExec(
        new Fake("claude", { evidence: { source: "claude", raw: "raw", usage, model: { requested: "haiku", reported: ["claude-haiku-4-5"] } } }),
        options(env, { model: null }),
      ).run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "p" });
      return (await query(env, SUBJECT)).entries.at(-1)!;
    };
    // D-142's measured turn: 10 fresh, 11,856 written to the 1-hour cache, 65 out.
    const measured: Usage = { status: "reported", input: 11_866, output: 65, total: null, cache_read: 0, cache_write: 11_856, cache_write_5m: 0, cache_write_1h: 11_856, not_printed: [] };
    const oneHour = await record(measured);
    // 10×$1 + 11,856×$2 + 65×$5 per million tokens = 24,047 µ$ — not the 15,155 of the 5-minute rate.
    expect(oneHour.cost?.usd_micros).toBe(24_047);
    expect(oneHour.cost?.usd_micros_per_mtok).toEqual({ input: 1_000_000, output: 5_000_000, cache_read: 100_000, cache_write: 1_250_000, cache_write_1h: 2_000_000 });
    // The split is kept on the line as the backend printed it.
    expect([oneHour.usage?.cache_write_5m, oneHour.usage?.cache_write_1h]).toEqual([0, 11_856]);
    // The same write to the 5-minute cache: the four rates, the shape a line had before D-143.
    const fiveMinute = await record({ ...measured, cache_write_5m: 11_856, cache_write_1h: 0 });
    expect(fiveMinute.cost?.usd_micros).toBe(15_155);
    expect(Object.keys(fiveMinute.cost!.usd_micros_per_mtok)).toEqual(["input", "output", "cache_read", "cache_write"]);
    // claude prints the split; a turn that wrote and did not say which is not charged, never priced as 5-minute.
    const unsplit = await record({ ...measured, cache_write_5m: null, cache_write_1h: null });
    expect(unsplit.cost).toBeNull();
    expect(unsplit.not_charged).toBe("usage-unsplit");
  });

  test("D-142: a vendor CLI's line names the model its output reported, and the one asked for apart", async () => {
    const env = await makeEnv();
    // Claude-shaped counts with both cache parts printed: 100 in, 10 out, nothing cached — a turn that can be priced.
    const usage: Usage = { status: "reported", input: 100, output: 10, total: null, cache_read: 0, cache_write: 0, not_printed: [] };
    const run = async (backend: string, requested: string | null, reported: readonly (string | null)[]) => {
      await new RecordingExec(
        new Fake(backend, { evidence: { source: backend, raw: "raw", usage, model: { requested, reported } } }),
        // A vendor CLI runs no model by construction: its line is what it says, and what it was asked.
        options(env, { model: null }),
      ).run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "p" });
      return (await query(env, SUBJECT)).entries.at(-1)!;
    };

    // Asked for an alias, and the output named what it resolved to: that is the model, and the price.
    const resolved = await run("claude", "opus", ["claude-opus-5-5"]);
    expect(resolved.model).toBe("claude-opus-5-5");
    expect(resolved.model_requested).toBe("opus");
    // 100 × $4.00 + 10 × $20.00 per million tokens = 600 µ$.
    expect(resolved.cost?.usd_micros).toBe(600);

    // The output named a model other than the one asked for: what it ran wins, for the name and the price.
    const other = await run("claude", "claude-opus-5", ["claude-sonnet-5"]);
    expect(other.model).toBe("claude-sonnet-5");
    expect(other.cost?.usd_micros).toBe(300);

    // Asked for an alias, and the output named nothing: the alias is recorded as asked, never priced as a model.
    const alias = await run("claude", "opus", []);
    expect(alias.model).toBeNull();
    expect(alias.model_requested).toBe("opus");
    expect(alias.cost).toBeNull();
    expect(alias.not_charged).toBe("model-unknown");

    // Asked for a full name the table lists for this backend, and the output named nothing: priced by it.
    const exact = await run("claude", "claude-opus-5", []);
    expect(exact.model).toBeNull();
    expect(exact.model_requested).toBe("claude-opus-5");
    // 100 × $5.00 + 10 × $25.00 per million tokens = 750 µ$.
    expect(exact.cost?.usd_micros).toBe(750);
    expect(exact.cost?.source).toBe("default");

    // The same name on a backend the table does not list it for is not a price.
    const elsewhere = await run("grok", "claude-opus-5", []);
    expect(elsewhere.not_charged).toBe("model-unknown");

    // The output named two models, or one it could not read: neither, and the request does not stand in for them.
    for (const reported of [["claude-opus-5-5", "claude-haiku-4-5"], [null]] as const) {
      const unclear = await run("claude", "claude-opus-5", reported);
      expect(unclear.model).toBeNull();
      expect(unclear.model_requested).toBe("claude-opus-5");
      expect(unclear.not_charged).toBe("model-unknown");
    }

    // Nothing asked, nothing named: the vendor's own default, unnamed and unpriced.
    const nothing = await run("claude", null, []);
    expect(nothing.model).toBeNull();
    expect(nothing.model_requested).toBeNull();
    expect(nothing.not_charged).toBe("model-unknown");

    // The request prices only an exact entry of a table in force — an owner's included — and not while the
    // owner's file cannot be read.
    const ownerNamed: PricesInForce = { ...SHIPPED, owner: { state: "ok", table: OWN } };
    await new RecordingExec(
      new Fake("ollama", { evidence: { source: "ollama", raw: "raw", usage: ollamaUsage(10, 5) } }),
      options(env, { model: "stub", prices: ownerNamed }),
    ).run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "p" });
    const ollama = (await query(env, SUBJECT)).entries.at(-1)!;
    // ollama runs the model it is handed: it is both the model and the request.
    expect([ollama.model, ollama.model_requested, ollama.cost?.usd_micros]).toEqual(["stub", "stub", 3]);
    const broken = await new RecordingExec(
      new Fake("claude", { evidence: { source: "claude", raw: "raw", usage, model: { requested: "claude-opus-5", reported: [] } } }),
      options(env, { model: null, prices: { ...SHIPPED, owner: { state: "unusable", reason: "x" } } }),
    ).run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "p" }).then(async () => (await query(env, SUBJECT)).entries.at(-1)!);
    expect(broken.not_charged).toBe("table-unusable");
  });

  test("--private keeps the counts, because a token total is not the words", async () => {
    // A `--private` line already records `prompt_bytes`, which bounds the size
    // of what was sent more tightly than a token count does. Withholding the
    // counts would cost the owner their own accounting without hiding
    // anything the line does not already imply.
    const env = await makeEnv();
    const usage = { status: "reported", input: 15, output: 24, total: null } as const;
    const wrapped = new RecordingExec(
      new Fake("ollama", { evidence: { source: "ollama", raw: "raw", usage } }),
      options(env, { content: "withheld" }),
    );
    await wrapped.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "canary-7f3a", system: "soul" });

    const line = (await query(env, SUBJECT)).entries[0]!;
    expect(line.content).toBe("withheld");
    expect(line.prompt).toBeNull();
    expect(line.usage).toEqual(usage);
  });

  test("a fallback line carries the counts of the backend that held the text, and only those", async () => {
    // One line per backend that was handed the prompt, and each line's counts
    // are its own. Summing them onto the answering backend would credit it
    // with tokens another vendor's tokenizer counted.
    const env = await makeEnv();
    const silent = new RecordingExec(
      new Fake("claude", {
        confidence: "silent",
        text: "",
        evidence: {
          source: "claude",
          raw: "",
          usage: { status: "reported", input: 7, output: 0, total: null },
        },
      }),
      options(env),
    );
    const answered = new RecordingExec(
      new Fake("ollama", {
        evidence: {
          source: "ollama",
          raw: "raw",
          usage: { status: "reported", input: 15, output: 24, total: null },
        },
      }),
      options(env),
    );

    const result = await new FallbackExec([silent, answered]).run({ restraint: RESTRAINED,
      subject: SUBJECT,
      prompt: "canary-7f3a",
      system: "soul",
    });

    // The chain hands the answering backend's evidence up, unmixed.
    expect(result.evidence.usage).toEqual({
      status: "reported",
      input: 15,
      output: 24,
      total: null,
    });

    const { entries } = await query(env, SUBJECT);
    const byBackend = new Map(entries.map((e) => [e.backend, e.usage]));
    expect(byBackend.get("claude")).toEqual({ status: "reported", input: 7, output: 0, total: null });
    expect(byBackend.get("ollama")).toEqual({ status: "reported", input: 15, output: 24, total: null });
  });

  test("a failed write is handed to the caller, never thrown at the chain", async () => {
    const env = await makeEnv();
    const failures: Error[] = [];
    // A directory that cannot be created: a file sits where it needs to be.
    const broken: LedgerEnv = { ...env, env: { XDG_STATE_HOME: "/dev/null/nope" } };
    const wrapped = new RecordingExec(
      new Fake("ollama", {}),
      options(broken, { onWriteFailure: (error) => failures.push(error) }),
    );

    // The turn's result still comes back: the answer is real even when the
    // bookkeeping failed, and hiding it would lose something true.
    const result = await wrapped.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "hello", system: "soul" });
    expect(result.text).toBe("answer from ollama");
    expect(failures.length).toBe(1);
  });
});

describe("how long a line waits for the lock depends on whether its send has happened (D-145)", () => {
  test("behind a 10 s hold, chat and A2A lines written before a send give up at about 5 s; a turn's line after its answer is recorded", async () => {
    const env = await makeEnv();
    const dir = ledgerDir(env, SUBJECT);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // A live holder in a process of its own, as another turn or a `forget` would be.
    const holder = Bun.spawn([process.execPath, "run", join(import.meta.dir, "lock-child.ts"), "hold", dir, "10000"], {
      env: { PATH: process.env["PATH"] ?? "", HOME: env.home, XDG_STATE_HOME: join(env.home, "state"), MIND_QDRANT_URL: "http://127.0.0.1:9" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = holder.stdout.getReader();
    let seen = "";
    while (!seen.split("\n").includes("held")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`the holder ended without taking the lock: ${seen}`);
      seen += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();

    const began = performance.now();
    const timed = <T>(work: Promise<T>) =>
      work.then(
        (value) => ({ ok: true as const, value, after: performance.now() - began }),
        (error: unknown) => ({ ok: false as const, error, after: performance.now() - began }),
      );
    const message: ChatMessage = { platform: "telegram", chatId: "chat-1", userId: "user-1", messageId: "msg-1", text: "hello" };
    const [chat, a2a, check, recorded] = await Promise.all([
      // The gates, with append's default: chat records a message before it answers, A2A before it delivers.
      timed(append(env, chatEntry({ subject: SUBJECT, direction: "in", message, text: "hello", at: new Date(), content: "full" }))),
      timed(append(env, messageEntry({ subject: SUBJECT, direction: "in", peer: "a-peer", messageId: "a2a-1", text: "hello", at: new Date(), content: "full" }))),
      timed(canAppend(env, SUBJECT)),
      // After a send: the backend has answered, and its line must not be lost to the hold.
      timed(new RecordingExec(new Fake("ollama", {}), options(env)).run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "p", system: "s" })),
    ]);

    for (const gate of [chat, a2a]) {
      expect(gate.ok).toBe(false);
      if (!gate.ok) expect(gate.error).toBeInstanceOf(LedgerLocked);
      expect(gate.after).toBeGreaterThanOrEqual(LOCK_TIMING.waitMs);
      expect(gate.after).toBeLessThan(9_000);
    }
    expect(check.ok && !check.value.ok && check.value.kind).toBe("locked");
    expect(check.after).toBeLessThan(9_000);
    // `options` throws from onWriteFailure, so a run that resolved is a line that was written.
    expect(recorded.ok).toBe(true);
    expect(recorded.after).toBeGreaterThanOrEqual(9_000);
    const { entries } = await query(env, SUBJECT);
    expect(entries.map((entry) => entry.backend)).toEqual(["ollama"]);
    expect(await holder.exited).toBe(0);
  }, 40_000);
});
