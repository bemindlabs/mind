/**
 * S8.3 through the binary (D-048): a prompt carrying a needle is not handed to
 * a cloud vendor, the chain falls through to the local model, and the record
 * says which rule — never the text.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeWarning, JUDGE_WARNING_PREFIX } from "../../src/egress/judge-mode.ts";
import { barePath, BUN } from "../support/bare-path.ts";
import { serveOllama, type StubOllama } from "../support/stub-ollama.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const SECRET = "Wanida Srisuk";

const scratch: string[] = [];
const stubs: StubOllama[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) s.server.stop(true);
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "mind-turn-egress-"));
  scratch.push(home);
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  // A claude that leaves a mark if it is ever run.
  await Bun.write(
    join(bin, "claude"),
    `#!/usr/bin/env bun\nrequire("node:fs").writeFileSync(process.env.HOME + "/claude-was-called", process.argv.join(" "));\nconsole.log(JSON.stringify({ result: "from claude" }));\n`,
  );
  await chmod(join(bin, "claude"), 0o755);
  const ollama = serveOllama();
  stubs.push(ollama);
  const env = {
    HOME: home,
    PATH: `${bin}:${await barePath(home)}`,
    XDG_STATE_HOME: join(home, "state"),
    XDG_DATA_HOME: join(home, "data"),
    // Nothing listens on port 9: no test turn writes a collection into this machine's real Qdrant.
    MIND_QDRANT_URL: "http://127.0.0.1:9",
    OLLAMA_HOST: ollama.url,
  };
  const run = async (args: readonly string[], extraEnv: Record<string, string> = {}) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  return { home, run, ollama };
}

const turn = (prompt: string) => [
  "turn", SOUL, "--subject", "example", "--backend", "claude,ollama", "--model", "stub", "--no-recall", "--prompt", prompt,
];

describe("S8.3 — personal data does not leave through a turn", () => {
  test("a needle keeps the prompt from claude; the local model answers; the record has no text", async () => {
    const { home, run, ollama } = await setup();
    const where = await run(["egress", "needles", "--subject", "example"]);
    const needles = where.stdout.split("\n")[0]!;
    await mkdir(join(needles, ".."), { recursive: true });
    await Bun.write(needles, `# mine\n${SECRET}\n`);

    const result = await run(turn(`token t1 — write to ${SECRET} about the invoice`));

    expect(result.code, result.stderr).toBe(0);
    expect(await Bun.file(join(home, "claude-was-called")).exists()).toBe(false);
    expect(result.stderr).toContain("not sent to claude");
    expect(result.stderr).toContain("personal needle #1");
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stdout).toContain("from ollama");
    expect(ollama.prompts[0]).toContain(SECRET);

    const log = await run(["egress", "log", "--subject", "example"]);
    expect(log.stdout).toContain("claude");
    expect(log.stdout).toContain("personal needle #1");
    expect(log.stdout).not.toContain(SECRET);
  }, 60_000);

  test("the control: a clean prompt goes to claude as before", async () => {
    const { home, run } = await setup();
    const result = await run(turn("token t2 — how do I close the month?"));
    expect(result.stdout).toContain("from claude");
    expect(await Bun.file(join(home, "claude-was-called")).exists()).toBe(true);
    expect((await run(["egress", "log", "--subject", "example"])).stdout).toContain("nothing has been kept in");
  }, 60_000);

  test("a shape needs no needle: a phone number keeps the prompt in", async () => {
    const { home, run } = await setup();
    const result = await run(turn("token t3 — call 081-234-5678"));
    expect(result.stderr).toContain("thai-phone");
    expect(await Bun.file(join(home, "claude-was-called")).exists()).toBe(false);
  }, 60_000);

  test("egress check and needles, from the command line", async () => {
    const { run } = await setup();
    expect((await run(["egress", "check", "--subject", "example", "a@b.co"])).code).toBe(1);
    expect((await run(["egress", "check", "--subject", "example", "nothing here"])).code).toBe(0);
    expect((await run(["egress", "needles", "--subject", "example"])).stdout).toContain("no needles file yet");
    for (const args of [["egress"], ["egress", "check"], ["egress", "log"], ["egress", "wat"]]) {
      expect((await run(args)).code, args.join(" ")).toBe(2);
    }
  }, 60_000);

  test("D-071: the judge reads the question, not the soul — so a soul it would flag does not keep a clean turn in", async () => {
    const { home, run } = await setup();
    const where = await run(["egress", "needles", "--subject", "example"]);
    const needles = where.stdout.split("\n")[0]!;
    await mkdir(join(needles, ".."), { recursive: true });
    await Bun.write(needles, `${SECRET}\n`);
    // A judge that calls anything carrying the fixture's name revealing.
    const judge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { messages: { role: string; content: string }[] };
        const text = body.messages.at(-1)?.content ?? "";
        return Response.json({ message: { content: JSON.stringify({ reveals: text.includes("Example Keeper") }) } });
      },
    });
    try {
      const child = Bun.spawn([BUN, "run", BIN, ...turn("token t5 — how do I close the month?")], {
        cwd: ROOT,
        env: { HOME: home, PATH: `${join(home, "bin")}:${await barePath(home)}`, XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), MIND_QDRANT_URL: "http://127.0.0.1:9", OLLAMA_HOST: `http://127.0.0.1:${judge.port}`, MIND_EGRESS_JUDGE: "stub" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(child.stdout).text();
      await child.exited;
      expect(stdout).toContain("from claude");
      expect(await Bun.file(join(home, "claude-was-called")).exists()).toBe(true);
    } finally {
      judge.stop(true);
    }
  }, 60_000);

  test("D-095: an earlier message with a needle stays on this machine; claude still answers, with the rest", async () => {
    const { home, run } = await setup();
    const where = await run(["egress", "needles", "--subject", "example"]);
    const needles = where.stdout.split("\n")[0]!;
    await mkdir(join(needles, ".."), { recursive: true });
    await Bun.write(needles, `${SECRET}\n`);
    const history = JSON.stringify([
      { role: "you", text: `I am ${SECRET}` },
      { role: "agent", text: "Noted." },
      { role: "you", text: "Which port does the vault use?" },
      { role: "agent", text: "The vault listens on 8200." },
    ]);
    const result = await run([...turn("token t6 — and restart it?"), "--history-json", history]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("from claude");
    const argv = await Bun.file(join(home, "claude-was-called")).text();
    expect(argv).toContain("The vault listens on 8200.");
    expect(argv).toContain("## This conversation so far");
    expect(argv).not.toContain(SECRET);
    expect(result.stderr).toContain("1 earlier message(s) stay on this machine");
    expect((await run([...turn("x"), "--history-json", "{not json"])).code).toBe(2);
  }, 60_000);

  test("D-095: a recalled note with a needle goes to the local model only; claude gets the clean notes, not the whole turn held back", async () => {
    const { home, run } = await setup();
    const where = await run(["egress", "needles", "--subject", "example"]);
    const needles = where.stdout.split("\n")[0]!;
    await mkdir(join(needles, ".."), { recursive: true });
    await Bun.write(needles, `${SECRET}\n`);
    const agent = join(home, "agent");
    await cp(SOUL, join(agent, "soul"), { recursive: true });
    await mkdir(join(agent, "memory"), { recursive: true });
    await Bun.write(join(agent, "memory", "vault.md"), "# Vault\n\nThe vault restarts with systemctl restart vault.\n");
    await Bun.write(join(agent, "memory", "owner.md"), `# Owner\n\nThe vault belongs to ${SECRET}.\n`);
    expect((await run(["memory", "index", agent, "--subject", "example"])).code).toBe(0);
    const result = await run(["turn", agent, "--subject", "example", "--backend", "claude,ollama", "--model", "stub", "--prompt", "token t7 — how do I restart the vault?"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("from claude");
    const argv = await Bun.file(join(home, "claude-was-called")).text();
    expect(argv).toContain("systemctl restart vault");
    expect(argv).not.toContain(SECRET);
    expect(result.stderr).toContain("1 piece(s) stay on this machine");
  }, 60_000);

  test("S12.4: --json says who answered, on whose machine, with the model and both held counts", async () => {
    const { home, run } = await setup();
    const where = await run(["egress", "needles", "--subject", "example"]);
    const needles = where.stdout.split("\n")[0]!;
    await mkdir(join(needles, ".."), { recursive: true });
    await Bun.write(needles, `${SECRET}\n`);
    const agent = join(home, "agent");
    await cp(SOUL, join(agent, "soul"), { recursive: true });
    await mkdir(join(agent, "memory"), { recursive: true });
    await Bun.write(join(agent, "memory", "vault.md"), "# Vault\n\nThe vault restarts with systemctl restart vault.\n");
    await Bun.write(join(agent, "memory", "owner.md"), `# Owner\n\nThe vault belongs to ${SECRET}.\n`);
    expect((await run(["memory", "index", agent, "--subject", "example"])).code).toBe(0);
    const history = JSON.stringify([
      { role: "you", text: `I am ${SECRET}` },
      { role: "agent", text: "Noted." },
    ]);
    const result = await run([
      "turn", agent, "--subject", "example", "--backend", "claude,ollama", "--model", "stub",
      "--prompt", "token t8 — how do I restart the vault?", "--history-json", history, "--json",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("from claude");
    const parsed = JSON.parse(result.stdout) as {
      backend: string;
      local: boolean;
      model: string | null;
      held: number;
      heldMessages: number;
      changed: unknown;
    };
    // claude is a cloud backend: the badge says so, and the counts name what
    // stayed on this machine — one recalled piece and one earlier message.
    expect(parsed.backend).toBe("claude");
    expect(parsed.local).toBe(false);
    // `--model stub` went to ollama, which did not answer; claude ran its own default and does not name it
    // (S15.9, PR #3 review L2 — this used to say "stub", a model claude was never given).
    expect(parsed.model).toBeNull();
    expect(parsed.held).toBe(1);
    expect(parsed.heldMessages).toBe(1);
    // Level 1 takes no snapshot, so there is no change report.
    expect(parsed.changed).toBeNull();
  }, 60_000);
});

describe("D-181 — a cloud-bound turn: the judge is automatic when a local model is configured, and said to be missing when it is not", () => {
  const PARAPHRASE = "token d1 — pass this to the bookkeeper whose name means young woman";
  const warnings = (stderr: string) => stderr.split("\n").filter((line) => line.includes(JUDGE_WARNING_PREFIX));

  async function withNeedle(run: Awaited<ReturnType<typeof setup>>["run"]) {
    const where = await run(["egress", "needles", "--subject", "example"]);
    const needles = where.stdout.split("\n")[0]!;
    await mkdir(join(needles, ".."), { recursive: true });
    await Bun.write(needles, `${SECRET}\n`);
  }

  /** The local model: a judge for the privacy question, an answerer for everything else; it keeps what the judge was asked. */
  function localModel(reveals: boolean) {
    const asked: { model: string; text: string }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "local-stub" }] });
        const body = (await req.json()) as { model: string; messages: { role: string; content: string }[] };
        const system = body.messages.find((m) => m.role === "system")?.content ?? "";
        const user = body.messages.at(-1)?.content ?? "";
        if (system.startsWith("You guard an owner's privacy")) {
          asked.push({ model: body.model, text: user.slice(user.indexOf("TEXT:\n") + "TEXT:\n".length) });
          return Response.json({ message: { content: JSON.stringify({ reveals }) } });
        }
        return Response.json({ message: { content: "from ollama (local)" } });
      },
    });
    return { asked, stop: () => server.stop(true), env: { MIND_OLLAMA_MODEL: "local-stub", OLLAMA_HOST: `http://127.0.0.1:${server.port}` } };
  }

  test("no judge named and no local model: each prompt that goes to claude is announced as screened by the filter alone, every time", async () => {
    const { home, run } = await setup();
    for (const token of ["d2", "d3"]) {
      const result = await run(turn(`token ${token} — how do I close the month?`));
      expect(result.stdout).toContain("from claude");
      expect(warnings(result.stderr)).toEqual([judgeWarning("en")]);
      expect(result.stderr.indexOf(JUDGE_WARNING_PREFIX)).toBeLessThan(result.stderr.indexOf("leaving this machine"));
      expect(/[฀-๿]/.test(result.stderr)).toBe(false);
    }
    expect(await Bun.file(join(home, "claude-was-called")).exists()).toBe(true);
  }, 60_000);

  test("a turn that never leaves this machine has nothing to warn about", async () => {
    const { run } = await setup();
    const result = await run(["turn", SOUL, "--subject", "example", "--backend", "ollama", "--model", "stub", "--no-recall", "--prompt", "token d4 — how do I close the month?"]);
    expect(result.stdout).toContain("from ollama");
    expect(warnings(result.stderr)).toEqual([]);
    expect(result.stderr).not.toContain("leaving this machine");
  }, 60_000);

  test("Thai is chosen: the English, then the Thai, on the one line", async () => {
    const { run } = await setup();
    const result = await run(turn("token d5 — how do I close the month?"), { MIND_LANG: "th" });
    expect(warnings(result.stderr)).toEqual([judgeWarning("th")]);
  }, 60_000);

  test("a local model is configured: the judge reads the prompt by itself, and a reveal keeps it from claude (no warning)", async () => {
    const { home, run } = await setup();
    await withNeedle(run);
    const model = localModel(true);
    try {
      const result = await run(turn(PARAPHRASE), model.env);
      expect(result.code, result.stderr).toBe(0);
      expect(model.asked.length).toBeGreaterThan(0);
      expect(new Set(model.asked.map((a) => a.model))).toEqual(new Set(["local-stub"]));
      expect(result.stderr).toContain("not sent to claude");
      expect(result.stderr).toContain("the local judge read it as revealing");
      expect(warnings(result.stderr)).toEqual([]);
      expect(await Bun.file(join(home, "claude-was-called")).exists()).toBe(false);
      expect(result.stdout).toContain("from ollama (local)");
    } finally {
      model.stop();
    }
  }, 60_000);

  test("a local model is configured and reads the prompt as clear: claude is handed it, and nothing is warned about", async () => {
    const { home, run } = await setup();
    await withNeedle(run);
    const model = localModel(false);
    try {
      const result = await run(turn(PARAPHRASE), model.env);
      expect(result.stdout).toContain("from claude");
      expect(model.asked.length).toBeGreaterThan(0);
      expect(warnings(result.stderr)).toEqual([]);
      expect(await Bun.file(join(home, "claude-was-called")).exists()).toBe(true);
    } finally {
      model.stop();
    }
  }, 60_000);

  test("an explicit empty MIND_EGRESS_JUDGE wins over a configured local model: the judge is not asked and the line is still said", async () => {
    const { home, run } = await setup();
    await withNeedle(run);
    const model = localModel(true);
    try {
      const result = await run(turn(PARAPHRASE), { ...model.env, MIND_EGRESS_JUDGE: "" });
      expect(model.asked).toEqual([]);
      expect(result.stdout).toContain("from claude");
      expect(warnings(result.stderr)).toEqual([judgeWarning("en")]);
      expect(await Bun.file(join(home, "claude-was-called")).exists()).toBe(true);
    } finally {
      model.stop();
    }
  }, 60_000);

  test("an explicit MIND_EGRESS_JUDGE names the model that is asked", async () => {
    const { run } = await setup();
    await withNeedle(run);
    const model = localModel(false);
    try {
      await run(turn(PARAPHRASE), { ...model.env, MIND_EGRESS_JUDGE: "named-guard" });
      expect(new Set(model.asked.map((a) => a.model))).toEqual(new Set(["named-guard"]));
    } finally {
      model.stop();
    }
  }, 60_000);

  test("a model the daemon relays to a hosted service is not made the judge: claude is handed the prompt, the line says what to fix, and the model is never asked", async () => {
    const { home, run } = await setup();
    await withNeedle(run);
    const model = localModel(true);
    try {
      const result = await run(turn(PARAPHRASE), { ...model.env, MIND_OLLAMA_MODEL: "gpt-oss:120b-cloud" });
      expect(model.asked).toEqual([]);
      expect(result.stdout).toContain("from claude");
      expect(warnings(result.stderr)).toEqual([judgeWarning("en", "local-model-not-local")]);
      expect(result.stderr.indexOf(JUDGE_WARNING_PREFIX)).toBeLessThan(result.stderr.indexOf("leaving this machine"));
      expect(await Bun.file(join(home, "claude-was-called")).exists()).toBe(true);
    } finally {
      model.stop();
    }
  }, 60_000);

  test("a host with no scheme: the line names the host, not a judge to set", async () => {
    const { run } = await setup();
    const result = await run(turn("token d9 — how do I close the month?"), { MIND_OLLAMA_MODEL: "qwen", OLLAMA_HOST: "127.0.0.1:11434" });
    expect(warnings(result.stderr)).toEqual([judgeWarning("en", "local-model-not-local")]);
    expect(warnings(result.stderr)[0]).toContain("OLLAMA_HOST must be a full URL on a loopback address");
  }, 60_000);

  test("egress check names the cause when a configured model is not a local one", async () => {
    const { run } = await setup();
    const cloud = await run(["egress", "check", "--subject", "example", "nothing here"], { MIND_OLLAMA_MODEL: "gpt-oss:120b-cloud" });
    expect(cloud.stdout).toContain("second layer: off — MIND_OLLAMA_MODEL is set but names no model on this machine");
    expect(cloud.stdout).toContain("-cloud or :cloud");
    expect(cloud.stdout).not.toContain("(or MIND_OLLAMA_MODEL) to have a model");
  }, 60_000);

  test("egress check says which it is: on by itself with a local model, off without", async () => {
    const { run } = await setup();
    const none = await run(["egress", "check", "--subject", "example", "nothing here"]);
    expect(none.stdout).toContain("second layer: off");
    expect(none.stdout).toContain("says so each time");
    const model = localModel(false);
    try {
      const on = await run(["egress", "check", "--subject", "example", "nothing here"], model.env);
      expect(on.stdout).toContain("second layer: on by itself (MIND_OLLAMA_MODEL) — local-stub");
      const off = await run(["egress", "check", "--subject", "example", "nothing here"], { ...model.env, MIND_EGRESS_JUDGE: "" });
      expect(off.stdout).toContain("second layer: off");
    } finally {
      model.stop();
    }
  }, 60_000);
});
