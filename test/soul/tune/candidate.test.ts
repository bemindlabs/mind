/** S21.5 — T4 as code, the evidence a proposer may see, and one dimension's ask-parse-retry loop. */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSoul } from "../../../src/soul/load.ts";
import { buildCandidate, evidenceFrom, leakSources, splitRole, askProposer } from "../../../src/soul/tune/candidate.ts";
import { SOUL, fakeRun, proposal, tasksOf, KEEP } from "../../support/tune-fixture.ts";
import { subjectId } from "../../../src/types.ts";

const subject = subjectId("example");
const roleText = await readFile(join(SOUL, "role.md"), "utf8");
const personText = await readFile(join(SOUL, "person.md"), "utf8");
const loaded = parseSoul(roleText, personText, subject);
if (!loaded.ok) throw new Error("fixture soul");
const base = loaded.soul;

describe("splitRole", () => {
  test("the frontmatter and the body, which together are the file", () => {
    const s = splitRole("role.md", roleText)!;
    expect(s.front + s.body).toBe(roleText);
    expect(s.front.endsWith("+++\n")).toBe(true);
    expect(splitRole("role.md", "no frontmatter")).toBeNull();
  });
});

describe("buildCandidate (T4)", () => {
  const build = (newBody: string, over: Partial<Parameters<typeof buildCandidate>[0]> = {}) => buildCandidate({ roleText, personText, subject, base, newBody, ...over });

  test("only the body changes: the frontmatter is the base's byte for byte, and the soul still loads", () => {
    const out = build("# New body\n\nDo the careful thing.");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [a, b] = [splitRole("role.md", roleText)!, splitRole("role.md", out.text)!];
    expect(b.front).toBe(a.front);
    expect(b.body).toBe("\n# New body\n\nDo the careful thing.\n");
    expect(parseSoul(out.text, personText, subject).ok).toBe(true);
  });

  test("a body that is a frontmatter fence, or a role.md that will not split, is refused", () => {
    const fence = build("text\n+++\nname = \"X\"\n+++\nmore");
    expect(fence.ok).toBe(false);
    if (!fence.ok) expect(fence.issues.join("\n")).toContain("line of +++");
    const broken = build("x", { roleText: "no frontmatter" });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.issues[0]).toContain("does not split");
  });

  test("a soul that would not load, or whose name or prohibitions differ from the base, is refused", () => {
    // Loads, but is a different soul than the base's: caught by the field comparison.
    const other = parseSoul(roleText.replace("Example Keeper", "Another Keeper"), personText, subject);
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const out = build("body", { base: other.soul });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.issues.join("\n")).toContain("differ from the base (T4)");
    // Person.md that does not belong to this subject: the real loader refuses.
    const wrong = build("body", { personText: personText.replace('subject = "example"', 'subject = "other"') });
    expect(wrong.ok).toBe(false);
  });
});

describe("evidenceFrom: train rows only", () => {
  test("failures and passes, one answer each, the failed one preferred; held-out rows never appear", async () => {
    const tasks = tasksOf();
    const run = await fakeRun("RULE-t5 RULE-h3", tasks, 2, "example", true, null);
    const e = evidenceFrom(tasks, run.results);
    expect(e.failures.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(e.passes.map((t) => t.id)).toEqual(["t5"]);
    expect(e.failures[0]).toMatchObject({ attempts: 4, passed: 0, answer: "nope", ask: "Question t1?" });
    expect(JSON.stringify(e)).not.toContain("h3");
    // Answers that were not kept are said so rather than invented.
    const bare = await fakeRun("", tasks, 1, "example", false, null);
    expect(evidenceFrom(tasks, bare.results).failures[0]!.answer).toContain("not kept");
    expect(evidenceFrom(tasks, []).failures).toEqual([]);
  });

  test("leakSources: every task's phrases and the held-out asks", () => {
    const s = leakSources(tasksOf());
    expect(s.expect).toContain("ok-t1");
    expect(s.reject).toContain("bad-h6");
    expect(s.heldOutAsks).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"].map((id) => `Question ${id}?`));
  });
});

describe("askProposer", () => {
  const input = (answers: (string | Error)[], stopped = async () => false) => {
    const sent: string[] = [];
    let n = 0;
    return {
      sent,
      args: { dimension: "INV" as const, mission: "MISSION\n", roleText, personText, subject, base, sources: leakSources(tasksOf()), stopped, ask: async (prompt: string) => { sent.push(prompt); const a = answers[n++]!; if (a instanceof Error) throw a; return a; } },
    };
  };

  test("a valid edit on the first try; KEEP_BASE as it is", async () => {
    const edit = input([proposal("New body.")]);
    expect(await askProposer(edit.args)).toMatchObject({ outcome: "edit", tries: 1, body: "\nNew body.\n" });
    const keep = input([KEEP]);
    expect(await askProposer(keep.args)).toMatchObject({ outcome: "keep-base", tries: 1 });
  });

  test("the retry carries the issues; a second failure is keep-base; a throw counts as a failed try", async () => {
    const retry = input(["junk", proposal("New body.")]);
    expect(await askProposer(retry.args)).toMatchObject({ outcome: "edit", tries: 2 });
    expect(retry.sent[1]).toStartWith("MISSION\n");
    expect(retry.sent[1]).toContain("- proposal: notes — a <notes> block is required");
    expect(retry.sent[1]).toContain("This is the last try.");
    const twice = input([new Error("offline"), "junk"]);
    const out = await askProposer(twice.args);
    expect(out).toMatchObject({ outcome: "keep-base", tries: 2 });
    expect(twice.sent).toHaveLength(2);
  });

  test("the brake ends it, before or after an answer, and the leak guard runs before every send", async () => {
    let calls = 0;
    expect(await askProposer(input([proposal("x")], async () => ++calls >= 1).args)).toBeNull();
    calls = 0;
    expect(await askProposer(input([proposal("x")], async () => ++calls >= 2).args)).toBeNull();
    const leaky = input([KEEP]);
    await expect(askProposer({ ...leaky.args, mission: "Question h1? is here\n" })).rejects.toThrow("held-out ask");
    expect(leaky.sent).toEqual([]);
  });
});
