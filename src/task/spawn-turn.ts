/**
 * One step's turn: `mind turn <dir> --subject <id> --prompt-file <file> --json --task <task>`, as a child of
 * the runner, through the spawn chokepoint (`src/spawn.ts`).
 *
 * The prompt goes in a file, not argv: argv is readable by every local user in `/proc`, and a step's prompt holds
 * the goal and every summary so far. The file is in the task's own directory (personal, 700), mode 600, and is
 * removed when the turn ends.
 *
 * `--task` is what tells the turn it is a step: it takes its timeout from the task, and — for a task with a
 * browser — the browser's MCP config (`bin/commands/turn.ts`). Everything else is the turn as a person runs it.
 */

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { procStat } from "../decide/runs.ts";
import { spawnGuarded } from "../spawn.ts";
import { STATE_FILE_MODE } from "../state.ts";
import type { StepTurn } from "./runner.ts";
import type { ProcessId, TaskRecord } from "./store.ts";

/** The argv of a step's turn after the engine's own (`engineCommand().argv`). */
export function stepTurnArgs(record: TaskRecord, promptFile: string): string[] {
  return [
    "turn",
    record.dir,
    "--subject",
    record.subject,
    "--prompt-file",
    promptFile,
    "--json",
    "--task",
    record.id,
    ...(record.backend === null ? [] : ["--backend", record.backend]),
    ...(record.model === null ? [] : ["--model", record.model]),
  ];
}

const NOISE = ["leaving this machine:", "what this turn changed in", "not seen by this report:", "commands that ran and left no file", "a file changed and changed back", "anything under .git/"];

/** The last few lines of a turn's stderr, without colour: why it did not answer. */
export function tail(stderr: string, lines = 3): string {
  // eslint-disable-next-line no-control-regex
  const plain = stderr.replace(/\u001b\[[0-9;]*m/g, "");
  return plain
    .split("\n")
    .map((line) => line.trim())
    // The lines every turn prints whatever happened (the egress notice, D-043's report) say nothing about why.
    .filter((line) => line !== "" && !NOISE.some((noise) => line.includes(noise)))
    .slice(-lines)
    .join(" · ")
    .slice(0, 600);
}

/** What `turn --json` printed, read for a step. A stdout that is not JSON is a turn with no answer. */
export function readTurnJson(stdout: string): { readonly text: string; readonly turnId: string | null; readonly backend: string | null; readonly tokens: number | null; readonly why?: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { text: "", turnId: null, backend: null, tokens: null };
  }
  const usage = (parsed["evidence"] as { usage?: { input?: unknown; output?: unknown } } | undefined)?.usage;
  const input = typeof usage?.input === "number" ? usage.input : null;
  const output = typeof usage?.output === "number" ? usage.output : null;
  const raw = (parsed["evidence"] as { raw?: unknown } | undefined)?.raw;
  const route = typeof parsed["route"] === "string" ? parsed["route"] : "";
  return {
    // With no answer, what the backend itself said is the reason (a timeout, a refusal, "no backend answered").
    ...(parsed["text"] === "" || parsed["text"] === undefined ? { why: [route, typeof raw === "string" ? raw.slice(-300) : ""].filter((part) => part !== "").join(" — ") } : {}),
    text: typeof parsed["text"] === "string" ? parsed["text"] : "",
    turnId: typeof parsed["turn"] === "string" ? parsed["turn"] : null,
    backend: typeof parsed["backend"] === "string" ? parsed["backend"] : null,
    tokens: input === null && output === null ? null : (input ?? 0) + (output ?? 0),
  };
}

/**
 * Run one step's turn with `engine` (the argv that starts this engine). `started` is told the turn's process
 * before anything is awaited on it, so `task stop` and `mind stop` can find it.
 */
export async function spawnStepTurn(
  engine: readonly string[],
  taskDir: string,
  record: TaskRecord,
  prompt: string,
  n: number,
  started: (process_: ProcessId) => Promise<void>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<StepTurn> {
  const file = join(taskDir, `prompt-${n}.txt`);
  await writeFile(file, prompt, { mode: STATE_FILE_MODE });
  const began = performance.now();
  try {
    const child = spawnGuarded([...engine, ...stepTurnArgs(record, file)], { cwd: record.cwd, env });
    await started({ pid: child.pid, start: procStat(child.pid)?.startTicks ?? null });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    const { why, ...read } = readTurnJson(stdout);
    return { code: child.exitCode ?? -1, ...read, ms: Math.round(performance.now() - began), error: why === undefined || why === "" ? tail(stderr) : why };
  } finally {
    await rm(file, { force: true });
  }
}
