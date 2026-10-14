/**
 * D-056 through the binary: `mind setup` with its answers piped in creates
 * an agent, writes the soul it was told, checks it, runs one turn against a
 * stub Ollama — and raises no level and enables no capture.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barePath, BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");

const scratch: string[] = [];
const servers: { stop: (force: boolean) => void }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

function stubOllama(models: readonly string[] = ["stub"]) {
  const systems: string[] = [];
  const used: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/api/tags") return Response.json({ models: models.map((name) => ({ name })) });
      const body = (await req.json()) as { model?: string; messages: { role: string; content: string }[] };
      used.push(body.model ?? "");
      systems.push(body.messages.find((m) => m.role === "system")?.content ?? "");
      return Response.json({ message: { content: "I am helper, an AI agent, not a human." } });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, systems, used };
}

/**
 * `holdOpen`: stdin is a pipe that is written and never closed, which is what a terminal is to the process: the
 * answers arrive and no end-of-file follows. A run that only returns when it is killed is the B2 of the stranger run.
 */
async function setupRun(answers: readonly string[], ollama: string, extra: readonly string[] = [], extraEnv: Record<string, string> = {}, holdOpen = false) {
  const home = await mkdtemp(join(tmpdir(), "mind-setup-"));
  scratch.push(home);
  await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Test\n\temail = t@example.invalid\n");
  // `new` runs `git init`; no vendor CLI is on this PATH, so the first turn defaults to ollama.
  const path = await barePath(home);
  await symlink(Bun.which("git")!, join(home, "bare-bin", "git"));
  const child = Bun.spawn([BUN, "run", BIN, "setup", ...extra], {
    cwd: ROOT,
    env: {
      HOME: home,
      USER: "tester",
      PATH: path,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      OLLAMA_HOST: ollama,
      ...extraEnv,
    },
    stdin: holdOpen ? "pipe" : new TextEncoder().encode(answers.map((a) => `${a}\n`).join("")),
    stdout: "pipe",
    stderr: "pipe",
  });
  let hung = false;
  if (holdOpen) {
    const sink = child.stdin as unknown as { write(text: string): number; flush(): Promise<number> | number };
    sink.write(answers.map((a) => `${a}\n`).join(""));
    await sink.flush();
    const timer = setTimeout(() => {
      hung = true;
      child.kill();
    }, 30_000);
    child.exited.finally(() => clearTimeout(timer));
  }
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { home, code: child.exitCode ?? -1, stdout, stderr, hung };
}

describe("mind setup", () => {
  test("creates the agent, writes the answers into its soul, and runs a first turn", async () => {
    const ollama = stubOllama();
    // name · subject · parent · role · does · does-not · address · backend · model
    const run = await setupRun(
      ["helper", "", "~/agents", "answers questions about this server", "", "restarts services", "ที่รัก", "", ""],
      ollama.url,
    );

    expect(run.code, run.stderr).toBe(0);
    const dir = join(run.home, "agents", "helper");
    const role = await Bun.file(join(dir, "soul", "role.md")).text();
    const person = await Bun.file(join(dir, "soul", "person.md")).text();
    expect(role).toContain('subject = "tester"');
    expect(role).toContain('role = "answers questions about this server"');
    expect(role).toContain('does = "answers questions about this server"');
    expect(role).toContain('does_not = "restarts services"');
    expect(person).toContain('addresses_user_as = "ที่รัก"');

    expect(ollama.systems).toHaveLength(1);
    expect(ollama.systems[0]).toContain("answers questions about this server");
    expect(run.stdout).toContain("I am helper, an AI agent, not a human.");
    expect(run.stdout).toContain("git add soul && git commit");

    // Nothing raised, nothing enabled.
    expect(await Bun.file(join(dir, "soul", "autonomy.md")).exists()).toBe(false);
    expect(await Bun.file(join(run.home, "data", "mind", "tester", "personal", "consent.json")).exists()).toBe(false);
  }, 60_000);

  test("it says where the egress judge stands and where the needles are listed, so an agent is not left thinking it is protected (D-181)", async () => {
    const ollama = stubOllama();
    const answers = ["helper", "", "~/agents", "answers questions about this server", "", "restarts services", "ที่รัก", "", ""];
    const none = await setupRun(answers, ollama.url, ["--no-turn"]);
    expect(none.code, none.stderr).toBe(0);
    expect(none.stdout).toContain("egress judge: off — no local model is configured");
    expect(none.stdout).toContain("mind egress needles --subject tester");

    // A local model that runs here makes the judge automatic; a new agent has listed nothing for it to read against.
    const automatic = await setupRun(answers, ollama.url, ["--no-turn"], { MIND_OLLAMA_MODEL: "stub" });
    expect(automatic.code, automatic.stderr).toBe(0);
    expect(automatic.stdout).toContain(`egress judge: on by itself (MIND_OLLAMA_MODEL) — stub at ${ollama.url}; idle: no needles are listed`);
  }, 120_000);

  test("a bad answer is asked again, and --no-turn sends nothing", async () => {
    const ollama = stubOllama();
    const run = await setupRun(
      ["bad name!", "helper", "Bad Subject", "someone", "", "keeps notes", "", "", ""],
      ollama.url,
      ["--no-turn"],
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("letters, digits, '.', '_' and '-'");
    expect(run.stdout).toContain("lower-case letters, digits, '_' and '-', up to 64");
    expect(await Bun.file(join(run.home, "agents", "helper", "soul", "role.md")).text()).toContain('subject = "someone"');
    expect(ollama.systems).toHaveLength(0);
  }, 60_000);

  test("running out of answers stops before anything is created", async () => {
    const run = await setupRun(["helper", "tester", ""], "http://127.0.0.1:9");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("ran out of input");
    expect(await Bun.file(join(run.home, "agents", "helper", "soul", "role.md")).exists()).toBe(false);
  }, 60_000);

  test("it returns by itself when stdin stays open after the last answer, as a terminal's does (B2)", async () => {
    const ollama = stubOllama();
    const run = await setupRun(
      ["helper", "", "~/agents", "answers questions about this server", "", "restarts services", "ที่รัก", "", ""],
      ollama.url,
      ["--no-turn"],
      {},
      true,
    );
    expect(run.hung, "the process only ended because the test killed it").toBe(false);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("Done.");
  }, 60_000);

  test("with a first turn too, the process still ends by itself and no answer is lost between questions (B2)", async () => {
    const ollama = stubOllama();
    const run = await setupRun(
      ["helper", "", "~/agents", "answers questions about this server", "", "restarts services", "ที่รัก", "", ""],
      ollama.url,
      [],
      {},
      true,
    );
    expect(run.hung).toBe(false);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("I am helper, an AI agent, not a human.");
  }, 60_000);

  test("Enter at the model question takes MIND_OLLAMA_MODEL when it is pulled, and the line says so (B3)", async () => {
    const ollama = stubOllama(["big-27b:latest", "small-4b:latest"]);
    const run = await setupRun(
      ["helper", "", "~/agents", "answers questions about this server", "", "restarts services", "ที่รัก", "", ""],
      ollama.url,
      [],
      { MIND_OLLAMA_MODEL: "small-4b:latest" },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("default model: small-4b:latest — MIND_OLLAMA_MODEL is set and that model is pulled");
    expect(ollama.used).toEqual(["small-4b:latest"]);
  }, 60_000);

  test("MIND_OLLAMA_MODEL naming a model that is not pulled falls back to the first, and says it did (B3)", async () => {
    const ollama = stubOllama(["big-27b:latest", "small-4b:latest"]);
    const run = await setupRun(
      ["helper", "", "~/agents", "answers questions about this server", "", "restarts services", "ที่รัก", "", ""],
      ollama.url,
      [],
      { MIND_OLLAMA_MODEL: "missing:1b" },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("default model: big-27b:latest — the first of 2 pulled models; MIND_OLLAMA_MODEL=missing:1b is not pulled");
    expect(ollama.used).toEqual(["big-27b:latest"]);
  }, 60_000);
});
