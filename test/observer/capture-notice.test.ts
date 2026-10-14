/**
 * S7.2 AC4 for the observer — "แจ้งก่อน" enforced by a type rather than by a
 * habit.
 *
 * AC4 says the things that cannot be deleted must be disclosed *before*, not
 * discovered when somebody asks to delete. For raw capture, "before" means
 * before the directory that holds the records exists — and the only way to make
 * that a property of the program rather than a convention w4 has to remember is
 * to make the disclosure a **value** `ensureObserverDir` requires.
 *
 * So `announceCapture(write)` is the one constructor of `CaptureNotice`, and
 * three things are checked here:
 *
 * 1. calling it really writes `OBSERVER_UNDELETABLE` somewhere;
 * 2. `ensureObserverDir` without one does not compile, demonstrated with
 *    `@ts-expect-error` rather than described;
 * 3. no file outside `src/observer/store.ts` says `as CaptureNotice`, because
 *    a cast would turn the whole mechanism off in one keystroke with nothing in
 *    review to catch the eye — the same gate `test/guard/personal-type.test.ts`
 *    puts around `Personal<T>`.
 *
 * **What it does not prove, and the code says so too:** that anybody read the
 * lines. A type can witness a call; no type can witness a reading. That limit
 * is in `OBSERVER_LIMITS`, asserted at the bottom, so deleting it breaks a test
 * rather than quietly widening the claim.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  announceCapture,
  CAPTURE_NOTICE_HEADING,
  ensureObserverDir,
  OBSERVER_LIMITS,
  OBSERVER_UNDELETABLE,
} from "../../src/observer/store.ts";
import { subjectId } from "../../src/types.ts";
import { assertionEscapes, sourceFiles } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const SUBJECT = subjectId("example");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-notice-"));
  scratch.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// The constructor
// ---------------------------------------------------------------------------

describe("announceCapture", () => {
  test("it writes the heading and every undeletable line, in order", () => {
    const written: string[] = [];
    announceCapture((line) => written.push(line));

    expect(written[0]).toBe(CAPTURE_NOTICE_HEADING);
    expect(written.length).toBe(OBSERVER_UNDELETABLE.length + 1);
    for (const [index, note] of OBSERVER_UNDELETABLE.entries()) {
      expect(written[index + 1]).toBe(`  - ${note}`);
    }
  });

  test("Mind does not choose the channel, only that there was one", () => {
    // A test's array, a log file, `console.log` — the notice is about the lines
    // having been handed somewhere, and forcing stdout would have made this
    // untestable and w4 unable to log it.
    const lines: string[] = [];
    const notice = announceCapture((line) => lines.push(line));
    expect(notice).toBeObject();
    expect(Object.isFrozen(notice)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The door it guards
// ---------------------------------------------------------------------------

describe("ensureObserverDir", () => {
  test("the capture directory cannot be created without one", async () => {
    const home = await sandbox();
    const env = { home, env: { XDG_DATA_HOME: join(home, "data") } };

    // The whole mechanism, as a compile error. w4 cannot reach this function
    // without having called `announceCapture` first.
    // @ts-expect-error — a CaptureNotice is required, and only announceCapture mints one
    void (() => ensureObserverDir(env, SUBJECT));
    // @ts-expect-error — and an ordinary object is not one either
    void (() => ensureObserverDir(env, SUBJECT, { announced: true }));

    const created = await ensureObserverDir(env, SUBJECT, announceCapture(() => undefined));
    expect(created.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The gate that keeps the door the only one
// ---------------------------------------------------------------------------

describe("no cast writes its way past the notice", () => {
  /**
   * The one file allowed to say the words that would turn `tsc` off here.
   *
   * `store.ts` mints the brand in `announceCapture`, which is the whole of what
   * AC4 permits. This file is deliberately *not* on the list: a gate that
   * exempts itself in order to demonstrate the bypass has written the bypass.
   */
  const ALLOWED: readonly string[] = [join("src", "observer", "store.ts")];
  const TYPES = ["CaptureNotice"];

  test("`as CaptureNotice` appears in exactly one file", async () => {
    const files = [
      ...(await sourceFiles(join(ROOT, "src"))),
      ...(await sourceFiles(join(ROOT, "test"))),
      // The whole of `bin/`, not the entry point alone: the CLI is several
      // files, and a gate naming one of them would be green over the rest.
      ...(await sourceFiles(join(ROOT, "bin"))),
    ];
    // Guards the gate's own scope: an empty file list would make this vacuous.
    expect(files.length).toBeGreaterThan(40);
    // `src/` and `test/` alone clear 40, so the count cannot see `bin/` go.
    expect(files).toContain(join(ROOT, "bin", "mind.ts"));

    const escapes: string[] = [];
    for (const path of files) {
      const rel = relative(ROOT, path);
      if (ALLOWED.includes(rel)) continue;
      for (const hit of assertionEscapes(path, await Bun.file(path).text(), TYPES, [])) {
        escapes.push(`${rel}:${hit}`);
      }
    }
    expect(escapes).toEqual([]);

    // The reverse: an allowance that stopped being used should not sit on the
    // list forever claiming to cover something.
    for (const rel of ALLOWED) {
      const source = await Bun.file(join(ROOT, rel)).text();
      expect(
        assertionEscapes(join(ROOT, rel), source, TYPES, []).length,
        `${rel} is allowed but says none of the words`,
      ).toBeGreaterThan(0);
    }
  }, 30_000);

  test("the checker catches both syntaxes and ignores the words in prose", () => {
    const caught = (source: string) => assertionEscapes("synthetic.ts", source, TYPES, []);

    expect(caught(`const n = {} as CaptureNotice;`)).not.toEqual([]);
    expect(caught(`const n = <CaptureNotice>{};`)).not.toEqual([]);

    expect(caught(`function f(n: CaptureNotice) {}`)).toEqual([]);
    expect(caught(`// as CaptureNotice would be a bypass`)).toEqual([]);
    expect(caught(`const s = "x as CaptureNotice";`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The size of what this proves
// ---------------------------------------------------------------------------

describe("what the notice does not prove", () => {
  test("the limit is in the engine's own output, not only in this comment", () => {
    const limits = OBSERVER_LIMITS.join("\n");
    expect(limits).toContain("proves a call, not a reading");
    expect(limits).toContain("announceCapture");
    expect(limits).toContain("Mind does not claim it");
  });
});
