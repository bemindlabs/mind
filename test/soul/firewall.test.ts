/**
 * S6.4 — the identity firewall that CI can hold (D-006, D-046).
 *
 * AC3 is structural and is held here: an identity that inherits from a person
 * may not go by that person's name, and the soul does not load if it tries.
 * AC1/AC2 are about what a model says, which CI cannot run; what CI *can*
 * hold is what the model is given — every rendered soul carries the
 * disclosure and the refusal to sign in anyone's name, whatever its files say.
 * The model half is `firewall.real.test.ts`, opt-in.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadSoul } from "../../src/soul/load.ts";
import { renderSoul } from "../../src/soul/render.ts";
import { borrowedNames, type SoulPerson, type SoulRole } from "../../src/soul/schema.ts";
import { serializePerson } from "../../src/soul/serialize.ts";
import { subjectId } from "../../src/types.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "soul-inherits");
const SUBJECT = subjectId("ledger-aide");

function pair(name: string, selves: readonly string[], sources: readonly string[]) {
  const role = { name } as SoulRole;
  const person = { refers_to_self_as: selves, inherits_from: sources } as SoulPerson;
  return borrowedNames(role, person);
}

describe("AC3 — an agent does not wear its source person's name", () => {
  test("a fictional source person with a different agent name loads", async () => {
    const loaded = await loadSoul(FIXTURE, SUBJECT);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.soul.person.inherits_from).toEqual(["Wanida Srisuk"]);
  });

  test("the whole name, a part of it, any case, any punctuation, and Thai with no spaces", () => {
    expect(pair("Wanida Srisuk", [], ["Wanida Srisuk"]).length).toBe(1);
    expect(pair("Wanida's helper", [], ["Wanida Srisuk"]).length).toBe(1);
    expect(pair("aide", ["SRISUK-bot"], ["Wanida Srisuk"]).length).toBe(1);
    expect(pair("ผู้ช่วยวนิดา", [], ["วนิดา ศรีสุข"]).length).toBe(1);
    expect(pair("วนิดาบอท", [], ["วนิดา"]).length).toBe(1);
  });

  test("a different name passes; a part shorter than three characters is not a name", () => {
    expect(pair("Ledger Aide", ["the aide"], ["Wanida Srisuk"])).toEqual([]);
    expect(pair("Ledger Aide", [], ["Li Wu"])).toEqual([]);
    expect(pair("anything", [], [])).toEqual([]);
  });

  test("loading refuses the soul, names the file and the key, and says why", async () => {
    const role = (await Bun.file(join(FIXTURE, "role.md")).text()).replace('name = "Ledger Aide"', 'name = "Wanida"');
    const { parseSoul } = await import("../../src/soul/load.ts");
    const person = await Bun.file(join(FIXTURE, "person.md")).text();
    const result = parseSoul(role, person, SUBJECT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]!.path).toBe("name");
      expect(result.issues[0]!.message).toContain("I-5");
    }
  });

  test("inherits_from round-trips, and a soul without one does not grow the key", async () => {
    const loaded = await loadSoul(FIXTURE, SUBJECT);
    if (!loaded.ok) throw new Error("fixture");
    expect(serializePerson(loaded.soul.person)).toContain('inherits_from = [');
    expect(serializePerson({ ...loaded.soul.person, inherits_from: [] })).not.toContain("inherits_from");
  });
});

describe("AC1/AC2 — what the model is given, which CI can hold", () => {
  test("every rendered soul discloses that it is an AI and refuses to act in a person's name", async () => {
    const loaded = await loadSoul(FIXTURE, SUBJECT);
    if (!loaded.ok) throw new Error("fixture");
    const text = renderSoul(loaded.soul);
    expect(text).toContain("is an AI agent, not a person");
    expect(text).toContain("answers plainly that it is an AI");
    expect(text).toContain("does not sign, approve, promise, or give an undertaking in any person's name");
    // The source person's name is not written into what vendors read.
    expect(text).not.toContain("Wanida");
  });
});
