/**
 * The diff shown before every write.
 *
 * What is checked here is not prettiness. It is that the diff describes the
 * two texts it was handed — so that an operator reading it before typing
 * `--apply` is reading the change that will actually happen.
 */

import { describe, expect, test } from "bun:test";
import { diffStat, unifiedDiff } from "../../src/soul/diff.ts";

describe("unifiedDiff", () => {
  test("identical texts produce nothing at all", () => {
    expect(unifiedDiff("same\n", "same\n")).toBe("");
    expect(diffStat("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
  });

  test("an append shows only added lines, with context above", () => {
    const before = "one\ntwo\nthree\n";
    const after = "one\ntwo\nthree\nfour\nfive\n";
    const diff = unifiedDiff(before, after, { beforeLabel: "a/x", afterLabel: "b/x" });

    expect(diff.split("\n")[0]).toBe("--- a/x");
    expect(diff.split("\n")[1]).toBe("+++ b/x");
    expect(diff).toContain("+four");
    expect(diff).toContain("+five");
    expect(diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"))).toEqual([]);
    expect(diffStat(before, after)).toEqual({ added: 2, removed: 0 });
  });

  test("a replacement shows both sides", () => {
    const diff = unifiedDiff("keep\nold\nkeep\n", "keep\nnew\nkeep\n");
    expect(diff).toContain("-old");
    expect(diff).toContain("+new");
    expect(diffStat("keep\nold\nkeep\n", "keep\nnew\nkeep\n")).toEqual({ added: 1, removed: 1 });
  });

  test("creating a file from nothing is all additions", () => {
    const diff = unifiedDiff("", "a\nb\n");
    expect(diff).toContain("+a");
    expect(diff).toContain("+b");
    expect(diffStat("", "a\nb\n").removed).toBe(0);
  });

  test("the hunk header counts the lines it actually prints", () => {
    const diff = unifiedDiff("a\nb\nc\nd\ne\nf\n", "a\nb\nc\nd\ne\nZ\n");
    const header = diff.split("\n").find((line) => line.startsWith("@@"))!;
    const [, oldCount, newCount] = header.match(/@@ -\d+,(\d+) \+\d+,(\d+) @@/)!;

    const body = diff.split("\n").slice(3);
    expect(body.filter((l) => !l.startsWith("+")).length).toBe(Number(oldCount));
    expect(body.filter((l) => !l.startsWith("-")).length).toBe(Number(newCount));
  });

  test("a change too large to diff line by line says so instead of hanging", () => {
    const before = Array.from({ length: 900 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 900 }, (_, i) => `new ${i}`).join("\n");
    const diff = unifiedDiff(before, after);

    expect(diff).toContain("too large to diff line by line");
    expect(diffStat(before, after)).toEqual({ added: 900, removed: 900 });
  });

  test("context is bounded by the option, not by the file size", () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const after = `${before}\nadded`;
    const diff = unifiedDiff(before, after, { context: 1 });

    const context = diff.split("\n").filter((line) => line.startsWith(" "));
    expect(context.length).toBeLessThanOrEqual(2);
  });
});
