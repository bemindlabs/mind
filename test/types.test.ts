/**
 * `subjectId` — the one piece of runtime behaviour in `src/types.ts`, and the
 * reason this file exists.
 *
 * `SubjectId` is the brand that makes I-3 (identities never bleed) checkable
 * instead of aspirational: a leak needs a `SubjectId` to have been passed, and
 * every call site that passes one is greppable. All of that rests on the brand
 * being unforgeable at the edge — which is `subjectId()` refusing a value that
 * is not a safe directory name.
 *
 * Until the coverage gate grew a per-file line floor, that refusal had no test
 * on it. The file scored 70% and passed anyway, because some other test had
 * imported a *type* from it and "loaded" was the whole question the gate asked.
 * The three uncovered lines were the `throw`. This is what the floor is for.
 *
 * Every id below is synthetic (D-021): no real subject, no real path.
 */

import { describe, expect, test } from "bun:test";
import {
  countPersonal,
  flagPersonal,
  isSubjectId,
  subjectId,
  tokenCount,
  UNREPORTED_USAGE,
  type CountTally,
} from "../src/types.ts";

describe("subjectId", () => {
  test("accepts the shapes a directory name can take", () => {
    // Read back as `string`: the brand is compile-time only, so the value that
    // comes out is the same string that went in, unchanged.
    for (const value of ["a", "0", "alice", "role-editor", "role_editor", "a1-b2_c3"]) {
      expect(subjectId(value) as string).toBe(value);
    }
  });

  test("accepts exactly 64 characters, and refuses 65", () => {
    // The boundary is load-bearing: it is the point where a valid id becomes a
    // path segment some filesystem may truncate rather than reject.
    expect(subjectId("a".repeat(64)) as string).toBe("a".repeat(64));
    expect(() => subjectId("a".repeat(65))).toThrow(TypeError);
  });

  test("refuses anything that is not a safe path segment", () => {
    for (
      const value of [
        "", // nothing at all
        "Alice", // uppercase — two ids differing only by case collide on a case-insensitive filesystem
        "-alice", // leading dash reads as a flag to every CLI it is passed to
        "_alice", // same class: the first character is deliberately narrower
        "al ice", // a space
        "al/ice", // a separator — the whole point of the alphabet
        "..", // the parent directory
        "alice\n", // a trailing newline, which a regex without anchors would let through
      ]
    ) {
      expect(() => subjectId(value)).toThrow(TypeError);
    }
  });

  test("says what it rejected, so the error is actionable", () => {
    // Quoted, so an id that is empty or whitespace is visible in the message.
    expect(() => subjectId("")).toThrow('invalid subject id ""');
  });
});

describe("isSubjectId", () => {
  test("answers the same question as subjectId, without throwing", () => {
    expect(isSubjectId("role-editor")).toBe(true);
    expect(isSubjectId("Alice")).toBe(false);
    expect(isSubjectId("")).toBe(false);
  });

  test("is false for values that are not strings at all", () => {
    for (const value of [undefined, null, 42, {}, ["alice"]]) {
      expect(isSubjectId(value)).toBe(false);
    }
  });
});

describe("tokenCount", () => {
  test("accepts whole counts, zero included", () => {
    // Zero is a count a vendor can genuinely print, and it has to survive the
    // trip as a number — collapsing it to null would turn a real measurement
    // into "nobody reported", which is the one confusion the usage states
    // exist to prevent.
    for (const value of [0, 1, 2, 80_951, Number.MAX_SAFE_INTEGER]) {
      expect(tokenCount(value)).toBe(value);
    }
  });

  test("refuses everything a tokenizer cannot produce", () => {
    // A quoted number is the shape a vendor takes on the day it changes its
    // output, and coercing it would mean a format change never shows up as
    // one. The rest cannot come from counting.
    for (
      const value of [
        "123",
        "",
        null,
        undefined,
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 2,
        {},
        [4],
        true,
      ]
    ) {
      expect(tokenCount(value)).toBeNull();
    }
  });
});

/**
 * `countPersonal` — the second way out of the box, and the one that cannot
 * carry text.
 *
 * The property every test here circles is one sentence: **every key in the
 * output came from the vocabulary, and every value is a count.** So the
 * adversarial cases are the interesting ones — a boxed path, a boxed string
 * instead of records, a field holding something that is not a string — and in
 * each the question is the same: did anything from inside the box get out?
 *
 * Every value below is invented (D-021): no real path, no real project.
 */
describe("countPersonal", () => {
  /** Two tallies over a shape like a capture record, with a named `other` bucket. */
  const TALLIES: readonly CountTally[] = [
    { key: { parts: [{ field: "at", take: "month" }, { literal: "kind" }, { field: "kind" }] } },
    {
      key: { parts: [{ literal: "tool" }, { field: "tool" }] },
      otherwise: { parts: [{ literal: "tool" }, { literal: "other" }] },
    },
    {
      key: {
        parts: [{ literal: "program" }, { field: "target", take: "first-word" }],
      },
      otherwise: { parts: [{ literal: "program" }, { literal: "other" }] },
    },
  ];

  const VOCABULARY = [
    "2026-09|kind|file-edit",
    "2026-09|kind|command",
    "2026-08|kind|command",
    "tool|Edit",
    "tool|Bash",
    "tool|other",
    "program|git",
    "program|other",
  ] as const;

  const record = (fields: Record<string, unknown>) => ({
    at: "2026-09-21T10:00:00.000Z",
    kind: "tool",
    tool: "Read",
    target: "",
    ...fields,
  });

  test("it counts over the vocabulary, and every unseen word is 0 rather than absent", () => {
    const counts = countPersonal(
      flagPersonal([
        record({ kind: "file-edit", tool: "Edit", target: "src/a.ts" }),
        record({ kind: "command", tool: "Bash", target: "git commit" }),
        record({ kind: "command", tool: "Bash", target: "git push" }),
      ]),
      TALLIES,
      VOCABULARY,
    );

    expect(counts["2026-09|kind|file-edit"]).toBe(1);
    expect(counts["2026-09|kind|command"]).toBe(2);
    expect(counts["tool|Edit"]).toBe(1);
    expect(counts["tool|Bash"]).toBe(2);
    expect(counts["program|git"]).toBe(2);
    // A month with a file and no records reports 0. "Nothing happened then" and
    // "this release stopped counting it" are different facts.
    expect(counts["2026-08|kind|command"]).toBe(0);
    // `src/a.ts` is not a program name, so it lands in the named bucket.
    expect(counts["program|other"]).toBe(1);
  });

  test("the keys are exactly the vocabulary — a path cannot become one", () => {
    const counts = countPersonal(
      flagPersonal([
        // Every string here is something that must never reach a caller: a
        // client's directory, a server name that is a company, a session id.
        record({
          kind: "file-edit",
          tool: "mcp__acme__write",
          target: "clients/acme-corp/report.ts",
          project: "/invented/home/someone/work",
          session: "9f3c-secret-session",
        }),
      ]),
      TALLIES,
      VOCABULARY,
    );

    expect(Object.keys(counts).sort()).toEqual([...VOCABULARY].sort());

    const serialised = JSON.stringify(counts);
    for (const leak of ["acme", "someone", "9f3c", "report.ts", "clients"]) {
      expect(serialised, leak).not.toContain(leak);
    }
    // And it was counted, under the words the caller supplied.
    expect(counts["tool|other"]).toBe(1);
    expect(counts["program|other"]).toBe(1);
  });

  test("every value is a non-negative whole number, whatever the fields held", () => {
    const counts = countPersonal(
      flagPersonal([
        record({ kind: "command", tool: "Bash", target: "git status" }),
        // Fields that are not strings: a tally cannot read them, so this record
        // contributes to nothing rather than to a key called "undefined".
        record({ kind: 7, tool: { name: "Edit" }, target: ["git", "log"] }),
      ]),
      TALLIES,
      VOCABULARY,
    );

    for (const [word, count] of Object.entries(counts)) {
      expect(Number.isSafeInteger(count), `${word} = ${String(count)}`).toBe(true);
      expect(count, word).toBeGreaterThanOrEqual(0);
    }
    expect(counts["2026-09|kind|command"]).toBe(1);
    expect(counts["program|git"]).toBe(1);
    // The second record composed no key at all, so not even `other` moved.
    expect(counts["tool|other"]).toBe(0);
  });

  test("a boxed string, or anything that is not a list of objects, yields zeros", () => {
    // The smuggling case: `Personal<string[]>` type-checks against
    // `Personal<readonly unknown[]>`, and there is nothing in it to read.
    const counts = countPersonal(
      flagPersonal(["what the owner typed", 42, null, ["nested"]]),
      TALLIES,
      VOCABULARY,
    );

    expect(Object.values(counts).every((count) => count === 0)).toBe(true);
    expect(JSON.stringify(counts)).not.toContain("what the owner typed");
  });

  test("an empty vocabulary is an empty result, not a leak", () => {
    const counts = countPersonal(flagPersonal([record({})]), TALLIES, []);
    expect(counts).toEqual({});
  });

  test("`otherwise` is only reached when the composed key is unknown", () => {
    const tallies: readonly CountTally[] = [
      {
        key: { parts: [{ literal: "tool" }, { field: "tool" }] },
        otherwise: { parts: [{ literal: "tool" }, { literal: "other" }] },
      },
    ];
    const counts = countPersonal(
      flagPersonal([record({ tool: "Edit" }), record({ tool: "SomethingElse" })]),
      tallies,
      ["tool|Edit", "tool|other"],
    );

    expect(counts["tool|Edit"]).toBe(1);
    expect(counts["tool|other"]).toBe(1);
  });

  test("a tally with no `otherwise` counts nothing rather than everything", () => {
    const tallies: readonly CountTally[] = [
      { key: { parts: [{ literal: "vendor" }, { field: "vendor" }] } },
    ];
    const counts = countPersonal(
      flagPersonal([record({ vendor: "claude" }), record({ vendor: "somebody-elses-cli" })]),
      tallies,
      ["vendor|claude"],
    );

    expect(counts).toEqual({ "vendor|claude": 1 });
  });

  test("`month` and `first-word` are the only reductions, and they are blunt", () => {
    const counts = countPersonal(
      flagPersonal([
        // `month` is seven characters of an ISO instant. A value that is not one
        // yields seven characters that are in no vocabulary, and is counted
        // nowhere — which is how a record with a broken timestamp shows up.
        record({ at: "not a timestamp", kind: "command" }),
        record({ at: "2026-09-01T00:00:00.000Z", kind: "command" }),
      ]),
      [TALLIES[0] as CountTally],
      VOCABULARY,
    );

    expect(counts["2026-09|kind|command"]).toBe(1);
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(1);
  });
});

describe("UNREPORTED_USAGE", () => {
  test("is all nulls under a status that says nobody reported", () => {
    expect(UNREPORTED_USAGE).toEqual({
      status: "unreported",
      input: null,
      output: null,
      total: null,
      cache_read: null,
      cache_write: null,
      cache_write_5m: null,
      cache_write_1h: null,
    });
    // No `not_printed`: nobody has surveyed what such a backend prints, which is
    // not the same as knowing it prints nothing (S15.9).
    expect("not_printed" in UNREPORTED_USAGE).toBe(false);
  });

  test("is frozen, because it is shared by every line that has no counts", () => {
    // One object reaches many ledger entries. A caller that could mutate it
    // would rewrite turns it never ran.
    expect(Object.isFrozen(UNREPORTED_USAGE)).toBe(true);
  });
});
