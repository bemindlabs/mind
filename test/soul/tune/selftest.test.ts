/** S21.7 — the four controls and their sabotaged twins: that they run, discriminate, clean up and seal. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectByRule } from "../../../src/soul/eval-compare.ts";
import { checkProof, CONTROLS, writeProof, type EngineIdentity } from "../../../src/soul/tune/proof.ts";
import { PERSON_NEEDLES, proofOf, runControls, runSelftest, scriptedPass, selftestLines, withScratch, type SelftestOutcome } from "../../../src/soul/tune/selftest.ts";
import { VERSION } from "../../../src/version.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "mind-selftest-"));
  dirs.push(d);
  return d;
};
const options = (stateRoot: string) => ({ stateRoot, env: process.env, now: () => new Date("2026-10-20T09:00:00Z") });
const ENGINE: EngineIdentity = { version: VERSION, gitSha: "a".repeat(40), sourceSha256: "b".repeat(64) };

describe("the selftest", () => {
  test("every control passes, every sabotaged twin is caught for its own reason, and the throwaway is gone", async () => {
    const state = await tmp();
    const outcome = await runSelftest(options(state));
    expect(outcome.ok).toBe(true);
    expect(outcome.controls.map((c) => [c.control, c.pass])).toEqual(CONTROLS.map((c) => [c, true]));
    expect(outcome.twins.map((t) => [t.control, t.caught])).toEqual(CONTROLS.map((c) => [c, true]));
    const by = Object.fromEntries(outcome.controls.map((c) => [c.control, c.evidence]));
    expect(by["noop"]).toContain("adopt refused");
    expect(by["good"]).toContain("selftest@agents.mind.invalid");
    expect(by["harmful"]).toContain("pass→flaky");
    expect(by["leak"]).toContain("none found");
    expect(outcome.twins.find((t) => t.control === "leak")!.evidence).toContain("person.md text");
    expect(await readdir(join(state, "scratch", "tune"))).toEqual([]);
    const text = selftestLines(outcome).join("\n");
    expect(text).toContain("ALL as required: 4/4 controls passed, 4/4 twins caught.");
    expect(text).toContain("(d) leak");
  }, 120_000);

  test("a twin whose sabotage does not change the round shows a blind control, and one that fails for another reason is not counted", async () => {
    const state = await tmp();
    const root = await mkdtemp(join(state, "x-"));
    // Not sabotaged at all: the control passes on it, so it cannot tell.
    const blind = await runControls(root, options(state), [{ control: "noop", sabotage: "nothing", because: "was selected", parts: {} }]);
    expect(blind.twins[0]).toMatchObject({ control: "noop", caught: false });
    expect(blind.twins[0]!.evidence).toContain("cannot tell a broken tuner from a sound one");
    expect(blind.ok).toBe(false);
    expect(selftestLines(blind).join("\n")).toContain("FAIL  (a) noop");
    // Fails, but not for the reason the twin names.
    const other = await runControls(root, options(state), [{ control: "good", sabotage: "never adopts", because: "no such words", parts: { select: (b, c) => ({ ...selectByRule(b, c), verdict: "keep-base" as const }) } }]);
    expect(other.twins[0]!.caught).toBe(false);
    expect(other.twins[0]!.evidence).toContain("not because of the sabotage");
  }, 120_000);

  test("withScratch removes its directory on a return, on a throw, and leaves the signal handlers as it found them", async () => {
    const state = await tmp();
    const before = process.listenerCount("SIGINT");
    let seen = "";
    await withScratch(state, async (root) => {
      seen = root;
      expect(process.listenerCount("SIGINT")).toBe(before + 1);
      await mkdir(join(root, "inner"), { recursive: true });
    });
    expect(await Bun.file(seen).exists()).toBe(false);
    await expect(
      withScratch(state, async (root) => {
        seen = root;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await readdir(join(state, "scratch", "tune"))).toEqual([]);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("proofOf", () => {
  const ok = (over: Partial<SelftestOutcome> = {}): SelftestOutcome => ({
    controls: CONTROLS.map((control) => ({ control, title: control, pass: true, evidence: `saw ${control}` })),
    twins: CONTROLS.map((control) => ({ control, sabotage: "x", caught: true, evidence: "failed" })),
    ok: true,
    ...over,
  });

  test("sealed and valid for the engine it was made on, only when everything behaved and the build can be bound", async () => {
    const state = await tmp();
    const proof = proofOf(ok(), ENGINE, new Date("2026-10-20T09:00:00Z"))!;
    expect(proof.controls).toEqual({ noop: true, good: true, harmful: true, leak: true });
    expect(proof.evidence.good).toBe("saw good");
    await writeProof(join(state, "evals"), proof);
    expect((await checkProof(join(state, "evals"), ENGINE)).ok).toBe(true);
    expect(proofOf(ok({ ok: false }), ENGINE, new Date())).toBeNull();
    expect(proofOf(ok(), { ...ENGINE, sourceSha256: null }, new Date())).toBeNull();
  });
});

describe("the scripted pieces", () => {
  test("RULE passes, BREAK beats RULE, FLAKY passes the first attempt only; the person markers are distinct", () => {
    expect(scriptedPass("RULE-t1", "t1", 1)).toBe(true);
    expect(scriptedPass("RULE-t1", "t2", 1)).toBe(false);
    expect(scriptedPass("RULE-t1 BREAK-t1", "t1", 1)).toBe(false);
    expect([1, 2].map((a) => scriptedPass("FLAKY-t1", "t1", a))).toEqual([true, false]);
    expect(new Set(PERSON_NEEDLES).size).toBe(PERSON_NEEDLES.length);
  });
});
