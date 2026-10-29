/** `mind dispatch` and `mind task new --kind/--backend auto` end to end (S22.14, S22.15). */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Measure } from "../../src/dispatch/measure.ts";
import { BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home() {
  const dir = await mkdtemp(join(tmpdir(), "mind-dispatch-cli-"));
  scratch.push(dir);
  const bin = join(dir, "bin");
  await mkdir(bin);
  // Stubs that only have to be on PATH: `available()` is a lookup.
  for (const name of ["claude", "codex", "grok"]) {
    await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, name), 0o755);
  }
  const env: Record<string, string> = {
    HOME: dir,
    PATH: `${bin}:/usr/bin:/bin`,
    XDG_STATE_HOME: join(dir, "state"),
    XDG_DATA_HOME: join(dir, "data"),
    MIND_QDRANT_URL: "http://127.0.0.1:9",
    MIND_NO_UPDATE_CHECK: "1",
  };
  const personal = join(dir, "data", "mind", "example", "personal");
  return { dir, env, personal, tasks: join(personal, "tasks") };
}

async function run(env: Record<string, string>, args: readonly string[]) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: env["HOME"]!, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  await child.exited;
  return { code: child.exitCode ?? -1, stdout: stdout.trim(), stderr };
}

function measure(backend: string, model: string | null, kind: string, status: Measure["status"], n: number): Measure {
  return { v: 1, task: `t-${n.toString(16).padStart(8, "0")}`, subject: "example", at: "2026-10-28T00:00:00.000Z", kind, status, backend, model, steps: [], turns: 3, tokens: 100, tokensUnknown: 0, activeMs: 1000, review: null };
}

async function seed(personal: string, lines: readonly Measure[]) {
  await mkdir(join(personal, "measure"), { recursive: true });
  await writeFile(join(personal, "measure", "measures.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

const new_ = (env: Record<string, string>, ...extra: string[]) => run(env, ["task", "new", SOUL, "--subject", "example", "--goal", "x", "--queue", "--json", ...extra]);

describe("mind task new --kind and --backend auto (S22.14)", () => {
  test("a kind is stored on the record, and anything that is not a slug is refused", async () => {
    const h = await home();
    const made = await new_(h.env, "--kind", "bugfix", "--backend", "claude");
    expect(made.code, made.stderr).toBe(0);
    const id = (JSON.parse(made.stdout) as { id: string }).id;
    expect((JSON.parse(await readFile(join(h.tasks, id, "task.json"), "utf8")) as { kind: string }).kind).toBe("bugfix");
    expect((await new_(h.env, "--kind", "Fix it for Alice")).code).toBe(2);
  });

  test("auto needs a kind, and --candidates/--from need auto", async () => {
    const h = await home();
    expect((await new_(h.env, "--backend", "auto")).stderr).toContain("--backend auto needs --kind");
    expect((await new_(h.env, "--candidates", "claude")).code).toBe(2);
  });

  test("auto writes the ranked chain into the task and says why, with the numbers behind it", async () => {
    const h = await home();
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => measure("claude", "claude-opus-5-5", "bugfix", i < 2 ? "done" : "failed", i)),
      ...Array.from({ length: 5 }, (_, i) => measure("codex", "gpt-6-sol", "bugfix", "done", 10 + i)),
    ];
    await seed(h.personal, lines);
    const made = await new_(h.env, "--kind", "bugfix", "--backend", "auto", "--candidates", "claude,codex,grok");
    expect(made.code, made.stderr).toBe(0);
    const id = (JSON.parse(made.stdout) as { id: string }).id;
    const record = JSON.parse(await readFile(join(h.tasks, id, "task.json"), "utf8")) as { backend: string };
    // codex is 5 of 5, claude 2 of 5, grok has no data: codex leads unless the dice sample grok, which then goes first.
    expect(["codex,claude,grok", "grok,codex,claude"]).toContain(record.backend);
    expect(made.stderr).toContain("dispatch for bugfix");
    expect(made.stderr).toContain("claude  n=5");
    expect(made.stderr).toContain("codex  n=5");
  });

  test("a resting backend is last in the chain, with the reason said", async () => {
    const h = await home();
    await seed(h.personal, Array.from({ length: 5 }, (_, i) => measure("codex", "gpt-6-sol", "bugfix", "done", i)));
    const { fileHealth, healthPath } = await import("../../src/exec/health.ts");
    fileHealth(healthPath(h.dir, h.env)).rest("codex", Date.now() + 3_600_000, Date.now());
    const made = await new_(h.env, "--kind", "bugfix", "--backend", "auto", "--candidates", "claude,codex");
    const id = (JSON.parse(made.stdout) as { id: string }).id;
    const record = JSON.parse(await readFile(join(h.tasks, id, "task.json"), "utf8")) as { backend: string };
    expect(record.backend).toBe("claude,codex");
    expect(made.stderr).toContain("resting until");
  });
});

describe("mind dispatch (S22.14, S22.15)", () => {
  test("table shows each row with its n, and a stopped task is counted apart", async () => {
    const h = await home();
    await seed(h.personal, [
      ...Array.from({ length: 4 }, (_, i) => measure("claude", "claude-opus-5-5", "bugfix", "done", i)),
      measure("claude", "claude-opus-5-5", "bugfix", "failed", 4),
      measure("claude", "claude-opus-5-5", "bugfix", "stopped", 5),
      measure("codex", "gpt-6-sol", "docs", "done", 6),
    ]);
    const shown = await run(h.env, ["dispatch", "table", SOUL, "--subject", "example"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("claude");
    expect(shown.stdout).toContain("n=5");
    expect(shown.stdout).toContain("80% of 5");
    expect(shown.stdout).toContain("(1 stopped, not counted)");
    const json = JSON.parse((await run(h.env, ["dispatch", "table", SOUL, "--subject", "example", "--kind", "docs", "--json"])).stdout) as { rows: { backend: string; n: number }[] };
    expect(json.rows.map((r) => [r.backend, r.n])).toEqual([["codex", 1]]);
    expect(shown.stderr).toContain("a direction, not a score of skill");
  });

  test("suggest ranks and explains, review proposes where the numbers point and changes nothing", async () => {
    const h = await home();
    await seed(h.personal, Array.from({ length: 5 }, (_, i) => measure("codex", "gpt-6-sol", "bugfix", "done", i)));
    const suggested = JSON.parse((await run(h.env, ["dispatch", "suggest", SOUL, "--subject", "example", "--kind", "bugfix", "--candidates", "claude,codex", "--explore", "0", "--json"])).stdout) as { chain: string[]; mode: string };
    expect(suggested.chain).toEqual(["codex", "claude"]);
    expect(suggested.mode).toBe("table");
    const reviewed = await run(h.env, ["dispatch", "review", SOUL, "--subject", "example", "--candidates", "claude,codex"]);
    expect(reviewed.stdout).toContain("bugfix: go to codex first (100% of 5 done), not claude");
    expect(reviewed.stderr).toContain("Nothing was changed");
    expect((await run(h.env, ["dispatch", "suggest", SOUL, "--subject", "example", "--candidates", "claude"])).code).toBe(2);
    expect((await run(h.env, ["dispatch", "suggest", SOUL, "--subject", "example", "--kind", "x", "--explore", "2"])).code).toBe(2);
    expect((await run(h.env, ["dispatch"])).code).toBe(2);
  });

  test("watch reports a model change from finished tasks' measure lines until it is read, then goes quiet; and it reads no ledger", async () => {
    const h = await home();
    const finished = (task: number, model: string, at: string): Measure => ({ ...measure("claude", model, "bugfix", "done", task), at, steps: [{ backend: "claude", model, n: 1 }] });
    await seed(h.personal, [finished(1, "claude-opus-5", "2026-10-20T00:00:00.000Z")]);
    const first = await run(h.env, ["dispatch", "watch", SOUL, "--subject", "example", "--update"]);
    expect(first.stdout).toContain("claude: first seen on claude-opus-5");
    await seed(h.personal, [finished(1, "claude-opus-5", "2026-10-20T00:00:00.000Z"), finished(2, "claude-opus-5-5", "2026-10-27T00:00:00.000Z")]);
    const changed = await run(h.env, ["dispatch", "watch", SOUL, "--subject", "example"]);
    expect(changed.stdout).toContain("claude: claude-opus-5 → claude-opus-5-5");
    expect(changed.stdout).toContain("start independently");
    expect(changed.stdout).toContain(`mind eval code ${SOUL} --subject example --set evals/code --backend claude`);
    expect(changed.stderr).toContain("reported until you run this with --update");
    const again = await run(h.env, ["dispatch", "watch", SOUL, "--subject", "example", "--update"]);
    expect(again.stdout).toContain("claude: claude-opus-5 → claude-opus-5-5");
    const quiet = await run(h.env, ["dispatch", "watch", SOUL, "--subject", "example"]);
    expect(quiet.stdout).toContain("no backend has changed its model");
  });
});
