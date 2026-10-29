import { describe, expect, test } from "bun:test";
import { parseRoster } from "../../src/fleet/roster.ts";

const GOOD = `
[[bot]]
id = "ada"
subject = "fleet-ada"
backend = "claude"
fallback = ["codex", "gemini"]

[[bot]]
id = "bo"
subject = "fleet-bo"
backend = "codex"
fallback = ["claude"]
scope = "worktree"
`;

function problems(text: string): readonly string[] {
  const roster = parseRoster(text);
  if (roster.ok) throw new Error("expected a refusal");
  return roster.problems;
}

describe("parseRoster", () => {
  test("reads a flat roster: home, ordered spares, and scope that defaults to machine", () => {
    const roster = parseRoster(GOOD);
    expect(roster.ok).toBe(true);
    if (!roster.ok) return;
    expect(roster.bots.map((b) => [b.id, b.home, b.spares, b.scope])).toEqual([
      ["ada", "claude", ["codex", "gemini"], "machine"],
      ["bo", "codex", ["claude"], "worktree"],
    ]);
  });

  test("a spare may be another bot's home: borrowing is not owning", () => {
    expect(parseRoster(GOOD).ok).toBe(true);
  });

  test("one model, one bot: two bots on one home are refused", () => {
    const text = GOOD.replace('backend = "codex"', 'backend = "claude"').replace('fallback = ["claude"]', "");
    expect(problems(text).join("\n")).toContain(`backend "claude" is already bot "ada"'s home`);
  });

  test("one subject, one bot (I-3)", () => {
    const text = GOOD.replace("fleet-bo", "fleet-ada");
    expect(problems(text).join("\n")).toContain("one subject, one bot");
  });

  test("a local model is refused as a home and as a spare", () => {
    expect(problems(GOOD.replace('"claude"\nfallback = ["codex", "gemini"]', '"ollama"\nfallback = ["codex"]')).join("\n")).toContain("backend must be one of");
    expect(problems(GOOD.replace('["codex", "gemini"]', '["codex", "claude-local"]')).join("\n")).toContain("claude-local not cloud");
  });

  test("a field that names a lead is refused as hierarchy, not skipped as unknown", () => {
    for (const key of ["lead", "role", "manager", "reports_to"]) {
      const out = problems(GOOD.replace('id = "bo"', `id = "bo"\n${key} = "ada"`)).join("\n");
      expect(out, key).toContain("the fleet is flat");
    }
  });

  test("an unknown key and an unknown top-level table are refused", () => {
    expect(problems(GOOD.replace('id = "bo"', 'id = "bo"\nmodel = "x"')).join("\n")).toContain('unknown key "model"');
    expect(problems(`${GOOD}\n[lead]\nname = "ada"\n`).join("\n")).toContain('unknown top-level key "lead"');
  });

  test("a spare that repeats, or names the bot's own home, is refused", () => {
    expect(problems(GOOD.replace('["codex", "gemini"]', '["codex", "codex"]')).join("\n")).toContain("twice");
    expect(problems(GOOD.replace('["codex", "gemini"]', '["claude"]')).join("\n")).toContain("repeats its own backend");
  });

  test("a scope other than machine or worktree is refused", () => {
    expect(problems(GOOD.replace('"worktree"', '"root"')).join("\n")).toContain('scope must be "machine" or "worktree"');
  });

  test("an empty roster, a repeated id and a bad id are refused", () => {
    expect(problems("")[0]).toContain("no [[bot]] entries");
    expect(problems(GOOD.replace('id = "bo"', 'id = "ada"')).join("\n")).toContain("id repeats");
    expect(problems(GOOD.replace('id = "bo"', 'id = "Bo!"')).join("\n")).toContain("id must match");
  });

  test("every problem is reported in one pass", () => {
    const text = `[[bot]]\nid = "A"\nsubject = "X Y"\nbackend = "ollama"\nlead = "z"\nscope = "root"\n`;
    expect(problems(text).length).toBeGreaterThanOrEqual(5);
  });

  test("broken TOML is a refusal naming the parse, and never echoes the value", () => {
    const out = problems('[[bot]]\nid = "ada" subject = "SECRET-VALUE"\n').join("\n");
    expect(out).toContain("not valid TOML");
    expect(out).not.toContain("SECRET-VALUE");
  });
});
