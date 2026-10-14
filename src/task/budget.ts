/**
 * A task's budget (D-154): turns, minutes and tokens — asked before every step, so a runaway task ends at the
 * limit rather than past it.
 *
 * - **turns** — every step's turn counts, the plan included, and a step a crash interrupted too: a turn that may
 *   have reached a backend has been spent.
 * - **minutes** — active time: the wall time of the steps, minus the time a step sat paused on the owner's
 *   answer to a sensitive action (D-156). A task the owner left waiting overnight has not worked overnight.
 * - **tokens** — input + output as each backend counted them (`TurnResult.evidence.usage`). A backend that does
 *   not report makes the count a floor; that is said, not hidden. claude counts its cache reads as input
 *   (~80,000 a turn, measured for D-139), so a token budget for claude is mostly a turn budget.
 *
 * A step that is running when a limit is reached finishes: its turn has its own timeout, which is never longer
 * than the minutes left (plus one approval's wait).
 */

import type { Budget, TaskRecord } from "./store.ts";

export const DEFAULT_BUDGET: Budget = { turns: 12, minutes: 30, tokens: null };
export const MAX_TURNS = 200;
export const MAX_MINUTES = 24 * 60;
export const DEFAULT_STEP_SECONDS = 600;
export const DEFAULT_APPROVAL_SECONDS = 600;
export const MIN_STEP_SECONDS = 30;
export const MAX_APPROVAL_SECONDS = 3600;

/** Why the budget allows no next step, or `undefined`. */
export function budgetSpent(record: TaskRecord): string | undefined {
  const { budget, used } = record;
  if (used.turns >= budget.turns) return `its budget of ${budget.turns} turn(s) is spent`;
  if (used.activeMs >= budget.minutes * 60_000) return `its budget of ${budget.minutes} minute(s) is spent`;
  if (budget.tokens !== null && used.tokens >= budget.tokens) {
    return `its budget of ${budget.tokens} token(s) is spent (${used.tokens} counted${used.tokensUnknown > 0 ? `, and ${used.tokensUnknown} step(s) reported none` : ""})`;
  }
  return undefined;
}

/** A step's turn timeout: its own ceiling or the minutes left, whichever is less — plus one approval's wait. */
export function stepTimeoutMs(record: TaskRecord): number {
  return activeLimitMs(record) + (record.operate >= 2 ? record.approvalSeconds * 1000 * MAX_HOLDS_PER_STEP : 0);
}

/**
 * How many held actions a step's turn has room to wait on. The turn's own timeout is a ceiling the runner
 * cannot move once the turn has started, so it leaves room for this many full waits; the runner ends the turn
 * itself when its *active* time — wall time minus every hold — passes {@link activeLimitMs} (review of PR #24).
 */
export const MAX_HOLDS_PER_STEP = 4;

/** A step's own limit on active time: its ceiling or the minutes left, at least ten seconds. */
export function activeLimitMs(record: TaskRecord): number {
  const left = Math.max(0, record.budget.minutes * 60_000 - record.used.activeMs);
  return Math.max(Math.min(record.stepSeconds * 1000, left), 10_000);
}

/** Parse a positive whole number flag, or say why not. */
export function wholeNumber(raw: string | undefined, name: string, min: number, max: number): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!/^[0-9]{1,9}$/.test(raw)) return { ok: false, reason: `${name} takes a whole number` };
  const value = Number(raw);
  if (value < min || value > max) return { ok: false, reason: `${name} must be ${min}–${max}` };
  return { ok: true, value };
}
