/**
 * The price table: what a million tokens of one model on one backend costs, in whole US micro-dollars
 * (S15.9, D-110, D-139).
 *
 * Two tables can be in force, and a line always says which one its price came from:
 *
 * - **default** — the newest file in `shipped/`, named by its version and shipped in the binary. Dated, and
 *   each group of prices names the page it was read from and the day. Only backends whose usage can be priced
 *   are in it: claude and grok print input, output and both cache counts apart; codex prints one total, and
 *   gemini, copilot and kimi have not been surveyed, so a price for them would be a price no turn could use.
 *
 *   **A shipped file is never edited** (PR #3 review, R5). A signed report names a shipped table by version
 *   and digest, and `usage verify` holds the row to it — so a version whose content changed would turn old,
 *   honest reports into refused ones. New prices are a new file with a new version, added to
 *   {@link SHIPPED_TABLES}; the old files stay so the reports priced by them still check.
 *   `test/pricing/table.test.ts` pins every version's digest, so an edit, a note included, goes red.
 * - **owner** — `$XDG_STATE_HOME/mind/prices.json`, written by the owner and never by Mind. It has the
 *   same shape. It is where a model on this machine gets a price at all (D-106: power and GPU are the owner's
 *   to price) and where an owner on a subscription says what their turns really cost them. An entry there
 *   replaces the default entry for the same backend and model; every other default entry still stands.
 *
 * ## Unknown is unknown
 *
 * A backend and model with no entry have **no price** — not a zero, and not the price of a model with a
 * similar name. Neither does a part a table leaves null (xAI publishes no cache-write price): a turn that
 * used that part is not charged. `0` is a price, and an owner who writes one is saying the turn is free.
 * The one part a table may leave out is `cache_write_1h` (D-143), and left out it is no price too: a turn
 * that wrote to the 1-hour cache is not charged, never charged at the 5-minute rate.
 *
 * ## Why an owner file that cannot be read stops all pricing
 *
 * A price file the owner wrote and got wrong is not the same as no price file. Falling back to the default
 * table would charge a hirer the list price of a model the owner meant to price at their own rate — the one
 * outcome the owner's file exists to prevent — so every turn while it is broken is recorded as not charged
 * (`table-unusable`), and `turn` and `usage prices` say why.
 *
 * Strict for the same reason: an unknown field (`cache_reads`) would otherwise leave the real field absent,
 * which reads as null, which reads as "this part has no price" — a typo quietly turning into a policy. The
 * file is parsed with the signed-report parser, which refuses a field named twice and a number written any way
 * but plain integer digits (`3e5`, `300000.0` — D-141): every number in it is a whole rate or a format
 * version, and the rates are copied into signed rows.
 *
 * Money is integers throughout — a rate is micro-dollars per million tokens, so $0.30/MTok is `300000` —
 * because a line's cost ends up in a signed report whose canonical JSON allows integers only (D-138).
 */

import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "../state.ts";
import { isModelBackend, isModelName, isSafeId } from "../identity/shapes.ts";
import { canonicalBytes } from "../identity/sign.ts";
import { parseJsonStrict } from "../identity/strict-json.ts";
import { createHash } from "node:crypto";
import SHIPPED_2026_09_28 from "./shipped/2026-09-28.json" with { type: "json" };
import SHIPPED_2026_09_29 from "./shipped/2026-09-29.json" with { type: "json" };

/** The `kind` of a price table file: `mind.price-table`. It is also the `kind` inside the digest preimage (see {@link tableDigest}). */
export const PRICE_TABLE_KIND = "mind.price-table";
export const PRICE_TABLE_V = 1;
export const PRICE_CURRENCY = "usd";
export const PRICE_UNIT = "micros-per-million-tokens";
/** The owner's file, under the state root beside the ledger, the peers and the triggers. */
export const OWNER_PRICES_FILE = "prices.json";
/** A rate above this — a million dollars per million tokens — is a typo, not a price. */
export const MAX_RATE = 1_000_000_000_000;
/** A price file larger than this is not a price file. */
export const MAX_PRICE_FILE_BYTES = 1 << 20;

/** Micro-dollars per million tokens, per part. `null`: this table has no price for that part. */
export interface Rates {
  readonly input: number | null;
  readonly output: number | null;
  readonly cache_read: number | null;
  /**
   * A cache write — the 5-minute one where the vendor prices two (Anthropic: 1.25× input), and every write of
   * a backend that never splits its writes (D-143).
   */
  readonly cache_write: number | null;
  /**
   * A write to the vendor's 1-hour cache (Anthropic: 2× input), priced apart since D-143. **Optional**, and
   * absent means the same as null — no price: a table written before D-143 (the shipped `2026-09-28`, an
   * owner's file) does not have it, and a turn that wrote to the 1-hour cache is then not charged, never
   * charged at the 5-minute rate. On a line's or a row's rates it is there only when the turn wrote to the
   * 1-hour cache, so every other row keeps the shape a reader from before D-143 reads.
   */
  readonly cache_write_1h?: number | null;
}

/** The four parts every price and every cost names — the rates a table must write, null or not. */
export const RATE_FIELDS: readonly (keyof Rates)[] = ["input", "output", "cache_read", "cache_write"];

/** The part a table may write and a cost carries only when used (D-143): see {@link Rates.cache_write_1h}. */
export const RATE_1H = "cache_write_1h";

/** Every rate field, the four and the one that may be absent — for a reader that has to name them all. */
export const ALL_RATE_FIELDS: readonly (keyof Rates)[] = [...RATE_FIELDS, RATE_1H];

/** `cache_write_1h` as a whole rate or null, whether the object left it out or wrote null. */
export const rate1h = (rates: Rates): number | null => rates.cache_write_1h ?? null;

export interface PriceEntry extends Rates {
  readonly backend: string;
  readonly model: string;
}

/** Where a group of prices was read, and what it does not cover. For people; never used in arithmetic. */
export interface PriceSource {
  readonly backends?: readonly string[];
  readonly url?: string;
  readonly read?: string;
  readonly note?: string;
}

export interface PriceTable {
  /** The table's own version, recorded on every line priced from it. */
  readonly version: string;
  /**
   * What the table says, bound: the first 16 hex characters of SHA-256 over its canonical JSON (PR #3
   * review). A version is a name the owner chose and can keep while changing every price under it; the
   * digest changes with any of them, so a row that carries it says which content priced it. See
   * {@link tableDigest} for exactly what is hashed.
   */
  readonly digest: string;
  readonly sources: readonly PriceSource[];
  readonly entries: readonly PriceEntry[];
}

/** A table digest's shape: 16 lowercase hex characters. */
export const TABLE_DIGEST = /^[0-9a-f]{16}$/;

/**
 * The digest of a table: `sha256(canonicalJson({kind, v, version, currency, unit, sources, prices}))`, hex,
 * first 16 characters — over the table as validated, so key order and whitespace in the file do not move
 * it and every field that can change a price or its provenance does. The `kind` in that preimage is
 * {@link PRICE_TABLE_KIND}: the digest of a shipped table is signed into usage reports and checked against
 * mind-platform's own copy, so the preimage cannot move without a new table version both sides understand.
 * `sources` is `[]` when the file has none; `prices` keeps the file's order and exactly the six fields of an
 * entry — seven when the entry writes `cache_write_1h` (D-143), null or not, and never a seventh the file did
 * not write, so a table from before D-143 keeps the digest it had. The canonical JSON is the one reports are
 * signed over (RFC 8785, integers only — D-138), so another implementation gets the same.
 */
export function tableDigest(table: Omit<PriceTable, "digest">): string {
  const canonical = canonicalBytes({
    kind: PRICE_TABLE_KIND,
    v: PRICE_TABLE_V,
    version: table.version,
    currency: PRICE_CURRENCY,
    unit: PRICE_UNIT,
    sources: table.sources,
    prices: table.entries,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export type TableOrigin = "default" | "owner";

/** The owner's file, as found. */
export type OwnerTable =
  | { readonly state: "absent" }
  | { readonly state: "ok"; readonly table: PriceTable }
  | { readonly state: "unusable"; readonly reason: string };

/** What a turn is priced against: always the default, and the owner's file as it stood when the turn began. */
export interface PricesInForce {
  readonly default: PriceTable;
  readonly owner: OwnerTable;
  /** Where the owner's file is looked for. Printed by `usage prices`; never written into a line or a report. */
  readonly ownerPath: string;
}

export type TableRead = { readonly ok: true; readonly table: PriceTable } | { readonly ok: false; readonly reason: string };

const TOP_FIELDS = new Set(["kind", "v", "version", "currency", "unit", "sources", "prices"]);
const SOURCE_FIELDS = new Set(["backends", "url", "read", "note"]);
const ENTRY_FIELDS = new Set(["backend", "model", ...ALL_RATE_FIELDS]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function unknownField(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key));
}

function rateProblem(value: unknown): boolean {
  return value !== null && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RATE);
}

function sourceProblem(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at} is not an object`;
  const extra = unknownField(value, SOURCE_FIELDS);
  if (extra !== undefined) return `${at} has a field a price table does not have: ${JSON.stringify(extra)}`;
  for (const field of ["url", "read", "note"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return `${at}.${field} is not text`;
  }
  const backends = value["backends"];
  if (backends !== undefined && (!Array.isArray(backends) || !backends.every((b) => typeof b === "string"))) {
    return `${at}.backends is not a list of backend ids`;
  }
  return undefined;
}

function entryProblem(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at} is not an object`;
  const extra = unknownField(value, ENTRY_FIELDS);
  if (extra !== undefined) {
    return `${at} has a field a price does not have: ${JSON.stringify(extra)} (the fields are backend, model, ${RATE_FIELDS.join(", ")}, and ${RATE_1H} if you price it)`;
  }
  if (typeof value["backend"] !== "string" || !isModelBackend(value["backend"])) return `${at}.backend is not a backend id (claude, ollama, claude-local, …)`;
  if (typeof value["model"] !== "string" || !isModelName(value["model"])) return `${at}.model is not a model's name (name or org/name)`;
  for (const field of RATE_FIELDS) {
    if (!(field in value)) return `${at}.${field} is missing — write null for a part with no price, so leaving it out is never a decision`;
    if (rateProblem(value[field])) return `${at}.${field} is not a whole number of micro-dollars per million tokens (0 to ${MAX_RATE}) or null`;
  }
  // Optional (D-143): every owner file written before it lacks the field, and must not become unusable. Left out
  // it is no price, which charges nothing for a 1-hour write — never the 5-minute rate in its place.
  if (RATE_1H in value && rateProblem(value[RATE_1H])) {
    return `${at}.${RATE_1H} is not a whole number of micro-dollars per million tokens (0 to ${MAX_RATE}) or null`;
  }
  return undefined;
}

/**
 * Rates copied by name, never the object handed on — `cache_write_1h` only when the source has it, so a table's
 * digest and a row's shape stay what they were without it (D-143).
 */
export function copyRates(rates: Rates): Rates {
  const four = { input: rates.input, output: rates.output, cache_read: rates.cache_read, cache_write: rates.cache_write };
  return RATE_1H in rates ? { ...four, cache_write_1h: rate1h(rates) } : four;
}

/** A price table from a parsed value, or why it is not one. Never throws. */
export function validatePriceTable(value: unknown): TableRead {
  if (!isRecord(value)) return { ok: false, reason: "it is not a JSON object" };
  const extra = unknownField(value, TOP_FIELDS);
  if (extra !== undefined) return { ok: false, reason: `it has a field a price table does not have: ${JSON.stringify(extra)}` };
  if (value["kind"] !== PRICE_TABLE_KIND) return { ok: false, reason: `"kind" is not "${PRICE_TABLE_KIND}"` };
  if (value["v"] !== PRICE_TABLE_V) return { ok: false, reason: `"v" is not ${PRICE_TABLE_V}` };
  if (!isSafeId(value["version"])) return { ok: false, reason: `"version" is missing or not an id (letters, digits and ._:- — a date works)` };
  if (value["currency"] !== PRICE_CURRENCY) return { ok: false, reason: `"currency" is not "${PRICE_CURRENCY}" — Mind prices in US dollars only` };
  if (value["unit"] !== PRICE_UNIT) return { ok: false, reason: `"unit" is not "${PRICE_UNIT}" — write $0.30 per million tokens as 300000` };
  const sources = value["sources"] ?? [];
  if (!Array.isArray(sources)) return { ok: false, reason: `"sources" is not a list` };
  for (const [index, source] of sources.entries()) {
    const problem = sourceProblem(source, `sources[${index}]`);
    if (problem !== undefined) return { ok: false, reason: problem };
  }
  const prices = value["prices"];
  if (!Array.isArray(prices)) return { ok: false, reason: `"prices" is not a list` };
  const seen = new Set<string>();
  for (const [index, entry] of prices.entries()) {
    const problem = entryProblem(entry, `prices[${index}]`);
    if (problem !== undefined) return { ok: false, reason: problem };
    const key = `${(entry as PriceEntry).backend} ${(entry as PriceEntry).model}`;
    if (seen.has(key)) return { ok: false, reason: `prices[${index}] prices ${key.replace(" ", " · ")} a second time — which one is meant?` };
    seen.add(key);
  }
  const table = {
    version: value["version"],
    sources: (sources as PriceSource[]).map((s) => ({ ...s })),
    entries: (prices as PriceEntry[]).map((e) => ({ backend: e.backend, model: e.model, ...copyRates(e) })),
  };
  try {
    return { ok: true, table: { ...table, digest: tableDigest(table) } };
  } catch (error) {
    // Only text with no canonical form gets here (a lone surrogate in a note): it cannot be bound, so it
    // cannot price anything.
    return { ok: false, reason: `it cannot be digested: ${(error as Error).message}` };
  }
}

/** A price table from the text of a file: strict JSON (no field twice), then {@link validatePriceTable}. */
export function parsePriceTable(text: string): TableRead {
  const parsed = parseJsonStrict(text);
  if (!parsed.ok) return { ok: false, reason: `it is not strict JSON: ${parsed.reason}` };
  return validatePriceTable(parsed.value);
}

/** A shipped file as a table. A bundled file that does not validate is a build error, not a state. */
function shipped(json: unknown): PriceTable {
  const read = validatePriceTable(json);
  if (!read.ok) throw new Error(`a shipped price table is not valid: ${read.reason}`);
  return read.table;
}

/**
 * Every table this build ships, oldest first — `shipped/<version>.json`, each imported here by name so the
 * compiled binary carries it. The last is the default. Append; never edit or remove one (see the file comment).
 */
export const SHIPPED_TABLES: readonly PriceTable[] = [shipped(SHIPPED_2026_09_28), shipped(SHIPPED_2026_09_29)];

/** The table a turn is priced from when the owner's file has no entry: the newest one shipped. */
export const DEFAULT_PRICES: PriceTable = SHIPPED_TABLES.at(-1)!;

export function ownerPricesPath(home: string, env: Readonly<Record<string, string | undefined>>): string {
  return join(stateRoot(home, env), OWNER_PRICES_FILE);
}

/**
 * The owner's file, read once through one handle: absent, usable, or unusable and why.
 *
 * The file decides what a hirer is charged, so it is held to what the agent's key is held to where that
 * matters: it must be ours, and nobody else may be able to write it — a price someone else can change is a
 * bill someone else can change. Readable by others is fine; prices are not secret. A symlink is followed (a
 * dotfiles checkout is an ordinary place for it) and the file it reaches is checked.
 *
 * **Absent means nothing at the path at all** (PR #3 review, M1). A symlink whose target moved makes `open`
 * fail with ENOENT exactly as a missing file does, and reading that as "no owner file" would price every turn
 * at the shipped list prices — the fallback this file exists to refuse. So ENOENT is asked again of the path
 * itself: a link that is there and leads nowhere is `unusable`, never `absent`.
 */
export async function readOwnerPrices(path: string): Promise<OwnerTable> {
  let handle;
  try {
    // Non-blocking, so a FIFO planted at the path cannot hang a turn; the stat below refuses it.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return nothingThere(path);
    return { state: "unusable", reason: `it cannot be opened: ${(error as Error).message}` };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { state: "unusable", reason: "it is not a regular file" };
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return { state: "unusable", reason: "it belongs to another user, and a price someone else controls is a bill someone else controls" };
    if ((info.mode & 0o022) !== 0) {
      return { state: "unusable", reason: `group or others can write it (mode ${(info.mode & 0o777).toString(8)}) — \`chmod go-w\` it` };
    }
    if (info.size > MAX_PRICE_FILE_BYTES) return { state: "unusable", reason: `it is over ${MAX_PRICE_FILE_BYTES} bytes` };
    const read = parsePriceTable(await handle.readFile("utf8"));
    if (!read.ok) return { state: "unusable", reason: read.reason };
    // A copy of a shipped table, version and all, carries that table's digest — and a row with a shipped
    // digest is held to the shipped labels (PR #3 review, R2), so its turns would be refused as `owner`. It
    // says nothing the shipped table does not; the fix is to remove it.
    const same = SHIPPED_TABLES.find((table) => table.digest === read.table.digest);
    if (same !== undefined) {
      return { state: "unusable", reason: `it is the shipped table ${same.version} word for word — remove it, and the shipped prices apply` };
    }
    return { state: "ok", table: read.table };
  } catch (error) {
    return { state: "unusable", reason: `it cannot be read: ${(error as Error).message}` };
  } finally {
    await handle.close();
  }
}

/** After ENOENT: absent only if there is no entry at the path at all; a link to nowhere is unusable. */
async function nothingThere(path: string): Promise<OwnerTable> {
  try {
    const entry = await lstat(path);
    const what = entry.isSymbolicLink() ? "a symbolic link whose target does not exist" : "an entry that vanished while it was read";
    return {
      state: "unusable",
      reason: `it is ${what} — nothing is priced until it points at your price file again, or is removed`,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "unusable", reason: `it cannot be looked at: ${(error as Error).message}` };
  }
}

/** The tables in force right now, for one turn or one `usage prices`. */
export async function loadPrices(home: string, env: Readonly<Record<string, string | undefined>>): Promise<PricesInForce> {
  const ownerPath = ownerPricesPath(home, env);
  return { default: DEFAULT_PRICES, owner: await readOwnerPrices(ownerPath), ownerPath };
}

/** One price as found: the rates, and the table they came from. */
export interface FoundPrice {
  readonly origin: TableOrigin;
  readonly table: string;
  readonly digest: string;
  readonly rates: Rates;
}

/**
 * The price of this model on this backend: the owner's entry if there is one, else the default's, else none.
 * Exact names only — `claude-opus-5` is not `opus`, and a model that is not listed is not the one beside it.
 * Call it only when the owner's file is usable; an unusable one means no price at all (see the file comment).
 */
export function findPrice(prices: PricesInForce, backend: string, model: string): FoundPrice | undefined {
  const match = (entry: PriceEntry) => entry.backend === backend && entry.model === model;
  if (prices.owner.state === "ok") {
    const own = prices.owner.table.entries.find(match);
    if (own !== undefined) return { origin: "owner", table: prices.owner.table.version, digest: prices.owner.table.digest, rates: copyRates(own) };
  }
  const shipped = prices.default.entries.find(match);
  return shipped === undefined
    ? undefined
    : { origin: "default", table: prices.default.version, digest: prices.default.digest, rates: copyRates(shipped) };
}

/**
 * The shipped table of this version, if this build carries it — what `usage verify` holds a row labelled
 * `default` to (PR #3 review, M2). A build that does not carry a version can only say so.
 */
export function shippedTable(version: string): PriceTable | undefined {
  return SHIPPED_TABLES.find((table) => table.version === version);
}

/** The shipped table with this digest, if any — a row carrying it is held to that table whatever it says. */
export function shippedByDigest(digest: string): PriceTable | undefined {
  return SHIPPED_TABLES.find((table) => table.digest === digest);
}

/** Every price a turn could be charged at now, the owner's first — what `usage prices` lists. */
export function pricesInForce(prices: PricesInForce): readonly (PriceEntry & { readonly origin: TableOrigin; readonly table: string })[] {
  const own = prices.owner.state === "ok" ? prices.owner.table : undefined;
  const mine = (own?.entries ?? []).map((entry) => ({ ...entry, origin: "owner" as const, table: own!.version }));
  const shadowed = new Set(mine.map((entry) => `${entry.backend} ${entry.model}`));
  const shipped = prices.default.entries
    .filter((entry) => !shadowed.has(`${entry.backend} ${entry.model}`))
    .map((entry) => ({ ...entry, origin: "default" as const, table: prices.default.version }));
  return [...mine, ...shipped];
}
