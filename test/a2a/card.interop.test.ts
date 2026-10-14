/**
 * S8.1 AC3 — a real A2A client reads Mind's card. Interop with another
 * system's code, not a mock of it.
 *
 * The client is `bwoc a2a fetch-card`, which needs the `bwoc-a2a` binary on
 * PATH or beside `bwoc`. Where it is not installed this is skipped and says
 * so; point `MIND_BWOC_A2A_DIR` at a directory holding a built `bwoc-a2a`
 * to run it anyway. The card is served on a loopback port by this test only —
 * Mind itself still serves nothing (E8 stays off until S8.3).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AGENT_CARD_PATH, agentCard } from "../../src/a2a/card.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { subjectId } from "../../src/types.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "soul-inherits");
const extraDir = process.env["MIND_BWOC_A2A_DIR"];
const path = extraDir === undefined ? (process.env["PATH"] ?? "") : `${extraDir}:${process.env["PATH"] ?? ""}`;
const bwoc = Bun.which("bwoc", { PATH: path });
const a2a = Bun.which("bwoc-a2a", { PATH: path });

describe.skipIf(bwoc === null || a2a === null)("S8.1 AC3 — `bwoc a2a fetch-card` reads the card", () => {
  test("the real client fetches the well-known path and prints the card it parsed", async () => {
    const loaded = await loadSoul(FIXTURE, subjectId("ledger-aide"));
    if (!loaded.ok) throw new Error("fixture");
    const asked: string[] = [];
    let base = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request: Request): Response {
        const url = new URL(request.url);
        asked.push(url.pathname);
        return url.pathname === AGENT_CARD_PATH
          ? Response.json(agentCard(loaded.soul, base))
          : new Response("not here", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    try {
      const child = Bun.spawn([bwoc!, "a2a", "fetch-card", base], {
        env: { ...process.env, PATH: path },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(child.stdout).text();
      const err = await new Response(child.stderr).text();
      await child.exited;
      expect(child.exitCode, err).toBe(0);
      expect(asked).toContain(AGENT_CARD_PATH);
      expect(out).toContain("Ledger Aide");
      expect(out).toContain("An AI agent, not a person.");
    } finally {
      server.stop(true);
    }
  }, 60_000);
});
