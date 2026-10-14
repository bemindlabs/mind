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
 */

import { parseFrontmatter } from "./frontmatter.ts";
import type { SoulIssue, Validated } from "./schema.ts";

export const EVALS_FILE = "evals.md";
/** The schema tag of a task set. */
export const EVALS_SCHEMA = "mind/evals@1";
/** AC1: fewer than this is not a measurement of a job. */
export const MIN_TASKS = 20;

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
}

export const MODES = ["soul", "soul+rag"] as const;
export type Mode = (typeof MODES)[number];
export const NOT_MEASURED: readonly { readonly mode: string; readonly why: string }[] = [
  { mode: "soul+rag+fine-tune", why: "SP-3 closed as not passed for now (D-076) — nothing is trained" },
];

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FIELDS = new Set(["kind", "ask", "expect", "reject", "source"]);

const strings = (v: unknown): readonly string[] | undefined =>
  v === undefined ? [] : typeof v === "string" ? [v] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

export function parseEvals(file: string, text: string): Validated<readonly EvalTask[]> {
  const parsed = parseFrontmatter(file, text);
  if (!parsed.ok) return parsed;
  const { table, lines } = parsed.value.doc;
  const lineOf = (key: string) => lines.get(key) ?? parsed.value.openLine;
  const issues: SoulIssue[] = [];
  const bad = (path: string, message: string) => issues.push({ file, line: lineOf(path), path, message });
  if (table["schema"] !== EVALS_SCHEMA) bad("schema", `schema must be ${JSON.stringify(EVALS_SCHEMA)}, not ${JSON.stringify(table["schema"])}`);
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
    for (const key of Object.keys(entry)) if (!FIELDS.has(key)) bad(`${id}.${key}`, `${key} is not a task field (kind, ask, expect, reject, source)`);
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

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

export function report(tasks: readonly EvalTask[], results: readonly EvalResult[]): EvalReport {
  const byMode = MODES.map((mode) => {
    const passed = results.filter((r) => r.mode === mode && r.pass).length;
    return { mode, passed, percent: pct(passed, tasks.length) };
  });
  const kinds = [...new Set(tasks.map((t) => t.kind))].sort();
  const byKind = kinds.map((kind) => {
    const ids = new Set(tasks.filter((t) => t.kind === kind).map((t) => t.id));
    const percent: Record<string, number> = {};
    for (const mode of MODES) percent[mode] = pct(results.filter((r) => r.mode === mode && ids.has(r.task) && r.pass).length, ids.size);
    return { kind, tasks: ids.size, percent };
  });
  const notYet = byKind.filter((k) => Math.max(...MODES.map((m) => k.percent[m] ?? 0)) < 50).map((k) => k.kind);
  return { total: tasks.length, byMode, byKind, notYet, notMeasured: NOT_MEASURED };
}
