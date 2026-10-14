/**
 * The block, and the one property everything else rests on.
 *
 * Almost every test here is the same assertion written against a different
 * shape of file: **write the block, take it out again, and get the original
 * bytes back**. Not "the same content" — the same bytes, including the ones
 * that were never there, like a trailing newline the file did not have.
 *
 * The rest are the cases where Mind must refuse rather than do its best. A
 * marker it cannot parse, a block a human edited, a file that mentions the
 * marker in prose: guessing at any of these is how a tool deletes somebody's
 * writing while reporting success.
 */

import { describe, expect, test } from "bun:test";
import { subjectId } from "../../src/types.ts";
import {
  END_MARKER,
  MARKER_NAMESPACE,
  detectEol,
  isMarkerLine,
  locate,
  sha256,
  splice,
  strip,
} from "../../src/soul/block.ts";

const SUBJECT = subjectId("example");
const OTHER = subjectId("other-example");
const BODY = "# Example Keeper\n\n**Role.** Keeps things tidy.";

function write(text: string, subject = SUBJECT, body = BODY): string {
  const result = splice(text, { subject, body });
  if (result.kind !== "spliced") throw new Error(`refused: ${result.reason}`);
  return result.next;
}

describe("round trip", () => {
  const shapes: Record<string, string> = {
    "an empty file": "",
    "no trailing newline": "# Notes\n\nlast line with no newline",
    "one trailing newline": "# Notes\n\nlast line\n",
    "two trailing newlines": "# Notes\n\nlast line\n\n",
    "four trailing newlines": "# Notes\n\nlast line\n\n\n\n",
    "only whitespace": "\n\n",
    "CRLF throughout": "# Notes\r\n\r\nlast line\r\n",
    "CRLF with no trailing newline": "# Notes\r\n\r\nlast line",
    "non-ASCII text": "# บันทึก\n\nบรรทัดสุดท้าย\n",
  };

  for (const [name, original] of Object.entries(shapes)) {
    test(`${name} comes back byte-identical after strip`, () => {
      const next = write(original);
      expect(next).not.toBe(original);
      expect(next.startsWith(original)).toBe(true);

      const stripped = strip(next);
      expect(stripped.kind).toBe("stripped");
      if (stripped.kind !== "stripped") return;
      expect(stripped.text).toBe(original);
      expect(stripped.subject).toBe(SUBJECT);
    });
  }

  test("a CRLF file gets a CRLF block, with no stray bare newline", () => {
    const next = write("# Notes\r\nbody\r\n");
    const added = next.slice("# Notes\r\nbody\r\n".length);
    expect(added).not.toBe("");
    expect(added.replaceAll("\r\n", "")).not.toContain("\n");
    expect(detectEol(next)).toBe("\r\n");
  });
});

describe("splice", () => {
  test("writing the same soul twice changes nothing the second time", () => {
    const once = write("# Notes\n");
    const twice = write(once);
    expect(twice).toBe(once);
  });

  test("a different subject replaces the whole block and says whose it was", () => {
    const first = write("# Notes\n", SUBJECT, "identity A");
    const result = splice(first, { subject: OTHER, body: "identity B" });
    expect(result.kind).toBe("spliced");
    if (result.kind !== "spliced") return;

    expect(result.action).toBe("replace");
    expect(result.replacedSubject).toBe(SUBJECT);
    expect(result.next).not.toContain("identity A");
    expect(result.next).toContain("identity B");
    expect(strip(result.next)).toMatchObject({ kind: "stripped", text: "# Notes\n" });
  });

  test("the same subject replacing its own block is not reported as a takeover", () => {
    const first = write("# Notes\n", SUBJECT, "identity A");
    const result = splice(first, { subject: SUBJECT, body: "identity A2" });
    expect(result.kind).toBe("spliced");
    if (result.kind !== "spliced") return;
    expect(result.action).toBe("replace");
    expect(result.replacedSubject).toBeUndefined();
  });

  test("refuses an identity that contains a marker line", () => {
    const result = splice("# Notes\n", { subject: SUBJECT, body: `before\n${END_MARKER}\nafter` });
    expect(result.kind).toBe("refused");
  });
});

describe("locate", () => {
  test("a file that only talks about the marker has no block", () => {
    const prose =
      `The tool writes \`${MARKER_NAMESPACE}begin ... -->\` into this file.\n` +
      "Indented, it is an example and not a block:\n\n" +
      `    ${END_MARKER}\n`;
    expect(locate(prose)).toEqual({ kind: "absent" });
    expect(strip(prose)).toMatchObject({ kind: "absent" });
  });

  test("an opening marker with no closing one is refused, not guessed at", () => {
    const opened = write("# Notes\n").replace(`${END_MARKER}`, "");
    const found = locate(opened);
    expect(found.kind).toBe("refused");
    if (found.kind !== "refused") return;
    expect(found.reason).toContain("marker");
  });

  test("a closing marker with no opening one is refused", () => {
    expect(locate(`# Notes\n${END_MARKER}\n`).kind).toBe("refused");
  });

  test("two blocks in one file are refused", () => {
    const one = write("# Notes\n");
    expect(locate(one + one).kind).toBe("refused");
  });

  test("a marker in Mind's namespace that Mind cannot parse is refused", () => {
    expect(locate(`# Notes\n${MARKER_NAMESPACE}middle -->\n`).kind).toBe("refused");
  });

  test("hand-edited text inside the block is detected and never overwritten", () => {
    const next = write("# Notes\n");
    const tampered = next.replace("**Role.** Keeps things tidy.", "**Role.** something a human typed");

    const found = locate(tampered);
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    expect(found.block.intact).toBe(false);
    expect(found.block.actualSha).not.toBe(found.block.declaredSha);

    expect(splice(tampered, { subject: SUBJECT, body: BODY }).kind).toBe("refused");
    expect(strip(tampered).kind).toBe("refused");
  });

  test("the marker records the hash of the body it wraps", () => {
    const found = locate(write("# Notes\n"));
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    expect(found.block.declaredSha).toBe(sha256(BODY));
    expect(found.block.body).toBe(BODY);
  });

  test("a lead count that does not fit the file is refused", () => {
    const next = write("# Notes\n").replace(/lead=\d+/, "lead=999");
    expect(locate(next).kind).toBe("refused");
  });

  test("a lead that would swallow real text is refused", () => {
    // lead=1 where the character before the marker is part of the human's
    // last line, not a separator Mind added.
    const next = write("# Notes").replace(/lead=\d+/, "lead=3");
    expect(locate(next).kind).toBe("refused");
  });
});

describe("isMarkerLine", () => {
  test("matches a bare marker line, CRLF included, and nothing indented", () => {
    expect(isMarkerLine(END_MARKER)).toBe(true);
    expect(isMarkerLine(`${END_MARKER}\r`)).toBe(true);
    expect(isMarkerLine(`  ${END_MARKER}`)).toBe(false);
    expect(isMarkerLine(`text \`${END_MARKER}\` text`)).toBe(false);
  });
});
