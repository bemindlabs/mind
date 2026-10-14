/**
 * The shapes of personal data that are not Thai: phone numbers with a country code, bank accounts, national ids
 * and passports of the countries below, and payment cards in any script's digits (GL-03b, I-6).
 *
 * ## What this list is, and is not
 *
 * **It supplements the owner's own needles. It does not replace them.** A shape is a kind of number that can be
 * checked: a country code that exists, a checksum that adds up, a date that is on the calendar. A national id, a
 * phone format or a passport of a country that is not here has no shape in this file, and it is kept in only
 * when it is a needle. A number every country writes the same way and none checks (a bare nine digits) is not
 * here either, because a pattern that fires on every nine digits is one nobody keeps switched on.
 *
 * ## How a shape earns its place
 *
 * - It is **validated**, not only matched: a checksum, a calendar date, a table of real country codes or
 *   lengths. A near miss passes, and each rule has a test of a near miss beside the test of a hit.
 * - Where a format has no checksum (a US social security number, a Korean registration number) it is matched
 *   only in its written form — with the separators — and with the ranges the issuer says are never assigned
 *   left out.
 * - A passport number has no checksum anywhere in the world but the machine-readable zone. So the zone is a
 *   shape, with its own check digits; and a number is taken as a passport's only when the word for passport is
 *   written just before it, in one of a dozen languages. A bare `AB1234567` is not.
 *
 * A finding names the rule and never the text (see `filter.ts`).
 *
 * Every function here takes text that has been through {@link forShapes}: compatibility forms folded, and every
 * decimal digit of any script written as `0`–`9`. So a number typed in Arabic-Indic, Devanagari, Thai or
 * full-width digits is the same number.
 */

/** One kind of personal data with a shape. */
export interface Shape {
  readonly rule: string;
  /** What it catches, in one line a person reads in `mind egress check`. */
  readonly says: string;
  readonly find: (text: string) => boolean;
}

/** The numeric value of a decimal digit of any script, by its place in its block of ten. */
function digitValue(character: string): number {
  const at = character.codePointAt(0)!;
  let zero = at;
  while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return (at - zero) % 10;
}

/**
 * Text as the shapes read it: NFKC (full-width and other compatibility forms folded to the plain ones), then
 * every decimal digit of any script — Arabic-Indic, Devanagari, Thai, Bengali, full-width — as `0`–`9`.
 *
 * Plain ASCII is returned as it is, which is nearly every message.
 */
export function forShapes(text: string): string {
  if (!/[^\x00-\x7f]/.test(text)) return text;
  return text.normalize("NFKC").replace(/\p{Nd}/gu, (digit) => String(digitValue(digit)));
}

/** True when any match of `pattern` (which must be global) satisfies `accept`. */
function anyMatch(text: string, pattern: RegExp, accept: (match: RegExpMatchArray) => boolean): boolean {
  for (const match of text.matchAll(pattern)) if (accept(match)) return true;
  return false;
}

const digitsOf = (value: string): string => value.replace(/\D/g, "");

/** Not inside a longer number: no digit, or a hyphen, before; and not a digit group of a longer number. */
const NUMBER_START = "(?<![\\d-])(?<!\\d[ ])";
const NUMBER_END = "(?![\\d-])(?![ ]\\d)";

/** A real calendar date? Leap years are allowed in February: a birth date is not checked against today. */
function realDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

/** Luhn, for payment cards and the Swedish personal number. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------------------------------------------

/** The country calling codes of ITU-T E.164 that are assigned. No code is the start of another. */
const CALLING_CODES: ReadonlySet<string> = new Set([
  "1", "7",
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66",
  "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98",
  "211", "212", "213", "216", "218",
  ...Array.from({ length: 39 }, (_, i) => String(220 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(260 + i)),
  "290", "291", "297", "298", "299",
  ...Array.from({ length: 10 }, (_, i) => String(350 + i)),
  "370", "371", "372", "373", "374", "375", "376", "377", "378", "380", "381", "382", "383", "385", "386", "387", "389",
  "420", "421", "423",
  ...Array.from({ length: 10 }, (_, i) => String(500 + i)),
  ...Array.from({ length: 10 }, (_, i) => String(590 + i)),
  "670", "672", "673", "674", "675", "676", "677", "678", "679", "680", "681", "682", "683", "685", "686", "687", "688", "689", "690", "691", "692",
  "850", "852", "853", "855", "856", "870", "880", "886",
  ...Array.from({ length: 9 }, (_, i) => String(960 + i)),
  "970", "971", "972", "973", "974", "975", "976", "977",
  "992", "993", "994", "995", "996", "998",
]);

/** The assigned calling code a run of digits starts with, if any. */
function callingCode(digits: string): string | undefined {
  for (const length of [1, 2, 3]) {
    const code = digits.slice(0, length);
    if (CALLING_CODES.has(code)) return code;
  }
  return undefined;
}

/**
 * `+` and a country code and the rest, 8 to 15 digits in all, with spaces, dots, hyphens or brackets between
 * them. The code must be an assigned one; +1 must be a North American number (area code and exchange not
 * starting with 0 or 1), and +7 is eleven digits.
 */
function phoneE164(text: string): boolean {
  return anyMatch(text, /(?<![\w+])\+[1-9](?:[ .()-]{0,2}\d){6,14}(?!\d)/g, (match) => {
    const digits = digitsOf(match[0]);
    const code = callingCode(digits);
    if (code === undefined) return false;
    if (code === "1") return /^1[2-9]\d\d[2-9]\d{6}$/.test(digits);
    if (code === "7") return digits.length === 11;
    return digits.length >= 8 && digits.length <= 15;
  });
}

/**
 * A North American number written with its separators — `(415) 555-2671`, `415-555-2671`, `415.555.2671`, with
 * or without `+1` — and not ten bare digits, which are anything.
 */
function phoneNanp(text: string): boolean {
  return anyMatch(text, /(?<![\w.+-])(?:\+?1[ .-])?\(?[2-9]\d\d\)?[ .-][2-9]\d\d[ .-]\d{4}(?![\w-])/g, () => true);
}

// ---------------------------------------------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------------------------------------------

/** IBAN length by country (the SWIFT registry). A code that is not here is not an IBAN country. */
const IBAN_LENGTH: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22,
  CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22,
  GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30,
  KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27,
  MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33,
  SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29,
  VA: 22, VG: 24, XK: 20, YE: 30,
};

/** ISO 13616: move the first four characters to the end, read letters as 10–35, and the number is 1 mod 97. */
export function ibanValid(compact: string): boolean {
  const rearranged = `${compact.slice(4)}${compact.slice(0, 4)}`.toUpperCase();
  let remainder = 0;
  for (const character of rearranged) {
    const value = /\d/.test(character) ? Number(character) : character.charCodeAt(0) - 55;
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
}

/**
 * An IBAN, in its compact or its spaced form: a registered country code, two check digits, the length that
 * country uses, and a checksum of 1 mod 97. Read off the text by the country's length, so words after the
 * number are not taken for part of it.
 */
function iban(text: string): boolean {
  for (const candidate of text.matchAll(/(?<![A-Za-z0-9])([A-Za-z]{2})\d{2}/g)) {
    const length = IBAN_LENGTH[candidate[1]!.toUpperCase()];
    if (length === undefined) continue;
    let compact = "";
    let at = candidate.index!;
    while (compact.length < length && at < text.length) {
      const character = text[at]!;
      if (/[A-Za-z0-9]/.test(character)) {
        compact += character;
        at += 1;
      } else if ((character === " " || character === "-") && compact.length > 0 && /[A-Za-z0-9]/.test(text[at + 1] ?? "")) {
        at += 1;
      } else break;
    }
    if (compact.length === length && !/[A-Za-z0-9]/.test(text[at] ?? "") && ibanValid(compact)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// National identity numbers
// ---------------------------------------------------------------------------------------------------------------

/**
 * United States social security number, `123-45-6789` (or with spaces). Written form only: nine bare digits are
 * anything. Area 000, 666 and 900–999, group 00 and serial 0000 are never issued.
 */
function usSsn(text: string): boolean {
  return anyMatch(text, /(?<![\d-])(\d{3})([- ])(\d{2})\2(\d{4})(?![\d-])(?![ ]\d)/g, (m) => {
    const area = Number(m[1]);
    return area !== 0 && area !== 666 && area < 900 && m[3] !== "00" && m[4] !== "0000";
  });
}

/**
 * United Kingdom National Insurance number: two letters, six digits, a suffix letter A–D. The first letter is
 * never D, F, I, Q, U or V, the second never D, F, I, O, Q, U or V, and the pairs BG, GB, NK, KN, TN, NT and ZZ
 * are not issued.
 */
function ukNino(text: string): boolean {
  return anyMatch(text, /(?<![A-Za-z0-9])([A-Za-z]{2}) ?(\d{2}) ?(\d{2}) ?(\d{2}) ?[A-Da-d](?![A-Za-z0-9])/g, (m) => {
    const prefix = m[1]!.toUpperCase();
    return !/[DFIQUV]/.test(prefix[0]!) && !/[DFIOQUV]/.test(prefix[1]!) && !["BG", "GB", "NK", "KN", "TN", "NT", "ZZ"].includes(prefix);
  });
}

/** People's Republic of China resident identity card: 18 characters, a birth date in them, ISO 7064 MOD 11-2. */
function cnResidentId(text: string): boolean {
  return anyMatch(
    text,
    /(?<![A-Za-z0-9])([1-9]\d{5})((?:18|19|20)\d{2})(\d{2})(\d{2})(\d{3})([\dXx])(?![A-Za-z0-9])/g,
    (m) => {
      if (!realDate(Number(m[2]), Number(m[3]), Number(m[4]))) return false;
      const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
      const body = `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}`;
      const sum = [...body].reduce((total, digit, i) => total + Number(digit) * weights[i]!, 0);
      return "10X98765432"[sum % 11] === m[6]!.toUpperCase();
    },
  );
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

/** The Verhoeff checksum: the whole number, check digit last, reduces to 0. */
export function verhoeff(digits: string): boolean {
  let c = 0;
  [...digits].reverse().forEach((digit, i) => {
    c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![Number(digit)]!]!;
  });
  return c === 0;
}

/** India's Aadhaar: twelve digits in three groups of four, never starting 0 or 1, Verhoeff-checked. */
function inAadhaar(text: string): boolean {
  return anyMatch(text, new RegExp(`${NUMBER_START}([2-9]\\d{3})([ -])(\\d{4})\\2(\\d{4})${NUMBER_END}`, "g"), (m) =>
    verhoeff(`${m[1]}${m[3]}${m[4]}`),
  );
}

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

/** Spain: the DNI (eight digits and a letter) and the NIE (X, Y or Z, seven digits and a letter), both mod 23. */
function esDni(text: string): boolean {
  return anyMatch(
    text,
    /(?<![A-Za-z0-9])(?:(\d{8})-?([A-Za-z])|([XYZxyz])-?(\d{7})-?([A-Za-z]))(?![A-Za-z0-9])/g,
    (m) => {
      const [digits, letter] =
        m[1] !== undefined
          ? [m[1], m[2]!]
          : [`${"XYZ".indexOf(m[3]!.toUpperCase())}${m[4]}`, m[5]!];
      return DNI_LETTERS[Number(digits) % 23] === letter.toUpperCase();
    },
  );
}

/** The value of an odd-position character of a codice fiscale: digits 0–9, then letters A–Z. */
const CF_ODD: readonly number[] = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];

/** A character's place for the odd-position table: digits count as the first ten letters (0→A … 9→J). */
function cfOdd(character: string): number {
  return CF_ODD[/\d/.test(character) ? Number(character) : character.charCodeAt(0) - 65]!;
}

/** Italy's codice fiscale: sixteen characters in a fixed pattern, the last a check letter. */
function itCodiceFiscale(text: string): boolean {
  return anyMatch(text, /(?<![A-Za-z0-9])[A-Za-z]{6}\d{2}[A-EHLMPR-Ta-ehlmpr-t]\d{2}[A-Za-z]\d{3}[A-Za-z](?![A-Za-z0-9])/g, (m) => {
    const code = m[0].toUpperCase();
    let sum = 0;
    for (let i = 0; i < 15; i += 1) {
      const character = code[i]!;
      sum += i % 2 === 0 ? cfOdd(character) : /\d/.test(character) ? Number(character) : character.charCodeAt(0) - 65;
    }
    return String.fromCharCode(65 + (sum % 26)) === code[15];
  });
}

/** Brazil's CPF, `123.456.789-09`, both check digits right and not one digit repeated. */
function brCpf(text: string): boolean {
  return anyMatch(text, /(?<![\d.-])(\d{3})\.(\d{3})\.(\d{3})-(\d{2})(?![\d-])/g, (m) => {
    const digits = `${m[1]}${m[2]}${m[3]}${m[4]}`;
    if (/^(\d)\1+$/.test(digits)) return false;
    const check = (length: number): number => {
      const sum = [...digits.slice(0, length)].reduce((total, digit, i) => total + Number(digit) * (length + 1 - i), 0);
      return ((sum * 10) % 11) % 10;
    };
    return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
  });
}

/** Singapore NRIC and FIN: S, T, F or G, seven digits, and a check letter. */
function sgNric(text: string): boolean {
  return anyMatch(text, /(?<![A-Za-z0-9])([STFGstfg])(\d{7})([A-Za-z])(?![A-Za-z0-9])/g, (m) => {
    const series = m[1]!.toUpperCase();
    const weights = [2, 7, 6, 5, 4, 3, 2];
    const sum = [...m[2]!].reduce((total, digit, i) => total + Number(digit) * weights[i]!, 0) + (series === "T" || series === "G" ? 4 : 0);
    const letters = series === "S" || series === "T" ? "JZIHGFEDCBA" : "XWUTRQPNMLK";
    return letters[sum % 11] === m[3]!.toUpperCase();
  });
}

const TW_LETTERS = "ABCDEFGHJKLMNPQRSTUVXYWZIO";

/** Taiwan's national identification card: a letter, 1 or 2, eight digits, a weighted check. */
function twNationalId(text: string): boolean {
  return anyMatch(text, /(?<![A-Za-z0-9])([A-Z])([12])(\d{8})(?![A-Za-z0-9])/g, (m) => {
    const code = TW_LETTERS.indexOf(m[1]!) + 10;
    const digits = [Math.floor(code / 10), code % 10, Number(m[2]), ...[...m[3]!].map(Number)];
    const weights = [1, 9, 8, 7, 6, 5, 4, 3, 2, 1, 1];
    return digits.reduce((total, digit, i) => total + digit * weights[i]!, 0) % 10 === 0;
  });
}

/**
 * Korea's resident registration number, `YYMMDD-NNNNNNN`: a birth date that is on the calendar and a first
 * digit 1–8. The last digit was a checksum until 2020 and is not any more, so it is not checked.
 */
function krResidentNumber(text: string): boolean {
  return anyMatch(text, /(?<![\d-])(\d{2})(\d{2})(\d{2})-([1-8])\d{6}(?![\d-])/g, (m) => {
    const century = Number(m[4]) <= 2 || (Number(m[4]) >= 5 && Number(m[4]) <= 6) ? 1900 : 2000;
    return realDate(century + Number(m[1]), Number(m[2]), Number(m[3]));
  });
}

/** France's number of social security (INSEE): 15 characters, a birth month, department 2A/2B for Corsica, key 97. */
function frInsee(text: string): boolean {
  return anyMatch(
    text,
    /(?<![A-Za-z0-9])([12]) ?(\d{2}) ?(0[1-9]|1[0-2]) ?(\d{2}|2[AaBb]) ?(\d{3}) ?(\d{3}) ?(\d{2})(?![A-Za-z0-9])/g,
    (m) => {
      const department = m[4]!.toUpperCase() === "2A" ? "19" : m[4]!.toUpperCase() === "2B" ? "18" : m[4]!;
      const body = Number(`${m[1]}${m[2]}${m[3]}${department}${m[5]}${m[6]}`);
      return 97 - (body % 97) === Number(m[7]);
    },
  );
}

/** Sweden's personnummer, `YYMMDD-NNNC` or with the century, the date on the calendar (or coordination day +60), Luhn. */
function sePersonnummer(text: string): boolean {
  return anyMatch(text, /(?<![\d-])((?:19|20)?)(\d{2})(\d{2})(\d{2})[-+](\d{4})(?![\d-])/g, (m) => {
    const day = Number(m[4]) > 60 ? Number(m[4]) - 60 : Number(m[4]);
    // Without the century either one may be meant, so either one may make the date real.
    const years = m[1] === "" ? [1900 + Number(m[2]), 2000 + Number(m[2])] : [Number(`${m[1]}${m[2]}`)];
    return years.some((year) => realDate(year, Number(m[3]), day)) && luhn(`${m[2]}${m[3]}${m[4]}${m[5]}`);
  });
}

const CURP_STATES = new Set(["AS", "BC", "BS", "CC", "CL", "CM", "CS", "CH", "DF", "DG", "GT", "GR", "HG", "JC", "MC", "MN", "MS", "NT", "NL", "OC", "PL", "QT", "QR", "SP", "SL", "SR", "TC", "TS", "TL", "VZ", "YN", "ZS", "NE"]);

/** Mexico's CURP: eighteen characters — name letters, birth date, sex, state, consonants — and a check digit. */
function mxCurp(text: string): boolean {
  return anyMatch(
    text,
    /(?<![A-Za-z0-9])[A-Z]{4}(\d{2})(\d{2})(\d{2})[HM]([A-Z]{2})[B-DF-HJ-NP-TV-Z]{3}[A-Z0-9]\d(?![A-Za-z0-9])/g,
    (m) => {
      if (!CURP_STATES.has(m[4]!)) return false;
      // The century is not in the date: 1900s and 2000s are both tried, so a leap day is not turned away.
      if (!realDate(1900 + Number(m[1]), Number(m[2]), Number(m[3])) && !realDate(2000 + Number(m[1]), Number(m[2]), Number(m[3]))) return false;
      const dictionary = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";
      const sum = [...m[0].slice(0, 17)].reduce((total, character, i) => total + dictionary.indexOf(character) * (18 - i), 0);
      return (10 - (sum % 10)) % 10 === Number(m[0][17]);
    },
  );
}

/** Russia's SNILS, `112-233-445 95`: nine digits and a two-digit control number. */
function ruSnils(text: string): boolean {
  return anyMatch(text, /(?<![\d-])(\d{3})-(\d{3})-(\d{3})[ -](\d{2})(?![\d-])/g, (m) => {
    const number = `${m[1]}${m[2]}${m[3]}`;
    if (number <= "001001998") return false;
    const sum = [...number].reduce((total, digit, i) => total + Number(digit) * (9 - i), 0);
    const control = sum < 100 ? sum : sum > 101 ? (sum % 101 === 100 ? 0 : sum % 101) : 0;
    return control === Number(m[4]);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Passports
// ---------------------------------------------------------------------------------------------------------------

/** ICAO 9303 check digit over a field of the machine-readable zone: weights 7, 3, 1; letters 10–35; `<` is 0. */
export function mrzCheck(field: string): number {
  const weights = [7, 3, 1];
  return (
    [...field].reduce((total, character, i) => {
      const value = /\d/.test(character) ? Number(character) : character === "<" ? 0 : character.charCodeAt(0) - 55;
      return total + value * weights[i % 3]!;
    }, 0) % 10
  );
}

/**
 * The second line of a passport's machine-readable zone (44 characters, TD3) or of an identity card's (30, TD1):
 * the date of birth and of expiry each with a check digit that must be right — and, on a passport, the document
 * number's too.
 */
function passportMrz(text: string): boolean {
  const passport = anyMatch(
    text,
    /(?<![A-Z0-9<])([A-Z0-9<]{9})(\d)[A-Z<]{3}(\d{6})(\d)[MF<](\d{6})(\d)[A-Z0-9<]{14}[\d<]\d(?![A-Z0-9<])/g,
    (m) => mrzCheck(m[1]!) === Number(m[2]) && mrzCheck(m[3]!) === Number(m[4]) && mrzCheck(m[5]!) === Number(m[6]),
  );
  return (
    passport ||
    anyMatch(
      text,
      /(?<![A-Z0-9<])(\d{6})(\d)[MF<](\d{6})(\d)[A-Z<]{3}[A-Z0-9<]{11}\d(?![A-Z0-9<])/g,
      (m) => mrzCheck(m[1]!) === Number(m[2]) && mrzCheck(m[3]!) === Number(m[4]),
    )
  );
}

/** The word for passport in the languages most written, matched where there is no word boundary to rely on. */
const PASSPORT_WORDS =
  "(?:\\b(?:passports?|passeports?|reisepass|pasaportes?|passaportes?|passaporto|paszport|pasaport|paspoort)\\b|паспорт|护照|護照|パスポート|旅券|여권|หนังสือเดินทาง|พาสปอร์ต|جواز سفر|پاسپورت|पासपोर्ट|διαβατήριο|דרכון)";

/**
 * A passport number written just after the word for passport: one or two letters and six to eight digits
 * (`AA1234567`, `X12345678`), or nine digits. Nothing else is taken for a passport number: no pattern for a bare
 * `AB1234567` stays quiet on ordinary text.
 */
function passportNumber(text: string): boolean {
  return anyMatch(
    text,
    new RegExp(`${PASSPORT_WORDS}[^\\n\\r]{0,24}?(?<![A-Za-z0-9])([A-Za-z]{1,2}\\d{6,8}|\\d{9})(?![A-Za-z0-9])`, "giu"),
    () => true,
  );
}

/** Every shape in this file, in the order `mind egress check` lists them. */
export const INTERNATIONAL_SHAPES: readonly Shape[] = [
  { rule: "phone-e164", says: "a phone number with a country code (+44 20 7946 0958): an assigned code, 8 to 15 digits", find: phoneE164 },
  { rule: "phone-nanp", says: "a North American phone number with its separators ((415) 555-2671)", find: phoneNanp },
  { rule: "iban", says: "an IBAN (GB82 WEST 1234 5698 7654 32): a registered country, its length, mod-97 checksum", find: iban },
  { rule: "us-ssn", says: "a US social security number (123-45-6789) in an issued range", find: usSsn },
  { rule: "uk-nino", says: "a UK National Insurance number (QQ is not one; AB 12 34 56 C is)", find: ukNino },
  { rule: "cn-resident-id", says: "a Chinese resident identity card number: a real birth date and the MOD 11-2 check", find: cnResidentId },
  { rule: "in-aadhaar", says: "an Indian Aadhaar number (2345 6789 0124): three groups of four, Verhoeff check", find: inAadhaar },
  { rule: "es-dni", says: "a Spanish DNI or NIE: digits and the mod-23 letter", find: esDni },
  { rule: "it-codice-fiscale", says: "an Italian codice fiscale: sixteen characters and the check letter", find: itCodiceFiscale },
  { rule: "br-cpf", says: "a Brazilian CPF (123.456.789-09): both check digits", find: brCpf },
  { rule: "sg-nric", says: "a Singapore NRIC or FIN: S, T, F or G, seven digits, the check letter", find: sgNric },
  { rule: "tw-national-id", says: "a Taiwan national ID: a letter, 1 or 2, eight digits, the weighted check", find: twNationalId },
  { rule: "kr-resident-number", says: "a Korean resident registration number (YYMMDD-NNNNNNN) with a real birth date", find: krResidentNumber },
  { rule: "fr-insee", says: "a French social security number (INSEE): 15 characters and the key of 97", find: frInsee },
  { rule: "se-personnummer", says: "a Swedish personnummer (YYMMDD-NNNC): a real date and the Luhn check", find: sePersonnummer },
  { rule: "mx-curp", says: "a Mexican CURP: eighteen characters, a state, a real date, the check digit", find: mxCurp },
  { rule: "ru-snils", says: "a Russian SNILS (112-233-445 95): nine digits and the control number", find: ruSnils },
  { rule: "passport-mrz", says: "the machine-readable zone of a passport or identity card, check digits right", find: passportMrz },
  { rule: "passport-number", says: "a passport number written just after the word for passport, in a dozen languages", find: passportNumber },
];
