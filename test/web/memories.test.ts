/** D-068 — the page reads memory/ and nothing else. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMemories, memoryGraph, memoryLinks, memoryMeta, readMemoryFile, whoMentions } from "../../src/web/memories.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function agent() {
  const dir = await mkdtemp(join(tmpdir(), "mind-web-mem-"));
  scratch.push(dir);
  await mkdir(join(dir, "memory", "imported", "owner"), { recursive: true });
  await mkdir(join(dir, "soul"), { recursive: true });
  await writeFile(join(dir, "soul", "person.md"), "secret person");
  await writeFile(join(dir, "memory", "imported", "owner", "ports.md"), "---\nname: ports\ndescription: which port is which\nmetadata:\n  type: reference\n---\n\nbody\n");
  await writeFile(join(dir, "memory", "notes.md"), "# Server notes\n\nThe first paragraph says what it is.\n");
  await writeFile(join(dir, "memory", "skip.txt"), "not markdown");
  return dir;
}

describe("memories on the page", () => {
  test("front matter, else the first heading and paragraph, else the name", () => {
    expect(memoryMeta("memory/x.md", "---\nname: n\ndescription: \"d\"\nmetadata:\n  type: user\n---\nb")).toEqual({ title: "n", description: "d", type: "user" });
    expect(memoryMeta("memory/x.md", "# Head\n\npara one\n\npara two")).toEqual({ title: "Head", description: "para one", type: "" });
    expect(memoryMeta("memory/dir/plain.md", "just text")).toEqual({ title: "plain", description: "just text", type: "" });
  });

  test("lists .md under memory/ in path order; reads one", async () => {
    const dir = await agent();
    const list = await listMemories(dir);
    expect(list.map((m) => m.path)).toEqual(["memory/imported/owner/ports.md", "memory/notes.md"]);
    expect(list[0]).toMatchObject({ title: "ports", description: "which port is which", type: "reference" });
    expect(await readMemoryFile(dir, "memory/notes.md")).toEqual({ ok: true, text: "# Server notes\n\nThe first paragraph says what it is.\n" });
    expect(await listMemories(join(dir, "nowhere"))).toEqual([]);
  });

  test("nothing outside memory/: not ../, not another folder, not a link out, not a non-.md", async () => {
    const dir = await agent();
    await symlink(join(dir, "soul", "person.md"), join(dir, "memory", "link.md"));
    await symlink(join(dir, "soul"), join(dir, "memory", "soullink"));
    await symlink(join(dir, "soul", "person.md"), join(dir, "soul", "p2.md"));
    for (const path of ["memory/../soul/person.md", "soul/person.md", "memory/link.md", "memory/soullink/p2.md", "memory/skip.txt", "/etc/passwd", "memory/./notes.md", "memory/missing.md", ""]) {
      const read = await readMemoryFile(dir, path);
      expect(read.ok, path).toBe(false);
    }
    expect((await listMemories(dir)).map((m) => m.path)).not.toContain("memory/link.md");
  });
});

describe("the memory map (D-082)", () => {
  test("wiki names and relative .md links, not web links", () => {
    expect(memoryLinks("see [[ports]] and [[Server notes|notes]] and [[a#h]]; [x](../y.md) [z](memory/z.md#top) [w](https://e.com/w.md)")).toEqual({
      names: ["ports", "Server notes", "a"],
      files: ["../y.md", "memory/z.md"],
    });
  });

  test("a neuron per file, one synapse per linked pair, broken links counted", async () => {
    const dir = await agent();
    await writeFile(join(dir, "memory", "notes.md"), "# Server notes\n\nSee [[ports]] and [[ports]] again, [[nowhere]], and [it](imported/owner/ports.md).\n");
    await writeFile(join(dir, "memory", "imported", "owner", "back.md"), "---\nname: back\n---\nBack to [[Server notes]] and [up](../../notes.md) and [[back]].\n");
    const g = await memoryGraph(dir);
    expect(g.nodes.map((n) => n.path)).toEqual(["memory/imported/owner/back.md", "memory/imported/owner/ports.md", "memory/notes.md"]);
    expect(g.nodes[1]).toEqual({ path: "memory/imported/owner/ports.md", title: "ports", type: "reference", bytes: expect.any(Number), kind: "memory", tags: [] });
    expect([...g.edges].sort()).toEqual([[0, 2, 2], [1, 2, 3]]);
    expect(g.dangling).toBe(1);
    expect(await memoryGraph(join(dir, "nowhere"))).toEqual({ nodes: [], edges: [], dangling: 0, entities: [], mentions: [] });
  });
});

describe("the things memories share (D-092)", () => {
  test("the graph keeps what two memories mention; who finds a port however it is asked, and the line", async () => {
    const dir = await agent();
    await writeFile(join(dir, "memory", "notes.md"), "# Server notes\n\nvLLM listens on 127.0.0.1:10410.\nThe web is mind-web-om.service.\n");
    await writeFile(join(dir, "memory", "imported", "owner", "ports.md"), "---\nname: ports\n---\nLiteLLM is port 10400; never call :10410 directly.\n");
    const g = await memoryGraph(dir);
    expect(g.entities).toEqual([{ type: "port", value: "10410", count: 2 }]);
    expect(g.mentions.map(([e, n]) => [g.entities[e]!.value, g.nodes[n]!.path])).toEqual([["10410", "memory/imported/owner/ports.md"], ["10410", "memory/notes.md"]]);
    for (const ask of ["10410", "port 10410", ":10410"]) {
      const who = await whoMentions(dir, ask);
      expect(who).toHaveLength(1);
      expect(who[0]!.mentions.map((m) => `${m.path}:${m.line}`)).toEqual(["memory/imported/owner/ports.md:4", "memory/notes.md:3"]);
    }
    expect((await whoMentions(dir, "web-om"))[0]).toMatchObject({ type: "service", value: "mind-web-om.service" });
    expect(await whoMentions(dir, "ab")).toEqual([]);
    expect(await whoMentions(dir, "  ")).toEqual([]);
  });
});
