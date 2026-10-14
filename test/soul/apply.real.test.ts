/**
 * AC4 against the operator's actual instruction file — opt-in, and read-only.
 *
 * Run with:
 *
 *     MIND_REAL_CLAUDE_MD=1 bun test test/soul/apply.real.test.ts
 *
 * Skipped otherwise, because it depends on a file that exists on one machine
 * and not in CI, and a test that silently passes when its subject is missing
 * is worse than no test.
 *
 * What it does: reads the real file, copies it into a temporary home, applies
 * a fixture identity *there*, and checks that stripping Mind's block gives
 * the real file's bytes back. The real file is never opened for writing, and
 * its path is computed from `$HOME` at run time rather than written down (a
 * path in the engine would be a person's path in the engine — D-021).
 *
 * The synthetic case lives in `apply.test.ts` and runs everywhere. This one
 * exists to catch what a fixture cannot: whatever is actually in that file
 * today, including whatever another tool has written into it since.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { subjectId } from "../../src/types.ts";
import { sha256, strip } from "../../src/soul/block.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { resolveTargets } from "../../src/soul/targets.ts";
import { commitApply, planApply, type ApplyEnv } from "../../src/soul/apply.ts";

const ENABLED = process.env["MIND_REAL_CLAUDE_MD"] === "1";
const REAL = join(homedir(), ".claude", "CLAUDE.md");
const FIXTURES = join(import.meta.dir, "..", "fixtures");

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("the real instruction file", () => {
  test("survives an apply on a copy, byte for byte", async () => {
    const original = await readFile(REAL, "utf8");
    const before = sha256(await readFile(REAL));
    const beforeMode = (await stat(REAL)).mode & 0o777;

    const home = await mkdtemp(join(tmpdir(), "mind-real-"));
    scratch.push(home);
    await mkdir(join(home, ".claude"), { recursive: true });
    const copy = join(home, ".claude", "CLAUDE.md");
    await writeFile(copy, original, { mode: beforeMode });

    const subject = subjectId("example");
    const loaded = await loadSoul(join(FIXTURES, "soul-valid"), subject);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const env: ApplyEnv = {
      home,
      env: { XDG_STATE_HOME: join(home, "state") },
      now: () => new Date(),
      explicit: new Set(["claude"]),
    };
    const targets = await resolveTargets(["claude"], {
      home,
      cwd: home,
      env: {},
      which: () => Promise.resolve(true),
    });

    const plan = await planApply(loaded.soul, targets, env);
    expect(plan.issues).toEqual([]);
    expect(plan.plans[0]!.action).toBe("insert");

    const result = await commitApply(plan, env);
    expect(result.ok).toBe(true);

    const after = await readFile(copy, "utf8");
    const stripped = strip(after);
    expect(stripped.kind).toBe("stripped");
    if (stripped.kind !== "stripped") return;
    expect(stripped.text).toBe(original);
    expect((await stat(copy)).mode & 0o777).toBe(beforeMode);

    // And the file this was read from has not been touched.
    expect(sha256(await readFile(REAL))).toBe(before);
  });
});
