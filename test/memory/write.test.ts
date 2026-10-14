/** D-081 — one memory file by hand: the path stays in memory/, the text passes the scan. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMove, commitWrite, MAX_MEMORY_BYTES, memoryPathProblem, planMove, planWrite } from "../../src/memory/write.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
async function agent() {
  const dir = await mkdtemp(join(tmpdir(), "mind-mem-write-"));
  scratch.push(dir);
  await mkdir(join(dir, "memory", "notes"), { recursive: true });
  await writeFile(join(dir, "memory", "notes", "ports.md"), "# Ports\n\nvLLM 10410\nLiteLLM 10400\n");
  return dir;
}

describe("memory write", () => {
  test("which paths are memories", () => {
    for (const ok of ["memory/a.md", "memory/notes/2026-09-26-x.md", "memory/imported/owner/b_c.md"]) expect(memoryPathProblem(ok), ok).toBeUndefined();
    for (const bad of ["memory/a.txt", "soul/role.md", "memory/../soul/role.md", "memory/.hidden.md", "memory/a b.md", "/etc/x.md", "memory/", "memory/x/.git/c.md"]) expect(memoryPathProblem(bad), bad).toBeDefined();
  });

  test("new, replace with what changed, same; refused when too big, empty, or holding a credential", async () => {
    const dir = await agent();
    expect(await planWrite(dir, "memory/notes/new.md", "# New\n")).toMatchObject({ kind: "new", bytesBefore: 0, refusal: undefined });
    expect(await planWrite(dir, "memory/notes/ports.md", "# Ports\n\nvLLM 10410\nLiteLLM :10400\n")).toMatchObject({ kind: "replace", linesAdded: 1, linesRemoved: 1 });
    expect((await planWrite(dir, "memory/notes/ports.md", "# Ports\n\nvLLM 10410\nLiteLLM 10400\n")).kind).toBe("same");
    expect((await planWrite(dir, "memory/x.md", "x".repeat(MAX_MEMORY_BYTES + 1))).refusal).toContain("KB");
    expect((await planWrite(dir, "memory/x.md", "  \n")).refusal).toContain("empty");
    const secret = await planWrite(dir, "memory/x.md", `token: ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}\n`);
    expect(secret.refusal).toContain("credential");
    expect(secret.blocked.length).toBeGreaterThan(0);
  });

  test("not through a link, not over a directory; commit writes and refuses a refused plan", async () => {
    const dir = await agent();
    const outside = await mkdtemp(join(tmpdir(), "mind-outside-"));
    scratch.push(outside);
    await symlink(outside, join(dir, "memory", "out"));
    expect((await planWrite(dir, "memory/out/x.md", "# x\n")).refusal).toContain("link");
    await mkdir(join(dir, "memory", "d.md"));
    expect((await planWrite(dir, "memory/d.md", "# x\n")).refusal).toContain("not a plain file");
    const plan = await planWrite(dir, "memory/deep/new/n.md", "# n\n");
    await commitWrite(dir, plan, "# n\n");
    expect(await readFile(join(dir, "memory", "deep", "new", "n.md"), "utf8")).toBe("# n\n");
    const refused = await planWrite(dir, "soul/role.md", "x");
    await expect(commitWrite(dir, refused, "x")).rejects.toThrow();
  });
});

describe("moving a memory (D-090)", () => {
  test("to a free path: planned, then written there and gone from here; a taken path, a missing file or a credential is refused", async () => {
    const d = await mkdtemp(join(tmpdir(), "mind-move-"));
    try {
      await mkdir(join(d, "memory", "notes"), { recursive: true });
      await writeFile(join(d, "memory", "notes", "ports.md"), "# Ports\n\n30700 is a2a.\n");
      await writeFile(join(d, "memory", "notes", "other.md"), "# Other\n");
      const plan = await planMove(d, "memory/notes/ports.md", "memory/knowledge/ports.md");
      expect(plan.refusal).toBeUndefined();
      expect(plan.write.kind).toBe("new");
      await commitMove(d, plan);
      expect(await Bun.file(join(d, "memory", "knowledge", "ports.md")).text()).toBe("# Ports\n\n30700 is a2a.\n");
      expect(await Bun.file(join(d, "memory", "notes", "ports.md")).exists()).toBe(false);
      expect((await planMove(d, "memory/notes/other.md", "memory/knowledge/ports.md")).refusal).toContain("already a memory");
      expect((await planMove(d, "memory/notes/gone.md", "memory/knowledge/gone.md")).refusal).toContain("not a memory file");
      expect((await planMove(d, "memory/notes/other.md", "memory/notes/other.md")).refusal).toContain("already there");
      expect((await planMove(d, "../x.md", "memory/x.md")).refusal).toBeDefined();
      await writeFile(join(d, "memory", "notes", "leak.md"), `key ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}\n`);
      expect((await planMove(d, "memory/notes/leak.md", "memory/knowledge/leak.md")).refusal).toContain("credential");
      await expect(commitMove(d, await planMove(d, "memory/notes/gone.md", "memory/knowledge/g.md"))).rejects.toThrow();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
