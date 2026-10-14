/**
 * Which language the words Mind prints are in (GL-01).
 *
 * **English, unless Thai is chosen.** Mind opens to people anywhere, so the default is the one language every
 * reader of the project's documents has. The Thai that used to be printed beside the English half of a line
 * (the dial's level names, the browser's levels, the sensitive-actions list) is still in the engine, every
 * string of it, and is printed when a person has chosen Thai.
 *
 * There was no language setting before this file, so this is it. In order:
 *
 * 1. `MIND_LANG` — the explicit choice, and the only one that can say "English" over a Thai locale. `th`,
 *    `th_TH`, `th-TH` and `th_TH.UTF-8` are Thai; any other non-empty value is English.
 * 2. The locale, by the POSIX rule: the first of `LC_ALL`, `LC_MESSAGES`, `LANG` that is set and not empty
 *    decides. Thai when it starts with `th` followed by nothing or one of `_ . @ -`.
 * 3. Otherwise English.
 *
 * Only two answers exist because only two languages are carried. A third is a new member of {@link Language},
 * which is a `tsc` error at every `switch` until it is handled.
 *
 * Pure: the environment is an argument, as D-021 asks of `src/`. The command layer passes `process.env`.
 */

import { readMind, type Env } from "./env.ts";

/** The languages Mind can print. */
export type Language = "en" | "th";

/** The environment variable that chooses, over the locale. */
export const LANG_ENV = "MIND_LANG";

/** A locale or language tag that names Thai: `th`, `th_TH`, `th-TH`, `th_TH.UTF-8`, `th@euro`. */
const THAI_TAG = /^th(?:[_.@-]|$)/i;

/** The language this environment has chosen. */
export function chosenLanguage(env: Env): Language {
  const explicit = readMind(LANG_ENV, env)?.trim();
  if (explicit !== undefined && explicit !== "") return THAI_TAG.test(explicit) ? "th" : "en";
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") return THAI_TAG.test(value) ? "th" : "en";
  }
  return "en";
}

/**
 * A line's two halves as the chosen language prints them: the English alone, or the English with the Thai
 * after ` · `. English is always there; Thai never stands in for it.
 */
export function withThai(en: string, th: string, language: Language): string {
  return language === "th" ? `${en} · ${th}` : en;
}
