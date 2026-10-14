/**
 * A task as a person, the web page and the app are shown it — one shape for `task show --json`, `task list
 * --json`, `/api/tasks` and the tasks in `/api/state`, so every channel says the same thing (D-086, D-154).
 */

import { resumable, shownStatus, type ShownStatus, type TaskRecord, type TaskStep } from "./store.ts";

export interface TaskSummary {
  readonly id: string;
  readonly goal: string;
  readonly status: ShownStatus;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly statusAt: string;
  readonly backend: string | null;
  readonly operate: 0 | 1 | 2;
  readonly allow: readonly string[];
  readonly budget: TaskRecord["budget"];
  readonly used: TaskRecord["used"];
  readonly plan: readonly string[] | null;
  readonly steps: readonly TaskStep[];
  readonly result: string | null;
  /** Whether the page may offer "Resume": the task was interrupted, or parked (S18.2). */
  readonly resumable: boolean;
  /** Whether "Stop" means anything: the task has not ended. */
  readonly stoppable: boolean;
  readonly browser: { readonly port: number } | null;
}

export function summarise(record: TaskRecord, stat?: (pid: number) => { readonly startTicks: number } | null): TaskSummary {
  const status = shownStatus(record, stat);
  return {
    id: record.id,
    goal: record.goal,
    status,
    reason: record.reason,
    createdAt: record.createdAt,
    statusAt: record.statusAt,
    backend: record.backend,
    operate: record.operate,
    allow: record.allow,
    budget: record.budget,
    used: record.used,
    plan: record.plan,
    steps: record.steps,
    result: record.result,
    resumable: resumable(status),
    stoppable: status !== "done" && status !== "failed" && status !== "stopped" && status !== "budget",
    browser: record.browser === null ? null : { port: record.browser.port },
  };
}

/** One line for `task list`. */
export function listLine(summary: TaskSummary): string {
  const goal = summary.goal.replace(/\s+/g, " ");
  return `${summary.id}  ${summary.status.padEnd(15)}  ${summary.used.turns}/${summary.budget.turns} turns  ${goal.length > 70 ? `${goal.slice(0, 69)}…` : goal}`;
}

/** The lines of `task show`, without colour. */
export function showLines(summary: TaskSummary): string[] {
  const used = summary.used;
  const minutes = (used.activeMs / 60_000).toFixed(1);
  const lines = [
    `task ${summary.id} — ${summary.status}${summary.reason === null ? "" : ` (${summary.reason})`}`,
    `  goal: ${summary.goal}`,
    `  created ${summary.createdAt} · backend ${summary.backend ?? "the usual chain"} · browser ${summary.operate === 0 ? "none" : `operate ${summary.operate} on ${summary.allow.join(", ")}`}`,
    `  used: ${used.turns}/${summary.budget.turns} turns · ${minutes}/${summary.budget.minutes} min · ${used.tokens}${summary.budget.tokens === null ? "" : `/${summary.budget.tokens}`} tokens${used.tokensUnknown > 0 ? ` (at least: ${used.tokensUnknown} step(s) reported none)` : ""}`,
  ];
  if (summary.plan !== null) {
    lines.push("  plan:");
    if (summary.plan.length === 0) lines.push("    (none could be read)");
    summary.plan.forEach((item, index) => lines.push(`    ${index + 1}. ${item}`));
  }
  if (summary.steps.length > 0) lines.push("  steps:");
  for (const step of summary.steps) {
    const what = step.kind === "plan" ? "plan" : `step ${step.n}`;
    const state = step.finishedAt === null ? "running" : step.outcome ?? "?";
    lines.push(`    ${what} — ${state}${step.turnId === null ? "" : ` · turn ${step.turnId}`}${step.waitedMs > 0 ? ` · waited ${Math.round(step.waitedMs / 1000)}s for you` : ""}`);
    if (step.summary !== "") lines.push(`      ${step.summary}`);
  }
  if (summary.result !== null) lines.push(`  result: ${summary.result}`);
  if (summary.status === "interrupted") lines.push("  it was interrupted: `mind task resume` carries on from the step it was on");
  if (summary.status === "parked") lines.push("  it was parked: `mind task resume` carries it on, `mind task stop` ends it");
  if (summary.status === "waiting-backend") lines.push("  its runner is waiting for the backend; it carries on by itself when the backend is back");
  return lines;
}
