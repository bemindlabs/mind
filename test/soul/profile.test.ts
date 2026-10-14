/** D-074 — the soul laid flat for a form, and back, unchanged unless changed. */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseSoul } from "../../src/soul/load.ts";
import { applyProfile, changedFields, PROFILE_FIELDS, profileOf, readProfile } from "../../src/soul/profile.ts";
import { serializeSoul } from "../../src/soul/serialize.ts";
import { subjectId } from "../../src/types.ts";

const ROOT = join(import.meta.dir, "..", "..");
async function fixture() {
  const loaded = parseSoul(
    await Bun.file(join(ROOT, "test/fixtures/soul-valid/role.md")).text(),
    await Bun.file(join(ROOT, "test/fixtures/soul-valid/person.md")).text(),
    subjectId("example"),
  );
  if (!loaded.ok) throw new Error("fixture");
  return loaded.soul;
}

describe("profile", () => {
  test("every axis, and back again to the same files", async () => {
    const soul = await fixture();
    const p = profileOf(soul);
    expect(Object.keys(p).sort()).toEqual([...PROFILE_FIELDS].sort());
    const again = serializeSoul(applyProfile(soul, p));
    const before = serializeSoul(soul);
    expect(again).toEqual(before);
    expect(changedFields(p, p)).toEqual([]);
  });

  test("a change is a change, and the result is still a soul", async () => {
    const soul = await fixture();
    const p = { ...profileOf(soul), name: "Keeper Two", tone: ["brief", "warm"], prohibitions: [...soul.role.prohibitions, "never deploys on Fridays"] };
    expect(changedFields(profileOf(soul), p)).toEqual(["name", "prohibitions", "tone"]);
    const s = serializeSoul(applyProfile(soul, p));
    const loaded = parseSoul(s.role, s.person, subjectId("example"));
    expect(loaded.ok && loaded.soul.role.name).toBe("Keeper Two");
    expect(loaded.ok && loaded.soul.disclosesAi).toBe(true);
  });

  test("what a form sends is read strictly: lists are lists, text is text, nothing extra", async () => {
    const good = { ...profileOf(await fixture()), tone: ["  brief ", "", "warm"], name: "  Keeper  " };
    const read = readProfile(good);
    expect(read.ok && read.profile.tone).toEqual(["brief", "warm"]);
    expect(read.ok && read.profile.name).toBe("Keeper");
    const bad = readProfile({ ...good, tone: "brief", name: 3, disclosesAi: false, principles: Array(41).fill("x"), role: "y".repeat(401) });
    expect(bad.ok).toBe(false);
    const problems = bad.ok ? "" : bad.problems.join("\n");
    for (const p of ["tone is a list", "name is text", "disclosesAi is not part of a profile", "principles has more than 40", "role is longer than 400"]) expect(problems).toContain(p);
    expect(readProfile(null).ok).toBe(false);
  });
});
