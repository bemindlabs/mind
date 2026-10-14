/** D-070 — the page's markdown: a tree first, then elements, never HTML. */

import { describe, expect, test } from "bun:test";
import { MARKDOWN_JS } from "../../src/web/markdown.ts";
import { PAGE_HTML } from "../../src/web/page.ts";

type Node = { t: string; v?: string; c?: Node[]; href?: string; level?: number; lang?: string; items?: { depth: number; ordered: boolean; c: Node[] }[]; head?: Node[][]; rows?: Node[][][] };
const { mdTree, mdInline } = new Function(`${MARKDOWN_JS}; return { mdTree, mdInline };`)() as {
  mdTree: (text: string) => Node[];
  mdInline: (text: string) => Node[];
};

describe("markdown on the page", () => {
  test("inline: code, bold, italic, links — and snake_case and 2*3*4 stay text", () => {
    expect(mdInline("run `ls -la` **now** and *soon*")).toEqual([
      { t: "text", v: "run " }, { t: "code", v: "ls -la" }, { t: "text", v: " " },
      { t: "strong", c: [{ t: "text", v: "now" }] }, { t: "text", v: " and " }, { t: "em", c: [{ t: "text", v: "soon" }] },
    ]);
    expect(mdInline("file_name_here and 2*3*4")).toEqual([{ t: "text", v: "file_name_here and 2*3*4" }]);
    expect(mdInline("[docs](https://a.example/x) and https://b.example/y.")).toEqual([
      { t: "a", href: "https://a.example/x", c: [{ t: "text", v: "docs" }] }, { t: "text", v: " and " },
      { t: "a", href: "https://b.example/y", c: [{ t: "text", v: "https://b.example/y" }] }, { t: "text", v: "." },
    ]);
  });

  test("a link that is not http(s) stays text", () => {
    for (const bad of ["[x](javascript:alert(1))", "[x](file:///etc/passwd)", "[x](data:text/html,hi)"]) {
      const out = mdInline(bad);
      expect(out.every((n) => n.t === "text"), bad).toBe(true);
      expect(out.map((n) => n.v).join(""), bad).toBe(bad);
    }
  });

  test("blocks: front matter, heading, list with nesting, code, quote, rule, table, paragraph", () => {
    const tree = mdTree("---\nname: x\n---\n# Title\n\n- one\n  - one.a\n- two\n\n1. first\n\n```sh\necho hi\n```\n> quoted\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nplain\nnext line");
    expect(tree.map((n) => n.t)).toEqual(["meta", "h", "list", "list", "pre", "quote", "hr", "table", "p"]);
    expect(tree[0]!.v).toBe("name: x");
    expect(tree[2]!.items!.map((i) => i.depth)).toEqual([0, 1, 0]);
    expect(tree[3]!.items![0]!.ordered).toBe(true);
    expect(tree[4]).toEqual({ t: "pre", lang: "sh", v: "echo hi" });
    expect(tree[7]!.rows!.length).toBe(1);
    expect(tree[8]).toEqual({ t: "p", c: [{ t: "text", v: "plain\nnext line" }] });
  });

  test("HTML in the text is text: nothing on the page ever assigns innerHTML", () => {
    expect(mdTree("<script>alert(1)</script>")).toEqual([{ t: "p", c: [{ t: "text", v: "<script>alert(1)</script>" }] }]);
    expect(MARKDOWN_JS).not.toContain("innerHTML");
    expect(PAGE_HTML).not.toContain("innerHTML");
    expect(PAGE_HTML).toContain("function mdTree(");
  });

  test("an unclosed fence runs to the end instead of swallowing nothing", () => {
    expect(mdTree("```\ncode\nmore")).toEqual([{ t: "pre", lang: "", v: "code\nmore" }]);
  });
});
