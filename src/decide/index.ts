/**
 * Decide — choosing the next action, and stopping when it should not act.
 *
 * E5 filled the two halves the backlog put in the MVP, and the order they are
 * listed in is the order they matter in:
 *
 * - **`stop.ts`** (S5.4) — the brake, which is the existence of a file and
 *   nothing more, so that stopping Mind never depends on Mind working.
 * - **`runs.ts`** (S5.4) — the record that makes a running turn findable, and
 *   the identity check that stops a kill switch from killing the wrong process.
 * - **`autonomy.ts`** (S5.1) — the dial. Read its header before anything else
 *   here: it does not add restraint, it is what removes it.
 * - **`effective.ts`** (S5.1) — one rule, `min`, over the file, the environment
 *   ceiling and the brake. No source in Mind can raise a level.
 * - **`proposals.ts`** (S5.2) — what was asked before it was done, and the
 *   refusals that are not allowed to be forgotten. It arrived as a new file
 *   rather than a new parameter in the four above, which is what the sentence
 *   that used to be here said it would do. Read its header for D-029: this is a
 *   store of its own, outside the ledger, because AC2 needs a memory and the
 *   ledger is the one store that may never become one.
 *
 * S5.3 is `triggers.ts`: schedules the owner declares, each firing a turn held
 * at level 1 (D-054); triggers mined from behaviour still wait on S3.3.
 * Not here are S5.2's AC1 and AC4, which ask for something the vendor
 * CLIs do not expose — Mind sees a turn's stdout, stderr and exit code, not
 * the tool calls inside it — and which D-029 leaves to a decision of their own.
 */

export * from "./agent-proposal.ts";
export * from "./autonomy.ts";
export * from "./confirm.ts";
export * from "./effective.ts";
export * from "./proposals.ts";
export * from "./report.ts";
export * from "./runs.ts";
export * from "./sensitive.ts";
export * from "./sensitive-lang.ts";
export * from "./stop.ts";
export * from "./triggers.ts";
