/**
 * `mind web --key-file` — a link key that survives a restart (D-069).
 *
 * By default the key is new every start, so an old link stops working the
 * moment the page does. A page run as a service restarts on its own, and a
 * key that changes each time is a link nobody can keep. With a key file the
 * key is read from it — created once, 600, if it is not there — and it is
 * refused if anyone but the owner could read it.
 */

import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

const KEY = /^[0-9a-f]{32,64}$/;

export async function loadOrCreateKey(path: string): Promise<{ readonly ok: true; readonly key: string; readonly created: boolean } | { readonly ok: false; readonly reason: string }> {
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) return { ok: false, reason: `${path} can be read by others (mode ${(info.mode & 0o777).toString(8)}) — chmod 600 it first` };
    const key = (await readFile(path, "utf8")).trim();
    if (!KEY.test(key)) return { ok: false, reason: `${path} does not hold a page key (32–64 lower-case hex)` };
    return { ok: true, key, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const key = newKey();
  try {
    // wx: never over a file that appeared in between.
    await writeFile(path, `${key}\n`, { mode: 0o600, flag: "wx" });
    return { ok: true, key, created: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** A page key: 64 lower-case hex from two random UUIDs. */
export function newKey(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

/**
 * S14.2 AC3: a new key in place of the old one, so every paired phone and every old link stop working. Written
 * beside the file (600, never over one that appeared) and renamed over it, so the file is never half a key.
 */
export async function replaceKey(path: string, key: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  if (!KEY.test(key)) return { ok: false, reason: "not a page key (32–64 lower-case hex)" };
  const temp = `${path}.new-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await writeFile(temp, `${key}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
    return { ok: true };
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A short, one-way name for a page key (16 hex of its SHA-256): what a push subscription records so that only the
 * page holding that key tells that phone anything (D-130). It says nothing about the key a holder could use.
 */
export function keyPrint(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 16);
}
