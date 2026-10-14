/**
 * What a model is actually told.
 *
 * Two properties are load-bearing and both are asserted here rather than
 * reviewed by eye: the render is *deterministic* — no clock, no host, no
 * version string — so applying twice is a no-op and the block hash means
 * something; and the AI disclosure (I-5) is present in every render, because
 * there is no field in a soul file that can switch it off.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { subjectId } from "../../src/types.ts";
import { END_MARKER } from "../../src/soul/block.ts";
import { loadSoul, parseSoul } from "../../src/soul/load.ts";
import { renderIssues, renderSoul } from "../../src/soul/render.ts";
import type { Soul } from "../../src/soul/schema.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const EXAMPLE = subjectId("example");

async function fixtureSoul(dir = "soul-valid", subject = EXAMPLE): Promise<Soul> {
  const loaded = await loadSoul(join(FIXTURES, dir), subject);
  if (!loaded.ok) throw new Error(loaded.issues.map((i) => i.message).join("; "));
  return loaded.soul;
}

describe("renderSoul", () => {
  test("is deterministic: the same soul renders the same bytes", async () => {
    const soul = await fixtureSoul();
    expect(renderSoul(soul)).toBe(renderSoul(soul));
    // Nothing that varies between runs may appear in the output.
    expect(renderSoul(soul)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("carries every field a soul is required to have", async () => {
    const soul = await fixtureSoul();
    const text = renderSoul(soul);

    expect(text).toContain(soul.role.name);
    expect(text).toContain(soul.role.role);
    expect(text).toContain(soul.role.scope.does);
    expect(text).toContain(soul.role.scope.does_not);
    for (const prohibition of soul.role.prohibitions) expect(text).toContain(prohibition);
    for (const principle of soul.person.principles) expect(text).toContain(principle);
    expect(text).toContain(soul.person.addresses_user_as);
    for (const name of soul.person.refers_to_self_as) expect(text).toContain(name);
  });

  test("carries both Markdown bodies, so nothing in the soul is dropped", async () => {
    const soul = await fixtureSoul();
    const text = renderSoul(soul);
    expect(text).toContain("write down what changed");
    expect(text).toContain("Voice and manner.");
  });

  test("always discloses that this is an AI (I-5)", async () => {
    for (const dir of ["soul-valid", "soul-valid-b"] as const) {
      const subject = dir === "soul-valid" ? EXAMPLE : subjectId("other-example");
      const text = renderSoul(await fixtureSoul(dir, subject));
      expect(text).toContain("## Disclosure");
      expect(text).toContain("is an AI agent, not a person");
      expect(text).toContain("it answers plainly that it is an AI");
    }
  });

  test("two different souls share no distinguishing wording (AC5)", async () => {
    const a = renderSoul(await fixtureSoul());
    const b = renderSoul(await fixtureSoul("soul-valid-b", subjectId("other-example")));
    expect(a).toContain("Example Keeper");
    expect(b).not.toContain("Example Keeper");
    expect(b).toContain("Second Keeper");
    expect(a).not.toContain("Second Keeper");
  });
});

describe("renderIssues", () => {
  test("a well-formed soul has none", async () => {
    expect(renderIssues(await fixtureSoul())).toEqual([]);
  });

  test("a soul whose prose contains a Mind marker is named, with the body line", () => {
    const role = [
      "+++",
      'schema = "mind/soul-role@1"',
      'subject = "example"',
      'name = "Marker Keeper"',
      'role = "documents the marker"',
      'prohibitions = ["never lies"]',
      "",
      "[scope]",
      'does = "documentation"',
      'does_not = "anything else"',
      "+++",
      "",
      "The marker Mind writes looks like this:",
      END_MARKER,
      "",
    ].join("\n");
    const person = [
      "+++",
      'schema = "mind/soul-person@1"',
      'subject = "example"',
      'tone = ["plain"]',
      'addresses_user_as = "friend"',
      'refers_to_self_as = ["the keeper"]',
      'principles = ["say what was skipped"]',
      "+++",
      "",
      "Nothing unusual here.",
      "",
    ].join("\n");

    const parsed = parseSoul(role, person, EXAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const issues = renderIssues(parsed.soul);
    expect(issues.length).toBe(1);
    expect(issues[0]!.file).toBe("role.md");
    expect(issues[0]!.message).toContain("body line 3");
  });
});
