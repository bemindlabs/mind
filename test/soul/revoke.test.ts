/** S1.5 in-process — the manifest history, and every branch of the plan. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, splice } from "../../src/soul/block.ts";
import { beforeApply, commitRevoke, planRevoke } from "../../src/soul/revoke.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("example");
const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mind-revoke-unit-"));
  scratch.push(d);
  return d;
}

function applied(text: string, subject = SUBJECT): string {
  const result = splice(text, { subject, body: "# identity\n\nExample Keeper\n" });
  if (result.kind !== "spliced") throw new Error(JSON.stringify(result));
  return result.next;
}

describe("beforeApply", () => {
  test("the oldest manifest wins, and an unreadable one is reported", async () => {
    const root = await dir();
    const write = async (stamp: string, files: unknown) => {
      await mkdir(join(root, stamp), { recursive: true });
      await Bun.write(join(root, stamp, "manifest.json"), JSON.stringify({ files }));
    };
    await write("20260901T000000000Z", [{ path: "/a", existedBefore: true, sha256: "first" }]);
    await write("20260902T000000000Z", [{ path: "/a", existedBefore: true, sha256: "second" }, { path: "/b", existedBefore: false, sha256: "" }]);
    await mkdir(join(root, "20260903T000000000Z"), { recursive: true });
    await Bun.write(join(root, "20260903T000000000Z", "manifest.json"), "{ broken");
    await write("20260904T000000000Z", "not a list");

    const history = await beforeApply(root);
    expect(history.paths.get("/a")).toEqual({ existedBefore: true, sha256: "first" });
    expect(history.paths.get("/b")).toEqual({ existedBefore: false, sha256: "" });
    expect(history.unreadable.length).toBe(2);
  });

  test("no backups at all is an empty history", async () => {
    expect((await beforeApply(join(await dir(), "nope"))).paths.size).toBe(0);
  });
});

describe("planRevoke", () => {
  test("strip back to identical; delete what Mind created; leave others; refuse what it cannot read", async () => {
    const d = await dir();
    const human = "# mine\n\nhello\n";
    const files = {
      kept: join(d, "kept.md"),
      created: join(d, "created.md"),
      other: join(d, "other.md"),
      plain: join(d, "plain.md"),
      binary: join(d, "binary.md"),
      folder: join(d, "folder.md"),
      nohistory: join(d, "nohistory.md"),
    };
    await writeFile(files.kept, applied(human));
    await writeFile(files.created, applied(""));
    await writeFile(files.other, applied(human, subjectId("someone-else")));
    await writeFile(files.plain, human);
    await writeFile(files.binary, new Uint8Array([0xff, 0xfe, 0x00]));
    await mkdir(files.folder);
    await writeFile(files.nohistory, applied(human));

    const history = new Map([
      [files.kept, { existedBefore: true, sha256: sha256(human) }],
      [files.created, { existedBefore: false, sha256: "" }],
    ]);
    const plan = await planRevoke([...Object.values(files), join(d, "missing.md")], SUBJECT, history);
    const by = Object.fromEntries(plan.map((p) => [p.path, p]));

    expect(by[files.kept]).toMatchObject({ action: "strip", identical: true, next: human });
    expect(by[files.created]).toMatchObject({ action: "delete", identical: true });
    expect(by[files.other]!.action).toBe("other-subject");
    expect(by[files.plain]!.action).toBe("absent");
    expect(by[files.binary]!.action).toBe("refused");
    expect(by[files.folder]!.action).toBe("refused");
    expect(by[files.nohistory]).toMatchObject({ action: "strip", identical: null });
    expect(by[join(d, "missing.md")]!.action).toBe("absent");

    await expect(commitRevoke(plan)).rejects.toThrow("refused plan");
  });

  test("commit writes the strips and removes the deletes, and nothing else", async () => {
    const d = await dir();
    const human = "keep\n";
    const kept = join(d, "kept.md");
    const created = join(d, "created.md");
    const other = join(d, "other.md");
    await writeFile(kept, applied(human));
    await writeFile(created, applied(""));
    await writeFile(other, applied(human, subjectId("someone-else")));
    const otherBefore = await Bun.file(other).text();

    const plan = await planRevoke([kept, created, other], SUBJECT, new Map([[created, { existedBefore: false, sha256: "" }]]));
    expect(await commitRevoke(plan)).toEqual({ changed: 2 });
    expect(await Bun.file(kept).text()).toBe(human);
    expect(await Bun.file(created).exists()).toBe(false);
    expect(await Bun.file(other).text()).toBe(otherBefore);
  });
});
