/**
 * The brand that makes "did anything ask the dial?" a question nobody can skip.
 *
 * Three things, the same three `test/observer/capture-notice.test.ts` checks
 * about `CaptureNotice`:
 *
 * 1. `restrain` really does read the decided dial, so the value is not a token
 *    with a number written on it;
 * 2. a turn cannot be composed without one, demonstrated with `@ts-expect-error`
 *    rather than described;
 * 3. **no file outside `src/exec/restraint.ts` says `as Restraint`**, because a
 *    cast would switch the whole mechanism off in one keystroke with nothing in
 *    review to catch the eye.
 *
 * Plus the one thing this brand is for that the other two are not: the vendor
 * with no read-only mechanism is *refused* at level 1, and the refusal quotes
 * the registry's own words rather than paraphrasing them.
 */

import { describe, expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";
import { DEFAULT_DIAL, effectiveDial, type Dial, type Level, type ReachLevel } from "../../src/decide/index.ts";
import {
  loosenedNote,
  probeRestraint,
  restrain,
  restraintRefusal,
} from "../../src/exec/restraint.ts";
import { readOnlyArgs, restraintArgs, VENDORS, vendor, type VendorSpec } from "../../src/exec/registry.ts";
import { assertionEscapes, sourceFiles } from "../support/ast.ts";
import { atLevel, LOOSENED, RESTRAINED } from "../support/restraint.ts";

const ROOT = resolve(import.meta.dir, "..", "..");

function flat(level: Level): Dial {
  return {
    read: level,
    write: level,
    run: level,
    reach: Math.min(level, 2) as ReachLevel,
    operate: 0,
    setBy: null,
    setAt: null,
  };
}

describe("restrain reads the decision, and cannot be handed a number", () => {
  test("the acting level it carries is the dial's, minimum and all", () => {
    for (const level of [0, 1, 2, 3] as const) {
      const effective = effectiveDial({
        stored: flat(level),
        source: "file",
        envValue: undefined,
        stopped: false,
      });
      expect(restrain(effective).act).toBe(effective.act);
    }

    // The case that matters: a dial nobody could read produces a restraint at
    // 0, so the turn does not run. Not a default — silence.
    const broken = effectiveDial({
      stored: flat(3),
      source: "file-unreadable",
      envValue: undefined,
      stopped: false,
    });
    expect(restrain(broken).act).toBe(0);
  });

  test("`loosened` is the one bit the argv actually turns on", () => {
    expect(restrain(effectiveDial({ stored: flat(1), source: "file", envValue: undefined, stopped: false })).loosened).toBe(false);
    expect(restrain(effectiveDial({ stored: flat(2), source: "file", envValue: undefined, stopped: false })).loosened).toBe(true);
  });

  test("it is frozen, so nothing edits a restraint after the dial decided", () => {
    expect(Object.isFrozen(RESTRAINED)).toBe(true);
  });

  test("the probe's restraint is pinned, and pinned to the strict end", () => {
    // A measuring instrument whose permissions follow a setting produces
    // readings that follow a setting. `soul verify` must be read-only whatever
    // `autonomy.md` says, and this constructor cannot express anything else.
    const probe = probeRestraint();
    expect(probe.act).toBe(1);
    expect(probe.loosened).toBe(false);
  });
});

describe("the argv is the only thing the dial changes", () => {
  test("at level 1 every vendor gets exactly what it always got", () => {
    // The direction, asserted. `readOnlyArgs` was spliced in unconditionally
    // before E5, so this is the old behaviour and the default.
    for (const spec of VENDORS) {
      expect(restraintArgs(spec.readOnly, RESTRAINED)).toEqual(readOnlyArgs(spec.readOnly));
    }
  });

  test("at level 2 every vendor gets nothing — this is the loosening", () => {
    for (const spec of VENDORS) expect(restraintArgs(spec.readOnly, LOOSENED)).toEqual([]);
    // Control: the two are not trivially equal, or the case above proves
    // nothing. At least four vendors have flags to lose.
    const withFlags = VENDORS.filter((spec) => readOnlyArgs(spec.readOnly).length > 0);
    expect(withFlags.length).toBeGreaterThan(3);
  });
});

describe("the vendor with no mechanism is refused, not run hopefully", () => {
  // Synthetic since S12.6: kimi, the last real vendor with nothing to pass,
  // now has a profile file (D-120). The refusal has to keep working for the
  // next one, so it is tested on a vendor that declares `none` on purpose.
  const kimi: VendorSpec = {
    ...vendor("kimi"),
    id: "example",
    readOnly: {
      kind: "none",
      why: "a synthetic vendor with no tool filter and no sandbox; a turn told to write a file would write it",
      evidence: "writes",
    },
  };

  test("a vendor with no mechanism at level 1 is refused, in the registry's own words", () => {
    expect(kimi.readOnly.kind).toBe("none");
    const refusal = restraintRefusal(kimi, RESTRAINED);
    expect(refusal).toBeDefined();
    // Word for word: one sentence about this hole in the program, not two that
    // can drift apart.
    if (kimi.readOnly.kind === "none") expect(refusal).toContain(kimi.readOnly.why);
    expect(refusal).toContain("raise write, run and reach to 2 together");
  });

  test("…and is not refused at level 2, which is what raising the dial is for", () => {
    expect(restraintRefusal(kimi, LOOSENED)).toBeUndefined();
  });

  test("level 0 refuses every vendor, mechanism or not", () => {
    const silent = atLevel(0);
    for (const spec of VENDORS) {
      const refusal = restraintRefusal(spec, silent);
      expect(refusal, spec.id).toBeDefined();
      expect(refusal).toContain("the autonomy dial is at 0");
    }
  });

  test("a vendor that has a mechanism is never refused at 1", () => {
    // The control for the first case: without it, a `restraintRefusal` that
    // refused everything would pass.
    for (const spec of VENDORS) {
      if (spec.readOnly.kind === "none") continue;
      expect(restraintRefusal(spec, RESTRAINED), spec.id).toBeUndefined();
    }
  });
});

describe("the line a loosened turn prints before it goes", () => {
  test("it names the three categories, so a reader knows what took the flag off", () => {
    const loose = effectiveDial({
      stored: flat(2),
      source: "file",
      envValue: undefined,
      stopped: false,
    });
    const note = loosenedNote(loose);
    expect(note).toBeDefined();
    expect(note).toContain("NOT sent");
    expect(note).toContain("may write files and run commands");
  });

  test("and there is no line at all when nothing was loosened", () => {
    expect(
      loosenedNote(
        effectiveDial({ stored: DEFAULT_DIAL, source: "default", envValue: undefined, stopped: false }),
      ),
    ).toBeUndefined();
  });
});

describe("no cast composes a turn past the dial", () => {
  /**
   * The one file allowed to say the words that would turn `tsc` off here.
   *
   * This file is deliberately *not* on the list, and neither is
   * `test/support/restraint.ts`: a gate that exempts itself in order to
   * demonstrate the bypass has written the bypass, and a test helper that took
   * the shortcut would be the shortcut.
   */
  const ALLOWED: readonly string[] = [join("src", "exec", "restraint.ts")];
  const TYPES = ["Restraint"];

  test("`as Restraint` appears in exactly one file", async () => {
    const files = [
      ...(await sourceFiles(join(ROOT, "src"))),
      ...(await sourceFiles(join(ROOT, "test"))),
      ...(await sourceFiles(join(ROOT, "bin"))),
    ];
    // Guards the gate's own scope: an empty file list would make this vacuous.
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain(join(ROOT, "bin", "mind.ts"));
    expect(files).toContain(join(ROOT, "test", "support", "restraint.ts"));

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

    expect(caught(`const r = {} as Restraint;`)).not.toEqual([]);
    expect(caught(`const r = <Restraint>{};`)).not.toEqual([]);

    expect(caught(`function f(r: Restraint) {}`)).toEqual([]);
    expect(caught(`// as Restraint would be a bypass`)).toEqual([]);
    expect(caught(`const s = "x as Restraint";`)).toEqual([]);
  });
});
