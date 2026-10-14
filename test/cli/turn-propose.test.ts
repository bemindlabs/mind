/**
 * S5.2 AC1 through the binary (D-045): at level 1 the model is told to
 * propose, what it proposes is filed, a refused one is not filed again, and
 * at level 2 the instruction is not sent at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROPOSAL_FENCE } from "../../src/decide/agent-proposal.ts";
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

/** A stub ollama that proposes when told to, and records the system prompt. */
function proposingOllama(answer: string) {
  const systems: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "stub" }] });
      const body = (await req.json()) as { messages: { role: string; content: string }[] };
      systems.push(body.messages.find((m) => m.role === "system")?.content ?? "");
      return Response.json({ message: { content: answer } });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, systems };
}

async function setup(ollama: string) {
  const home = await mkdtemp(join(tmpdir(), "mind-turn-propose-"));
  scratch.push(home);
  const soul = join(home, "agent", "soul");
  await cp(SOUL, soul, { recursive: true });
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
  return { soul, run };
}

const ANSWER =
  "I would restart it.\n```" + PROPOSAL_FENCE + "\n" +
  '{"what": "restart the dashboard", "why": "it stopped answering", "impact": "30 seconds of downtime"}' +
  "\n```\n";

const turn = (soul: string, ...extra: string[]) => [
  "turn", soul, "--subject", "example", "--backend", "ollama", "--model", "stub", "--prompt", "fix the dashboard", ...extra,
];

describe("level 1 proposes instead of acting", () => {
  test("the instruction is sent, the block is filed as the agent's, and --json lists it", async () => {
    const ollama = proposingOllama(ANSWER);
    const { soul, run } = await setup(ollama.url);

    const result = await run(turn(soul, "--json"));

    expect(result.code, result.stderr).toBe(0);
    expect(ollama.systems[0]).toContain("Acting level: 1 — propose");
    expect(result.stderr).toMatch(/proposal [0-9a-f-]{36} filed by the agent: restart the dashboard/);
    expect(result.stderr).toContain("nothing was done");
    const json = JSON.parse(result.stdout) as { proposals: { outcome: string; id: string }[] };
    expect(json.proposals.map((p) => p.outcome)).toEqual(["filed"]);

    const list = await run(["proposal", "list", soul, "--subject", "example"]);
    expect(list.stdout).toContain("restart the dashboard  (filed by the agent)");
  }, 60_000);

  test("a refused proposal is not filed again by the next turn (AC2 holds for the agent too)", async () => {
    const ollama = proposingOllama(ANSWER);
    const { soul, run } = await setup(ollama.url);
    const first = JSON.parse((await run(turn(soul, "--json"))).stdout) as { proposals: { id: string }[] };
    const id = first.proposals[0]!.id;
    const refused = await run(["proposal", "decide", id, soul, "--subject", "example", "--refuse"]);
    expect(refused.code, refused.stderr).toBe(0);

    const again = await run(turn(soul, "--json"));

    expect(again.stderr).toContain(`not filed — already asked (${id})`);
    const json = JSON.parse(again.stdout) as { proposals: { outcome: string }[] };
    expect(json.proposals.map((p) => p.outcome)).toEqual(["already-asked"]);
  }, 60_000);

  test("--no-proposals files nothing — a measurement leaves no work in the owner's list", async () => {
    // `mind eval` runs every task at level 1; before this flag each answer that proposed
    // something filed it, so measuring an agent put questions in front of its owner.
    const ollama = proposingOllama(ANSWER);
    const { soul, run } = await setup(ollama.url);
    const result = await run(turn(soul, "--json", "--no-proposals"));
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as { proposals: unknown[] };
    expect(json.proposals).toEqual([]);
    const list = await run(["proposal", "list", soul, "--subject", "example"]);
    expect(list.stdout).not.toContain("filed by the agent");
  }, 60_000);

  test("an unreadable block is said, and nothing is filed for it", async () => {
    const ollama = proposingOllama("```" + PROPOSAL_FENCE + '\n{"what": "only this"}\n```');
    const { soul, run } = await setup(ollama.url);
    const result = await run(turn(soul));
    expect(result.stderr).toContain("could not be read (it needs what, why and impact)");
    const list = await run(["proposal", "list", soul, "--subject", "example"]);
    expect(list.stdout).not.toContain("filed by the agent");
  }, 60_000);

  test("at level 2 the instruction is not sent and blocks are not filed", async () => {
    const ollama = proposingOllama(ANSWER);
    const { soul, run } = await setup(ollama.url);
    for (const category of ["write", "run", "reach"]) {
      expect((await run(["autonomy", "set", category, "2", soul, "--subject", "example"])).code).toBe(0);
    }
    const result = await run(turn(soul, "--json"));
    expect(ollama.systems[0]).not.toContain("Acting level: 1");
    expect((JSON.parse(result.stdout) as { proposals: unknown[] }).proposals).toEqual([]);
  }, 60_000);
});

describe("D-149: a backend with no tools does not get to look as if it acted", () => {
  // Measured 2026-10-04 (D-149 e2e): asked at level 2 to create a file, a real
  // model behind ollama answered "done", the turn exited 0, and the only sign
  // that nothing happened was D-043's "nothing" changed.
  test("at level 2 an answer from ollama is said to be words only", async () => {
    const ollama = proposingOllama("done");
    const { soul, run } = await setup(ollama.url);
    for (const category of ["write", "run", "reach"]) {
      expect((await run(["autonomy", "set", category, "2", soul, "--subject", "example"])).code).toBe(0);
    }
    const result = await run(turn(soul));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("done");
    expect(result.stderr).toContain("ollama has no tools — it answered in words and could not act");
  }, 60_000);

  test("--json carries the same note, so the page and the app see it without reading stderr", async () => {
    const ollama = proposingOllama("done");
    const { soul, run } = await setup(ollama.url);
    for (const category of ["write", "run", "reach"]) {
      expect((await run(["autonomy", "set", category, "2", soul, "--subject", "example"])).code).toBe(0);
    }
    const two = JSON.parse((await run(turn(soul, "--json"))).stdout) as { notes: string[] };
    expect(two.notes).toEqual([expect.stringContaining("ollama has no tools")]);
    expect(((await run(["autonomy", "set", "reach", "1", soul, "--subject", "example"])).code)).toBe(0);
    const one = JSON.parse((await run(turn(soul, "--json"))).stdout) as { notes: string[] };
    expect(one.notes).toEqual([]);
  }, 60_000);

  test("at level 1 it is not said: nothing was allowed, so nothing is missing", async () => {
    const ollama = proposingOllama("done");
    const { soul, run } = await setup(ollama.url);
    const result = await run(turn(soul));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("has no tools");
  }, 60_000);
});
