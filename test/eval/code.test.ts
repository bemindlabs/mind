/**
 * S22.12 AC3 — the coding eval's accounting, with the processes stubbed. What a real backend does is not tested
 * here; what is tested is that the number cannot be flattered: a gate that starts green is not counted, and a bot
 * that turns the gate green by editing the spec is not green.
 */

import { describe, expect, test } from "bun:test";
import {
  attempt,
  changedPaths,
  codeLines,
  codePrompt,
  codeTable,
  globToRegExp,
  parseCodeTask,
  runCodeEval,
  type CodeDeps,
  type CodeTask,
  type GateResult,
  type TurnResult,
} from "../../src/eval/code.ts";

const TOML = (extra = "") => `schema = "mind/code-eval@1"\nask = "Fix sum()."\ngate = ["bun", "test"]\nprotect = ["test/**"]\n${extra}`;
const TASK: CodeTask = { id: "fix-sum", ask: "Fix sum().", gate: ["bun", "test"], protect: ["test/**"], gateTimeoutS: 60 };

function stub(options: { gates: GateResult[]; edits?: Record<string, string>; turn?: Partial<TurnResult> }): CodeDeps & { cleaned: number } {
  let files = new Map<string, string>([["src/sum.js", "a"], ["test/sum.test.js", "t"]]);
  const gates = [...options.gates];
  const state = { cleaned: 0 };
  return {
    get cleaned() {
      return state.cleaned;
    },
    async materialise() {
      return { dir: "/nowhere", cleanup: async () => void state.cleaned++ };
    },
    async gate() {
      return gates.shift() ?? { pass: false, unrunnable: true };
    },
    async turn() {
      for (const [path, hash] of Object.entries(options.edits ?? {})) files = new Map(files).set(path, hash);
      return { code: 0, text: "done", backend: "claude", model: "m1", error: "", ...options.turn };
    },
    async snapshot() {
      return files;
    },
  };
}

const RED: GateResult = { pass: false, unrunnable: false };
const GREEN: GateResult = { pass: true, unrunnable: false };

describe("code task file", () => {
  test("a good file parses, with defaults", () => {
    const parsed = parseCodeTask("fix-sum", TOML());
    expect(parsed.ok && parsed.task).toMatchObject({ id: "fix-sum", gate: ["bun", "test"], protect: ["test/**"], gateTimeoutS: 120 });
  });

  test("every problem is reported at once: a shell line, no protect, an escape, an unknown key", () => {
    const parsed = parseCodeTask("Bad Id", `schema = "mind/code-eval@1"\nask = ""\ngate = "bun test"\nprotect = ["../x"]\nextra = 1\n`);
    expect(parsed.ok).toBe(false);
    const text = !parsed.ok ? parsed.problems.join("\n") : "";
    for (const part of ["not a task id", "ask is the task", "argv array", "inside the repository", 'unknown key "extra"']) expect(text).toContain(part);
    const none = parseCodeTask("fix-sum", TOML().replace('protect = ["test/**"]\n', ""));
    expect(!none.ok && none.problems.join()).toContain("protect must name");
  });

  test("the prompt says the check and the protected files out loud", () => {
    const prompt = codePrompt(TASK);
    expect(prompt).toContain("bun test");
    expect(prompt).toContain("test/**");
  });
});

describe("one attempt", () => {
  test("gate red, bot edits the source, gate green: green", async () => {
    const deps = stub({ gates: [RED, GREEN], edits: { "src/sum.js": "b" } });
    const row = await attempt(TASK, "claude", deps);
    expect(row).toMatchObject({ outcome: "green", model: "m1", changed: ["src/sum.js"] });
    expect(deps.cleaned).toBe(1);
  });

  test("green by editing the spec is not green", async () => {
    const row = await attempt(TASK, "claude", stub({ gates: [RED, GREEN], edits: { "test/sum.test.js": "x" } }));
    expect(row.outcome).toBe("edited-protected");
    expect(row.detail).toContain("test/sum.test.js");
  });

  test("a gate that starts green measures nothing: invalid, and the bot is never asked", async () => {
    let asked = false;
    const deps = { ...stub({ gates: [GREEN] }), turn: async () => ((asked = true), { code: 0, text: "x", backend: null, model: null, error: "" }) };
    expect((await attempt(TASK, "claude", deps)).outcome).toBe("invalid");
    expect(asked).toBe(false);
  });

  test("a gate that cannot run on the untouched copy is invalid, not red", async () => {
    expect((await attempt(TASK, "claude", stub({ gates: [{ pass: false, unrunnable: true }] }))).outcome).toBe("invalid");
  });

  test("no answer, and still red", async () => {
    expect((await attempt(TASK, "claude", stub({ gates: [RED], turn: { code: 1, text: "", error: "quota" } }))).outcome).toBe("no-answer");
    expect((await attempt(TASK, "claude", stub({ gates: [RED, RED], edits: { "src/sum.js": "c" } }))).outcome).toBe("still-red");
  });

  test("the copy is removed even when the turn throws", async () => {
    const base = stub({ gates: [RED] });
    const deps = { ...base, turn: async (): Promise<TurnResult> => Promise.reject(new Error("boom")) };
    await expect(attempt(TASK, "claude", deps)).rejects.toThrow("boom");
    expect(base.cleaned).toBe(1);
  });

  test("globs: ** crosses directories, * does not, dots are literal", () => {
    const hits = (glob: string, path: string): boolean => globToRegExp(glob).test(path);
    expect(hits("test/**", "test/a/b.js")).toBe(true);
    expect(hits("test/**", "src/test/a.js")).toBe(false);
    expect(hits("src/*.js", "src/a.js")).toBe(true);
    expect(hits("src/*.js", "src/a/b.js")).toBe(false);
    expect(hits("a.js", "aXjs")).toBe(false);
  });

  test("changedPaths sees edits, additions and deletions", () => {
    expect(changedPaths(new Map([["a", "1"], ["b", "1"]]), new Map([["a", "2"], ["c", "1"]]))).toEqual(["a", "b", "c"]);
  });
});

describe("the table", () => {
  test("n counts every attempt but the invalid ones, and the caveat is printed", async () => {
    const rows = await runCodeEval([TASK, { ...TASK, id: "other" }], ["claude", "codex"], {
      ...stub({ gates: [] }),
      gate: (() => {
        const queue = [RED, GREEN, GREEN, RED, RED, RED, RED, RED]; // claude: red→green, other: starts green (invalid); codex: red→red, red→red
        return async () => queue.shift() ?? RED;
      })(),
    });
    const table = codeTable(rows);
    expect(table.map((line) => [line.backend, line.n, line.green, line.invalid])).toEqual([["claude", 1, 1, 1], ["codex", 2, 0, 0]]);
    const text = codeLines(table).join("\n");
    expect(text).toContain("claude (m1): 1/1 green (100%)");
    expect(text).toContain("1 invalid task(s), not counted");
    expect(text).toContain("codex (m1): 0/2 green (0%) — 2 still red");
    expect(text).toContain("not a ranking");
  });
});
