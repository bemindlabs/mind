/**
 * S21.6 (D-196) — `lessons.md`: what an agent's tuning rounds taught it, kept only once its owner says so.
 *
 * A lesson is `{cue, lesson, evidence}` (D-190). The reflection step of `mind soul tune` may *propose* one
 * (kept in the tune-run record, outside git); only `mind soul tune lessons accept` writes it here, a
 * git-tracked file at the agent root beside `evals.md`, and Mind never commits it (T7). Two readers, and
 * only of what is in this file: the next tune round's proposer ({@link selectLessons}) and recall, which
 * indexes the file like a note (`src/memory/sources.ts`) inside the recall cap that already holds (D-075).
 *
 * ```
 * +++
 * schema = "mind/lessons@1"
 * +++
 *
 * ## Lesson: <cue>
 *
 * - cue: <the shape of situation>
 * - lesson: <the change to make to a role body>
 * - evidence: rows 1, 2: <the contrast in the answers>
 * - run: tn-20261020T101500Z-ab12
 * - date: 2026-10-20
 * - soul: <the base commit of the round>
 * ```
 *
 * One entry per `## ` heading, so recall cuts one piece per lesson. This file holds the format, the refusal
 * memory (D-029's shape: a refused lesson is not proposed again), the leak check run at propose and at accept
 * time (T2, I-6), and the deterministic matching rule. It reads and writes nothing of a model's.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { proposalKey } from "../decide/proposals.ts";
import { screen } from "../egress/filter.ts";
import { replaceFile } from "../task/store.ts";
import { privateDir } from "./eval-runs.ts";
import { LESSONS_FILE, one, parseLessons, type LessonEntry, type ParsedLessons } from "./lessons-format.ts";
import { assertNoLeak, type LeakSources, type Lesson } from "./tune/prompts.ts";

/** Where the owner's accept and refuse decisions live: beside the tune records, outside git, 0600. */
export { appendEntry, LESSONS_FILE, LESSONS_SCHEMA, parseLessons, renderEntry, type LessonEntry, type ParsedLessons } from "./lessons-format.ts";

/** The refusal key of a lesson: the cue and the lesson, normalised as a proposal's `what` is (D-029). */
export function lessonKey(lesson: Pick<Lesson, "cue" | "lesson">): string {
  return proposalKey(`${one(lesson.cue)}\n${one(lesson.lesson)}`);
}

export const DECISIONS_FILE = "lessons-decisions.json";
export const DECISIONS_SCHEMA = "mind/lesson-decisions@1";

/** The most characters of one lesson field kept: a lesson is a rule with its trigger, not an essay. */
export const MAX_FIELD_CHARS = 600;

/** The accepted lessons of an agent: none when there is no file; the reason when the file cannot be read as one. */
export async function readLessons(agentDir: string): Promise<ParsedLessons> {
  let text: string;
  try {
    text = await readFile(join(agentDir, LESSONS_FILE), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, entries: [], skipped: 0 };
    return { ok: false, reason: String(cause) };
  }
  return parseLessons(text);
}

/** Write the file whole or not at all, with the mode a repository file has. */
export async function writeLessonsFile(agentDir: string, text: string): Promise<string> {
  const path = join(agentDir, LESSONS_FILE);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.mind-${process.pid}.tmp`;
  await writeFile(temp, text);
  await rename(temp, path);
  return path;
}

// ---------------------------------------------------------------------------
// The guard: nothing graded, nothing personal (T2, I-6), at propose time and at accept time
// ---------------------------------------------------------------------------

/**
 * What stands in the way of a lesson, in words that never repeat the offending text (a retry prompt that
 * quoted a held-out ask would itself leak one). Empty means it may be proposed, or accepted.
 *
 * - the strict leak check of the tuner (`assertNoLeak`, no allowance for evidence): no `expect` or `reject`
 *   phrase of any task and no held-out ask;
 * - anything flagged personal: a line of `person.md` (the soul's own personal text, at least 8 characters
 *   once folded) and the shapes the egress filter knows (an e-mail address, a phone number, a national id,
 *   a card, a credential).
 */
export function lessonProblems(lesson: Pick<Lesson, "cue" | "lesson" | "evidence">, sources: LeakSources, personText: string): string[] {
  const text = [lesson.cue, lesson.lesson, lesson.evidence].join("\n");
  const problems: string[] = [];
  try {
    assertNoLeak(text, sources);
  } catch (cause) {
    const found = new Set([...String(cause instanceof Error ? cause.message : cause).matchAll(/(expect phrase|reject phrase|held-out ask) "/g)].map((m) => m[1]!));
    problems.push(`the lesson holds a ${[...found].join(" and a ") || "graded phrase"} of the task set (T2): state the pattern without it`);
  }
  const folded = fold(text);
  const personal = personText.split("\n").map((l) => fold(l)).filter((l) => [...l].length >= 8 && !l.startsWith("+++") && !/^[a-z_]+ = /.test(l));
  if (personal.some((l) => folded.includes(l))) problems.push("the lesson holds text of person.md (I-6): a lesson is the agent's working knowledge, never the person's");
  const findings = screen(text, { needles: [] });
  if (findings.length > 0) problems.push(`the lesson holds something the egress filter flags as personal or secret (${[...new Set(findings.map((f) => f.rule))].join(", ")}; I-6)`);
  for (const [name, value] of [["cue", lesson.cue], ["lesson", lesson.lesson], ["evidence", lesson.evidence]] as const) {
    if ([...one(value)].length > MAX_FIELD_CHARS) problems.push(`the ${name} is over ${MAX_FIELD_CHARS} characters: a lesson is a rule with its trigger`);
  }
  return problems;
}

const fold = (text: string): string => text.normalize("NFC").toLowerCase().replace(/[\s*_`]+/g, " ").trim();

// ---------------------------------------------------------------------------
// Decisions: accepted and refused, outside git
// ---------------------------------------------------------------------------

export interface LessonDecision {
  /** The tune run the lesson was proposed in: a round proposes at most one. */
  readonly run: string;
  readonly outcome: "accepted" | "refused";
  /** {@link lessonKey}. */
  readonly key: string;
  readonly at: string;
}

export async function readDecisions(runsDir: string): Promise<readonly LessonDecision[]> {
  try {
    const parsed = JSON.parse(await readFile(join(runsDir, DECISIONS_FILE), "utf8")) as { schema?: unknown; decisions?: unknown };
    if (parsed.schema !== DECISIONS_SCHEMA || !Array.isArray(parsed.decisions)) return [];
    return parsed.decisions.filter((d): d is LessonDecision => typeof d === "object" && d !== null && typeof (d as LessonDecision).run === "string" && typeof (d as LessonDecision).key === "string" && ((d as LessonDecision).outcome === "accepted" || (d as LessonDecision).outcome === "refused"));
  } catch {
    return [];
  }
}

export async function recordDecision(runsDir: string, decision: LessonDecision): Promise<void> {
  const before = await readDecisions(runsDir);
  await privateDir(join(runsDir, ".."));
  await privateDir(runsDir);
  await replaceFile(join(runsDir, DECISIONS_FILE), `${JSON.stringify({ schema: DECISIONS_SCHEMA, decisions: [...before, decision] }, null, 2)}\n`);
}

/** The keys the owner refused. */
export async function refusedKeys(runsDir: string): Promise<ReadonlySet<string>> {
  return new Set((await readDecisions(runsDir)).filter((d) => d.outcome === "refused").map((d) => d.key));
}

// ---------------------------------------------------------------------------
// Matching: which accepted lessons a round's proposer is shown
// ---------------------------------------------------------------------------

/** At most this many lessons, and this many characters of them in all, go into one mission. */
export const MAX_LESSONS = 3;
export const MAX_LESSON_CHARS = 1500;
/** Words this short, or this common, say nothing about a situation. */
const MIN_WORD = 3;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "when", "what", "how", "does", "from", "into", "are", "was", "has", "have", "not", "any", "all", "can", "will", "you", "your"]);

/** The words of a text: Unicode word segments (Thai included, which has no spaces), folded, short and common ones dropped. */
export function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text.normalize("NFC").toLowerCase())) {
    if (part.isWordLike !== true) continue;
    const w = part.segment;
    if ([...w].length >= MIN_WORD && !STOP.has(w)) out.add(w);
  }
  return out;
}

/**
 * The matching rule (documented in `docs/tune.md`): a lesson matches when its **cue** shares words with the
 * **asks of the train tasks that failed**. The score is the number of distinct shared words; a lesson needs
 * at least 2, or 1 when its cue has a single word. Best score first, then file order; at most
 * {@link MAX_LESSONS} lessons and {@link MAX_LESSON_CHARS} characters (a lesson that would pass the cap is
 * skipped, a smaller one after it may still fit). Lessons that fail {@link lessonProblems} now are left out
 * and counted: a hand-edited file is read with the same guard as a proposal.
 */
export function selectLessons(entries: readonly LessonEntry[], failedAsks: readonly string[], options: { readonly sources: LeakSources; readonly personText: string }): { readonly chosen: readonly LessonEntry[]; readonly considered: number; readonly refused: number } {
  const pool = new Set<string>();
  for (const ask of failedAsks) for (const w of wordsOf(ask)) pool.add(w);
  let refused = 0;
  const scored = entries.flatMap((entry, index) => {
    const cue = wordsOf(entry.cue);
    const score = [...cue].filter((w) => pool.has(w)).length;
    if (score < Math.min(2, cue.size) || score === 0) return [];
    if (lessonProblems(entry, options.sources, options.personText).length > 0) {
      refused += 1;
      return [];
    }
    return [{ entry, score, index }];
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: LessonEntry[] = [];
  let used = 0;
  for (const { entry } of scored) {
    const size = [...entry.cue].length + [...entry.lesson].length + [...entry.evidence].length;
    if (chosen.length >= MAX_LESSONS || used + size > MAX_LESSON_CHARS) continue;
    chosen.push(entry);
    used += size;
  }
  return { chosen, considered: scored.length, refused };
}

/** The part of a recall hit's text that names the lesson, for `eval --recall-only` (S21.6, T7). */
export function lessonOfHit(hit: { readonly path: string; readonly text: string }): { readonly cue: string; readonly run: string } | null {
  if (hit.path !== LESSONS_FILE) return null;
  const field = (k: string) => new RegExp(`^- ${k}: (.*)$`, "m").exec(hit.text)?.[1]?.trim() ?? "";
  const cue = field("cue");
  return cue === "" ? null : { cue, run: field("run") };
}
