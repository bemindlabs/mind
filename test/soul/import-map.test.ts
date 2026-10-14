/**
 * The import map — the file that carries every judgement call the engine will
 * not make for itself.
 *
 * Two properties are worth testing and they pull in opposite directions. The
 * map must be *strict*, because it is the only thing standing between a
 * mindset and the wrong half of a soul, and a typo that parses is a typo that
 * ships. And it must be *legible when it fails*, because the person fixing it
 * is reading a TOML file by hand — hence the line number on every complaint
 * (AC4).
 *
 * What is deliberately not tested here is any particular agent's map. The real
 * one lives outside this repository (D-021), so everything below is synthetic.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadImportMap, parseImportMap } from "../../src/soul/import-map.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const MAP = join(FIXTURES, "bwoc-agent-synthetic.import-map.toml");

/** A minimal valid `[readme]`, so a test can vary one thing at a time. */
const README_RULES = `
[readme]
addresses_user_as_row = "Calls the user"
refers_to_self_as_row = "Refers to itself as"
tone_section          = "Personality"
principles_section    = "Core Principles"
constraints_section   = "Constraints"
`;

describe("parseImportMap", () => {
  test("reads the three destinations and remembers each one's line", () => {
    const text = `[classify]
"persona/a.md" = "role"
"mindsets/b.md" = "person"
"mindsets/SPEC.md" = "skip"
${README_RULES}`;

    const result = parseImportMap("map.toml", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.map.classify.get("persona/a.md")).toBe("role");
    expect(result.map.classify.get("mindsets/b.md")).toBe("person");
    expect(result.map.classify.get("mindsets/SPEC.md")).toBe("skip");

    // The line index is what makes a stale entry reportable later (bwoc.ts
    // points at it when a mapped file no longer exists).
    expect(result.map.lines.get("persona/a.md")).toBe(2);
    expect(result.map.lines.get("mindsets/SPEC.md")).toBe(4);

    expect(result.map.readme.tone_section).toBe("Personality");
    expect(result.map.file).toBe("map.toml");
  });

  test("rejects a fourth destination, naming the line and the value", () => {
    const text = `[classify]
"persona/a.md" = "role"
"mindsets/b.md" = "personal"
${README_RULES}`;

    const result = parseImportMap("map.toml", text);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.issues).toHaveLength(1);
    const [issue] = result.issues;
    expect(issue!.file).toBe("map.toml");
    expect(issue!.line).toBe(3);
    expect(issue!.path).toBe("classify.mindsets/b.md");
    expect(issue!.message).toContain("role, person, skip");
    // Quoting the value back is what tells a reader it was "personal", not
    // "person" — the two are one character apart and opposite in effect.
    expect(issue!.message).toContain('"personal"');
    expect(issue!.approximate).toBeUndefined();
  });

  test("a missing [classify] is refused rather than treated as empty", () => {
    const result = parseImportMap("map.toml", README_RULES.trimStart());
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("classify");
  });

  test("a missing [readme] is refused — the engine knows no agent's headings", () => {
    const result = parseImportMap("map.toml", '[classify]\n"persona/a.md" = "role"\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toContain("readme");
  });

  test("reports every malformed [readme] label at once, each on its own line", () => {
    const text = `[classify]
"persona/a.md" = "role"

[readme]
addresses_user_as_row = "Calls the user"
refers_to_self_as_row = ""
tone_section          = 12
principles_section    = "Core Principles"
constraints_section   = "Constraints"
`;

    const result = parseImportMap("map.toml", text);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    // All of them, not just the first: someone hand-editing this file wants
    // the whole list, the same way the soul validator gives it.
    const byPath = new Map(result.issues.map((issue) => [issue.path, issue.line]));
    expect(byPath.get("readme.refers_to_self_as_row")).toBe(6);
    expect(byPath.get("readme.tone_section")).toBe(7);
  });

  test("rejects an unknown section and an unknown [readme] key", () => {
    const text = `[classify]
"persona/a.md" = "role"

[readme]
addresses_user_as_row = "Calls the user"
refers_to_self_as_row = "Refers to itself as"
tone_section          = "Personality"
principles_section    = "Core Principles"
constraints_section   = "Constraints"
voice_section         = "Voice"

[defaults]
unmapped = "person"
`;

    const result = parseImportMap("map.toml", text);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const byPath = new Map(result.issues.map((issue) => [issue.path, issue]));

    // `[defaults]` is the specific mistake this schema exists to refuse: a map
    // with a fallback is a map that can silently swallow a new file.
    expect(byPath.get("defaults")?.message).toContain("unknown section");
    expect(byPath.get("defaults")?.line).toBe(12);
    expect(byPath.get("readme.voice_section")?.message).toContain("unknown key");
    expect(byPath.get("readme.voice_section")?.line).toBe(10);
  });

  test("a TOML syntax error is reported with an approximate line, marked as such", () => {
    const text = `[classify]
"persona/a.md" = role
${README_RULES}`;

    const result = parseImportMap("map.toml", text);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.issues).toHaveLength(1);
    const [issue] = result.issues;
    // Bun reports no usable position for TOML syntax errors, so the line is
    // derived by prefix-parsing and carries `approximate` all the way out.
    // The exact number is not asserted — only that it is honest and in range.
    expect(issue!.approximate).toBe(true);
    expect(issue!.line).toBeGreaterThanOrEqual(1);
    expect(issue!.line).toBeLessThanOrEqual(text.split("\n").length);
  });

  test("a document that is not a table at all is refused", () => {
    const result = parseImportMap("map.toml", "");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // An empty file parses as an empty table, so what is missing is content.
    expect(result.issues.map((issue) => issue.path).sort()).toEqual(["classify", "readme"]);
  });
});

describe("loadImportMap", () => {
  test("loads the synthetic fixture map from disk", async () => {
    const result = await loadImportMap(MAP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect([...result.map.classify.keys()].sort()).toEqual([
      "mindsets/SPEC.md",
      "mindsets/example-no-headings.md",
      "mindsets/example-ops.md",
      "mindsets/example-terse.md",
      "mindsets/example-voice.md",
      "persona/example-buddy.md",
    ]);
  });

  test("a missing map is an issue, not an exception", async () => {
    const result = await loadImportMap(join(FIXTURES, "no-such-map.toml"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.line).toBe(0);
    expect(result.issues[0]!.message).toContain("not found");
  });
});
