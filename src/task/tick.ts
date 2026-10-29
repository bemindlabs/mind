/**
 * S22.10 (D-197, AO-1) — which tasks a tick carries on.
 *
 * A runner that died, a machine that restarted and a task parked until its backend is back all leave a task that
 * nobody is running. `Restart=no` on the runner's unit was a decision (`unit.ts`): resuming is a decision, and this is
 * where it is made, as a pure answer over the records. `mind task tick` asks it and starts a runner for each yes; the
 * owner's own timer calls the tick. Mind starts no timer of its own.
 *
 * Two limits keep a tick from being a loop that burns the budget:
 *
 * - a task is carried on only up to {@link MAX_RUNNERS} runners in all (its `generation`): one that keeps dying is a
 *   bug or a poison step, and a person looks at it;
 * - at most `max` tasks per tick, oldest first, so a hundred parked tasks do not all start at once.
 *
 * Nothing here touches the brake or the dial: the command refuses to tick while the brake is on.
 */

import { shownStatus, type TaskRecord } from "./store.ts";

/** A task that has had this many runners is left to a person. */
export const MAX_RUNNERS = 20;
/** Tasks carried on by one tick unless the caller says another number. */
export const DEFAULT_TICK_MAX = 3;

export interface TickChoice {
  readonly id: string;
  readonly action: "resume" | "skip";
  /** One line: why this one, or why not. */
  readonly why: string;
}

/**
 * What a tick does with each task that is interrupted or parked. Tasks in any other state are not mentioned.
 *
 * @param stat Whether a pid is alive, as `shownStatus` takes it.
 */
export function tickChoices(
  records: readonly TaskRecord[],
  now: number,
  max: number,
  stat?: Parameters<typeof shownStatus>[1],
): readonly TickChoice[] {
  const candidates: { readonly record: TaskRecord; readonly action: "resume" | "skip"; readonly why: string }[] = [];
  for (const record of records) {
    const status = shownStatus(record, stat, now);
    if (status !== "interrupted" && status !== "parked") continue;
    if ((record.generation ?? 0) >= MAX_RUNNERS) {
      candidates.push({ record, action: "skip", why: `it has had ${record.generation} runners already — a person looks at it (\`mind task show\`)` });
    } else if (status === "parked" && record.resumeAfter === undefined) {
      candidates.push({ record, action: "skip", why: "parked with no time to go on: `mind task resume` is a person's decision" });
    } else if (status === "parked" && Date.parse(record.resumeAfter!) > now) {
      candidates.push({ record, action: "skip", why: `parked until ${record.resumeAfter}` });
    } else {
      candidates.push({ record, action: "resume", why: status === "parked" ? "its time to go on has come" : "its runner is gone" });
    }
  }
  // Oldest first, so the longest-waiting task is the one that starts when the tick cannot carry them all.
  candidates.sort((a, b) => Date.parse(a.record.createdAt) - Date.parse(b.record.createdAt));
  let started = 0;
  return candidates.map(({ record, action, why }) => {
    if (action === "resume" && started >= max) return { id: record.id, action: "skip" as const, why: `over this tick's limit of ${max}; the next tick` };
    if (action === "resume") started += 1;
    return { id: record.id, action, why };
  });
}
