/** `readEnv`: `MIND_<suffix>` and only that name; an empty string is a value. */

import { describe, expect, test } from "bun:test";
import { readEnv, readMind } from "../src/env.ts";

describe("readEnv", () => {
  test("MIND_X is read", () => {
    expect(readEnv("TOKEN", { MIND_TOKEN: "secret" })).toBe("secret");
  });

  test("neither set is undefined; an empty string is a value, not a gap", () => {
    expect(readEnv("TOKEN", {})).toBeUndefined();
    expect(readEnv("TOKEN", { MIND_TOKEN: "" })).toBe("");
  });

  test("another prefix is not read", () => {
    expect(readEnv("TOKEN", { TOKEN: "x", OTHER_TOKEN: "y" })).toBeUndefined();
  });
});

describe("readMind", () => {
  test("takes the full MIND_* name", () => {
    expect(readMind("MIND_TTL", { MIND_TTL: "5" })).toBe("5");
  });

  test("refuses a name that is not MIND_*: a caller's mistake", () => {
    expect(() => readMind("TTL", { MIND_TTL: "5" })).toThrow("MIND_");
  });
});
