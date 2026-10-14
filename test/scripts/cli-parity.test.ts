/**
 * The harness that proves a refactor changed nothing, proved.
 *
 * `scripts/cli-parity.ts` is the tool that measured `split1`'s claim. It did
 * not appear in the coverage report — not at 0%, but not at all — and it could
 * not have: it had no `import.meta.main`, so the first thing an `import` did
 * was read `--base` off the test runner's own command line, fail to find it,
 * and `process.exit(2)`, taking the suite with it. The proof tool was the one
 * file in `scripts/` nothing could check.
 *
 * The question asked of it here is **not** the one `bin/` is asked. A size
 * ratchet answers "did code arrive where nobody can see it", which is the right
 * question for a command and the wrong one for an instrument: this file can be
 * byte-for-byte identical and have stopped proving anything, the moment a
 * `case` lands in the CLI entry file that its matrix never runs. Nothing about its
 * size moves. So it is asked two questions instead, and both are asked on every
 * `bun test` rather than when somebody remembers:
 *
 * 1. **Do the two controls still hold?** Answered by really running them — one
 *    scenario of `--selftest`, in a `mkdtemp`, measured at ~1.3 s. The full
 *    matrix is 381 invocations and ~16 s, which is the right price by hand
 *    (`npm run parity`) and the wrong one on every test run. Cutting it to one
 *    scenario keeps *both* controls, because the control is what would
 *    otherwise never run automatically at all.
 * 2. **Does the matrix still describe this CLI?** Answered statically: every
 *    `case` in the CLI entry file is exercised, every fixture the matrix names is
 *    on disk, and control 2's needle is still a string the CLI prints. Each of
 *    those can rot with no change to this file, which is exactly why they are
 *    checked against `bin/` as it is today rather than written down.
 *
 * The judging parts are tested in-process, and the control on the guard is done
 * over the *text* of the file rather than by breaking it: mutating a gate and
 * running it is the ordinary way to prove it bites, and here running it means
 * `bun test` inside `bun test`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CONTROL_INSERTION,
  CONTROL_NEEDLE,
  DECLARED,
  FIXTURES,
  NORMALISERS,
  SCENARIOS,
  addedCase,
  chosen,
  classify,
  crossing,
  diffCase,
  difference,
  isComment,
  normalise,
  place,
  stepStreams,
  stripInsertions,
  stripRemovals,
  treeDigest,
  workspaceFor,
} from "../../scripts/cli-parity.ts";
import { unguardedTopLevel } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "cli-parity.ts");
const CLI = join(ROOT, "bin", "mind.ts");

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

describe("the four normalisers, and the count that makes them safe", () => {
  test("a clock, in both spellings this repo writes", () => {
    const { text, counts } = normalise(
      "at 2026-09-21T10:11:12.345Z and 2026-09-21T10:11:12+07:00 and dir 20260921T101112Z",
    );
    expect(text).toBe("at <instant> and <instant> and dir <instant>");
    expect(counts.get("instant")).toBe(3);
  });

  test("a uuid, in either case, and only where it is really one", () => {
    const { text, counts } = normalise("id 3f2504e0-4f89-41d3-9a0c-0305e82c3301 and 3f2504e0-4f89");
    expect(text).toBe("id <uuid> and 3f2504e0-4f89");
    expect(counts.get("uuid")).toBe(1);
  });

  test("a duration, in the three shapes the CLI prints one", () => {
    expect(normalise('{"durationMs": 41}').text).toBe('{"durationMs": <ms>}');
    expect(normalise('{"duration_ms":7}').text).toBe('{"duration_ms":<ms>}');
    expect(normalise("took 1234 ms").text).toBe("took <ms>");
  });

  test("the mkdtemp tail, with the prefix kept so a different prefix still differs", () => {
    const { text, counts } = normalise("/tmp/mind-erase-Xk92mQ4a/cert.txt");
    expect(text).toBe("/tmp/mind-erase-<rand>/cert.txt");
    expect(counts.get("mkdtemp")).toBe(1);
    expect(normalise("/tmp/other-erase-Xk92mQ4a/cert.txt").text).toBe("/tmp/other-erase-Xk92mQ4a/cert.txt");
  });

  test("every normaliser reports a count, including zero", () => {
    // The fourth of the four things that make this comparison mean anything:
    // a side that replaced a *different number* of things must fail the diff
    // even when the replacements made the text match. That only works if the
    // count is always written, so an absent key would silently become 0.
    const { counts } = normalise("nothing here needs normalising");
    expect([...counts.keys()].sort()).toEqual(NORMALISERS.map((n) => n.name).sort());
    for (const name of counts.keys()) expect(counts.get(name)).toBe(0);
  });

  test("normalising is idempotent, so a recording cannot drift by being re-read", () => {
    const once = normalise("2026-09-21T10:11:12.345Z took 8 ms").text;
    expect(normalise(once).text).toBe(once);
  });
});

describe("a declared difference is one number on an otherwise identical line", () => {
  const rule = DECLARED.find((d) => d.id === "doctor.engine.filecount");

  test("the rule this repository has is still the one this test is about", () => {
    expect(rule, "doctor.engine.filecount is gone — this test needs rewriting").toBeDefined();
    expect(rule!.reason.length).toBeGreaterThan(80);
  });

  test("the same line with a different count is declared", () => {
    const { declared, undeclared } = classify([
      { file: "04-doctor.txt", line: 9, base: "  ok  61 file(s) under /x", head: "  ok  74 file(s) under /x" },
    ]);
    expect(declared.map((d) => d.by.id)).toEqual(["doctor.engine.filecount"]);
    expect(undeclared).toEqual([]);
  });

  test("the same shape with a different *path* is not declared", () => {
    // The rule permits one captured number to move and nothing else. If it
    // compared only the number, a side that searched a different directory
    // would be waved through by a rule written for a file count.
    const { declared, undeclared } = classify([
      { file: "04-doctor.txt", line: 9, base: "  ok  61 file(s) under /x", head: "  ok  61 file(s) under /y" },
    ]);
    expect(declared).toEqual([]);
    expect(undeclared).toHaveLength(1);
  });

  test("a line that matches no rule on either side is undeclared", () => {
    const { declared, undeclared } = classify([
      { file: "02-unknown.txt", line: 8, base: "mind: unknown command", head: "mind- unknown command" },
    ]);
    expect(declared).toEqual([]);
    expect(undeclared).toHaveLength(1);
  });

  test("a line matching on one side only is undeclared, not half-declared", () => {
    const { undeclared } = classify([
      { file: "04-doctor.txt", line: 9, base: "  ok  61 file(s) under /x", head: "  ok  the engine is fine" },
    ]);
    expect(undeclared).toHaveLength(1);
  });

  test("nothing in, nothing out", () => {
    expect(classify([])).toEqual({ declared: [], undeclared: [] });
  });
});

describe("a declared insertion, and the control that keeps it narrow", () => {
  /** A line the certificate gained in fix1, as the recording writes it. */
  const FOUND = "  | found        before deletion: 1 file(s) · 0 ledger line(s) · 0 applied block(s)";

  test("the rules this block is about are the ones this repository has", () => {
    const inserted = DECLARED.filter((rule) => rule.kind === "inserted");
    expect(inserted.length).toBeGreaterThan(0);
    for (const rule of inserted) expect(rule.reason.length).toBeGreaterThan(60);
    // Every rule with an `until` names both ends; a half-written one would eat
    // from its anchor to the bottom of the file if the search ever ran loose.
    for (const rule of inserted) {
      if (rule.kind !== "inserted" || rule.until === undefined) continue;
      expect(rule.pattern.source).not.toBe(rule.until.source);
    }
  });

  test("a head-only line matching a rule is taken out before anything is aligned", () => {
    const { head, inserted } = stripInsertions(["  | verdict      dry-run"], [
      "  | verdict      dry-run",
      FOUND,
    ]);
    expect(head).toEqual(["  | verdict      dry-run"]);
    expect(inserted.map((entry) => entry.text)).toEqual([FOUND]);
  });

  test("…and not when the base has such a line too — then it is an edit, not an insertion", () => {
    // The whole safety property. A rule written for a line that is new must not
    // become a way to wave through a change to a line that already existed, so
    // the moment the base side has one, the rule stops applying and the
    // ordinary positional comparison takes over.
    const older = "  | found        before deletion: 9 file(s) · 0 ledger line(s) · 0 applied block(s)";
    const { head, inserted } = stripInsertions([older], [FOUND]);
    expect(inserted).toEqual([]);
    expect(head).toEqual([FOUND]);
  });

  test("a block rule takes its whole object, from the anchor to the end it names", () => {
    const block = [
      '  |     "found": {',
      '  |       "files": 3,',
      '  |       "total": 3',
      "  |     },",
    ];
    const { head, inserted } = stripInsertions(["  |   {"], ["  |   {", ...block, "  |   }"]);
    expect(head).toEqual(["  |   {", "  |   }"]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.text.split("\n")).toEqual(block);
  });

  test("a rule whose end is not there strips nothing, rather than eating the rest", () => {
    const { head, inserted } = stripInsertions(
      ["  |   {"],
      ["  |   {", '  |     "found": {', '  |       "files": 3,'],
    );
    expect(inserted).toEqual([]);
    expect(head).toHaveLength(3);
  });

  test("a declared insertion leaves the case clean — nothing shifts behind it", () => {
    const base = ["## step 0", "exit: 0", "  | verdict      dry-run", "  | subject      demo"];
    const head = [...base.slice(0, 3), FOUND, ...base.slice(3)];
    const compared = diffCase("13-erase.txt", base.join("\n"), head.join("\n"));

    expect(compared.diffs).toEqual([]);
    expect(compared.lengths).toBeNull();
    expect(compared.inserted.map((entry) => entry.text)).toEqual([FOUND]);
  });

  test("THE CONTROL — an insertion nobody declared still goes red", () => {
    // The reason this whole mechanism is allowed to exist. `inserted` is the
    // one declaration kind that removes lines before the comparison, so it is
    // the one that could make a proof tool agree with whoever edits it. An
    // undeclared line shifts everything after it and changes the length, and
    // both of those are reported.
    const base = ["## step 0", "exit: 0", "  | verdict      dry-run", "  | subject      demo"];
    const head = [...base.slice(0, 3), "  | something nobody wrote a reason for", ...base.slice(3)];
    const compared = diffCase("13-erase.txt", base.join("\n"), head.join("\n"));

    expect(compared.inserted).toEqual([]);
    expect(compared.diffs.length).toBeGreaterThan(0);
    expect(compared.lengths).toContain("lines on base");
    // And it is not rescued by `classify` on the way out either.
    expect(classify(compared.diffs).undeclared.length).toBeGreaterThan(0);
  });

  test("control 3's planted line is covered by no rule, which is what makes it a control", () => {
    // If a declaration ever grew wide enough to match it, control 3 would pass
    // by being hidden rather than by being caught — and this goes red first.
    const planted = `  | ${CONTROL_INSERTION}`;
    const { head, inserted } = stripInsertions([], [planted]);
    expect(inserted).toEqual([]);
    expect(head).toEqual([planted]);
  });

  test("a `replaced` rule needs both sides, and both patterns", () => {
    const rule = DECLARED.find((entry) => entry.id === "erase.verdict.nothing-found");
    expect(rule?.kind).toBe("replaced");

    const { declared, undeclared } = classify([
      {
        file: "13-erase.txt",
        line: 3,
        base: "  | verdict      erased-and-verified",
        head: "  | verdict      nothing-found",
      },
    ]);
    expect(declared.map((entry) => entry.by.id)).toEqual(["erase.verdict.nothing-found"]);
    expect(undeclared).toEqual([]);

    // The same head line arriving from somewhere else is not the declared
    // change: a rule that only checked where it landed would cover every line
    // that ever became this one.
    expect(
      classify([
        {
          file: "13-erase.txt",
          line: 3,
          base: "  | verdict      erased-with-remainder",
          head: "  | verdict      nothing-found",
        },
      ]).undeclared,
    ).toHaveLength(1);
  });
});

describe("a declared addition, and the count that keeps it from being a mute button", () => {
  /** A base recording of a case whose command that revision does not have. */
  function refused(steps: number, command = "autonomy"): string {
    const lines = [`# ${steps}-${command}`];
    for (let step = 0; step < steps; step += 1) {
      lines.push(
        "",
        `## step ${step} — mind ${command} something`,
        "exit: 2",
        "stdout:",
        "  | ",
        "stderr:",
        `  | mind: unknown command "${command}"`,
        "  | mind 0.0.1 — build AGI agents you actually own",
      );
    }
    return lines.join("\n");
  }

  test("the rules this block is about are the ones this repository has", () => {
    const rules = DECLARED.filter((rule) => rule.kind === "added");
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.reason.length).toBeGreaterThan(60);
      if (rule.kind !== "added") continue;
      expect(rule.file.endsWith(".txt")).toBe(true);
      expect(rule.command.length).toBeGreaterThan(0);
    }
  });

  test("a case whose every step was refused as unknown is an addition", () => {
    const found = addedCase("15-autonomy.txt", refused(4));
    expect(found).toBeDefined();
    expect(found!.steps).toBe(4);
    expect(found!.refusals).toBe(4);
  });

  test("…and one step the base COULD run takes the exemption away", () => {
    // The control that decides whether this kind is a declaration or a mute
    // button. A case that mixes a new command with one the base already has is
    // a case where something might really have changed, so it goes back to
    // being judged line by line — which is the whole reason the counts are
    // compared rather than one refusal being looked for.
    const mixed = `${refused(3)}
## step 3 — mind new demo --subject example
exit: 0
stdout:
  | created`;
    expect(addedCase("15-autonomy.txt", mixed)).toBeUndefined();
  });

  test("a base that grew the command stops the rule dead", () => {
    // The day somebody implements `autonomy` on the base side, this rule must
    // stop firing by itself — otherwise a declaration written for a command's
    // birth would go on hiding every later change to it, for good.
    const implemented = refused(3).replace(/mind: unknown command "autonomy"/g, "  | read   1");
    expect(addedCase("15-autonomy.txt", implemented)).toBeUndefined();
  });

  test("a recording with no steps in it is not an addition", () => {
    // Otherwise the rule would be vacuously true over an empty file, which is
    // the `PARITY-UNDECIDED` failure arriving through a different door: a
    // comparison that did not happen, reported as a comparison that passed.
    expect(addedCase("15-autonomy.txt", "")).toBeUndefined();
    expect(addedCase("15-autonomy.txt", "# 15-autonomy\n")).toBeUndefined();
  });

  test("a file no rule names is never an addition, whatever is in it", () => {
    // The scope: `added` is keyed by case file, so a case nobody declared
    // cannot become exempt by happening to look like one that is.
    expect(addedCase("10-turn.txt", refused(4))).toBeUndefined();
  });

  test("the command word is matched literally, not as a pattern", () => {
    const rules = DECLARED.filter((rule) => rule.kind === "added");
    for (const rule of rules) {
      if (rule.kind !== "added") continue;
      // A word with regex metacharacters in it must not widen the search. The
      // escape is in `addedCase`; this asserts the words we actually have are
      // plain, so a future one with a dot in it is a deliberate choice.
      expect(rule.command).toMatch(/^[a-z-]+$/);
    }
  });

  test("every `added` rule names a case that is really in the matrix", () => {
    // A rule for a case that was renamed or deleted would sit here forever
    // claiming to cover something, and the case it was written for would be
    // judged by nothing at all.
    const ids = new Set(SCENARIOS.map((scenario) => `${scenario.id}.txt`));
    for (const rule of DECLARED) {
      if (rule.kind !== "added") continue;
      expect(ids.has(rule.file), rule.file).toBe(true);
    }
  });

  test("every step of a declared-added case really does begin with that command", () => {
    // The condition `addedCase` checks at run time, checked here against the
    // matrix instead of against a recording: a case with a `new` step in it
    // could never satisfy the count, so the declaration would silently never
    // fire and the case would be red for reasons nobody had written down.
    for (const rule of DECLARED) {
      if (rule.kind !== "added") continue;
      const scenario = SCENARIOS.find((entry) => `${entry.id}.txt` === rule.file);
      expect(scenario, rule.file).toBeDefined();
      for (const step of scenario!.steps) {
        expect(step.argv[0], `${rule.file}: ${step.argv.join(" ")}`).toBe(rule.command);
      }
    }
  });
});

describe("a declared removal, and the control that keeps it one-directional", () => {
  /**
   * `observe enable`, refused at a non-terminal, as the recording writes it.
   *
   * Three blank stdout lines before the `stderr:` marker is what the command
   * printed before fix3: one deliberate `console.log()` spacer, one trailing
   * newline from the line before it, and one from a bare `console.error()`
   * whose newline went to stdout.
   */
  const BEFORE = [
    "## step 1 — mind observe enable --subject example",
    'stdin: ""',
    "exit: 1",
    "stdout:",
    "  | observer — subject example",
    "  | ",
    "  | ",
    "  | ",
    "stderr:",
    "  | mind: this asks for consent to record what you do",
    "  | ",
  ];
  /** …and after: the same, one blank stdout line shorter. */
  const AFTER = [...BEFORE.slice(0, 7), ...BEFORE.slice(8)];

  test("the rules this block is about are the ones this repository has", () => {
    const rules = DECLARED.filter((rule) => rule.kind === "removed");
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.reason.length).toBeGreaterThan(60);
      // The anchor is not optional. `stripRemovals` ignores a rule without one,
      // so an unanchored rule would be dead rather than dangerous — but a dead
      // declaration in this list is a lie about what the harness checks, and
      // this is where it is caught.
      if (rule.kind !== "removed") continue;
      expect(rule.followedBy.length, rule.id).toBeGreaterThan(0);
    }
  });

  test("a base-only line matching the shape is taken out before anything is aligned", () => {
    const { base, removed } = stripRemovals(BEFORE);
    expect(base).toEqual(AFTER);
    expect(removed.map((entry) => entry.by.id)).toEqual(["observe.enable.stdout.spacer"]);
    expect(removed.map((entry) => entry.text)).toEqual(["  | "]);
  });

  test("a declared removal leaves the case clean — nothing shifts behind it", () => {
    const compared = diffCase("12-observe.txt", BEFORE.join("\n"), AFTER.join("\n"));

    expect(compared.diffs).toEqual([]);
    expect(compared.lengths).toBeNull();
    expect(compared.removed.map((entry) => entry.by.id)).toEqual(["observe.enable.stdout.spacer"]);
  });

  test("THE CONTROL — the reverse direction goes red", () => {
    // Run the harness the other way round: a base from after the change and a
    // head from before it, which is what comparing today's engine against a
    // revision that put the bare `console.error()` back would look like. The
    // anchor is not on the base side to fire on, so nothing is stripped, the
    // extra head line shifts everything behind it, and the case is red on both
    // counts. A symmetric pair of `replaced` rules would have declared this and
    // reported parity over the regression, for good.
    const compared = diffCase("12-observe.txt", AFTER.join("\n"), BEFORE.join("\n"));

    expect(compared.removed).toEqual([]);
    expect(compared.diffs.length).toBeGreaterThan(0);
    expect(compared.lengths).toContain("lines on base");
    // And `classify` does not rescue it on the way out either.
    expect(classify(compared.diffs).undeclared.length).toBeGreaterThan(0);
  });

  test("the anchor is what makes it narrow: a blank line elsewhere is left alone", () => {
    // Every other blank line in a recording — and there are hundreds — has to
    // survive, or the rule would be a normaliser wearing a declaration's name.
    const ordinary = [
      "stdout:",
      "  | a line",
      "  | ",
      "  | another line",
      "  | ",
      "stderr:",
      "  | ",
    ];
    const { base, removed } = stripRemovals(ordinary);
    expect(removed).toEqual([]);
    expect(base).toEqual(ordinary);

    // Two blanks before `stderr:` is the shape *both* sides already had at
    // another step of the same case; stripping that would invent a difference.
    const two = ["stdout:", "  | a line", "  | ", "  | ", "stderr:", "  | reason"];
    expect(stripRemovals(two).removed).toEqual([]);
  });
});

describe("a declared crossing, and the four controls that keep it honest", () => {
  /**
   * `erase … --json`, as the recording writes it, before odd3.
   *
   * The plan is on stdout in front of the certificate — which is why the whole
   * of stdout did not parse — and the step wrote nothing to stderr. Shortened
   * to the shape that matters: the real step is about 450 lines and every one
   * of them is one of these five kinds.
   */
  const BEFORE = [
    "# 13-erase",
    "",
    "## step 5 — mind erase example --no-agent --by tester --json",
    "exit: 0",
    "stdout:",
    "  | erase — subject example · no agent directory given",
    "  | ",
    "  | The five places a subject's data can end up:",
    "  | ",
    "  | {",
    `  |   "schema": "mind/erase-certificate@5"`,
    "  | }",
    "  | ",
    "  | Nothing was removed. Re-run with --yes to remove it.",
    "  | ",
    "stderr:",
    "  | ",
    "",
    "## sandbox",
    "  dir cwd",
  ];

  /** …and after: stdout is the certificate, every human line is on stderr. */
  const AFTER = [
    "# 13-erase",
    "",
    "## step 5 — mind erase example --no-agent --by tester --json",
    "exit: 0",
    "stdout:",
    "  | {",
    `  |   "schema": "mind/erase-certificate@5"`,
    "  | }",
    "  | ",
    "stderr:",
    "  | erase — subject example · no agent directory given",
    "  | ",
    "  | The five places a subject's data can end up:",
    "  | ",
    "  | ",
    "  | Nothing was removed. Re-run with --yes to remove it.",
    "  | ",
    "",
    "## sandbox",
    "  dir cwd",
  ];

  const CASE = "13-erase.txt";

  test("the rule this block is about is the one this repository has", () => {
    const rules = DECLARED.filter((rule) => rule.kind === "crossed");
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      if (rule.kind !== "crossed") continue;
      expect(rule.reason.length).toBeGreaterThan(60);
      // The case it names has to be a case, and the step a step. A rule
      // pointing at a recording nobody writes is dead, and a dead declaration
      // in this list is a lie about what the harness checks.
      const scenario = SCENARIOS.find((one) => `${one.id}.txt` === rule.file);
      expect(scenario, `${rule.id} names ${rule.file}, which no scenario writes`).toBeDefined();
      expect(rule.step).toBeGreaterThanOrEqual(0);
      expect(rule.step).toBeLessThan(scenario!.steps.length);
      // …and that step really is the one that takes `--json`, which is the
      // whole reason a crossing is expected there at all.
      expect(scenario!.steps[rule.step]!.argv).toContain("--json");
    }
  });

  test("the streams of each step are found, and the trailing sections are not steps", () => {
    const regions = stepStreams(BEFORE);
    expect([...regions.keys()]).toEqual([5]);
    const at = regions.get(5)!;
    expect(BEFORE.slice(at.stdout[0], at.stdout[1])[0]).toContain("erase — subject example");
    expect(BEFORE.slice(at.stderr[0], at.stderr[1])).toEqual(["  | ", ""]);
  });

  test("a block that only changed stream leaves the case clean", () => {
    const compared = diffCase(CASE, BEFORE.join("\n"), AFTER.join("\n"));

    expect(compared.diffs).toEqual([]);
    expect(compared.lengths).toBeNull();
    expect(compared.crossed.map((entry) => entry.by.id)).toEqual(["erase.json.plan-to-stderr"]);
    // Printed whole, and it is the block that left stdout.
    const moved = compared.crossed[0]!.text.split("\n");
    expect(moved[0]).toContain("erase — subject example");
    expect(moved).toContain("  | Nothing was removed. Re-run with --yes to remove it.");
    expect(moved).not.toContain(`  |   "schema": "mind/erase-certificate@5"`);
  });

  test("THE CONTROL — one byte different on the way across goes red", () => {
    // The thing a `removed` + `inserted` pair could never have caught: the
    // block left stdout and a *different* block arrived on stderr. Here the
    // difference is one word in the closing sentence.
    const edited = AFTER.map((line) =>
      line === "  | Nothing was removed. Re-run with --yes to remove it."
        ? "  | Nothing was erased. Re-run with --yes to remove it."
        : line,
    );
    const compared = diffCase(CASE, BEFORE.join("\n"), edited.join("\n"));

    expect(compared.crossed).toEqual([]);
    expect(compared.diffs.length).toBeGreaterThan(0);
    expect(classify(compared.diffs).undeclared.length).toBeGreaterThan(0);
  });

  test("THE CONTROL — a line that was never on stdout goes red", () => {
    // stderr gained something stdout never had. That is an addition wearing a
    // move's clothes, and the search has no assignment for it.
    const extra = [...AFTER];
    extra.splice(11, 0, "  | mind: a sentence nobody declared");
    const compared = diffCase(CASE, BEFORE.join("\n"), extra.join("\n"));

    expect(compared.crossed).toEqual([]);
    expect(compared.diffs.length).toBeGreaterThan(0);
  });

  test("THE CONTROL — the reverse direction goes red", () => {
    // A base from after the change and a head from before it: what comparing
    // today's engine against a revision that put the plan back on stdout would
    // look like. stdout *gains* and stderr *loses*, so there is nothing for the
    // rule to find and the case is red on the shift and on the length.
    const compared = diffCase(CASE, AFTER.join("\n"), BEFORE.join("\n"));

    expect(compared.crossed).toEqual([]);
    expect(compared.diffs.length).toBeGreaterThan(0);
    expect(classify(compared.diffs).undeclared.length).toBeGreaterThan(0);
  });

  test("THE CONTROL — the same move in a case the rule does not name goes red", () => {
    // The rule is `13-erase.txt` step 5 and nothing else. Rename the recording
    // and the identical change is undeclared, which is what stops one
    // declaration from waving through every future stream move in the matrix.
    const compared = diffCase("12-observe.txt", BEFORE.join("\n"), AFTER.join("\n"));

    expect(compared.crossed).toEqual([]);
    expect(compared.diffs.length).toBeGreaterThan(0);
  });

  test("the search is exact where a diff would have had to guess", () => {
    // Four identical blank lines, and a multiset difference cannot say which
    // one moved — the first version of this did, and produced one answer for
    // stdout and a different one for stderr over the same recording. The
    // question here is existence, so there is nothing to guess: a consistent
    // assignment exists, or the rule does not fire.
    const moved = crossing(
      ["  | a", "  | ", "  | b", "  | ", "  | keep", "  | ", "  | c", "  | "],
      ["  | keep", "  | "],
      ["  | "],
      ["  | a", "  | ", "  | b", "  | ", "  | ", "  | c", "  | "],
    );
    expect(moved).toBeDefined();
    expect(moved!.fromStdout.length).toBe(6);
    expect(moved!.ontoStderr.length).toBe(6);

    // …and it says no when there is no assignment, rather than the nearest one.
    expect(
      crossing(["  | a", "  | b"], ["  | b"], ["  | "], ["  | a", "  | ", "  | z"]),
    ).toBeUndefined();
  });
});

describe("the structural proof counts lines as a multiset", () => {
  test("a repeated line removed once is reported once", () => {
    // Both sides having `}` 400 times and one side having it 399 times is a
    // real difference, and a set would lose it entirely.
    expect(difference(["}", "}", "}"], ["}", "}"])).toEqual(["}"]);
    expect(difference(["}", "}"], ["}", "}", "}"])).toEqual([]);
  });

  test("order does not matter, presence and count do", () => {
    expect(difference(["a", "b"], ["b", "a"])).toEqual([]);
    expect(difference(["a"], [])).toEqual(["a"]);
    expect(difference([], ["a"])).toEqual([]);
  });

  test("a comment line is prose, and `**drift**` inside help text is not", () => {
    expect(isComment("  // a note")).toBe(true);
    expect(isComment("/** a doc")).toBe(true);
    expect(isComment(" * continued")).toBe(true);
    expect(isComment(" */")).toBe(true);
    expect(isComment("*")).toBe(true);
    // The one line of USAGE that begins with two stars. It is output, not
    // prose about output, so gating it is the point.
    expect(isComment("**drift** — the soul on disk and the soul in the file")).toBe(false);
    expect(isComment("const x = 1;")).toBe(false);
  });
});

describe("the matrix still describes the CLI it is a matrix of", () => {
  test("every case in the CLI entry file is the first word of some step", async () => {
    // Counted with a pattern that is not anchored to the start of a line:
    // scenario `03-backends` is written as a one-line object, and a grep that
    // assumed one field per line would miss it and report thirteen scenarios
    // for fourteen. Things that count by formatting fail silently.
    const source = await readFile(CLI, "utf8");
    const main = source.slice(source.indexOf("async function main("));
    const dispatched = [...main.matchAll(/case "([^"]+)":/g)].map((match) => match[1]!);
    expect(dispatched.length).toBeGreaterThan(10);

    const firstWords = new Set(
      SCENARIOS.flatMap((scenario) => scenario.steps.map((step) => step.argv[0] ?? "")),
    );
    const unreached = dispatched.filter((name) => !firstWords.has(name));
    expect(unreached, "a command the CLI dispatches that the parity matrix never runs").toEqual([]);
  });

  test("the empty command line and `--as` are exercised too, since neither is a case", () => {
    const steps = SCENARIOS.flatMap((scenario) => scenario.steps);
    expect(steps.some((step) => step.argv.length === 0)).toBe(true);
    expect(steps.some((step) => step.argv[0] === "--as")).toBe(true);
  });

  test("every fixture the matrix hands the CLI is on disk", async () => {
    // A renamed fixture does not make the harness fail. Both sides are handed
    // the same path that does not exist, both say so identically, and the run
    // reports parity over a matrix that stopped exercising `soul check`.
    // Three of the four are directories, so this is `stat` and not
    // `Bun.file().exists()` — the latter answers false for a directory, which
    // would make this test pass only for the one fixture that is a file and
    // fail for the three that were always fine.
    expect(FIXTURES.length).toBeGreaterThan(3);
    for (const rel of FIXTURES) {
      const info = await stat(join(ROOT, rel)).catch(() => undefined);
      expect(info !== undefined, `${rel} is named by the matrix and is not there`).toBe(true);
      expect(info!.isDirectory() || info!.isFile()).toBe(true);
    }
  });

  test("control 2's needle is still a string this CLI prints", async () => {
    // Control 2 plants one changed character inside this message and requires
    // the comparison to go red. If the message were reworded, the control
    // would refuse to run — but only when somebody ran `--selftest` by hand.
    const source = await readFile(CLI, "utf8");
    expect(source).toContain(CONTROL_NEEDLE);
  });

  test("the scenario control 2 runs under is one that reaches that message", () => {
    // The mini-run below passes `--only 02-unknown`, so the needle has to be
    // reachable from *that* scenario rather than from the matrix at large.
    const unknown = SCENARIOS.find((scenario) => scenario.id === "02-unknown");
    expect(unknown).toBeDefined();
    const dispatched = new Set(["version", "backends", "doctor", "new", "rebuild", "soul", "worn",
      "turn", "ledger", "observe", "erase", "guard", "help"]);
    expect(unknown!.steps.some((step) => !dispatched.has(step.argv[0] ?? "help"))).toBe(true);
  });

  test("the ids are unique, and `--only` can name every one of them", () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(chosen(id)).toHaveLength(1);
  });

  test("`--only` naming nothing throws rather than proving nothing", () => {
    // An empty selection would let `runSide` write no recordings, `compare`
    // find no differences, and the run print PARITY-OK and exit 0. A typo in a
    // flag must not be able to manufacture a proof.
    expect(() => chosen("07-soul")).toThrow(/names no scenario/);
    expect(chosen(undefined)).toBe(SCENARIOS);
  });
});

describe("two checkouts do not write into one another's workspace", () => {
  test("the directory is derived from the checkout, not fixed", () => {
    // The bug: a fixed directory name directly under /tmp. Two worktrees running the harness at
    // once shared one engine and one set of recordings, and the result was not
    // a crash — it was a comparison that quietly answered about the wrong tree.
    expect(workspaceFor("/a/one")).not.toBe(workspaceFor("/a/two"));
    expect(workspaceFor("/a/one")).toBe(workspaceFor("/a/one"));
    for (const repo of ["/a/one", "/a/two"]) {
      expect(workspaceFor(repo)).toStartWith("/tmp/mind-parity-");
    }
  });

  test("and it is a hash, so /tmp carries no sentence about somebody's filesystem", () => {
    expect(workspaceFor("/home/someone/projects/mind-dev")).not.toContain("someone");
    expect(workspaceFor("/home/someone/projects/mind-dev")).toMatch(/^\/tmp\/mind-parity-[0-9a-f]+$/);
  });
});

describe("a side is what the spec says, and nothing the side before it left behind", () => {
  test("materialising a tree removes what was there first", async () => {
    // The bug this test exists for, found by running the harness rather than
    // by reading it. `copyTree` only ever *writes* files, and the base side is
    // unpacked into the same directory a moment earlier — so a file the head
    // side deleted was still sitting there when the head side ran.
    //
    // It showed up as the worst possible symptom: `--base HEAD --head .` over
    // a working tree with one file deleted from `scripts/` printed PARITY-OK
    // and not even a declared difference, because `doctor` counted 87 engine
    // files on both sides. The harness could not see a deletion.
    const source = await mkdtemp(join(tmpdir(), "mind-parity-src-"));
    const into = await mkdtemp(join(tmpdir(), "mind-parity-into-"));
    scratch.push(source, into);

    await Bun.write(join(source, "kept.txt"), "head\n");
    await Bun.write(join(into, "deleted.txt"), "base left this behind\n");
    await Bun.write(join(into, "kept.txt"), "base\n");

    // A path, so `isRevision` answers false without consulting git: this is the
    // directory branch, which is the one that was wrong.
    await place(source, into);

    expect(await Bun.file(join(into, "kept.txt")).text()).toBe("head\n");
    expect(
      await Bun.file(join(into, "deleted.txt")).exists(),
      "a file only the previous side had survived into this one",
    ).toBe(false);
  });
});

describe("the third answer — a run that refused to judge", () => {
  // odd2 measured this hole and `notes/odd2-driver.ts` row `D-P6` is where it
  // was printed: two empty directories, every invocation failing identically on
  // both sides, `PARITY-OK` and exit 0. Two engines that both fail the same way
  // *are* at parity by this harness's definition, which is exactly why the
  // definition needed a third answer rather than a fourth rule.

  test("two empty directories are refused, with exit 3 and no PARITY-OK", async () => {
    // Cheap enough to be a unit test: the refusal happens in the preflight,
    // before a single scenario runs. It spawns the harness rather than calling
    // it, because the exit code is the thing under test and this file cannot
    // `process.exit`. No `git archive` and no real HOME — both specs are
    // directories, and the preflight's own home is inside `--work` (G4-3).
    const base = await mkdtemp(join(tmpdir(), "mind-parity-hollow-base-"));
    const head = await mkdtemp(join(tmpdir(), "mind-parity-hollow-head-"));
    const work = await mkdtemp(join(tmpdir(), "mind-parity-hollow-work-"));
    scratch.push(base, head, work);

    const child = Bun.spawn(
      ["bun", "run", SCRIPT, "--base", base, "--head", head, "--only", "02-unknown", "--work", work],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;

    expect(child.exitCode, `${stdout}\n${stderr}`).toBe(3);
    expect(stderr).toContain("PARITY-UNDECIDED");
    expect(stderr).toContain("no bin/mind.ts");
    // The part that matters to anything reading this harness's output: the
    // words that mean "the two sides agree" are nowhere in a run that did not
    // compare them.
    expect(`${stdout}\n${stderr}`).not.toContain("PARITY-OK");
  }, 60_000);

  test("a digest of a tree changes with one byte, and not with the path it is at", async () => {
    // What the `--base HEAD --head .` refusal stands on. If this were a digest
    // of anything else — a file count, a modification time — the refusal would
    // fire on trees that really do differ, or miss ones that do not.
    const one = await mkdtemp(join(tmpdir(), "mind-parity-digest-a-"));
    const two = await mkdtemp(join(tmpdir(), "mind-parity-digest-b-"));
    scratch.push(one, two);

    for (const dir of [one, two]) {
      await Bun.write(join(dir, "bin", "mind.ts"), "console.log('x');\n");
      await Bun.write(join(dir, "src", "a.ts"), "export const a = 1;\n");
    }
    expect(await treeDigest(one)).toBe(await treeDigest(two));

    await Bun.write(join(two, "src", "a.ts"), "export const a = 2;\n");
    expect(await treeDigest(one)).not.toBe(await treeDigest(two));
  });

  test("…and with a file that is only on one side", async () => {
    // The `gate4` bug's shape, asked of the digest rather than of the engine
    // directory: a deletion has to move it.
    const one = await mkdtemp(join(tmpdir(), "mind-parity-digest-c-"));
    const two = await mkdtemp(join(tmpdir(), "mind-parity-digest-d-"));
    scratch.push(one, two);

    await Bun.write(join(one, "kept.ts"), "export const a = 1;\n");
    await Bun.write(join(two, "kept.ts"), "export const a = 1;\n");
    await Bun.write(join(two, "extra.ts"), "export const b = 2;\n");
    expect(await treeDigest(one)).not.toBe(await treeDigest(two));
  });
});

describe("the controls are run, not just described", () => {
  test(
    "one scenario of --selftest: the harness is steady, and it is not blind",
    async () => {
      // The whole point of the mini-run. Control 1 runs one revision against
      // itself and must find nothing; control 2 changes one character in an
      // error message and must find it. A comparison that cannot fail is not
      // evidence, and a control that only runs when somebody remembers is a
      // control that ran once.
      //
      // Cheap enough to be automatic: a directory spec, so `copyTree` rather
      // than `git archive`; one scenario of fourteen; HOME inside the sandbox
      // the harness builds per step, never this machine's.
      const work = await mkdtemp(join(tmpdir(), "mind-parity-test-"));
      scratch.push(work);

      const started = Bun.nanoseconds();
      const child = Bun.spawn(
        ["bun", "run", SCRIPT, "--base", ROOT, "--selftest", "--only", "02-unknown", "--work", work],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(child.stdout).text();
      await new Response(child.stderr).text();
      await child.exited;
      const seconds = (Bun.nanoseconds() - started) / 1e9;

      expect(child.exitCode, stdout).toBe(0);
      expect(stdout).toContain("control 1");
      expect(stdout).toContain("PARITY-OK");
      expect(stdout).toContain("control 2 passed");
      // The third: an added line, which is the one the `inserted` declarations
      // are able to hide and therefore the one that has to be proved visible.
      expect(stdout).toContain("control 3 passed");
      // The fourth: a side with no engine in it. Controls 1 to 3 all ask
      // whether a difference is seen; this one asks whether a comparison that
      // never happened gets reported as one.
      expect(stdout).toContain("control 4 passed");

      // G4-2's budget, measured and printed rather than asserted — and the
      // comment this replaces said the bar was "where a regression is a
      // regression rather than a slow morning". A slow morning crossed it:
      // 5.93 s on 2026-09-22 while another suite and six bun processes were
      // running, against ~1.3-1.8 s on a quiet machine. Asserting wall-clock
      // time in a suite that shares a machine makes the verdict depend on what
      // else is running, which is the flake `odd3` found in the truncation
      // canary and the rule D-028 settled: assert what is deterministic, print
      // what is not. The controls above are the deterministic part; this number
      // is not, so it goes to the reader with the load beside it.
      //
      // The ceiling that remains is this test's own timeout, which is there to
      // catch a structural change — a control that started spawning the whole
      // matrix — rather than a busy machine. It was 20 s; on 2026-10-05 the
      // mini-run took 8.8 s on an idle machine (the tree it copies per side has
      // grown to ~550 files), which left a loaded CI runner under coverage no
      // room. 120 s: still far below "the whole matrix", and the slowdown itself
      // is reported, not hidden — the number printed below is the measurement.
      const load = (await import("node:os")).loadavg()[0] ?? 0;
      console.log(
        `  mini-selftest: ${seconds.toFixed(2)}s (G4-2 budget 5s, measured on a quiet ` +
          `machine at ~1.3-1.8s) · 1-minute load average ${load.toFixed(2)} · ` +
          `not asserted, because it depends on what else this machine is doing`,
      );

      // `--work` was honoured: the recordings are here, and nothing was written
      // to the directory a run started by hand would be using.
      expect(await Bun.file(join(work, "out", "base", "02-unknown.txt")).exists()).toBe(true);
    },
    120_000,
  );
});

describe("the harness can be imported at all", () => {
  test("nothing in the script runs until it is run as a program", async () => {
    // This test file imported it, and the suite is still going — which is the
    // strongest form of the assertion, because the previous shape of this file
    // would have called `process.exit(2)` before the first `expect` below.
    const source = await readFile(SCRIPT, "utf8");
    expect(unguardedTopLevel(SCRIPT, source)).toEqual([]);
    expect(source).toContain("if (import.meta.main)");
  });

  test("the control: the three ways the guard could come undone, on the real file", async () => {
    // Over the real source's *text*, mutated in memory and never executed. The
    // ordinary way to prove a guard bites is to break it and watch it go red,
    // and here that means a `process.exit(2)` in the middle of `bun test`.
    const source = await readFile(SCRIPT, "utf8");
    const GUARD = "if (import.meta.main) process.exit(await main());";
    expect(source).toContain(GUARD);

    const shapes: ReadonlyArray<readonly [string, string]> = [
      ["a top-level await put back", `const code = await main();\n${GUARD}`],
      ["the guard dropped", "process.exit(await main());"],
      [
        "the guard replaced by something that is true on import",
        `if (Bun.argv.length > 1) ${GUARD.slice("if (import.meta.main) ".length)}`,
      ],
    ];

    for (const [what, replacement] of shapes) {
      const mutated = source.replace(GUARD, replacement);
      expect(mutated, what).not.toBe(source);
      expect(unguardedTopLevel(SCRIPT, mutated), what).not.toEqual([]);
    }
  });

  test("npm run parity points at this script", async () => {
    const manifest = await Bun.file(join(ROOT, "package.json")).json();
    expect(manifest.scripts.parity).toBe("bun run scripts/cli-parity.ts");
  });
});
