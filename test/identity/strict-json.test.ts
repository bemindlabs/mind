/**
 * The strict JSON reader signed text goes through (S15.8 security review, L5): what `JSON.parse` accepts it
 * reads to the same value, a duplicate member name anywhere is a refusal, a number is accepted in its one
 * integer spelling only (D-141 §4), and nothing it is given throws.
 */

import { describe, expect, test } from "bun:test";
import { parseJsonStrict } from "../../src/identity/strict-json.ts";

const same = (text: string) => {
  const parsed = parseJsonStrict(text);
  expect(parsed.ok, text).toBe(true);
  if (parsed.ok) expect(parsed.value).toEqual(JSON.parse(text));
};

const refused = (text: string, because: string) => {
  const parsed = parseJsonStrict(text);
  expect(parsed.ok, text).toBe(false);
  if (!parsed.ok) expect(parsed.reason, text).toContain(because);
};

describe("what JSON.parse reads, this reads to the same value", () => {
  test("every kind of value, nesting, escapes and whitespace", () => {
    for (const text of [
      '{"a":1,"b":[true,false,null,"x\\u00e9\\n\\t\\"\\\\\\/\\b\\f\\r",-1500,0,200,10]}',
      " [ ] ",
      "{}",
      '"\\ud83d\\ude00"',
      '{"nested":{"deeper":[{"k":"v"}]}}',
      "0",
      "\n\t\r 7 \n",
      // The integers at the edge of what is signed (D-138): 2^53 − 1 each way.
      "[9007199254740991,-9007199254740991,-1,10,1234567890]",
    ]) same(text);
  });

  test("__proto__ is a member, as JSON.parse makes it, not a prototype", () => {
    const parsed = parseJsonStrict('{"__proto__":{"polluted":true}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const value = parsed.value as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect((value as { polluted?: unknown }).polluted).toBeUndefined();
    expect(value).toEqual(JSON.parse('{"__proto__":{"polluted":true}}'));
  });
});

describe("refused, where JSON.parse would have chosen", () => {
  test("a duplicate member name, at any depth — JSON.parse keeps the last", () => {
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 });
    refused('{"a":1,"a":2}', 'duplicate member name "a"');
    refused('{"x":{"rows":[],"rows":[1]}}', 'duplicate member name "rows"');
    refused('[{"k":1},{"k":1,"k":1}]', "duplicate member name");
    // Different names that only look alike are different names.
    same('{"a":1,"A":2,"\\u0061b":3}');
  });
});

describe("refused, as JSON.parse refuses them — and never a throw", () => {
  test("malformed text of every shape", () => {
    refused("[1,]", "not a JSON value");
    refused("01", "a number with a leading zero");
    refused('"\t"', "raw control character");
    refused('{"a":1} x', "text after the value");
    refused("nul", "not a JSON value");
    refused('"abc', "unterminated string");
    refused('{"a" 1}', 'expected ":"');
    refused("{1:2}", 'expected "\\""');
    refused("[1 2]", 'expected "]"');
    refused('{"a":1 "b":2}', 'expected "}"');
    refused("-", "not a JSON value");
    refused('"\\x"', "bad escape");
    refused('"\\', "bad escape");
    refused('"\\u12"', "bad \\u escape");
    refused("", "not a JSON value");
    for (const text of ["[1,]", "01", "", "{", "[[[", '"\\u'] ) expect(() => JSON.parse(text)).toThrow();
  });

  test("hostile nesting is a reason, not a stack overflow", () => {
    refused(`[${"1".repeat(100_000)}]`, "beyond 2^53 − 1");
    refused("[".repeat(100_000), "nesting deeper than 64");
    refused('{"a":'.repeat(1_000), "nesting deeper than 64");
    same(`${"[".repeat(60)}${"]".repeat(60)}`);
  });
});

describe("numbers in one spelling only — an integer's plain digits (D-141 §4)", () => {
  test("each other spelling of the same integer is refused, where JSON.parse reads it as that integer", () => {
    for (const [text, because] of [
      ["1.0", "fraction or an exponent"],
      ["151250.0", "fraction or an exponent"],
      ["1.5125e5", "fraction or an exponent"],
      ["1e3", "fraction or an exponent"],
      ["1E3", "fraction or an exponent"],
      ["1e+3", "fraction or an exponent"],
      ["1e0", "fraction or an exponent"],
      ["10e-1", "fraction or an exponent"],
      ["0.0", "fraction or an exponent"],
      ["-0", "zero is written 0"],
      ["-0.0", "fraction or an exponent"],
      ["9007199254740992", "beyond 2^53 − 1"],
      ["-9007199254740992", "beyond 2^53 − 1"],
      ["12345678901234567890", "beyond 2^53 − 1"],
    ] as const) {
      expect(() => JSON.parse(text), text).not.toThrow();
      refused(text, because);
      // At depth, and inside the members a signed payload really has.
      refused(`{"payload":{"rows":[{"usd_micros":${text}}]}}`, because);
    }
  });

  test("a fraction is refused, not rounded — payloads are integers only", () => {
    refused("1.5", "fraction or an exponent");
    refused('{"duration_ms":0.5}', "fraction or an exponent");
    refused("-2.25E-7", "fraction or an exponent");
  });

  test("a leading zero and a plus sign are not JSON at all, and say so", () => {
    refused("01", "leading zero");
    refused("-01", "leading zero");
    refused("[00]", "leading zero");
    refused('{"a":007}', "leading zero");
    refused("+1", "not a JSON value");
    refused("[+1]", "not a JSON value");
    for (const text of ["01", "-01", "+1"]) expect(() => JSON.parse(text)).toThrow();
  });

  test("a hostile number is quoted short in the reason", () => {
    const parsed = parseJsonStrict(`${"9".repeat(10_000)}.5`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason.length).toBeLessThan(200);
  });
});
