/**
 * S21.3 — two souls on the same tasks, compared mechanically (D-073: no model
 * judges a model).
 *
 * The unit is a task in one mode. Each side's attempts give it a verdict
 * (`stable pass`, `stable fail`, `flaky`, from S21.1), and the comparison is
 * the change between the two verdicts. A rate that moves between two flaky
 * readings is noise and is not a change either way.
 *
 * {@link selectByRule} is the owner's ruling T6, as a pure function: the
 * candidate is `adopt` only if the held-out pass rate rises and no held-out
 * task loses a pass the base had; a tie or any such loss is `keep-base`. A
 * held-out task "flips pass→fail" when the candidate loses passes the base
 * had: stable pass → flaky or stable fail, or flaky → stable fail. Both modes
 * count. Printing the verdict changes nothing: adoption is S21.5's.
 */

import { MIN_HELDOUT, MODES, pct, SPLITS, type Mode, type Split } from "./evals.ts";
import { soulShort, type EvalAttempt, type EvalRunRecord, type Style, type Verdict } from "./eval-runs.ts";

/** What one side of a comparison needs: its attempt rows. */
export interface CompareSide {
  readonly results: readonly EvalAttempt[];
}

export type Change = "pass→fail" | "fail→pass" | "pass→flaky" | "fail→flaky" | "flaky→pass" | "flaky→fail" | "same";

/** The changes that lose a pass the base had: what T6 calls a flip pass→fail. */
export const REGRESSIONS: ReadonlySet<Change> = new Set<Change>(["pass→fail", "pass→flaky", "flaky→fail"]);

export interface SideRate {
  readonly passes: number;
  readonly attempts: number;
  readonly verdict: Verdict;
}

export interface TaskChange {
  readonly task: string;
  readonly kind: string;
  readonly mode: Mode;
  readonly split: Split;
  readonly base: SideRate;
  readonly candidate: SideRate;
  readonly change: Change;
}

export interface SplitDelta {
  readonly split: Split;
  readonly tasks: number;
  /** Passes over attempts, both modes, as a percentage. */
  readonly base: number;
  readonly candidate: number;
  /** candidate − base, in points, to one place. */
  readonly delta: number;
}

export interface Comparison {
  /** Every task × mode on both sides, in the base's order. */
  readonly rows: readonly TaskChange[];
  readonly bySplit: readonly SplitDelta[];
}

const key = (task: string, mode: Mode) => `${task}\0${mode}`;

function rates(side: CompareSide): Map<string, { readonly task: string; readonly kind: string; readonly mode: Mode; readonly split: Split; readonly rate: SideRate }> {
  const out = new Map<string, { task: string; kind: string; mode: Mode; split: Split; passes: number; attempts: number }>();
  for (const r of side.results) {
    const k = key(r.task, r.mode);
    const row = out.get(k) ?? { task: r.task, kind: r.kind, mode: r.mode, split: r.split ?? "train", passes: 0, attempts: 0 };
    row.attempts += 1;
    if (r.pass) row.passes += 1;
    out.set(k, row);
  }
  return new Map(
    [...out].map(([k, { task, kind, mode, split, passes, attempts }]) => [
      k,
      { task, kind, mode, split, rate: { passes, attempts, verdict: passes === attempts ? "stable pass" : passes === 0 ? "stable fail" : "flaky" } },
    ]),
  );
}

const SHORT: Readonly<Record<Verdict, string>> = { "stable pass": "pass", "stable fail": "fail", flaky: "flaky" };

/** The change from one verdict to another; two flaky readings are the same, whatever their rates. */
export function changeOf(base: Verdict, candidate: Verdict): Change {
  return base === candidate ? "same" : (`${SHORT[base]}→${SHORT[candidate]}` as Change);
}

const percentOf = (rows: readonly SideRate[]) => pct(rows.reduce((a, r) => a + r.passes, 0), rows.reduce((a, r) => a + r.attempts, 0));

/** Per task × mode, the change; per side of the split, the pass rate on each side and the delta. */
export function compareSides(base: CompareSide, candidate: CompareSide): Comparison {
  const b = rates(base);
  const c = rates(candidate);
  const rows: TaskChange[] = [];
  for (const [k, row] of b) {
    const other = c.get(k);
    if (other === undefined) continue;
    rows.push({ task: row.task, kind: row.kind, mode: row.mode, split: row.split, base: row.rate, candidate: other.rate, change: changeOf(row.rate.verdict, other.rate.verdict) });
  }
  const bySplit = SPLITS.map((split) => {
    const mine = rows.filter((r) => r.split === split);
    const before = percentOf(mine.map((r) => r.base));
    const after = percentOf(mine.map((r) => r.candidate));
    return { split, tasks: new Set(mine.map((r) => r.task)).size, base: before, candidate: after, delta: Math.round((after - before) * 10) / 10 };
  });
  return { rows, bySplit };
}

export interface Selection {
  readonly verdict: "adopt" | "keep-base";
  readonly reason: string;
  readonly heldout: { readonly tasks: number; readonly base: number; readonly candidate: number };
  /** Held-out task × mode rows that lost a pass the base had. */
  readonly regressions: readonly TaskChange[];
  /** Fewer than {@link MIN_HELDOUT} held-out tasks: the verdict stands, but it is too small to judge on. */
  readonly tooSmall: boolean;
}

/** T6: adopt only if the held-out pass rate rises and no held-out task flips pass→fail; anything else keeps the base. */
export function selectByRule(base: CompareSide, candidate: CompareSide): Selection {
  const { rows, bySplit } = compareSides(base, candidate);
  const held = bySplit.find((s) => s.split === "heldout")!;
  const heldout = { tasks: held.tasks, base: held.base, candidate: held.candidate };
  const regressions = rows.filter((r) => r.split === "heldout" && REGRESSIONS.has(r.change));
  const tooSmall = held.tasks < MIN_HELDOUT;
  const keep = (reason: string): Selection => ({ verdict: "keep-base", reason, heldout, regressions, tooSmall });
  if (held.tasks === 0) return keep("no held-out tasks: there is nothing to judge on");
  if (regressions.length > 0) return keep(`held-out ${regressions.map((r) => `${r.task} [${r.mode}] ${r.change}`).join(", ")}`);
  if (held.candidate === held.base) return keep(`held-out pass rate tied at ${held.base}%`);
  if (held.candidate < held.base) return keep(`held-out pass rate fell ${held.base}% → ${held.candidate}%`);
  return { verdict: "adopt", reason: `held-out pass rate rose ${held.base}% → ${held.candidate}% and no held-out task flipped pass→fail`, heldout, regressions, tooSmall };
}

/** Two records answer the same question only over the same task set, tasks and modes, for the same subject. */
export function comparable(a: EvalRunRecord, b: EvalRunRecord): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (a.evalsSha256 !== b.evalsSha256) {
    return { ok: false, reason: `the two runs answered different task sets (evalsSha256 ${a.evalsSha256.slice(0, 12)} vs ${b.evalsSha256.slice(0, 12)}): a pass rate is only comparable against the same set` };
  }
  if (a.subject !== b.subject) return { ok: false, reason: `the two runs are of different subjects (${a.subject}, ${b.subject})` };
  const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
  if (!same(a.tasks, b.tasks)) return { ok: false, reason: "the two runs asked different tasks from the set (--only or --split differed)" };
  if (!same(a.modes, b.modes)) return { ok: false, reason: "the two runs measured different modes" };
  return { ok: true };
}

/** `cmp-` + UTC time to the second + 4 hex, like a run id. */
export function newCompareId(at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `cmp-${stamp}-${crypto.randomUUID().slice(0, 4)}`;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n === 0 ? "±0" : String(n));
const frac = (r: SideRate) => `${r.passes}/${r.attempts}`;

/** What the side was: the working tree, a ref, or a recorded run. */
function label(run: EvalRunRecord): string {
  if (run.compare === undefined) return "recorded run";
  return run.compare.role === "base" ? "working tree" : `${run.compare.ref} = ${run.compare.commit.slice(0, 8)}`;
}

/** The comparison as printed: the two sides, per split, every change, and the T6 verdict. */
export function compareLines(base: EvalRunRecord, candidate: EvalRunRecord, { bold, dim }: Style): string[] {
  const { rows, bySplit } = compareSides(base, candidate);
  const sel = selectByRule(base, candidate);
  const id = base.compare?.id ?? "compare";
  const out = [bold(`\n${id} — ${base.tasks.length} task(s) × ${MODES.length} modes, base ×${base.repeat}, candidate ×${candidate.repeat}`)];
  out.push(`  base       ${soulShort(base.soul).padEnd(14)}  ${label(base).padEnd(22)}  ${base.runId}`);
  out.push(`  candidate  ${soulShort(candidate.soul).padEnd(14)}  ${label(candidate).padEnd(22)}  ${candidate.runId}`);
  out.push(bold(`\n${"by split".padEnd(24)}base   candidate  delta`));
  for (const s of bySplit) out.push(`  ${s.split.padEnd(8)} ${String(s.tasks).padStart(3)} task(s)  ${s.tasks === 0 ? "—" : `${`${s.base}%`.padEnd(6)} ${`${s.candidate}%`.padEnd(10)} ${signed(s.delta)}`}`);
  const changed = rows.filter((r) => r.change !== "same");
  out.push(bold(`\nchanges (task × mode) — ${changed.length} changed, ${rows.length - changed.length} the same`));
  for (const r of changed) out.push(`  ${r.task.padEnd(24)} ${r.mode.padEnd(9)} ${r.split.padEnd(8)} ${r.change.padEnd(11)} ${frac(r.base)} → ${frac(r.candidate)}${REGRESSIONS.has(r.change) && r.split === "heldout" ? "  ← blocks adoption" : ""}`);
  if (changed.length === 0) out.push(dim("  none"));
  out.push(bold(`\nT6 verdict: ${sel.verdict} — ${sel.reason}`));
  if (sel.heldout.tasks > 0 && sel.tooSmall) out.push(bold(`Held-out is ${sel.heldout.tasks} task(s): too small to judge a tuning decision (at least ${MIN_HELDOUT}).`));
  out.push(dim("Graded by the task set's phrases, not by a model. Nothing was changed: adopting a candidate is S21.5's."));
  return out;
}
