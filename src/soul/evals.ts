/**
 * S6.5 — how much of the job the agent can really do, as a number (D-073).
 *
 * A set of real tasks, each with what a right answer must say and what it
 * must not, lives beside the soul in `evals.md` (in git: the tasks are the
 * job's, and a result is only comparable against the same set). The agent
 * answers each task once per configuration — the soul alone, then the soul
 * with recall (RAG) — and the grading is mechanical: every `expect` phrase
 * present, no `reject` phrase present. No model grades a model; a grade
 * anyone can recompute from the answer is one worth putting a percentage on.
 *
 * The third configuration AC2 names, soul + RAG + a fine-tuned model, is
 * S6.3's, and SP-3 closed as not passed for now (D-076); the report says so
 * rather than leaving the column out.
 *
 * S21.2 (owner ruling T3): a task may say which side of a train / held-out
 * split it is on, `split = "train"` (the default) or `split = "heldout"`, under
 * schema `mind/evals@2`. A `mind/evals@1` set still parses, every task train.
 * Held-out tasks are what a tuning decision is judged on; a tuner may look at
 * train results only.
 */

import { parseFrontmatter } from "./frontmatter.ts";
import type { SoulIssue, Validated } from "./schema.ts";

export const EVALS_FILE = "evals.md";
/** The schema tag of a task set: written as @2, @1 still read (every task train). */
export const EVALS_SCHEMA = "mind/evals@2";
export const EVALS_SCHEMA_V1 = "mind/evals@1";
const SCHEMAS: readonly string[] = [EVALS_SCHEMA, EVALS_SCHEMA_V1];
/** AC1: fewer than this is not a measurement of a job. */
export const MIN_TASKS = 20;
/**
 * S21.2: fewer held-out tasks than this cannot judge a tuning decision. At 6
 * one task moves the held-out rate by 16.7 points, already coarse; at 5 it is
 * 20 and a single flaky task decides the verdict. 6 is also a quarter of the
 * 24-task set the harness-tuning plan costs, the usual held-out share.
 */
export const MIN_HELDOUT = 6;

export const SPLITS = ["train", "heldout"] as const;
export type Split = (typeof SPLITS)[number];
/** `--split`: one side, or both. */
export type SplitFilter = Split | "all";

/** `--split`: absent is all; otherwise train, heldout or all, or the reason it is not. */
export function parseSplitFilter(raw: string | undefined): { readonly ok: true; readonly value: SplitFilter } | { readonly ok: false; readonly reason: string } {
  if (raw === undefined) return { ok: true, value: "all" };
  if (raw === "all" || (SPLITS as readonly string[]).includes(raw)) return { ok: true, value: raw as SplitFilter };
  return { ok: false, reason: `--split is train, heldout or all, not ${JSON.stringify(raw)}` };
}

/** The tasks on the given side of the split. */
export function bySplit<T extends { readonly split: Split }>(tasks: readonly T[], filter: SplitFilter): T[] {
  return filter === "all" ? [...tasks] : tasks.filter((t) => t.split === filter);
}

export interface EvalTask {
  readonly id: string;
  /** What kind of work this is — the report groups by it (AC3). */
  readonly kind: string;
  readonly ask: string;
  /** Every one must appear in the answer (case and spacing forgiven). */
  readonly expect: readonly string[];
  /** None may appear. */
  readonly reject: readonly string[];
  /** Where the right answer comes from — a memory file, a document. */
  readonly source: string;
  /** S21.2: which side of the train / held-out split; train unless the set says otherwise. */
  readonly split: Split;
}

export const MODES = ["soul", "soul+rag"] as const;
export type Mode = (typeof MODES)[number];
export const NOT_MEASURED: readonly { readonly mode: string; readonly why: string }[] = [
  { mode: "soul+rag+fine-tune", why: "SP-3 closed as not passed for now (D-076) — nothing is trained" },
];

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FIELDS = new Set(["kind", "ask", "expect", "reject", "source", "split"]);

const strings = (v: unknown): readonly string[] | undefined =>
  v === undefined ? [] : typeof v === "string" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

export function parseEvals(file: string, text: string): Validated<readonly EvalTask[]> {
  const parsed = parseFrontmatter(file, text);
  if (!parsed.ok) return parsed;
  const { table, lines } = parsed.value.doc;
  const lineOf = (key: string) => lines.get(key) ?? parsed.value.openLine;
  const issues: SoulIssue[] = [];
  const bad = (path: string, message: string) => issues.push({ file, line: lineOf(path), path, message });
  const schema = table["schema"];
  if (typeof schema !== "string" || !SCHEMAS.includes(schema)) bad("schema", `schema must be ${JSON.stringify(EVALS_SCHEMA)} (or ${JSON.stringify(EVALS_SCHEMA_V1)}), not ${JSON.stringify(schema)}`);
  const tasks: EvalTask[] = [];
  for (const [id, value] of Object.entries(table)) {
    if (id === "schema") continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      bad(id, `${id} is not a task: write it as a [${id}] table`);
      continue;
    }
    if (!ID.test(id)) {
      bad(id, `task ids are lower-case letters, digits and "-" — ${JSON.stringify(id)} is not`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (!FIELDS.has(key)) bad(`${id}.${key}`, `${key} is not a task field (kind, ask, expect, reject, source, split)`);
    const split = entry["split"] ?? "train";
    if (entry["split"] !== undefined && schema === EVALS_SCHEMA_V1) bad(`${id}.split`, `split needs schema ${JSON.stringify(EVALS_SCHEMA)}; under ${JSON.stringify(EVALS_SCHEMA_V1)} every task is train`);
    else if (typeof split !== "string" || !(SPLITS as readonly string[]).includes(split)) bad(`${id}.split`, `split is "train" or "heldout", not ${JSON.stringify(split)}`);
    const ask = typeof entry["ask"] === "string" ? entry["ask"].trim() : "";
    const expect = strings(entry["expect"]);
    const reject = strings(entry["reject"]);
    if (ask === "") bad(`${id}.ask`, "ask is the task, as the agent would be asked it");
    if (expect === undefined || expect.length === 0 || expect.some((e) => e.trim() === "")) bad(`${id}.expect`, "expect is one phrase or a list of them, every one required in a right answer");
    if (reject === undefined || reject.some((e) => e.trim() === "")) bad(`${id}.reject`, "reject is a list of phrases a right answer must not contain");
    if (ask === "" || expect === undefined || expect.length === 0 || reject === undefined) continue;
    tasks.push({
      id,
      kind: typeof entry["kind"] === "string" && entry["kind"].trim() !== "" ? entry["kind"].trim() : "general",
      ask,
      expect,
      reject,
      source: typeof entry["source"] === "string" ? entry["source"] : "",
      split: split === "heldout" ? "heldout" : "train",
    });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: tasks };
}

const fold = (s: string) => s.normalize("NFC").toLowerCase().replace(/[\s*_`]+/g, " ").trim();

/** Pass or fail, and exactly why. */
export function grade(task: EvalTask, answer: string): { readonly pass: boolean; readonly missing: readonly string[]; readonly rejected: readonly string[] } {
  const a = fold(answer);
  const missing = task.expect.filter((e) => !a.includes(fold(e)));
  const rejected = task.reject.filter((r) => a.includes(fold(r)));
  return { pass: a !== "" && missing.length === 0 && rejected.length === 0, missing, rejected };
}

export interface EvalResult {
  readonly task: string;
  readonly kind: string;
  readonly mode: Mode;
  readonly pass: boolean;
  readonly missing: readonly string[];
  readonly rejected: readonly string[];
  /** Which backend answered, or why none did. */
  readonly route: string;
}

export interface EvalReport {
  readonly total: number;
  readonly byMode: readonly { readonly mode: Mode; readonly passed: number; readonly percent: number }[];
  readonly byKind: readonly { readonly kind: string; readonly tasks: number; readonly percent: Readonly<Record<string, number>> }[];
  /** AC3: kinds the agent does not yet do in any configuration — below half, in the best one. */
  readonly notYet: readonly string[];
  readonly notMeasured: typeof NOT_MEASURED;
}

/** n of d as a percentage to one place; 0 of 0 is 0. */
export const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

/**
 * The report. With `repeat` k > 1 (S21.1) every task was answered k times per
 * configuration, so a task counts as its pass rate: `passed` is the sum of
 * those rates (a fraction, to two places) and every percentage is passes over
 * tasks × k. With k = 1 it is the count it always was.
 */
export function report(tasks: readonly EvalTask[], results: readonly EvalResult[], repeat = 1): EvalReport {
  const byMode = MODES.map((mode) => {
    const passes = results.filter((r) => r.mode === mode && r.pass).length;
    return { mode, passed: Math.round((passes / repeat) * 100) / 100, percent: pct(passes, tasks.length * repeat) };
  });
  const kinds = [...new Set(tasks.map((t) => t.kind))].sort();
  const byKind = kinds.map((kind) => {
    const ids = new Set(tasks.filter((t) => t.kind === kind).map((t) => t.id));
    const percent: Record<string, number> = {};
    for (const mode of MODES) percent[mode] = pct(results.filter((r) => r.mode === mode && ids.has(r.task) && r.pass).length, ids.size * repeat);
    return { kind, tasks: ids.size, percent };
  });
  const notYet = byKind.filter((k) => Math.max(...MODES.map((m) => k.percent[m] ?? 0)) < 50).map((k) => k.kind);
  return { total: tasks.length, byMode, byKind, notYet, notMeasured: NOT_MEASURED };
}
