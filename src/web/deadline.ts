/**
 * A child of `mind web` held to a deadline (D-152) — `/api/memory-ask` is the route that asks for one.
 *
 * The child is started as the leader of a process group of its own, so the signals reach it and whatever it
 * started in that group, and nothing of the server's. At the deadline the group gets SIGTERM, which `memory
 * ask` answers by ending its backends; if the group is still there {@link ASK_KILL_GRACE_MS} later it gets
 * SIGKILL. Without the second step a child that ignored SIGTERM would hold the route's one-ask-per-agent slot
 * for good, and the 504 would never come. Resolves only once the child has exited.
 */

import { ASK_KILL_GRACE_MS } from "../memory/ask.ts";
import { spawnGuarded } from "../spawn.ts";

export interface DeadlineRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** SIGKILL was needed: the group outlived its SIGTERM by the whole grace. */
  readonly killed: boolean;
}

export async function runWithDeadline(argv: readonly string[], timeoutMs: number, graceMs: number = ASK_KILL_GRACE_MS): Promise<DeadlineRun> {
  const child = spawnGuarded(argv, { detached: true });
  let timedOut = false;
  let killed = false;
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, name);
    } catch {
      // The group is gone — or never formed; the child alone, then.
      try {
        child.kill(name);
      } catch {
        // Gone.
      }
    }
  };
  let grace: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    signal("SIGTERM");
    grace = setTimeout(() => {
      killed = true;
      signal("SIGKILL");
    }, graceMs);
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code: child.exitCode ?? -1, stdout, stderr: stderr.trim(), timedOut, killed };
  } finally {
    clearTimeout(timer);
    if (grace !== undefined) clearTimeout(grace);
  }
}
