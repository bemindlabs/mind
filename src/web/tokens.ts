/**
 * The shared design tokens, as the console takes them (design system spec §8, S3).
 *
 * `src/web/tokens/` holds two files that mind-app generates from its `src/design/tokens.ts` (the one source for
 * every Mind UI), copied byte for byte and never edited here; `test/web/tokens-pinned.test.ts` holds the copies to
 * the source they came from. The console ships as one program, so the stylesheet is imported as text and put into
 * the page, and nothing is fetched.
 */

import TOKENS_CSS_TEXT from "./tokens/tokens.css" with { type: "text" };

/** The `:root` blocks: light by default, dark by the device or by the page's own choice (`data-theme`). */
export const TOKENS_CSS: string = TOKENS_CSS_TEXT;
