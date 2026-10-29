/**
 * The alpha line: the binary prints `0.11.1` (no suffix) while its release is the tag `v0.11.1-alpha`, so what
 * `mind update` and the daily check do with those two spellings is a decision, not an accident. This pins it.
 */

import { describe, expect, test } from "bun:test";
import { compareVersions, newerLine, parseVersion } from "../../src/update/version.ts";

const v = (text: string) => parseVersion(text)!;

describe("the alpha line of releases (0.11.x)", () => {
  test("a binary is never told that its own alpha release is newer than it", () => {
    expect(newerLine("0.11.1", "v0.11.1-alpha")).toBeUndefined();
    expect(newerLine("0.11.2", "v0.11.2-alpha")).toBeUndefined();
  });

  test("a binary is told about the next alpha, and the line names both versions", () => {
    const line = newerLine("0.11.1", "v0.11.2-alpha");
    expect(line).toContain("mind 0.11.2-alpha is available (you have 0.11.1)");
  });

  test("an older alpha is never offered over a newer binary", () => {
    expect(newerLine("0.11.2", "v0.11.1-alpha")).toBeUndefined();
    expect(newerLine("0.11.2", "v0.11.0-alpha")).toBeUndefined();
  });

  test("patch numbers compare as numbers, not as text", () => {
    expect(compareVersions(v("0.11.10-alpha"), v("0.11.9-alpha"))).toBeGreaterThan(0);
    expect(compareVersions(v("0.12.0-alpha"), v("0.11.99"))).toBeGreaterThan(0);
  });

  test("the planned stages order alpha, then beta, then the release", () => {
    expect(compareVersions(v("1.0.0-alpha"), v("1.0.0-beta"))).toBeLessThan(0);
    expect(compareVersions(v("1.0.0-beta"), v("1.0.0"))).toBeLessThan(0);
    expect(newerLine("0.12.0", "v1.0.0")).toContain("mind 1.0.0 is available");
  });

  test("a tag that is not a version offers nothing", () => {
    expect(newerLine("0.11.2", "nightly")).toBeUndefined();
    expect(newerLine("0.11.2", null)).toBeUndefined();
  });
});
