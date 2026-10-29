/**
 * S22.15 (D-201) — notice when a backend starts answering with another model, so the new one is measured before it is
 * trusted.
 *
 * "claude" is not a model; `claude-opus-5` and `claude-opus-5-5` are. A backend's alias moves under it: the same
 * `--backend claude` is one model today and another after a release, and a table that merged them would credit the new
 * model with the old one's record. So the table keys by the model the backend's own output named (S22.14), the ranking
 * counts only the current model's outcomes (the older model's are a prior, shown and not counted), and this file is
 * what notices the change.
 *
 * It compares the newest model the finished tasks' measure lines name for each backend with the last one **seen** — a small book under the
 * state root, written only when the person asks (`--update`), so a change is reported until somebody has read it.
 * A backend seen for the first time is not a change: there is nothing to compare with.
 *
 * Not here: the version of the CLI itself (`mind doctor` already checks that drift), and the small fixed eval before a
 * new model is trusted (`mind eval`, run by the person: it spends turns on a vendor).
 */

import type { Measure } from "./measure.ts";

export interface Seen {
  readonly model: string;
  /** ISO time a finished task first showed this model for the backend, as far as `--update` has seen. */
  readonly since: string;
}
export type SeenBook = Readonly<Record<string, Seen>>;

export interface ModelChange {
  readonly backend: string;
  readonly from: string;
  readonly to: string;
  /** When a finished task first shows the new model for this backend. */
  readonly since: string;
}

export interface Watched {
  readonly changes: readonly ModelChange[];
  /** Backends whose model is seen for the first time: nothing to compare, recorded by `--update`. */
  readonly first: readonly { readonly backend: string; readonly model: string; readonly since: string }[];
  /** What the book should hold after `--update`. */
  readonly next: SeenBook;
}

export function watch(measures: readonly Measure[], seen: SeenBook): Watched {
  // Only what the steps of finished tasks named: read from the measure lines, never back from the ledger (D-022).
  const named: { backend: string; model: string; at: string }[] = [];
  for (const m of measures) for (const step of m.steps) if (step.model !== null) named.push({ backend: step.backend, model: step.model, at: m.at });
  const byBackend = new Map<string, typeof named>();
  for (const item of named) byBackend.set(item.backend, [...(byBackend.get(item.backend) ?? []), item]);
  const changes: ModelChange[] = [];
  const first: Watched["first"][number][] = [];
  const next: Record<string, Seen> = { ...seen };
  for (const [backend, lines] of byBackend) {
    const newest = lines.reduce((a, b) => (b.at > a.at ? b : a));
    const since = lines.filter((line) => line.model === newest.model).reduce((a, b) => (b.at < a.at ? b : a)).at;
    const before = seen[backend];
    if (before === undefined) {
      first.push({ backend, model: newest.model, since });
      next[backend] = { model: newest.model, since };
    } else if (before.model !== newest.model) {
      changes.push({ backend, from: before.model, to: newest.model, since });
      next[backend] = { model: newest.model, since };
    }
  }
  return { changes, first, next };
}

const shellWord = (value: string): string => /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** A command for the owner to run, never executed here. */
export function evalCommand(backend: string, dir?: string, subject?: string): string {
  return `mind eval code ${dir === undefined ? "<agent-dir>" : shellWord(dir)} --subject ${subject === undefined ? "<id>" : shellWord(subject)} --set evals/code --backend ${shellWord(backend)}`;
}

/** One person-readable block for a change: what moved, what it means for the table, and what to do before trusting it. */
export function changeWords(change: ModelChange, priorOutcomes: number, dir?: string, subject?: string): string[] {
  return [
    `${change.backend}: ${change.from} → ${change.to} (first seen ${change.since.slice(0, 10)})`,
    `  Its rows start independently for every kind of work; ${priorOutcomes} outcome(s) of older models are a prior, shown and never counted. Dispatch samples it until it has its own.`,
    `  A price is never guessed: whether ${change.to} has one is what the ledger's own \`not_charged\` says for its turns.`,
    `  Before it is trusted: run \`${evalCommand(change.backend, dir, subject)}\` and read it beside the old model's.`,
  ];
}
