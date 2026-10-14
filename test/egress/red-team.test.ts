/**
 * S8.3 AC3 across countries and scripts (GL-03b): the filter against `red-team.ts`. What it stops is asserted as
 * stopped, by the rule that should stop it; what it cannot see is asserted as passing, with the reason written
 * beside it; and ordinary work in nine languages still leaves.
 *
 * The second layer — a model on this machine — reads the forms the filter cannot see. It is
 * `judge.real.test.ts`, opt-in, and reads the same fixtures.
 */

import { describe, expect, test } from "bun:test";
import { FILTER_LIMITS, screen } from "../../src/egress/filter.ts";
import { WORLD_CAUGHT, WORLD_LEXICON, WORLD_MISSED, WORLD_ORDINARY } from "./red-team.ts";

describe("the red team, across countries and scripts", () => {
  for (const form of WORLD_CAUGHT) {
    test(`caught by ${form.rule} — ${form.country}: ${form.form}`, () => {
      const rules = screen(form.text, WORLD_LEXICON).map((finding) => finding.rule);
      expect(rules, form.text).toContain(form.rule);
    });
  }

  for (const miss of WORLD_MISSED) {
    test(`NOT caught — ${miss.country}: ${miss.form} (${miss.why})`, () => {
      expect(screen(miss.text, WORLD_LEXICON)).toEqual([]);
    });
  }

  for (const miss of WORLD_MISSED.filter((m) => m.needle !== undefined)) {
    test(`…and kept in the moment the owner lists it — ${miss.country}: ${miss.form}`, () => {
      // The shapes supplement the needles: what has no shape is the owner's to list, and listing it is enough.
      expect(screen(miss.text, { needles: [miss.needle!] })).toEqual([{ rule: "needle", needle: 1 }]);
    });
  }

  for (const text of WORLD_ORDINARY) {
    test(`may leave — ${text.slice(0, 40)}`, () => {
      expect(screen(text, WORLD_LEXICON)).toEqual([]);
    });
  }

  test("the fixtures span more than one country and more than one script", () => {
    const countries = new Set([...WORLD_CAUGHT, ...WORLD_MISSED].map((form) => form.country));
    expect(countries.size).toBeGreaterThanOrEqual(15);
    const scripts = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Arabic}/u, /\p{Script=Hebrew}/u, /\p{Script=Han}/u, /\p{Script=Hangul}/u, /\p{Script=Devanagari}/u, /\p{Script=Greek}/u, /\p{Script=Thai}/u, /\p{Script=Hiragana}/u];
    const text = [...WORLD_CAUGHT.map((form) => form.text), ...WORLD_MISSED.map((miss) => miss.text), ...WORLD_ORDINARY].join("\n");
    for (const script of scripts) expect(text, String(script)).toMatch(script);
  });

  test("the tally: 41 of 50 stopped by the filter, 9 left for the judge — and every one of them is as the fixtures say", () => {
    const caught = WORLD_CAUGHT.filter((form) => screen(form.text, WORLD_LEXICON).length > 0).length;
    const missed = WORLD_MISSED.filter((miss) => screen(miss.text, WORLD_LEXICON).length === 0).length;
    expect(WORLD_CAUGHT.length).toBe(41);
    expect(WORLD_MISSED.length).toBe(9);
    expect(caught).toBe(WORLD_CAUGHT.length);
    expect(missed).toBe(WORLD_MISSED.length);
  });

  test("what is missed is said in the limits the person reads", () => {
    const limits = FILTER_LIMITS.join(" ");
    expect(limits).toContain("paraphrased, abbreviated, translated");
    expect(limits).toContain("supplement your needles and never replace them");
  });
});
