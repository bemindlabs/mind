/**
 * D-093 through the binary: draft against a stub local model, the invented fact cut, the draft kept in
 * personal/, decide, and adopt writing only the yes into memory/knowledge/facts/.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

function stubModel() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.json();
      return Response.json({
        message: {
          content: JSON.stringify([
            { fact: "vLLM listens on port 10410.", quote: "vLLM listens on 127.0.0.1:10410", topic: "ports" },
            { fact: "Backups run at 03:00.", quote: "backups run at three in the morning", topic: "backups" },
          ]),
        },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function setup(basis: boolean) {
  const home = await mkdtemp(join(tmpdir(), "mind-distill-"));
  scratch.push(home);
  const agent = join(home, "agent");
  await mkdir(join(agent, "memory", "knowledge"), { recursive: true });
  await writeFile(join(agent, "memory", "knowledge", "vllm.md"), "# vLLM\n\nvLLM listens on 127.0.0.1:10410.\n");
  await writeFile(join(agent, "memory", "diary.md"), "# Diary\n\nA good day.\n");
  if (basis) {
    await mkdir(join(home, "state", "mind", "basis", "example"), { recursive: true });
    await writeFile(join(home, "state", "mind", "basis", "example", "records.json"), JSON.stringify([{ id: "b1", subject: "example", basis: "owner", approvedBy: "test", at: "2026-09-26T00:00:00Z", uses: ["memory"], expires: null, note: "", revokedAt: null }]));
  }
  const env = { HOME: home, PATH: await barePath(home), XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), OLLAMA_HOST: stubModel(), MIND_NO_UPDATE_CHECK: "1", MIND_QDRANT_URL: "http://127.0.0.1:9" };
  const run = async (args: readonly string[], extra: Record<string, string> = {}) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  return { home, agent, run };
}

describe("mind memory distill", () => {
  test("draft → show → decide → adopt: the invented fact is cut, only a yes is written", async () => {
    const t = await setup(true);
    const d = await t.run(["memory", "distill", t.agent, "--subject", "example", "--model", "stub"]);
    expect(d.code, d.stderr).toBe(0);
    expect(d.stdout).toContain("1 fact(s) drafted, each quoting its note · 1 cut");
    expect(d.stderr).toContain("1 memory file(s)");
    expect(await readdir(join(t.home, "data", "mind", "example", "personal", "knowledge"))).toHaveLength(1);
    const shown = JSON.parse((await t.run(["memory", "distill", "show", "--subject", "example", "--json"])).stdout) as { draft: { facts: { id: string; fact: string }[] } };
    expect(shown.draft.facts.map((f) => f.fact)).toEqual(["vLLM listens on port 10410."]);
    const id = shown.draft.facts[0]!.id;
    expect((await t.run(["memory", "distill", "adopt", t.agent, "--subject", "example"])).stdout).toContain("nothing to add");
    expect((await t.run(["memory", "distill", "decide", id, "--subject", "example", "--yes"])).code).toBe(0);
    const plan = await t.run(["memory", "distill", "adopt", t.agent, "--subject", "example"]);
    expect(plan.stdout).toContain("new memory/knowledge/facts/ports.md · +1 fact(s)");
    expect(await Bun.file(join(t.agent, "memory", "knowledge", "facts", "ports.md")).exists()).toBe(false);
    const wet = await t.run(["memory", "distill", "adopt", t.agent, "--subject", "example", "--yes"]);
    expect(wet.code, wet.stderr).toBe(0);
    expect(await Bun.file(join(t.agent, "memory", "knowledge", "facts", "ports.md")).text()).toContain("- vLLM listens on port 10410. — `memory/knowledge/vllm.md:3`");
    // A second draft does not read the facts already written.
    const again = await t.run(["memory", "distill", t.agent, "--subject", "example", "--model", "stub"]);
    expect(again.stderr).toContain("1 memory file(s)");
    expect((await t.run(["memory", "distill", "decide", "ffffffff", "--subject", "example", "--no"])).code).toBe(1);
    expect((await t.run(["memory", "distill", "decide", id, "--subject", "example"])).code).toBe(2);
  }, 60_000);

  test("no basis, a model not on this machine, nothing to read, or no draft: refused, nothing kept", async () => {
    const none = await setup(false);
    expect((await none.run(["memory", "distill", none.agent, "--subject", "example", "--model", "stub"])).stderr).toContain("no basis");
    const t = await setup(true);
    expect((await t.run(["memory", "distill", t.agent, "--subject", "example", "--model", "stub"], { OLLAMA_HOST: "http://10.0.0.5:11434" })).stderr).toContain("not a loopback address");
    expect((await t.run(["memory", "distill", t.agent, "--subject", "example", "--model", "stub", "--from", "memory/nowhere"])).stderr).toContain("no memory under memory/nowhere");
    expect((await t.run(["memory", "distill", "show", "--subject", "example"])).code).toBe(1);
    expect(JSON.parse((await t.run(["memory", "distill", "show", "--subject", "example", "--json"])).stdout)).toMatchObject({ draft: null });
    expect((await t.run(["memory", "distill", t.agent, "--subject", "example"], { MIND_OLLAMA_MODEL: "" })).code).toBe(2);
    expect((await t.run(["memory", "distill"])).code).toBe(2);
  }, 60_000);
});
