/**
 * The price table (S15.9, D-110, D-139): the one shipped with Mind, the owner's own, and which one a price
 * came from.
 *
 * The properties bought here: an unknown model has no price rather than a zero; the owner's file replaces a
 * shipped price entry by entry and never silently falls back when it is broken; a typo in it is a refusal,
 * not a null; and the shipped table prices only what a turn can actually be priced by.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseJsonStrict } from "../../src/identity/strict-json.ts";
import { VENDORS } from "../../src/exec/registry.ts";
import {
  DEFAULT_PRICES,
  findPrice,
  loadPrices,
  MAX_PRICE_FILE_BYTES,
  MAX_RATE,
  ownerPricesPath,
  parsePriceTable,
  PRICE_TABLE_KIND,
  SHIPPED_TABLES,
  pricesInForce,
  readOwnerPrices,
  shippedTable,
  tableDigest,
  validatePriceTable,
  type PricesInForce,
} from "../../src/pricing/table.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const SHIPPED_DIR = join(ROOT, "src", "pricing", "shipped");
const SHIPPED_FILE = join(SHIPPED_DIR, "2026-09-29.json");
/** The table before D-143: priced every cache write at the 5-minute rate. Kept, so reports priced by it still check. */
const SHIPPED_FILE_0928 = join(SHIPPED_DIR, "2026-09-28.json");

/**
 * Every shipped table's version and digest (PR #3 review, R5). A signed report names a shipped table by both,
 * and `usage verify` holds its rows to that content — so a shipped file is never edited, a note included. New
 * prices are a new `shipped/<version>.json`, appended to SHIPPED_TABLES and pinned here; the old one stays.
 */
const PINNED: Readonly<Record<string, string>> = {
  "2026-09-28": "a31ab3b3ae968235",
  // D-143: the 1-hour cache-write rate of every claude model; grok as it was.
  "2026-09-29": "aa87cfa68980bcdf",
};

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-prices-"));
  scratch.push(dir);
  return dir;
}

/** A valid owner table with one local model priced. */
function ownTable(overrides: Record<string, unknown> = {}, entries?: unknown[]): Record<string, unknown> {
  return {
    kind: PRICE_TABLE_KIND,
    v: 1,
    version: "home-1",
    currency: "usd",
    unit: "micros-per-million-tokens",
    prices: entries ?? [{ backend: "ollama", model: "qwen3:8b", input: 20_000, output: 60_000, cache_read: null, cache_write: null }],
    ...overrides,
  };
}

describe("the shipped tables are never edited (R5)", () => {
  test("every shipped version is pinned to its digest, one file per version, named by it; the newest is the default", async () => {
    expect(Object.fromEntries(SHIPPED_TABLES.map((t) => [t.version, t.digest]))).toEqual(PINNED);
    const files = (await readdir(SHIPPED_DIR)).filter((name) => name.endsWith(".json")).sort();
    expect(files).toEqual(Object.keys(PINNED).sort().map((version) => `${version}.json`));
    for (const file of files) {
      const read = parsePriceTable(await Bun.file(join(SHIPPED_DIR, file)).text());
      expect(read.ok, file).toBe(true);
      if (read.ok) expect(`${read.table.version}.json`).toBe(file);
    }
    expect(DEFAULT_PRICES).toBe(SHIPPED_TABLES.at(-1)!);
    // The default is the last one, so the list must run oldest to newest (S15.9 third review).
    const versions = SHIPPED_TABLES.map((t) => t.version);
    expect(versions).toEqual([...versions].sort());
    for (const table of SHIPPED_TABLES) expect(shippedTable(table.version)).toBe(table);
  });

  test("an owner file that is a shipped table word for word is unusable, with the fix", async () => {
    const dir = await home();
    const path = join(dir, "prices.json");
    for (const [file, version] of [[SHIPPED_FILE, "2026-09-29"], [SHIPPED_FILE_0928, "2026-09-28"]] as const) {
      await writeFile(path, await Bun.file(file).text(), { mode: 0o600 });
      const read = await readOwnerPrices(path);
      expect(read.state).toBe("unusable");
      if (read.state === "unusable") expect(read.reason).toContain(`is the shipped table ${version} word for word`);
    }
  });

  test("D-143: the default is 2026-09-29, and 2026-09-28 is still carried, still without a 1-hour rate", () => {
    expect(DEFAULT_PRICES.version).toBe("2026-09-29");
    const before = shippedTable("2026-09-28")!;
    // Read without the field it never had: its digest is the one reports priced by it carry (pinned above).
    for (const entry of before.entries) expect("cache_write_1h" in entry).toBe(false);
    // Every other rate is the same in both: the new table only adds the 1-hour write.
    for (const entry of before.entries) {
      const now = DEFAULT_PRICES.entries.find((e) => e.backend === entry.backend && e.model === entry.model)!;
      expect({ ...now, cache_write_1h: undefined }).toEqual({ ...entry, cache_write_1h: undefined });
    }
    expect(DEFAULT_PRICES.entries.length).toBe(before.entries.length);
  });
});

describe("the shipped table", () => {
  test("validates, is dated, and names where each group of prices was read and when", async () => {
    expect(DEFAULT_PRICES.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(DEFAULT_PRICES.entries.length).toBeGreaterThan(5);
    for (const source of DEFAULT_PRICES.sources) {
      expect(source.url).toStartWith("https://");
      expect(source.read).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.note?.length ?? 0).toBeGreaterThan(40);
    }
    // Every backend priced has a source that says where its prices came from.
    const sourced = new Set(DEFAULT_PRICES.sources.flatMap((s) => s.backends ?? []));
    for (const entry of DEFAULT_PRICES.entries) expect(sourced.has(entry.backend), entry.backend).toBe(true);
    // The file itself, read the strict way: no field twice, anywhere.
    expect(parseJsonStrict(await Bun.file(SHIPPED_FILE).text()).ok).toBe(true);
    expect(parsePriceTable(await Bun.file(SHIPPED_FILE).text()).ok).toBe(true);
  });

  test("prices only backends whose usage splits into the four parts — a price no turn can use is not shipped", () => {
    // claude and grok print input, output and both cache counts apart; codex prints one total; gemini,
    // copilot and kimi are unsurveyed. A price for any of those would never be applied — and would read
    // as if it were.
    const splits = new Set(
      VENDORS.filter((v) => v.usage?.shape === "json" && v.usage.cacheRead !== undefined && v.usage.cacheWrite !== undefined).map((v) => v.id),
    );
    expect([...splits].sort()).toEqual(["claude", "grok"]);
    for (const entry of DEFAULT_PRICES.entries) expect(splits.has(entry.backend), entry.backend).toBe(true);
  });

  test("prices no model on this machine — that is the owner's to price (D-106)", () => {
    for (const entry of DEFAULT_PRICES.entries) {
      expect(["ollama", "claude-local", "grok-local"]).not.toContain(entry.backend);
      expect(entry.model).not.toBe("local-coder");
    }
  });

  test("a part the vendor publishes no price for is null, never 0", () => {
    const grok = DEFAULT_PRICES.entries.filter((e) => e.backend === "grok");
    expect(grok.length).toBeGreaterThan(0);
    for (const entry of grok) expect([entry.cache_write, entry.cache_write_1h]).toEqual([null, null]);
    for (const entry of DEFAULT_PRICES.entries) {
      for (const rate of [entry.input, entry.output, entry.cache_read, entry.cache_write, entry.cache_write_1h]) {
        if (rate !== null) expect(rate).toBeGreaterThan(0);
      }
    }
  });

  test("D-143: every entry writes its 1-hour rate — claude's at 2x input, as Anthropic's page states it — and none leaves it out", () => {
    for (const entry of DEFAULT_PRICES.entries) expect("cache_write_1h" in entry, `${entry.backend} ${entry.model}`).toBe(true);
    const claude = DEFAULT_PRICES.entries.filter((e) => e.backend === "claude");
    expect(claude.length).toBe(12);
    for (const entry of claude) {
      // The page's multipliers: a 5-minute write at 1.25x input, a 1-hour write at 2x.
      expect(entry.cache_write_1h, entry.model).toBe(entry.input! * 2);
      expect(entry.cache_write, entry.model).toBe(entry.input! * 1.25);
    }
    expect(DEFAULT_PRICES.entries.find((e) => e.model === "claude-haiku-4-5")!.cache_write_1h).toBe(2_000_000);
    expect(DEFAULT_PRICES.entries.find((e) => e.model === "claude-opus-5-5")!.cache_write_1h).toBe(8_000_000);
  });

  test("the rates are whole micro-dollars per million tokens: $3/MTok is 3000000", () => {
    const sonnet = DEFAULT_PRICES.entries.find((e) => e.model === "claude-sonnet-4-6")!;
    expect(sonnet).toMatchObject({ input: 3_000_000, output: 15_000_000, cache_read: 300_000, cache_write: 3_750_000, cache_write_1h: 6_000_000 });
  });
});

describe("what a price table may say", () => {
  test("the owner's own table is the same shape, and sources are optional", () => {
    const read = validatePriceTable(ownTable());
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.table.version).toBe("home-1");
      expect(read.table.sources).toEqual([]);
      expect(read.table.entries).toEqual([{ backend: "ollama", model: "qwen3:8b", input: 20_000, output: 60_000, cache_read: null, cache_write: null }]);
    }
  });

  test.each([
    ["not an object", [], "not a JSON object"],
    ["an unknown top-level field", ownTable({ prices_usd: [] }), "does not have"],
    ["another kind", ownTable({ kind: "something" }), "kind"],
    ["another format version", ownTable({ v: 2 }), '"v"'],
    ["no version", ownTable({ version: undefined }), "version"],
    ["a version with a space", ownTable({ version: "my table" }), "version"],
    ["another currency", ownTable({ currency: "thb" }), "US dollars only"],
    ["dollars instead of micro-dollars", ownTable({ unit: "usd-per-million-tokens" }), "300000"],
    ["sources that are not a list", ownTable({ sources: {} }), "sources"],
    ["a source with an unknown field", ownTable({ sources: [{ link: "x" }] }), "sources[0]"],
    ["a source whose url is not text", ownTable({ sources: [{ url: 7 }] }), "sources[0].url"],
    ["a source that is not an object", ownTable({ sources: ["x"] }), "sources[0]"],
    ["a source whose backends are not ids", ownTable({ sources: [{ backends: "claude" }] }), "sources[0].backends"],
    ["prices that are not a list", ownTable({ prices: {} }), "prices"],
    ["a price that is not an object", ownTable({}, [7]), "prices[0]"],
    ["a misspelt part", ownTable({}, [{ backend: "ollama", model: "m", input: 1, output: 1, cache_read: null, cache_writes: 1 }]), "cache_writes"],
    ["a part left out", ownTable({}, [{ backend: "ollama", model: "m", input: 1, output: 1, cache_read: null }]), "cache_write is missing"],
    ["a price in dollars", ownTable({}, [{ backend: "ollama", model: "m", input: 0.3, output: 1, cache_read: null, cache_write: null }]), "prices[0].input"],
    ["a negative price", ownTable({}, [{ backend: "ollama", model: "m", input: -1, output: 1, cache_read: null, cache_write: null }]), "prices[0].input"],
    ["a price past the ceiling", ownTable({}, [{ backend: "ollama", model: "m", input: MAX_RATE + 1, output: 1, cache_read: null, cache_write: null }]), "prices[0].input"],
    ["a quoted price", ownTable({}, [{ backend: "ollama", model: "m", input: "1", output: 1, cache_read: null, cache_write: null }]), "prices[0].input"],
    ["a backend that is a message", ownTable({}, [{ backend: "a2a:in:x", model: "m", input: 1, output: 1, cache_read: null, cache_write: null }]), "backend"],
    ["a model that is a path", ownTable({}, [{ backend: "ollama", model: "/models/x.gguf", input: 1, output: 1, cache_read: null, cache_write: null }]), "model"],
    [
      "one model priced twice",
      ownTable({}, [
        { backend: "ollama", model: "m", input: 1, output: 1, cache_read: null, cache_write: null },
        { backend: "ollama", model: "m", input: 2, output: 2, cache_read: null, cache_write: null },
      ]),
      "a second time",
    ],
  ])("refuses %s, and says why", (_name, value, reason) => {
    const read = validatePriceTable(value);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain(reason);
  });

  test("D-143: an owner's entry may write cache_write_1h or leave it out — left out it is no price, and no digest moves", () => {
    const without = validatePriceTable(ownTable());
    const withNull = validatePriceTable(ownTable({}, [{ backend: "ollama", model: "qwen3:8b", input: 20_000, output: 60_000, cache_read: null, cache_write: null, cache_write_1h: null }]));
    const priced = validatePriceTable(ownTable({}, [{ backend: "claude-local", model: "local-coder", input: 1, output: 2, cache_read: 0, cache_write: 1, cache_write_1h: 2 }]));
    if (!without.ok || !withNull.ok || !priced.ok) throw new Error("a table did not validate");
    // Read as written: no seventh field the file did not have, so a file from before D-143 keeps its digest.
    expect("cache_write_1h" in without.table.entries[0]!).toBe(false);
    expect(withNull.table.entries[0]!.cache_write_1h).toBeNull();
    expect(withNull.table.digest).not.toBe(without.table.digest);
    expect(priced.table.entries[0]!.cache_write_1h).toBe(2);
    for (const bad of [-1, 1.5, "2", MAX_RATE + 1]) {
      const read = validatePriceTable(ownTable({}, [{ backend: "claude", model: "m", input: 1, output: 1, cache_read: 1, cache_write: 1, cache_write_1h: bad }]));
      expect(read.ok, String(bad)).toBe(false);
      if (!read.ok) expect(read.reason).toContain("prices[0].cache_write_1h");
    }
    const misspelt = validatePriceTable(ownTable({}, [{ backend: "claude", model: "m", input: 1, output: 1, cache_read: 1, cache_write: 1, cache_write_1hr: 2 }]));
    expect(misspelt.ok).toBe(false);
    if (!misspelt.ok) expect(misspelt.reason).toContain("cache_write_1hr");
  });

  test("a field written twice in the file is refused, not settled by whichever comes last", () => {
    const text = JSON.stringify(ownTable()).replace('"version":"home-1"', '"version":"home-1","version":"home-2"');
    const read = parsePriceTable(text);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("duplicate");
    expect(parsePriceTable("{ // a comment\n}").ok).toBe(false);
  });

  test("a rate written any way but plain integer digits is refused, though it has the same value (D-141)", () => {
    const plain = JSON.stringify(ownTable());
    expect(plain).toContain('"input":20000');
    expect(parsePriceTable(plain).ok).toBe(true);
    for (const spelling of ["20000.0", "2e4", "2E4", "2.0e4"]) {
      const read = parsePriceTable(plain.replace('"input":20000', `"input":${spelling}`));
      expect(read.ok, spelling).toBe(false);
      if (!read.ok) expect(read.reason).toContain("fraction or an exponent");
    }
  });
});

describe("the owner's file", () => {
  test("lives under the state root, beside the ledger", async () => {
    const dir = await home();
    expect(ownerPricesPath(dir, { XDG_STATE_HOME: join(dir, "state") })).toBe(join(dir, "state", "mind", "prices.json"));
    expect(ownerPricesPath(dir, {})).toBe(join(dir, ".local", "state", "mind", "prices.json"));
  });

  test("absent is absent; present and well formed is in force; symlinked is followed", async () => {
    const dir = await home();
    const env = { XDG_STATE_HOME: join(dir, "state") };
    expect((await loadPrices(dir, env)).owner).toEqual({ state: "absent" });

    const path = ownerPricesPath(dir, env);
    await mkdir(join(dir, "state", "mind"), { recursive: true });
    await writeFile(join(dir, "dotfiles-prices.json"), JSON.stringify(ownTable()), { mode: 0o644 });
    await symlink(join(dir, "dotfiles-prices.json"), path);
    const prices = await loadPrices(dir, env);
    expect(prices.owner.state).toBe("ok");
    expect(prices.ownerPath).toBe(path);
  });

  test("a file others can write, a directory, an oversized or malformed file are each unusable, and say why", async () => {
    const dir = await home();
    const path = join(dir, "prices.json");

    await writeFile(path, JSON.stringify(ownTable()), { mode: 0o600 });
    await chmod(path, 0o666);
    let read = await readOwnerPrices(path);
    expect(read.state).toBe("unusable");
    if (read.state === "unusable") expect(read.reason).toContain("chmod go-w");

    await chmod(path, 0o600);
    await writeFile(path, "{not json");
    read = await readOwnerPrices(path);
    expect(read.state).toBe("unusable");
    if (read.state === "unusable") expect(read.reason).toContain("strict JSON");

    await writeFile(path, " ".repeat(MAX_PRICE_FILE_BYTES + 1));
    read = await readOwnerPrices(path);
    expect(read.state).toBe("unusable");
    if (read.state === "unusable") expect(read.reason).toContain("bytes");

    await rm(path);
    await mkdir(path);
    read = await readOwnerPrices(path);
    expect(read.state).toBe("unusable");
    if (read.state === "unusable") expect(read.reason).toMatch(/regular file|cannot be/);
  });

  test("M1: a symlink whose target is gone is unusable, never absent — no fallback to list prices", async () => {
    const dir = await home();
    const env = { XDG_STATE_HOME: join(dir, "state") };
    const path = ownerPricesPath(dir, env);
    await mkdir(join(dir, "state", "mind"), { recursive: true });
    await symlink(join(dir, "dotfiles", "moved-away.json"), path);
    const dangling = await loadPrices(dir, env);
    expect(dangling.owner.state).toBe("unusable");
    if (dangling.owner.state === "unusable") expect(dangling.owner.reason).toContain("symbolic link whose target does not exist");

    // A loop is unusable too, and says the kernel's reason.
    await rm(path);
    await symlink(path, path);
    expect((await readOwnerPrices(path)).state).toBe("unusable");

    // And a link to a real file is still followed.
    await rm(path);
    await writeFile(join(dir, "real.json"), JSON.stringify(ownTable()), { mode: 0o600 });
    await symlink(join(dir, "real.json"), path);
    expect((await readOwnerPrices(path)).state).toBe("ok");
  });

  test("a FIFO at the path cannot hang the turn that reads it", async () => {
    const dir = await home();
    const path = join(dir, "prices.json");
    const made = Bun.spawnSync(["mkfifo", path]);
    if (made.exitCode !== 0) return; // no mkfifo here; nothing to measure
    const read = await readOwnerPrices(path);
    expect(read.state).toBe("unusable");
  });
});

describe("a table's digest binds what it says", () => {
  test("16 hex characters over the canonical table: key order and spacing do not move it, a price does", () => {
    const one = validatePriceTable(ownTable());
    const reordered = parsePriceTable(`{"prices": ${JSON.stringify(ownTable()["prices"])}, "unit": "micros-per-million-tokens", "currency": "usd", "version": "home-1", "v": 1, "kind": "${PRICE_TABLE_KIND}"}`);
    const repriced = validatePriceTable(ownTable({}, [{ backend: "ollama", model: "qwen3:8b", input: 20_001, output: 60_000, cache_read: null, cache_write: null }]));
    const renamed = validatePriceTable(ownTable({ version: "home-2" }));
    const sourced = validatePriceTable(ownTable({ sources: [{ note: "power at 5 THB/kWh" }] }));
    if (!one.ok || !reordered.ok || !repriced.ok || !renamed.ok || !sourced.ok) throw new Error("a table did not validate");
    expect(one.table.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(reordered.table.digest).toBe(one.table.digest);
    for (const other of [repriced, renamed, sourced]) expect(other.table.digest).not.toBe(one.table.digest);
    // Exactly the documented bytes: sha256 of the canonical {kind, v, version, currency, unit, sources, prices}.
    // The kind in it is mind.price-table: the digest of a table is signed into reports.
    const canonical =
      `{"currency":"usd","kind":"${PRICE_TABLE_KIND}","prices":[{"backend":"ollama","cache_read":null,"cache_write":null,"input":20000,"model":"qwen3:8b","output":60000}],"sources":[],"unit":"micros-per-million-tokens","v":1,"version":"home-1"}`;
    expect(one.table.digest).toBe(new Bun.CryptoHasher("sha256").update(canonical).digest("hex").slice(0, 16));
    expect(tableDigest(one.table)).toBe(one.table.digest);
  });

  test("text with no canonical form cannot be bound, so the table is refused rather than thrown", () => {
    const read = validatePriceTable(ownTable({ sources: [{ note: "half a pair \ud800" }] }));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("cannot be digested");
  });

  test("the shipped table is found by its version, and no other", () => {
    expect(shippedTable(DEFAULT_PRICES.version)).toBe(DEFAULT_PRICES);
    expect(shippedTable("2031-01-01")).toBeUndefined();
  });
});

describe("the kind of a price table file", () => {
  test("a table of kind mind.price-table is read, from a value and from text, with the same digest", () => {
    expect(PRICE_TABLE_KIND).toBe("mind.price-table");
    const current = validatePriceTable(ownTable({ kind: PRICE_TABLE_KIND }));
    if (!current.ok) throw new Error("a table did not validate");
    const read = parsePriceTable(JSON.stringify(ownTable({ kind: PRICE_TABLE_KIND })));
    expect(read.ok && read.table.digest).toBe(current.table.digest);
  });

  test("an owner's prices.json of that kind is usable", async () => {
    const dir = await home();
    const path = join(dir, "prices.json");
    await writeFile(path, JSON.stringify(ownTable({ kind: PRICE_TABLE_KIND })), { mode: 0o600 });
    expect((await readOwnerPrices(path)).state).toBe("ok");
  });

  test("any other kind is refused, and the reason names the kind", () => {
    for (const kind of ["price-table", "mind.usage-report", "", 1, null, undefined]) {
      const read = validatePriceTable(ownTable({ kind }));
      expect(read.ok, String(kind)).toBe(false);
      if (!read.ok) expect(read.reason).toBe(`"kind" is not "${PRICE_TABLE_KIND}"`);
    }
  });

  test("the two shipped files carry the kind, and keep the digest pinned here (the kind is inside the digest's preimage)", async () => {
    for (const [version, digest] of Object.entries(PINNED)) {
      const file = JSON.parse(await Bun.file(join(SHIPPED_DIR, `${version}.json`)).text()) as Record<string, unknown>;
      expect(file["kind"], version).toBe(PRICE_TABLE_KIND);
      const read = validatePriceTable(file);
      expect(read.ok && read.table.digest, version).toBe(digest);
    }
  });
});

describe("which price a turn gets", () => {
  const owner = validatePriceTable(
    ownTable({}, [
      { backend: "ollama", model: "qwen3:8b", input: 20_000, output: 60_000, cache_read: null, cache_write: null },
      // A subscription holder pricing claude at what they really pay.
      { backend: "claude", model: "claude-sonnet-4-6", input: 0, output: 0, cache_read: 0, cache_write: 0 },
    ]),
  );
  if (!owner.ok) throw new Error(owner.reason);
  const prices: PricesInForce = { default: DEFAULT_PRICES, owner: { state: "ok", table: owner.table }, ownerPath: "/x" };

  test("the owner's entry replaces the shipped one for that backend and model, and only that one", () => {
    expect(findPrice(prices, "claude", "claude-sonnet-4-6")).toEqual({
      origin: "owner",
      table: "home-1",
      digest: owner.table.digest,
      rates: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    });
    expect(findPrice(prices, "claude", "claude-opus-5")?.digest).toBe(DEFAULT_PRICES.digest);
    // The shipped entry's 1-hour rate comes with it; the owner's entry that has none has none (D-143).
    expect(findPrice(prices, "claude", "claude-opus-5")?.rates.cache_write_1h).toBe(10_000_000);
    expect("cache_write_1h" in findPrice(prices, "claude", "claude-sonnet-4-6")!.rates).toBe(false);
    expect(findPrice(prices, "claude", "claude-opus-5")?.origin).toBe("default");
    expect(findPrice(prices, "claude", "claude-opus-5")?.table).toBe(DEFAULT_PRICES.version);
    expect(findPrice(prices, "ollama", "qwen3:8b")?.rates.input).toBe(20_000);
  });

  test("exact names only: an alias, a neighbour and another backend's model have no price", () => {
    expect(findPrice(prices, "claude", "opus")).toBeUndefined();
    expect(findPrice(prices, "claude", "claude-opus-5-20260101")).toBeUndefined();
    expect(findPrice(prices, "claude", "qwen3:8b")).toBeUndefined();
    expect(findPrice(prices, "ollama", "qwen3:14b")).toBeUndefined();
  });

  test("the list in force puts the owner's first, and a shadowed shipped price is not listed", () => {
    const listed = pricesInForce(prices);
    expect(listed[0]).toMatchObject({ backend: "ollama", origin: "owner", table: "home-1" });
    expect(listed.filter((e) => e.backend === "claude" && e.model === "claude-sonnet-4-6").map((e) => e.origin)).toEqual(["owner"]);
    expect(listed.length).toBe(DEFAULT_PRICES.entries.length + 1);
    const shippedOnly = pricesInForce({ ...prices, owner: { state: "absent" } });
    expect(shippedOnly.every((e) => e.origin === "default")).toBe(true);
  });
});
