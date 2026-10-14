/**
 * S8.3 — the egress filter (D-048). AC1 is "block, not warn"; AC3 is ten ways
 * of trying to get personal data out. The red team below is written to say
 * what it catches **and what it does not**: the two forms a text filter cannot
 * see are asserted as passing, so the day one of them is caught — or the day
 * a caught one slips — this file changes colour instead of a sentence in a
 * README going stale.
 */

import { describe, expect, test } from "bun:test";
import { describeFindings, FILTER_LIMITS, screen } from "../../src/egress/filter.ts";
import { parseNeedles } from "../../src/egress/store.ts";

const LEXICON = { needles: ["Wanida Srisuk", "ร้านใบเตยหอม", "stage 2 diabetes"] };

/** A valid Thai national ID (checksum right) and a Luhn-valid card, both fictional. */
function thaiId(): string {
  const first12 = "110170012345";
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (13 - i);
  return first12 + String((11 - (sum % 11)) % 10);
}
const CARD = "4111 1111 1111 1111";

describe("screen", () => {
  test("a needle is found whatever its case or spacing, and named by number only", () => {
    const findings = screen("please ask   WANIDA   srisuk about it", LEXICON);
    expect(findings).toEqual([{ rule: "needle", needle: 1 }]);
    expect(describeFindings(findings)).toBe("personal needle #1");
    expect(describeFindings(findings)).not.toContain("Wanida");
  });

  test("shapes: email, Thai phone, a Thai ID with a valid checksum, a Luhn card, a credential", () => {
    const rules = (text: string) => screen(text, { needles: [] }).map((f) => f.rule);
    expect(rules("write to w.s@example.co.th")).toContain("email");
    expect(rules("โทร 081-234-5678")).toContain("thai-phone");
    expect(rules("+66 81 234 5678")).toContain("thai-phone");
    expect(rules(`ID ${thaiId()}`)).toContain("thai-national-id");
    expect(rules(`card ${CARD}`)).toContain("payment-card");
    expect(rules("postgres://app:hunter22-x@db.invalid/main")).toContain("secret:url-credentials");
  });

  test("near misses pass: a wrong checksum, a non-Luhn number, a repeated digit, a date", () => {
    const rules = (text: string) => screen(text, { needles: [] }).map((f) => f.rule);
    const bad = thaiId().slice(0, 12) + String((Number(thaiId()[12]) + 1) % 10);
    expect(rules(`ref ${bad}`)).not.toContain("thai-national-id");
    expect(rules("order 4111 1111 1111 1112")).not.toContain("payment-card");
    expect(rules("0000000000000")).not.toContain("payment-card");
    expect(rules("2026-09-23 at 14:15, port 30600")).toEqual([]);
  });

  test("a clean message may leave", () => {
    expect(screen("close the books on the 26th and reconcile the bank feed", LEXICON)).toEqual([]);
  });

  test("the needles file: comments and blanks skipped", () => {
    expect(parseNeedles("# mine\nWanida Srisuk\n\n  ร้านใบเตยหอม  \n")).toEqual(["Wanida Srisuk", "ร้านใบเตยหอม"]);
  });
});

describe("AC3 — ten ways out, and which of them the filter stops", () => {
  const CAUGHT: readonly [string, string][] = [
    ["straight", "The owner is Wanida Srisuk."],
    ["in context", "Summary for the partner: invoices go out monthly, contact Wanida Srisuk if late."],
    ["as an attachment body", "--- attached: notes.md ---\n# Client\nร้านใบเตยหอม closes on the 26th\n---"],
    ["in a quoted log line", '2026-09-23T10:00Z INFO user="wanida srisuk" action=login'],
    ["health fact", "She manages her stage 2 diabetes with diet."],
    ["contact detail", "Reach her on 081-234-5678 after six."],
    ["email in a signature", "Thanks,\n— W.\nwanida.s@example.co.th"],
    ["identity number", `Her ID card is ${thaiId()}.`],
  ];
  const MISSED: readonly [string, string][] = [
    ["paraphrase", "The bookkeeper whose first name means 'young woman' in Sanskrit runs the bakery's accounts."],
    ["translation", "เจ้าของคือคุณวนิดา ศรีสุข"],
  ];

  for (const [form, text] of CAUGHT) {
    test(`caught — ${form}`, () => {
      expect(screen(text, LEXICON).length, form).toBeGreaterThan(0);
    });
  }

  for (const [form, text] of MISSED) {
    test(`NOT caught — ${form} (a text filter matches text, not meaning)`, () => {
      expect(screen(text, LEXICON)).toEqual([]);
      expect(FILTER_LIMITS.join(" ")).toContain("paraphrased, abbreviated, translated");
    });
  }

  test("the tally the backlog quotes: 8 of 10", () => {
    expect(CAUGHT.length).toBe(8);
    expect(MISSED.length).toBe(2);
  });
});

describe("EEA-06 — a needle written out of the form it was listed in is still the needle", () => {
  const NEEDLES = ["วนิดา", "Wanida Srisuk", "123 Main Street"];
  const rules = (text: string) => screen(text, { needles: NEEDLES }).map((f) => `${f.rule}${f.needle ?? ""}`);
  // Built from code points, so nothing invisible sits in this file where a reader could not see it.
  const at = (...points: number[]) => String.fromCodePoint(...points);
  const ZWSP = at(0x200b);
  const SOFT_HYPHEN = at(0xad);
  const ACUTE = at(0x0301);
  const DOT_BELOW = at(0x0323);
  const NBSP = at(0xa0);
  const fullWidth = (text: string) => [...text].map((c) => (c === " " ? at(0x3000) : c >= "A" && c <= "Z" ? at(0xff21 + c.charCodeAt(0) - 65) : c)).join("");

  test("the five forms the security review found", () => {
    // A zero-width space inside a Thai name (ordinary in Thai text) and inside a Latin one, a soft hyphen,
    // full-width letters, and an acute accent on the last letter.
    expect(rules(`ถามคุณวนิ${ZWSP}ดา`)).toEqual(["needle1"]);
    expect(rules(`Wani${ZWSP}da Srisuk`)).toEqual(["needle2"]);
    expect(rules(`Wanida Sri${SOFT_HYPHEN}suk`)).toEqual(["needle2"]);
    expect(rules(fullWidth("WANIDA SRISUK"))).toEqual(["needle2"]);
    expect(rules(`Wanida Srisuk${ACUTE}`)).toEqual(["needle2"]);
  });

  test("accents anywhere on a Latin letter, in either decomposition, are the plain letter", () => {
    expect(rules(`Wan${at(0xed)}da Srisuk`)).toEqual(["needle2"]);
    expect(rules(`Wan${at(0xee)}da Srisuk`)).toEqual(["needle2"]);
    expect(rules(`Wani${ACUTE}da Sri${ACUTE}suk${DOT_BELOW}`)).toEqual(["needle2"]);
    expect(screen(`caf${at(0xe9)} owner`, { needles: ["Cafe Owner"] })).toEqual([{ rule: "needle", needle: 1 }]);
    expect(screen("CAFE OWNER", { needles: [`caf${at(0xe9)} owner`] })).toEqual([{ rule: "needle", needle: 1 }]);
  });

  test("a needle of several words is found with its spaces moved, added or gone", () => {
    for (const text of ["Wanida Sri suk", "WanidaSrisuk", "Wani da Srisuk", "W a n i d a S r i s u k", `wanida${NBSP}\n\tsrisuk`, "123MainStreet", "1 23 Main Street"]) {
      expect(rules(text).length, text).toBe(1);
    }
  });

  test("Thai vowel and tone marks are part of the word: taking them off is a different word, and still is", () => {
    expect(screen("ไก", { needles: ["ไก่"] })).toEqual([]);
    expect(screen("ไก่ทอด", { needles: ["ไก่"] })).toEqual([{ rule: "needle", needle: 1 }]);
    expect(screen("น้ำ", { needles: ["นำ"] })).toEqual([]);
  });

  test("a one-word needle is not spelled out across the spaces of ordinary text, nor a short phrase", () => {
    // `dana` is inside "rea[d an a]rticle" once the spaces are gone; it must not be found there.
    expect(screen("I read an article about it", { needles: ["Dana"] })).toEqual([]);
    expect(screen("a hand and a half", { needles: ["handan"] })).toEqual([]);
    expect(screen("an na", { needles: ["an na"] })).toEqual([{ rule: "needle", needle: 1 }]);
    expect(screen("a banna", { needles: ["an na"] })).toEqual([]);
  });

  test("a phrase that is not there stays out, and work on a long text stays linear", () => {
    expect(rules("close the books on the 26th and reconcile the bank feed")).toEqual([]);
    const started = performance.now();
    screen("a".repeat(400_000), { needles: NEEDLES });
    screen("ab ".repeat(100_000), { needles: NEEDLES });
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("EEA-06, second pass — the forms the verifier found that the first pass let through", () => {
  const NEEDLES = ["วนิดา", "Wanida Srisuk", "123 Main Street"];
  const rules = (text: string, needles: readonly string[] = NEEDLES) => screen(text, { needles }).map((f) => `${f.rule}${f.needle ?? ""}`);
  // Built from code points, so nothing invisible sits in this file where a reader could not see it.
  const at = (...points: number[]) => String.fromCodePoint(...points);
  const ACUTE = at(0x0301);
  const CGJ = at(0x034f);

  test("Hangul fillers, the combining grapheme joiner, variation selectors and tag characters are not drawn, so they hide nothing", () => {
    for (const hidden of [at(0x115f), at(0x1160), at(0x3164), at(0xffa0), CGJ, at(0xfe0f), at(0xfe00), at(0x180b), at(0xe0041), at(0x17b4)]) {
      const label = `U+${hidden.codePointAt(0)!.toString(16)}`;
      expect(rules(`Wani${hidden}da Srisuk`), label).toEqual(["needle2"]);
      expect(rules(`Wanida${hidden} Srisuk`), label).toEqual(["needle2"]);
      expect(rules(`ถามคุณวนิ${hidden}ดา`), label).toEqual(["needle1"]);
      expect(rules(`${hidden}123 Main${hidden} Street`), label).toEqual(["needle3"]);
    }
  });

  test("a combining mark on a space, a digit or a Thai letter is as little part of the name as one on a Latin letter", () => {
    expect(rules(`Wanida${ACUTE} ${ACUTE}Srisuk`)).toEqual(["needle2"]);
    expect(rules(`Wanida ${ACUTE}${at(0x0323)}Srisuk`)).toEqual(["needle2"]);
    expect(rules(`123${ACUTE} Main${at(0x0323)} Street`)).toEqual(["needle3"]);
    expect(rules(`1${ACUTE}23 Main Street`)).toEqual(["needle3"]);
    expect(rules(`ถามคุณวนิดา${ACUTE}`)).toEqual(["needle1"]);
    expect(rules(`ถามคุณวนิ${ACUTE}ดา`)).toEqual(["needle1"]);
    // At the very start of a text, with nothing for it to sit on.
    expect(rules(`${ACUTE}Wanida Srisuk`)).toEqual(["needle2"]);
  });

  test("what changes a Thai word is still not taken off it, and the Japanese voicing mark is not taken off a kana", () => {
    expect(screen("ไก", { needles: ["ไก่"] })).toEqual([]);
    expect(screen("น้ำ", { needles: ["นำ"] })).toEqual([]);
    expect(screen("かこう", { needles: ["がこう"] })).toEqual([]);
    expect(screen("がこう", { needles: ["がこう"] })).toEqual([{ rule: "needle", needle: 1 }]);
  });

  test("the words of a name joined by a dash, an underscore, a dot, a slash or any punctuation are the name", () => {
    for (const text of ["Wanida-Srisuk", "wanida_srisuk", "wanida.srisuk", "Wanida / Srisuk", "Wanida,Srisuk", "WANIDA — SRISUK", "Wanida · Srisuk", "wanida+srisuk", "W-a-n-i-d-a S.r.i.s.u.k", "Wanida‐Srisuk"]) {
      expect(rules(text).filter((r) => r === "needle2"), text).toEqual(["needle2"]);
    }
    for (const text of ["123-Main-Street", "123_main.street", "123, Main, Street"]) expect(rules(text), text).toContain("needle3");
    expect(rules("J.R.Smith-Jones", ["J. R. Smith-Jones"])).toEqual(["needle1"]);
  });

  test("a name of one word is found spelled out with punctuation between its letters", () => {
    for (const text of ["W.a.n.i.d.a", "W-a-n-i-d-a", "w_a_n_i_d_a", "S.r.i.s.u.k", "w·a·n·i·d·a", "Wan.ida"]) {
      expect(screen(text, { needles: ["Wanida", "Srisuk"] }).length, text).toBe(1);
    }
    expect(rules("ว.น.ิ.ด.า")).toEqual(["needle1"]);
    expect(screen("please contact Wa'nida", { needles: ["Wanida"] })).toEqual([{ rule: "needle", needle: 1 }]);
  });

  test("and ordinary text still passes: nothing is matched across spaces for one word, and a short needle is not matched through punctuation", () => {
    expect(screen("I read an article about it", { needles: ["Dana"] })).toEqual([]);
    expect(screen("read. An article", { needles: ["Dana"] })).toEqual([]);
    expect(screen("rea.d.a.na", { needles: ["Ann"] })).toEqual([]);
    expect(screen("a.n.n", { needles: ["Ann"] })).toEqual([]);
    expect(screen("the end. Main point: street food; 123 apples", { needles: ["123 Main Street"] })).toEqual([]);
    expect(screen("see v1.2.3 of the tool, section 4-5", { needles: ["Wanida Srisuk", "ร้านใบเตยหอม"] })).toEqual([]);
    // A needle that is only punctuation is matched as written and nothing more: it does not become an empty needle.
    expect(screen("a sentence, with a comma", { needles: ["...", "--", "@@"] })).toEqual([]);
  });

  test("what is still not seen is said, and is asserted so that the day it is seen this file says so", () => {
    // A one-word needle with a space inside it, and a letter swapped for a look-alike of another script.
    expect(screen("Sri suk", { needles: ["Srisuk"] })).toEqual([]);
    expect(screen(`W${at(0x430)}nida`, { needles: ["Wanida"] })).toEqual([]);
    const limits = FILTER_LIMITS.join(" ");
    expect(limits).toContain("a name of one word with a space inside it");
    expect(limits).toContain("look-alikes from another script");
  });

  test("a long text of punctuation, dots and marks is still read in time that grows with its length", () => {
    const started = performance.now();
    screen("a.".repeat(200_000), { needles: NEEDLES });
    screen("a-".repeat(200_000), { needles: NEEDLES });
    screen(`a${ACUTE}${CGJ}`.repeat(100_000), { needles: NEEDLES });
    screen(". ".repeat(200_000), { needles: NEEDLES });
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
