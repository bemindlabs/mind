/**
 * S5.3 through the binary (D-054): a due trigger runs as a turn held at level
 * 1 whatever the dial says, fires once per window, never under the brake, and
 * `schedule` prints what the OS would run and installs nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STOP_FILE } from "../../src/decide/stop.ts";
import { firedPath, readFired, triggersDirFor } from "../../src/decide/triggers.ts";
import { stateRoot } from "../../src/state.ts";
import { subjectId } from "../../src/types.ts";
import { barePath, BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");

const scratch: string[] = [];
const servers: { stop: (force: boolean) => void }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A stub ollama that records every system prompt it is sent. */
function stubOllama(onPrompt: (prompt: string) => Promise<Response | undefined> | Response | undefined = () => undefined) {
  const systems: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/api/tags") return Response.json({ models: [{ name: "stub" }] });
      const body = (await req.json()) as { messages: { role: string; content: string }[] };
      systems.push(body.messages.find((m) => m.role === "system")?.content ?? "");
      const answered = await onPrompt(body.messages.find((m) => m.role === "user")?.content ?? "");
      return answered ?? Response.json({ message: { content: "Nothing to propose today." } });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, systems };
}

/** A triggers file under the given schema id. */
const triggersFile = (schema: string) => `+++
schema = "${schema}"

[daily-look]
every = "1d"
prompt = "Look around and propose one thing."
+++
`;

const TRIGGERS = triggersFile("mind/triggers@1");

async function setup(ollama: string, triggers: string | null = TRIGGERS) {
  const home = await mkdtemp(join(tmpdir(), "mind-triggers-"));
  scratch.push(home);
  const soul = join(home, "agent", "soul");
  await cp(SOUL, soul, { recursive: true });
  if (triggers !== null) await writeFile(join(soul, "triggers.md"), triggers);
  const env = {
    HOME: home,
    PATH: await barePath(home),
    XDG_STATE_HOME: join(home, "state"),
    XDG_DATA_HOME: join(home, "data"),
    OLLAMA_HOST: ollama,
  };
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  const fired = () => readFired(firedPath(soul, triggersDirFor({ home, env }, subjectId("example"))));
  return { home, env, soul, run, fired };
}

const tick = (soul: string) => ["triggers", "tick", soul, "--subject", "example", "--backend", "ollama", "--model", "stub"];

describe("a due trigger is a turn held at level 1", () => {
  test("the dial at 2 still yields a proposing turn, and the fire time is recorded (AC2, AC6)", async () => {
    const ollama = stubOllama();
    const { soul, run, fired } = await setup(ollama.url);
    for (const category of ["write", "run", "reach"]) {
      expect((await run(["autonomy", "set", category, "2", soul, "--subject", "example"])).code).toBe(0);
    }

    const result = await run(tick(soul));

    expect(result.code, result.stderr).toBe(0);
    expect(ollama.systems).toHaveLength(1);
    expect(ollama.systems[0]).toContain("Acting level: 1 — propose");
    expect(result.stderr).toContain("trigger daily-look (every 1d) — a turn held at level 1");
    expect(Object.keys(await fired())).toEqual(["daily-look"]);

    const ledger = await run(["ledger", "show", "--subject", "example"]);
    expect(ledger.stdout).toContain("ollama");
  }, 60_000);

  test("a second tick inside the window runs nothing (AC5)", async () => {
    const ollama = stubOllama();
    const { soul, run } = await setup(ollama.url);
    expect((await run(tick(soul))).code).toBe(0);

    const again = await run(tick(soul));

    expect(again.code).toBe(0);
    expect(again.stdout).toContain("nothing is due");
    expect(ollama.systems).toHaveLength(1);
  }, 60_000);
});

const TWO = `+++
schema = "mind/triggers@1"

[first]
every = "1h"
prompt = "first: this one breaks"

[second]
every = "1h"
prompt = "second: this one is fine"
+++
`;

describe("one trigger does not decide for the others", () => {
  test("a failing turn does not stop the next; the tick says so with exit 1 (AC5)", async () => {
    const ollama = stubOllama((prompt) => (prompt.startsWith("first") ? new Response("boom", { status: 500 }) : undefined));
    const { soul, run, fired } = await setup(ollama.url, TWO);

    const result = await run(tick(soul));

    expect(result.code).toBe(1);
    expect(ollama.systems).toHaveLength(2);
    expect(Object.keys(await fired()).sort()).toEqual(["first", "second"]);
  }, 60_000);

  test("a brake set mid-tick stops the rest, and the refused one is not counted as fired (AC3)", async () => {
    let brake: () => Promise<void> = async () => {};
    const ollama = stubOllama(async (prompt) => {
      if (prompt.startsWith("first")) await brake();
      return undefined;
    });
    const { home, env, soul, run, fired } = await setup(ollama.url, TWO);
    brake = async () => {
      await mkdir(stateRoot(home, env), { recursive: true });
      await writeFile(join(stateRoot(home, env), STOP_FILE), "");
    };

    const result = await run(tick(soul));

    expect(result.code).toBe(4);
    expect(result.stderr).toContain("trigger second was refused by the dial or the brake");
    expect(ollama.systems).toHaveLength(1);
    expect(Object.keys(await fired())).toEqual(["first"]);
  }, 60_000);
});

describe("the brake", () => {
  test("nothing runs and nothing is marked as fired (AC3)", async () => {
    const ollama = stubOllama();
    const { home, env, soul, run, fired } = await setup(ollama.url);
    await mkdir(stateRoot(home, env), { recursive: true });
    await writeFile(join(stateRoot(home, env), STOP_FILE), "");

    const result = await run(tick(soul));

    expect(result.code).toBe(4);
    expect(result.stderr).toContain("no trigger ran");
    expect(ollama.systems).toHaveLength(0);
    expect(await fired()).toEqual({});
  }, 60_000);
});

describe("show, schedule and a bad file", () => {
  test("show lists each trigger, and with no file prints an example", async () => {
    const { soul, run } = await setup("http://127.0.0.1:9");
    const shown = await run(["triggers", "show", soul, "--subject", "example"]);
    expect(shown.stdout).toContain("daily-look");
    expect(shown.stdout).toContain("due now");

    const bare = await setup("http://127.0.0.1:9", null);
    const none = await bare.run(["triggers", "show", bare.soul, "--subject", "example"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("nothing runs by itself");
  }, 60_000);

  test("schedule prints a timer and a cron line and installs nothing (AC4)", async () => {
    const { home, soul, run } = await setup("http://127.0.0.1:9");
    const result = await run(["triggers", "schedule", soul, "--subject", "example", "--every", "15m"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("OnUnitActiveSec=15min");
    expect(result.stdout).toContain("*/15 * * * *");
    expect(result.stdout).toContain("'triggers' 'tick'");
    expect(result.stdout).toContain("Nothing was installed");
    expect(await Bun.file(join(home, ".config", "systemd")).exists()).toBe(false);

    expect((await run(["triggers", "schedule", soul, "--subject", "example", "--every", "90m"])).code).toBe(2);
  }, 60_000);

  test("a trigger file with an error is refused with its line, and tick runs nothing", async () => {
    const ollama = stubOllama();
    const { soul, run } = await setup(ollama.url, TRIGGERS.replace('every = "1d"', 'every = "1s"'));
    const result = await run(tick(soul));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("triggers.md:5");
    expect(ollama.systems).toHaveLength(0);
  }, 60_000);
});
