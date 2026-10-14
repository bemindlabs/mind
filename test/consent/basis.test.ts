/** S7.3 (D-077) — the basis record, and which use it allows when. */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basisDirFor, basisFor, basisProblem, readBasis, recordPhrase, recordState, refusalLine, soulSubject, writeBasis, type BasisRecord } from "../../src/consent/basis.ts";
import { subjectId } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

const rec = (over: Partial<BasisRecord> = {}): BasisRecord => ({ id: "a", subject: "example", basis: "owner", approvedBy: "me", at: "2026-09-25T00:00:00Z", uses: ["memory"], expires: null, note: "", revokedAt: null, ...over });
const NOW = new Date("2026-09-25T12:00:00Z");

describe("basis", () => {
  test("AC1: what makes a record, and what does not", () => {
    expect(basisProblem("owner", ["memory"], null, NOW)).toBeUndefined();
    expect(basisProblem("consent", ["memory", "persona"], "2027-01-31", NOW)).toBeUndefined();
    expect(basisProblem("vibes", ["memory"], null, NOW)).toContain("the basis is one of");
    expect(basisProblem("owner", [], null, NOW)).toContain("at least one use");
    expect(basisProblem("owner", ["training"], null, NOW)).toContain('not "training"');
    expect(basisProblem("owner", ["memory"], "tomorrow", NOW)).toContain("YYYY-MM-DD");
    expect(basisProblem("owner", ["memory"], "2026-09-24", NOW)).toContain("already passed");
    expect(basisProblem("owner", ["memory"], "2026-09-25", NOW)).toBeUndefined();
    expect(recordPhrase("example")).toBe("record basis for example");
  });

  test("AC2 + AC3: the newest active record naming the use; otherwise exactly why not", () => {
    expect(basisFor([], "memory", NOW)).toEqual({ ok: false, reason: "there is no basis on record for this subject" });
    expect(basisFor([rec()], "memory", NOW)).toMatchObject({ ok: true, record: { id: "a" } });
    expect(basisFor([rec()], "persona", NOW)).toEqual({ ok: false, reason: "the basis on record allows memory — not persona" });
    expect(basisFor([rec({ uses: ["memory", "persona"] })], "fine-tune", NOW).ok).toBe(false);
    expect(basisFor([rec({ expires: "2026-09-24" })], "memory", NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("expired or been revoked") });
    expect(basisFor([rec({ revokedAt: "2026-09-25T01:00:00Z" })], "memory", NOW).ok).toBe(false);
    expect(basisFor([rec({ id: "old" }), rec({ id: "new", at: "2026-09-25T06:00:00Z" })], "memory", NOW)).toMatchObject({ record: { id: "new" } });
    expect(recordState(rec({ expires: "2026-09-25" }), NOW)).toBe("active");
    expect(refusalLine("example", "persona", "why")).toContain("mind basis record");
  });

  test("stored 600 under the state root; read back; a broken file is no record", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-basis-"));
    scratch.push(home);
    const dir = basisDirFor({ home, env: { XDG_STATE_HOME: join(home, "state") } }, subjectId("example"));
    expect(dir).toContain(join("state", "mind", "basis", "example"));
    expect(await readBasis(dir)).toEqual([]);
    await writeBasis(dir, [rec()]);
    expect(((await stat(join(dir, "records.json"))).mode & 0o777).toString(8)).toBe("600");
    expect(await readBasis(dir)).toEqual([rec()]);
    await writeFile(join(dir, "records.json"), "{nope");
    expect(await readBasis(dir)).toEqual([]);
  });

  test("the subject a soul names, from an agent directory or a soul directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-basis-soul-"));
    scratch.push(home);
    await cp(join(import.meta.dir, "..", "fixtures", "soul-valid"), join(home, "agent", "soul"), { recursive: true });
    expect(await soulSubject(join(home, "agent"))).toBe("example");
    expect(await soulSubject(join(home, "agent", "soul"))).toBe("example");
    expect(await soulSubject(join(home, "nowhere"))).toBeUndefined();
  });
});
