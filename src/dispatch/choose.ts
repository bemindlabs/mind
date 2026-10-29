/**
 * S22.14 AC3 (D-201) — which backend a task of a kind goes to first.
 *
 * The table decides only where it has the numbers to. A candidate with fewer than `minN` outcomes for this kind and
 * this model is **not trusted**: it is not ranked by a rate, it is sampled. Until some candidate has `minN`, every
 * task of the kind goes to the least-sampled usable one, so the data arrives; once some have, the best of them goes
 * first, except for a share of tasks (`explore`) that go to the least-sampled candidate so a new backend, or a new
 * model of an old one (S22.15), is not shut out for ever by its first bad week.
 *
 * Resting (S22.2) and unreachable backends are never first: they are put last, kept in the chain so a backend that
 * wakes in the middle of a task is still there for the next turn.
 *
 * Only an order is chosen. It is written into the task's chain at creation, said aloud with the numbers behind it, and
 * changed by nothing afterwards: the person can see why, and can override it with `--backend a,b` any time. Pure: the
 * dice are an argument, so a test says which way they fall.
 */

import type { Row } from "./table.ts";

/** The cloud backends a task may be dispatched among when the person names none. */
export const DISPATCH_CANDIDATES: readonly string[] = ["claude", "codex", "grok", "gemini", "copilot", "kimi"];
/** The fewest outcomes (done, failed, out of budget) a candidate needs, for a kind and a model, to be ranked by its rate. */
export const MIN_N = 5;
/** The share of tasks that go to the least-sampled candidate even when others are trusted. */
export const EXPLORE = 0.2;

export interface Candidate {
  readonly id: string;
  /** Resting, unreachable: last in the chain, and the reason is said. */
  readonly usable: boolean;
  readonly why?: string;
  /** The model this backend runs now, when known (`mind dispatch watch`). `null` counts every model it has run. */
  readonly model: string | null;
}

export interface Considered {
  readonly id: string;
  readonly n: number;
  readonly rate: number | null;
  readonly trusted: boolean;
  readonly note: string;
}

export interface Ranking {
  readonly chain: readonly string[];
  readonly mode: "table" | "explore" | "no-data";
  readonly considered: readonly Considered[];
  readonly reason: string;
}

interface Stat {
  readonly n: number;
  readonly done: number;
  readonly changeRate: number | null;
  readonly turnsMean: number | null;
  /** Outcomes of other models of this backend: shown as a prior, never counted. */
  readonly priorN: number;
}

function statOf(candidate: Candidate, kind: string, rows: readonly Row[]): Stat {
  const mine = rows.filter((row) => row.backend === candidate.id && row.kind === kind);
  const counted = candidate.model === null ? mine : mine.filter((row) => row.model === candidate.model);
  const n = counted.reduce((sum, row) => sum + row.n, 0);
  const done = counted.reduce((sum, row) => sum + row.done, 0);
  const weighted = (pick: (row: Row) => number | null): number | null => {
    const parts = counted.filter((row) => pick(row) !== null && row.n > 0);
    const total = parts.reduce((sum, row) => sum + row.n, 0);
    return total === 0 ? null : parts.reduce((sum, row) => sum + pick(row)! * row.n, 0) / total;
  };
  return {
    n,
    done,
    changeRate: weighted((row) => row.changeRate),
    turnsMean: weighted((row) => row.turnsMean),
    priorN: candidate.model === null ? 0 : mine.filter((row) => row.model !== candidate.model).reduce((sum, row) => sum + row.n, 0),
  };
}

export function rank(
  kind: string,
  candidates: readonly Candidate[],
  rows: readonly Row[],
  options: { readonly minN?: number; readonly explore?: number; readonly rand: () => number },
): Ranking {
  const minN = options.minN ?? MIN_N;
  const explore = options.explore ?? EXPLORE;
  const stats = new Map(candidates.map((candidate) => [candidate.id, statOf(candidate, kind, rows)]));
  const usable = candidates.filter((candidate) => candidate.usable);
  const unusable = candidates.filter((candidate) => !candidate.usable);
  const trusted = usable
    .filter((candidate) => stats.get(candidate.id)!.n >= minN)
    .sort((a, b) => {
      const x = stats.get(a.id)!;
      const y = stats.get(b.id)!;
      return y.done / y.n - x.done / x.n || (x.changeRate ?? 0) - (y.changeRate ?? 0) || (x.turnsMean ?? 0) - (y.turnsMean ?? 0);
    });
  const under = usable.filter((candidate) => stats.get(candidate.id)!.n < minN).sort((a, b) => stats.get(a.id)!.n - stats.get(b.id)!.n);

  const considered: Considered[] = candidates.map((candidate) => {
    const s = stats.get(candidate.id)!;
    const isTrusted = candidate.usable && s.n >= minN;
    const prior = s.priorN > 0 ? `; ${s.priorN} outcome(s) of older models are a prior, not measured for this model and not counted` : "";
    return {
      id: candidate.id,
      n: s.n,
      rate: s.n === 0 ? null : s.done / s.n,
      trusted: isTrusted,
      note: `${!candidate.usable ? `${candidate.why ?? "not usable now"}; last` : isTrusted ? `ranked by its rate over ${s.n}` : `only ${s.n} outcome(s) for ${kind}; not ranked, sampled`}${prior}`,
    };
  });

  let ordered: Candidate[];
  let mode: Ranking["mode"];
  let reason: string;
  if (trusted.length === 0) {
    mode = "no-data";
    ordered = under;
    reason = `no candidate has ${minN} outcomes for ${kind} yet, so the least-sampled goes first and the data arrives`;
  } else if (under.length > 0 && options.rand() < explore) {
    mode = "explore";
    ordered = [under[0]!, ...trusted, ...under.slice(1)];
    reason = `${trusted[0]!.id} leads the table for ${kind}, but this task samples ${under[0]!.id} (${Math.round(explore * 100)}% of tasks do)`;
  } else {
    mode = "table";
    ordered = [...trusted, ...under];
    const lead = stats.get(trusted[0]!.id)!;
    reason = `${trusted[0]!.id} leads for ${kind}: ${lead.done} of ${lead.n} done`;
  }
  return { chain: [...ordered, ...unusable].map((candidate) => candidate.id), mode, considered, reason };
}
