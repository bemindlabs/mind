import { describe, expect, test } from "bun:test";
import { classify } from "../../src/exec/backend.ts";

/**
 * These exist because of a bug found by running `soul verify` for real, in a
 * file this project's own coverage gate had already flagged as untested — and
 * which was then exempted as debt to deal with later. The gate was right.
 */
describe("classify", () => {
  test("a reply with a clean exit is a reply", () => {
    expect(classify("friend", 0)).toBe("confirmed");
  });

  test("an empty reply is silence, not a wrong answer", () => {
    expect(classify("", 0)).toBe("silent");
    expect(classify("   \n  ", 0)).toBe("silent");
  });

  test("a non-zero exit is silence even when the CLI printed something", () => {
    // The regression. `claude -p` with no credentials prints "Not logged in ·
    // Please run /login" and exits 1. Read as an answer, that became "the
    // model replied, but not from this soul" — and `soul verify` went on to
    // blame the identity channel for what was a login problem. The CLI never
    // took the turn; nothing it printed is a reply.
    expect(classify("Not logged in · Please run /login", 1)).toBe("silent");
    expect(classify("error: unknown option '--nope'", 2)).toBe("silent");
  });

  test("never returns `failed` — this layer cannot know an answer is wrong", () => {
    // Judging content needs to know what was asked, which only the caller
    // does. A backend that returns `failed` here would be claiming knowledge
    // it does not have, and callers would trust it.
    //
    // The return type now says so too — `"confirmed" | "silent"`, not
    // `Confidence` — so a `failed` added to this function no longer reaches
    // this assertion: `tsc` refuses it, and so does every caller that tried to
    // compare against it. The cases below stay because a type says what the
    // function may return and not what it does return.
    const outcomes = new Set(
      [
        ["", 0],
        ["text", 0],
        ["text", 1],
        ["", 1],
        ["text", undefined],
      ].map(([text, code]) => classify(text as string, code as number | undefined)),
    );
    expect([...outcomes].sort()).toEqual(["confirmed", "silent"]);
  });

  test("an unknown exit code with text is still a reply", () => {
    // A backend that cannot report an exit code (an HTTP call, say) passes
    // undefined. Absence of a code is not evidence of failure.
    expect(classify("friend", undefined)).toBe("confirmed");
  });
});
