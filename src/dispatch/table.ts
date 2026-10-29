/**
 * S22.14 AC2 (D-201) — what the measure lines say, per (backend, model, kind of work), with how many there were.
 *
 * Every row carries `n`. A rate from three tasks and a rate from three hundred are different facts, and a table that
 * shows only the rate lets the first pass for the second. The page and the command both print `n` beside it (AC4).
 *
 * `n` counts tasks that reached an outcome of the backend's doing or not: done, failed, or out of budget. A task the
 * owner **stopped** is counted apart and never in `n` or in a rate: stopping says nothing about the backend.
 *
 * What a rate is not: a score of skill. Two tasks of one kind are not equally hard, the finisher is credited for
 * what a handoff left it, and small `n` is noise. It is a direction, and the table says how many tasks it rests on.
 */

import type { Measure } from "./measure.ts";

export interface Row {
  readonly backend: string;
  /** The model the backend's own output named; `null` when it named none. An alias is never a model (D-142). */
  readonly model: string | null;
  readonly kind: string | null;
  /** Tasks done, failed or out of budget: what a rate rests on. */
  readonly n: number;
  readonly done: number;
  readonly failed: number;
  readonly budget: number;
  readonly stopped: number;
  /** `done / n`, or `null` when `n` is 0. */
  readonly doneRate: number | null;
  readonly turnsMean: number | null;
  readonly activeMsMean: number | null;
  /** Mean of the tokens the backends printed, over the tasks where any did; `null` when none did. */
  readonly tokensMean: number | null;
  readonly reviewed: number;
  /** Of the reviewed tasks, the share a reviewer asked changes for. `null` when none was reviewed. */
  readonly changeRate: number | null;
  readonly lastAt: string;
}

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/** The table: one row per (backend, model, kind), most-sampled first. Lines with no answering backend are left out. */
export function tableOf(measures: readonly Measure[]): readonly Row[] {
  const groups = new Map<string, Measure[]>();
  for (const m of measures) {
    if (m.backend === null) continue;
    const key = [m.backend, m.model ?? "", m.kind ?? ""].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const rows: Row[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const counted = group.filter((m) => m.status !== "stopped");
    const done = counted.filter((m) => m.status === "done").length;
    const reviewed = group.filter((m) => m.review !== null);
    rows.push({
      backend: first.backend!,
      model: first.model,
      kind: first.kind,
      n: counted.length,
      done,
      failed: counted.filter((m) => m.status === "failed").length,
      budget: counted.filter((m) => m.status === "budget").length,
      stopped: group.length - counted.length,
      doneRate: counted.length === 0 ? null : done / counted.length,
      turnsMean: mean(counted.map((m) => m.turns)),
      activeMsMean: mean(counted.map((m) => m.activeMs)),
      tokensMean: mean(counted.filter((m) => m.tokens !== null).map((m) => m.tokens!)),
      reviewed: reviewed.length,
      changeRate: reviewed.length === 0 ? null : reviewed.filter((m) => m.review!.changes > 0).length / reviewed.length,
      lastAt: group.map((m) => m.at).sort().at(-1)!,
    });
  }
  return rows.sort((a, b) => b.n - a.n || a.backend.localeCompare(b.backend) || (a.model ?? "").localeCompare(b.model ?? "") || (a.kind ?? "").localeCompare(b.kind ?? ""));
}

/** A rate for a person: `80% of 5`, never a bare percentage. */
export function rateWords(row: Pick<Row, "doneRate" | "n">): string {
  return row.doneRate === null ? "no outcome yet" : `${Math.round(row.doneRate * 100)}% of ${row.n}`;
}
