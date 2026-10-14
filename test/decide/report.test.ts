/** S5.2 AC4 — what a turn allowed to act changed, said before it ends (D-043). */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSnapshots, formatTreeChange, REPORT_LIMITS, snapshotTree } from "../../src/decide/report.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tree(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mind-report-"));
  scratch.push(d);
  await Bun.write(join(d, "keep.txt"), "same");
  await Bun.write(join(d, "edit.txt"), "before");
  await Bun.write(join(d, "gone.txt"), "bye");
  await mkdir(join(d, ".git"), { recursive: true });
  await Bun.write(join(d, ".git", "index"), "x");
  await mkdir(join(d, "node_modules", "p"), { recursive: true });
  await Bun.write(join(d, "node_modules", "p", "a.js"), "x");
  return d;
}

describe("snapshots", () => {
  test("added, changed and removed, with .git and node_modules never walked", async () => {
    const d = await tree();
    const before = await snapshotTree(d);
    expect([...before!.keys()].sort()).toEqual(["edit.txt", "gone.txt", "keep.txt"]);

    await Bun.write(join(d, "edit.txt"), "after, and longer");
    await rm(join(d, "gone.txt"));
    await mkdir(join(d, "sub"), { recursive: true });
    await Bun.write(join(d, "sub", "new.txt"), "hi");
    await Bun.write(join(d, ".git", "index"), "changed by git");
    await symlink(join(d, "keep.txt"), join(d, "link"));

    expect(diffSnapshots(before, await snapshotTree(d))).toEqual({
      added: ["link", "sub/new.txt"],
      changed: ["edit.txt"],
      removed: ["gone.txt"],
    });
  });

  test("the same size and mtime is invisible — which is why the limits say so", async () => {
    const d = await tree();
    const before = await snapshotTree(d);
    const when = new Date("2026-01-01T00:00:00Z");
    await utimes(join(d, "keep.txt"), when, when);
    const stamped = await snapshotTree(d);
    await Bun.write(join(d, "keep.txt"), "SAME");
    await utimes(join(d, "keep.txt"), when, when);
    expect(diffSnapshots(stamped, await snapshotTree(d))).toEqual({ added: [], changed: [], removed: [] });
    expect(diffSnapshots(before, stamped)!.changed).toEqual(["keep.txt"]);
    expect(REPORT_LIMITS.join(" ")).toContain("changed back within the turn");
  });

  test("over the cap is not measured — never reported as nothing", async () => {
    const d = await tree();
    expect(await snapshotTree(d, 2)).toBeNull();
    expect(diffSnapshots(null, await snapshotTree(d))).toBeNull();
    expect(formatTreeChange(d, null)[0]).toContain("NOT MEASURED");
  });
});

describe("formatTreeChange", () => {
  test("nothing changed is said, not left silent", () => {
    expect(formatTreeChange("/w", { added: [], changed: [], removed: [] })[0]).toBe("what this turn changed in /w: nothing");
  });

  test("marks each kind, cuts long lists, and ends with what it cannot see", () => {
    const many = Array.from({ length: 5 }, (_, i) => `f${i}`);
    const lines = formatTreeChange("/w", { added: many, changed: ["c"], removed: ["r"] }, 2);
    expect(lines[0]).toBe("what this turn changed in /w: 5 added · 1 changed · 1 removed");
    expect(lines).toContain("  + f0");
    expect(lines).toContain("  + … and 3 more");
    expect(lines).toContain("  ~ c");
    expect(lines).toContain("  - r");
    expect(lines.at(-1)).toContain("not seen by this report");
  });
});
