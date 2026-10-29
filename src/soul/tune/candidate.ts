/**
 * S21.5 (D-193) — from a failed train task to a candidate `role.md`, and nothing past it.
 *
 * Three things live here, each pure or nearly so:
 *
 * - {@link evidenceFrom}: the train rows of a base run, as the proposer may see them (T2): the ask, one
 *   answer, how many attempts passed. Held-out rows never come in: only train tasks are looked at.
 * - {@link buildCandidate}: T4 as code. The candidate is the base `role.md` with its body replaced and every
 *   byte of the frontmatter kept; it must load through the real `parseSoul` and keep the same name, role,
 *   prohibitions, scope and extra. Nothing else in the soul is in play: the branch is built from the base's
 *   tree with this one blob replaced (`git.ts`), so `person.md`, `autonomy.md` and `triggers.md` are the base's
 *   own bytes by construction.
 * - {@link askProposer}: one dimension's round with the model. The mission is checked by the leak guard before
 *   every send, an invalid answer gets exactly one retry with the issues listed, and then the dimension is
 *   KEEP_BASE. What it asks is a function the caller passes, so the real engine path (a `mind turn`, with its
 *   egress notice, ledger and fence) and a scripted proposer are the same shape.
 */

import { parseFrontmatter } from "../frontmatter.ts";
import { parseSoul } from "../load.ts";
import { formatIssue, type Soul } from "../schema.ts";
import type { EvalTask } from "../evals.ts";
import type { EvalAttempt } from "../eval-runs.ts";
import type { SubjectId } from "../../types.ts";
import { assertNoLeak, parseProposal, proposeMission, ROLE_BODY_SURFACE, type Dimension, type LeakSources, type Lesson, type TaskEvidence } from "./prompts.ts";

/** The text of `role.md` before its body, and the body, split the way the loader splits them; null when it does not split cleanly. */
export function splitRole(file: string, text: string): { readonly front: string; readonly body: string } | null {
  const parsed = parseFrontmatter(file, text);
  if (!parsed.ok) return null;
  const { body } = parsed.value;
  return text.endsWith(body) ? { front: text.slice(0, text.length - body.length), body } : null;
}

/** What may be asked of nobody: the phrases every task grades by, and every held-out ask. */
export function leakSources(tasks: readonly EvalTask[]): LeakSources {
  return { expect: tasks.flatMap((t) => t.expect), reject: tasks.flatMap((t) => t.reject), heldOutAsks: tasks.filter((t) => t.split === "heldout").map((t) => t.ask) };
}

/**
 * The train tasks of a base run as evidence: those that failed at least once, and those that always passed.
 * Each task's attempts are counted over both modes; the answer shown is the first failed one, else the first.
 */
export function evidenceFrom(tasks: readonly EvalTask[], rows: readonly EvalAttempt[]): { readonly failures: readonly TaskEvidence[]; readonly passes: readonly TaskEvidence[] } {
  const failures: TaskEvidence[] = [];
  const passes: TaskEvidence[] = [];
  for (const task of tasks.filter((t) => t.split === "train")) {
    const mine = rows.filter((r) => r.task === task.id);
    if (mine.length === 0) continue;
    const passed = mine.filter((r) => r.pass).length;
    const shown = mine.find((r) => !r.pass) ?? mine[0]!;
    const row: TaskEvidence = { id: task.id, kind: task.kind, ask: task.ask, answer: shown.answer ?? "(the answer was not kept)", attempts: mine.length, passed };
    (passed === mine.length ? passes : failures).push(row);
  }
  return { failures, passes };
}

export type Built = { readonly ok: true; readonly text: string; readonly body: string } | { readonly ok: false; readonly issues: readonly string[] };

/**
 * The base `role.md` with `newBody` as its body. Refused, with every reason, unless the frontmatter is the
 * base's byte for byte, the soul still loads, and name, role, prohibitions, scope and extra are unchanged.
 */
export function buildCandidate(input: { readonly roleText: string; readonly personText: string; readonly subject: SubjectId; readonly base: Soul; readonly newBody: string }): Built {
  const issues: string[] = [];
  const split = splitRole("role.md", input.roleText);
  if (split === null) return { ok: false, issues: ["the base role.md does not split into frontmatter and body; Mind will not rewrite it"] };
  // The body keeps the base's own edges: a blank line after the fence and a final newline, as the base has them.
  const body = `${split.body.startsWith("\n") ? "\n" : ""}${input.newBody.trim()}${split.body.endsWith("\n") ? "\n" : ""}`;
  const text = `${split.front}${body}`;
  if (body.split("\n").some((l) => l.trim() === "+++")) issues.push("the body has a line of +++, which is a frontmatter fence");
  const again = splitRole("role.md", text);
  if (again === null || again.front !== split.front) issues.push("the frontmatter of the candidate is not the base's, byte for byte (T4: only the body may change)");
  const loaded = parseSoul(text, input.personText, input.subject);
  if (!loaded.ok) issues.push(...loaded.issues.map(formatIssue));
  else {
    const [a, b] = [input.base.role, loaded.soul.role];
    const same = a.name === b.name && a.role === b.role && JSON.stringify(a.prohibitions) === JSON.stringify(b.prohibitions) && JSON.stringify(a.scope) === JSON.stringify(b.scope) && JSON.stringify(a.extra) === JSON.stringify(b.extra);
    if (!same) issues.push("name, role, prohibitions, scope or extra differ from the base (T4)");
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, text, body };
}

export type ProposerOutcome =
  | { readonly outcome: "edit"; readonly dimension: Dimension; readonly body: string; readonly text: string; readonly notes: string; readonly tries: number }
  | { readonly outcome: "keep-base"; readonly dimension: Dimension; readonly reason: string; readonly tries: number };

export interface AskInput {
  readonly dimension: Dimension;
  readonly mission: string;
  readonly roleText: string;
  readonly personText: string;
  readonly subject: SubjectId;
  readonly base: Soul;
  readonly sources: LeakSources;
  /** Send one prompt to the proposer; the answer, or a throw. */
  readonly ask: (prompt: string, attempt: 1 | 2) => Promise<string>;
  /** True once the brake is on: nothing more is sent. */
  readonly stopped: () => Promise<boolean>;
  /** The leak check run on every prompt before it is sent; the relaxed guard when absent. S21.7 swaps it to prove the controls are not blind. */
  readonly guard?: Guard;
}

const NOTES_MAX = 2000;

/** The retry's prompt: the same mission, then the reasons, in Mind's words. */
export function retryMission(mission: string, issues: readonly string[]): string {
  return [mission, "# YOUR PREVIOUS ANSWER WAS REFUSED", "", "Mind could not use it, for these reasons:", ...issues.map((i) => `- ${i}`), "", "Answer once more, in the OUTPUT FORMAT above, fixing every one of them, or answer KEEP_BASE. This is the last try.", ""].join("\n");
}

/** A leak check on a finished prompt: throws when it leaks. */
export type Guard = (prompt: string, sources: LeakSources) => void;

/** D-193: evidence may hold phrases the agent itself wrote; held-out asks are looked for everywhere. What a real round runs. */
export const relaxedGuard: Guard = (prompt, sources) => assertNoLeak(prompt, sources, { allowInEvidence: true });

/** S21.7 (d): no expect or reject phrase and no held-out ask anywhere, evidence included. */
export const strictGuard: Guard = (prompt, sources) => assertNoLeak(prompt, sources);

/** The mission for one dimension, leak-checked (by default in the relaxed mode, {@link relaxedGuard}). */
export function missionFor(dimension: Dimension, base: Soul, evidence: ReturnType<typeof evidenceFrom>, sources: LeakSources, guard: Guard = relaxedGuard, lessons: readonly Lesson[] = []): string {
  const mission = proposeMission({
    dimension,
    soul: { name: base.role.name, role: base.role.role, prohibitions: base.role.prohibitions, scope: { does: base.role.scope.does, does_not: base.role.scope.does_not }, body: base.role.body },
    failures: evidence.failures,
    passes: evidence.passes,
    lessons,
    surface: ROLE_BODY_SURFACE,
  });
  guard(mission, sources);
  return mission;
}

/** One dimension: ask, parse, validate; one retry with the issues; then KEEP_BASE. Returns null when the brake went on. */
export async function askProposer(input: AskInput): Promise<ProposerOutcome | null> {
  let prompt = input.mission;
  let last: readonly string[] = [];
  for (const attempt of [1, 2] as const) {
    if (await input.stopped()) return null;
    (input.guard ?? relaxedGuard)(prompt, input.sources);
    let answer: string;
    try {
      answer = await input.ask(prompt, attempt);
    } catch (cause) {
      last = [`the proposer did not answer: ${cause instanceof Error ? cause.message : String(cause)}`];
      prompt = retryMission(input.mission, last);
      continue;
    }
    if (await input.stopped()) return null;
    const parsed = parseProposal(answer, { baseBody: input.base.role.body });
    if (!parsed.ok) {
      last = parsed.issues.map(formatIssue);
    } else if (parsed.value.kind === "keep-base") {
      return { outcome: "keep-base", dimension: input.dimension, reason: parsed.value.notes.slice(0, NOTES_MAX), tries: attempt };
    } else {
      const built = buildCandidate({ roleText: input.roleText, personText: input.personText, subject: input.subject, base: input.base, newBody: parsed.value.body });
      if (built.ok) return { outcome: "edit", dimension: input.dimension, body: built.body, text: built.text, notes: parsed.value.notes.slice(0, NOTES_MAX), tries: attempt };
      last = built.issues;
    }
    prompt = retryMission(input.mission, last);
  }
  return { outcome: "keep-base", dimension: input.dimension, reason: `no usable proposal after two tries: ${last.join("; ")}`.slice(0, NOTES_MAX), tries: 2 };
}
