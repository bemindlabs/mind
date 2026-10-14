/**
 * The token counts, read off the vendors themselves — opt-in, and the only
 * layer here that can tell you the registry is still true.
 *
 * Run with:
 *
 *     MIND_REAL_USAGE=1 MIND_REAL_MODEL=<ollama model> bun test test/exec/usage.real.test.ts
 *
 * Skipped otherwise, and skipped on purpose. Everything else in this suite
 * measures Mind against a stub that was written to print what the registry
 * expects, so a suite that is entirely green proves only that Mind is
 * self-consistent. The claim `registry.ts` actually makes — *these are the
 * fields the vendor prints, on this stream, in this shape* — is a claim about
 * somebody else's program, and it goes stale without anyone touching this repo.
 * Only a real turn can check it.
 *
 * Why it cannot be a gate: each case spends a real turn. It costs quota, it
 * writes a transcript into the operator's own home, and it needs a logged-in
 * CLI — none of which belongs in `bun test`. A backend that is not available is
 * reported and skipped rather than failed, for the same reason.
 *
 * What a failure here means: the vendor moved, and every line Mind has
 * written since it moved says `missing` where it used to say a number. That is
 * the failure mode the three-state design chose — a visible gap instead of a
 * wrong figure — and this file is how the gap gets noticed.
 *
 * Nothing is written here by name (D-021): the home is whatever the operator's
 * environment says, the model comes from a variable, and no path is spelled out.
 */

import { describe, expect, test } from "bun:test";
import { CliExec } from "../../src/exec/cli-exec.ts";
import { OllamaExec } from "../../src/exec/ollama-exec.ts";
import { VENDORS } from "../../src/exec/registry.ts";
import type { ExecBackend } from "../../src/exec/backend.ts";
import { subjectId, type Usage } from "../../src/types.ts";
import { RESTRAINED } from "../support/restraint.ts";

const ENABLED = process.env["MIND_REAL_USAGE"] === "1";
const MODEL = process.env["MIND_REAL_MODEL"] ?? "";

const SUBJECT = subjectId("example");

/** Small, uninteresting, and answerable in one word: the cheapest real turn. */
const PROMPT = "Reply with exactly: ok";

/** Every backend that claims to report counts, plus the local one (I-1). */
function surveyed(): ExecBackend[] {
  const vendors = VENDORS.filter((spec) => spec.usage !== null).map((spec) => new CliExec(spec));
  const local = MODEL === "" ? [] : [new OllamaExec({ defaultModel: MODEL })];
  return [...vendors, ...local];
}

/** One line a human can read against `docs/cli-matrix.md`. */
function report(id: string, usage: Usage | undefined): string {
  if (usage === undefined) return `${id}: no usage on the evidence at all`;
  return `${id}: ${usage.status} · in=${usage.input} out=${usage.output} total=${usage.total}`;
}

describe.skipIf(!ENABLED)("what the vendors really print (opt-in)", () => {
  test("the registry names a channel each surveyed backend still uses", async () => {
    const backends = surveyed();
    expect(backends.length).toBeGreaterThan(0);

    const skipped: string[] = [];
    const measured: string[] = [];

    for (const backend of backends) {
      const ready = await backend.available();
      if (!ready.ok) {
        skipped.push(`${backend.id}: ${ready.detail}`);
        continue;
      }

      const result = await backend.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: PROMPT, timeoutMs: 120_000 });
      const usage = result.evidence.usage;
      measured.push(report(backend.id, usage));

      // Printed before it is asserted, so a failing run still tells the reader
      // what the vendor actually sent rather than only that it disagreed.
      console.log(`  ${report(backend.id, usage)}`);

      expect(usage).toBeDefined();
      // `missing` here is the whole finding: the vendor changed shape and the
      // registry has not. Re-measure and update both the spec and the matrix.
      expect(usage!.status).toBe("reported");

      // Whatever came back is a count, not a placeholder that happens to be
      // truthy: at least one number, and every number a whole one.
      const numbers = [usage!.input, usage!.output, usage!.total].filter(
        (value): value is number => value !== null,
      );
      expect(numbers.length).toBeGreaterThan(0);
      for (const value of numbers) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
    }

    for (const note of skipped) console.log(`  skipped — ${note}`);
    // Every backend unavailable is not a pass: it is a run that measured
    // nothing, and saying so beats a green tick over an empty loop.
    expect(measured.length).toBeGreaterThan(0);
  }, 600_000);
});
