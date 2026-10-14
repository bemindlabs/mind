/**
 * D-152 review — a child held to a deadline is ended even when it ignores SIGTERM: its group gets SIGKILL after
 * the grace, so the one-ask-per-agent slot is freed and the route's 504 comes.
 */

import { describe, expect, test } from "bun:test";
import { runWithDeadline } from "../../src/web/deadline.ts";
import { BUN } from "../support/bare-path.ts";
import { procState } from "../support/wait.ts";

describe("runWithDeadline", () => {
  test("a child that ignores SIGTERM — and a grandchild in its group — are killed after the grace", async () => {
    // The child traps TERM, starts a grandchild that sleeps (also in its group), prints the grandchild's pid, and waits.
    const script =
      'process.on("SIGTERM", () => {});' +
      'const g = Bun.spawn(["' + BUN + '", "-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });' +
      'console.log(g.pid); setInterval(() => {}, 1000);';
    // The deadline is what the child gets to start bun, trap TERM and start the grandchild before SIGTERM comes.
    // At 400 ms a loaded runner could signal a child that had not trapped it yet — it then died politely, needed
    // no SIGKILL, and the case failed without the code under test doing anything wrong.
    const DEADLINE_MS = 2_000;
    const GRACE_MS = 600;
    const started = performance.now();
    const out = await runWithDeadline([BUN, "-e", script], DEADLINE_MS, GRACE_MS);
    const took = performance.now() - started;
    expect(out.timedOut).toBe(true);
    expect(out.killed).toBe(true);
    // Ended soon after deadline + grace, not left to run: the same 4.6 s of slack the 400 ms case had.
    expect(took).toBeLessThan(DEADLINE_MS + GRACE_MS + 4_000);
    const grandchild = Number(out.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    // Ended by the time the call returned, asked at once: gone, a zombie its new parent has not reaped yet, or with
    // SIGKILL already pending. (It used to sleep 100 ms and ask whether the pid answered a signal 0 — which a
    // zombie does, so a slow reaper on a loaded runner failed a kill that worked.)
    const now = procState(grandchild);
    expect(now === null || now.state === "Z" || now.state === "X" || now.killPending, JSON.stringify(now)).toBe(true);
  }, 60_000);

  test("a child that ends on SIGTERM needs no SIGKILL; one that finishes in time is not signalled", async () => {
    const polite = await runWithDeadline([BUN, "-e", "setInterval(() => {}, 1000)"], 300, 5_000);
    expect(polite).toMatchObject({ timedOut: true, killed: false });
    const quick = await runWithDeadline([BUN, "-e", 'console.log("done")'], 10_000, 5_000);
    expect(quick).toMatchObject({ code: 0, stdout: "done\n", timedOut: false, killed: false });
  }, 60_000);
});
