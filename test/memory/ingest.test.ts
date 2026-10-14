/**
 * S4.2 — the owner's notes into the agent's memory/, through the guard's own
 * scanner first (D-040).
 *
 * The case that matters most is the file that is *not* copied: it measured on
 * the real source, where four of seventy-five files carried a credential that
 * a search for vendor prefixes had missed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitIngest,
  formatIngestPlan,
  importedPath,
  importName,
  planIngest,
} from "../../src/memory/ingest.ts";
import { readMemory, summaryProse } from "../../src/memory/sources.ts";
import { SUMMARY_SCHEMA, type ActionsSummary } from "../../src/observer/actions.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mind-ingest-"));
  scratch.push(d);
  return d;
}

const SECRET = "hunter22-not-a-real-one";

async function source(): Promise<string> {
  const d = await dir();
  await Bun.write(join(d, "infra.md"), "# Ports\n\ndashboard on 30600\n");
  await Bun.write(join(d, "MEMORY.md"), "- [infra](infra.md)\n");
  await Bun.write(join(d, "creds.md"), `# DB\n\npostgres://app:${SECRET}@db.invalid/main\n`);
  await Bun.write(join(d, "notes.txt"), "not markdown");
  await mkdir(join(d, "workspaces", "x"), { recursive: true });
  await Bun.write(join(d, "workspaces", "x", "CLAUDE.md"), "another tool's context");
  await symlink(join(d, "infra.md"), join(d, "link.md"));
  return d;
}

describe("planIngest", () => {
  test("top-level markdown only; the credential file is blocked and never copied", async () => {
    const src = await source();
    const agent = await dir();
    const plan = await planIngest(src, agent, "owner");

    expect(plan.target).toBe("memory/imported/owner");
    expect(plan.copy.map((c) => c.path)).toEqual([
      "memory/imported/owner/MEMORY.md",
      "memory/imported/owner/infra.md",
    ]);
    expect(plan.blocked.map((f) => `${f.path}:${f.line} ${f.rule}`)).toEqual([
      "memory/imported/owner/creds.md:3 url-credentials",
    ]);
    expect(plan.ignored.join(" ")).toContain("workspaces — a directory");
    expect(plan.ignored.join(" ")).toContain("link.md — a link");
    expect(plan.ignored.join(" ")).toContain("notes.txt — not a .md file");

    // The plan as printed never carries the secret.
    expect(formatIngestPlan(plan).join("\n")).not.toContain(SECRET);

    // And planning wrote nothing.
    expect(await readdir(agent)).toEqual([]);
  });

  test("commit writes the plan and nothing else; a second plan sees it unchanged", async () => {
    const src = await source();
    const agent = await dir();
    const done = await commitIngest(await planIngest(src, agent, "owner"));
    expect(done).toEqual({ written: 2, removed: 0 });
    expect((await readdir(join(agent, importedPath("owner")))).sort()).toEqual(["MEMORY.md", "infra.md"]);

    const again = await planIngest(src, agent, "owner");
    expect(again.copy).toEqual([]);
    expect(again.unchanged).toBe(2);
  });

  test("a mirror: changed files are rewritten, and a file gone from the source is removed", async () => {
    const src = await source();
    const agent = await dir();
    await commitIngest(await planIngest(src, agent, "owner"));

    await Bun.write(join(src, "infra.md"), "# Ports\n\ndashboard on 30601\n");
    await rm(join(src, "MEMORY.md"));
    const plan = await planIngest(src, agent, "owner");
    expect(plan.copy.map((c) => `${c.change} ${c.path}`)).toEqual(["changed memory/imported/owner/infra.md"]);
    expect(plan.remove).toEqual(["memory/imported/owner/MEMORY.md"]);
    expect(formatIngestPlan(plan)[0]).toContain("1 changed");

    await commitIngest(plan);
    expect(await readdir(join(agent, importedPath("owner")))).toEqual(["infra.md"]);
    expect(await Bun.file(join(agent, importedPath("owner"), "infra.md")).text()).toContain("30601");
  });

  test("a name that could leave the directory is refused", async () => {
    await expect(planIngest(await dir(), await dir(), "../x")).rejects.toThrow("cannot name an import");
  });

  test("importName makes a directory name, or nothing", () => {
    expect(importName("-home-bmt")).toBe("home-bmt");
    expect(importName("Memory Notes")).toBe("memory-notes");
    expect(importName("...")).toBeUndefined();
  });

  test("what was ingested is what readMemory reads", async () => {
    const src = await source();
    const agent = await dir();
    await commitIngest(await planIngest(src, agent, "owner"));
    const read = await readMemory(agent);
    expect(read.files).toEqual(["memory/imported/owner/MEMORY.md", "memory/imported/owner/infra.md"]);
  });
});

describe("the action summary as a piece of recall", () => {
  const summary = (over: Partial<ActionsSummary> = {}): ActionsSummary => ({
    schema: SUMMARY_SCHEMA,
    at: "2026-09-23",
    generator: "test",
    months: ["2026-09"],
    uncounted: 0,
    counts: {
      "2026-09": {
        records: 40,
        kind: { command: 30, "file-edit": 10, tool: 0 },
        outcome: { ok: 38, failed: 2, unknown: 0 },
        origin: {},
        vendor: {},
        tool: {},
        program: { git: 12, bun: 9, other: 50, docker: 3 },
      },
    },
    notes: [],
    limits: [],
    ...over,
  });

  test("one line per month, words from Mind's vocabulary and numbers only", () => {
    const text = summaryProse(summary());
    expect(text).toContain("2026-09: 40 captured action(s)");
    expect(text).toContain("most-run programs: git 12, bun 9, docker 3");
    expect(text).toContain("outcomes: ok 38, failed 2");
    expect(text).not.toContain("other");
  });

  test("a key typed in by hand that is not in the vocabulary never comes out", () => {
    const edited = summary();
    const month = edited.counts["2026-09"]!;
    const text = summaryProse({
      ...edited,
      months: ["2026-09", "/home/owner/secret-project"],
      counts: {
        "2026-09": { ...month, program: { ...month.program, "/home/owner/secret-project": 99 } },
      },
    });
    expect(text).not.toContain("secret-project");
  });

  test("nothing counted is no piece at all", () => {
    expect(summaryProse(summary({ months: [] }))).toBe("");
  });

  test("readMemory adds it as one piece, and reports a summary it cannot read", async () => {
    const agent = await dir();
    await mkdir(join(agent, "actions"), { recursive: true });
    await Bun.write(join(agent, "actions", "summary.json"), JSON.stringify(summary()));
    const read = await readMemory(agent);
    expect(read.chunks.map((c) => c.path)).toEqual(["actions/summary.json"]);
    expect(read.chunks[0]?.heading).toBe("How the owner works");

    await Bun.write(join(agent, "actions", "summary.json"), "{ broken");
    expect((await readMemory(agent)).unreadable.map((u) => u.path)).toEqual(["actions/summary.json"]);
  });
});
