/**
 * S22.12 AC3 (D-201) — does a backend get a repository's gate green? One fixed set of small coding tasks, run per
 * backend, counted with n.
 *
 * A task is a directory: `task.toml` and the repository the bot starts in (`repo/`). The set says the gate (an argv,
 * never a shell line) and which files are the specification (`protect`). One attempt is:
 *
 * 1. the gate runs on the untouched copy and **must be red** — a task that starts green measures nothing and is
 *    `invalid`, left out of every rate and listed apart;
 * 2. the bot gets the task and works in the copy;
 * 3. the gate runs again, and which files changed is read from a before/after fingerprint of the tree, not from the
 *    bot's own account of what it did.
 *
 * Green needs the gate green **and** every protected file untouched: a bot that makes the gate pass by editing the
 * test has not done the task, and it is counted as `edited-protected`, a miss of its own, so the number is not
 * flattered by the one cheat the setup invites.
 *
 * Pure of processes. Copying the fixture, running the gate and the turn are handed in ({@link CodeDeps}); the caller
 * is `bin/commands/eval.ts`. Nothing here reads the ledger (D-022), and nothing here says one backend is better: a
 * rate over a handful of tasks is a direction, and the table carries its n beside every number.
 */

export const CODE_EVAL_SCHEMA = "mind/code-eval@1";
export const TASK_FILE = "task.toml";
export const REPO_DIR = "repo";

const TASK_ID = /^[a-z][a-z0-9-]{0,39}$/;
const TASK_KEYS = new Set(["schema", "ask", "gate", "protect", "gate_timeout_s"]);
export const DEFAULT_GATE_TIMEOUT_S = 120;
export const MAX_GATE_TIMEOUT_S = 900;

export interface CodeTask {
  readonly id: string;
  readonly ask: string;
  /** The gate as an argv, run in the copy. */
  readonly gate: readonly string[];
  /** Globs (relative to the repository) of the files that say what "right" is. */
  readonly protect: readonly string[];
  readonly gateTimeoutS: number;
}

export type ParsedTask = { readonly ok: true; readonly task: CodeTask } | { readonly ok: false; readonly problems: readonly string[] };

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "") ? (value as string[]) : undefined;
}

/** Read one `task.toml`. Every problem is reported together, so one edit fixes one pass. */
export function parseCodeTask(id: string, text: string): ParsedTask {
  const problems: string[] = [];
  if (!TASK_ID.test(id)) problems.push(`the directory name ${JSON.stringify(id)} is not a task id (lowercase letters, digits, dash; starts with a letter)`);
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (error) {
    return { ok: false, problems: [`${id}/${TASK_FILE} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const table = doc as Record<string, unknown>;
  for (const key of Object.keys(table)) if (!TASK_KEYS.has(key)) problems.push(`${id}: unknown key "${key}"`);
  if (table["schema"] !== CODE_EVAL_SCHEMA) problems.push(`${id}: schema must be "${CODE_EVAL_SCHEMA}"`);
  const ask = table["ask"];
  if (typeof ask !== "string" || ask.trim() === "") problems.push(`${id}: ask is the task, in words, and is required`);
  const gate = strings(table["gate"]);
  if (gate === undefined || gate.length === 0) problems.push(`${id}: gate is an argv array such as ["bun", "test"], never a shell line`);
  const protect = table["protect"] === undefined ? [] : strings(table["protect"]);
  if (protect === undefined) problems.push(`${id}: protect is an array of globs`);
  else if (protect.length === 0) problems.push(`${id}: protect must name the files that say what "right" is, or a bot can pass by editing the test`);
  for (const glob of protect ?? []) if (glob.startsWith("/") || glob.split("/").includes("..")) problems.push(`${id}: protect "${glob}" must stay inside the repository`);
  const timeout = table["gate_timeout_s"] ?? DEFAULT_GATE_TIMEOUT_S;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_GATE_TIMEOUT_S) {
    problems.push(`${id}: gate_timeout_s is a whole number of seconds from 1 to ${MAX_GATE_TIMEOUT_S}`);
  }
  if (problems.length > 0 || gate === undefined || protect === undefined || typeof ask !== "string") return { ok: false, problems };
  return { ok: true, task: { id, ask: ask.trim(), gate, protect, gateTimeoutS: timeout as number } };
}

/** What the bot is told. The gate and the protected files are said out loud: nothing about the check is a surprise. */
export function codePrompt(task: CodeTask): string {
  return [
    task.ask,
    "",
    `The check is: ${task.gate.join(" ")} — it fails now and must pass when you are done.`,
    `Do not change these files, they say what is right: ${task.protect.join(", ")}.`,
    "Change only what the task needs. Say at the end what you changed.",
  ].join("\n");
}

export type Outcome = "green" | "still-red" | "edited-protected" | "no-answer" | "invalid";

export interface GateResult {
  readonly pass: boolean;
  /** The gate could not be run at all (not found, killed on timeout): not a red, not a green. */
  readonly unrunnable: boolean;
}

export interface TurnResult {
  readonly code: number;
  readonly text: string;
  readonly backend: string | null;
  readonly model: string | null;
  readonly error: string;
}

export interface CodeDeps {
  /** A fresh copy of the task's repository; `cleanup` removes it. */
  materialise(task: CodeTask): Promise<{ readonly dir: string; cleanup(): Promise<void> }>;
  gate(dir: string, argv: readonly string[], timeoutMs: number): Promise<GateResult>;
  turn(dir: string, prompt: string, backend: string): Promise<TurnResult>;
  /** Fingerprint of every file in the tree, path → hash. */
  snapshot(dir: string): Promise<ReadonlyMap<string, string>>;
}

export interface CodeRow {
  readonly task: string;
  readonly backend: string;
  readonly model: string | null;
  readonly outcome: Outcome;
  readonly changed: readonly string[];
  readonly detail: string;
}

/** The paths whose bytes differ, appear or vanish between two fingerprints, sorted. */
export function changedPaths(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly string[] {
  const out = new Set<string>();
  for (const [path, hash] of before) if (after.get(path) !== hash) out.add(path);
  for (const path of after.keys()) if (!before.has(path)) out.add(path);
  return [...out].sort();
}

/** `**` crosses directories, `*` and `?` do not; everything else is literal. Enough for "test/**" and "src/*.test.js". */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") i++;
      out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function touchesProtected(changed: readonly string[], protect: readonly string[]): readonly string[] {
  const globs = protect.map(globToRegExp);
  return changed.filter((path) => globs.some((glob) => glob.test(path)));
}

/** One attempt: one task, one backend. Always cleans its copy up. */
export async function attempt(task: CodeTask, backend: string, deps: CodeDeps): Promise<CodeRow> {
  const copy = await deps.materialise(task);
  const row = (outcome: Outcome, rest: Partial<CodeRow> = {}): CodeRow => ({ task: task.id, backend, model: null, changed: [], detail: "", outcome, ...rest });
  try {
    const timeoutMs = task.gateTimeoutS * 1000;
    const before = await deps.gate(copy.dir, task.gate, timeoutMs);
    if (before.unrunnable) return row("invalid", { detail: "the gate could not be run on the untouched copy" });
    if (before.pass) return row("invalid", { detail: "the gate already passes before the bot does anything" });

    const fingerprint = await deps.snapshot(copy.dir);
    const turn = await deps.turn(copy.dir, codePrompt(task), backend);
    const named = { model: turn.model };
    if (turn.code !== 0 || turn.text === "") return row("no-answer", { ...named, detail: turn.error });

    const changed = changedPaths(fingerprint, await deps.snapshot(copy.dir));
    const touched = touchesProtected(changed, task.protect);
    if (touched.length > 0) return row("edited-protected", { ...named, changed, detail: `changed ${touched.join(", ")}` });
    const after = await deps.gate(copy.dir, task.gate, timeoutMs);
    if (after.unrunnable) return row("still-red", { ...named, changed, detail: "the gate could not be run afterwards" });
    return row(after.pass ? "green" : "still-red", { ...named, changed });
  } finally {
    await copy.cleanup();
  }
}

/** Every task on every backend, one after another: backends share quota and machine, and a measurement should not race itself. */
export async function runCodeEval(tasks: readonly CodeTask[], backends: readonly string[], deps: CodeDeps, progress: (row: CodeRow) => void = () => undefined): Promise<readonly CodeRow[]> {
  const rows: CodeRow[] = [];
  for (const backend of backends) {
    for (const task of tasks) {
      const row = await attempt(task, backend, deps);
      rows.push(row);
      progress(row);
    }
  }
  return rows;
}

export interface BackendLine {
  readonly backend: string;
  readonly models: readonly string[];
  /** Attempts that count: everything but `invalid`. */
  readonly n: number;
  readonly green: number;
  readonly stillRed: number;
  readonly editedProtected: number;
  readonly noAnswer: number;
  readonly invalid: number;
}

/** One line per backend, `n` always present. An `invalid` task is counted apart and never in n. */
export function codeTable(rows: readonly CodeRow[]): readonly BackendLine[] {
  const order: string[] = [];
  for (const row of rows) if (!order.includes(row.backend)) order.push(row.backend);
  return order.map((backend) => {
    const mine = rows.filter((row) => row.backend === backend);
    const count = (outcome: Outcome): number => mine.filter((row) => row.outcome === outcome).length;
    return {
      backend,
      models: [...new Set(mine.map((row) => row.model).filter((model): model is string => model !== null))].sort(),
      n: mine.length - count("invalid"),
      green: count("green"),
      stillRed: count("still-red"),
      editedProtected: count("edited-protected"),
      noAnswer: count("no-answer"),
      invalid: count("invalid"),
    };
  });
}

/** Printed lines. The caveat is part of the output: a small n is a direction, not a ranking. */
export function codeLines(lines: readonly BackendLine[]): readonly string[] {
  const out = lines.map((line) => {
    const rate = line.n === 0 ? "—" : `${Math.round((line.green / line.n) * 1000) / 10}%`;
    const misses = [
      line.stillRed > 0 ? `${line.stillRed} still red` : "",
      line.editedProtected > 0 ? `${line.editedProtected} edited the spec` : "",
      line.noAnswer > 0 ? `${line.noAnswer} no answer` : "",
    ].filter((part) => part !== "");
    const invalid = line.invalid > 0 ? ` · ${line.invalid} invalid task(s), not counted` : "";
    const model = line.models.length === 0 ? "" : ` (${line.models.join(", ")})`;
    return `${line.backend}${model}: ${line.green}/${line.n} green (${rate})${misses.length > 0 ? ` — ${misses.join(", ")}` : ""}${invalid}`;
  });
  return [...out, "n is the number of tasks that counted. A few tasks is a direction, not a ranking; the same task is not equally hard for every backend's habits."];
}
