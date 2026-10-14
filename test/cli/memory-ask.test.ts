/**
 * D-152 through the binary — `mind memory ask`, against a stub ollama and stub vendor CLIs that record what
 * they were handed. Each claim is checked on what actually arrived: the sources are the pieces the answering
 * backend was given (not the files the model named), nothing recalled means no model is asked, every vendor
 * runs read-only even with the dial at 2, a piece with a personal word never reaches a cloud CLI, and the ask
 * leaves one ledger line per backend handed the question.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { grantArgs, readOnlyArgs, vendor } from "../../src/exec/registry.ts";
import { LOOSENED } from "../support/restraint.ts";
import { barePath, BUN } from "../support/bare-path.ts";
import { waitFor } from "../support/wait.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const SUBJECT = "example";
const DEAD = "http://127.0.0.1:9";
const SECRET = "Wanida Srisuk";

const MEMORY: Record<string, string> = {
  "memory/infra.md": "---\nname: Infra notes\n---\n\n# Ports\n\nThe second-brain dashboard listens on port 30600, tailnet only.\n\n# ราคา\n\nแจ้งราคาทองทุกเช้าเวลา 09:00\n",
  "memory/people.md": `# Invoices\n\nThe dashboard invoice goes to ${SECRET} every month.\n`,
};

const scratch: string[] = [];
const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

/** An ollama that answers what it is told to, and keeps every system and prompt it was handed. */
function ollama(reply: string) {
  const systems: string[] = [];
  const prompts: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "stub" }] });
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      systems.push(body.messages.find((m) => m.role === "system")?.content ?? "");
      prompts.push(body.messages.at(-1)?.content ?? "");
      return Response.json({ message: { content: reply }, prompt_eval_count: 11, eval_count: 7 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, systems, prompts };
}

async function sandbox(memory: Record<string, string> = MEMORY) {
  const home = await mkdtemp(join(tmpdir(), "mind-memory-ask-"));
  scratch.push(home);
  const agent = join(home, "agent");
  await cp(SOUL, join(agent, "soul"), { recursive: true });
  for (const [rel, text] of Object.entries(memory)) {
    await mkdir(dirname(join(agent, rel)), { recursive: true });
    await Bun.write(join(agent, rel), text);
  }
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  // Vendor CLIs that write down their argv and answer in claude's JSON shape.
  for (const name of ["claude", "grok", "codex"]) {
    await Bun.write(
      join(bin, name),
      `#!/usr/bin/env bun\nrequire("node:fs").appendFileSync(process.env.HOME + "/${name}-argv.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");\nconsole.log(JSON.stringify({ result: "from ${name}: the dashboard is on 30600 (see memory/elsewhere.md)" }));\n`,
    );
    await chmod(join(bin, name), 0o755);
  }
  const path = `${bin}:${await barePath(home)}`;
  const run = async (args: readonly string[], ollamaUrl = DEAD) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], {
      cwd: ROOT,
      env: { HOME: home, PATH: path, XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), OLLAMA_HOST: ollamaUrl, MIND_EMBED_URL: DEAD, MIND_QDRANT_URL: DEAD, MIND_CAPTURE: "off" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  const argvOf = async (name: string): Promise<string[][]> => {
    const file = Bun.file(join(home, `${name}-argv.jsonl`));
    if (!(await file.exists())) return [];
    return (await file.text()).trim().split("\n").map((l) => JSON.parse(l) as string[]);
  };
  const ledger = async (): Promise<Record<string, unknown>[]> => {
    const dir = join(home, "state", "mind", "ledger", SUBJECT);
    const lines: Record<string, unknown>[] = [];
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      if (!file.endsWith(".jsonl")) continue;
      for (const line of (await Bun.file(join(dir, file)).text()).split("\n")) if (line.trim() !== "") lines.push(JSON.parse(line));
    }
    return lines;
  };
  return { home, agent, run, argvOf, ledger };
}

async function indexed(memory?: Record<string, string>) {
  const box = await sandbox(memory);
  const built = await box.run(["memory", "index", box.agent, "--subject", SUBJECT]);
  expect(built.code, built.stderr).toBe(0);
  return box;
}

const ask = (agent: string, question: string, ...extra: string[]) => ["memory", "ask", agent, "--subject", SUBJECT, "--json", ...extra, question];

interface AskOut {
  ok: boolean;
  answer: string;
  sources: { path: string; title?: string; section?: string }[];
  found: number;
  backend: string | null;
  model: string | null;
  local: boolean;
  held: number;
  pieces: { path: string; excerpt: string }[];
  searched: boolean;
}

describe("memory ask — an answer and the pieces it came from", () => {
  test("the sources are the pieces the backend was handed, never the file the model named; one ledger line", async () => {
    const box = await indexed();
    const model = ollama("The dashboard listens on 30600 (memory/made-up.md).");
    const result = await box.run(ask(box.agent, "which port does the dashboard use?", "--backend", "ollama", "--model", "stub"), model.url);

    expect(result.code, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as AskOut;
    expect(out.ok).toBe(true);
    expect(out.answer).toBe("The dashboard listens on 30600 (memory/made-up.md).");
    expect(out.backend).toBe("ollama");
    expect(out.model).toBe("stub");
    expect(out.local).toBe(true);
    // Handed by recall, not named by the model.
    expect(out.sources.map((s) => s.path)).not.toContain("memory/made-up.md");
    expect(out.sources).toContainEqual({ path: "memory/infra.md", title: "Infra notes", section: "Ports" });
    expect(new Set(out.sources.map((s) => `${s.path}#${s.section ?? ""}`)).size).toBe(out.sources.length);
    expect(out.found).toBeGreaterThan(0);
    expect(out.pieces.some((p) => p.excerpt.includes("30600"))).toBe(true);
    // The question is the prompt as typed; the instruction and the pieces ride in the system message.
    expect(model.prompts).toEqual(["which port does the dashboard use?"]);
    expect(model.systems[0]).toContain("Never paste");
    expect(model.systems[0]).toContain("listens on port 30600");
    expect(model.systems[0]).toContain("Example Keeper");
    // Accounted for as a turn is (S2.2): one line, the question, the backend, the model.
    const lines = await box.ledger();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ backend: "ollama", model: "stub", prompt: "which port does the dashboard use?" });
  }, 60_000);

  test("plain output is the answer, then Sources:", async () => {
    const box = await indexed();
    const model = ollama("Port 30600, from memory/infra.md.");
    const result = await box.run(["memory", "ask", box.agent, "--subject", SUBJECT, "--backend", "ollama", "--model", "stub", "dashboard", "port?"], model.url);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.startsWith("Port 30600, from memory/infra.md.\n")).toBe(true);
    expect(result.stdout).toContain("Sources:");
    expect(result.stdout).toContain("memory/infra.md — Ports");
    expect(model.prompts).toEqual(["dashboard port?"]);
  }, 60_000);

  test("after --, --help and --as=… are a question, not help and not an identity", async () => {
    const box = await indexed();
    const model = ollama("NOT_IN_MEMORY");
    for (const question of ["--help", "-h", "--as=/elsewhere"]) {
      const result = await box.run(["memory", "ask", box.agent, "--subject", SUBJECT, "--backend", "ollama", "--model", "stub", "--json", "--", question], model.url);
      expect(result.stdout, question).not.toContain("Nothing was done. `--help` asks how");
      expect(result.code, `${question}: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout).ok, question).toBe(true);
    }
    // Before the --, --help is still a question about the command.
    const help = await box.run(["memory", "ask", box.agent, "--help"]);
    expect(help.stdout).toContain("Nothing was done. `--help` asks how");
  }, 60_000);

  test("after --, a question that looks like flags is asked word for word", async () => {
    const box = await indexed();
    const model = ollama("Port 30600 (memory/infra.md).");
    const result = await box.run(["memory", "ask", box.agent, "--subject", SUBJECT, "--backend", "ollama", "--model", "stub", "--json", "--", "--scope", "dashboard", "port", "-v", "--json"], model.url);
    expect(result.code, result.stderr).toBe(0);
    expect(model.prompts).toEqual(["--scope dashboard port -v --json"]);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  }, 60_000);

  test("nothing recalled: no model is asked, nothing is recorded, and it is said in the question's language", async () => {
    const box = await indexed();
    const model = ollama("should never be asked");
    for (const [question, said] of [["zebra quantum mongolia", "There is nothing in memory about this."], ["ยีราฟบินได้", "ใน memory ไม่มีเรื่องนี้"]] as const) {
      const result = await box.run(ask(box.agent, question, "--backend", "ollama", "--model", "stub"), model.url);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, answer: said, found: 0, sources: [], backend: null });
    }
    expect(model.prompts).toEqual([]);
    expect(await box.ledger()).toEqual([]);
  }, 60_000);

  test("each ask leaves one line of numbers in the personal directory — on the model path and the no-model path", async () => {
    const box = await indexed();
    const model = ollama("Port 30600 (memory/infra.md).");
    await box.run(ask(box.agent, "which port does the dashboard use?", "--backend", "ollama", "--model", "stub"), model.url);
    await box.run(ask(box.agent, "zebra quantum mongolia", "--backend", "ollama", "--model", "stub"), model.url);
    const where = await box.run(["egress", "needles", "--subject", SUBJECT]);
    const personal = dirname(dirname(where.stdout.split("\n")[0]!));
    const text = await Bun.file(join(personal, "ask", "recall.jsonl")).text();
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ v: 1, scope: "all", vector: false, best_cosine: null, model_asked: true });
    expect(lines[1]).toMatchObject({ kept: 0, handed: 0, model_asked: false });
    for (const leak of ["dashboard", "zebra", "memory/", "30600"]) expect(text).not.toContain(leak);
  }, 60_000);

  test("the model says memory does not cover it: the engine's sentence, found 0, no sources", async () => {
    const box = await indexed();
    const model = ollama("NOT_IN_MEMORY");
    const result = await box.run(ask(box.agent, "how is the dashboard port secured?", "--backend", "ollama", "--model", "stub"), model.url);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, answer: "There is nothing in memory about this.", found: 0, sources: [], backend: "ollama" });
    expect(model.prompts).toHaveLength(1);
  }, 60_000);

  test("an empty question and one over 2000 characters are refused with exit 2, before anything is read", async () => {
    const box = await indexed();
    const model = ollama("x");
    for (const question of ["   ", "x".repeat(2001)]) {
      const result = await box.run(ask(box.agent, question, "--backend", "ollama", "--model", "stub"), model.url);
      expect(result.code, question.slice(0, 10)).toBe(2);
    }
    expect((await box.run(["memory", "ask", box.agent, "--subject", SUBJECT])).code).toBe(2);
    expect((await box.run(["memory", "ask", box.agent, "--subject", SUBJECT, "--"])).code).toBe(2);
    expect((await box.run(ask(box.agent, "q", "--scope", "everything"))).code).toBe(2);
    expect(model.prompts).toEqual([]);
  }, 60_000);

  test("no index and no vector store: exit 3, nothing searched, nothing sent", async () => {
    const box = await sandbox();
    const model = ollama("x");
    const result = await box.run(ask(box.agent, "which port?", "--backend", "ollama", "--model", "stub"), model.url);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, searched: false });
    expect(result.stderr).toContain("nothing searched");
    expect(model.prompts).toEqual([]);
  }, 60_000);

  test("the scope narrows recall: knowledge only finds nothing in a memory with no knowledge/", async () => {
    const box = await indexed();
    const model = ollama("x");
    const result = await box.run(ask(box.agent, "dashboard port", "--backend", "ollama", "--model", "stub", "--scope", "knowledge"), model.url);
    expect(JSON.parse(result.stdout)).toMatchObject({ found: 0, backend: null });
    expect(model.prompts).toEqual([]);
  }, 60_000);
});

describe("memory ask — read-only on every backend, whatever the dial says", () => {
  test("with write, run and reach at 2, each vendor still gets its read-only flags and no grant", async () => {
    const box = await indexed();
    for (const category of ["write", "run", "reach"]) {
      const set = await box.run(["autonomy", "set", category, "2", box.agent, "--subject", SUBJECT]);
      expect(set.code, set.stderr).toBe(0);
    }
    for (const id of ["claude"]) {
      await box.run(ask(box.agent, "which port does the dashboard use?", "--backend", id));
      const argv = (await box.argvOf(id))[0];
      expect(argv, id).toBeDefined();
      const spec = vendor(id);
      const flags = readOnlyArgs(spec.readOnly);
      expect(flags.length, id).toBeGreaterThan(0);
      // The read-only flags, in order, somewhere in the argv…
      const at = argv!.findIndex((_, i) => flags.every((f, j) => argv![i + j] === f));
      expect(at, `${id}: ${JSON.stringify(argv)}`).toBeGreaterThanOrEqual(0);
      // …and none of what level 2 would grant.
      for (const granted of grantArgs(spec.grant, LOOSENED).filter((a) => a.startsWith("--") && !flags.includes(a))) {
        expect(argv, `${id} was granted ${granted}`).not.toContain(granted);
      }
    }
  }, 120_000);

  test("grok and grok-local keep read tools even read-only, so an ask never starts them", async () => {
    const box = await indexed();
    for (const id of ["grok", "grok-local"]) {
      const result = await box.run(ask(box.agent, "which port does the dashboard use?", "--backend", id));
      expect(result.code, id).toBe(1);
      expect(result.stderr, id).toContain(`${id} is left out of this ask — even read-only it keeps tools that read files`);
    }
    expect(await box.argvOf("grok")).toEqual([]);
    const model = ollama("Port 30600 (memory/infra.md).");
    const chain = await box.run(ask(box.agent, "which port does the dashboard use?", "--backend", "grok,ollama", "--model", "ollama=stub"), model.url);
    expect(JSON.parse(chain.stdout).backend).toBe("ollama");
    expect(await box.argvOf("grok")).toEqual([]);
  }, 60_000);

  test("a stopped ask kills a backend that ignores SIGTERM, after the grace, and exits", async () => {
    const box = await indexed();
    const bin = join(box.home, "bin");
    // A claude that ignores SIGTERM, then says so by writing its pid (whole, by rename), and never answers.
    // Handler first: the pid file is what lets the stop go, so the SIGTERM can never land before it is ignored.
    await Bun.write(join(bin, "claude"), `#!/usr/bin/env bun\nprocess.on("SIGTERM", () => {});\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.HOME + "/claude.pid.tmp", String(process.pid));\nfs.renameSync(process.env.HOME + "/claude.pid.tmp", process.env.HOME + "/claude.pid");\nsetInterval(() => {}, 1000);\n`);
    await chmod(join(bin, "claude"), 0o755);
    const child = Bun.spawn([BUN, "run", BIN, ...ask(box.agent, "which port does the dashboard use?", "--backend", "claude")], {
      cwd: ROOT,
      env: { HOME: box.home, PATH: `${bin}:${await barePath(box.home)}`, XDG_STATE_HOME: join(box.home, "state"), XDG_DATA_HOME: join(box.home, "data"), MIND_EMBED_URL: DEAD, MIND_QDRANT_URL: DEAD, MIND_CAPTURE: "off" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    // A fresh `Bun.file` on every look: one `BunFile` asked `exists()` again keeps its first `false`, which made
    // this wait always run out its whole budget and read the file only afterwards.
    const pidPath = join(box.home, "claude.pid");
    expect(await waitFor(() => Bun.file(pidPath).exists()), "the vendor never started").toBe(true);
    const vendorPid = Number(await Bun.file(pidPath).text());
    // A pid that is not one would make every check below about /proc/0 — and pass.
    expect(vendorPid).toBeGreaterThan(1);
    child.kill("SIGTERM");
    const started = performance.now();
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(child.exitCode).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false });
    // Gone, or a zombie waiting to be reaped — never still running.
    const running = async (): Promise<boolean> => {
      const stat = await Bun.file(`/proc/${vendorPid}/stat`).text().catch(() => "");
      return stat !== "" && !/\) Z /.test(stat);
    };
    await waitFor(async () => !(await running()));
    expect(await running(), await Bun.file(`/proc/${vendorPid}/stat`).text().catch(() => "gone")).toBe(false);
  }, 120_000);

  test("a vendor that cannot be handed the pieces is left out, and said so; it is never started", async () => {
    const box = await indexed();
    const model = ollama("Port 30600 (memory/infra.md).");
    const result = await box.run(ask(box.agent, "which port does the dashboard use?", "--backend", "codex,ollama", "--model", "stub"), model.url);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toContain("codex is left out of this ask");
    expect(await box.argvOf("codex")).toEqual([]);
    expect(JSON.parse(result.stdout).backend).toBe("ollama");
    expect((await box.run(ask(box.agent, "which port?", "--backend", "codex"))).code).toBe(1);
  }, 60_000);
});

describe("memory ask — personal pieces stay on this machine (D-095, D-048)", () => {
  async function withNeedle() {
    const box = await indexed();
    const where = await box.run(["egress", "needles", "--subject", SUBJECT]);
    const needles = where.stdout.split("\n")[0]!;
    await mkdir(dirname(needles), { recursive: true });
    await Bun.write(needles, `${SECRET}\n`);
    return box;
  }

  test("a cloud CLI gets the clean pieces only, and its sources say so", async () => {
    const box = await withNeedle();
    const model = ollama("x");
    const result = await box.run(ask(box.agent, "dashboard", "--backend", "claude,ollama", "--model", "ollama=stub"), model.url);
    expect(result.code, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as AskOut;
    expect(out.backend).toBe("claude");
    expect(out.local).toBe(false);
    expect(out.held).toBe(1);
    expect(out.sources.map((s) => s.path)).toEqual(["memory/infra.md"]);
    expect(out.pieces.map((p) => p.path)).not.toContain("memory/people.md");
    const argv = (await box.argvOf("claude"))[0]!;
    expect(argv.join(" ")).toContain("30600");
    expect(argv.join(" ")).not.toContain(SECRET);
    expect(model.prompts).toEqual([]);
  }, 60_000);

  test("D-181: a cloud ask goes on with the filter alone and says so, every time; a named empty judge changes nothing about that", async () => {
    const box = await withNeedle();
    const model = ollama("x");
    for (const _ of [1, 2]) {
      const result = await box.run(ask(box.agent, "dashboard", "--backend", "claude,ollama", "--model", "ollama=stub"), model.url);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).backend).toBe("claude");
      expect(result.stderr.split("\n").filter((line) => line.startsWith("mind: warning: only the filter screened this"))).toHaveLength(1);
    }
    // No local model was configured, so the judge was not asked and the local ollama answered nothing.
    expect(model.prompts).toEqual([]);
  }, 60_000);

  test("when every piece is held, the cloud CLI is not asked at all and the local model answers from them", async () => {
    const box = await withNeedle();
    const model = ollama("It goes to the person in memory/people.md.");
    const result = await box.run(ask(box.agent, "invoice", "--backend", "claude,ollama", "--model", "ollama=stub"), model.url);
    expect(result.code, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as AskOut;
    expect(out.backend).toBe("ollama");
    expect(out.sources.map((s) => s.path)).toEqual(["memory/people.md"]);
    expect(await box.argvOf("claude")).toEqual([]);
    expect(model.systems[0]).toContain(SECRET);
    // Only the backend handed the question has a line.
    expect((await box.ledger()).map((l) => l["backend"])).toEqual(["ollama"]);
  }, 60_000);
});
