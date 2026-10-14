/**
 * `mind turn` against a real local model — opt-in, and the only layer here
 * that says anything about assumption A5.
 *
 * Run with:
 *
 *     MIND_REAL_RUN=1 MIND_REAL_MODEL=<ollama model> bun test test/cli/turn.real.test.ts
 *
 * Skipped otherwise. The hermetic AC6 test next door proves the *route* — the
 * vendors are gone, ollama answers, the soul lands in the system field — and
 * it proves it against a stub that was written to answer correctly. It
 * therefore says nothing at all about A5, *"a local model alone is good enough
 * to stand in for claude/codex"*, which is the riskiest unproven assumption in
 * the backlog and the one the whole positioning rests on (D-019).
 *
 * So this file is a **measurement, not a gate**. It runs three small tasks
 * with freshly randomised inputs — so no answer can be a memorised fixture —
 * grades each one by machine, prints the score and every raw answer, and fails
 * only when the model gets **none** of them. A 2-of-3 threshold was considered
 * and rejected: the backlog says "good enough" without defining it, a number
 * invented here would be mistaken for one that came from somewhere, and the
 * score itself is the finding. The raw answers are printed so a reader can
 * disagree with the grader.
 *
 * What is asserted hard, on every task, because these are properties and not
 * measurements: the answer came from ollama, both vendor CLIs were tried and
 * missing from PATH, something came back, and the daemon was on loopback.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENABLED = process.env["MIND_REAL_RUN"] === "1";
const MODEL = process.env["MIND_REAL_MODEL"] ?? "";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const BUN = Bun.which("bun") ?? "bun";

/** Whatever this machine's ollama is; never a name or a host written here (D-021). */
const OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

function isLoopback(host: string): boolean {
  if (host === "") return true; // OllamaExec's own default is 127.0.0.1.
  try {
    const url = new URL(host.includes("://") ? host : `http://${host}`);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** A temporary HOME and a PATH holding one symlink to `bun` and nothing else. */
async function bareMachine(): Promise<{ home: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), "mind-turn-real-"));
  scratch.push(home);
  const bin = join(home, "bare-bin");
  await mkdir(bin, { recursive: true });
  await symlink(BUN, join(bin, "bun"));
  return { home, path: bin };
}

async function turn(machine: { home: string; path: string }, prompt: string) {
  const startedAt = performance.now();
  const child = Bun.spawn(
    [BUN, "run", BIN, "turn", SOUL, "--subject", "example", "--prompt", prompt, "--model", MODEL],
    {
      cwd: ROOT,
      env: {
        HOME: machine.home,
        PATH: machine.path,
        ...(OLLAMA_HOST === "" ? {} : { OLLAMA_HOST }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return {
    code: child.exitCode ?? -1,
    stdout,
    stderr,
    seconds: (performance.now() - startedAt) / 1000,
  };
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** Six hex characters, so no id is a substring of another. */
function id(): string {
  return `r-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
}

const WORDS = [
  "anchor", "basket", "cinder", "dulcet", "ember", "fathom", "girder", "harbour",
  "ingot", "jetty", "kernel", "lantern", "mantle", "nutmeg", "otter", "parcel",
];

interface Task {
  readonly name: string;
  readonly prompt: string;
  /** True when the answer is right. Crude on purpose; the raw text is printed. */
  grade(answer: string): boolean;
  readonly expected: string;
}

/** Find the one record that failed, in JSON that changes every run. */
function extractTask(): Task {
  const ids = Array.from({ length: 5 }, id);
  const unique = [...new Set(ids)];
  const failed = pick(unique);
  const records = shuffle(
    unique.map((value) => ({ id: value, status: value === failed ? "failed" : "ok" })),
  );
  return {
    name: "extract",
    expected: failed,
    prompt:
      `Here is a JSON array of records:\n${JSON.stringify(records)}\n\n` +
      `Reply with the id of the one record whose status is "failed". ` +
      `Reply with that id only, no explanation.`,
    grade(answer) {
      // Naming exactly one id, and the right one. An answer that echoes the
      // whole array on the way to the truth is not counted as correct — it is
      // not usable by a caller either.
      const named = unique.filter((value) => answer.includes(value));
      return named.length === 1 && named[0] === failed;
    },
  };
}

/** Sort and de-duplicate — an ordering the input never shows. */
function transformTask(): Task {
  const chosen = shuffle(WORDS).slice(0, 5);
  const given = shuffle([...chosen, pick(chosen)]);
  const expected = [...new Set(chosen)].sort().join(", ");
  const tidy = (text: string) => text.toLowerCase().replace(/\s*,\s*/g, ",").replace(/\s+/g, " ");
  return {
    name: "transform",
    expected,
    prompt:
      `Sort these words alphabetically and remove duplicates:\n${given.join(", ")}\n\n` +
      `Reply with one comma-separated line and nothing else.`,
    grade: (answer) => tidy(answer).includes(tidy(expected)),
  };
}

/** Count the lines that match a rule. The input contains no digits. */
function constrainedTask(): Task {
  const target = pick(WORDS);
  const others = WORDS.filter((word) => word !== target);
  const hits = 2 + Math.floor(Math.random() * 4);
  const misses = 3 + Math.floor(Math.random() * 3);
  const lines = shuffle([
    ...Array.from({ length: hits }, () => `${pick(others)} ${target} ${pick(others)}`),
    ...Array.from({ length: misses }, () => `${pick(others)} ${pick(others)} ${pick(others)}`),
  ]);
  return {
    name: "constrained",
    expected: String(hits),
    prompt:
      `Count how many of the lines below contain the word "${target}".\n\n${lines.join("\n")}\n\n` +
      `Reply with the number only.`,
    grade(answer) {
      const numbers = answer.match(/\d+/g);
      return numbers !== null && numbers[numbers.length - 1] === String(hits);
    },
  };
}

describe.skipIf(!ENABLED || MODEL === "")("a turn on a real local model, with no vendor CLI", () => {
  test(
    "A5 — three tasks on ollama alone, scored and shown",
    async () => {
      // A remote "local" model would make everything below a claim about
      // someone else's machine. Fail rather than quietly measure that.
      expect(isLoopback(OLLAMA_HOST)).toBe(true);

      const machine = await bareMachine();
      expect(Bun.which("claude", { PATH: machine.path })).toBeNull();
      expect(Bun.which("codex", { PATH: machine.path })).toBeNull();

      const tasks = [extractTask(), transformTask(), constrainedTask()];
      const rows: { task: Task; answer: string; ok: boolean; seconds: number }[] = [];

      for (const task of tasks) {
        const result = await turn(machine, task.prompt);

        // Properties, not measurements — these hold whatever the model says.
        expect(result.stderr).toContain("answered by ollama");
        expect(result.stderr).toContain("claude: unavailable (claude: not on PATH)");
        expect(result.stderr).toContain("codex: unavailable (codex: not on PATH)");
        expect(result.code).toBe(0);
        expect(result.stdout.trim().length).toBeGreaterThan(0);

        rows.push({
          task,
          answer: result.stdout.trim(),
          ok: task.grade(result.stdout),
          seconds: result.seconds,
        });
      }

      const score = rows.filter((row) => row.ok).length;
      console.log(`\nA5 — ollama alone, model ${MODEL}: ${score}/${rows.length} correct\n`);
      console.log("task         correct  seconds  expected");
      for (const row of rows) {
        console.log(
          `${row.task.name.padEnd(12)} ${(row.ok ? "yes" : "no").padEnd(8)} ` +
            `${row.seconds.toFixed(1).padStart(7)}  ${row.task.expected}`,
        );
      }
      for (const row of rows) {
        console.log(`\n--- ${row.task.name} · raw answer ---\n${row.answer}`);
      }
      console.log(
        `\nThe grader above is crude and the raw answers are printed so it can be ` +
          `overruled. This is a measurement of A5, not a threshold.`,
      );

      // Red only at zero: a local model that gets nothing right is not a
      // measurement, it is the local route being unusable (I-1).
      expect(score).toBeGreaterThan(0);
    },
    900_000,
  );
});
