/**
 * E8 end to end against a real bwoc fleet agent (D-063). Opt-in, because it
 * writes one message into a real agent's inbox and starts listeners:
 *
 *   MIND_E2E_BWOC_WORKSPACE=~/bwoc MIND_E2E_BWOC_AGENT=busaba \
 *     [MIND_BWOC_A2A_DIR=<dir holding bwoc-a2a>] bun test test/a2a/fleet.e2e.test.ts
 *
 * `bwoc a2a` runs a `bwoc-a2a` binary it looks for beside itself or on PATH;
 * when the fleet's install has none, point MIND_BWOC_A2A_DIR at a build —
 * it is put on PATH for these children only, and nothing is installed.
 *
 * The Mind side is a throwaway agent in a temp home — a real agent's peers
 * are added by its owner typing the phrase, and this test does not type it for
 * them. The fleet side is the real agent, reached through the fleet's own
 * `bwoc a2a serve` and `bwoc a2a send`, on loopback, stopped afterwards.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKSPACE = process.env["MIND_E2E_BWOC_WORKSPACE"] ?? "";
const AGENT = process.env["MIND_E2E_BWOC_AGENT"] ?? "";
const A2A_DIR = process.env["MIND_BWOC_A2A_DIR"] ?? "";
const FLEET_PATH = A2A_DIR === "" ? (process.env["PATH"] ?? "") : `${A2A_DIR}:${process.env["PATH"] ?? ""}`;
const ENABLED = WORKSPACE !== "" && AGENT !== "" && Bun.which("bwoc") !== null && Bun.which("bwoc-a2a", { PATH: FLEET_PATH }) !== null && Bun.which("script") !== null;
const FLEET_ENV = { ...process.env, PATH: FLEET_PATH };
const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const FLEET_PORT = 30796;
const MIND_PORT = 30797;

/** Listeners are started as group leaders and stopped as groups: `bwoc a2a serve` runs `bwoc-a2a` as a child. */
const groups: number[] = [];
const scratch: string[] = [];
afterAll(async () => {
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

async function until(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(200);
  }
  throw new Error("timed out");
}
const up = (port: number) => until(async () => (await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`)).ok);

describe.skipIf(!ENABLED)(`E8 with the real fleet agent ${AGENT}`, () => {
  test("Mind → fleet, and fleet → Mind, through the fleet's own a2a — and nothing left listening", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-e2e-fleet-"));
    scratch.push(home);
    const soul = join(home, "soul");
    await cp(join(ROOT, "test", "fixtures", "soul-valid"), soul, { recursive: true });
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data") };
    const om = (args: readonly string[]) => Bun.spawn(["bun", "run", BIN, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const text = async (p: ReturnType<typeof om>) => {
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      return { code: p.exitCode, out, err };
    };

    // The fleet agent listens, through the fleet's own CLI.
    const fleet = Bun.spawn(["bwoc", "a2a", "serve", AGENT, "--workspace", WORKSPACE, "--port", String(FLEET_PORT)], { env: FLEET_ENV, stdout: "ignore", stderr: "pipe", detached: true });
    groups.push(fleet.pid);
    await up(FLEET_PORT);

    // A throwaway Mind agent allows it, the phrase typed through a real pty.
    const allow = Bun.spawn(
      ["script", "-qec", `bun run ${BIN} a2a allow fleet --endpoint http://127.0.0.1:${FLEET_PORT}/ --subject example`, "/dev/null"],
      { env, stdin: new TextEncoder().encode("allow fleet\n"), stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(allow.stdout).text()).toContain("fleet is allowed");

    // Mind → fleet.
    const inbox = join(WORKSPACE, "agents", `agent-${AGENT}`, ".bwoc", "inbox.jsonl");
    const marker = `Mind e2e ${crypto.randomUUID()} — a test message from mind a2a; no action needed`;
    const sent = await text(om(["a2a", "send", soul, "--subject", "example", "--to", "fleet", "--text", marker]));
    expect(sent.code, sent.err).toBe(0);
    expect(sent.err).toContain("leaving this machine");
    expect(await readFile(inbox, "utf8")).toContain(marker);

    // fleet → Mind, with the token Mind issued.
    const peers = JSON.parse(await readFile(join(home, "state", "mind", "a2a", "example", "peers.json"), "utf8")) as { peers: { inboundToken: string }[] };
    const serve = Bun.spawn(["bun", "run", BIN, "a2a", "serve", soul, "--subject", "example", "--port", String(MIND_PORT)], { env, stdout: "ignore", stderr: "ignore", detached: true });
    groups.push(serve.pid);
    await up(MIND_PORT);
    const back = `reply from the fleet ${crypto.randomUUID()}`;
    const reply = Bun.spawn(["bwoc", "a2a", "send", `http://127.0.0.1:${MIND_PORT}/`, back, "--token", peers.peers[0]!.inboundToken, "--workspace", WORKSPACE], { env: FLEET_ENV, stdout: "pipe", stderr: "pipe" });
    const replyOut = await new Response(reply.stdout).text();
    await reply.exited;
    expect(replyOut).toContain("delivered to Example Keeper's inbox");
    expect((await text(om(["a2a", "inbox", "--subject", "example"]))).out).toContain(back);

    // Without the token the fleet's client is turned away.
    const stranger = Bun.spawn(["bwoc", "a2a", "send", `http://127.0.0.1:${MIND_PORT}/`, "no token", "--workspace", WORKSPACE], { env: FLEET_ENV, stdout: "pipe", stderr: "pipe" });
    await stranger.exited;
    expect(stranger.exitCode).not.toBe(0);

    for (const pid of groups.splice(0)) process.kill(-pid, "SIGTERM");
    await until(async () => {
      const closed = await Promise.all([FLEET_PORT, MIND_PORT].map((port) => fetch(`http://127.0.0.1:${port}/`).then(() => false, () => true)));
      return closed.every(Boolean);
    });
  }, 120_000);
});
