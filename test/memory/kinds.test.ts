/** D-090 — memory and knowledge, told apart by the path. */

import { describe, expect, test } from "bun:test";
import { inScope, memoryKind, movedPath } from "../../src/memory/kinds.ts";

describe("memory and knowledge", () => {
  test("the kind is the path", () => {
    expect(memoryKind("memory/knowledge/manual.md")).toBe("knowledge");
    expect(memoryKind("memory/knowledge/manual/part-01.md")).toBe("knowledge");
    expect(memoryKind("memory/notes/knowledge.md")).toBe("memory");
    expect(memoryKind("memory/knowledgebase.md")).toBe("memory");
    expect(inScope("memory/knowledge/a.md", "knowledge")).toBe(true);
    expect(inScope("memory/knowledge/a.md", "memory")).toBe(false);
    expect(inScope("memory/a.md", "all")).toBe(true);
  });

  test("moving keeps the name: into knowledge/, or out of it to notes/", () => {
    expect(movedPath("memory/imported/owner/ports.md", "knowledge")).toBe("memory/knowledge/ports.md");
    expect(movedPath("memory/knowledge/deep/ports.md", "memory")).toBe("memory/notes/ports.md");
    expect(movedPath("memory/knowledge/ports.md", "knowledge")).toBe("memory/knowledge/ports.md");
    expect(movedPath("memory/notes/a.md", "memory")).toBe("memory/notes/a.md");
  });
});
