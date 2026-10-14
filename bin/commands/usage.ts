/**
 * `mind usage` — what the agent's turns used and cost, signed with its own key (S15.4 minimum, S15.8,
 * S15.9, D-106, D-110).
 *
 *   report <dir> --subject <id>   one row per model delivery from the ledger, signed; --json prints the envelope;
 *                                 --market and --listing (and --job) bind it to where it is going (D-141)
 *   verify <file|-> --key <pk>    check a signed report against the key it should be signed by, and with
 *                                 --market and --listing, against where it should be going
 *   prices [--json]               the price tables a turn is charged against now: shipped, and the owner's
 *
 * The parts are in `src/identity/` (sign, key, report, strict-json), where tests call them; this is the
 * parsing and the printing. A report never holds what was said — no prompt, no answer, no memory, no subject
 * id — and a count the ledger does not have is null, never 0. Everything printed from a report goes through
 * `printable` first: a report is somebody else's text on your terminal (S15.8 review, M2).
 *
 * `verify` exits 0 only for a well-formed usage report signed by exactly the key given with `--key` (review
 * L4): 1 is not valid, 2 a command line it will not run, and 3 a report that is internally consistent but was
 * checked against no key — which says only that *some* key signed it, and anyone can make a key. With
 * `--market` and `--listing` a report bound anywhere else, or to nothing, is not valid (1); without them the
 * binding is printed and said to be unchecked, and the exit code is what it was.
 */

import { readFile } from "node:fs/promises";
import { identityDirFor } from "../../src/identity/dir.ts";
import { readAgentKey } from "../../src/identity/key.ts";
import {
  buildUsageReport,
  checkUsageReport,
  costGroups,
  printable,
  usageTotals,
  verifyUsageReport,
  type BindingPins,
  type RateCheck,
  type ReportBinding,
  type UsageRow,
  type UsageTotals,
} from "../../src/identity/report.ts";
import { isJobId, isListingSlug, marketOriginProblem } from "../../src/identity/shapes.ts";
import { publicKeyProblem } from "../../src/identity/sign.ts";
import { formatRate, formatUsd } from "../../src/pricing/cost.ts";
import { ALL_RATE_FIELDS, loadPrices, pricesInForce, rate1h, RATE_1H, RATE_FIELDS, type PriceTable, type Rates } from "../../src/pricing/table.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { subjectId } from "../../src/types.ts";
import { dialEnv } from "../dial.ts";
import { ERR, ledgerEnv, OUT, parseArgs, report, usageError, type Sink } from "../shared.ts";

const USAGE =
  "usage: mind usage report <agent-dir> --subject <id> [--since <iso>] [--until <iso>] [--market <origin> --listing <slug> [--job <id>]] [--json]\n" +
  "       mind usage verify <file|-> [--key <public-key>] [--market <origin> --listing <slug>]\n" +
  "       mind usage prices [--json]";

/** `report`'s options that take a value; `--json` is its one flag, declared where `parseArgs` is told of it. */
const REPORT_OPTIONS = ["subject", "since", "until", "market", "listing", "job"];
const VERIFY_OPTIONS = ["key", "market", "listing"];

/** Consistent, but checked against no key: not a yes. */
const UNPINNED = 3;

function parseInstant(flag: string, value: string): Date | string {
  const at = Date.parse(value);
  return Number.isNaN(at) ? `${flag} is not a date Mind can read: ${JSON.stringify(value)} — try 2026-09-01 or 2026-09-01T12:00:00Z` : new Date(at);
}

const cell = (value: number | string | null, width: number) => printable(`${value ?? "-"}`).padEnd(width);

/** A row's cache write, with the part that went to the 1-hour cache when it has one (D-143). */
const cacheWriteCell = (r: UsageRow) =>
  r.cache_write_1h_tokens === undefined ? r.cache_write_tokens : `${r.cache_write_tokens ?? "-"} (1h ${r.cache_write_1h_tokens})`;

/** Rates for a person: the four, and the 1-hour write rate where it is one of them (D-143). */
const rateList = (rates: Rates) =>
  (RATE_1H in rates ? ALL_RATE_FIELDS : RATE_FIELDS).map((field) => `${field} ${formatRate(rates[field] ?? null)}`).join(", ");

/** A flag no subcommand here takes, said by name — never silently ignored. */
function strayOption(options: ReadonlyMap<string, string>, allowed: readonly string[], sub: string): number | undefined {
  const stray = [...options.keys()].find((name) => !allowed.includes(name));
  if (stray === undefined) return undefined;
  return usageError(`usage ${sub} takes ${allowed.map((name) => `--${name}`).join(", ")} and nothing else, not --${printable(stray)}\n${USAGE}`);
}

/**
 * `--market` and `--listing` — both, or neither — in their shapes (D-141): the pins `verify` holds a report
 * to, and the market and listing `report` binds one to. Undefined for neither; a number is the exit code of
 * the usage error that says what is wrong.
 */
function pinsFrom(options: ReadonlyMap<string, string>): BindingPins | undefined | number {
  const market = options.get("market");
  const listing = options.get("listing");
  if (market === undefined && listing === undefined) return undefined;
  if (market === undefined || listing === undefined) {
    return usageError("--market and --listing go together: a report is bound to one listing on one market, or to nothing");
  }
  const problem = marketOriginProblem(market);
  if (problem !== undefined) return usageError(`--market ${printable(problem)}`);
  if (!isListingSlug(listing)) return usageError("--listing is not a slug: 3–40 lower-case letters, digits and hyphens, starting and ending with a letter or digit");
  return { market, listing };
}

/** Where a report is bound, for a person. Every part passed its shape, and is escaped all the same. */
function bindingLine(binding: ReportBinding | null): string {
  if (binding === null) return "bound to no market — for this machine; a market takes only a report made with --market and --listing (D-141)";
  const job = binding.job === null ? "no job" : `job ${printable(binding.job)}`;
  return `bound to listing ${printable(binding.listing)} on market ${printable(binding.market)}, ${job}`;
}

function printRows(out: Sink, rows: readonly UsageRow[]): void {
  out.line(
    out.dim(
      `${cell("when", 25)} ${cell("backend", 13)} ${cell("model", 24)} ${cell("in", 10)} ${cell("out", 10)} ` +
        `${cell("cache r", 10)} ${cell("cache w", 10)} ${cell("usage", 13)} cost`,
    ),
  );
  for (const r of rows) {
    const cost = r.cost === null ? `not charged: ${r.not_charged}` : formatUsd(r.cost.usd_micros);
    out.line(
      `${cell(r.at, 25)} ${cell(r.backend, 13)} ${cell(r.model, 24)} ${cell(r.input_tokens, 10)} ${cell(r.output_tokens, 10)} ` +
        `${cell(r.cache_read_tokens, 10)} ${cell(cacheWriteCell(r), 10)} ${cell(r.usage, 13)} ${cell(cost, 0)}`,
    );
  }
}

/** What a reader can know about a group's rates, in one sentence (PR #3 review, M2). */
function checkSentence(check: RateCheck, table: string): string {
  if (check === "shipped") return `checked — the rates Mind ships as table ${printable(table)} for this model`;
  if (check === "unknown-default") {
    return `NOT checked — says the shipped table ${printable(table)}, which this Mind does not carry; the rates are the agent's word`;
  }
  return "NOT checked — rates the agent's owner set; only their price file can confirm them, and the digest is the agent's own claim about which file that was";
}

/**
 * The charged rows grouped by the price each claims — source, table, digest, backend, model — with the rates,
 * so what is being claimed is on the screen and not only its sum.
 */
function printCostGroups(out: Sink, rows: readonly UsageRow[]): void {
  const groups = costGroups(rows);
  if (groups.length === 0) return;
  out.line("cost by the price each row claims (rates in US$ per million tokens):");
  for (const g of groups) {
    const rates = rateList(g.rates);
    out.line(
      `  ${formatUsd(g.usdMicros)} over ${g.rows} row(s) · ${printable(g.backend)} · ${printable(g.model)} · ` +
        `${g.source} table ${printable(g.table)} (digest ${printable(g.table_digest)}) · ${rates}`,
    );
    out.line(`    ${checkSentence(g.check, g.table)}`);
  }
}

function printTotals(out: Sink, totals: UsageTotals): void {
  out.line(
    `${totals.rows} row(s) · input ${totals.input} (cache read ${totals.cacheRead}, cache write ${totals.cacheWrite}` +
      `${totals.cacheWrite1h > 0n ? `, of it ${totals.cacheWrite1h} to the 1-hour cache` : ""}) · ` +
      `output ${totals.output} tokens, summed over the counts that exist`,
  );
  if (totals.withoutInput + totals.withoutOutput > 0) {
    out.line(
      `${totals.withoutInput} row(s) have no input count and ${totals.withoutOutput} no output count (from ${printable(totals.unknownFrom.join(", "))}). ` +
        "They are null in the report, not 0 — the backend printed none, or the line is older than the counts (D-110).",
    );
  }
  // Money is a sum of the charged rows alone, and what was not charged is counted by reason, so a total is
  // never read as the whole bill (D-110).
  // Split, so a sum made partly of the agent's own rates is never read as one checked figure (PR #3 review, R4).
  out.line(
    `cost ${formatUsd(totals.usdMicros)} (${totals.usdMicros} usd_micros) over ${totals.charged} charged row(s), of which ` +
      `${formatUsd(totals.usdMicrosChecked)} checked against a shipped table and ` +
      `${formatUsd(totals.usdMicros - totals.usdMicrosChecked)} NOT checked`,
  );
  if (totals.notCharged.length > 0) {
    out.line(
      `${totals.rows - totals.charged} row(s) not charged — ${totals.notCharged.map(([why, n]) => `${why} ${n}`).join(", ")}. ` +
        "A turn with a count or a price missing is billed at nothing, never at a guess (D-110); `mind usage prices` shows the tables.",
    );
  }
}

async function cmdReport(argv: readonly string[]): Promise<number> {
  const flags = ["json"];
  const { positional, options } = parseArgs(argv, flags);
  const json = options.has("json");
  const dir = positional[0];
  const raw = options.get("subject");
  if (dir === undefined || positional.length > 1 || raw === undefined || raw === "") return usageError(USAGE);
  const stray = strayOption(options, [...REPORT_OPTIONS, ...flags], "report");
  if (stray !== undefined) return stray;
  const pins = pinsFrom(options);
  if (typeof pins === "number") return pins;
  const job = options.get("job");
  if (job !== undefined && pins === undefined) return usageError("--job needs --market and --listing: a job is on a market, under a listing");
  if (job !== undefined && !isJobId(job)) return usageError("--job is not a job's id: letters, digits and _ . : -, starting with a letter or digit, up to 128");
  const binding: ReportBinding | null = pins === undefined ? null : { ...pins, job: job ?? null };
  let id;
  try {
    id = subjectId(raw);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const range: { since?: Date; until?: Date } = {};
  for (const key of ["since", "until"] as const) {
    const value = options.get(key);
    if (value === undefined || value === "") continue;
    const parsed = parseInstant(`--${key}`, value);
    if (typeof parsed === "string") return usageError(parsed);
    range[key] = parsed;
  }
  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);

  const read = await readAgentKey(identityDirFor(dialEnv(), id));
  if (read.state !== "present") {
    console.error(
      read.state === "absent"
        ? `mind: ${loaded.soul.role.name} has no signing key yet, so there is nothing to sign with — \`mind key ${dir} --subject ${id}\` makes one.`
        : `mind: the signing key cannot be used: ${read.reason}`,
    );
    return 1;
  }
  const { payload, facts } = await buildUsageReport(ledgerEnv(), id, range, binding);
  let envelope;
  try {
    envelope = read.key.sign(payload);
  } catch (error) {
    // Every row was given its shape above, so this is a bug here — said in one line, never as a stack trace.
    console.error(`mind: the report could not be signed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // Under --json the envelope is stdout, alone; everything a person reads goes to stderr.
  const say = json ? ERR : OUT;
  say.line(say.bold(`${printable(loaded.soul.role.name)}'s usage — signed by ed25519 key ${envelope.fingerprint}`));
  say.line(bindingLine(payload.binding));
  if (!json) printRows(say, payload.rows);
  printTotals(say, usageTotals(payload.rows));
  printCostGroups(say, payload.rows);
  if (facts.notModel > 0) say.line(`${facts.notModel} ledger line(s) are messages (A2A, chat), not model turns, and are not in it.`);
  if (facts.modelWithheld > 0) say.line(`${facts.modelWithheld} row(s) had a model value that is not a model's name (a path?) and send it as null.`);
  const left = facts.unshapely + facts.unreadable + facts.foreign;
  if (left > 0) say.line(`${left} ledger line(s) could not be read, were not this subject's, or had ids of no row's shape, and are not in it.`);
  // Said apart, with the reason: a line left out for its cost is a claim that did not check, not a bad id.
  if (facts.costRefused > 0) {
    say.line(
      `${facts.costRefused} ledger line(s) claim a cost that does not check and are not in it — ` +
        `${facts.costReasons.map((why) => printable(why)).join("; ")}.`,
    );
  }
  if (facts.conflicting > 0) {
    say.line(`${facts.conflicting} ledger line(s) claim two different prices from one price table (one digest) and are not in it: one table has one price per model.`);
  }
  say.line(
    say.dim(
      "It holds no prompt, no answer, no memory and no subject id — only ids, times, backend, model, token counts and cost." +
        (json ? "" : " `--json` prints the signed report to send; `mind usage verify <file> --key <public key>` checks one."),
    ),
  );
  // Compact, one line (PR #3 review, R6): a v2 row is ~0.5 KiB compact and ~0.8 KiB indented, and the platform
  // caps an upload by size. Nothing reads the indentation; `jq .` prints it for a person.
  if (json) console.log(JSON.stringify(envelope));
  return 0;
}

async function cmdVerify(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const file = positional[0];
  const key = options.get("key");
  if (file === undefined || positional.length > 1) return usageError(USAGE);
  // `--key`, `--market` and `--listing` are the only options. A stray `--json` used to be ignored, so a script
  // that expected a document got prose and exit 0; the verdict is the exit code, and the platform computes its
  // own from the signed report.
  const stray = strayOption(options, VERIFY_OPTIONS, "verify");
  if (stray !== undefined) return stray;
  const pins = pinsFrom(options);
  if (typeof pins === "number") return pins;
  const keyProblem = key === undefined ? undefined : publicKeyProblem(key);
  if (keyProblem !== undefined) {
    return usageError(`--key is not an ed25519 public key a signature may be checked against: ${keyProblem}. Pass the one \`mind key\` and the agent card print.`);
  }
  let text: string;
  try {
    text = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf8");
  } catch (error) {
    console.error(`mind: NOT valid — ${printable(file)} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const checked = key === undefined ? checkUsageReport(text, pins) : verifyUsageReport(text, key, pins);
  if (!checked.ok) {
    console.error(`mind: NOT valid — ${printable(checked.reason)}`);
    return 1;
  }
  const { envelope, payload } = checked;
  console.log(`${key === undefined ? "consistent" : "valid"} — a usage report signed by ed25519 key ${envelope.fingerprint}`);
  console.log(`  public key  ${envelope.publicKey}`);
  console.log(`  made ${printable(payload.generated_at)}, from ${printable(payload.since ?? "the start")} to ${printable(payload.until ?? "then")}`);
  console.log(`  ${bindingLine(payload.binding)}`);
  // Held to --market and --listing when they were given (a mismatch never gets here); said to be unchecked
  // when they were not — the job is the market's to check, against its own jobs.
  console.log(
    pins !== undefined
      ? "  checked — it is bound to the market and listing you named; whether its job is one the market has, only the market can say"
      : payload.binding === null
        ? "  NOT checked against a market — none was named, and it is bound to none"
        : "  NOT checked — pass --market and --listing to hold it to where it should be going",
  );
  printTotals(OUT, usageTotals(payload.rows));
  printCostGroups(OUT, payload.rows);
  if (key === undefined) {
    console.error(
      "mind: NOT verified — the key inside the report signed it, and anyone can make a key. Pass --key <public key> " +
        `from the agent card to know whose it is (exit ${UNPINNED}).`,
    );
    return UNPINNED;
  }
  console.log("It is signed by the key you named.");
  return 0;
}

/** One table's header, for a person. Every string in it came from a file, and goes through `printable`. */
function printTable(out: Sink, label: string, table: PriceTable): void {
  out.line(`${label}: version ${printable(table.version)}`);
  for (const source of table.sources) {
    const read = source.read === undefined ? "" : ` (read ${printable(source.read)})`;
    const who = source.backends === undefined ? "" : `${printable(source.backends.join(", "))}: `;
    if (source.url !== undefined) out.line(`  ${who}${printable(source.url)}${read}`);
    if (source.note !== undefined) out.line(out.dim(`    ${printable(source.note)}`));
  }
}

/**
 * `usage prices` — the tables a turn would be charged against if it started now. Reads; writes nothing.
 *
 * Exit 1 when the owner's file is there and cannot be used, because every turn is then recorded as not
 * charged, and a command that says "these are the prices" with exit 0 would hide that.
 */
async function cmdPrices(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["json"]);
  if (positional.length > 0) return usageError(USAGE);
  const { home, env } = ledgerEnv();
  const prices = await loadPrices(home, env);
  const entries = pricesInForce(prices);
  const unusable = prices.owner.state === "unusable";

  if (options.has("json")) {
    const owner =
      prices.owner.state === "ok"
        ? { state: "ok", version: prices.owner.table.version, sources: prices.owner.table.sources }
        : prices.owner.state === "unusable"
          ? { state: "unusable", reason: prices.owner.reason }
          : { state: "absent" };
    console.log(
      JSON.stringify(
        {
          currency: "usd",
          unit: "usd_micros per million tokens",
          default: { version: prices.default.version, sources: prices.default.sources },
          owner: { path: prices.ownerPath, ...owner },
          // What a turn is charged at now: none at all while the owner's file cannot be used.
          // `cache_write_1h` null where the table has none (D-143): no price, as a table that leaves it out means.
          prices: unusable
            ? []
            : entries.map((e) => ({ backend: e.backend, model: e.model, source: e.origin, table: e.table, input: e.input, output: e.output, cache_read: e.cache_read, cache_write: e.cache_write, cache_write_1h: rate1h(e) })),
        },
        null,
        2,
      ),
    );
    if (unusable) console.error(`mind: the price file ${printable(prices.ownerPath)} cannot be used — ${printable(prices.owner.state === "unusable" ? prices.owner.reason : "")}`);
    return unusable ? 1 : 0;
  }

  printTable(OUT, "shipped (default)", prices.default);
  if (prices.owner.state === "ok") {
    printTable(OUT, `yours (${printable(prices.ownerPath)})`, prices.owner.table);
  } else if (prices.owner.state === "absent") {
    OUT.line(
      `yours: none at ${printable(prices.ownerPath)}. Write one in the same shape to price a model on this machine (D-106) or ` +
        "to replace a shipped price with what you really pay; an entry there replaces the shipped one for that backend and model.",
    );
  } else {
    console.error(
      `mind: the price file ${printable(prices.ownerPath)} cannot be used — ${printable(prices.owner.reason)}. ` +
        "Until it is fixed every turn is recorded as not charged (table-unusable); the shipped table is not used in its place.",
    );
    return 1;
  }
  OUT.line("");
  OUT.line(OUT.dim(`${cell("backend", 13)} ${cell("model", 24)} ${ALL_RATE_FIELDS.map((f) => cell(f, 14)).join(" ")} from`));
  for (const e of entries) {
    const rates = ALL_RATE_FIELDS.map((f) => cell(formatRate(e[f] ?? null), 14));
    OUT.line(`${cell(e.backend, 13)} ${cell(e.model, 24)} ${rates.join(" ")} ${cell(`${e.origin} ${e.table}`, 0)}`);
  }
  OUT.line(
    OUT.dim(
      "US dollars per million tokens. `-` is no price: a turn that used that part is not charged. cache_write is the " +
        "5-minute write where a vendor prices two, and cache_write_1h the 1-hour one (D-143). A model that is not " +
        "listed has no price, never 0 — and a turn whose backend ran its own default names no model, so it is not charged either.",
    ),
  );
  return 0;
}

export async function cmdUsage(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "report":
      return cmdReport(rest);
    case "verify":
      return cmdVerify(rest);
    case "prices":
      return cmdPrices(rest);
    default:
      return usageError(`unknown usage subcommand ${JSON.stringify(sub ?? "")}\n${USAGE}`);
  }
}
