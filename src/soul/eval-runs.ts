/**
 * S21.1 — every `mind eval` run is kept, tied to the soul that answered it (D-189).
 *
 * A run is one JSON file, `personal/evals/<runId>.json`, under the subject's
 * personal directory (`$XDG_DATA_HOME/mind/<subject>/personal/`, outside git;
 * owner ruling T1 of the harness-tuning plan): an answer can hold personal
 * data, and a record that only sometimes holds answers is still kept where
 * answers may go. Answers themselves are stored only on `--keep-answers`.
 *
 * The soul is named three ways, because each one fails somewhere the others
 * do not: the git tree of the soul directory at HEAD (null outside git), a
 * dirty flag (the files differ from that tree, so the tree alone would lie),
 * and a sha256 over the soul files' bytes, which is always there.
 *
 * A task answered k times (`--repeat k`) is a pass rate, and a task that both
 * passed and failed is flaky: the noise a later comparison (S21.3) must not
 * mistake for an effect. Per-attempt rows are kept addressable by task, mode
 * and attempt so the held-out split (S21.2) and compare (S21.3) can read them.
 *
 * S21.2 bumps the record to `mind/eval-run@2`: each row carries its task's
 * split, the record the `--split` it ran with and, for a compare (S21.3), the
 * link to its other half. `mind/eval-run@1` records are still read, as runs in
 * which every task was train.
 */

import { chmod, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { personalDir, type PersonalEnv } from "../guard/personal.ts";
import { runGuarded } from "../spawn.ts";
import { STATE_DIR_MODE } from "../state.ts";
import { replaceFile } from "../task/store.ts";
import type { SubjectId } from "../types.ts";
import { grade, MIN_HELDOUT, MODES, NOT_MEASURED, pct, report, SPLITS, type EvalReport, type EvalResult, type EvalTask, type Mode, type Split, type SplitFilter } from "./evals.ts";
import { PERSON_FILE, ROLE_FILE } from "./schema.ts";

export const EVAL_RUN_SCHEMA = "mind/eval-run@2";
/** Still read: a run from before the split, every task train. */
export const EVAL_RUN_SCHEMA_V1 = "mind/eval-run@1";
export const EVAL_RUNS_DIR = "evals";
export const MAX_REPEAT = 10;

/** The soul files named when the soul sits in the given directory itself, not in a `soul/` of its own. */
export const NAMED_SOUL_FILES: readonly string[] = [ROLE_FILE, PERSON_FILE, "autonomy.md", "triggers.md"];

export interface EvalAttempt extends EvalResult {
  /** 1..repeat. */
  readonly attempt: number;
  /** S21.2: the task's side of the split. */
  readonly split: Split;
  /** Only on `--keep-answers`: it may hold personal data. */
  readonly answer?: string;
}

export type Verdict = "stable pass" | "stable fail" | "flaky";

export interface TaskRate {
  readonly task: string;
  readonly kind: string;
  readonly mode: Mode;
  readonly passes: number;
  readonly attempts: number;
  readonly rate: number;
  readonly verdict: Verdict;
}

/** One side of the split: how many tasks, and the pass rate per mode and over both. */
export interface SplitRate {
  readonly split: Split;
  readonly tasks: number;
  readonly byMode: readonly { readonly mode: Mode; readonly percent: number }[];
  /** Passes over attempts, both modes together. */
  readonly percent: number;
}

export interface RepeatedReport extends EvalReport {
  readonly repeat: number;
  /** S21.2: train and held-out, always both, a side with no tasks at 0. */
  readonly bySplit: readonly SplitRate[];
  /** One row per task × mode, in task order. */
  readonly byTask: readonly TaskRate[];
  readonly flaky: number;
}

export interface SoulVersion {
  /** `git rev-parse HEAD:<soul dir>`; null outside git, before a first commit, or when the soul is not committed. */
  readonly gitTree: string | null;
  /** The soul files differ from HEAD (or are not in it). Null outside git. */
  readonly dirty: boolean | null;
  /** sha256 over each soul file's relative name and bytes, in name order. Always present. */
  readonly contentSha256: string;
  /** The files hashed, relative to the soul directory. */
  readonly files: readonly string[];
}

/** S21.3: the two runs of one `--compare`, and which half this one is. */
export interface CompareLink {
  readonly id: string;
  readonly role: "base" | "candidate";
  /** The git ref the candidate soul was read from (on both halves). */
  readonly ref: string;
  /** The commit that ref named when the compare ran. */
  readonly commit: string;
}

export interface EvalRunRecord {
  readonly schema: typeof EVAL_RUN_SCHEMA;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly subject: string;
  readonly soul: SoulVersion;
  readonly evalsSha256: string;
  readonly backend: string | null;
  readonly model: string | null;
  readonly recallChars: number;
  readonly repeat: number;
  readonly modes: readonly Mode[];
  readonly tasks: readonly string[];
  /** S21.2: the `--split` the run was made with. */
  readonly split: SplitFilter;
  readonly keptAnswers: boolean;
  readonly results: readonly EvalAttempt[];
  readonly report: RepeatedReport;
  /** S21.3: present on the two runs of a compare. */
  readonly compare?: CompareLink;
}

/** `--repeat`: absent is 1; otherwise a whole number 1..MAX_REPEAT, or the reason it is not. */
export function parseRepeat(raw: string | undefined): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string } {
  if (raw === undefined) return { ok: true, value: 1 };
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 1 || n > MAX_REPEAT) return { ok: false, reason: `--repeat is a whole number from 1 to ${MAX_REPEAT}, not ${JSON.stringify(raw)}` };
  return { ok: true, value: n };
}

/** What one attempt needs from the engine: the answer and the route, or why there was none. */
export type Ask = (task: EvalTask, mode: Mode, attempt: number) => Promise<{ readonly answer: string; readonly route: string }>;

/** Each task × mode, `repeat` times, graded. `onAttempt` sees each row as it is graded (progress lines). */
export async function runAttempts(
  tasks: readonly EvalTask[],
  repeat: number,
  ask: Ask,
  keepAnswers: boolean,
  onAttempt: (row: EvalAttempt, index: number) => void = () => undefined,
): Promise<EvalAttempt[]> {
  const rows: EvalAttempt[] = [];
  for (const [i, task] of tasks.entries()) {
    for (const mode of MODES) {
      for (let attempt = 1; attempt <= repeat; attempt++) {
        const { answer, route } = await ask(task, mode, attempt);
        const g = grade(task, answer);
        const row: EvalAttempt = { task: task.id, kind: task.kind, mode, attempt, split: task.split, pass: g.pass, missing: g.missing, rejected: g.rejected, route, ...(keepAnswers ? { answer } : {}) };
        rows.push(row);
        onAttempt(row, i);
      }
    }
  }
  return rows;
}

/** S21.2: per side of the split, from the rows alone (so a record can be read back without its task set). */
export function splitRates(rows: readonly EvalAttempt[]): SplitRate[] {
  return SPLITS.map((split) => {
    const mine = rows.filter((r) => r.split === split);
    const byMode = MODES.map((mode) => {
      const m = mine.filter((r) => r.mode === mode);
      return { mode, percent: pct(m.filter((r) => r.pass).length, m.length) };
    });
    return { split, tasks: new Set(mine.map((r) => r.task)).size, byMode, percent: pct(mine.filter((r) => r.pass).length, mine.length) };
  });
}

/** Today's report, with pass rates, plus one row per task × mode saying whether it held. */
export function repeatedReport(tasks: readonly EvalTask[], rows: readonly EvalAttempt[], repeat: number): RepeatedReport {
  const byTask: TaskRate[] = [];
  for (const task of tasks) {
    for (const mode of MODES) {
      const mine = rows.filter((r) => r.task === task.id && r.mode === mode);
      const passes = mine.filter((r) => r.pass).length;
      const attempts = mine.length;
      const verdict: Verdict = passes === attempts && attempts > 0 ? "stable pass" : passes === 0 ? "stable fail" : "flaky";
      byTask.push({ task: task.id, kind: task.kind, mode, passes, attempts, rate: attempts === 0 ? 0 : Math.round((passes / attempts) * 1000) / 1000, verdict });
    }
  }
  const results: EvalResult[] = rows.map(({ task, kind, mode, pass, missing, rejected, route }) => ({ task, kind, mode, pass, missing, rejected, route }));
  return { ...report(tasks, results, repeat), repeat, bySplit: splitRates(rows), byTask, flaky: byTask.filter((t) => t.verdict === "flaky").length };
}

export function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function filesUnder(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const name = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesUnder(root, name)));
    else if (entry.isFile()) out.push(name);
  }
  return out;
}

/**
 * The soul files: every file under the directory when it is a `soul/` of its
 * own, else only the named soul files beside whatever else lives there (an
 * agent repository's memory is not its soul).
 */
export async function soulFiles(soulDir: string): Promise<string[]> {
  if (basename(soulDir) === "soul") return (await filesUnder(soulDir)).sort();
  const present: string[] = [];
  for (const name of NAMED_SOUL_FILES) if (await Bun.file(join(soulDir, name)).exists()) present.push(name);
  return present.sort();
}

/** sha256 over `name NUL size NUL bytes` for each file, in name order: a rename or a split changes it too. */
export async function soulContentSha(soulDir: string, files: readonly string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const name of files) {
    const bytes = await readFile(join(soulDir, name));
    hasher.update(`${name}\0${bytes.byteLength}\0`);
    hasher.update(bytes);
  }
  return hasher.digest("hex");
}

/** No git on the machine reads as "not in git": the content hash still names the soul. */
const git = async (cwd: string, args: readonly string[]) => {
  try {
    const run = await runGuarded(["git", ...args], { cwd });
    return { code: run.code, out: new TextDecoder().decode(run.stdout).trim() };
  } catch {
    return { code: -1, out: "" };
  }
};

/** Which soul answered: its git tree, whether it differs from that tree, and its content hash. */
export async function soulVersion(soulDir: string): Promise<SoulVersion> {
  const files = await soulFiles(soulDir);
  const contentSha256 = await soulContentSha(soulDir, files);
  const inside = await git(soulDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out !== "true") return { gitTree: null, dirty: null, contentSha256, files };
  const tree = await git(soulDir, ["rev-parse", "--verify", "--quiet", "HEAD:./"]);
  if (tree.code !== 0 || tree.out === "") return { gitTree: null, dirty: true, contentSha256, files };
  // A `soul/` of its own: the whole directory, so a deleted file counts too. Beside other files: the named ones only.
  const paths = basename(soulDir) === "soul" ? ["."] : NAMED_SOUL_FILES;
  const changed = await git(soulDir, ["diff", "--quiet", "HEAD", "--", ...paths]);
  const untracked = await git(soulDir, ["ls-files", "--others", "--exclude-standard", "--", ...paths]);
  return { gitTree: tree.out, dirty: changed.code !== 0 || untracked.out !== "", contentSha256, files };
}

/** `ev-` + UTC time to the second + 4 hex: sorts by time, and two runs in one second still differ. */
export function newRunId(at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `ev-${stamp}-${crypto.randomUUID().slice(0, 4)}`;
}

const RUN_ID = /^ev-\d{8}T\d{6}Z-[0-9a-f]{4}$/;

export function isRunId(id: string): boolean {
  return RUN_ID.test(id);
}

/** `personal/evals/`, if the personal directory is outside git — resolved, not created. */
export async function evalRunsDir(env: PersonalEnv, subject: SubjectId): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }> {
  const parent = await personalDir(env, subject);
  if (!parent.ok) return { ok: false, reason: parent.reason };
  return { ok: true, path: join(parent.path, EVAL_RUNS_DIR) };
}

export async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: STATE_DIR_MODE });
  await chmod(path, STATE_DIR_MODE);
}

/** Write a run: the directory 0700 (and its parent), the file 0600, whole or not at all. */
export async function writeEvalRun(dir: string, record: EvalRunRecord): Promise<string> {
  if (!isRunId(record.runId)) throw new Error(`not an eval run id: ${JSON.stringify(record.runId)}`);
  await privateDir(join(dir, ".."));
  await privateDir(dir);
  const path = join(dir, `${record.runId}.json`);
  await replaceFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function isRunRecord(value: unknown): value is EvalRunRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const soul = r["soul"] as Record<string, unknown> | undefined;
  return (
    (r["schema"] === EVAL_RUN_SCHEMA || r["schema"] === EVAL_RUN_SCHEMA_V1) &&
    typeof r["runId"] === "string" &&
    isRunId(r["runId"]) &&
    typeof r["startedAt"] === "string" &&
    typeof soul === "object" &&
    soul !== null &&
    typeof soul["contentSha256"] === "string" &&
    typeof r["repeat"] === "number" &&
    Array.isArray(r["results"]) &&
    typeof r["report"] === "object" &&
    r["report"] !== null
  );
}

/** A record as today's shape: an @1 run is one in which every task was train and no `--split` was given. */
function normalised(record: EvalRunRecord): EvalRunRecord {
  if ((record.schema as string) !== EVAL_RUN_SCHEMA_V1) return record;
  const results = record.results.map((r) => ({ ...r, split: r.split ?? "train" }));
  return { ...record, split: "all", results, report: { ...record.report, bySplit: splitRates(results) } };
}

/** One run by id, or why it cannot be read. */
export async function readEvalRun(dir: string, runId: string): Promise<{ readonly ok: true; readonly run: EvalRunRecord } | { readonly ok: false; readonly reason: string }> {
  if (!isRunId(runId)) return { ok: false, reason: `${JSON.stringify(runId)} is not an eval run id (ev-<time>-<4 hex>; see mind eval runs)` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, `${runId}.json`), "utf8"));
  } catch {
    return { ok: false, reason: `no readable run ${runId} in ${dir}` };
  }
  return isRunRecord(parsed) ? { ok: true, run: normalised(parsed) } : { ok: false, reason: `${runId}.json is not an eval run record (${EVAL_RUN_SCHEMA})` };
}

/** S21.5: what else lives in `personal/evals/` and is not an eval run: tune-run records and the tuner's proof. */
const OTHER_RECORDS = /^(tn-.*|tuner-proof)\.json$/;

/** Every readable run of the directory, newest first, and the names of files that were not one. */
export async function listEvalRuns(dir: string): Promise<{ readonly runs: readonly EvalRunRecord[]; readonly unreadable: readonly string[] }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { runs: [], unreadable: [] };
  }
  const runs: EvalRunRecord[] = [];
  const unreadable: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".json") && !OTHER_RECORDS.test(n))) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (isRunRecord(parsed)) runs.push(normalised(parsed));
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.runId < b.runId ? 1 : -1));
  return { runs, unreadable: unreadable.sort() };
}

/** `tree 1a2b3c4d`, `tree 1a2b3c4d*` when dirty, `sha 9f8e7d6c` outside git (`*` when not committed). */
export function soulShort(soul: SoulVersion): string {
  const mark = soul.dirty === true ? "*" : "";
  return soul.gitTree === null ? `sha ${soul.contentSha256.slice(0, 8)}${mark}` : `tree ${soul.gitTree.slice(0, 8)}${mark}`;
}

/** One line per run, newest first. */
export function formatEvalRuns(runs: readonly EvalRunRecord[]): string[] {
  return runs.map((run) => {
    const date = run.startedAt.slice(0, 16).replace("T", " ");
    const where = `${run.backend ?? "default"}/${run.model ?? "default"}`;
    const modes = run.report.byMode.map((m) => `${m.mode} ${m.percent}%`).join("  ");
    const flaky = run.repeat > 1 ? ` · ${run.report.flaky} flaky` : "";
    const held = run.report.bySplit.find((s) => s.split === "heldout");
    const heldout = held !== undefined && held.tasks > 0 ? ` · heldout ${held.tasks} at ${held.percent}%` : "";
    const compare = run.compare === undefined ? "" : ` · ${run.compare.id} ${run.compare.role}`;
    return `${run.runId}  ${date}  ${soulShort(run.soul).padEnd(14)}  ${where.padEnd(20)}  ${modes}  ×${run.repeat}  ${run.tasks.length} task(s)${flaky}${heldout}${compare}`;
  });
}

/** The record of one run, from what the command knows at its end. */
export function evalRunRecord(run: {
  readonly startedAt: Date;
  readonly subject: string;
  readonly soul: SoulVersion;
  readonly setText: string;
  readonly backend: string | undefined;
  readonly model: string | undefined;
  readonly recallChars: number;
  readonly tasks: readonly EvalTask[];
  readonly split?: SplitFilter;
  readonly keptAnswers: boolean;
  readonly results: readonly EvalAttempt[];
  readonly report: RepeatedReport;
  readonly compare?: CompareLink;
}, finishedAt = new Date()): EvalRunRecord {
  return {
    schema: EVAL_RUN_SCHEMA,
    runId: newRunId(run.startedAt),
    startedAt: run.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    subject: run.subject,
    soul: run.soul,
    evalsSha256: sha256(run.setText),
    backend: run.backend || null,
    model: run.model || null,
    recallChars: run.recallChars,
    repeat: run.report.repeat,
    modes: [...MODES],
    tasks: run.tasks.map((t) => t.id),
    split: run.split ?? "all",
    keptAnswers: run.keptAnswers,
    results: run.results,
    report: run.report,
    ...(run.compare === undefined ? {} : { compare: run.compare }),
  };
}

/** The progress line of one graded attempt; `#n` only when there is more than one. */
export function attemptLine(g: EvalAttempt, index: number, total: number, repeat: number): string {
  const missing = g.missing.length ? ` — missing ${g.missing.map((m) => JSON.stringify(m)).join(", ")}` : "";
  const said = g.rejected.length ? ` — said ${g.rejected.map((m) => JSON.stringify(m)).join(", ")}` : "";
  return `  ${index + 1}/${total} ${g.task} [${g.mode}]${repeat > 1 ? ` #${g.attempt}` : ""} ${g.pass ? "pass" : `fail${missing}${said}`} · ${g.route.split(" · ")[0]}`;
}

export interface Style {
  readonly bold: (s: string) => string;
  readonly dim: (s: string) => string;
}

/**
 * S21.2: train and held-out, and what each is for. Held-out is what a tuning
 * decision is judged on; below {@link MIN_HELDOUT} tasks it is flagged as too
 * small to judge, and with none at all the run says it cannot judge one.
 */
export function splitLines(bySplit: readonly SplitRate[], { bold, dim }: Style): string[] {
  const out = [bold("\nby split")];
  for (const s of bySplit) out.push(`  ${s.split.padEnd(10)} ${String(s.tasks).padStart(3)} task(s)   ${s.tasks === 0 ? "—" : `${s.byMode.map((m) => `${m.mode} ${m.percent}%`).join("   ")}   both ${s.percent}%`}`);
  const held = bySplit.find((s) => s.split === "heldout")?.tasks ?? 0;
  out.push(dim("Held-out numbers are what a tuning decision is judged on; train numbers are what a tuner may look at."));
  if (held === 0) out.push(bold(`No held-out tasks in this run: it cannot judge a tuning decision. Mark some split = "heldout" (mind eval split proposes which).`));
  else if (held < MIN_HELDOUT) out.push(bold(`Held-out is ${held} task(s): too small to judge a tuning decision (at least ${MIN_HELDOUT}).`));
  return out;
}

/** The report as printed: per mode, per kind, per task when k > 1, and where the run was recorded. */
export function reportLines(name: string, r: RepeatedReport, kept: { readonly recorded: string | null; readonly soul: SoulVersion; readonly keptAnswers: boolean }, { bold, dim }: Style): string[] {
  const out = [bold(`\n${name} — ${r.total} task(s)${r.repeat > 1 ? `, each ${r.repeat} times` : ""}`)];
  for (const m of r.byMode) out.push(`  ${m.mode.padEnd(14)} ${String(m.passed).padStart(3)}/${r.total}  ${m.percent}%`);
  for (const m of NOT_MEASURED) out.push(dim(`  ${m.mode.padEnd(14)} not measured — ${m.why}`));
  out.push(...splitLines(r.bySplit, { bold, dim }));
  out.push(bold("\nby kind of work"));
  for (const k of r.byKind) out.push(`  ${k.kind.padEnd(18)} ${String(k.tasks).padStart(3)} task(s)   ${MODES.map((m) => `${m} ${k.percent[m]}%`).join("   ")}`);
  if (r.repeat > 1) {
    out.push(bold(`\nby task (${r.repeat} attempts each) — ${r.flaky} flaky`));
    for (const t of r.byTask) out.push(`  ${t.task.padEnd(28)} ${t.mode.padEnd(10)} ${t.passes}/${t.attempts}  ${t.verdict}`);
  }
  out.push(r.notYet.length === 0 ? "\nEvery kind of work passes at least half its tasks in some configuration." : bold(`\nNot yet replaceable (under half, in the best configuration): ${r.notYet.join(", ")}`));
  out.push(dim("Graded by the phrases in the task set, not by a model. Every answer is in the ledger."));
  out.push(dim(kept.recorded === null ? "Not recorded (--no-record)." : `Recorded as ${kept.recorded} (soul ${soulShort(kept.soul)}, answers ${kept.keptAnswers ? "kept" : "not kept"}).`));
  return out;
}
