/**
 * GL-01 — which language Mind prints in. English unless Thai is chosen, by `MIND_LANG` first and the locale
 * after it, by the POSIX rule (`LC_ALL`, then `LC_MESSAGES`, then `LANG`).
 */

import { describe, expect, test } from "bun:test";
import { chosenLanguage, withThai } from "../../src/lang.ts";

describe("chosenLanguage", () => {
  test("nothing set is English", () => {
    expect(chosenLanguage({})).toBe("en");
  });

  test("MIND_LANG chooses: th, th_TH, th-TH and th_TH.UTF-8 are Thai, in any case", () => {
    for (const value of ["th", "TH", "th_TH", "th-TH", "th_TH.UTF-8", "th@euro", " th "]) {
      expect(chosenLanguage({ MIND_LANG: value }), value).toBe("th");
    }
  });

  test("any other MIND_LANG is English — and beats a Thai locale", () => {
    for (const value of ["en", "en_US.UTF-8", "de", "fr_FR", "thai", "tha", "ja_JP", "zh_TH"]) {
      expect(chosenLanguage({ MIND_LANG: value }), value).toBe("en");
    }
    expect(chosenLanguage({ MIND_LANG: "en", LANG: "th_TH.UTF-8", LC_ALL: "th_TH.UTF-8" })).toBe("en");
  });

  test("an empty MIND_LANG is not a choice: the locale decides", () => {
    expect(chosenLanguage({ MIND_LANG: "", LANG: "th_TH.UTF-8" })).toBe("th");
    expect(chosenLanguage({ MIND_LANG: "  ", LANG: "en_US.UTF-8" })).toBe("en");
  });

  test("the locale: LC_ALL beats LC_MESSAGES beats LANG, and the first one that is set decides", () => {
    expect(chosenLanguage({ LANG: "th_TH.UTF-8" })).toBe("th");
    expect(chosenLanguage({ LC_MESSAGES: "th_TH.UTF-8" })).toBe("th");
    expect(chosenLanguage({ LC_ALL: "th_TH.UTF-8" })).toBe("th");
    expect(chosenLanguage({ LC_ALL: "en_US.UTF-8", LANG: "th_TH.UTF-8" })).toBe("en");
    expect(chosenLanguage({ LC_ALL: "C", LANG: "th_TH.UTF-8" })).toBe("en");
    expect(chosenLanguage({ LC_ALL: "", LC_MESSAGES: "en_GB", LANG: "th_TH" })).toBe("en");
    expect(chosenLanguage({ LC_ALL: "", LC_MESSAGES: "", LANG: "th_TH" })).toBe("th");
  });

  test("a locale that only begins with the letters th is not Thai", () => {
    for (const value of ["thx_XX", "the_BE", "C.UTF-8", "POSIX", "tha_TH"]) {
      expect(chosenLanguage({ LANG: value }), value).toBe("en");
    }
  });

  test("the process environment is not read: the caller hands it in", () => {
    const before = process.env["MIND_LANG"];
    process.env["MIND_LANG"] = "th";
    try {
      expect(chosenLanguage({})).toBe("en");
      expect(chosenLanguage(process.env)).toBe("th");
    } finally {
      if (before === undefined) delete process.env["MIND_LANG"];
      else process.env["MIND_LANG"] = before;
    }
  });
});

describe("withThai", () => {
  test("English alone, or English then the Thai — never the Thai alone", () => {
    expect(withThai("no browser", "ไม่ใช้เบราว์เซอร์", "en")).toBe("no browser");
    expect(withThai("no browser", "ไม่ใช้เบราว์เซอร์", "th")).toBe("no browser · ไม่ใช้เบราว์เซอร์");
  });
});
