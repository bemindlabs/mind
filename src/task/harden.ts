/**
 * A task's runner holds its browser's release key in memory (D-156). On Linux, `/proc/<pid>/mem` of a process is
 * readable by its ancestors under Yama ptrace_scope 1 — and a turn that started `mind task new` in the
 * foreground is the runner's ancestor (review of PR #24, round 2). `prctl(PR_SET_DUMPABLE, 0)` gives the
 * runner's `/proc/<pid>/mem`, `environ` and `fd` to root, so no other process of the owner's uid — its
 * ancestors included — can read them.
 *
 * Through `bun:ffi` to libc, the one way Bun reaches `prctl`. Off Linux there is no such call: said, not faked.
 */

const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

export type Harden = { readonly ok: true } | { readonly ok: false; readonly reason: string };

async function prctl(option: number, value: bigint): Promise<number> {
  const { dlopen, FFIType } = await import("bun:ffi");
  const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
  try {
    return libc.symbols.prctl(option, value, 0n, 0n, 0n);
  } finally {
    libc.close();
  }
}

/** Make this process not dumpable. */
export async function notDumpable(platform: string = process.platform, call: typeof prctl = prctl): Promise<Harden> {
  if (platform !== "linux") return { ok: false, reason: `prctl(PR_SET_DUMPABLE) is Linux's; this is ${platform}` };
  try {
    const result = await call(PR_SET_DUMPABLE, 0n);
    return result === 0 ? { ok: true } : { ok: false, reason: `prctl(PR_SET_DUMPABLE, 0) returned ${result}` };
  } catch (cause) {
    return { ok: false, reason: `prctl could not be called (${cause instanceof Error ? cause.message : String(cause)})` };
  }
}

/** `prctl(PR_GET_DUMPABLE)`: 1 or 0 on Linux, `null` elsewhere or when it cannot be asked. */
export async function dumpable(platform: string = process.platform): Promise<number | null> {
  if (platform !== "linux") return null;
  try {
    return await prctl(PR_GET_DUMPABLE, 0n);
  } catch {
    return null;
  }
}
