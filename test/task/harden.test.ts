import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { dumpable, notDumpable } from "../../src/task/harden.ts";
import { BUN } from "../support/bare-path.ts";
import { waitFor } from "../support/wait.ts";

const HARDEN = new URL("../../src/task/harden.ts", import.meta.url).pathname;

test("a runner made not dumpable: prctl says 0, and its /proc/<pid>/mem and environ are root's (review of PR #24, round 2)", async () => {
  // In a process of its own, so the test runner itself stays as it was.
  const child = Bun.spawn(
    [BUN, "-e", `const h = await import(${JSON.stringify(HARDEN)}); const before = await h.dumpable(); const r = await h.notDumpable(); console.log(before, JSON.stringify(r), await h.dumpable()); await Bun.sleep(3000);`],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, SECRET_FOR_TEST: "never-readable" } },
  );
  const reader = child.stdout.getReader();
  const line = new TextDecoder().decode((await reader.read()).value).trim();
  expect(line).toBe('1 {"ok":true} 0');
  // Owned by root now: this process — the child's parent, the same uid — cannot read them.
  expect(await waitFor(async () => (await stat(`/proc/${child.pid}/environ`)).uid === 0)).toBe(true);
  expect((await stat(`/proc/${child.pid}/mem`)).uid).toBe(0);
  await expect(Bun.file(`/proc/${child.pid}/environ`).text()).rejects.toThrow();
  child.kill();
  await child.exited;
});

test("off Linux it says so", async () => {
  expect(await notDumpable("darwin")).toEqual({ ok: false, reason: "prctl(PR_SET_DUMPABLE) is Linux's; this is darwin" });
  expect(await dumpable("darwin")).toBeNull();
  expect(await dumpable()).toBe(1);
  expect(await notDumpable("linux", async () => -1)).toEqual({ ok: false, reason: "prctl(PR_SET_DUMPABLE, 0) returned -1" });
  expect(await notDumpable("linux", async () => {
    throw new Error("no libc");
  })).toEqual({ ok: false, reason: "prctl could not be called (no libc)" });
});
