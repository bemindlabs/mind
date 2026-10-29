/** S21.6 (T7, D-196): lessons.md is indexed by recall on purpose, only what the owner accepted, inside the same cap. */

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachWithin, DEFAULT_RECALL_CHARS, RECALL_HITS } from "../../src/memory/attach.ts";
import { indexAgent, recall } from "../../src/memory/recall.ts";
import { readMemory } from "../../src/memory/sources.ts";
import { appendEntry, lessonOfHit, type LessonEntry } from "../../src/soul/lessons.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("alpha");
const NO_VECTORS = { reason: "no vector store in this test" };
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const entry = (over: Partial<LessonEntry> = {}): LessonEntry => ({ cue: "A question about restarting the gateway after a deploy", lesson: "Check the unit's status before restarting it, and name the unit.", evidence: "rows 1: t1 passed once the check was named", run: "tn-20261020T101500Z-ab12", date: "2026-10-20", soul: "a".repeat(40), ...over });

async function agent(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-lessons-recall-"));
  dirs.push(dir);
  await mkdir(join(dir, "memory"), { recursive: true });
  for (const [rel, text] of Object.entries(files)) await Bun.write(join(dir, rel), text);
  return dir;
}
const index = (dir: string) => indexAgent(dir, SUBJECT, NO_VECTORS, { markerDir: join(dir, ".marker"), now: () => new Date() });

test("lessons.md at the agent root is read by recall, one piece per accepted lesson, named by its cue", async () => {
  const dir = await agent({ "memory/note.md": "# Note\n\nThe gateway listens on 10410.\n", "lessons.md": appendEntry(appendEntry(null, entry()), entry({ cue: "A report with no date", lesson: "Date it first.", run: "tn-20261021T101500Z-cd34" })) });
  const sources = await readMemory(dir);
  expect(sources.files).toEqual(["memory/note.md", "lessons.md"]);
  const lessons = sources.chunks.filter((c) => c.path === "lessons.md");
  expect(lessons.map((c) => c.heading)).toEqual(["Lesson: A question about restarting the gateway after a deploy", "Lesson: A report with no date"]);
  expect(lessons[0]!.text).toContain("- lesson: Check the unit's status before restarting it, and name the unit.");
  // Stable ids across rebuilds, as every piece has.
  expect((await readMemory(dir)).chunks.map((c) => c.id)).toEqual(sources.chunks.map((c) => c.id));
  // The front matter is not a piece.
  expect(sources.chunks.some((c) => c.text.includes("mind/lessons@1"))).toBe(false);
});

test("a lesson whose cue matches reaches a turn through recall; a lesson only proposed (not in lessons.md) does not exist for it", async () => {
  const dir = await agent({ "lessons.md": appendEntry(null, entry()) });
  expect((await index(dir)).files).toBe(1);
  const found = await recall(dir, SUBJECT, "How do I restart the gateway after the deploy?", RECALL_HITS, NO_VECTORS, undefined, "any");
  expect(found.hits.map((h) => h.path)).toEqual(["lessons.md"]);
  expect(lessonOfHit(found.hits[0]!)).toEqual({ cue: entry().cue, run: entry().run });
  // No lessons.md: nothing of a lesson is there, whatever the tune records hold.
  const bare = await agent({ "memory/note.md": "# Note\n\nSomething else.\n" });
  await index(bare);
  expect((await recall(bare, SUBJECT, "restart the gateway after the deploy", RECALL_HITS, NO_VECTORS, undefined, "any")).hits).toEqual([]);
});

test("the recall cap (D-075) is unchanged and a lesson is inside it: whole pieces, best first, up to the ceiling", async () => {
  expect(DEFAULT_RECALL_CHARS).toBe(4500);
  expect(RECALL_HITS).toBe(12);
  const dir = await agent({ "memory/a.md": `# A\n\n${"gateway deploy restart ".repeat(150)}\n`, "lessons.md": appendEntry(null, entry()) });
  await index(dir);
  const found = await recall(dir, SUBJECT, "restart the gateway after the deploy", RECALL_HITS, NO_VECTORS, undefined, "any");
  const attachment = attachWithin(found.hits, 600);
  expect(attachment.chars).toBeLessThanOrEqual(600);
  expect(attachment.attached.map((a) => a.path)).toContain("lessons.md");
  expect(attachment.skipped).toBeGreaterThan(0);
});

test("a lessons.md that is not a lessons file is reported unreadable and indexes nothing", async () => {
  const dir = await agent({ "lessons.md": "my own notes about lessons\n" });
  const sources = await readMemory(dir);
  expect(sources.chunks).toEqual([]);
  expect(sources.unreadable).toEqual([{ path: "lessons.md", reason: expect.stringContaining("frontmatter") }]);
});
