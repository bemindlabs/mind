/** S8.3 AC4 in-process — where needles and the record live, and what the record holds (D-048). */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOCKED_FILE, EGRESS_DIR, loadLexicon, NEEDLES_FILE, readBlocked, recordBlocked } from "../../src/egress/store.ts";
import { personalDir } from "../../src/guard/personal.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("example");
const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function env() {
  const home = await mkdtemp(join(tmpdir(), "mind-egress-store-"));
  scratch.push(home);
  return { home, env: { XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state") } };
}

describe("egress store", () => {
  test("no file: no needles and no source; the soul's inherited names still count", async () => {
    const e = await env();
    const { lexicon, source } = await loadLexicon(e, SUBJECT, ["Wanida Srisuk"]);
    expect(source).toBeNull();
    expect(lexicon.needles).toEqual(["Wanida Srisuk"]);
  });

  test("a needles file in the personal directory is read, comments skipped", async () => {
    const e = await env();
    const dir = await personalDir(e, SUBJECT);
    await mkdir(join(dir.path, EGRESS_DIR), { recursive: true });
    await Bun.write(join(dir.path, EGRESS_DIR, NEEDLES_FILE), "# x\nsecret one\n");
    const { lexicon, source } = await loadLexicon(e, SUBJECT, []);
    expect(lexicon.needles).toEqual(["secret one"]);
    expect(source).toContain(NEEDLES_FILE);
  });

  test("the record: appended, read back in order, private, and holding no text", async () => {
    const e = await env();
    expect(await readBlocked(e, SUBJECT)).toEqual([]);
    const path = await recordBlocked(e, SUBJECT, { at: "t1", backend: "claude", findings: [{ rule: "needle", needle: 1 }] });
    await recordBlocked(e, SUBJECT, { at: "t2", backend: "codex", findings: [{ rule: "email" }] });
    expect(path.endsWith(join(EGRESS_DIR, BLOCKED_FILE))).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const entries = await readBlocked(e, SUBJECT);
    expect(entries.map((x) => x.backend)).toEqual(["claude", "codex"]);
    await Bun.write(path, `${await Bun.file(path).text()}{ broken\n`);
    expect((await readBlocked(e, SUBJECT)).length).toBe(2);
  });
});
