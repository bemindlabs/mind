/**
 * The schema half of AC4: malformed souls are refused, by line.
 *
 * Every assertion here is about a *number*, not just a rejection. "Invalid"
 * with no line is a message that makes someone re-read their whole file, and
 * the point of validating at all is to shorten that search to one glance.
 */

import { describe, expect, test } from "bun:test";
import { subjectId } from "../../src/types.ts";
import { parsePerson, parseRole } from "../../src/soul/load.ts";
import { formatIssue } from "../../src/soul/schema.ts";

const EXAMPLE = subjectId("example");

const ROLE = [
  "+++",
  'schema = "mind/soul-role@1"',
  'subject = "example"',
  'name = "Example Keeper"',
  'role = "Keeps the example tidy"',
  'prohibitions = ["never commits credentials"]',
  "",
  "[scope]",
  'does = "tends the fixture"',
  'does_not = "touches nothing else"',
  "+++",
  "body",
  "",
].join("\n");

const PERSON = [
  "+++",
  'schema = "mind/soul-person@1"',
  'subject = "example"',
  'tone = ["plain"]',
  'addresses_user_as = "friend"',
  'refers_to_self_as = ["the keeper"]',
  'principles = ["check before acting"]',
  "+++",
  "body",
  "",
].join("\n");

/** Replace one whole line of a fixture, keeping every other line's number. */
function withLine(text: string, lineNumber: number, replacement: string): string {
  const lines = text.split("\n");
  lines[lineNumber - 1] = replacement;
  return lines.join("\n");
}

describe("role.md", () => {
  test("accepts a well-formed file", () => {
    const parsed = parseRole("role.md", ROLE, EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("Example Keeper");
    expect(parsed.value.prohibitions).toEqual(["never commits credentials"]);
    expect(parsed.value.scope.does_not).toBe("touches nothing else");
    expect(parsed.value.body).toBe("body\n");
  });

  test("an unknown key is refused on its own line, not silently dropped", () => {
    const parsed = parseRole("role.md", withLine(ROLE, 4, 'nmae = "typo"'), EXAMPLE);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const unknown = parsed.issues.find((issue) => issue.path === "nmae");
    expect(unknown?.line).toBe(4);
    expect(unknown?.message).toContain("unknown key");
  });

  test("prohibitions may not be empty — a soul that forbids nothing is unfinished", () => {
    const parsed = parseRole("role.md", withLine(ROLE, 6, "prohibitions = []"), EXAMPLE);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const issue = parsed.issues.find((i) => i.path === "prohibitions");
    expect(issue?.line).toBe(6);
    expect(issue?.message).toContain("at least one");
  });

  test("a missing key inside [scope] is blamed on the table, not on line 1", () => {
    const parsed = parseRole("role.md", withLine(ROLE, 10, ""), EXAMPLE);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const issue = parsed.issues.find((i) => i.path === "scope.does_not");
    expect(issue?.line).toBe(8);
    expect(issue?.message).toContain("required");
  });

  test("a wrong type says what it found", () => {
    const parsed = parseRole("role.md", withLine(ROLE, 6, "prohibitions = 3"), EXAMPLE);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.message).toContain("array of strings");
  });

  test("every problem is reported, not just the first", () => {
    const broken = withLine(withLine(ROLE, 4, 'nmae = "typo"'), 6, "prohibitions = []");
    const parsed = parseRole("role.md", broken, EXAMPLE);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // unknown key, missing `name`, empty prohibitions
    expect(parsed.issues.length).toBeGreaterThanOrEqual(3);
  });

  test("a soul belonging to another subject is refused (I-3)", () => {
    const parsed = parseRole("role.md", ROLE, subjectId("someone-else"));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const issue = parsed.issues.find((i) => i.path === "subject");
    expect(issue?.line).toBe(3);
    expect(issue?.message).toContain("someone-else");
  });

  test("the schema tag must match exactly", () => {
    const parsed = parseRole("role.md", withLine(ROLE, 2, 'schema = "mind/soul-role@2"'), EXAMPLE);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.path).toBe("schema");
  });

  test("[extra] takes any key, but only text", () => {
    const withExtra = ROLE.replace("+++\nbody", '[extra]\nanything = "goes"\n+++\nbody');
    const parsed = parseRole("role.md", withExtra, EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.extra["anything"]).toBe("goes");

    const badValue = ROLE.replace("+++\nbody", "[extra]\nanything = 3\n+++\nbody");
    const refused = parseRole("role.md", badValue, EXAMPLE);
    expect(refused.ok).toBe(false);
  });
});

describe("person.md", () => {
  test("accepts a well-formed file", () => {
    const parsed = parsePerson("person.md", PERSON, EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.addresses_user_as).toBe("friend");
  });

  test("a soul may not declare that it is not an AI", () => {
    // `disclosesAi` is set by the engine and has no key, so writing one is an
    // unknown key — which is how I-5 stays non-negotiable in the file format.
    const parsed = parsePerson(
      "person.md",
      withLine(PERSON, 7, "disclosesAi = false"),
      EXAMPLE,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.some((i) => i.path === "disclosesAi")).toBe(true);
  });
});

describe("formatIssue", () => {
  test("names file and line, and hedges only when the line is derived", () => {
    expect(
      formatIssue({ file: "role.md", line: 6, path: "prohibitions", message: "must not be empty" }),
    ).toBe("role.md:6: prohibitions — must not be empty");

    expect(
      formatIssue({ file: "role.md", line: 3, path: "", message: "bad toml", approximate: true }),
    ).toContain("approximate");

    expect(formatIssue({ file: "role.md", line: 0, path: "", message: "not found" })).toBe(
      "role.md: not found",
    );
  });
});
