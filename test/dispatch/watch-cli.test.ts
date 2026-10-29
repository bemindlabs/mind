import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDispatch } from "../../bin/commands/dispatch.ts";

test("watch prints commands for changed and first-seen models and table labels the prior", async () => {
  const root = await mkdtemp(join(tmpdir(), "mind-watch-"));
  const data = process.env["XDG_DATA_HOME"];
  const state = process.env["XDG_STATE_HOME"];
  const log = console.log;
  const error = console.error;
  const output: string[] = [];
  try {
    process.env["XDG_DATA_HOME"] = root;
    process.env["XDG_STATE_HOME"] = root;
    console.log = (...args) => { output.push(args.join(" ")); };
    console.error = () => {};
    const personal = join(root, "mind", "s", "personal", "measure");
    await mkdir(personal, { recursive: true });
    const line = (task: string, backend: string, model: string, at: string) => ({ v: 1, task, subject: "s", at, kind: "bugfix", status: "done", backend, model, steps: [{ backend, model, n: 1 }], turns: 1, tokens: null, tokensUnknown: 1, activeMs: 1, review: null });
    await writeFile(join(personal, "measures.jsonl"), [line("a", "claude", "old", "2026-01-01"), line("b", "claude", "new", "2026-01-02"), line("c", "codex", "first", "2026-01-02")].map((item) => JSON.stringify(item)).join("\n"));
    const book = join(root, "mind", "models-seen.json");
    const original = JSON.stringify({ models: { claude: { model: "old", since: "2026-01-01" } } });
    await writeFile(book, original);
    expect(await cmdDispatch(["watch", "agent dir", "--subject", "s"])).toBe(0);
    expect(output.join("\n")).toContain("mind eval code 'agent dir' --subject s --set evals/code --backend claude");
    expect(output.join("\n")).toContain("mind eval code 'agent dir' --subject s --set evals/code --backend codex");
    expect(await readFile(book, "utf8")).toBe(original);
    output.length = 0;
    expect(await cmdDispatch(["watch", "agent dir", "--subject", "s", "--json"])).toBe(0);
    const watched = JSON.parse(output[0]!) as { changes: { evalCommand: string }[]; first: { evalCommand: string }[] };
    expect(watched.changes[0]!.evalCommand).toContain("--backend claude");
    expect(watched.first[0]!.evalCommand).toContain("--backend codex");
    output.length = 0;
    expect(await cmdDispatch(["table", "agent dir", "--subject", "s"])).toBe(0);
    expect(output.join("\n")).toContain("not measured for this model");
    expect(output.join("\n")).toContain("n=1");
  } finally {
    console.log = log;
    console.error = error;
    if (data === undefined) delete process.env["XDG_DATA_HOME"]; else process.env["XDG_DATA_HOME"] = data;
    if (state === undefined) delete process.env["XDG_STATE_HOME"]; else process.env["XDG_STATE_HOME"] = state;
    await rm(root, { recursive: true, force: true });
  }
});
