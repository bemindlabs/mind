/**
 * S22.14 (D-197, D-201) — one line of measurement when a task ends.
 *
 * **Metadata only** (AC1): ids, labels the owner chose, statuses, counts, times. Never a goal, a prompt, an answer, a
 * summary or a line of code. The line says what was run and how it ended; the words stay where they were (the task,
 * the ledger), and a test holds the shape to that.
 *
 * Who a task "belongs to" for the table: the backend and model that answered its **last** step, the one that finished
 * it. A task carried across a handoff counts for the backend that ended it, and its `steps` list keeps every other one.
 * That is a choice, written down so nobody reads the table as more than it is: it credits the finisher, not the
 * whole path.
 *
 * What is not here: whether the project's gates were green on the first run. Mind runs no gate, and a number a bot
 * could write about its own work is not a measurement; the review verdicts (`reviews.jsonl`, S22.7) are the only
 * outside signal a line carries, as `review`. A reader who wants gate rates adds them from the place the gate runs.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";
import type { ReviewRecord } from "../review/review.ts";
import type { TaskRecord } from "../task/store.ts";

export const MEASURE_SCHEMA = "mind/measure@1";
export const MEASURE_DIR = "measure";
export const MEASURE_FILE = "measures.jsonl";

/** A kind is a short label the owner gives a sort of work (`refactor`, `bugfix`, `docs`); a slug, so it cannot carry prose. */
export const KIND = /^[a-z][a-z0-9-]{0,23}$/;

export type MeasuredStatus = "done" | "failed" | "stopped" | "budget";

export interface Measure {
  readonly v: 1;
  readonly task: string;
  readonly subject: string;
  readonly at: string;
  readonly kind: string | null;
  readonly status: MeasuredStatus;
  /** The backend that answered the last step, and the model its own output named — `null` when it named none. */
  readonly backend: string | null;
  readonly model: string | null;
  /** Every (backend, model) that answered a step, with how many. */
  readonly steps: readonly { readonly backend: string; readonly model: string | null; readonly n: number }[];
  readonly turns: number;
  /** Tokens the backends printed, summed; `null` when none printed any. A floor when `tokensUnknown` is above 0. */
  readonly tokens: number | null;
  readonly tokensUnknown: number;
  readonly activeMs: number;
  /** What `mind review` said of it, when it was reviewed; `null` when it never was. */
  readonly review: { readonly n: number; readonly changes: number; readonly blockers: number } | null;
}

const FINAL: readonly string[] = ["done", "failed", "stopped", "budget"];

/**
 * The line for a task that has ended, or `undefined` for one that has not.
 *
 * The model of each step is the one the step recorded when it ran (from the turn's own `--json`), never read back from
 * the ledger: nothing reads the ledger into a decision (D-022), and a measurement that decides routing is one.
 */
export function measureOf(record: TaskRecord, reviews: readonly ReviewRecord[]): Measure | undefined {
  if (!FINAL.includes(record.status)) return undefined;
  const answered = record.steps.filter((step) => step.backend !== null && (step.outcome === "ok" || step.outcome === "unreadable"));
  const grouped = new Map<string, { backend: string; model: string | null; n: number }>();
  let last: { backend: string; model: string | null } | undefined;
  for (const step of answered) {
    const model = step.model ?? null;
    const key = `${step.backend}\u0000${model ?? ""}`;
    const entry = grouped.get(key) ?? { backend: step.backend!, model, n: 0 };
    entry.n += 1;
    grouped.set(key, entry);
    last = { backend: step.backend!, model };
  }
  return {
    v: 1,
    task: record.id,
    subject: record.subject,
    at: record.statusAt,
    kind: typeof record.kind === "string" && KIND.test(record.kind) ? record.kind : null,
    status: record.status as MeasuredStatus,
    backend: last?.backend ?? null,
    model: last?.model ?? null,
    steps: [...grouped.values()],
    turns: record.used.turns,
    tokens: record.used.tokensUnknown >= record.used.turns && record.used.tokens === 0 ? null : record.used.tokens,
    tokensUnknown: record.used.tokensUnknown,
    activeMs: record.used.activeMs,
    review:
      reviews.length === 0
        ? null
        : { n: reviews.length, changes: reviews.filter((r) => r.verdict === "changes").length, blockers: reviews.reduce((sum, r) => sum + r.counts.blocker, 0) },
  };
}

/** A line read back, or `undefined` for anything that is not one: torn, foreign, or from a schema this does not know. */
export function parseMeasure(line: string): Measure | undefined {
  try {
    const m = JSON.parse(line) as Record<string, unknown>;
    const ok =
      m["v"] === 1 &&
      typeof m["task"] === "string" &&
      typeof m["subject"] === "string" &&
      typeof m["at"] === "string" &&
      (m["kind"] === null || (typeof m["kind"] === "string" && KIND.test(m["kind"]))) &&
      FINAL.includes(String(m["status"])) &&
      (m["backend"] === null || typeof m["backend"] === "string") &&
      (m["model"] === null || typeof m["model"] === "string") &&
      Array.isArray(m["steps"]) &&
      typeof m["turns"] === "number" &&
      (m["tokens"] === null || typeof m["tokens"] === "number") &&
      typeof m["tokensUnknown"] === "number" &&
      typeof m["activeMs"] === "number";
    return ok ? (m as unknown as Measure) : undefined;
  } catch {
    return undefined;
  }
}

/** What `mind review` recorded for a task (`reviews.jsonl` in its directory): lines that read, in order. */
export async function readReviews(taskDir: string): Promise<readonly ReviewRecord[]> {
  let text = "";
  try {
    text = await readFile(join(taskDir, "reviews.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: ReviewRecord[] = [];
  for (const line of text.split("\n")) {
    try {
      const r = JSON.parse(line) as Partial<ReviewRecord>;
      if ((r.verdict === "approve" || r.verdict === "changes") && typeof r.counts?.blocker === "number") out.push(r as ReviewRecord);
    } catch {
      // A torn or foreign line is skipped.
    }
  }
  return out;
}

export async function appendMeasure(personal: string, measure: Measure): Promise<void> {
  const dir = join(personal, MEASURE_DIR);
  await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
  await appendFile(join(dir, MEASURE_FILE), `${JSON.stringify(measure)}\n`, { mode: STATE_FILE_MODE });
}

/** Every line of one subject's measure file that reads. A task measured twice (a resumed one) counts once, the last. */
export async function readMeasures(personal: string): Promise<readonly Measure[]> {
  let text = "";
  try {
    text = await readFile(join(personal, MEASURE_DIR, MEASURE_FILE), "utf8");
  } catch {
    return [];
  }
  const byTask = new Map<string, Measure>();
  for (const line of text.split("\n")) {
    const measure = line === "" ? undefined : parseMeasure(line);
    if (measure !== undefined) byTask.set(measure.task, measure);
  }
  return [...byTask.values()];
}
