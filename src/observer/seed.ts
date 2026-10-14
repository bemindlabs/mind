/**
 * The one-off import of history — and the reason it is one-off.
 *
 * ## What a seed is for, and what it is not
 *
 * SP-1 measured the material and D-024 read the measurement: the transcripts
 * parse perfectly and extract well, and they reach back about seven weeks for
 * claude and eleven days for grok, because vendor retention deletes them. The
 * window does not grow by waiting — a run next month reaches back exactly as
 * far as a run today — so E3 is a capture, and the history is a *seed*: read it
 * once, keep what it holds, and never depend on it again.
 *
 * Reading all of it takes five seconds (SP-1 §7), so this is not an argument
 * against doing it. It is an argument against building on it.
 *
 * ## Seeding twice is a backfill wearing another name
 *
 * Because the reader de-duplicates by key, a second seed is harmless and
 * therefore tempting: put it on a timer and grok — which has no hook at all —
 * keeps producing records. That is a backfill, and D-024's whole finding is
 * that a backfill is not the shape E3 takes. So a seed is recorded in
 * {@link SEEDS_FILE}, a repeat is refused, and `--again` exists but says
 * {@link BACKFILL_NOTE} out loud when it is used. The point is not to stop
 * anybody; it is that nobody drifts into it without the word being said.
 *
 * ## Two passes, over the whole directory
 *
 * Pass 1 builds an index and emits nothing; pass 2 emits. They are separate
 * because the answer to "did this call succeed?" is in a *different record*
 * from the call — and for grok, `S3.1 AC8`, in a different **file**: all 565 of
 * its `tool_completed` records matched a call somewhere else in the directory.
 * A reader that indexed per file would report that grok never succeeds at
 * anything.
 *
 * Both passes stream line by line (`S3.1 AC4`). 663 MB never becomes 663 MB of
 * heap; what is held is the index, which is two maps of ids.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { STATE_FILE_MODE } from "../state.ts";
import { appendRecord } from "./capture-store.ts";
import {
  claudeTranscript,
  emptyClaudeIndex,
  indexClaudeLine,
  type ClaudeIndex,
} from "./adapters/claude-transcript.ts";
import {
  emptyGrokIndex,
  grokSession,
  indexGrokLine,
  type GrokIndex,
} from "./adapters/grok-session.ts";
import { readInto, streamLines, type Adapter, type ReadReport } from "./reader.ts";
import type { CaptureVendor } from "./record.ts";

/** The file that records what has been seeded, inside the observer directory. */
export const SEEDS_FILE = "seeds.json";

/** Said out loud whenever a vendor is seeded a second time. */
export const BACKFILL_NOTE =
  "This is a backfill. D-024 found that re-reading vendor history does not reach further back " +
  "than the first read did — the limit is the vendor deleting its own files, not effort — so a " +
  "repeated seed adds only what happened since the last one, which is what the capture hook is " +
  "for. Re-seeding on a timer is a backfill under another name, and E3 is not built on one.";

/** What one vendor's seed did, kept so a second run knows there was a first. */
export interface SeedEntry {
  readonly at: string;
  /** The directory that was read, so a later run can see it was a different one. */
  readonly root: string;
  readonly records: number;
}

/** What has been seeded, by vendor. */
export type SeedLedger = { readonly [K in CaptureVendor]?: SeedEntry };

/** Read the seed ledger back. A missing or unreadable file is "nothing has been seeded". */
export async function loadSeeds(observerPath: string): Promise<SeedLedger> {
  let text: string;
  try {
    text = await readFile(join(observerPath, SEEDS_FILE), "utf8");
  } catch {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

  const raw = value as Record<string, unknown>;
  const ledger: { -readonly [K in CaptureVendor]?: SeedEntry } = {};
  for (const vendor of ["claude", "grok"] as const) {
    const entry = raw[vendor];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const fields = entry as Record<string, unknown>;
    if (typeof fields["at"] !== "string" || typeof fields["root"] !== "string") continue;
    const records = fields["records"];
    ledger[vendor] = {
      at: fields["at"],
      root: fields["root"],
      records: typeof records === "number" && Number.isSafeInteger(records) ? records : 0,
    };
  }
  return ledger;
}

/** Write the seed ledger. */
export async function saveSeeds(observerPath: string, ledger: SeedLedger): Promise<void> {
  await writeFile(join(observerPath, SEEDS_FILE), `${JSON.stringify(ledger, null, 2)}\n`, {
    mode: STATE_FILE_MODE,
  });
}

/**
 * Every `.jsonl` file under a root, sorted, bounded in depth.
 *
 * `.json` files beside them are deliberately not read: SP-1 measured all 1,258
 * of them and found zero tool calls, zero records that look like a person
 * typing, and 98–100% with no timestamp. They are session registries and
 * telemetry, and counting them would make the readable-percentage a statement
 * about sidecars.
 */
export async function transcriptFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      found.push(...(await transcriptFiles(path, depth + 1)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found.sort();
}

/** Everything one seed run saw and did. */
export interface SeedResult {
  readonly vendor: CaptureVendor;
  readonly root: string;
  readonly files: number;
  readonly bytes: number;
  /** Merged across every file, so `pct` is the whole run's (AC3). */
  readonly report: ReadReport;
  /** Records actually written. Differs from `report.accepted` only on a refusal. */
  readonly written: number;
  /** Records the store refused, with the reason. Reported, never swallowed. */
  readonly refused: readonly string[];
  /** True when this vendor had been seeded before. */
  readonly repeat: boolean;
}

/** Add one file's report into a running total. */
function merge(into: ReadReport, add: ReadReport): ReadReport {
  const skipped: Record<string, number> = { ...into.skipped };
  for (const [reason, count] of Object.entries(add.skipped)) {
    skipped[reason] = (skipped[reason] ?? 0) + count;
  }
  const lines = into.lines + add.lines;
  const parsed = into.parsed + add.parsed;
  return {
    lines,
    parsed,
    accepted: into.accepted + add.accepted,
    duplicates: into.duplicates + add.duplicates,
    skipped,
    pct: lines === 0 ? 100 : Math.round((parsed * 1000) / lines) / 10,
  };
}

const EMPTY_REPORT: ReadReport = {
  lines: 0,
  parsed: 0,
  accepted: 0,
  duplicates: 0,
  skipped: {},
  pct: 100,
};

/**
 * Read one vendor's history into the capture store.
 *
 * @param seen Keys already on disk. Passed in by the caller from
 *   {@link capturedKeys} so that a seed run after a week of capture adds only
 *   what the hook did not already write (`S3.1 AC7`), and so that a re-run adds
 *   only what is new.
 */
export async function seedVendor(options: {
  readonly observerPath: string;
  readonly vendor: CaptureVendor;
  readonly root: string;
  readonly now: Date;
  readonly seen: Set<string>;
  readonly repeat: boolean;
}): Promise<SeedResult> {
  const files = await transcriptFiles(options.root);
  const nowIso = options.now.toISOString();

  let bytes = 0;
  for (const path of files) {
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined) bytes += info.size;
  }

  // ---- pass 1: the index, across every file in the directory (AC8) --------
  const claude: ClaudeIndex = emptyClaudeIndex();
  const grok: GrokIndex = emptyGrokIndex();

  for (const path of files) {
    const session = basename(path).replace(/\.jsonl$/, "");
    for await (const line of streamLines(path)) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        // Counted in pass 2, where the report is built. Saying it twice would
        // halve the readable percentage for one bad line.
        continue;
      }
      if (options.vendor === "claude") indexClaudeLine(value, claude);
      else indexGrokLine(value, grok, session);
    }
  }

  // ---- pass 2: emit ------------------------------------------------------
  let report = EMPTY_REPORT;
  let written = 0;
  const refused: string[] = [];

  for (const path of files) {
    const session = basename(path).replace(/\.jsonl$/, "");
    const adapter: Adapter =
      options.vendor === "claude"
        ? claudeTranscript(claude, nowIso)
        : grokSession(grok, nowIso, session);

    const fileReport = await readInto(
      streamLines(path),
      adapter,
      async (record) => {
        const at = new Date(record.at);
        const outcome = await appendRecord(
          options.observerPath,
          record,
          Number.isNaN(at.getTime()) ? options.now : at,
        );
        if (outcome.ok) written += 1;
        else if (refused.length < 20) refused.push(outcome.reason);
      },
      options.seen,
    );
    report = merge(report, fileReport);
  }

  return {
    vendor: options.vendor,
    root: options.root,
    files: files.length,
    bytes,
    report,
    written,
    refused,
    repeat: options.repeat,
  };
}
