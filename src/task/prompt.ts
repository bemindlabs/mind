/**
 * What a task's turns are asked, and how their answers are read (D-154): plan, step, observe, decide next.
 *
 * Every step is an ordinary turn: these are only its prompt. The soul, recall, the dial, the fence, egress and
 * the ledger are the turn's business, exactly as for a message typed into the chat.
 *
 * The model reports at the end of each answer in one fenced block ({@link TASK_BLOCK}), holding JSON — the same shape
 * of contract as D-045's proposal block. A block that cannot be read is said to be unreadable, never guessed
 * at: the step's summary is then the start of the answer, and three in a row end the task (the model is not
 * following the format, and another turn is unlikely to help).
 */

import type { TaskRecord } from "./store.ts";

/** The fence the model is told to end an answer with. */
export const TASK_BLOCK = "mind-task";
/** How much of a step's summary, a plan item or a result is kept. */
export const SUMMARY_MAX = 600;
export const RESULT_MAX = 4000;
export const PLAN_MAX_ITEMS = 12;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The goal, as every prompt quotes it. */
function goalBlock(record: TaskRecord): string {
  return `The goal, from the person you work for:\n<<<\n${record.goal}\n>>>`;
}

function browserLine(record: TaskRecord): string {
  if (record.operate === 0) return "You have no web browser for this task.";
  const sites = record.allow.length === 0 ? "no site" : record.allow.join(", ");
  return record.operate === 1
    ? `You have a web browser (the mind-browser tools) that can open and read pages on: ${sites}. It cannot click or type.`
    : `You have a web browser (the mind-browser tools) that can open, read, click and type on: ${sites}. ` +
        "Paying, sending, deleting, passwords and accepting terms pause until the person says yes; if a step is " +
        "refused, do not try to get around it.";
}

/** The first turn: a plan, and nothing done. */
export function planPrompt(record: TaskRecord): string {
  return [
    "You are starting a task that you will carry out over several turns, one step per turn.",
    goalBlock(record),
    browserLine(record),
    "In this turn, only make the plan: 2 to 8 short steps that reach the goal. Do not carry any of them out yet.",
    `End your answer with exactly one block like this, and nothing after it:\n\`\`\`${TASK_BLOCK}\n{"plan": ["first step", "second step"]}\n\`\`\``,
  ].join("\n\n");
}

/** Every later turn: the plan, what was done, and the next step. */
export function stepPrompt(record: TaskRecord): string {
  const plan = (record.plan ?? []).map((item, index) => `${index + 1}. ${item}`).join("\n");
  const done = record.steps
    .filter((step) => step.kind === "step" && step.finishedAt !== null)
    .map((step) => `- step ${step.n}${step.outcome === "ok" ? "" : ` (${step.outcome})`}: ${step.summary}`)
    .join("\n");
  const notes = record.notes.map((note) => `- ${note}`).join("\n");
  return [
    "You are carrying out a task one step per turn.",
    goalBlock(record),
    browserLine(record),
    `The plan:\n${plan === "" ? "(none was made — work towards the goal directly)" : plan}`,
    `Done so far:\n${done === "" ? "(nothing yet)" : done}`,
    ...(notes === "" ? [] : [`Since the last step:\n${notes}`]),
    "Now do the next step — only one — using your tools. Check what you did worked.",
    `End your answer with exactly one block like this, and nothing after it:\n\`\`\`${TASK_BLOCK}\n{"done": false, "summary": "what you did in this step and what you saw"}\n\`\`\`\n` +
      `When the whole goal is reached, set "done": true and put the answer for the person in "result".`,
  ].join("\n\n");
}

/** The JSON of the last task block (or, failing that, the last ```json block), or `undefined`. */
export function lastBlock(text: string): unknown {
  const fences = [...text.matchAll(/```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g)];
  const ours = fences.filter((match) => match[1] === TASK_BLOCK);
  const candidates = ours.length > 0 ? ours : fences.filter((match) => match[1] === "json" || match[1] === "");
  for (const match of candidates.reverse()) {
    try {
      return JSON.parse(match[2]!.trim());
    } catch {
      // A later block may still read; an unreadable one is not guessed at.
    }
  }
  return undefined;
}

export type PlanRead = { readonly ok: true; readonly plan: readonly string[] } | { readonly ok: false };

export function readPlan(text: string): PlanRead {
  const block = lastBlock(text) as { plan?: unknown } | undefined;
  if (typeof block !== "object" || block === null || !Array.isArray(block.plan)) return { ok: false };
  const plan = block.plan
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .slice(0, PLAN_MAX_ITEMS)
    .map((item) => clip(item, SUMMARY_MAX));
  return plan.length === 0 ? { ok: false } : { ok: true, plan };
}

export type StepRead =
  | { readonly ok: true; readonly done: boolean; readonly summary: string; readonly result: string | null }
  | { readonly ok: false; readonly summary: string };

export function readStep(text: string): StepRead {
  const block = lastBlock(text) as { done?: unknown; summary?: unknown; result?: unknown } | undefined;
  const fallback = clip(text.replace(/```[\s\S]*?```/g, " "), 300) || "(no answer text)";
  if (typeof block !== "object" || block === null || typeof block.done !== "boolean") return { ok: false, summary: fallback };
  const summary = typeof block.summary === "string" && block.summary.trim() !== "" ? clip(block.summary, SUMMARY_MAX) : fallback;
  const result = typeof block.result === "string" && block.result.trim() !== "" ? block.result.trim().slice(0, RESULT_MAX) : null;
  return { ok: true, done: block.done, summary, result };
}
