/** D-042 — the record that lets a 3 count, and the safe direction when it is missing. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmationsDirFor, confirmationsPath, readConfirmations, setConfirmation } from "../../src/decide/confirm.ts";
import { subjectId } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mind-confirm-"));
  scratch.push(d);
  return d;
}

describe("confirmations", () => {
  test("keyed by the soul directory's path, under the state root and outside the repo", async () => {
    const h = await home();
    const env = { home: h, env: { XDG_STATE_HOME: join(h, "state") } };
    const S = subjectId("example");
    const a = confirmationsPath(env, join(h, "agent", "soul"), S);
    expect(a.startsWith(join(h, "state", "mind", "dial", "example"))).toBe(true);
    expect(a.startsWith(confirmationsDirFor(env, S))).toBe(true);
    expect(a).toBe(confirmationsPath(env, join(h, "agent", "soul", "."), S));
    expect(a).not.toBe(confirmationsPath(env, join(h, "clone", "soul"), S));
    expect(a).not.toBe(confirmationsPath(env, join(h, "agent", "soul"), subjectId("other")));
  });

  test("set, read back, withdraw — one category at a time", async () => {
    const h = await home();
    const path = join(h, "state", "mind", "dial", "x.json");
    await setConfirmation(path, "write", { by: "a", at: "t1" });
    await setConfirmation(path, "run", { by: "b", at: "t2" });
    expect(await readConfirmations(path)).toEqual({ write: { by: "a", at: "t1" }, run: { by: "b", at: "t2" } });
    await setConfirmation(path, "write", null);
    expect(await readConfirmations(path)).toEqual({ run: { by: "b", at: "t2" } });
  });

  test("missing, unreadable, or malformed entries are none", async () => {
    const h = await home();
    const path = join(h, "c.json");
    expect(await readConfirmations(path)).toEqual({});
    await Bun.write(path, "{ not json");
    expect(await readConfirmations(path)).toEqual({});
    await Bun.write(path, JSON.stringify({ write: { by: 1 }, run: null, read: { by: "x", at: "y" } }));
    expect(await readConfirmations(path)).toEqual({ read: { by: "x", at: "y" } });
  });
});
