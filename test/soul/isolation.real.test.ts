/**
 * The same five questions, asked of a real local model — opt-in and local only.
 *
 * Run with:
 *
 *     MIND_REAL_ISOLATION=1 MIND_REAL_MODEL=<ollama model> \
 *       bun test test/soul/isolation.real.test.ts
 *
 * Skipped otherwise, and ollama only: I-1 says the local path has to work, and
 * spending a cloud CLI's quota to watch a model not know something is a poor
 * trade. A test that silently passed when its daemon was missing would be worse
 * than no test, so the skip is explicit and the run is loud.
 *
 * ## What this is, and what the gate is
 *
 * `test/soul/isolation.test.ts` is the gate. It proves the claim Mind can
 * actually make — that after a switch the other identity's text is not in the
 * channel — using a backend that would repeat anything it was given.
 *
 * This file is the other half of the sentence, and it is *evidence about this
 * machine on this day*, not a property of the system. A failure here means one
 * of two things: a leak, or a model reproducing a synthetic sentence it was
 * never shown. Both are worth a human reading the raw answers, which is why
 * every one of them is printed.
 *
 * Nothing is written anywhere. The souls are synthetic (D-021) and live in a
 * temporary directory; the identity travels in the system field of each
 * request, which is gone when the request is.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backend } from "../../src/exec/index.ts";
import { factProbes, FACTS_PER_SOUL, sharedFacts } from "../../src/soul/isolation.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { renderSoul } from "../../src/soul/render.ts";
import { normalize, scoreAnswer } from "../../src/soul/verify.ts";
import { subjectId } from "../../src/types.ts";
import { factValues, SOUL_A, SOUL_B, writeSoul } from "../support/synthetic-soul.ts";
import { RESTRAINED } from "../support/restraint.ts";

const ENABLED = process.env["MIND_REAL_ISOLATION"] === "1";
const MODEL = process.env["MIND_REAL_MODEL"];

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED || MODEL === undefined || MODEL === "")(
  "isolation against a real local model",
  () => {
    test(
      "wearing B, the model cannot produce any of A's five facts",
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "mind-isolation-real-"));
        scratch.push(dir);

        const a = await loadSoul(await writeSoul(dir, SOUL_A), subjectId(SOUL_A.subject));
        const b = await loadSoul(await writeSoul(dir, SOUL_B), subjectId(SOUL_B.subject));
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;

        // The fixture control, before a single turn is spent.
        expect(sharedFacts(a.soul, b.soul)).toEqual([]);

        const wearingA = renderSoul(a.soul);
        const wearingB = renderSoul(b.soul);

        // Mind's own half of the claim, and the only part of this file that
        // is a property rather than an observation: what B's system field
        // carries holds none of A's facts.
        const folded = normalize(wearingB);
        for (const value of factValues(SOUL_A)) {
          expect(folded).not.toContain(normalize(value));
        }

        const exec = backend("ollama", { model: MODEL! });
        const availability = await exec.available();
        expect(availability.ok, availability.detail).toBe(true);

        const ask = async (system: string, soul: typeof a.soul) => {
          const results = [];
          for (const probe of factProbes(soul, () => Math.random().toString(36).slice(2, 10))) {
            const turn = await exec.run({ restraint: RESTRAINED, subject: soul.subject, prompt: probe.question, system });
            results.push({ probe, verdict: scoreAnswer(probe, turn), answer: turn.text });
          }
          return results;
        };

        // The control: wearing A, its own facts are reachable. Without this, a
        // model that answers "unknown" to everything would look like isolation.
        const control = await ask(wearingA, a.soul);
        const recalled = control.filter((r) => r.verdict === "confirmed" || r.verdict === "partial");
        console.log(
          `ollama (${MODEL}) wearing ${SOUL_A.subject}: ${recalled.length}/${FACTS_PER_SOUL} of ` +
            `its own facts came back\n` +
            control.map((r) => `  ${r.probe.id}: ${JSON.stringify(r.answer.slice(0, 200))}`).join("\n"),
        );

        // Now the switch: B's identity in the system field, A's questions.
        const after = await ask(wearingB, a.soul);
        const leaked = after.filter((r) => r.verdict === "confirmed" || r.verdict === "partial");
        console.log(
          `ollama (${MODEL}) wearing ${SOUL_B.subject}: ${leaked.length}/${FACTS_PER_SOUL} of ` +
            `${SOUL_A.subject}'s facts came back\n` +
            after.map((r) => `  ${r.probe.id}: ${JSON.stringify(r.answer.slice(0, 200))}`).join("\n"),
        );

        expect(
          leaked.map((r) => `${r.probe.id}: ${r.answer}`),
          "a fact of the identity that is not worn came back from a model that was never given " +
            "it — read the raw answers above before believing either explanation",
        ).toEqual([]);

        // Said plainly rather than left for the reader to infer from a green
        // run: the control is information, not an assertion, because how much a
        // model recalls of its own system prompt is the model's property.
        if (recalled.length === 0) {
          console.log(
            `note: ${MODEL} recalled none of its own facts either, so the run above says nothing ` +
              `about isolation. Try a larger model before reading it as evidence.`,
          );
        }
      },
      900_000,
    );
  },
);
