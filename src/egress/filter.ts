/**
 * The egress filter — what may not leave this machine (S8.3, D-048, I-6).
 *
 * Pure: text in, findings out. What counts as personal is handed in as a
 * {@link Lexicon}; the patterns below are the kinds of personal data that have
 * a shape. A finding never carries the matched text — the caller has the
 * text, and a finding that repeated it would be one more copy of the thing
 * being kept in.
 *
 * ## The shapes supplement the owner's needles — they do not replace them
 *
 * **The owner's needles are the filter.** A name, an address, an illness, a
 * shop, a nickname — anything that must not leave is something only the owner
 * can list, and `mind egress needles` is where they do. The shapes are what a
 * list of words cannot be: kinds of number that can be recognised without
 * being told, and that are checked (a checksum, a date on the calendar, a
 * country code that exists) so that an ordinary number is not mistaken for one.
 * They are, in {@link FILTER_SHAPES}'s order:
 *
 * - an e-mail address, and a payment card (Luhn) of any issuer;
 * - from Thailand: a phone number and a national id (checksum), since D-048;
 * - from everywhere else (`shapes.ts`, GL-03b): phone numbers with a country
 *   code, IBANs, and the national ids and passport formats of the United
 *   States, the United Kingdom, China, India, Spain, Italy, Brazil, Singapore,
 *   Taiwan, Korea, France, Sweden, Mexico and Russia;
 * - a credential, by the repo guard's own rules.
 *
 * A national id, a phone format or a passport of a country that is not on that
 * list has **no shape here**, and is kept in only if it is a needle. A list
 * like this is never complete, and a reader who takes it for the whole of I-6
 * is wrong in the dangerous direction. Digits written in any script
 * (Arabic-Indic, Devanagari, Thai, full-width) are read as the same number.
 *
 * What this cannot see is said in {@link FILTER_LIMITS}, and it is most of
 * the problem: personal information written as prose, paraphrased, translated
 * or summarised has no pattern and no needle.
 */

import { scanStaged } from "../guard/scan.ts";
import { forShapes, INTERNATIONAL_SHAPES, luhn, type Shape } from "./shapes.ts";

/** What the owner has said is personal, plus names the soul says it inherits from. */
export interface Lexicon {
  readonly needles: readonly string[];
  /**
   * Why the owner's needles could not be read, when they could not (EEA-05). A file that is not there declares
   * nothing, which is the owner's choice; a file that is there and cannot be read declares something that is
   * unknown, and unknown stays in: while this is set, {@link screen} finds something in every text.
   */
  readonly unreadable?: string;
}

/** One reason a message may not leave. */
export interface EgressFinding {
  readonly rule: string;
  /** For `needle`: its 1-based position in the lexicon. Never the needle's text. */
  readonly needle?: number;
}

/**
 * Characters that are not drawn: the format characters (zero-width space, joiners, the soft hyphen, bidirectional
 * marks, the byte-order mark) and the rest of Unicode's default-ignorable set (the Hangul fillers U+115F, U+1160,
 * U+3164 and U+FFA0, which are letters by category and blanks by sight; the combining grapheme joiner; the variation
 * selectors; the tag characters).
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Lower-case, NFKC, invisible characters removed, whitespace collapsed — the form needles are matched in.
 *
 * NFKC rather than NFC so that a needle typed in full-width letters, or a Thai vowel written in its two-part form,
 * is the needle it was meant to be. Invisible characters are dropped from both the needle and the text, so a name with
 * one slipped into the middle of it is still the name; they go before the normal form is taken, so that a letter and
 * a mark with one between them are composed as if it were not there. Both sides are folded the same way, so nothing a
 * needle matched before stops matching.
 */
function fold(value: string): string {
  return value.replace(INVISIBLE, "").normalize("NFKC").replace(INVISIBLE, "").toLowerCase().replace(/\s+/g, " ");
}

/**
 * The generic combining marks, wherever they sit: the diacritical blocks (U+0300 to U+036F, and the extended and
 * supplement blocks), the marks for symbols and the half marks. They belong to no script's words, so they go off a
 * space, a digit or a Thai letter as well as off a Latin one. Thai vowel and tone marks are not here: they are marks of
 * the Thai script and they change the word. Neither are the Japanese voicing marks (U+3099, U+309A): a voiced kana is
 * another syllable.
 */
const GENERIC_MARK = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;

/** Marks on a Latin, Greek or Cyrillic letter, whatever their own script: an accent is a mark on a letter that has them. */
const ACCENT = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu;

/**
 * `fold`, then with the accents taken off letters that have them (an acute accent on the last k of Srisuk): what a name looks like to a
 * reader, as the form a model told to hide a name would still leave readable. Both sides go through it.
 */
function plain(value: string): string {
  return fold(value).normalize("NFKD").replace(GENERIC_MARK, "").replace(ACCENT, "$1");
}

/** The spaces and every mark of punctuation or symbol taken out, for a needle that is itself several words: `Wanida Sri suk`, `Wanida-Srisuk` and `wanida.srisuk` are the name written out of step. */
const unspaced = (value: string): string => value.replace(/[\s\p{P}\p{S}]+/gu, "");

/** Only the punctuation and symbols taken out, the spaces kept: `W.a.n.i.d.a` is a one-word needle spelled out. */
const unpunctuated = (value: string): string => value.replace(/[\p{P}\p{S}]+/gu, "");

/** A phrase this short, spaces removed, is too likely to be made by two ordinary words side by side to be matched that way. */
const UNSPACED_MIN = 6;

/** A one-word needle shorter than this is not matched through the punctuation of ordinary text (`a.n.n`). */
const UNPUNCTUATED_MIN = 4;

/** Thai national ID: 13 digits whose last is the checksum of the first twelve. */
function thaiIdValid(digits: string): boolean {
  if (!/^\d{13}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(digits[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(digits[12]);
}

/**
 * `local@domain.tld`, as `/[\w.+-]+@[\w-]+\.[\w.-]+/` always meant it, found from each `@` instead of from each
 * letter: that expression, tried at every position of a long run of word characters with no `@` (a base64 blob, a
 * minified file, a long number), scans to the end of the run from each one, and 50 KB of digits took 0.7 s while a
 * megabyte took minutes. Here the work is the length of the text.
 */
function hasEmail(text: string): boolean {
  const domain = /[\w-]+\.[\w.-]+/y;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at === 0 || !/[\w.+-]/.test(text[at - 1]!)) continue;
    domain.lastIndex = at + 1;
    if (domain.test(text)) return true;
  }
  return false;
}

/** The shapes this filter has always had, and the one every country shares: the Thai ones are D-048's. */
const BASE_SHAPES: readonly Shape[] = [
  { rule: "email", says: "an e-mail address", find: hasEmail },
  {
    rule: "thai-phone",
    says: "a Thai phone number (081-234-5678, +66 81 234 5678)",
    find: (t) => /(?<!\d)(?:\+66[\s-]?|0)(?:[689]\d)[\s-]?\d{3}[\s-]?\d{4}(?!\d)/.test(t),
  },
  {
    rule: "thai-national-id",
    says: "a Thai national id: 13 digits whose last is the checksum of the first twelve",
    find: (t) => [...t.matchAll(/(?<!\d)(\d[\s-]?){12}\d(?!\d)/g)].some((m) => thaiIdValid(m[0].replace(/[\s-]/g, ""))),
  },
  {
    rule: "payment-card",
    says: "a payment card number: 13 to 19 digits that pass the Luhn check",
    find: (t) =>
      [...t.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)].some((m) => {
        const d = m[0].replace(/[ -]/g, "");
        return d.length >= 13 && d.length <= 19 && !/^(\d)\1+$/.test(d) && luhn(d);
      }),
  },
];

/**
 * Every shape, in the order `mind egress check` lists them, with what each one says it catches. A supplement to
 * the owner's needles, not a substitute for them (see the top of this file).
 */
export const FILTER_SHAPES: readonly Shape[] = [...BASE_SHAPES, ...INTERNATIONAL_SHAPES];

/** Everything that stops this text from leaving. Empty means it may go. */
export function screen(text: string, lexicon: Lexicon): readonly EgressFinding[] {
  const findings: EgressFinding[] = [];
  if (lexicon.unreadable !== undefined) findings.push({ rule: "needles-unreadable" });
  const folded = fold(text);
  const plained = plain(text);
  const closed = unspaced(plained);
  const joined = unpunctuated(plained);
  lexicon.needles.forEach((needle, index) => {
    const wanted = fold(needle).trim();
    if (wanted.length < 2) return;
    const bare = plain(needle).trim();
    // As written; then with accents off; then, for a needle of several words, with the spaces and punctuation off on both
    // sides (a name split, joined, dashed or spaced out of step is the same name, EEA-06); and, for a needle of one word,
    // with the punctuation off (a name spelled out letter by letter with dots). A one-word needle is never matched across
    // the spaces of ordinary text.
    const several = /\s/.test(bare) && unspaced(bare).length >= UNSPACED_MIN;
    const spelled = !/\s/.test(bare) && unpunctuated(bare).length >= UNPUNCTUATED_MIN;
    if (folded.includes(wanted) || plained.includes(bare) || (several && closed.includes(unspaced(bare))) || (spelled && joined.includes(unpunctuated(bare)))) {
      findings.push({ rule: "needle", needle: index + 1 });
    }
  });
  // The shapes read the text with digits of any script as 0-9 and compatibility forms folded (`forShapes`).
  const shaped = forShapes(text);
  for (const shape of FILTER_SHAPES) if (shape.find(shaped)) findings.push({ rule: shape.rule });
  // Credentials: the repo guard's own content rules, over the text as a file.
  const secrets = new Set(
    scanStaged([{ path: "outbound.txt", bytes: new TextEncoder().encode(text) }]).map((f) => f.rule),
  );
  for (const rule of secrets) findings.push({ rule: `secret:${rule}` });
  return findings;
}

/** A line a person can act on, naming no personal text. */
export function describeFindings(findings: readonly EgressFinding[]): string {
  const said: Readonly<Record<string, string>> = {
    "needles-unreadable": "your needles could not be read, so nothing leaves this machine until they can be",
    "judge:reveals": "the local judge read it as revealing a protected item",
    "judge:unsure": "the local judge could not decide, so it stays in",
  };
  return findings.map((f) => (f.rule === "needle" ? `personal needle #${f.needle}` : (said[f.rule] ?? f.rule))).join(", ");
}

/** What the filter cannot see. Printed by `egress check`. */
export const FILTER_LIMITS: readonly string[] = [
  "the shapes (phone numbers, IBANs, card numbers and the national ids and passports of the countries `egress check` lists) supplement your needles and never replace them: an id, a phone format or a passport of a country that is not listed has no shape here, and is kept in only if it is a needle",
  "personal information written as prose — a name nobody listed, an illness, a relationship — has no shape and is not caught unless it is a needle",
  "a needle paraphrased, abbreviated, translated or misspelled; the filter matches text, not meaning — unless the local judge is on (named by MIND_EGRESS_JUDGE, or on by itself for a turn, an A2A message or a proposal's triage when MIND_OLLAMA_MODEL names a model that runs on this machine, which a name ending -cloud does not; D-061, D-181), which reads meaning and can still be wrong; without it the text goes on with the filter alone and a line says so each time",
  "a needle disguised in form: invisible characters, accents, full-width letters, and spaces or punctuation moved in a name of several words are seen through; a name of one word with a space inside it (`Sri suk`), and letters swapped for look-alikes from another script (a Cyrillic а for a Latin a), are not",
  "a number split across lines or written in words",
  "anything a local backend receives: I-6 lets personal data reach this machine's own model, so local turns are not screened",
];
