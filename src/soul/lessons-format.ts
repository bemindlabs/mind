/**
 * The format of `lessons.md` (S21.6, D-196): front matter `schema = "mind/lessons@1"` and one `## Lesson: <cue>` entry
 * per lesson. Pure and light: recall's source reader (`src/memory/sources.ts`) imports it, and `lessons.ts` (the
 * refusal memory, the guard, the matching rule) builds on it. See `lessons.ts` for what the file is for.
 */

import { parseFrontmatter } from "./frontmatter.ts";
import type { Lesson } from "./tune/prompts.ts";


export const LESSONS_FILE = "lessons.md";
export const LESSONS_SCHEMA = "mind/lessons@1";

/** One accepted lesson, as `lessons.md` holds it. */
export interface LessonEntry extends Lesson {
  /** The tune run it came out of. */
  readonly run: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** The base commit of that round. */
  readonly soul: string;
}

/** One line: runs of whitespace are one space. */
export const one = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The heading of an entry: short, so a recall hit names its cue. */
export function lessonHeading(entry: LessonEntry): string {
  const cue = one(entry.cue);
  return `Lesson: ${cue.length > 80 ? `${[...cue].slice(0, 79).join("")}…` : cue}`;
}

/** One entry as written, without a leading blank line. */
export function renderEntry(entry: LessonEntry): string {
  return [`## ${lessonHeading(entry)}`, "", `- cue: ${one(entry.cue)}`, `- lesson: ${one(entry.lesson)}`, `- evidence: ${one(entry.evidence)}`, `- run: ${entry.run}`, `- date: ${entry.date}`, `- soul: ${entry.soul}`, ""].join("\n");
}

const HEAD = `+++\nschema = "${LESSONS_SCHEMA}"\n+++\n`;

/** The file with `entry` appended; a new file when `existing` is null. Pure. */
export function appendEntry(existing: string | null, entry: LessonEntry): string {
  const base = existing === null || existing.trim() === "" ? `${HEAD}\n` : existing.endsWith("\n") ? existing : `${existing}\n`;
  return `${base}${base.endsWith("\n\n") ? "" : "\n"}${renderEntry(entry)}`;
}

export type ParsedLessons = { readonly ok: true; readonly entries: readonly LessonEntry[]; readonly skipped: number } | { readonly ok: false; readonly reason: string };

const FIELD = /^- (cue|lesson|evidence|run|date|soul): (.*)$/;

/** Read `lessons.md`. An entry that is not complete is skipped and counted, never half-read. */
export function parseLessons(text: string): ParsedLessons {
  const front = parseFrontmatter(LESSONS_FILE, text);
  if (!front.ok) return { ok: false, reason: front.issues.map((i) => i.message).join("; ") };
  const schema = front.value.doc.table["schema"];
  if (schema !== LESSONS_SCHEMA) return { ok: false, reason: `schema must be ${JSON.stringify(LESSONS_SCHEMA)}, not ${JSON.stringify(schema)}` };
  const entries: LessonEntry[] = [];
  let skipped = 0;
  for (const part of `\n${front.value.body}`.split(/\n(?=## )/).filter((p) => p.startsWith("## ") || p.startsWith("\n## "))) {
    const fields = new Map<string, string>();
    for (const line of part.split("\n")) {
      const m = FIELD.exec(line);
      if (m !== null && !fields.has(m[1]!)) fields.set(m[1]!, m[2]!.trim());
    }
    const [cue, lesson, evidence, run, date, soul] = ["cue", "lesson", "evidence", "run", "date", "soul"].map((k) => fields.get(k) ?? "");
    if ([cue, lesson, evidence, run, date, soul].some((v) => v === "")) skipped += 1;
    else entries.push({ cue: cue!, lesson: lesson!, evidence: evidence!, run: run!, date: date!, soul: soul! });
  }
  return { ok: true, entries, skipped };
}

