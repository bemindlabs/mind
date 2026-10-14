/** S6.5 through the binary (D-073): each task twice, graded from the answer, reported by kind. */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** An evals file under the given schema id. */
const evalSet = (schema: string) => `+++
schema = "${schema}"

[port]
kind = "ports"
ask = "Which port does the queue use?"
expect = ["10410"]

[incident]
kind = "incidents"
ask = "What broke on Tuesday?"
expect = ["disk full"]
reject = ["no idea"]
+++
`;

const SET = evalSet("mind/evals@1");

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "mind-eval-"));
  scratch.push(home);
  const agent = join(home, "agent");
  await cp(SOUL, join(agent, "soul"), { recursive: true });
  await writeFile(join(agent, "evals.md"), SET);
  const asked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/api/tags") return Response.json({ models: [{ name: "stub" }] });
      const body = (await req.json()) as { messages: { role: string; content: string }[] };
      const q = body.messages.at(-1)?.content ?? "";
      asked.push(q);
      return Response.json({ message: { content: q.includes("queue") ? "It listens on **10410**." : "no idea, sorry" } });
    },
  });
  servers.push(server);
  // A dead Qdrant: `memory index` below must never write into the machine's real one.
  const env = { HOME: home, PATH: await barePath(home), XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), OLLAMA_HOST: `http://127.0.0.1:${server.port}`, MIND_QDRANT_URL: "http://127.0.0.1:9", MIND_NO_UPDATE_CHECK: "1" };
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  return { home, agent, asked, run };
}

describe("mind eval", () => {
  test("every task in both configurations, graded from the answer, with the kinds it cannot do yet", async () => {
    const t = await setup();
    const out = await t.run(["eval", t.agent, "--subject", "example", "--backend", "ollama", "--model", "stub"]);
    expect(out.code, out.stderr).toBe(0);
    expect(t.asked).toHaveLength(4);
    expect(out.stdout).toContain("2 task(s) — S6.5 AC1 asks for at least 20");
    expect(out.stdout).toMatch(/soul\s+1\/2\s+50%/);
    expect(out.stdout).toContain("soul+rag+fine-tune");
    expect(out.stdout).toContain("Not yet replaceable (under half, in the best configuration): incidents");
    expect(out.stdout).toContain('missing "disk full"');
    const json = await t.run(["eval", t.agent, "--subject", "example", "--backend", "ollama", "--model", "stub", "--only", "port", "--json"]);
    const parsed = JSON.parse(json.stdout) as { report: { total: number; notYet: string[] }; results: { mode: string; pass: boolean }[] };
    expect(parsed.report.total).toBe(1);
    expect(parsed.results.map((r) => [r.mode, r.pass])).toEqual([["soul", true], ["soul+rag", true]]);
    // The turns are in the ledger like any other.
    expect((await t.run(["ledger", "show", "--subject", "example", "--content"])).stdout).toContain("Which port does the queue use?");
  }, 120_000);

  test("no set, a broken set, and wrong usage", async () => {
    const t = await setup();
    await rm(join(t.agent, "evals.md"));
    expect((await t.run(["eval", t.agent, "--subject", "example"])).code).toBe(1);
    await writeFile(join(t.agent, "evals.md"), '+++\nschema = "nope"\n+++\n');
    expect((await t.run(["eval", t.agent, "--subject", "example"])).stderr).toContain("schema must be");
    await writeFile(join(t.agent, "evals.md"), SET);
    for (const args of [["eval"], ["eval", t.agent], ["eval", t.agent, "--subject", "example", "--only", "missing"]]) {
      expect((await t.run(args)).code, args.join(" ")).toBe(2);
    }
  }, 60_000);

  test("--recall-only asks no model: is the answer in what recall would attach?", async () => {
    const t = await setup();
    await Bun.write(join(t.agent, "memory", "queue.md"), "# Queue\n\nThe queue listens on port 10410 since the move.\n");
    const idx = await t.run(["memory", "index", t.agent, "--subject", "example"]);
    expect(idx.code, idx.stderr).toBe(0);
    const out = await t.run(["eval", t.agent, "--subject", "example", "--recall-only"]);
    expect(out.code, out.stderr).toBe(0);
    expect(t.asked).toEqual([]);
    expect(out.stdout).toMatch(/hit\s+port/);
    expect(out.stdout).toMatch(/MISS incident\s+.*missing "disk full"/);
    expect(out.stdout).toContain("recall attached the answer for 1/2 (50%) — no model asked");
    const json = JSON.parse((await t.run(["eval", t.agent, "--subject", "example", "--recall-only", "--json"])).stdout) as { hits: number };
    expect(json.hits).toBe(1);
    expect((await t.run(["eval", t.agent, "--subject", "example", "--recall-chars", "-1"])).code).toBe(2);
  }, 60_000);
});

