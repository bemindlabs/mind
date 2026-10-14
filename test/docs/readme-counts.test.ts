/**
 * The four numbers in README's *Status* line, counted out of `.scrum/`.
 *
 * README said *"Design phase. 9 epics · ~45 stories · 4 spikes · 22 recorded
 * decisions"* on a tree holding 10 epics, 42 stories, 4 spikes and 28
 * decisions. Three of the four were wrong, and none of them had been wrong at
 * the moment they were written: a number in a README is true once and then
 * decays silently, because nothing reads it again. The badge beside it said
 * `D--001 → D--022` for the same reason, six decisions after D-022.
 *
 * The numbers stay in README rather than being replaced by a link. They tell a
 * reader the shape of the project in one line, which a link does not, and the
 * reason they were a liability was never that they existed — it was that
 * nothing checked them. This file is the thing that checks them.
 *
 * ## The side effect, stated on purpose
 *
 * Editing `.scrum/backlog.md` can now turn this suite red, and that is the
 * behaviour being bought, not a cost being tolerated: adding an epic *should*
 * stop the tree until README knows about it. So every failure here says which
 * two files disagree and which one is likely to be the stale one — a message
 * reading only "expected 42, got 43" would send somebody looking for a bug in
 * a counter.
 *
 * ## The counters, and why they are shaped this way
 *
 * Counting Markdown by text shape is how six wrong counts got into three
 * reports in one day, so each counter here is pinned to structure rather than
 * to layout, and each is exercised against synthetic input below:
 *
 * - **epics** — `### E<n>` headings inside §5. §4 is an epic *map* whose rows
 *   name the same epics; counting `E<n>` anywhere doubles them.
 * - **stories** — table rows in §5 whose **first cell** carries an `S<n>.<m>`.
 *   Not `| S`, which misses every row whose id is prefixed by a ✅ or a 🔸 and
 *   answers 27. Not `S<n>.<m>` anywhere on the line, which counts the
 *   acceptance criteria and the cross-references in the notes column.
 * - **spikes** — `### SP-<n>` headings inside §6. `SP-5` appears once in §8, in
 *   a sentence proposing that one be added; a grep for `SP-` reads that as a
 *   fifth spike, and both a recon report and a plan did.
 * - **decisions** — `## D-<nnn>` headings in `.scrum/decisions.md`.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const README = join(ROOT, "README.md");
const BACKLOG = join(ROOT, ".scrum", "backlog.md");
const DECISIONS = join(ROOT, ".scrum", "decisions.md");

/** What to do about a mismatch, in the message rather than in somebody's head. */
const ADVICE =
  "README and .scrum/ disagree. .scrum/ is the source of truth for all four numbers, " +
  "so the fix is almost always README's Status line — unless you just edited the " +
  "backlog and meant something else, in which case fix the backlog.";

/** One numbered section of the backlog, `## <n>.` to the next `## `. */
function section(text: string, number: number): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${number}.`));
  if (start === -1) return "";
  const after = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start, after === -1 ? undefined : after).join("\n");
}

/** Headings in a section that match `### <prefix><digits>`. */
function headings(text: string, prefix: string): string[] {
  const pattern = new RegExp(`^### ${prefix}(\\d+)\\b`);
  return text
    .split("\n")
    .map((line) => pattern.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${prefix}${match[1]}`);
}

/**
 * Story ids, read out of the **first cell** of each table row.
 *
 * The first cell is what a story row puts its id in; a notes cell mentioning
 * `S3.2` is a cross-reference and an acceptance-criteria row puts `AC4` there.
 * A ✅ or 🔸 sits in front of the id in that cell and is not part of it.
 */
function storyIds(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    const first = line.slice(1).split("|")[0] ?? "";
    const match = /^[^A-Za-z]*(S\d+\.\d+)\s*$/.exec(first.trim());
    if (match !== null) found.push(match[1]!);
  }
  return found;
}

/** Decision ids, as the numbers of every `## D-<nnn>` heading. */
function decisionNumbers(text: string): number[] {
  return text
    .split("\n")
    .map((line) => /^## D-(\d+)\b/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
}

/** A shields.io path segment, back into the text it renders as. */
function decodeBadge(segment: string): string {
  return decodeURIComponent(segment)
    .replaceAll("--", "\u0000")
    .replaceAll("__", "\u0001")
    .replaceAll("_", " ")
    .replaceAll("\u0000", "-")
    .replaceAll("\u0001", "_");
}

/** The four numbers README claims, from its Status section. */
function claimed(readme: string): Record<string, number> {
  const status = readme.slice(readme.indexOf("\n## Status"));
  const match =
    /(\d+) epics · (\d+) stories · (\d+) spikes · (\d+) recorded decisions/.exec(status);
  if (match === null) throw new Error("README has no Status line of the expected shape");
  return {
    epics: Number(match[1]),
    stories: Number(match[2]),
    spikes: Number(match[3]),
    decisions: Number(match[4]),
  };
}

/** The four numbers `.scrum/` holds. */
async function counted(): Promise<Record<string, number>> {
  const backlog = await readFile(BACKLOG, "utf8");
  const decisions = await readFile(DECISIONS, "utf8");
  return {
    epics: headings(section(backlog, 5), "E").length,
    stories: storyIds(section(backlog, 5)).length,
    spikes: headings(section(backlog, 6), "SP-").length,
    decisions: decisionNumbers(decisions).length,
  };
}

describe("README's numbers are counted from .scrum/, not remembered", () => {
  test("epics, stories, spikes and decisions all agree", async () => {
    const real = await counted();
    const said = claimed(await readFile(README, "utf8"));

    const wrong = Object.keys(real)
      .filter((key) => real[key] !== said[key])
      .map((key) => `${key}: README says ${said[key]}, .scrum/ holds ${real[key]}. ${ADVICE}`);
    expect(wrong).toEqual([]);

    // Control: every counter found something. Four zeroes would agree with a
    // README that also said zero, and a section heading moving would produce
    // exactly that.
    for (const [key, value] of Object.entries(real)) {
      expect(`${key}=${value > 0}`).toBe(`${key}=true`);
    }
  });

  test("the decisions badge names the last decision there is", async () => {
    const readme = await readFile(README, "utf8");
    const numbers = decisionNumbers(await readFile(DECISIONS, "utf8"));
    const last = Math.max(...numbers);

    const match = /badge\/decisions-D--(\d+)%20→%20D--(\d+)-/.exec(readme);
    expect(match === null ? "the decisions badge is missing or reshaped" : "found").toBe("found");
    const [, first, shown] = match!;

    expect(
      Number(shown) === last
        ? []
        : [
            `the decisions badge says D-${shown}, and .scrum/decisions.md ends at ` +
              `D-${String(last).padStart(3, "0")}. ${ADVICE}`,
          ],
    ).toEqual([]);
    expect(Number(first)).toBe(Math.min(...numbers));

    // Control: the decisions really are a contiguous run, which is what makes
    // "the last one" and "how many there are" the same fact. If they ever stop
    // being, the count above and this badge start measuring different things.
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });

  test("the status badge says the same word the Status section does", async () => {
    const readme = await readFile(README, "utf8");
    const match = /img\.shields\.io\/badge\/status-(.+)-(\w+)\)/.exec(readme);
    expect(match === null ? "the status badge is missing or reshaped" : "found").toBe("found");

    const word = decodeBadge(match![1]!);
    const status = readme.slice(readme.indexOf("\n## Status"));
    const opening = status.split("\n").find((line) => /^[A-Za-z]/.test(line)) ?? "";

    expect(
      opening.toLowerCase().includes(word.toLowerCase())
        ? []
        : [
            `the status badge reads "${word}" and the Status section opens "${opening}". ` +
              "The badge is the first thing a reader sees and the last thing anybody " +
              "revisits, so it is tied to the prose deliberately: change both or neither.",
          ],
    ).toEqual([]);

    // Control: the decoder is doing something. `pre--release` is one word with
    // a dash in it, not two badge fields, and a decoder that returned the
    // segment unchanged would pass the assertion above by accident on a
    // one-word status and fail confusingly on this one.
    expect(decodeBadge("pre--release")).toBe("pre-release");
    expect(decodeBadge("design%20phase")).toBe("design phase");
    expect(decodeBadge("a_b")).toBe("a b");
  });
});

describe("the counters, on shapes they must count and shapes they must not", () => {
  const synthetic = [
    "## 4. Epic map",
    "",
    "| E0 | foundations |",
    "| E1 | identity |",
    "",
    "## 5. Epics & Stories",
    "",
    "### E0 — foundations",
    "",
    "| | story | notes |",
    "|---|---|---|",
    "| 🔸 S0.1 | a thing | blocked on S9.9 |",
    "| ✅ S0.2 | another | see S0.1 |",
    "| S0.3 | a third | |",
    "| AC4 | not a story | mentions S0.3 |",
    "",
    "### E1 — identity",
    "",
    "| S1.1 | one more | |",
    "",
    "## 6. Spikes",
    "",
    "### SP-1 — first",
    "### SP-2 — second",
    "",
    "## 8. Assumptions",
    "",
    "> consider adding **SP-5** if that is worth proving first",
    "",
  ].join("\n");

  test("§4's epic map is not counted as epics", () => {
    expect(headings(section(synthetic, 5), "E")).toEqual(["E0", "E1"]);
    // Control: §4 really does name them, so the answer 2 is a filter working
    // and not an empty section.
    expect(section(synthetic, 4)).toContain("E1");
  });

  test("a story id is the first cell, tick or no tick — and an AC row is not one", () => {
    expect(storyIds(section(synthetic, 5))).toEqual(["S0.1", "S0.2", "S0.3", "S1.1"]);

    // The two ways this has been counted wrong. `| S` misses the ticked rows;
    // anywhere-on-the-line picks up the notes column and the AC row.
    const rows = section(synthetic, 5).split("\n").filter((line) => line.startsWith("|"));
    expect(rows.filter((line) => line.startsWith("| S")).length).toBe(2);
    expect(rows.filter((line) => /S\d+\.\d+/.test(line)).length).toBe(5);
  });

  test("a spike proposed in prose is not a spike", () => {
    expect(headings(section(synthetic, 6), "SP-")).toEqual(["SP-1", "SP-2"]);
    // Control: the sentence that fooled two reports is in this fixture, and §6
    // is where the counter is looking.
    expect(synthetic).toContain("SP-5");
    expect(section(synthetic, 6)).not.toContain("SP-5");
  });

  test("a decision is a heading, not a mention", () => {
    const text = [
      "# Decisions",
      "",
      "## D-001 — the first",
      "",
      "Supersedes nothing. See D-002 below, and D-999 which does not exist.",
      "",
      "## D-002 — the second",
      "",
      "`## D-003` in a code span is not a heading.",
      "",
    ].join("\n");
    expect(decisionNumbers(text)).toEqual([1, 2]);
  });
});
