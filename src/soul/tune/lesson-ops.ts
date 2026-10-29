/**
 * S21.6 (D-196) — `mind soul tune lessons`: list, accept and reject what the reflection proposed.
 *
 * A proposed lesson lives in its `mind/tune-run@1` record (outside git). Nothing here, and nothing in the
 * round, writes it into the agent repository: **accept** is the owner's command, typed at a terminal with a
 * yes, and appends one entry to `<agent dir>/lessons.md`, which Mind never commits (the owner does). **Reject**
 * records the refusal in `personal/evals/lessons-decisions.json` so the same lesson, by its normalised cue and
 * text, is not proposed again (D-029's way with a refused proposal). Both are refused without a terminal:
 * a program running as the owner could pass any flag, and what an agent keeps as its own knowledge is not
 * something it may decide for itself.
 *
 * The leak check (`lessonProblems`) runs again at accept time, against the task set as it is now: a lesson
 * proposed under an older set, or a record edited by hand, still cannot carry a graded phrase, a held-out ask
 * or anything flagged personal into `lessons.md`, which recall and the next proposer both read.
 */

import { readdir } from "node:fs/promises";
import type { EvalTask } from "../evals.ts";
import type { Style } from "../eval-runs.ts";
import { appendEntry, lessonKey, lessonProblems, parseLessons, readDecisions, readLessons, recordDecision, writeLessonsFile, LESSONS_FILE, type LessonEntry } from "../lessons.ts";
import { leakSources } from "./candidate.ts";
import type { ProposedLesson, VerdictRow } from "./prompts.ts";
import { isTuneRunId, readTuneRun } from "./round.ts";

export type LessonStatus = "proposed" | "accepted" | "refused";

/** One proposed lesson, as the owner sees it. */
export interface ProposedEntry {
  readonly run: string;
  readonly at: string;
  readonly base: string;
  readonly lesson: ProposedLesson;
  /** The verdict rows the lesson cites. */
  readonly rows: readonly VerdictRow[];
  readonly status: LessonStatus;
  /** Why it is `refused` or `accepted` when it is not this run's own decision. */
  readonly note: string;
}

/** Every lesson the tune records propose, newest run first, with what became of it. */
export async function listProposed(runsDir: string): Promise<readonly ProposedEntry[]> {
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch {
    return [];
  }
  const decisions = await readDecisions(runsDir);
  const out: ProposedEntry[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(isTuneRunId).sort().reverse()) {
    const read = await readTuneRun(runsDir, name);
    const lesson = read.ok ? read.record.reflection?.lesson : null;
    if (!read.ok || lesson === null || lesson === undefined) continue;
    const key = lessonKey(lesson);
    const own = decisions.find((d) => d.run === name);
    const other = decisions.find((d) => d.key === key && d.run !== name);
    const status: LessonStatus = own !== undefined ? own.outcome === "accepted" ? "accepted" : "refused" : other?.outcome === "refused" ? "refused" : other?.outcome === "accepted" ? "accepted" : "proposed";
    const note = own !== undefined ? `${own.outcome} ${own.at.slice(0, 10)}` : other !== undefined ? `the same lesson was ${other.outcome} in ${other.run}` : "";
    out.push({ run: name, at: read.record.startedAt, base: read.record.base.commit, lesson, rows: (read.record.reflection?.rows ?? []).filter((r) => lesson.rows.includes(r.row)), status, note });
  }
  return out;
}

/** The list as printed: cue, lesson, the rows it rests on, which run. */
export function lessonLines(list: readonly ProposedEntry[], { bold, dim }: Style, all: boolean): string[] {
  const shown = all ? list : list.filter((e) => e.status === "proposed");
  if (shown.length === 0) return [all ? "No lesson has been proposed." : "No lesson waits for you. (--all lists the accepted and refused ones too.)"];
  const out: string[] = [];
  for (const e of shown) {
    out.push(bold(`\n${e.run}  ${e.status}${e.note === "" ? "" : ` (${e.note})`}`));
    out.push(`  cue       ${e.lesson.cue}`, `  lesson    ${e.lesson.lesson}`, `  evidence  ${e.lesson.evidence}`);
    for (const r of e.rows) out.push(`    row ${r.row}  ${r.verdict}: ${r.passage.slice(0, 100)} — ${r.observed.slice(0, 160)}`);
    out.push(`  run ${e.run}, base ${e.base.slice(0, 8)}`);
    if (e.status === "proposed") out.push(dim(`  mind soul tune lessons accept ${e.run} <dir> --subject <id>   |   reject ${e.run} --subject <id>`));
  }
  return out;
}

export interface LessonEnv {
  /** The agent's repository root: `lessons.md` is written here. */
  readonly agentDir: string;
  readonly runsDir: string;
  /** A person at a terminal. */
  readonly interactive: boolean;
  /** Asks the person for the yes; true only for a typed yes. */
  readonly confirm: (entry: LessonEntry) => Promise<boolean>;
  readonly now: () => Date;
}

export type LessonResult = { readonly ok: true; readonly notice: readonly string[] } | { readonly ok: false; readonly reason: string };

const NEEDS_TERMINAL = "this is the owner's decision and needs a terminal: a program running as you could pass any flag, so there is deliberately no --yes";

async function proposedIn(env: LessonEnv, runId: string): Promise<{ readonly ok: true; readonly entry: ProposedEntry } | { readonly ok: false; readonly reason: string }> {
  const found = (await listProposed(env.runsDir)).find((e) => e.run === runId);
  if (found !== undefined) return found.status === "proposed" ? { ok: true, entry: found } : { ok: false, reason: `the lesson of ${runId} is already ${found.status}${found.note === "" ? "" : ` (${found.note})`}` };
  const read = await readTuneRun(env.runsDir, runId);
  return { ok: false, reason: read.ok ? `${runId} proposed no lesson` : read.reason };
}

/** Accept: the leak check again, the owner's yes, then one entry appended to `lessons.md`. Mind does not commit it. */
export async function acceptLesson(env: LessonEnv, runId: string, tasks: readonly EvalTask[], personText: string): Promise<LessonResult> {
  if (!env.interactive) return { ok: false, reason: `not accepted: ${NEEDS_TERMINAL}` };
  const found = await proposedIn(env, runId);
  if (!found.ok) return found;
  const { lesson } = found.entry;
  const problems = lessonProblems(lesson, leakSources(tasks), personText);
  if (problems.length > 0) return { ok: false, reason: `not accepted, and nothing written: ${problems.join("; ")}` };
  const kept = await readLessons(env.agentDir);
  if (!kept.ok) return { ok: false, reason: `${LESSONS_FILE} cannot be read, so nothing was appended to it: ${kept.reason}` };
  if (kept.entries.some((e) => lessonKey(e) === lessonKey(lesson))) return { ok: false, reason: `${LESSONS_FILE} already holds this lesson` };
  const entry: LessonEntry = { cue: lesson.cue, lesson: lesson.lesson, evidence: lesson.evidence, run: runId, date: env.now().toISOString().slice(0, 10), soul: found.entry.base };
  if (!(await env.confirm(entry))) return { ok: false, reason: `not accepted: the answer was not yes, so nothing was written` };
  const existing = await Bun.file(`${env.agentDir}/${LESSONS_FILE}`).text().catch(() => null);
  if (existing !== null && !parseLessons(existing).ok) return { ok: false, reason: `${LESSONS_FILE} is not a lessons file (mind/lessons@1): fix or move it first` };
  const path = await writeLessonsFile(env.agentDir, appendEntry(existing, entry));
  await recordDecision(env.runsDir, { run: runId, outcome: "accepted", key: lessonKey(lesson), at: env.now().toISOString() });
  return { ok: true, notice: [`Appended to ${path}.`, `Mind does not commit it: review it, then git add ${LESSONS_FILE} && git commit in ${env.agentDir}.`, "Recall indexes the file at the next index; the next tune round shows a lesson to its proposers when its cue matches the failures."] };
}

/** Reject: remember the refusal so the same lesson is not proposed again. Nothing is written to the agent repository. */
export async function rejectLesson(env: LessonEnv, runId: string): Promise<LessonResult> {
  if (!env.interactive) return { ok: false, reason: `not rejected: ${NEEDS_TERMINAL}` };
  const found = await proposedIn(env, runId);
  if (!found.ok) return found;
  await recordDecision(env.runsDir, { run: runId, outcome: "refused", key: lessonKey(found.entry.lesson), at: env.now().toISOString() });
  return { ok: true, notice: [`Refused: the lesson of ${runId} will not be proposed again.`] };
}
