/** D-069 — a page key that survives a restart, and only the owner can read. */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateKey, newKey, replaceKey } from "../../src/web/key.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("web key file", () => {
  test("made once at 600, then the same key every time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-web-key-"));
    scratch.push(dir);
    const path = join(dir, "web.key");
    const first = await loadOrCreateKey(path);
    expect(first.ok && first.created).toBe(true);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    const again = await loadOrCreateKey(path);
    expect(again).toEqual({ ok: true, key: first.ok ? first.key : "", created: false });
    expect((await readFile(path, "utf8")).trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refused when others can read it, when it is not a key, or when it cannot be made", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-web-key-"));
    scratch.push(dir);
    const open = join(dir, "open.key");
    await writeFile(open, `${"a".repeat(32)}\n`);
    await chmod(open, 0o644);
    expect(await loadOrCreateKey(open)).toMatchObject({ ok: false });
    const junk = join(dir, "junk.key");
    await writeFile(junk, "not a key", { mode: 0o600 });
    expect(await loadOrCreateKey(junk)).toMatchObject({ ok: false });
    expect(await loadOrCreateKey(join(dir, "missing", "web.key"))).toMatchObject({ ok: false });
  });
});

describe("changing the key (S14.2 AC3)", () => {
  test("a new key is 64 lower-case hex, and new each time", () => {
    expect(newKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(newKey()).not.toBe(newKey());
  });

  test("replaced whole at 600, nothing left beside it, and loaded back as the same key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-key-"));
    scratch.push(dir);
    const path = join(dir, "web.key");
    const first = await loadOrCreateKey(path);
    const key = newKey();
    expect(await replaceKey(path, key)).toEqual({ ok: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["web.key"]);
    const again = await loadOrCreateKey(path);
    expect(again).toEqual({ ok: true, key, created: false });
    expect(first.ok && first.key !== key).toBe(true);
  });

  test("refuses what is not a key; a failed write leaves the old file and no stray one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-key-"));
    scratch.push(dir);
    const path = join(dir, "web.key");
    await loadOrCreateKey(path);
    const before = await readFile(path, "utf8");
    expect(await replaceKey(path, "NOT-A-KEY")).toEqual({ ok: false, reason: "not a page key (32–64 lower-case hex)" });
    const missing = await replaceKey(join(dir, "no-such-dir", "web.key"), newKey());
    expect(missing.ok).toBe(false);
    await mkdir(join(dir, "blocked.key")); // a directory, not empty, where the file should be: the rename fails
    await writeFile(join(dir, "blocked.key", "inside"), "x");
    const blocked = await replaceKey(join(dir, "blocked.key"), newKey());
    expect(blocked.ok).toBe(false);
    expect((await readdir(dir)).sort()).toEqual(["blocked.key", "web.key"]);
    expect(await readFile(path, "utf8")).toBe(before);
  });
});

