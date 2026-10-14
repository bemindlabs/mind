/**
 * The sensitive-actions list in the language a person chose (GL-01).
 *
 * `classifyAction` (`sensitive.ts`) writes each reason with the English meaning of a category and its Thai after
 * it. That text is made inside the browser container too (`docker/browser/sensitive.cjs`), which does not know
 * which language anybody chose, and a held action keeps it on disk. So the choice is made where the reason is
 * **read**, on the host: English is what is printed, and the Thai goes after it, with ` · `, only when Thai is
 * chosen (`src/lang.ts`).
 *
 * It is a separate file so that `sensitive.ts` stays the one thing the container bundles, with no language
 * setting, no environment read and no import in it.
 */

import { withThai, type Language } from "../lang.ts";
import { SENSITIVE_CATEGORIES, SENSITIVE_MEANING, type SensitiveCategory } from "./sensitive.ts";

/** One category's meaning: the English, with the Thai after it when Thai is chosen. */
export function sensitiveMeaning(category: SensitiveCategory, language: Language = "en"): string {
  return withThai(SENSITIVE_MEANING[category].en, SENSITIVE_MEANING[category].th, language);
}

/**
 * The reasons of a held action as a person who chose `language` reads them.
 *
 * A reason that opens with a category's meaning in both languages (what `classifyAction` writes) loses the Thai
 * unless Thai is chosen. A reason that opens with the English alone gets the Thai after it when Thai is chosen.
 * A reason that names no category (an unknown step kind, a commit) is left as it is.
 */
export function reasonsIn(reasons: readonly string[], language: Language = "en"): readonly string[] {
  return reasons.map((reason) => {
    for (const category of SENSITIVE_CATEGORIES) {
      const { en, th } = SENSITIVE_MEANING[category];
      const both = `${en} · ${th}`;
      if (reason.startsWith(both)) return language === "th" ? reason : `${en}${reason.slice(both.length)}`;
      if (reason.startsWith(en)) return language === "th" ? `${both}${reason.slice(en.length)}` : reason;
    }
    return reason;
  });
}
