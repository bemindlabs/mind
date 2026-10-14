/**
 * S3.5 AC2, layer C — the criterion's own words, checked at the syscall.
 *
 * Layers A and B (`no-network.test.ts`) read Mind's source and replace
 * Mind's globals. Both are arguments about the code in this repository. This
 * layer makes no such assumption: it runs the real CLI as a real process and
 * asks the kernel, through `strace`, whether that process ever called
 * `socket`, `connect` or `sendto`. A socket opened by a transitive dependency,
 * by the runtime, or by code that arrived some way the AST never saw is
 * visible here and nowhere else.
 *
 * ## Why it fails rather than skips when strace is missing
 *
 * A skip is a green tick for a check that did not run, and this is the only
 * layer that would notice a socket the other two are blind to. If strace is
 * unavailable the honest outcome is a red test naming what could not be
 * checked. (Measured on the machine this was written on: `/usr/bin/strace`
 * exists and `kernel.yama.ptrace_scope=1`, which permits tracing a child of
 * the tracing process — which is the only thing done here.)
 *
 * ## The baseline, measured rather than assumed
 *
 * `bun run` on a script that does nothing produces **no** `socket`, `connect`
 * or `sendto` line at all — measured 2026-09-21 on bun 1.4.2. So the assertion
 * for the observer commands is "none", not "no more than the runtime's own",
 * and the first test below re-measures that baseline on every run rather than
 * trusting the sentence you are reading. If a future bun opens an `AF_UNIX`
 * socket at start, that test goes red and says so — which is the right way to
 * find out, rather than an allowance quietly written in now.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { announceCapture, ensureObserverDir } from "../../src/observer/index.ts";
import { subjectId } from "../../src/types.ts";
import { BUN } from "../support/bare-path.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SUBJECT = subjectId("example");

/** Resolved once: its absence is a failure, asserted below, never a skip. */
const STRACE = Bun.which("strace");

/** The three syscalls that are the start of every way bytes leave a host. */
const TRACED = "socket,connect,sendto";
const SYSCALL = /\b(socket|connect|sendto)\(/;

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-strace-"));
  scratch.push(dir);
  return dir;
}

interface Traced {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The whole trace file, for a failure message worth reading. */
  readonly trace: string;
  /** Only the lines that are one of {@link TRACED}. */
  readonly sockets: string[];
}

/**
 * Run `argv` under strace and return what the kernel saw.
 *
 * `-f` follows every child, so a subprocess opening a socket would be counted
 * against the command that started it — which is the point: "the observer
 * cannot spawn" and "the observer cannot connect" are the same claim here.
 */
async function traced(
  dir: string,
  name: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<Traced> {
  const out = join(dir, `${name}.trace`);
  const child = Bun.spawn([STRACE!, "-f", "-qq", "-e", `trace=${TRACED}`, "-o", out, ...argv], {
    cwd: dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;

  const trace = await Bun.file(out)
    .text()
    .catch(() => "");
  return {
    code: child.exitCode ?? -1,
    stdout,
    stderr,
    trace,
    sockets: trace.split("\n").filter((line) => SYSCALL.test(line)),
  };
}

/** A home and a data root of this test's own. The real one is never read. */
function sandboxEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: dirname(BUN),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    // Would otherwise be inherited, and it is the one variable that could
    // point this run's ollama — and therefore a socket — somewhere real.
    OLLAMA_HOST: "",
  };
}

describe("C. strace — what the kernel saw", () => {
  test("strace is present, so this layer runs rather than skipping", () => {
    expect(
      STRACE,
      "strace is required: it is the only layer that can see a socket the AST and the in-process " +
        "traps are both blind to. Install it rather than skipping this file.",
    ).toBeString();
  });

  test("the baseline: bun itself opens nothing, and a fetch really is caught", async () => {
    const dir = await sandbox();
    const env = sandboxEnv(dir);

    await Bun.write(join(dir, "quiet.ts"), "process.exitCode = 0;\n");
    await Bun.write(
      join(dir, "noisy.ts"),
      'try { await fetch("http://127.0.0.1:1/", { signal: AbortSignal.timeout(500) }); } catch {}\n',
    );

    // The floor. Everything below is compared against this, and it is
    // re-measured here rather than written down as a constant.
    const quiet = await traced(dir, "quiet", [BUN, "run", join(dir, "quiet.ts")], env);
    expect(quiet.code).toBe(0);
    expect(quiet.sockets).toEqual([]);

    // The control. Without it, "no socket lines" would also be what a broken
    // strace invocation, an unwritable trace file or a typo in `-e` produces.
    const noisy = await traced(dir, "noisy", [BUN, "run", join(dir, "noisy.ts")], env);
    expect(noisy.sockets.length).toBeGreaterThan(0);
    expect(noisy.trace).toContain("AF_INET");
  }, 60_000);

  test("`observe status` opens no socket", async () => {
    const dir = await sandbox();
    const env = sandboxEnv(dir);

    const run = await traced(
      dir,
      "status",
      [BUN, "run", BIN, "observe", "status", "--subject", SUBJECT],
      env,
    );

    expect(run.code, run.stderr).toBe(0);
    // Proof the command did its work rather than exiting early on a usage
    // error, which would open no socket for an uninteresting reason.
    expect(run.stdout).toContain(join("mind", SUBJECT, "personal", "observer"));
    expect(run.stdout).toContain("What this does not reach:");
    expect(run.sockets, run.trace).toEqual([]);
  }, 60_000);

  test("`observe purge` opens no socket, with data there for it to delete", async () => {
    const dir = await sandbox();
    const env = sandboxEnv(dir);

    const created = await ensureObserverDir(
      { home: dir, env: { XDG_DATA_HOME: join(dir, "data") } },
      SUBJECT,
      announceCapture(() => undefined),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await Bun.write(join(created.path, "raw.jsonl"), '{"what":"typed"}\n{"what":"ran"}\n');

    const run = await traced(
      dir,
      "purge",
      [BUN, "run", BIN, "observe", "purge", "--subject", SUBJECT],
      env,
    );

    expect(run.code, run.stderr).toBe(0);
    // The deleting path is the one worth tracing, so assert it deleted.
    expect(run.stdout).toContain("removed 1 file(s)");
    expect(run.stdout).toContain("remaining: 0 file(s)");
    expect(run.sockets, run.trace).toEqual([]);
  }, 60_000);
});
