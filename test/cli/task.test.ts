/**
 * `mind task` end to end against a stub ollama on loopback (D-154): the real CLI, the real runner, real
 * `mind turn` children and their ledger lines — with a model that answers from a script. What a real model
 * and a real browser do is `test/e2e/tasks.e2e.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_SCHEMA, type BrowserRecord } from "../../src/browser/store.ts";
import { recordPath } from "../../src/browser/paths.ts";
import { HELD_SCHEMA } from "../../src/task/approvals.ts";
import { TASK_SCHEMA, type TaskRecord } from "../../src/task/store.ts";
import { subjectId } from "../../src/types.ts";
import { BUN } from "../support/bare-path.ts";
import { waitFor } from "../support/wait.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const SUBJECT = subjectId("example");

/** The stub model: a plan, then steps that are done after `doneAfter` of them; it can be held. */
const model = { doneAfter: 2, hold: false, never: false, fence: "mind-task", held: [] as (() => void)[], prompts: [] as string[] };
let server: ReturnType<typeof Bun.serve>;
const scratch: string[] = [];

beforeAll(() => {
  let steps = 0;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "stub" }] });
      const body = (await request.json()) as { messages: { content: string }[] };
      const prompt = body.messages.at(-1)!.content;
      model.prompts.push(prompt);
      if (prompt.includes("only make the plan")) return Response.json({ message: { content: `Plan.\n\`\`\`${model.fence}\n{"plan": ["look", "answer"]}\n\`\`\`` } });
      if (model.hold) await new Promise<void>((resolve) => model.held.push(resolve));
      steps += 1;
      const done = !model.never && steps % model.doneAfter === 0;
      const block = JSON.stringify({ done, summary: `step said ${steps}`, ...(done ? { result: "the answer is 42" } : {}) });
      return Response.json({ message: { content: `worked\n\`\`\`${model.fence}\n${block}\n\`\`\`` } });
    },
  });
});

afterAll(async () => {
  for (const release of model.held.splice(0)) release();
  server.stop(true);
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home() {
  const dir = await mkdtemp(join(tmpdir(), "mind-task-cli-"));
  scratch.push(dir);
  const bin = join(dir, "bin");
  await mkdir(bin);
  await symlink(BUN, join(bin, "bun"));
  const env: Record<string, string> = {
    HOME: dir,
    PATH: `${bin}:/usr/bin:/bin`,
    XDG_STATE_HOME: join(dir, "state"),
    XDG_DATA_HOME: join(dir, "data"),
    OLLAMA_HOST: server.url.origin,
    MIND_OLLAMA_MODEL: "stub",
    MIND_QDRANT_URL: "http://127.0.0.1:9",
  };
  const tasks = join(dir, "data", "mind", SUBJECT, "personal", "tasks");
  return { dir, env, tasks };
}

async function run(env: Record<string, string>, args: readonly string[], cwd: string = env["HOME"]!) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** The CLI with a terminal at both ends (util-linux `script`): how a person answers an approval. */
async function atTerminal(env: Record<string, string>, args: readonly string[], redirect = "") {
  const line = [BUN, "run", BIN, ...args].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ") + redirect;
  const child = Bun.spawn(["script", "-qec", line, "/dev/null"], { cwd: env["HOME"]!, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return { code: child.exitCode ?? -1, out };
}

async function readRecord(tasks: string, id: string): Promise<TaskRecord> {
  return JSON.parse(await readFile(join(tasks, id, "task.json"), "utf8")) as TaskRecord;
}

/** The value `what` finds, waited for by a deadline (test/support/wait.ts) — or the test fails, saying so. */
async function until<T>(what: () => Promise<T | undefined>, within = 30_000): Promise<T> {
  let found: T | undefined;
  const held = await waitFor(async () => {
    found = await what().catch(() => undefined);
    return found !== undefined;
  }, { within, every: 50 });
  if (!held || found === undefined) throw new Error("the condition this test waits for never held");
  return found;
}

async function ledgerTurns(dir: string): Promise<string[]> {
  const ledger = join(dir, "state", "mind", "ledger", SUBJECT);
  const ids: string[] = [];
  for (const file of await readdir(ledger).catch(() => [] as string[])) {
    for (const line of (await readFile(join(ledger, file), "utf8")).split("\n").filter((l) => l !== "")) ids.push((JSON.parse(line) as { turn: string }).turn);
  }
  return ids;
}

describe("mind task", () => {
  test("new: plan, steps, done — every step an ordinary turn with its ledger line; list and show tell it", async () => {
    model.doneAfter = 2;
    model.never = false;
    const h = await home();
    const ran = await run(h.env, ["task", "new", SOUL, "--subject", "example", "--goal", "find the answer", "--backend", "ollama", "--json"]);
    expect(ran.code, ran.stderr).toBe(0);
    const summary = JSON.parse(ran.stdout) as { id: string; status: string; result: string; steps: { turnId: string; kind: string }[] };
    expect(summary.status).toBe("done");
    expect(summary.result).toBe("the answer is 42");
    expect(ran.stderr).toContain(`task ${summary.id}: planning…`);
    // AC3: one ledger line per step, each named by the step that ran it.
    const ledger = await ledgerTurns(h.dir);
    for (const step of summary.steps) expect(ledger).toContain(step.turnId);
    expect(summary.steps.map((s) => s.kind)).toEqual(["plan", "step", "step"]);

    const list = await run(h.env, ["task", "list", SOUL, "--subject", "example"]);
    expect(list.stdout).toContain(`${summary.id}  done`);
    const listJson = JSON.parse((await run(h.env, ["task", "list", SOUL, "--subject", "example", "--json"])).stdout);
    expect(listJson.tasks[0].id).toBe(summary.id);
    const show = await run(h.env, ["task", "show", summary.id, SOUL, "--subject", "example"]);
    expect(show.stdout).toContain("result: the answer is 42");
    expect(show.stdout).toContain("1. look");
    expect((await run(h.env, ["task", "show", "t-11111111", SOUL, "--subject", "example"])).code).toBe(2);
    // The goal and steps are personal data: under personal/, not in the agent's repository.
    expect(await Bun.file(join(h.tasks, summary.id, "task.json")).exists()).toBe(true);
    // Stopping a task that ended changes nothing.
    expect((await run(h.env, ["task", "stop", summary.id, SOUL, "--subject", "example"])).stdout).toContain("had ended already (done)");
  }, 60_000);


  test("the budget stops a runaway task (exit 3)", async () => {
    model.never = true;
    const h = await home();
    const ran = await run(h.env, ["task", "new", SOUL, "--subject", "example", "--goal", "never ends", "--backend", "ollama", "--budget-turns", "3"]);
    model.never = false;
    expect(ran.code).toBe(3);
    expect(ran.stderr).toContain("budget — its budget of 3 turn(s) is spent");
  }, 60_000);

  test("refusals: no goal, a bad number, a browser without sites or on a backend that cannot have one, the brake", async () => {
    const h = await home();
    const base = ["task", "new", SOUL, "--subject", "example"];
    expect((await run(h.env, [...base])).code).toBe(2);
    expect((await run(h.env, [...base, "--goal", "x", "--budget-turns", "0"])).stderr).toContain("--budget-turns must be 1–200");
    expect((await run(h.env, [...base, "--goal", "x", "--operate", "3"])).code).toBe(2);
    expect((await run(h.env, [...base, "--goal", "x", "--allow", "https://a.example"])).stderr).toContain("--allow is for a task with a browser");
    expect((await run(h.env, [...base, "--goal", "x", "--operate", "1"])).stderr).toContain("needs --allow");
    const grok = await run(h.env, [...base, "--goal", "x", "--operate", "1", "--allow", "https://a.example", "--backend", "grok-local"]);
    expect(grok.code).toBe(4);
    expect(grok.stderr).toContain("claude and claude-local only");
    expect((await run(h.env, [...base, "--goal", "x", "--backend", "nope"])).stderr).toContain("unknown backend");
    expect((await run(h.env, ["task", "new", SOUL, "--subject", "Bad Subject", "--goal", "x"])).code).toBe(2);
    expect((await run(h.env, ["task", "frob"])).code).toBe(2);
    await mkdir(join(h.dir, "state", "mind"), { recursive: true });
    await writeFile(join(h.dir, "state", "mind", "STOP"), "stopped\n");
    const braked = await run(h.env, [...base, "--goal", "x", "--backend", "ollama"]);
    expect(braked.code).toBe(4);
    expect(braked.stderr).toContain("the brake is on");
    expect(await readdir(h.tasks).catch(() => [])).toEqual([]);
  }, 60_000);

  test("detach, then `task stop` mid-step: the step's turn is ended and no next step starts", async () => {
    model.hold = true;
    const h = await home();
    const started = await run(h.env, ["task", "new", SOUL, "--subject", "example", "--goal", "a long one", "--backend", "ollama", "--detach", "--json"]);
    expect(started.code, started.stderr).toBe(0);
    const { id } = JSON.parse(started.stdout) as { id: string };
    const mid = await until(async () => {
      const record = await readRecord(h.tasks, id);
      return record.current !== null && record.steps.at(-1)?.kind === "step" ? record : undefined;
    });
    expect(mid.status).toBe("running");
    const stopped = await run(h.env, ["task", "stop", id, SOUL, "--subject", "example", "--json"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ ok: true, outcome: "stopped" });
    const after = await until(async () => {
      const record = await readRecord(h.tasks, id);
      return record.runner === null ? record : undefined;
    });
    model.hold = false;
    for (const release of model.held.splice(0)) release();
    expect(after.status).toBe("stopped");
    expect(after.steps.filter((s) => s.kind === "step")).toHaveLength(1);
    expect(await readFile(join(h.tasks, id, "runner.log"), "utf8")).toContain("stopped");
  }, 60_000);

  test("a runner killed mid-step leaves an interrupted task; resume carries on from that step", async () => {
    model.hold = true;
    model.doneAfter = 1;
    const h = await home();
    const started = await run(h.env, ["task", "new", SOUL, "--subject", "example", "--goal", "survive a crash", "--backend", "ollama", "--detach", "--json"]);
    const { id, pid } = JSON.parse(started.stdout) as { id: string; pid: number };
    await until(async () => {
      const record = await readRecord(h.tasks, id);
      return record.current !== null && record.steps.at(-1)?.kind === "step" ? record : undefined;
    });
    process.kill(pid, "SIGKILL");
    // The orphaned step's turn may finish now; whatever it says, nobody records it into the task.
    model.hold = false;
    for (const release of model.held.splice(0)) release();
    const shown = await until(async () => {
      const out = await run(h.env, ["task", "show", id, SOUL, "--subject", "example", "--json"]);
      const summary = JSON.parse(out.stdout) as { status: string };
      return summary.status === "interrupted" ? summary : undefined;
    });
    expect(shown.status).toBe("interrupted");
    const resumed = await run(h.env, ["task", "resume", id, SOUL, "--subject", "example", "--json"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    const summary = JSON.parse(resumed.stdout) as { status: string; steps: { outcome: string }[]; used: { turns: number } };
    expect(summary.status).toBe("done");
    expect(summary.steps.map((s) => s.outcome)).toEqual(["ok", "interrupted", "ok"]);
    expect(summary.used.turns).toBe(3);
    expect(model.prompts.at(-1)).toContain("was interrupted before it reported");
    // Not interrupted any more: nothing to resume.
    expect((await run(h.env, ["task", "resume", id, SOUL, "--subject", "example"])).code).toBe(5);
    model.doneAfter = 2;
  }, 60_000);

  test("a task is not started from inside a turn: task new, run and resume under a recorded turn are refused (second review)", async () => {
    const { describeRun, procStat, writeRunRecord } = await import("../../src/decide/runs.ts");
    const h = await home();
    const commands = [
      ["task", "new", SOUL, "--subject", "example", "--goal", "x", "--backend", "ollama"],
      ["task", "run", "t-0000abcd", SOUL, "--subject", "example"],
      ["task", "resume", "t-0000abcd", SOUL, "--subject", "example"],
    ];
    for (const args of commands) {
      // A shell that stays the CLI's parent, recorded as a turn the moment it exists.
      const line = [BUN, "run", BIN, ...args].map((part) => `'${part}'`).join(" ");
      const shell = Bun.spawn(["sh", "-c", `sleep 1; ${line}; echo "exit=$?"`], { cwd: h.dir, env: h.env, stdout: "pipe", stderr: "pipe" });
      await writeRunRecord({ home: h.dir, env: h.env }, { ...describeRun({ turnId: "chat-under", subject: SUBJECT, backends: ["claude"], at: new Date(), loosened: true }), pid: shell.pid, pidStart: procStat(shell.pid)?.startTicks ?? null });
      const [out, err] = [await new Response(shell.stdout).text(), await new Response(shell.stderr).text()];
      await shell.exited;
      expect(out, err).toContain("exit=4");
      expect(err).toContain("runs under turn chat-under");
    }
    expect(await readdir(h.tasks).catch(() => [])).toEqual([]);
  }, 60_000);

  test("`mind stop` asks every running task to stop", async () => {
    const h = await home();
    const tasks = h.tasks;
    await mkdir(join(tasks, "t-0000abcd"), { recursive: true });
    const record: Partial<TaskRecord> = { schema: TASK_SCHEMA, id: "t-0000abcd", subject: SUBJECT, goal: "g", dir: SOUL, cwd: h.dir, status: "running", steps: [], allow: [], operate: 0, budget: { turns: 1, minutes: 1, tokens: null }, used: { turns: 0, activeMs: 0, tokens: 0, tokensUnknown: 0 }, createdAt: "2026-10-05T00:00:00.000Z" };
    await writeFile(join(tasks, "t-0000abcd", "task.json"), JSON.stringify(record));
    const stopped = await run(h.env, ["stop"]);
    expect(stopped.stdout).toContain("5. tasks");
    expect(stopped.stdout).toContain("t-0000abcd (subject example, running): asked to stop");
    expect(await Bun.file(join(tasks, "t-0000abcd", "stop")).exists()).toBe(true);
  }, 60_000);
});

describe("mind turn --task", () => {
  async function claudeStub(dir: string): Promise<string> {
    const bin = join(dir, "vendors");
    await mkdir(bin);
    await writeFile(
      join(bin, "claude"),
      `#!${BUN}\nrequire("node:fs").appendFileSync(process.env.HOME + "/argv-claude.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");\nconsole.log(JSON.stringify({ result: "seen", text: "seen" }));\n`,
    );
    await chmod(join(bin, "claude"), 0o755);
    return bin;
  }

  async function plantTask(tasks: string, cwd: string, overrides: Partial<TaskRecord>): Promise<void> {
    await mkdir(join(tasks, "t-0000abcd"), { recursive: true });
    const record = {
      schema: TASK_SCHEMA, id: "t-0000abcd", subject: SUBJECT, goal: "g", dir: SOUL, cwd, status: "running", steps: [], allow: ["http://a.example:80"], operate: 2,
      budget: { turns: 5, minutes: 5, tokens: null }, used: { turns: 0, activeMs: 0, tokens: 0, tokensUnknown: 0 }, createdAt: "2026-10-05T00:00:00.000Z",
      stepSeconds: 60, approvalSeconds: 30, browser: { task: "t-0000abcd", port: 30_745 }, ...overrides,
    };
    await writeFile(join(tasks, "t-0000abcd", "task.json"), JSON.stringify(record));
  }

  test("a step of a browser task hands claude its browser — one server, its tools, and a tool timeout past an approval's wait", async () => {
    const h = await home();
    const vendors = await claudeStub(h.dir);
    await plantTask(h.tasks, h.dir, {});
    const env = { ...h.env, PATH: `${vendors}:${h.env["PATH"]}` };
    const browserEnv = { home: h.dir, env };
    const record: BrowserRecord = {
      schema: BROWSER_SCHEMA, task: "t-0000abcd", subject: SUBJECT, container: "mind-browser-x-t-0000abcd", image: "i", port: 30_745, token: "ab".repeat(32),
      allowed: ["http://a.example:80"], operate: 2, outDir: join(h.dir, "out"), owner: null, startedAt: new Date().toISOString(), ttlSeconds: 600,
    };
    await mkdir(join(h.dir, "state", "mind", "browser", SUBJECT), { recursive: true });
    await writeFile(recordPath(browserEnv, SUBJECT, "t-0000abcd"), JSON.stringify(record));
    // operate and reach at 2, so the step may act in the browser.
    const agent = join(h.dir, "agent");
    await mkdir(agent);
    for (const file of await readdir(SOUL)) await writeFile(join(agent, file), await readFile(join(SOUL, file)));
    await plantTask(h.tasks, h.dir, { dir: agent });
    for (const [cat, level] of [["reach", "2"], ["operate", "2"], ["write", "2"], ["run", "2"]]) {
      const set = await run(env, ["autonomy", "set", cat!, level!, agent, "--subject", "example"]);
      expect(set.code, set.stderr).toBe(0);
    }
    const ran = await run(env, ["turn", agent, "--subject", "example", "--prompt", "look", "--backend", "claude", "--task", "t-0000abcd", "--json"]);
    expect(ran.code, ran.stderr).toBe(0);
    const json = JSON.parse(ran.stdout) as { task: string; turn: string };
    expect(json.task).toBe("t-0000abcd");
    expect(json.turn).toMatch(/^[0-9a-f-]{36}$/);
    expect(ran.stderr).toContain("this step has its browser (operate 2");
    const argv = (await readFile(join(h.dir, "argv-claude.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as string[]).at(-1)!;
    const config = argv[argv.indexOf("--mcp-config") + 1]!;
    expect(argv).toContain("--strict-mcp-config");
    // Review of PR #24, finding 1: the dial says write and run 2, and the step still has no shell, no file
    // tools and no web fetch — the browser only (claude's `--tools ""`, no grant).
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv.join(" ")).not.toMatch(/Bash|WebFetch|acceptEdits/);
    expect(ran.stderr).toContain("acts through the browser only");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toContain("mcp__mind-browser__browser_click");
    const written = JSON.parse(await readFile(config, "utf8"));
    expect(written.mcpServers["mind-browser"].timeout).toBe(150_000);
  }, 60_000);

  test("refused before anything is sent: an unknown or ended task, --task with --proposal, a non-browser backend, a dial at operate 0", async () => {
    const h = await home();
    const base = ["turn", SOUL, "--subject", "example", "--prompt", "x"];
    expect((await run(h.env, [...base, "--task", "t-11111111"])).stderr).toContain("no task t-11111111");
    expect((await run(h.env, ["turn", SOUL, "--subject", "example", "--proposal", "p", "--task", "t-11111111"])).stderr).toContain("--task cannot go with --proposal");
    await plantTask(h.tasks, h.dir, { status: "done" });
    expect((await run(h.env, [...base, "--task", "t-0000abcd"])).stderr).toContain("is done; its steps are over");
    await plantTask(h.tasks, h.dir, {});
    const ollama = await run(h.env, [...base, "--task", "t-0000abcd", "--backend", "ollama"]);
    expect(ollama.code).toBe(4);
    expect(ollama.stderr).toContain("claude and claude-local only");
    // The fixture soul has no autonomy.md: operate is 0.
    const dial = await run(h.env, [...base, "--task", "t-0000abcd", "--backend", "claude"]);
    expect(dial.code).toBe(4);
    expect(dial.stderr).toContain("browser level for this turn is 0");
  }, 60_000);
});

describe("mind task approve | deny (D-156)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const release = require("../../docker/browser/release.cjs") as { descriptorOf: (a: object) => object; digestOf: (d: object) => string; macOf: (k: string, i: string, d: string, v: string) => string };
  const KEY = "cd".repeat(32);

  async function held(outDir: string, id: string, credential = false): Promise<string> {
    const action = release.descriptorOf(credential ? { kind: "type", origin: "http://a.example:80", role: "textbox", text: "Password", valueClass: "password" } : { kind: "click", origin: "http://a.example:80", role: "button", text: "Delete" });
    const digest = release.digestOf(action);
    await mkdir(join(outDir, "pending"), { recursive: true });
    const kind = credential ? { rules: ["credentials.field"], categories: ["credentials"], approvable: false } : { rules: ["delete.words"], categories: ["delete"] };
    await writeFile(join(outDir, "pending", `${id}.json`), JSON.stringify({ schema: HELD_SCHEMA, id, action, digest, ...kind, reasons: ["r"], filedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    return digest;
  }

  test("shown with the task; a yes is claimed once (the runner releases it); a no with --stop stops the task", async () => {
    const h = await home();
    const outDir = join(h.dir, "data", "mind", SUBJECT, "personal", "browser", "t-0000abcd");
    await mkdir(join(h.tasks, "t-0000abcd"), { recursive: true });
    await writeFile(join(h.tasks, "t-0000abcd", "task.json"), JSON.stringify({
      schema: TASK_SCHEMA, id: "t-0000abcd", subject: SUBJECT, goal: "g", dir: SOUL, cwd: h.dir, status: "waiting", steps: [], allow: ["http://a.example:80"], operate: 2,
      budget: { turns: 5, minutes: 5, tokens: null }, used: { turns: 0, activeMs: 0, tokens: 0, tokensUnknown: 0 }, createdAt: "2026-10-05T00:00:00.000Z",
      via: "cli", backend: "claude-local", model: null, stepSeconds: 60, approvalSeconds: 600, statusAt: "2026-10-05T00:00:00.000Z", reason: null, plan: ["a"],
      result: null, runner: null, current: null, browser: { task: "t-0000abcd", port: 30_745 }, notes: [], generation: 1,
    } satisfies TaskRecord));
    const browserEnv = { home: h.dir, env: h.env };
    await mkdir(join(h.dir, "state", "mind", "browser", SUBJECT), { recursive: true });
    const record = { schema: BROWSER_SCHEMA, task: "t-0000abcd", subject: SUBJECT, container: "c", image: "i", port: 30_745, token: "ab".repeat(32), allowed: [], operate: 2, outDir, owner: null, startedAt: new Date().toISOString(), ttlSeconds: 600, approvalWaitSeconds: 600 };
    await writeFile(recordPath(browserEnv, SUBJECT, "t-0000abcd"), JSON.stringify(record));
    const one = "a-11111111-2222-4333-8444-555555555555";
    const two = "a-22222222-2222-4333-8444-555555555555";
    const digest = await held(outDir, one);
    await held(outDir, two);

    const show = await run(h.env, ["task", "show", "t-0000abcd", SOUL, "--subject", "example"]);
    expect(show.stdout, show.stderr).toContain(`${one} — pending`);
    expect(show.stdout).toContain('click "Delete" on http://a.example:80');
    const shownJson = JSON.parse((await run(h.env, ["task", "show", "t-0000abcd", SOUL, "--subject", "example", "--json"])).stdout) as { approvals: { id: string; status: string }[] };
    expect(shownJson.approvals.map((a) => a.status)).toEqual(["pending", "pending"]);

    // Review of PR #24, finding 1: not at a terminal — a script, an agent's shell — nothing is answered.
    const piped = await run(h.env, ["task", "approve", "t-0000abcd", one, SOUL, "--subject", "example", "--json"]);
    expect(piped.code).toBe(4);
    expect(piped.stderr).toContain("answered by a person");
    expect(await Bun.file(join(outDir, "release", `${one}.json`)).exists()).toBe(false);
    // At a terminal with any one stream not a terminal: refused, each of the three (second review).
    for (const redirect of [" < /dev/null", " > /dev/null", " 2> /dev/null"]) {
      const mixed = await atTerminal(h.env, ["task", "approve", "t-0000abcd", one, SOUL, "--subject", "example"], `${redirect}; echo "exit=$?"`);
      expect(mixed.out, redirect).toContain("exit=4");
    }
    expect(await Bun.file(join(h.tasks, "t-0000abcd", "approvals", "decided", `${one}.json`)).exists()).toBe(false);
    // `--by` is gone: what said "web" before is now a stray option nothing reads, and still a pipe.
    expect((await run(h.env, ["task", "approve", "t-0000abcd", one, SOUL, "--subject", "example", "--by", "web"])).code).toBe(4);

    const yes = await atTerminal(h.env, ["task", "approve", "t-0000abcd", one, SOUL, "--subject", "example"]);
    expect(yes.code, yes.out).toBe(0);
    // The answer is a claim; the release itself is the runner's to write, with the key only it holds.
    expect(JSON.parse(await readFile(join(h.tasks, "t-0000abcd", "approvals", "decided", `${one}.json`), "utf8"))).toMatchObject({ id: one, digest, verdict: "approve" });
    expect(await Bun.file(join(outDir, "release", `${one}.json`)).exists()).toBe(false);
    void release;
    void KEY;
    const again = await atTerminal(h.env, ["task", "approve", "t-0000abcd", one, SOUL, "--subject", "example"]);
    expect(again.code).toBe(5);
    expect(again.out).toContain("approved already");

    const no = await atTerminal(h.env, ["task", "deny", "t-0000abcd", two, SOUL, "--subject", "example", "--stop"]);
    expect(no.code, no.out).toBe(0);
    expect(no.out).toContain("denied");
    expect(JSON.parse(await readFile(join(h.tasks, "t-0000abcd", "approvals", "decided", `${two}.json`), "utf8")).verdict).toBe("deny");
    expect(await Bun.file(join(h.tasks, "t-0000abcd", "stop")).exists()).toBe(true);

    // D-160: a credential is shown as not allowed, and no answer releases it.
    const secret = "a-44444444-2222-4333-8444-555555555555";
    await held(outDir, secret, true);
    expect((await run(h.env, ["task", "show", "t-0000abcd", SOUL, "--subject", "example"])).stdout).toContain(`${secret} — not allowed yet (D-160)`);
    const refused = await atTerminal(h.env, ["task", "approve", "t-0000abcd", secret, SOUL, "--subject", "example"]);
    expect(refused.code).toBe(5);
    expect(refused.out).toContain("not allowed yet (D-160)");
    expect(await Bun.file(join(outDir, "release", `${secret}.json`)).exists()).toBe(false);

    expect((await atTerminal(h.env, ["task", "approve", "t-0000abcd", "a-99999999-2222-4333-8444-555555555555", SOUL, "--subject", "example"])).code).toBe(2);
    expect((await atTerminal(h.env, ["task", "approve", "t-11111111", one, SOUL, "--subject", "example"])).code).toBe(2);
    expect((await run(h.env, ["task", "approve", "t-0000abcd", SOUL, "--subject", "example"])).code).toBe(2);
    // With the browser gone there is nothing waiting to release.
    const three = "a-33333333-2222-4333-8444-555555555555";
    await held(outDir, three);
    // As the runner files it while the step runs.
    await mkdir(join(h.tasks, "t-0000abcd", "approvals"), { recursive: true });
    await writeFile(join(h.tasks, "t-0000abcd", "approvals", `${three}.json`), await readFile(join(outDir, "pending", `${three}.json`)));
    // Review of PR #24, finding 2: while an action waits, a turn that could run commands does not start.
    const agent = join(h.dir, "agent");
    await mkdir(agent);
    for (const file of await readdir(SOUL)) await writeFile(join(agent, file), await readFile(join(SOUL, file)));
    for (const [cat, level] of [["write", "2"], ["run", "2"], ["reach", "2"]]) expect((await run(h.env, ["autonomy", "set", cat!, level!, agent, "--subject", "example"])).code).toBe(0);
    // From a scratch directory of its own: a turn that may write is refused in a directory that holds the agent (D-163).
    const elsewhere = await mkdtemp(join(tmpdir(), "mind-task-cwd-"));
    const loosened = await run(h.env, ["turn", agent, "--subject", "example", "--prompt", "hi", "--backend", "ollama"], elsewhere);
    expect(loosened.code).toBe(4);
    expect(loosened.stderr).toContain(`is waiting on your answer to a held action (${three})`);
    const { rm: remove } = await import("node:fs/promises");
    await remove(recordPath(browserEnv, SUBJECT, "t-0000abcd"));
    const gone = await atTerminal(h.env, ["task", "approve", "t-0000abcd", three, SOUL, "--subject", "example"]);
    expect(gone.code).toBe(5);
    expect(gone.out).toContain("browser is gone");
    // Round 4: a loosened turn leaves a note of when it ran and ended, so a claim made meanwhile is tainted.
    await remove(join(outDir, "pending"), { recursive: true, force: true });
    await remove(join(h.tasks, "t-0000abcd", "approvals", `${three}.json`), { force: true });
    const { readEnded } = await import("../../src/decide/runs.ts");
    const before = Date.now();
    const ran = await run(h.env, ["turn", agent, "--subject", "example", "--prompt", "hi", "--backend", "ollama"], elsewhere);
    const notes = await readEnded({ home: h.env["HOME"]!, env: h.env });
    expect(notes, ran.stderr).toHaveLength(1);
    expect(Date.parse(notes[0]!.startedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(notes[0]!.endedAt)).toBeGreaterThanOrEqual(Date.parse(notes[0]!.startedAt));
    await rm(elsewhere, { recursive: true, force: true });
  }, 60_000);
});
