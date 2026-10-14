/**
 * Frontmatter splitting, and the line numbers AC4 promises.
 *
 * The syntax-error case is the interesting one. `Bun.TOML.parse` on bun 1.4.2
 * reports the *call site* rather than the position in the TOML, so the line in
 * a syntax-error issue is derived here, by prefix-parsing. That makes it
 * deterministic enough to assert exactly — while still being flagged
 * `approximate`, because a prefix can also fail for being a prefix.
 */

import { describe, expect, test } from "bun:test";
import { parseFrontmatter, parseTomlDocument } from "../../src/soul/frontmatter.ts";

describe("parseFrontmatter", () => {
  test("splits the first +++ pair and keeps the body byte-identical", () => {
    const body = "# Title\n\nSome text with a stray +++ marker inside it.\n";
    const text = `+++\nname = "x"\n+++\n${body}`;

    const parsed = parseFrontmatter("role.md", text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.doc.table["name"]).toBe("x");
    expect(parsed.value.body).toBe(body);
    expect(parsed.value.closeLine).toBe(3);
  });

  test("a later +++ on its own line does not reopen the frontmatter", () => {
    const text = '+++\nname = "x"\n+++\nbody\n+++\nstill body\n';
    const parsed = parseFrontmatter("role.md", text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.body).toBe("body\n+++\nstill body\n");
  });

  test("rejects a file that does not open with the fence", () => {
    const parsed = parseFrontmatter("role.md", '# Title\n\nname = "x"\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.line).toBe(1);
    expect(parsed.issues[0]?.message).toContain("+++");
  });

  test("rejects an unterminated fence", () => {
    const parsed = parseFrontmatter("role.md", '+++\nname = "x"\n');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.message).toContain("unterminated");
  });

  test("a CRLF body survives the round trip through split/join", () => {
    const text = '+++\r\nname = "x"\r\n+++\r\nline one\r\nline two\r\n';
    const parsed = parseFrontmatter("role.md", text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.body).toBe("line one\r\nline two\r\n");
  });
});

describe("line numbers", () => {
  test("a TOML syntax error is blamed on the right line, and marked approximate", () => {
    const text = '+++\na = 1\nb = = 2\nc = 3\n+++\nbody\n';
    const parsed = parseFrontmatter("role.md", text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    const issue = parsed.issues[0]!;
    expect(issue.line).toBe(3);
    expect(issue.approximate).toBe(true);
    // Inside the frontmatter, never pointing at the body.
    expect(issue.line).toBeGreaterThan(1);
    expect(issue.line).toBeLessThan(5);
  });

  test("a multi-line array does not drag the blame backwards", () => {
    const text = '+++\na = [\n  1,\n  2,\n]\nb = = 3\n+++\n';
    const parsed = parseFrontmatter("role.md", text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.line).toBe(6);
  });

  test("every key is indexed, including keys inside tables", () => {
    const parsed = parseTomlDocument(
      "map.toml",
      ['a = 1', '', '[scope]', 'does = "x"', 'does_not = "y"', ''].join("\n"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.lines.get("a")).toBe(1);
    expect(parsed.value.lines.get("scope")).toBe(3);
    expect(parsed.value.lines.get("scope.does")).toBe(4);
    expect(parsed.value.lines.get("scope.does_not")).toBe(5);
  });

  test("keys inside a multi-line array are not mistaken for real keys", () => {
    const parsed = parseTomlDocument("map.toml", ['a = [\n  "b = 2",\n]\nc = 3'].join("\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.lines.get("b")).toBeUndefined();
    expect(parsed.value.lines.get("c")).toBe(4);
  });
});
