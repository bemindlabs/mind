/**
 * S22.14 (D-201) — the ranking, with the facts it needs gathered through the caller's hands.
 *
 * `rank` (choose.ts) is pure. This is the thin layer that feeds it: the measure lines of the subjects the person named,
 * each candidate's current model (from those lines), and whether each candidate can be first at all (resting, not
 * reachable). Reading is the caller's: this file touches no file and starts nothing, so a test hands it plain data.
 *
 * Which subjects feed the table is explicit. A table that quietly pooled every agent on the machine would read one
 * agent's metadata for another's task (I-3's spirit, though it is counts and labels, not words): the person names the
 * subjects with `--from`, and the task's own subject is always one of them.
 */

import { rank, type Candidate, type Ranking } from "./choose.ts";
import type { Measure } from "./measure.ts";
import { tableOf, type Row } from "./table.ts";

export interface PlanIo {
  readonly measures: (subject: string) => Promise<readonly Measure[]>;
  /** Why this backend cannot be first now (resting, not reachable), or `undefined` when it can. */
  readonly unusable: (backend: string) => Promise<string | undefined>;
}

/**
 * The newest model each backend's own output named in a finished task. An alias is never a model: a step records the
 * model its output named, or `null`, and `null` is no evidence. Read from the measure lines, not the ledger (D-022).
 */
export function currentModelsOf(measures: readonly Measure[]): ReadonlyMap<string, string> {
  const newest = new Map<string, { at: string; model: string }>();
  for (const m of measures) {
    for (const step of m.steps) {
      if (step.model === null) continue;
      const seen = newest.get(step.backend);
      if (seen === undefined || m.at > seen.at) newest.set(step.backend, { at: m.at, model: step.model });
    }
  }
  return new Map([...newest].map(([backend, { model }]) => [backend, model]));
}

export interface PlanIo {
  readonly measures: (subject: string) => Promise<readonly Measure[]>;
  /** Why this backend cannot be first now (resting, not reachable), or `undefined` when it can. */
  readonly unusable: (backend: string) => Promise<string | undefined>;
}

export interface Plan extends Ranking {
  readonly rows: readonly Row[];
  readonly subjects: readonly string[];
}

export async function plan(
  input: { readonly kind: string; readonly candidates: readonly string[]; readonly subjects: readonly string[]; readonly minN?: number; readonly explore?: number; readonly rand: () => number },
  io: PlanIo,
): Promise<Plan> {
  const subjects = [...new Set(input.subjects)];
  const measures = (await Promise.all(subjects.map((subject) => io.measures(subject)))).flat();
  const models = currentModelsOf(measures);
  const candidates: Candidate[] = [];
  for (const id of input.candidates) {
    const why = await io.unusable(id);
    candidates.push({ id, usable: why === undefined, ...(why === undefined ? {} : { why }), model: models.get(id) ?? null });
  }
  const rows = tableOf(measures);
  const ranking = rank(input.kind, candidates, rows, { ...(input.minN === undefined ? {} : { minN: input.minN }), ...(input.explore === undefined ? {} : { explore: input.explore }), rand: input.rand });
  return { ...ranking, rows, subjects };
}
