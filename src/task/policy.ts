/**
 * What a task's step may be given, decided before anything is sent (D-154, D-155, D-157).
 *
 * - A task's browser reaches **claude and claude-local only**: they are the vendors Mind can hand *only* its
 *   own MCP server (`--mcp-config` + `--strict-mcp-config`, `src/browser/mcp-config.ts`). grok stays off it
 *   (D-157, D-119); kimi and codex cannot be told "only this server". A chain with anything else in it is
 *   refused for a task with a browser, rather than run a step whose fallback has no browser.
 * - The dial still decides: the step's browser level is `min(operate, reach)` (D-153) and the container's level
 *   (the task's). At 0 there is no browser for this turn, and the step is refused.
 */

import { isFinal, readTask, tasksDir, type TaskEnv, type TaskRecord } from "./store.ts";
import type { SubjectId } from "../types.ts";

export const BROWSER_BACKENDS: readonly string[] = ["claude", "claude-local"];

/** Why a step of a task with a browser may not run on this chain at this operate level, or `undefined`. */
export function browserTaskProblem(backends: readonly string[], operate: number): string | undefined {
  const others = backends.filter((backend) => !BROWSER_BACKENDS.includes(backend));
  if (backends.length === 0 || others.length > 0) {
    return (
      `a task's browser reaches ${BROWSER_BACKENDS.join(" and ")} only (D-155, D-157), and this chain has ` +
      `${others.length > 0 ? others.join(", ") : "nothing"} in it — name \`--backend claude-local\` or \`--backend claude\` for the task`
    );
  }
  if (operate <= 0) {
    return "the dial's browser level for this turn is 0 (min(operate, reach), D-153): `mind autonomy set operate 1` lets it look, 2 lets it act";
  }
  return undefined;
}

/**
 * How long claude may wait on one browser tool call: one approval's wait and two minutes more. A click the
 * container is holding for the owner's answer (D-156) is a tool call that has not returned yet, and claude's
 * own per-call limit must not end it first. Only at operate 2: at 1 nothing is ever held.
 */
export function browserToolTimeoutMs(record: TaskRecord): number | undefined {
  return record.operate >= 2 ? (record.approvalSeconds + 120) * 1000 : undefined;
}

/** The task a turn's `--task` names, if it is one this subject has and it has not ended. */
export async function taskForTurn(
  env: TaskEnv,
  subject: SubjectId,
  id: string,
): Promise<{ readonly ok: true; readonly record: TaskRecord } | { readonly ok: false; readonly reason: string }> {
  const dir = await tasksDir(env, subject);
  if (!dir.ok) return dir;
  const read = await readTask(dir.path, subject, id);
  if (!read.ok) return read;
  if (isFinal(read.record.status)) return { ok: false, reason: `task ${id} is ${read.record.status}; its steps are over` };
  return { ok: true, record: read.record };
}
