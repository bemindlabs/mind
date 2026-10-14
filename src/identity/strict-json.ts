/**
 * JSON read the way a signature needs it read: strictly, and refusing a member name twice in one object
 * (S15.8 security review, L5).
 *
 * `JSON.parse` keeps the last of two members with one name. RFC 8785 forbids duplicates outright, and for a
 * signed document the difference is the whole point: `{"rows":[…unsigned…],"rows":[…signed…]}` verifies under
 * `JSON.parse`, while a reader that keeps the first sees the unsigned rows as if they were signed. So signed
 * text is parsed here, and a duplicate anywhere is a refusal rather than a choice.
 *
 * RFC 8259 exactly: no comments, no trailing commas, no leading zeros, no raw control characters in strings,
 * whitespace only where the grammar allows it. Objects are made the way `JSON.parse` makes them — plain
 * objects with own enumerable properties, `__proto__` included as a property rather than a prototype — so a
 * value read here compares equal to one `JSON.parse` would give. Nesting is limited, so hostile input cannot
 * exhaust the stack. Pure, and it never throws.
 *
 * ## Numbers are written one way only (D-141 §4)
 *
 * Everything Mind signs holds integers and nothing else (D-138), and the canonical form of an integer is its
 * plain decimal digits. So a number is accepted only as that form: `0`, or an optional `-` and digits that do not
 * start with `0`, of magnitude at most 2^53 − 1. Refused, although RFC 8259 allows them and they parse to the
 * same value: a fraction (`1.0`, `1.5`), an exponent (`1e3`, `1E3`, `1e+0`), `-0`, and an integer beyond 2^53 − 1
 * (which no longer reads back as the digits written); `01` and `+1` are refused by the grammar itself.
 *
 * Before this, `"usd_micros":151250.0` and `1.5125e5` verified — the value was equal, so the signature over its
 * canonical form matched — and two texts that are one signed report to Mind could be two different reports to
 * a reader that keeps what it was given. Refusing every other spelling means a signed number has one text —
 * numbers only: strings keep their JSON escapes and whitespace is free, so dedupe on decoded values, never on
 * the raw text. The platform's verifier holds itself to the same rule.
 *
 * Every caller reads integers only: a signed envelope (`report.ts`, `proof.ts`) and the owner's price file
 * (`src/pricing/table.ts`), whose rates are whole micro-dollars and end up in signed rows. Nothing that
 * legitimately holds a fraction may read through here; `JSON.parse` is for that.
 */

export type StrictParsed = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };

const MAX_DEPTH = 64;
/** RFC 8259's number: what the grammar allows, before the rule below narrows it. */
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
/** The one spelling of an integer: `0`, or digits with no leading zero, with an optional `-`. */
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;
const LITERALS: readonly (readonly [string, boolean | null])[] = [
  ["true", true],
  ["false", false],
  ["null", null],
];
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

class Refused extends Error {}

export function parseJsonStrict(text: string): StrictParsed {
  let at = 0;

  const fail = (what: string): never => {
    throw new Refused(`${what} at character ${at}`);
  };
  const space = () => {
    while (at < text.length && (text[at] === " " || text[at] === "\t" || text[at] === "\n" || text[at] === "\r")) at++;
  };
  const expect = (literal: string) => {
    if (text.startsWith(literal, at)) at += literal.length;
    else fail(`expected ${JSON.stringify(literal)}`);
  };

  const string = (): string => {
    expect('"');
    let out = "";
    for (;;) {
      if (at >= text.length) fail("an unterminated string");
      const char = text[at]!;
      if (char === '"') {
        at++;
        return out;
      }
      if (char < " ") fail("a raw control character in a string");
      if (char !== "\\") {
        out += char;
        at++;
        continue;
      }
      const escape = text[at + 1];
      if (escape === "u") {
        const hex = text.slice(at + 2, at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("a bad \\u escape");
        out += String.fromCharCode(Number.parseInt(hex, 16));
        at += 6;
        continue;
      }
      const decoded = escape === undefined ? undefined : ESCAPES[escape];
      if (decoded === undefined) fail("a bad escape");
      out += decoded;
      at += 2;
    }
  };

  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) fail(`nesting deeper than ${MAX_DEPTH}`);
    space();
    const char = text[at];
    if (char === "{") {
      at++;
      const object: Record<string, unknown> = {};
      const names = new Set<string>();
      space();
      if (text[at] === "}") {
        at++;
        return object;
      }
      for (;;) {
        space();
        const name = string();
        if (names.has(name)) fail(`a duplicate member name ${JSON.stringify(name)}`);
        names.add(name);
        space();
        expect(":");
        const member = value(depth + 1);
        Object.defineProperty(object, name, { value: member, enumerable: true, writable: true, configurable: true });
        space();
        if (text[at] === ",") {
          at++;
          continue;
        }
        expect("}");
        return object;
      }
    }
    if (char === "[") {
      at++;
      const array: unknown[] = [];
      space();
      if (text[at] === "]") {
        at++;
        return array;
      }
      for (;;) {
        array.push(value(depth + 1));
        space();
        if (text[at] === ",") {
          at++;
          continue;
        }
        expect("]");
        return array;
      }
    }
    if (char === '"') return string();
    for (const [literal, meaning] of LITERALS) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return meaning;
      }
    }
    NUMBER.lastIndex = at;
    const number = NUMBER.exec(text);
    if (number === null) return fail("not a JSON value");
    return integer(number[0]);
  };

  /** A number the grammar allowed, if it is also the one spelling of an integer; `at` is where it starts. */
  const integer = (written: string): number => {
    if (/^-?0[0-9]/.test(text.slice(at, at + written.length + 1))) fail("a number with a leading zero");
    // Quoted short: the digits of a hostile number are not worth a megabyte of reason.
    const shown = written.length > 24 ? `${written.slice(0, 24)}…` : written;
    if (!INTEGER.test(written)) fail(`the number ${shown}, which has a fraction or an exponent — signed numbers are integers in plain digits`);
    if (written === "-0") fail("the number -0 — zero is written 0");
    const read = Number(written);
    if (!Number.isSafeInteger(read)) fail(`the number ${shown}, which is beyond 2^53 − 1 and does not read back as written`);
    at += written.length;
    return read;
  };

  try {
    const parsed = value(0);
    space();
    if (at !== text.length) fail("text after the value");
    return { ok: true, value: parsed };
  } catch (error) {
    // `Refused` is the grammar's; anything else would be a bug here, and is still an answer rather than a throw.
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
