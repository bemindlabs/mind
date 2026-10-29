/**
 * S22.10 (D-197) — a task whose backends are all resting waits for the first of them, or is parked until then.
 *
 * S22.2 made a backend whose quota is gone rest (`src/exec/health.ts`). A step run while every backend of the task's
 * chain rests would get no answer, count as a failed step, and two in a row end the task — spending its budget on a
 * clock. So the runner asks this first (`backendReady`), the way it already asks about the local model: when every
 * backend of the chain is resting, no step starts, and the answer carries the time the first of them comes back.
 *
 * Only a chain that is named, and only when every member is resting. The usual chain (no `--backend`) ends in a
 * model on this machine, which never rests, so it is never held here. A chain with one member free is not held:
 * the turn's own fallback skips the resting ones.
 */

import type { Health } from "../exec/health.ts";
import type { TaskRecord } from "./store.ts";

export interface RestState {
  /** Epoch milliseconds: when the first backend of the chain is due back. */
  readonly retryAt: number;
  /** One line, from the fixed phrases of `src/exec/limit.ts` — never text a backend printed. */
  readonly reason: string;
}

/** The backend ids a task's `--backend` names, in order. Empty for the usual chain. */
export function namedChain(record: Pick<TaskRecord, "backend">): readonly string[] {
  return (record.backend ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
}

/** Whether every backend of the task's named chain is resting at `now`, and until when the first one is. */
export function chainRest(record: Pick<TaskRecord, "backend">, health: Health, now: number): RestState | undefined {
  const chain = namedChain(record);
  if (chain.length === 0) return undefined;
  const holds = chain.map((id) => ({ id, hold: health.coolingUntil(id, now) }));
  if (holds.some((entry) => entry.hold === undefined)) return undefined;
  const earliest = Math.min(...holds.map((entry) => entry.hold!.until));
  const parts = holds.map((entry) => `${entry.id}: ${entry.hold!.reason} (until ${new Date(entry.hold!.until).toISOString()})`);
  return { retryAt: earliest, reason: `every backend of its chain is resting — ${parts.join("; ")}` };
}
