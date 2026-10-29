/**
 * S21.6 (D-196) — the reflection step of a tuning round: what each edit did, and at most one lesson.
 *
 * It runs after the round has its verdict and never changes it: a reflection that fails, leaks or is refused
 * leaves the round exactly as it was and records why there is no lesson. What goes to the model is
 * {@link reflectMission} (D-190) built from the base soul, the candidates' bodies, and per-run results in which
 * **held-out arrives as numbers only** (a count, a pass rate, a flip count: never an ask). The train answers
 * are the agent's own, as in the proposer's mission. The model is reached through the same function the
 * proposer is (`TuneDeps.reflect`, a child `mind turn` on the agent's own backend, T8), so the egress notice,
 * the ledger, the fence and the brake apply; the leak guard is run on every prompt before it is sent.
 *
 * A lesson comes out only if it parses (`parseReflection`: at most one, rows cited, not resting on confounded
 * rows alone), passes {@link lessonProblems} (nothing graded, nothing personal), and was not refused before nor
 * already accepted. An invalid answer gets one retry with the issues listed, in words that never repeat a
 * graded phrase; after that, "no lesson": the verdict rows are kept when only the lesson was the trouble.
 * A proposed lesson is not written anywhere in the agent's repository: it waits for the owner (`lessons.ts`).
 */

import { compareSides, REGRESSIONS } from "../eval-compare.ts";
import type { EvalRunRecord } from "../eval-runs.ts";
import type { EvalTask } from "../evals.ts";
import { lessonKey, lessonProblems } from "../lessons.ts";
import { formatIssue, type Soul } from "../schema.ts";
import { evidenceFrom, relaxedGuard, type Guard, type ProposerOutcome } from "./candidate.ts";
import { NO_LESSON_LINE, parseReflection, reflectMission, singleRollout, type CandidateView, type Dimension, type LeakSources, type ProposedLesson, type Reflection, type RoundResult, type TaskEvidence, type VerdictRow } from "./prompts.ts";

/** What the record keeps of the reflection (`mind/tune-run@1`, outside git). */
export interface ReflectionRecord {
  /** `done`: an answer was read. `skipped`: nothing was asked. `failed`: asked, and no usable answer. */
  readonly status: "done" | "skipped" | "failed";
  /** Why there is no lesson (or no reflection); empty when a lesson was proposed. */
  readonly reason: string;
  readonly tries: number;
  readonly rows: readonly VerdictRow[];
  /** At most one, and only one that waits for the owner. */
  readonly lesson: ProposedLesson | null;
}

/** One candidate as the reflection needs it. */
export interface ReflectCandidate {
  readonly dimension: Dimension;
  readonly proposal: ProposerOutcome;
  /** The eval run of the candidate soul; null for KEEP_BASE. */
  readonly run: EvalRunRecord | null;
}

export interface ReflectInput {
  readonly soul: Soul;
  readonly tasks: readonly EvalTask[];
  readonly repeat: number;
  readonly base: EvalRunRecord;
  readonly candidates: readonly ReflectCandidate[];
  readonly sources: LeakSources;
  readonly personText: string;
  /** {@link lessonKey}s the owner refused or already accepted: not proposed again. */
  readonly known: ReadonlySet<string>;
  readonly ask: (prompt: string, attempt: 1 | 2) => Promise<string>;
  readonly stopped: () => Promise<boolean>;
  readonly guard?: Guard;
  /** S21.7's sabotaged twin only: rewrites the mission before the guard sees it. */
  readonly rewrite?: (mission: string, sources: LeakSources) => string;
}

const skipped = (reason: string): ReflectionRecord => ({ status: "skipped", reason, tries: 0, rows: [], lesson: null });

/** Every train task of a run with the answer it gave, in the task set's order. */
function trainOf(tasks: readonly EvalTask[], run: EvalRunRecord): readonly TaskEvidence[] {
  const { failures, passes } = evidenceFrom(tasks, run.results);
  const all = [...failures, ...passes];
  return tasks.flatMap((t) => all.filter((e) => e.id === t.id));
}

/** The numbers of one split of a run, as a fraction; held-out asks never come in. */
function heldOutOf(run: EvalRunRecord, passToFail: number): RoundResult["heldOut"] {
  const held = run.report.bySplit.find((s) => s.split === "heldout");
  return { tasks: held?.tasks ?? 0, passRate: (held?.percent ?? 0) / 100, passToFail };
}

/** The reflection's input: base soul, candidate bodies, results. Pure. */
export function reflectInputOf(input: Pick<ReflectInput, "soul" | "tasks" | "repeat" | "base" | "candidates">): { readonly views: readonly CandidateView[]; readonly results: readonly RoundResult[] } {
  const views: CandidateView[] = input.candidates.map((c) => (c.proposal.outcome === "edit" ? { label: c.dimension, dimension: c.dimension, body: c.proposal.body, notes: c.proposal.notes } : { label: c.dimension, dimension: c.dimension, body: null, notes: c.proposal.outcome === "keep-base" ? c.proposal.reason : "" }));
  const results: RoundResult[] = [{ label: "base", repeat: input.repeat, train: trainOf(input.tasks, input.base), heldOut: heldOutOf(input.base, 0) }];
  for (const c of input.candidates) {
    if (c.run === null) continue;
    const flips = compareSides(input.base, c.run).rows.filter((r) => r.split === "heldout" && REGRESSIONS.has(r.change)).length;
    results.push({ label: c.dimension, repeat: input.repeat, train: trainOf(input.tasks, c.run), heldOut: heldOutOf(c.run, flips) });
  }
  return { views, results };
}

/** The retry's prompt: the same mission, then the reasons, in Mind's words. */
export function retryReflection(mission: string, issues: readonly string[]): string {
  return [mission, "# YOUR PREVIOUS ANSWER WAS REFUSED", "", "Mind could not use it, for these reasons:", ...issues.map((i) => `- ${i}`), "", `Answer once more, in the OUTPUT FORMAT above, fixing every one of them; ${NO_LESSON_LINE} is always a valid answer for the lesson. This is the last try.`, ""].join("\n");
}

/** The answer with its `<lesson>` block taken out and NO_LESSON in its place: the rows of an answer whose lesson was the only trouble. */
export function withoutLesson(answer: string): string {
  const lines = answer.replace(/\r\n?/g, "\n").split("\n");
  const open = lines.findIndex((l) => l.trim() === "<lesson>");
  const close = lines.findIndex((l) => l.trim() === "</lesson>");
  const kept = open !== -1 && close > open ? [...lines.slice(0, open), ...lines.slice(close + 1)] : lines.filter((l) => l.trim() !== "<lesson>" && l.trim() !== "</lesson>");
  return [...kept, NO_LESSON_LINE].join("\n");
}

/** Reflect on a finished round. Returns null when the brake went on; never throws for anything the model did. */
export async function reflectOnRound(input: ReflectInput): Promise<ReflectionRecord | null> {
  const guard = input.guard ?? relaxedGuard;
  if (!input.candidates.some((c) => c.proposal.outcome === "edit")) return skipped("no candidate changed the body: there is no edit to say anything about");
  const { views, results } = reflectInputOf(input);
  const base = input.soul.role;
  const built = reflectMission({ base: { name: base.name, role: base.role, prohibitions: base.prohibitions, scope: { does: base.scope.does, does_not: base.scope.does_not }, body: base.body }, candidates: views, results });
  const mission = input.rewrite === undefined ? built : input.rewrite(built, input.sources);
  const check = { singleRollout: singleRollout(results), labels: views.map((v) => v.label) };

  let prompt = mission;
  let issues: readonly string[] = [];
  let lastAnswer = "";
  let lessonOnly = false;
  for (const attempt of [1, 2] as const) {
    if (await input.stopped()) return null;
    try {
      guard(prompt, input.sources);
    } catch (cause) {
      return skipped(`the leak guard refused the reflection's input, so no model was asked: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    let answer: string;
    try {
      answer = await input.ask(prompt, attempt);
    } catch (cause) {
      issues = [`the reflection did not answer: ${cause instanceof Error ? cause.message : String(cause)}`];
      lessonOnly = false;
      prompt = retryReflection(mission, issues);
      continue;
    }
    if (await input.stopped()) return null;
    lastAnswer = answer;
    const parsed = parseReflection(answer, check);
    if (!parsed.ok) {
      issues = parsed.issues.map(formatIssue);
      lessonOnly = parsed.issues.every((i) => i.path === "lesson" || i.path.startsWith("lesson."));
      prompt = retryReflection(mission, issues);
      continue;
    }
    const lesson = parsed.value.lesson;
    if (lesson === null) return { status: "done", reason: "the reflection wrote no lesson", tries: attempt, rows: parsed.value.rows, lesson: null };
    if (input.known.has(lessonKey(lesson))) return { status: "done", reason: "the same lesson was refused or accepted before: not proposed again", tries: attempt, rows: parsed.value.rows, lesson: null };
    const problems = lessonProblems(lesson, input.sources, input.personText);
    if (problems.length === 0) return { status: "done", reason: "", tries: attempt, rows: parsed.value.rows, lesson };
    if (attempt === 2) return { status: "done", reason: `lesson declined: ${problems.join("; ")}`, tries: attempt, rows: parsed.value.rows, lesson: null };
    issues = problems;
    prompt = retryReflection(mission, issues);
  }
  // Two tries, no usable answer. When the lesson was the only trouble, the rows are still worth keeping.
  if (lastAnswer !== "" && lessonOnly) {
    const salvage: Reflection | null = (() => {
      const again = parseReflection(withoutLesson(lastAnswer), check);
      return again.ok ? again.value : null;
    })();
    if (salvage !== null) return { status: "done", reason: `lesson declined: ${issues.join("; ")}`.slice(0, 1000), tries: 2, rows: salvage.rows, lesson: null };
  }
  return { status: "failed", reason: `no lesson: no usable answer after two tries (${issues.join("; ")})`.slice(0, 1000), tries: 2, rows: [], lesson: null };
}
