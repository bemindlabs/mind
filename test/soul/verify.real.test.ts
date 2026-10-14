/**
 * Verification against this machine — opt-in, read-only, and costly.
 *
 * Run with:
 *
 *     MIND_REAL_VERIFY=1 bun test test/soul/verify.real.test.ts
 *     MIND_REAL_VERIFY=1 MIND_REAL_MODEL=<ollama model> bun test test/soul/verify.real.test.ts
 *
 * Skipped otherwise. It spends a real turn on a commercial CLI and needs a
 * daemon that exists on one machine and not in CI, and a test that silently
 * passes when its subject is missing is worse than no test.
 *
 * What it cannot do is assert what a model will say — that is the thing being
 * measured, and a test that demanded a particular answer would be a test of the
 * fixture's luck. So it asserts the properties that must hold *whatever* the
 * model answers:
 *
 * - nothing is written, and the operator's own instruction file is unchanged
 *   to the byte;
 * - a soul Mind never applied here is never reported as `present` on disk;
 * - a pass with no block on disk always carries the caveat that says so — the
 *   attribution guard, which is the whole reason the probes ask for this
 *   soul's own words rather than "who are you";
 * - session-start hooks in this home are reported rather than ignored.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { backend } from "../../src/exec/index.ts";
import { sha256 } from "../../src/soul/block.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { resolveTargets, whichOnPath } from "../../src/soul/targets.ts";
import { contextInjectionNote, verifySoul } from "../../src/soul/verify.ts";
import { subjectId } from "../../src/types.ts";

const ENABLED = process.env["MIND_REAL_VERIFY"] === "1";
const MODEL = process.env["MIND_REAL_MODEL"];
const FIXTURES = join(import.meta.dir, "..", "fixtures");
const HOME = homedir();

async function fixtureSoul() {
  const loaded = await loadSoul(join(FIXTURES, "soul-valid"), subjectId("example"));
  if (!loaded.ok) throw new Error("the fixture soul no longer loads");
  return loaded.soul;
}

describe.skipIf(!ENABLED)("verify against this machine", () => {
  test("the claude row is honest about a soul that was never applied here", async () => {
    const soul = await fixtureSoul();
    const targets = await resolveTargets(["claude"], {
      home: HOME,
      cwd: HOME,
      env: process.env,
      which: whichOnPath,
    });
    const path = (targets[0] as { path: string }).path;
    const before = await readFile(path).then(sha256).catch(() => "");

    const report = await verifySoul(soul, [backend("claude")], {
      targets,
      runs: 1,
      caveats: await contextInjectionNote(HOME),
    });

    const [row] = report.backends;
    // Mind has never applied this fixture to the real home, so the file can
    // be anything except "holds exactly this soul".
    expect(row!.file.state).not.toBe("present");

    // The attribution guard: a pass here would mean the answers came from
    // somewhere Mind did not write, and the row has to say that out loud.
    if (row!.level === "confirmed" || row!.level === "partial") {
      expect(row!.caveats.join(" ")).toContain("some other channel");
    }

    // Whatever happened, the operator's file was only ever read.
    expect(await readFile(path).then(sha256).catch(() => "")).toBe(before);

    console.log(
      `claude: ${row!.level} — ${row!.reason}\n` +
        row!.runs.map((r) => `  ${r.probe}: ${JSON.stringify(r.answer.slice(0, 200))}`).join("\n"),
    );
    for (const caveat of report.caveats) console.log(`caveat: ${caveat}`);
  }, 300_000);

  test.skipIf(MODEL === undefined || MODEL === "")(
    "the local backend carries the soul in the system field (I-1)",
    async () => {
      const soul = await fixtureSoul();
      const targets = await resolveTargets(["ollama"], {
        home: HOME,
        cwd: HOME,
        env: process.env,
        which: whichOnPath,
      });

      const report = await verifySoul(soul, [backend("ollama", { model: MODEL! })], {
        targets,
        runs: 1,
      });

      const [row] = report.backends;
      expect(row!.channel.kind).toBe("system-field");
      expect(row!.channel.strength).toBe("system");
      console.log(
        `ollama (${MODEL}): ${row!.level} — ${row!.reason}\n` +
          row!.runs.map((r) => `  ${r.probe}: ${JSON.stringify(r.answer.slice(0, 200))}`).join("\n"),
      );
    },
    600_000,
  );
});
