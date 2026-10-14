/**
 * Waiting on a condition in a test — by a deadline, never by a count of attempts or a fixed sleep.
 *
 * A fixed `await Bun.sleep(300)` before the thing it waits for is an assumption about how fast the machine
 * is, and a GitHub runner under `bun run coverage` is several times slower than a laptop. A loop of
 * `for (i < 100) sleep(20)` is the same assumption written as a budget: 2 s of polling that becomes 0.3 s of
 * useful time when each sleep oversleeps. Both made tests here pass locally and fail on CI.
 *
 * So a wait names the condition it is for and gives up only at a deadline — one long enough that hitting it
 * means something broke, not that the machine was busy. The caller asserts on the answer, so a broken
 * condition still fails, and with the caller's own message.
 */

import { readFileSync } from "node:fs";

/** How long a wait gives a loaded machine by default before it reports the condition as never met. */
export const WAIT_MS = 30_000;

/**
 * Poll `done` every `every` ms until it holds or `within` ms have passed, and say whether it held.
 *
 * The last check is made after the deadline, so a condition that comes true just as time runs out counts.
 */
export async function waitFor(
  done: () => boolean | Promise<boolean>,
  { within = WAIT_MS, every = 20 }: { readonly within?: number; readonly every?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if (await done()) return true;
    await Bun.sleep(every);
  }
  return await done();
}

/**
 * How a process stands in `/proc`, read the way a test needs it: state letter, and whether SIGKILL is
 * already pending against it. `null` when there is no such process.
 */
export interface ProcState {
  /** Field 3 of `/proc/<pid>/stat`: R, S, D, Z, X, … */
  readonly state: string;
  /** Field 22: start time in clock ticks since boot — together with the pid, which process this is. */
  readonly startTicks: number;
  /** SIGKILL is in the process's pending set: the kill was sent, the kernel has not finished it yet. */
  readonly killPending: boolean;
}

export function procState(pid: number): ProcState | null {
  const read = (file: string): string | null => {
    try {
      return readFileSync(`/proc/${pid}/${file}`, "utf8");
    } catch {
      return null;
    }
  };
  const stat = read("stat");
  if (stat === null) return null;
  const status = read("status") ?? "";
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const fields = stat.slice(close + 2).split(" ");
  // Signal 9 is bit 8 of the masks. SigPnd is the thread's own pending set, ShdPnd the group's.
  const pending = (name: string): boolean => {
    const hex = new RegExp(`^${name}:\\s*([0-9a-f]+)$`, "m").exec(status)?.[1];
    return hex !== undefined && (BigInt(`0x${hex}`) & 0x100n) !== 0n;
  };
  return { state: fields[0] ?? "?", startTicks: Number(fields[19]), killPending: pending("SigPnd") || pending("ShdPnd") };
}

/**
 * Has the process that was `pid` at `startTicks` been ended — gone, reaped and reused, a zombie, or with
 * SIGKILL already pending so that it cannot run another instruction of its own?
 *
 * A killed process whose parent has not reaped it yet still has a `/proc` entry, and on a loaded runner
 * that window is not short. Asking "is the entry gone?" then fails a kill that worked.
 */
export function ended(pid: number, startTicks: number): boolean {
  const now = procState(pid);
  return now === null || now.startTicks !== startTicks || now.state === "Z" || now.state === "X" || now.killPending;
}

/** Does the process ignore `signal` (its number) — the `SigIgn` mask of `/proc/<pid>/status`? */
export function ignores(pid: number, signal: number): boolean {
  try {
    const hex = /^SigIgn:\s*([0-9a-f]+)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    return hex !== undefined && (BigInt(`0x${hex}`) & (1n << BigInt(signal - 1))) !== 0n;
  } catch {
    return false;
  }
}
