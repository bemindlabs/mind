/**
 * The one rule — **a source may lower a level, never raise one** — and the
 * table of environment values, one row per reading somebody might expect.
 *
 * Two owner rules are asserted here rather than described:
 *
 * 1. **The unreadable file falls to 0, not to the default.** A file Mind
 *    cannot parse means Mind does not know what was intended, and "carry on
 *    as usual" answers a question nobody asked.
 * 2. **Nothing is clamped in silence.** Every reduction comes back as a
 *    {@link Clamp} carrying the number that was set, the number in force, and
 *    why — including the one the *minimum* introduces, which is the lie
 *    `actLevel` would otherwise tell with arithmetic instead of with silence.
 */

import { describe, expect, test } from "bun:test";
import {
  AUTONOMY_MAX_ENV,
  AUTONOMY_MAX_VALUES,
  defaultEffective,
  effectiveDial,
  type DialSource,
} from "../../src/decide/effective.ts";
import {
  CATEGORIES,
  DEFAULT_DIAL,
  levelOf,
  type Category,
  type Dial,
  type Level,
  type ReachLevel,
} from "../../src/decide/autonomy.ts";

function flat(level: Level, reach: ReachLevel = Math.min(level, 2) as ReachLevel): Dial {
  return { read: level, write: level, run: level, reach, operate: 0, setBy: null, setAt: null };
}

function decide(options: {
  stored?: Dial;
  source?: DialSource;
  envValue?: string | undefined;
  stopped?: boolean;
  confirmedThree?: readonly Category[];
}) {
  return effectiveDial({
    stored: options.stored ?? DEFAULT_DIAL,
    source: options.source ?? "default",
    envValue: options.envValue,
    stopped: options.stopped ?? false,
    confirmedThree: options.confirmedThree ?? [],
  });
}

describe("no file, and the default that is also today's behaviour", () => {
  test("every category is 1 and the note says why that is not timidity", () => {
    const verdict = defaultEffective();
    // D-153: the browser is the one category that starts at 0 — there was no browser before it.
    for (const category of CATEGORIES) expect(levelOf(verdict.dial, category)).toBe(category === "operate" ? 0 : 1);
    expect(verdict.act).toBe(1);
    expect(verdict.operate).toBe(0);
    expect(verdict.clamps).toEqual([]);
    expect(verdict.notes.join(" ")).toContain("what Mind already did before this dial existed");
  });
});

describe("a file that could not be read falls to silence, never to the default", () => {
  test("every category is 0 and the stored dial is discarded", () => {
    const verdict = decide({ stored: flat(3), source: "file-unreadable" });
    for (const category of CATEGORIES) expect(levelOf(verdict.dial, category)).toBe(0);
    expect(verdict.act).toBe(0);
    // The property the owner asked for in words: the fallback is the safest
    // value, not the one that happens to be sitting in a variable.
    expect(verdict.dial).not.toEqual(DEFAULT_DIAL);
    expect(verdict.notes.join(" ")).toContain("not a fall back to the default");
  });

  test("and it says so per category, with both numbers", () => {
    const verdict = decide({ stored: { ...flat(2), operate: 2 }, source: "file-unreadable" });
    for (const category of CATEGORIES) {
      const clamp = verdict.clamps.find((entry) => entry.category === category);
      expect(clamp, category).toBeDefined();
      expect(clamp!.set).toBe(2);
      expect(clamp!.effective).toBe(0);
      expect(clamp!.why).toContain("could not be parsed");
    }
  });
});

describe(`${AUTONOMY_MAX_ENV} is a ceiling, read as an exact string`, () => {
  // One row per reading somebody might expect a number-parser to give. Every
  // value outside the four is 0 — not "ignored", not "the default" — because
  // an environment variable that is not one of the four is a ceiling nobody
  // can show was meant, and the safe reading of that is silence.
  const TABLE: readonly (readonly [string | undefined, number | null, number])[] = [
    // value            ceiling   acting level with a stored dial of 2
    [undefined, null, 2],
    ["0", 0, 0],
    ["1", 1, 1],
    ["2", 2, 2],
    ["3", 3, 2],
    ["", 0, 0],
    [" ", 0, 0],
    ["3 ", 0, 0],
    [" 3", 0, 0],
    ["03", 0, 0],
    ["+3", 0, 0],
    ["3.0", 0, 0],
    ["0x3", 0, 0],
    ["3abc", 0, 0],
    ["three", 0, 0],
    ["-1", 0, 0],
    ["4", 0, 0],
    ["true", 0, 0],
    ["\n3\n", 0, 0],
  ];

  for (const [value, ceiling, act] of TABLE) {
    test(`${JSON.stringify(value)} → ceiling ${ceiling}, acting level ${act}`, () => {
      const verdict = decide({ stored: flat(2), source: "file", envValue: value });
      expect(verdict.ceiling).toBe(ceiling as Level | null);
      expect(verdict.act).toBe(act as Level);
    });
  }

  test("`Number` and `parseInt` are the readings this table exists to refuse", () => {
    // The four values below are the ones a conversion would have accepted, and
    // each of them loosens: `parseInt("3abc")` is 3, `Number(" 3 ")` is 3,
    // `Number("0x3")` is 3, `Number("")` is 0 — the last being the only one
    // that is safe, and safe by accident.
    expect(parseInt("3abc", 10)).toBe(3);
    expect(Number(" 3 ")).toBe(3);
    expect(Number("0x3")).toBe(3);
    for (const value of ["3abc", " 3 ", "0x3"]) {
      expect(decide({ stored: flat(3), source: "file", envValue: value }).act).toBe(0);
    }
  });

  test("it can only lower — there is no value that raises a level", () => {
    // The property, over the whole accepted domain rather than one example. A
    // variable that could raise is a variable the agent being restrained can
    // export for itself before it starts the next `mind`.
    for (const stored of [0, 1, 2, 3] as const) {
      for (const value of [...AUTONOMY_MAX_VALUES, undefined, "nonsense"]) {
        const verdict = decide({ stored: flat(stored), source: "file", envValue: value });
        for (const category of CATEGORIES) {
          expect(levelOf(verdict.dial, category)).toBeLessThanOrEqual(
            levelOf(flat(stored), category),
          );
        }
      }
    }
  });

  test("a ceiling that bites says so, with both numbers", () => {
    const verdict = decide({ stored: flat(3), source: "file", envValue: "1" });
    const write = verdict.clamps.find((entry) => entry.category === "write");
    expect(write).toBeDefined();
    expect(write!.set).toBe(3);
    expect(write!.effective).toBe(1);
    expect(write!.why).toContain(AUTONOMY_MAX_ENV);
  });
});

describe("the brake outranks everything", () => {
  test("it takes every category to 0 and says how to clear it", () => {
    const verdict = decide({ stored: flat(3), source: "file", envValue: "3", stopped: true });
    for (const category of CATEGORIES) expect(levelOf(verdict.dial, category)).toBe(0);
    expect(verdict.act).toBe(0);
    expect(verdict.stopped).toBe(true);
    expect(verdict.notes.join(" ")).toContain("autonomy resume");
    expect(verdict.clamps.every((clamp) => clamp.why.includes("stop flag"))).toBe(true);
  });
});

describe("no silent clamp — including the one the minimum makes", () => {
  test("a category set above the acting level is reported with the reason", () => {
    // The owner's rule: if a number will not have the effect it says, the
    // person setting it is told at the moment of setting. This is the value
    // `mind autonomy set` prints.
    const verdict = decide({
      stored: { read: 1, write: 3, run: 3, reach: 1, operate: 0, setBy: null, setAt: null },
      source: "file",
      confirmedThree: ["write", "run"],
    });
    expect(verdict.act).toBe(1);

    const write = verdict.clamps.find((entry) => entry.category === "write");
    expect(write).toBeDefined();
    expect(write!.set).toBe(3);
    expect(write!.effective).toBe(1);
    expect(write!.why).toContain("min(write, run, reach)");
    // Which category is holding it down — the actionable half.
    expect(write!.why).toContain("reach");
    expect(write!.why).toContain("I-6");

    // And `run`, which is equally ineffective, is equally reported.
    expect(verdict.clamps.some((entry) => entry.category === "run")).toBe(true);
    // …while `reach` itself is not clamped: it is the one doing the holding.
    expect(verdict.clamps.some((entry) => entry.category === "reach")).toBe(false);
  });

  test("a dial where every number has its effect reports no clamps at all", () => {
    // The control. Without it the assertion above would pass just as happily
    // over a function that reported a clamp for everything.
    const verdict = decide({ stored: flat(2), source: "file" });
    expect(verdict.act).toBe(2);
    expect(verdict.clamps).toEqual([]);
  });

  test("every clamp has both numbers and a reason long enough to act on", () => {
    // A property over the ways a clamp can arise, so a fifth source cannot
    // arrive with an empty explanation.
    const cases = [
      decide({ stored: flat(3), source: "file-unreadable" }),
      decide({ stored: flat(3), source: "file", envValue: "0" }),
      decide({ stored: flat(3), source: "file", stopped: true }),
      decide({
        stored: { read: 3, write: 3, run: 1, reach: 2, operate: 0, setBy: null, setAt: null },
        source: "file",
      }),
    ];
    let seen = 0;
    for (const verdict of cases) {
      for (const clamp of verdict.clamps) {
        expect(clamp.set).not.toBe(clamp.effective);
        expect(clamp.effective).toBeLessThan(clamp.set);
        expect(clamp.why.length).toBeGreaterThan(10);
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(5);
  });
});

describe("the stored dial's provenance survives the decision", () => {
  test("who set it and when are carried through, because AC4 asks for them", () => {
    const verdict = decide({
      stored: { ...flat(2), setBy: "Somebody Synthetic", setAt: "2026-09-22T00:00:00.000Z" },
      source: "file",
      envValue: "1",
    });
    expect(verdict.dial.setBy).toBe("Somebody Synthetic");
    expect(verdict.dial.setAt).toBe("2026-09-22T00:00:00.000Z");
  });
});

describe("D-042 — a 3 counts only where a person confirmed it on this machine", () => {
  const threes: Dial = { read: 3, write: 3, run: 3, reach: 2, operate: 0, setBy: "someone", setAt: "2026-09-23T00:00:00Z" };

  test("a file that says 3 with no confirmation is held at 2, and the reason names the hole", () => {
    const verdict = decide({ stored: threes, source: "file" });
    expect(verdict.dial.write).toBe(2);
    expect(verdict.dial.run).toBe(2);
    expect(verdict.dial.read).toBe(2);
    const write = verdict.clamps.find((c) => c.category === "write")!;
    expect(write).toMatchObject({ set: 3, effective: 2 });
    expect(write.why).toContain("never confirmed at a terminal");
    expect(write.why).toContain("agent acting at 2");
  });

  test("confirmed categories keep their 3; the rest do not", () => {
    const verdict = decide({ stored: threes, source: "file", confirmedThree: ["write"] });
    expect(verdict.dial.write).toBe(3);
    expect(verdict.dial.run).toBe(2);
  });

  test("a confirmation never raises anything: it only lets a stored 3 stand", () => {
    expect(decide({ source: "default", confirmedThree: ["write", "run", "read"] }).dial.write).toBe(1);
  });

  test("the stop flag and the ceiling still win over a confirmed 3", () => {
    expect(decide({ stored: threes, source: "file", confirmedThree: ["write"], stopped: true }).dial.write).toBe(0);
    expect(decide({ stored: threes, source: "file", confirmedThree: ["write"], envValue: "1" }).dial.write).toBe(1);
  });
});

describe("D-153 — operate runs at min(operate, reach), under every ceiling", () => {
  const withOperate = (operate: Level, reach: ReachLevel = 2): Dial => ({ ...flat(2), reach, operate });

  test("operate above reach is clamped, out loud, with reach named", () => {
    const verdict = decide({ stored: withOperate(2, 1), source: "file" });
    expect(verdict.operate).toBe(1);
    const clamp = verdict.clamps.find((c) => c.category === "operate");
    expect(clamp).toEqual(expect.objectContaining({ set: 2, effective: 1 }));
    expect(clamp!.why).toContain("min(operate, reach)");
    expect(verdict.act).toBe(1);
  });

  test("operate at or below reach is in force as set, with no clamp", () => {
    const verdict = decide({ stored: withOperate(1), source: "file" });
    expect(verdict.operate).toBe(1);
    expect(verdict.clamps).toEqual([]);
  });

  test("operate 3 is held at 2 until it is confirmed at a terminal (D-042)", () => {
    const unconfirmed = decide({ stored: withOperate(3), source: "file" });
    expect(unconfirmed.dial.operate).toBe(2);
    expect(unconfirmed.operate).toBe(2);
    expect(unconfirmed.clamps.find((c) => c.category === "operate")!.why).toContain("never confirmed");

    const confirmed = decide({ stored: withOperate(3), source: "file", confirmedThree: ["operate"] });
    expect(confirmed.dial.operate).toBe(3);
    expect(confirmed.operate).toBe(3);
    expect(confirmed.clamps).toEqual([]);
  });

  test("confirmed operate 3 with reach below its top is the minimum, and says so", () => {
    const verdict = decide({ stored: withOperate(3, 1), source: "file", confirmedThree: ["operate"] });
    expect(verdict.operate).toBe(1);
    expect(verdict.clamps.find((c) => c.category === "operate")).toEqual(expect.objectContaining({ set: 3, effective: 1 }));
  });

  test("the ceiling and the brake lower it like every category", () => {
    expect(decide({ stored: withOperate(2), source: "file", envValue: "1" }).operate).toBe(1);
    expect(decide({ stored: withOperate(3), source: "file", confirmedThree: ["operate"], envValue: "2" }).operate).toBe(2);
    expect(decide({ stored: withOperate(2), source: "file", stopped: true }).operate).toBe(0);
    expect(decide({ stored: withOperate(2), source: "file-unreadable" }).operate).toBe(0);
  });
});
