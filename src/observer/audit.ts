/**
 * The instrument `S3.2 AC4` needs, and the number it deliberately does not
 * produce by itself.
 *
 * AC4 reads *ตรวจมือ 20 ไฟล์สุ่ม — แม่น ≥ 80%* and carries its own status:
 * **⏳ ยังไม่ได้ตอบ**. SP-1 could say the data is there; it could not say the
 * reading of it is right. Nothing in a test suite can either, because every
 * record a test uses was invented by the test — a percentage over fixtures
 * measures this file, not the extraction.
 *
 * So what is built here is the thing that lets a person answer it in an
 * afternoon, and nothing that pretends to have answered it:
 *
 * - {@link sampleActions} picks up to twenty transcript files at random, derives
 *   records through the **same adapters a seed uses** (never a second reader —
 *   that is `S3.1 AC1`), and hands back pairs of *the line as the vendor wrote
 *   it* and *the record Mind made of it*.
 * - {@link judgeSample} shows each pair and takes `y`/`n` per field, at a
 *   terminal, from a person.
 * - {@link formatAudit} prints judged, correct and the percentage per field,
 *   against {@link AUDIT_FLOOR}.
 *
 * Three properties are worth naming because each is a way this could quietly
 * become useless:
 *
 * 1. **It writes nothing.** No capture, no consent, no store — it reads the
 *    vendor's files and prints. That is why it can be run before capture is ever
 *    enabled, which is what makes AC4 answerable for the seed path on the day
 *    this lands.
 * 2. **`origin` is not judged.** A transcript cannot answer "who set this
 *    going", which is the whole of `S3.2 AC3` and the reason D-024 moved capture
 *    to a hook. Asking a human to grade a field whose only honest value is
 *    `unknown` would manufacture agreement.
 * 3. **It needs a terminal and has no `--yes`.** Same reason `observe enable`
 *    has none: a program running as the owner can type `y` a hundred times, and
 *    a percentage produced that way is a measurement of nothing.
 */

import { basename } from "node:path";
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
import { isAction } from "./actions.ts";
import type { Adapter } from "./reader.ts";
import type { CaptureRecord, CaptureVendor } from "./record.ts";
import { streamLines } from "./reader.ts";
import { transcriptFiles } from "./seed.ts";

/** How many files AC4 names. */
export const AUDIT_FILES = 20;

/** How many pairs one file may contribute, so one busy session cannot be the sample. */
export const AUDIT_PER_FILE = 5;

/** Longest excerpt of a raw line that is shown. Bounded, because a line can be megabytes. */
export const AUDIT_EXCERPT = 800;

/** The bar AC4 sets. Below it on any field, S3.3 does not start. */
export const AUDIT_FLOOR = 80;

/**
 * The fields a person is asked about.
 *
 * `at`, `project`, `vendor` and `session` are copied from the line rather than
 * derived, so grading them would grade `JSON.parse`. `origin` is absent for the
 * reason in the file header. What is left is exactly what w4's classifier
 * decides: which of the three kinds this was, what it was aimed at, and whether
 * it worked.
 */
export type AuditField = "kind" | "target" | "outcome";

/** Those three, in the order they are asked. */
export const AUDIT_FIELDS: readonly AuditField[] = ["kind", "target", "outcome"];

/** One thing a person is asked to grade: the raw line, and what Mind made of it. */
export interface AuditPair {
  /** The vendor's own file. Shown on the terminal so the line can be looked up; stored nowhere. */
  readonly file: string;
  /** 1-based line number in that file. */
  readonly line: number;
  /** The line, flattened and cut to {@link AUDIT_EXCERPT}. */
  readonly excerpt: string;
  readonly record: CaptureRecord;
}

/** What one sampling run found. */
export interface AuditSample {
  readonly root: string;
  readonly vendor: CaptureVendor;
  /** Every `.jsonl` file under the root, whether or not it was sampled. */
  readonly filesFound: number;
  /** The files that were read in the second pass, sorted. */
  readonly filesRead: readonly string[];
  /** Lines read in that second pass. The index pass reads every file. */
  readonly linesRead: number;
  readonly pairs: readonly AuditPair[];
}

/** One line, flattened to something a terminal can show on one row. */
function excerptOf(line: string): string {
  const flat = line.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= AUDIT_EXCERPT ? flat : `${flat.slice(0, AUDIT_EXCERPT - 1)}…`;
}

/** A shuffled copy — Fisher–Yates over an injected source of randomness. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const here = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = here;
  }
  return copy;
}

/**
 * Twenty files at random, and the pairs they yield.
 *
 * The index pass runs over **every** file under the root, exactly as a seed does,
 * because an outcome lives in a different record from the call it belongs to —
 * and for grok, `S3.1 AC8`, in a different *file*. Indexing only the sampled
 * files would make every grok outcome `unknown` and have a person grade a
 * shortcut this took rather than the reading a seed would do.
 *
 * @param random Injected so a test is deterministic. `Math.random` otherwise.
 */
export async function sampleActions(options: {
  readonly root: string;
  readonly vendor: CaptureVendor;
  readonly now: Date;
  readonly files?: number;
  readonly perFile?: number;
  readonly random?: () => number;
}): Promise<AuditSample> {
  const found = await transcriptFiles(options.root);
  const nowIso = options.now.toISOString();
  const wanted = options.files ?? AUDIT_FILES;
  const perFile = options.perFile ?? AUDIT_PER_FILE;
  const random = options.random ?? Math.random;

  // ---- pass 1: the index, over the whole directory ------------------------
  const claude: ClaudeIndex = emptyClaudeIndex();
  const grok: GrokIndex = emptyGrokIndex();

  for (const path of found) {
    const session = sessionOf(path);
    for await (const line of streamLines(path)) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (options.vendor === "claude") indexClaudeLine(value, claude);
      else indexGrokLine(value, grok, session);
    }
  }

  // ---- pass 2: the sample -------------------------------------------------
  const picked = shuffled(found, random).slice(0, wanted).sort();
  const pairs: AuditPair[] = [];
  let linesRead = 0;

  for (const path of picked) {
    const session = sessionOf(path);
    const adapter: Adapter =
      options.vendor === "claude"
        ? claudeTranscript(claude, nowIso)
        : grokSession(grok, nowIso, session);

    let fromThisFile = 0;
    let lineNumber = 0;
    for await (const line of streamLines(path)) {
      lineNumber += 1;
      if (line.trim() === "" || fromThisFile >= perFile) continue;
      linesRead += 1;

      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const adapted = adapter(value);
      if (!("records" in adapted)) continue;

      for (const record of adapted.records) {
        if (fromThisFile >= perFile || !isAction(record)) continue;
        fromThisFile += 1;
        pairs.push({ file: path, line: lineNumber, excerpt: excerptOf(line), record });
      }
    }
  }

  return {
    root: options.root,
    vendor: options.vendor,
    filesFound: found.length,
    filesRead: picked,
    linesRead,
    pairs,
  };
}

/** The session id a file name stands for — the same rule `seed.ts` uses. */
function sessionOf(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

/** A terminal, injected — the same split `ConsentIo` makes, for the same reason. */
export interface AuditIo {
  /** Whether both ends are a terminal. False refuses the run; see the header. */
  readonly isTTY: boolean;
  readonly write: (line: string) => void;
  readonly readLine: () => Promise<string>;
}

/** What one field scored. */
export interface AuditVerdict {
  readonly field: AuditField;
  /** Pairs a person actually answered `y` or `n` about. */
  readonly judged: number;
  readonly correct: number;
  /** `correct / judged`, to one decimal. 0 when nothing was judged. */
  readonly pct: number;
}

/** What one answer meant. Anything else is a skip, which is not a judgement. */
type Answer = "yes" | "no" | "skip" | "quit";

function answerOf(line: string): Answer {
  const word = line.trim().toLowerCase();
  if (word === "y" || word === "yes") return "yes";
  if (word === "n" || word === "no") return "no";
  if (word === "q" || word === "quit") return "quit";
  return "skip";
}

/**
 * Show each pair and take a judgement per field.
 *
 * Skipping is a first-class answer and is counted as *not judged* rather than as
 * wrong: "I cannot tell from this line" is the honest response to a truncated
 * excerpt, and folding it into either column would invent an opinion. `q` ends
 * the run and keeps what was already answered.
 */
export async function judgeSample(
  io: AuditIo,
  sample: AuditSample,
): Promise<readonly AuditVerdict[]> {
  const judged = new Map<AuditField, { judged: number; correct: number }>();
  for (const field of AUDIT_FIELDS) judged.set(field, { judged: 0, correct: 0 });

  io.write(
    `${sample.pairs.length} pair(s) from ${sample.filesRead.length} of ${sample.filesFound} ` +
      `file(s) · vendor ${sample.vendor}`,
  );
  io.write("For each field: y = Mind read it right, n = wrong, anything else = skip, q = stop.");

  let quit = false;
  for (const [index, pair] of sample.pairs.entries()) {
    if (quit) break;
    io.write("");
    io.write(`(${index + 1}/${sample.pairs.length}) ${pair.file}:${pair.line}`);
    io.write(`  raw       ${pair.excerpt}`);
    io.write(`  tool      ${pair.record.tool}`);

    for (const field of AUDIT_FIELDS) {
      io.write(`  ${field.padEnd(9)} ${JSON.stringify(pair.record[field])}  ok? [y/n/skip/q]`);
      const answer = answerOf(await io.readLine());
      if (answer === "quit") {
        quit = true;
        break;
      }
      if (answer === "skip") continue;
      const tally = judged.get(field);
      if (tally === undefined) continue;
      tally.judged += 1;
      if (answer === "yes") tally.correct += 1;
    }
  }

  return AUDIT_FIELDS.map((field) => {
    const tally = judged.get(field) ?? { judged: 0, correct: 0 };
    return {
      field,
      judged: tally.judged,
      correct: tally.correct,
      pct: tally.judged === 0 ? 0 : Math.round((tally.correct * 1000) / tally.judged) / 10,
    };
  });
}

/** True when every field that was judged at all cleared {@link AUDIT_FLOOR}. */
export function auditClears(verdicts: readonly AuditVerdict[]): boolean {
  const answered = verdicts.filter((verdict) => verdict.judged > 0);
  return answered.length > 0 && answered.every((verdict) => verdict.pct >= AUDIT_FLOOR);
}

/** The verdicts as lines a human reads. A field nobody judged says so. */
export function formatAudit(verdicts: readonly AuditVerdict[]): readonly string[] {
  return verdicts.map((verdict) =>
    verdict.judged === 0
      ? `  ${verdict.field.padEnd(9)} nothing judged — no number, and none will be invented`
      : `  ${verdict.field.padEnd(9)} ${verdict.correct}/${verdict.judged} correct · ` +
        `${verdict.pct.toFixed(1)}% · floor ${AUDIT_FLOOR}%`,
  );
}

/**
 * What this instrument does and does not measure — printed on every run.
 *
 * The fourth line is the one the owner asked for by name: no percentage from the
 * test suite may be quoted as AC4's answer.
 */
export const AUDIT_LIMITS: readonly string[] = [
  "this command writes nothing. It reads the vendor's own files, shows what Mind derived beside " +
    "the line it came from, and prints a percentage. No capture is enabled, no consent is asked " +
    "for and none is needed, because nothing is kept — which is why it can be run before capture " +
    "has ever been turned on.",
  "it needs a terminal and has no --yes. A program running as you could answer `y` a hundred " +
    "times; a percentage produced that way measures nothing. A terminal proves there is a " +
    "terminal and not that there is a person (`script(1)` gives any process a pty) — Mind does " +
    "not claim otherwise.",
  "`origin` is not judged, because a transcript cannot answer it: every seeded record is " +
    "`unknown` by construction (S3.2 AC3, D-024). This measures the **seed** path. The hook path " +
    "stays unanswered until capture has been on long enough to sample real hook records — after " +
    "the first week of capture is the proposal.",
  "a number from the test suite is not this number. Every record a test uses was invented by the " +
    "test, so a percentage over fixtures measures this instrument and not the extraction. AC4 is " +
    "answered by a person at a terminal, on their own files, and by nothing else.",
  "twenty files is the sample AC4 names, and it is a sample. Nobody here computes a confidence " +
    "interval for it: a result under the floor is a reason to stop and look, not a statistic.",
  "what is shown is an excerpt of your own transcript, flattened and cut to " +
    `${AUDIT_EXCERPT} characters. It is not stored by Mind, and it is on your screen and in ` +
    "your scrollback.",
];
