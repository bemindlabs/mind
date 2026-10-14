/** `mind ledger` — what the turns were, and how to withdraw them. */

import {
  UNDELETABLE,
  commitForget,
  ledgerDir,
  planForget,
  query,
  removeLedgerDir,
  type ForgetSelector,
  type LedgerEntry,
} from "../../src/ledger/index.ts";
import { formatUsd } from "../../src/pricing/cost.ts";
import { subjectId } from "../../src/types.ts";
import { bold, dim, indent, ledgerEnv, parseArgs, usageError } from "../shared.ts";

/** Parse an ISO instant or a bare date, or say which flag was wrong. */
function parseInstant(flag: string, value: string): Date | string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) {
    return `${flag} is not a date Mind can read: ${JSON.stringify(value)} — try 2026-09-01 or 2026-09-01T12:00:00Z`;
  }
  return new Date(at);
}

/** Column headings, built the same way the cells are so the two cannot drift. */
const LEDGER_HEADER =
  `${"when".padEnd(25)} ${"backend".padEnd(9)} ${"outcome".padEnd(10)} ` +
  `${"exit".padEnd(5)} ${"ms".padEnd(8)} ${"bytes".padEnd(10)} ` +
  `${"tokens in/out/total".padEnd(20)} ${"usage".padEnd(10)} ${"cost".padEnd(15)} id`;

/** What a line cost, or why it was not charged — `(none)` for a line from before turns were priced. */
function costCell(entry: LedgerEntry): string {
  if (entry.cost !== null) return formatUsd(entry.cost.usd_micros);
  return entry.not_charged ?? "(none)";
}

/** A number the backend printed, or `-` where it printed none. */
function count(value: number | null): string {
  return value === null ? "-" : `${value}`;
}

/** One row of `ledger show`: everything except what was said. */
function ledgerRow(entry: LedgerEntry): string {
  const exit = entry.exit === null ? "-" : `${entry.exit}`;
  const ms = entry.duration_ms === null ? "-" : `${entry.duration_ms}`;
  // A line written before this column existed shows the same dashes as a
  // backend that reported nothing; the `usage` cell is what tells them apart.
  const usage = entry.usage;
  const tokens = `${count(usage?.input ?? null)}/${count(usage?.output ?? null)}/${count(usage?.total ?? null)}`;
  return (
    `${entry.at.padEnd(25)} ${entry.backend.padEnd(9)} ${entry.confidence.padEnd(10)} ` +
    `${exit.padEnd(5)} ${ms.padEnd(8)} ${`${entry.prompt_bytes}/${entry.text_bytes}`.padEnd(10)} ` +
    `${tokens.padEnd(20)} ${(usage?.status ?? "(none)").padEnd(10)} ${costCell(entry).padEnd(15)} ${entry.id}`
  );
}

/**
 * `mind ledger show` — AC3, and the reason it defaults to metadata.
 *
 * A ledger holds conversation. Printing it in full because somebody wanted to
 * know when the last turn ran is the kind of leak I-6 is about — onto a
 * screen, into scrollback, into whatever the output was piped to. So the
 * default answers the metadata question, and `--content` is a thing you have
 * to mean.
 */
async function cmdLedgerShow(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv, ["content", "json"]);
  const subject = options.get("subject");
  if (subject === undefined || subject === "") {
    return usageError(
      "usage: mind ledger show --subject <id> [--since <iso>] [--until <iso>] [--content] [--json]",
    );
  }

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const range: { since?: Date; until?: Date } = {};
  for (const [flag, key] of [["--since", "since"], ["--until", "until"]] as const) {
    const raw = options.get(key);
    if (raw === undefined || raw === "") continue;
    const parsed = parseInstant(flag, raw);
    if (typeof parsed === "string") return usageError(parsed);
    range[key] = parsed;
  }

  const env = ledgerEnv();
  const result = await query(env, id, range);
  const withContent = options.has("content");

  if (options.has("json")) {
    console.log(
      JSON.stringify(
        {
          subject: id,
          dir: ledgerDir(env, id),
          unreadable: result.unreadable,
          foreign: result.foreign,
          entries: withContent
            ? result.entries
            : result.entries.map(({ prompt, text, ...rest }) => rest),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(bold(LEDGER_HEADER));
  for (const entry of result.entries) console.log(ledgerRow(entry));
  if (result.entries.length === 0) console.log(dim("(nothing recorded for this subject in this range)"));

  console.log();
  console.log(dim(`${result.entries.length} line(s) · ${ledgerDir(env, id)}`));
  if (result.unreadable > 0) {
    console.log(
      dim(
        `${result.unreadable} line(s) could not be read and were skipped — most likely a turn ` +
          `interrupted mid-write. They are still in the file.`,
      ),
    );
  }
  // Should never happen; printed rather than dropped because an identity's
  // data surfacing under another's is the failure I-3 exists to catch.
  if (result.foreign > 0) {
    console.log(
      dim(
        `${result.foreign} line(s) in this directory name a different subject and were withheld ` +
          `(I-3). Read the files directly if you need to see them.`,
      ),
    );
  }
  console.log(
    dim(
      "tokens are what the backend itself printed about its own turn. `-` is a number nobody " +
        "printed; `missing` is a backend that usually prints one and did not this time; " +
        "`unreported` is a backend Mind has not surveyed; `(none)` is a line written before " +
        "this column existed. There is no total row — two vendors' tokenizers do not add up.",
    ),
  );
  console.log(
    dim(
      "cost is Mind's price for those tokens, from the price table in force when the turn ran " +
        "(`mind usage prices`) — never a vendor's own figure. A reason in its place is a turn not " +
        "charged: a count or a price was missing, and it is billed at nothing rather than a guess (D-110).",
    ),
  );

  if (!withContent) {
    console.log(dim("Prompts and answers are not shown. Pass --content to print them."));
    return 0;
  }

  for (const entry of result.entries) {
    console.log();
    console.log(bold(`${entry.at} · ${entry.backend} · ${entry.id}`));
    if (entry.content === "withheld") {
      console.log(dim("  recorded with --private: the text was never written"));
      continue;
    }
    console.log(dim(indent(entry.prompt ?? "", "  > ")));
    console.log(indent(entry.text ?? "", "  "));
  }
  return 0;
}

const FORGET_USAGE =
  "usage: mind ledger forget --subject <id> (--id <id> | --before <iso> | --all) [--yes]";

/**
 * `mind ledger forget` — the half of I-4 that is easy to get wrong.
 *
 * Two rules shape this command, and both are about honesty rather than
 * mechanism.
 *
 * **Say who already has it, before it is gone.** The lines being deleted are
 * the only record of which backends received that text. Delete them first and
 * the owner has destroyed the evidence they would have needed to decide
 * whether deleting was enough. So the backends are printed from the matched
 * lines, every time, including on the run that actually deletes.
 *
 * **Say what deletion does not reach.** Printed every time too, not filed in
 * a document somebody might read. A promise of erasure that quietly excludes
 * the vendor's copy, the filesystem snapshot and the shell history is worse
 * than no promise, because the owner acts on it.
 *
 * Like `soul apply`, a dry run is the default and `--yes` is the whole
 * difference between the two code paths.
 */
async function cmdLedgerForget(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv, ["all", "yes"]);
  const subject = options.get("subject");
  if (subject === undefined || subject === "") return usageError(FORGET_USAGE);

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const rawIds = (options.get("id") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const rawBefore = options.get("before");
  const all = options.has("all");

  const chosen = [rawIds.length > 0, rawBefore !== undefined && rawBefore !== "", all].filter(Boolean);
  if (chosen.length !== 1) {
    return usageError(
      chosen.length === 0
        ? `${FORGET_USAGE} — say which lines; Mind will not guess at a deletion`
        : "--id, --before and --all select three different things; pass one of them",
    );
  }

  let selector: ForgetSelector;
  if (all) {
    selector = { kind: "all" };
  } else if (rawIds.length > 0) {
    selector = { kind: "ids", ids: rawIds };
  } else {
    const parsed = parseInstant("--before", rawBefore!);
    if (typeof parsed === "string") return usageError(parsed);
    selector = { kind: "before", before: parsed };
  }

  const env = ledgerEnv();
  const plan = await planForget(env, id, selector);
  const write = options.has("yes");

  console.log(
    `${plan.matched.length} line(s) to forget · ${plan.kept} kept · subject ${id} · ${plan.dir}`,
  );
  if (plan.matched.length > 0) {
    console.log(
      dim(
        `${plan.withContent} of them still hold the text that was sent; the rest were recorded ` +
          `with --private and never did.`,
      ),
    );
    console.log();
    console.log(bold("Already received by, and Mind cannot take it back from:"));
    for (const backend of plan.backends) console.log(`  ${backend}`);
    console.log(
      dim("  This list disappears with the lines. It is printed now because afterwards nobody can."),
    );
  }
  if (plan.unreadable > 0) {
    console.log();
    console.log(
      dim(
        `${plan.unreadable} unreadable line(s) in these files will be kept — Mind cannot tell ` +
          `whether they are among the ones you are withdrawing, and they may still hold text. ` +
          `--all removes them with the files.`,
      ),
    );
  }

  console.log();
  console.log(bold("What this does not reach:"));
  for (const note of UNDELETABLE) console.log(dim(`  - ${note}`));
  console.log(
    dim(
      `  What it does guarantee: search ${ledgerDir(env, id)} afterwards and the text is not there.`,
    ),
  );

  if (!write) {
    console.log();
    console.log(dim("Nothing was removed. Re-run with --yes to remove it."));
    return 0;
  }
  if (plan.matched.length === 0) {
    console.log();
    console.log(dim("Nothing matched, so nothing was removed."));
    return 0;
  }

  let result;
  try {
    result = await commitForget(plan);
  } catch (error) {
    console.error(`mind: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // `--all` empties the directory; the lock lives inside it, so it can only go
  // once `commitForget` has released it.
  const dirRemoved = selector.kind === "all" ? await removeLedgerDir(env, id) : false;

  console.log();
  console.log(`removed ${result.removed} line(s)`);
  for (const path of result.filesRemoved) console.log(dim(`  deleted ${path}`));
  for (const path of result.filesRewritten) console.log(dim(`  rewrote ${path}`));
  if (dirRemoved) console.log(dim(`  removed ${plan.dir}`));
  return 0;
}

export async function cmdLedger(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "show":
      return cmdLedgerShow(rest);
    case "forget":
      return cmdLedgerForget(rest);
    default:
      return usageError(
        `unknown ledger subcommand ${JSON.stringify(sub ?? "")} — try "show" or "forget"`,
      );
  }
}
