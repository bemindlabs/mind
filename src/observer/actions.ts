/**
 * What the owner **did**, counted — and the line between what may enter git and
 * what may not.
 *
 * ## There is no second extractor here
 *
 * `S3.2 AC1` asks for three kinds — a file edited, a command run, a tool called
 * — and w4 already built that: `kindOf` and `targetOf`
 * (`adapters/vocabulary.ts`) classify every record on the way in, and
 * `CaptureRecord` (`record.ts`) carries all of `AC2`'s fields — when, which
 * project, what kind, what target, did it work. A second classifier in this file
 * would be a second answer to "what counts as an action", and the two would
 * drift the way `reader.ts` explains two readers drift. So an {@link Action} is
 * a record whose kind is not `prompt`, {@link isAction} is the whole of the
 * selection, and everything else here is about what happens *after* a record.
 *
 * The grok `permission_resolved` decision kind that AC1 permits as an exception
 * is **not built**, and the reason is in {@link ACTIONS_LIMITS} rather than in a
 * comment nobody prints: grok has no hook, so its data can only ever arrive
 * through a seed, and no seed has been run on this machine. An extractor for a
 * record shape that does not exist yet is a mechanism that cannot be tested,
 * which is the failure this project has now met several times. It is task w5b.
 *
 * ## The line this file draws (the decision `S3.2 AC5` needed)
 *
 * AC5 asks for output that is readable and can go into git (I-2). w3 proved the
 * other half of that sentence: **what enters git cannot be taken back out**
 * (`GIT_UNDELETABLE`). So the split is not "filter the risky parts out" but
 * "make the risky parts unrepresentable":
 *
 * | may enter git | never enters git |
 * |---|---|
 * | integers | any string from a record |
 * | the month (`YYYY-MM`) | a timestamp |
 * | the kind, outcome, origin, vendor — closed unions in `record.ts` | `project`, `session` |
 * | a tool name from {@link BUILTIN_TOOLS} | a path, a `target`, an MCP server's name |
 * | a program name from {@link SUMMARY_PROGRAMS} | anything else, counted as `other` |
 *
 * That is enforced by `countPersonal` (`src/types.ts`), which builds its result
 * from a vocabulary the caller supplies from *outside* the box and looks keys up
 * rather than inserting them. A path cannot become a key here even if somebody
 * asks for one: {@link actionsVocabulary} is the only thing that decides what
 * keys exist, and every word in it comes from a literal list in this file or
 * from the *name of a capture file* — which is a month, and nothing else.
 *
 * An MCP server's name is the case worth stating on its own. `mcp__acme__thing`
 * carries a company, and often a person; SP-1's first privacy guard is about
 * exactly that. It is not on the built-in list, so it is counted as `other`.
 */

import { basename } from "node:path";
import { countPersonal, type CountPart, type CountTally, type Personal } from "../types.ts";
import { BUILTIN_TOOLS } from "./adapters/vocabulary.ts";
import {
  CAPTURE_VENDORS,
  type CaptureKind,
  type CaptureOrigin,
  type CaptureOutcome,
  type CaptureRecord,
} from "./record.ts";

/** The three kinds `S3.2 AC1` keeps. `prompt` is context, not an action. */
export type ActionKind = Exclude<CaptureKind, "prompt">;

/** Those three, in one place, in the order every report prints them. */
export const ACTION_KINDS: readonly ActionKind[] = ["file-edit", "command", "tool"];

/** Every kind a record may carry, including the one that is not an action. */
const RECORD_KINDS: readonly CaptureKind[] = ["prompt", ...ACTION_KINDS];

const OUTCOMES: readonly CaptureOutcome[] = ["ok", "failed", "unknown"];

/**
 * Every origin, in the order a report prints them.
 *
 * `unknown` is last and is never added into `owner-prompted` — the rule
 * `record.ts` states and `S3.2 AC3` exists to enforce. A row of zeros under
 * `owner-prompted` beside a large `unknown` is what a store holding only seeded
 * records looks like, and {@link actionsSummary} says so in words rather than
 * leaving an empty row to be read as "the owner did nothing".
 */
const ORIGINS: readonly CaptureOrigin[] = [
  "owner-prompted",
  "unattended",
  "subagent",
  "unknown",
];

/** A record that is one of the three kinds. */
export type Action = CaptureRecord & { readonly kind: ActionKind };

/** True when this record is an action rather than the evidence of a human turn. */
export function isAction(record: CaptureRecord): record is Action {
  return record.kind !== "prompt";
}

/**
 * Program names a summary may name, and the reason the list is short.
 *
 * Every entry is a program whose name is public knowledge and says nothing about
 * this machine or the person at it: that somebody runs `git` is a fact about
 * their trade. A name that is not here is counted under `other`, which includes
 * anything local, anything installed from a private source, and anything whose
 * name is a person's or a company's.
 *
 * The list *is* the decision surface. Adding a name to it widens what a
 * committed summary can say, so it is a line in a diff rather than a heuristic —
 * and even for a name that is on it, what is recorded is that the program ran in
 * some month, never when, never where, and never with what arguments.
 */
export const SUMMARY_PROGRAMS: readonly string[] = [
  "awk",
  "bun",
  "cargo",
  "cat",
  "cd",
  "chmod",
  "cp",
  "curl",
  "df",
  "docker",
  "du",
  "find",
  "git",
  "go",
  "grep",
  "ls",
  "make",
  "mkdir",
  "mv",
  "node",
  "npm",
  "pip",
  "pnpm",
  "ps",
  "python3",
  "rg",
  "rm",
  "rsync",
  "sed",
  "ssh",
  "systemctl",
  "tar",
];

/** The bucket a name that is not on a built-in list is counted under. */
export const SUMMARY_OTHER = "other";

// ---------------------------------------------------------------------------
// The keys, and where they come from
// ---------------------------------------------------------------------------

/** `YYYY-MM.jsonl` → `YYYY-MM`. The only shape a month file has (`capture-store.ts`). */
const MONTH_FILE = /^(\d{4}-\d{2})\.jsonl$/;

/**
 * The months a summary may have columns for, taken from the **names of the
 * capture files** rather than from the records.
 *
 * Which is the point: a month read off a file name is a value that was never
 * inside the box, so it can be part of a vocabulary. A month read off a record
 * would be a string from inside the box, and `countPersonal` has no way to let
 * one out — by design.
 *
 * The cost is stated in {@link ACTIONS_LIMITS} and reported per run: a record
 * whose own timestamp disagrees with the file it sits in belongs to no column
 * and is counted nowhere, so the totals do not add up. {@link actionsSummary}
 * prints how many records that was instead of quietly balancing the books.
 */
export function monthsOfFiles(files: readonly string[]): readonly string[] {
  const months = new Set<string>();
  for (const file of files) {
    const found = MONTH_FILE.exec(basename(file));
    if (found?.[1] !== undefined) months.add(found[1]);
  }
  return [...months].sort();
}

/** `{month}|{words…}` — one key, spelled in one place. */
function key(month: string, ...words: readonly string[]): string {
  return [month, ...words].join("|");
}

/**
 * Every key a summary of these months may hold, and nothing else.
 *
 * Built by multiplying the months by lists that are literals in this file and in
 * `adapters/vocabulary.ts`. Read it as the answer to "what could this file
 * possibly say about me?" — because it is exactly that: no value outside this
 * function can appear in a count.
 */
export function actionsVocabulary(months: readonly string[]): readonly string[] {
  const words: string[] = [];
  for (const month of months) {
    words.push(key(month, "records"));
    for (const kind of RECORD_KINDS) words.push(key(month, "kind", kind));
    for (const outcome of OUTCOMES) words.push(key(month, "outcome", outcome));
    for (const origin of ORIGINS) words.push(key(month, "origin", origin));
    for (const vendor of CAPTURE_VENDORS) words.push(key(month, "vendor", vendor));
    for (const kind of ACTION_KINDS) {
      for (const tool of [...BUILTIN_TOOLS, SUMMARY_OTHER]) {
        words.push(key(month, "tool", kind, tool));
      }
    }
    for (const program of [...SUMMARY_PROGRAMS, SUMMARY_OTHER]) {
      words.push(key(month, "program", "command", program));
    }
  }
  return words;
}

/** The month part every key starts with, read off the record's own instant. */
const MONTH_OF: CountPart = { field: "at", take: "month" };

/**
 * What is counted per record — data, not code, because `countPersonal` takes no
 * function (see its comment for why).
 *
 * The two tallies with an `otherwise` are where the built-in lists do their
 * work: a tool or program name that is not on one lands in `other`, so a reader
 * can see that there were more than the ones named without the names being
 * written down. `program` carries the kind in its key and the vocabulary holds
 * only `command`, which is how a *file* path — the first word of a `file-edit`
 * target — is counted nowhere rather than being misfiled under `other`.
 */
export const ACTION_TALLIES: readonly CountTally[] = [
  { key: { parts: [MONTH_OF, { literal: "records" }] } },
  { key: { parts: [MONTH_OF, { literal: "kind" }, { field: "kind" }] } },
  { key: { parts: [MONTH_OF, { literal: "outcome" }, { field: "outcome" }] } },
  { key: { parts: [MONTH_OF, { literal: "origin" }, { field: "origin" }] } },
  { key: { parts: [MONTH_OF, { literal: "vendor" }, { field: "vendor" }] } },
  {
    key: { parts: [MONTH_OF, { literal: "tool" }, { field: "kind" }, { field: "tool" }] },
    otherwise: {
      parts: [MONTH_OF, { literal: "tool" }, { field: "kind" }, { literal: SUMMARY_OTHER }],
    },
  },
  {
    key: {
      parts: [
        MONTH_OF,
        { literal: "program" },
        { field: "kind" },
        { field: "target", take: "first-word" },
      ],
    },
    otherwise: {
      parts: [MONTH_OF, { literal: "program" }, { field: "kind" }, { literal: SUMMARY_OTHER }],
    },
  },
];

/**
 * Count a store's records, without opening the box.
 *
 * The one call to `countPersonal` in the observer, and the only way anything
 * about a capture record reaches a caller of this module.
 */
export function countActions(
  records: Personal<readonly CaptureRecord[]>,
  months: readonly string[],
): Readonly<Record<string, number>> {
  return countPersonal(records, ACTION_TALLIES, actionsVocabulary(months));
}

// ---------------------------------------------------------------------------
// The file (AC5)
// ---------------------------------------------------------------------------

/** What this schema is called, written into every file so a reader knows. */
export const SUMMARY_SCHEMA = "mind/actions-summary/1";

/** The directory the summary sits in, inside the agent repository. */
export const ACTIONS_DIR = "actions";

/** Its file name. */
export const SUMMARY_FILE = "summary.json";

/** `actions/summary.json` — repo-relative, POSIX, one copy of the string. */
export const SUMMARY_PATH = `${ACTIONS_DIR}/${SUMMARY_FILE}`;

/** One month's counts, nested so a human reads them without splitting keys. */
export interface MonthSummary {
  readonly records: number;
  readonly kind: Readonly<Record<string, number>>;
  readonly outcome: Readonly<Record<string, number>>;
  readonly origin: Readonly<Record<string, number>>;
  readonly vendor: Readonly<Record<string, number>>;
  /** kind → tool name → count. Built-in names only; everything else is `other`. */
  readonly tool: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Program names of commands. Built-in names only; everything else is `other`. */
  readonly program: Readonly<Record<string, number>>;
}

/** The whole file: counts, what they do not say, and what this run could not answer. */
export interface ActionsSummary {
  readonly schema: string;
  /** The date this was produced — a date, never an instant. */
  readonly at: string;
  /** Which engine produced it, so a reader knows whose arithmetic this is. */
  readonly generator: string;
  readonly months: readonly string[];
  /** Records that belong to no column, because their month has no file. */
  readonly uncounted: number;
  readonly counts: Readonly<Record<string, MonthSummary>>;
  /** Facts about *this* run — an empty owner row, records counted nowhere. */
  readonly notes: readonly string[];
  /** {@link ACTIONS_LIMITS}, in the file, so it travels with the numbers. */
  readonly limits: readonly string[];
}

/** One counted word, or 0 — a key the vocabulary holds is always present. */
function count(counts: Readonly<Record<string, number>>, word: string): number {
  return counts[word] ?? 0;
}

/** `{a: n, …}` over a closed list of words. */
function table(
  counts: Readonly<Record<string, number>>,
  month: string,
  group: string,
  words: readonly string[],
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const word of words) out[word] = count(counts, key(month, group, word));
  return out;
}

/**
 * Shape the flat counts into the file that may be committed.
 *
 * Nesting is safe for the same reason the counting is: every key being split
 * here was put there by {@link actionsVocabulary}, so there is no string from a
 * record to mishandle. What this function adds is the honesty the numbers cannot
 * carry by themselves — the two notes below, and the limits.
 *
 * @param records How many records were read back, counted outside the box by
 *   `readCaptured`. Used only to say how many belong to no column.
 */
export function actionsSummary(options: {
  readonly counts: Readonly<Record<string, number>>;
  readonly months: readonly string[];
  readonly records: number;
  readonly at: Date;
  readonly generator: string;
}): ActionsSummary {
  const counts: Record<string, MonthSummary> = {};
  let counted = 0;
  let ownerPrompted = 0;

  for (const month of options.months) {
    const tools: Record<string, Readonly<Record<string, number>>> = {};
    for (const kind of ACTION_KINDS) {
      const row: Record<string, number> = {};
      for (const tool of [...BUILTIN_TOOLS, SUMMARY_OTHER]) {
        row[tool] = count(options.counts, key(month, "tool", kind, tool));
      }
      tools[kind] = row;
    }

    const programs: Record<string, number> = {};
    for (const program of [...SUMMARY_PROGRAMS, SUMMARY_OTHER]) {
      programs[program] = count(options.counts, key(month, "program", "command", program));
    }

    const records = count(options.counts, key(month, "records"));
    counted += records;
    ownerPrompted += count(options.counts, key(month, "origin", "owner-prompted"));

    counts[month] = {
      records,
      kind: table(options.counts, month, "kind", RECORD_KINDS),
      outcome: table(options.counts, month, "outcome", OUTCOMES),
      origin: table(options.counts, month, "origin", ORIGINS),
      vendor: table(options.counts, month, "vendor", CAPTURE_VENDORS),
      tool: tools,
      program: programs,
    };
  }

  const uncounted = Math.max(0, options.records - counted);
  const notes: string[] = [];

  if (options.records > 0 && ownerPrompted === 0) {
    notes.push(OWNER_ROW_EMPTY);
  }
  if (uncounted > 0) {
    notes.push(
      `${uncounted} record(s) are in a month file whose name does not match their own ` +
        `timestamp, so they belong to no column and were counted nowhere. The columns will not ` +
        `add up to the ${options.records} record(s) read back, and that is the honest shape of ` +
        `it — see the months line in the limits below.`,
    );
  }

  return {
    schema: SUMMARY_SCHEMA,
    // A date, not an instant: the counts are monthly, and a second-resolution
    // timestamp in a committed file is a fact about when somebody was at their
    // desk. Provenance does not need it.
    at: options.at.toISOString().slice(0, 10),
    generator: options.generator,
    months: [...options.months],
    uncounted,
    counts,
    notes,
    limits: ACTIONS_LIMITS,
  };
}

/**
 * Why an empty `owner-prompted` row is not "the owner did nothing".
 *
 * The owner asked for this sentence by name, and it is a constant so that it is
 * the same words in the file and on the terminal: an empty row with no
 * explanation beside it is a kind of lie.
 */
export const OWNER_ROW_EMPTY =
  "every origin here is `unknown` or the fleet's, and `owner-prompted` is 0. That is what a " +
  "store holding only seeded records looks like: both transcript adapters write `origin: " +
  "\"unknown\"` without exception, because the field that would decide it — the vendor's own " +
  "word for who authored the turn — is not in a transcript file at all. It comes from the " +
  "capture hook, and nothing has been captured on this machine yet. Read this row as \"nobody " +
  "has turned capture on\", never as \"the owner did nothing\".";

/**
 * The size of what a summary is — written into the file and printed beside it.
 *
 * Here rather than only in a document for the reason `OBSERVER_LIMITS` and
 * `CAPTURE_LIMITS` are: a criterion that promises more than it checks gets
 * ticked, and then the tick is what people read.
 */
export const ACTIONS_LIMITS: readonly string[] = [
  "every number here is a count over words this program holds in its own source: the month, the " +
    "kind, the outcome, the origin, the vendor, and tool or program names only from the built-in " +
    "lists in src/observer/actions.ts. Nothing else can appear — not a path, not a project " +
    "directory, not a session id, not an instant, not the name of an MCP server (which is a " +
    "company, and often a person). That is by construction rather than by filtering: the keys are " +
    "built from those lists and looked up, so a string from a record has no way to become one.",
  "a name that is not on a built-in list is counted as `other`, and `other` is all anybody can " +
    "learn about it. Adding a name to a list widens what a committed file may say, which is why " +
    "the lists are lines in a diff and not a rule about what a name looks like.",
  "`origin: owner-prompted` is an upper bound, never a proof that a person typed — " +
    "CAPTURE_LIMITS says why, and `unknown` is never folded into it. A 0 in the owner row " +
    "normally means no capture hook has ever run: every record a seed writes is `unknown`.",
  "a count is still a channel in principle — an integer can be made to carry whatever the code " +
    "that produces it decides to put in it. What is bounded is the vocabulary of keys and the " +
    "type of values, and that bound is a property of countPersonal() in src/types.ts. What the " +
    "integers are *about* is a decision in review, which is what this list is for.",
  "months come from the names of the capture files, never from the records, because a month read " +
    "off a record would be a string from inside the box. A record whose timestamp disagrees with " +
    "the file it sits in therefore belongs to no column and is counted nowhere; the run says how " +
    "many that was rather than balancing the totals for you.",
  "nothing here enters git by itself. `mind observe actions` reads and prints; `--write` is " +
    "the only thing that puts a file in a working tree, one run at a time, and prints what a " +
    "commit cannot undo first. Mind never stages and never commits — that is yours. D-013 " +
    "(\"ไม่เข้า git โดยค่าเริ่มต้น\") holds.",
  "the one AC1 exception — grok's structural `permission_resolved` decision field — is not " +
    "built, and is task w5b. grok has no hook, so its records can only arrive through a seed, no " +
    "seed has been run, and an extractor for a shape nothing has ever produced is a mechanism " +
    "that cannot be tested. The three kinds AC1 keeps are unaffected.",
  "S3.2 AC4 (twenty files checked by hand, at least 80% right) is **not answered** by this " +
    "release. `mind observe audit --vendor claude --root <dir>` is the instrument; the number " +
    "has to come from a person reading real pairs at their own terminal. No percentage over the " +
    "test suite's fixtures may be quoted as that number — those records are invented, so a " +
    "percentage over them measures the instrument and not the extraction.",
];

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** `a 3 · b 1`, skipping words nothing happened under. */
function row(counts: Readonly<Record<string, number>>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([word, count]) => `${word} ${count}`);
  return parts.length === 0 ? "—" : parts.join(" · ");
}

/**
 * The summary as lines a human reads, in the same order the file holds them.
 *
 * Returns lines rather than printing them, so the CLI decides about colour and a
 * test can read what would have been shown.
 */
export function formatActions(summary: ActionsSummary): readonly string[] {
  const lines: string[] = [];
  for (const month of summary.months) {
    const counted = summary.counts[month];
    if (counted === undefined) continue;
    lines.push(`${month} · ${counted.records} record(s)`);
    lines.push(`  kind      ${row(counted.kind)}`);
    lines.push(`  outcome   ${row(counted.outcome)}`);
    lines.push(`  origin    ${row(counted.origin)}`);
    lines.push(`  vendor    ${row(counted.vendor)}`);
    for (const kind of ACTION_KINDS) {
      const tools = counted.tool[kind];
      if (tools === undefined) continue;
      lines.push(`  tool·${kind.padEnd(10)}${row(tools)}`);
    }
    lines.push(`  program   ${row(counted.program)}`);
  }
  if (summary.months.length === 0) lines.push("no capture files, so no months and no counts");
  for (const note of summary.notes) lines.push(note);
  return lines;
}
