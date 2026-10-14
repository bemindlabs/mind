/** D-091 — collections are the tags in a memory's front matter. */

import { describe, expect, test } from "bun:test";
import { MAX_TAGS, normalizeTag, tagsOf, withTags } from "../../src/memory/tags.ts";

describe("collections", () => {
  test("a tag is kept lower case, with Thai, digits, - and _", () => {
    expect(normalizeTag("  #Infra Ops ")).toBe("infra-ops");
    expect(normalizeTag("เซิร์ฟเวอร์")).toBe("เซิร์ฟเวอร์");
    expect(normalizeTag("a/b;c")).toBe("abc");
    expect(normalizeTag("x".repeat(40))).toHaveLength(30);
  });

  test("read inline, comma and block lists; none without front matter", () => {
    expect(tagsOf("---\nname: a\ntags: [Infra, ports, infra]\n---\nbody")).toEqual(["infra", "ports"]);
    expect(tagsOf("---\ntags: infra, \"agents\"\n---\n")).toEqual(["infra", "agents"]);
    expect(tagsOf("---\ntags:\n  - infra\n  - ports\nmetadata:\n  type: x\n---\n")).toEqual(["infra", "ports"]);
    expect(tagsOf("---\nname: a\n---\n")).toEqual([]);
    expect(tagsOf("# no front matter\ntags: [x]")).toEqual([]);
    expect(tagsOf(`---\ntags: [${Array.from({ length: 20 }, (_, i) => `t${i}`).join(",")}]\n---\n`)).toHaveLength(MAX_TAGS);
  });

  test("written back in place, after the description, or with new front matter; removed when empty", () => {
    expect(withTags("---\nname: a\ndescription: d\nmetadata:\n  type: x\n---\n\nbody\n", ["Infra"])).toBe("---\nname: a\ndescription: d\ntags: [infra]\nmetadata:\n  type: x\n---\n\nbody\n");
    expect(withTags("---\nname: a\ntags:\n  - old\n  - older\nmetadata:\n  type: x\n---\nbody", ["new"])).toBe("---\nname: a\ntags: [new]\nmetadata:\n  type: x\n---\nbody");
    expect(withTags("---\nname: a\ntags: [x]\n---\nbody", [])).toBe("---\nname: a\n---\nbody");
    expect(withTags("# Plain\n\nbody\n", ["a", "b"])).toBe("---\ntags: [a, b]\n---\n\n# Plain\n\nbody\n");
    expect(withTags("# Plain\n", [])).toBe("# Plain\n");
    expect(withTags("---\nname: a\n---\nbody", ["z"])).toBe("---\nname: a\ntags: [z]\n---\nbody");
  });
});
