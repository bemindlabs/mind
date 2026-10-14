/**
 * Wear A, switch to B, and prove nothing of A came with it.
 *
 * S1.6 AC2 is the sharpest sentence in the backlog: *สวม A → ถาม → สลับ B →
 * ถามเรื่องที่มีแต่ A รู้ → **B ตอบไม่ได้** (5 ข้อเท็จจริงที่แยกกันชัด)*. Five
 * facts, clearly separate, and the second identity must not be able to produce
 * any of them. This module is the question half of that; `worn.ts` is the disk
 * half, and the test that puts them together is `test/soul/isolation.test.ts`.
 *
 * ## Where the five facts come from
 *
 * From the soul's own `[extra]` table, sorted by key. That table is the one
 * open string table in the schema (`src/soul/schema.ts`) and
 * {@link import("./render.ts").renderSoul} already writes every entry into the
 * applied block under *Also true of this role* — so a fact planted there
 * genuinely travels the channel Mind controls, rather than being a question
 * about a field the model never saw.
 *
 * Derived rather than written down, for the reason `buildProbes` is derived
 * (D-003): a fact list hard-coded for one soul would measure that soul and pass
 * silently for every other.
 *
 * ## What this proves, and what it does not
 *
 * It proves a claim about the **channel**, which is the thing Mind owns: after
 * a switch, no text of A reaches the backend, so nothing a backend answers can
 * have come from A through Mind. It is *not* a claim about a model's memory.
 * A vendor with server-side conversation state, a session-start hook, or a
 * cached context can carry A's words past a file Mind rewrote, and no file
 * Mind writes can take those back (I-4). {@link ISOLATION_LIMITS} says that
 * where a reader meets the result.
 *
 * The questions are asked through {@link import("./verify.ts").verifySoul} — the
 * same protocol, scoring and four levels S1.3 uses — so "B could not answer A's
 * questions" and "A could" are readings of one instrument, not two.
 */

import type { ExecBackend } from "../exec/backend.ts";
import type { NonEmpty } from "../types.ts";
import { renderSoul } from "./render.ts";
import { ROLE_FILE, type Soul, type SoulIssue } from "./schema.ts";
import {
  askProbe,
  normalize,
  verifySoul,
  type Probe,
  type VerifyOptions,
  type VerifyReport,
} from "./verify.ts";

/** Facts AC2 asks for. Five, because AC2 says five. */
export const FACTS_PER_SOUL = 5;

/**
 * The shortest a fact may be, after {@link normalize}.
 *
 * A two-character expected answer matches by accident — `verifySoul` already
 * emits a caveat for one, and for an isolation run a caveat is not enough: the
 * whole result is "B could not say this", and a string short enough to turn up
 * in an unrelated sentence makes that unfalsifiable in the wrong direction.
 */
export const MIN_FACT_LENGTH = 8;

/**
 * The keys this soul carries facts under, in a fixed order.
 *
 * Sorted, so two runs over the same soul ask the same questions in the same
 * order and a diff of two reports is about the answers.
 */
export function factKeys(soul: Soul): readonly string[] {
  return Object.keys(soul.role.extra).sort();
}

/**
 * The fact questions, one per `[extra]` key, through the shared protocol.
 *
 * Shaped as a {@link import("./verify.ts").ProbeBuilder} so it can be handed
 * straight to `verifySoul`.
 *
 * @param wanted How many to ask. Fewer keys than this is not silently fewer
 *   questions — {@link factIssues} is where that is reported, before a run.
 */
export function factProbes(
  soul: Soul,
  nonce: () => string,
  wanted: number = FACTS_PER_SOUL,
): readonly Probe[] {
  return factKeys(soul)
    .slice(0, wanted)
    .map((key) => {
      const token = nonce();
      return {
        id: `fact:${key}`,
        asks: `what it knows as "${key}"`,
        nonce: token,
        expected: [soul.role.extra[key]!],
        question: askProbe(
          token,
          `Your standing instructions list facts under a heading "Also true of this role". ` +
            `What do they give for "${key}"?`,
        ),
      };
    });
}

/**
 * Reasons this soul cannot carry an isolation measurement.
 *
 * Checked *before* a run rather than read out of one afterwards. A soul with
 * three facts would produce a report that says "0 of 3 leaked" and reads like a
 * pass; a soul with two identical facts would produce a report where one wrong
 * answer counts twice. Both are how a green result gets weaker than it looks.
 */
export function factIssues(soul: Soul, wanted: number = FACTS_PER_SOUL): readonly SoulIssue[] {
  const issues: SoulIssue[] = [];
  const keys = factKeys(soul);

  if (keys.length < wanted) {
    issues.push({
      file: ROLE_FILE,
      line: 0,
      path: "extra",
      message:
        `an isolation run asks for ${wanted} fact(s) only this soul knows, and [extra] holds ` +
        `${keys.length}. Add entries there: every one of them is rendered into the block ` +
        `\`soul apply\` writes, so each is a fact the backend really was given.`,
    });
  }

  const seen = new Map<string, string>();
  for (const key of keys.slice(0, wanted)) {
    const value = soul.role.extra[key]!;
    const folded = normalize(value);

    if (folded.length < MIN_FACT_LENGTH) {
      issues.push({
        file: ROLE_FILE,
        line: 0,
        path: `extra.${key}`,
        message:
          `is ${folded.length} character(s) once punctuation and case are folded away, and an ` +
          `isolation run needs at least ${MIN_FACT_LENGTH}. A string this short can turn up in ` +
          `an answer by accident, which would read as a leak that is not one.`,
      });
      continue;
    }

    const first = seen.get(folded);
    if (first !== undefined) {
      issues.push({
        file: ROLE_FILE,
        line: 0,
        path: `extra.${key}`,
        message:
          `says the same thing as [extra].${first} once punctuation and case are folded away. ` +
          `AC2 asks for facts that are clearly separate; two that are not make one wrong answer ` +
          `count twice.`,
      });
      continue;
    }
    seen.set(folded, key);
  }

  return issues;
}

/**
 * Facts of `soul` that the *other* soul's rendered identity also carries.
 *
 * The control nobody thinks to run. If A and B happen to share a fact, then B
 * answering it is not a leak and a test that treated it as one would be red for
 * the wrong reason — or, worse, a fact they share would make B's inability to
 * answer look like isolation when it was a coincidence of wording. Non-empty
 * means the fixtures are wrong, not the system.
 */
export function sharedFacts(soul: Soul, other: Soul): readonly string[] {
  const theirs = normalize(renderSoul(other));
  return factKeys(soul)
    .map((key) => soul.role.extra[key]!)
    .filter((value) => {
      const folded = normalize(value);
      return folded.length > 0 && theirs.includes(folded);
    });
}

/** One fact of the wrong identity that came back anyway. */
export interface Leak {
  readonly backend: string;
  /** The probe id, e.g. `fact:project-codename`. */
  readonly probe: string;
  /** How strongly it came back: `confirmed` carries the run token, `partial` does not. */
  readonly verdict: "confirmed" | "partial";
  /** What should have been unanswerable. */
  readonly expected: readonly string[];
  /** The reply, verbatim, so a reader can disagree with the verdict. */
  readonly answer: string;
}

/**
 * Every answer in this report that should not have been possible.
 *
 * Read a report produced by asking **the other soul's** questions: anything
 * other than `failed` or `silent` is one identity's fact arriving in another's
 * mouth, which D-011 calls the most serious failure this system has. `silent`
 * is not a leak and is not a pass either — it means the backend never ran, and
 * {@link isolationHeld} refuses to call that isolation.
 */
export function leaks(report: VerifyReport): readonly Leak[] {
  return report.backends.flatMap((backend) =>
    backend.runs
      .filter((run) => run.verdict === "confirmed" || run.verdict === "partial")
      .map((run) => ({
        backend: backend.backend,
        probe: run.probe,
        verdict: run.verdict as "confirmed" | "partial",
        expected: run.expected,
        answer: run.answer,
      })),
  );
}

/**
 * Whether the switch held: every question was asked, and none was answered.
 *
 * Both halves are required, and the second is the one that is easy to lose. A
 * backend that could not run answers nothing, and a function that read "no
 * leaks" off that would report perfect isolation for a machine where the test
 * never happened — the silent success this project exists to catch. So a report
 * with no probe runs in it, or one whose runs were all `silent`, is `false`.
 */
export function isolationHeld(report: VerifyReport): boolean {
  const asked = report.backends.flatMap((backend) => backend.runs);
  if (asked.length === 0) return false;
  if (asked.every((run) => run.verdict === "silent")) return false;
  return leaks(report).length === 0;
}

/**
 * Ask one soul's five facts of a set of backends, through `verify`'s machinery.
 *
 * A thin composition on purpose: everything that decides a verdict lives in
 * `verify.ts`, so an isolation result and a verification result cannot disagree
 * about what an answer means.
 */
export function askFacts(
  soul: Soul,
  backends: NonEmpty<ExecBackend>,
  options: VerifyOptions,
  wanted: number = FACTS_PER_SOUL,
): Promise<VerifyReport> {
  return verifySoul(soul, backends, {
    ...options,
    probes: (forSoul, nonce) => factProbes(forSoul, nonce, wanted),
  });
}

/**
 * What an isolation result covers, printed with it.
 *
 * The first two lines are the ones that keep AC2 from being read as more than
 * it is. Mind owns the file and the request; it does not own the model, the
 * vendor's session store, or anything else on this machine that writes into the
 * same context.
 */
export const ISOLATION_LIMITS: readonly string[] = [
  "this measures the channel Mind controls: the block in each instruction file, and the " +
    "system field of a request. A pass means no text of the other identity reached the backend " +
    "through Mind.",
  "it is not a claim about a model's memory. A vendor with server-side conversation state, a " +
    "session-start hook, or a context cached before the switch can carry the other identity's " +
    "words past a file Mind rewrote, and no file Mind writes takes those back (I-4).",
  "the facts asked about are the soul's own [extra] entries. A soul that carries no distinctive " +
    "fact cannot be told apart from another by asking, and Mind says so rather than reporting " +
    "an empty run as isolation.",
  "memory is not measured here at all. A per-identity collection has a name " +
    "(`collectionFor`, src/memory/collection.ts) and no store behind it yet; the query-level " +
    "proof that B cannot read A's is owed by S4.1.",
];
