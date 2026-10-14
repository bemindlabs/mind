/** A task record and a temporary personal tree for the task tests. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_BLOCK } from "../../src/task/prompt.ts";
import { TASK_SCHEMA, type TaskRecord } from "../../src/task/store.ts";
import { subjectId } from "../../src/types.ts";

export const SUBJECT = subjectId("task-test");

export function aTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schema: TASK_SCHEMA,
    id: "t-0000abcd",
    subject: SUBJECT,
    dir: "/agents/a",
    cwd: "/work",
    goal: "find the answer",
    createdAt: "2026-10-05T10:00:00.000Z",
    via: "cli",
    backend: null,
    model: null,
    operate: 0,
    allow: [],
    budget: { turns: 12, minutes: 30, tokens: null },
    stepSeconds: 600,
    approvalSeconds: 600,
    status: "planning",
    statusAt: "2026-10-05T10:00:00.000Z",
    reason: null,
    plan: null,
    steps: [],
    result: null,
    used: { turns: 0, activeMs: 0, tokens: 0, tokensUnknown: 0 },
    runner: null,
    current: null,
    browser: null,
    notes: [],
    generation: 0,
    ...overrides,
  };
}

/** A temporary HOME whose data root holds the subject's personal tree. */
export async function tempHome(scratch: string[]): Promise<{ home: string; env: Record<string, string>; tasks: string }> {
  const home = await mkdtemp(join(tmpdir(), "mind-task-"));
  scratch.push(home);
  const env = { XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data") };
  return { home, env, tasks: join(home, "data", "mind", SUBJECT, "personal", "tasks") };
}

export async function cleanup(scratch: string[]): Promise<void> {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
}

/** An answer with the task block, in the fence the model is told to use. */
export function said(block: unknown, before = "ok", fence: string = TASK_BLOCK): string {
  return `${before}\n\`\`\`${fence}\n${JSON.stringify(block)}\n\`\`\``;
}
