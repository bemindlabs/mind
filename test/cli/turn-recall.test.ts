/**
 * S4.3 — a turn carries what the agent remembers, and says what it carried
 * (D-039).
 *
 * The backend is a stub ollama that records the system message and the prompt
 * it was handed, so each claim is checked on what actually arrived: the
 * recalled piece is in the system message, the prompt is the one typed, the
 * ceiling holds, and every attached piece was named on stderr first.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RECALL_HEADING } from "../../src/memory/attach.ts";
import { barePath, BUN } from "../support/bare-path.ts";
import { serveOllama, type StubOllama } from "../support/stub-ollama.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const SUBJECT = "example";
const DEAD = "http://127.0.0.1:9";

const scratch: string[] = [];
const stubs: StubOllama[] = [];
afterEach(async () => {
  for (const stub of stubs.splice(0)) stub.server.stop(true);
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-turn-recall-"));
  scratch.push(dir);
  return dir;
}

const MEMORY: Record<string, string> = {
  "memory/infra.md":
    "# Ports\n\nThe second-brain dashboard listens on port 30600, tailnet only.\n\n" +
    "# ราคา\n\nแจ้งราคาทองทุกเช้าเวลา 09:00\n",
  "memory/long.md": `# Essay\n\n${"a very long note about ports and nothing else. ".repeat(80)}\n`,
};

async function agent(home: string): Promise<string> {
  const dir = join(home, "agent");
  await cp(SOUL, join(dir, "soul"), { recursive: true });
  for (const [rel, text] of Object.entries(MEMORY)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await Bun.write(join(dir, rel), text);
  }
  return dir;
}

async function run(home: string, args: readonly string[], ollama: string) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: ROOT,
    env: {
      HOME: home,
      PATH: await barePath(home),
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      OLLAMA_HOST: ollama,
      MIND_EMBED_URL: DEAD,
      MIND_QDRANT_URL: DEAD,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

async function indexed(home: string): Promise<string> {
  const dir = await agent(home);
  const built = await run(home, ["memory", "index", dir, "--subject", SUBJECT], DEAD);
  expect(built.code, built.stderr).toBe(0);
  return dir;
}

function stub(): StubOllama {
  const s = serveOllama();
  stubs.push(s);
  return s;
}

const turn = (dir: string, prompt: string, ...extra: string[]) => [
  "turn", dir, "--subject", SUBJECT, "--backend", "ollama", "--model", "stub", "--prompt", prompt, ...extra,
];

describe("a turn with recall", () => {
  test("the related piece rides in the system message, the prompt is sent as typed", async () => {
    const home = await sandbox();
    const dir = await indexed(home);
    const ollama = stub();
    const prompt = "token t1 — which port does the dashboard use?";

    const result = await run(home, turn(dir, prompt), ollama.url);

    expect(result.code, result.stderr).toBe(0);
    expect(ollama.prompts).toEqual([prompt]);
    const system = ollama.systems[0]!;
    expect(system).toContain("Example Keeper");
    expect(system).toContain(RECALL_HEADING);
    expect(system).toContain("30600");
    // AC3: named before it went, with where it came from.
    expect(result.stderr).toMatch(/recall: \d+ piece\(s\)/);
    expect(result.stderr).toContain("memory/infra.md — Ports");
    expect(result.stderr).toContain("vector half skipped");
  }, 60_000);

  test("a Thai prompt with no spaces still finds the Thai note", async () => {
    const home = await sandbox();
    const dir = await indexed(home);
    const ollama = stub();

    await run(home, turn(dir, "token t2 ราคาทองแจ้งกี่โมง"), ollama.url);

    expect(ollama.systems[0]).toContain("09:00");
  }, 60_000);

  test("the ceiling holds: a piece that does not fit is left out whole, and said so", async () => {
    const home = await sandbox();
    const dir = await indexed(home);
    const ollama = stub();

    const result = await run(home, turn(dir, "token t3 ports essay note", "--recall-chars", "200"), ollama.url);

    const system = ollama.systems[0]!;
    const block = system.slice(system.indexOf(RECALL_HEADING));
    expect(block).not.toContain("a very long note");
    expect(result.stderr).toContain("over the ceiling, left out");
  }, 60_000);

  test("--no-recall and --recall-chars 0 send the soul alone", async () => {
    const home = await sandbox();
    const dir = await indexed(home);
    for (const flag of [["--no-recall"], ["--recall-chars", "0"]]) {
      const ollama = stub();
      const result = await run(home, turn(dir, "token t4 port", ...flag), ollama.url);
      expect(result.code, result.stderr).toBe(0);
      expect(ollama.systems[0], flag.join(" ")).not.toContain(RECALL_HEADING);
      expect(result.stderr, flag.join(" ")).not.toContain("recall:");
    }
  }, 60_000);

  test("an agent with no index is not asked anything, and nothing is printed", async () => {
    const home = await sandbox();
    const dir = await agent(home);
    const ollama = stub();
    const result = await run(home, turn(dir, "token t5 port"), ollama.url);
    expect(result.code, result.stderr).toBe(0);
    expect(ollama.systems[0]).not.toContain(RECALL_HEADING);
    expect(result.stderr).not.toContain("recall:");
  }, 60_000);

  test("naming the soul directory instead of the repository finds the same memory", async () => {
    const home = await sandbox();
    const dir = await indexed(home);
    const ollama = stub();
    await run(home, turn(join(dir, "soul"), "token t6 dashboard port"), ollama.url);
    expect(ollama.systems[0]).toContain("30600");
  }, 60_000);

  test("--json carries what was attached, and the ledger's soul hash ignores recall", async () => {
    const home = await sandbox();
    const dir = await indexed(home);
    const ollama = stub();

    const withRecall = await run(home, turn(dir, "token t7 dashboard port", "--json"), ollama.url);
    const parsed = JSON.parse(withRecall.stdout) as { recall: { attached: { path: string }[] } };
    expect(parsed.recall.attached.map((a) => a.path)).toContain("memory/infra.md");

    await run(home, turn(dir, "token t8 dashboard port", "--no-recall"), ollama.url);
    const ledgerDir = join(home, "state", "mind", "ledger", SUBJECT);
    const lines: { soul_sha: string | null }[] = [];
    for (const file of await readdir(ledgerDir)) {
      if (!file.endsWith(".jsonl")) continue;
      for (const line of (await Bun.file(join(ledgerDir, file)).text()).split("\n")) {
        if (line.trim() !== "") lines.push(JSON.parse(line));
      }
    }
    expect(lines.length).toBe(2);
    // Present, a sha256, and the same with and without recall.
    expect(lines[0]!.soul_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(lines.map((l) => l.soul_sha)).size).toBe(1);
  }, 60_000);

  test("a bad ceiling is a usage error, before anything is sent", async () => {
    const home = await sandbox();
    const dir = await indexed(home);
    const ollama = stub();
    const result = await run(home, turn(dir, "token t9", "--recall-chars", "-5"), ollama.url);
    expect(result.code).toBe(2);
    expect(ollama.prompts).toEqual([]);
  }, 60_000);
});
