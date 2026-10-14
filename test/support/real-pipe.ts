/**
 * Run the CLI with its stdout on a **pipe(2)**, the way a person's shell does.
 *
 * Every other test in this repository, and `scripts/cli-parity.ts` with it,
 * starts the engine with `Bun.spawn({ stdout: "pipe" })`. Measured under bun
 * 1.4.2, that is not the same thing as a shell pipeline: one program printing
 * 20001 bytes in a single `console.log` arrives whole through `Bun.spawn` and
 * can arrive **cut to 8192 bytes, with no error anywhere**, through
 * `sh -c '… | cat'` — but only once something in the process has read
 * `process.stdout`. `bin/shared.ts` read `process.stdout.isTTY` at import, so
 * every command was exposed and no test could see it.
 *
 * "Can", because it is a race a busy machine loses rather than a fixed ceiling:
 * the same probe was measured whole 40/40 on a quiet machine and cut 15/15 on
 * the same machine beside other bun processes. `test/cli/streams.test.ts` has
 * the numbers and prints a fresh set on every run.
 *
 * So the pipe here is a real one. The child's stdout is the write end of a
 * pipeline whose reader is `cat`; what `cat` forwards is what this returns.
 *
 * ## Why the exit code needs a file
 *
 * A pipeline's status is the status of its *last* command, and `cat` almost
 * never fails. `pipefail` is bash, and `/bin/sh` here may be dash. So the
 * left-hand side writes `$?` — the engine's own code, taken before anything
 * else runs — to a file this function then reads. The alternative, printing it
 * on one of the two streams, would put a byte in the output being measured.
 *
 * ## `sh` and `cat` are required, and their absence is red
 *
 * Not skipped. A guard that quietly opts out on a machine without `cat` is a
 * guard that is not running, which is the state this whole file exists to end.
 * {@link runThroughPipe} throws a message that says *which* tool is missing, so
 * a red run on such a machine is not mistaken for a red run about the engine.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PipedRun {
  /** The engine's exit code — not the pipeline's. */
  readonly code: number;
  /** Everything `cat` forwarded, which is everything that survived the pipe. */
  readonly stdout: string;
  /** stderr, inherited straight from the shell and never through `cat`. */
  readonly stderr: string;
}

export interface PipeOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

/**
 * Where `sh` and `cat` are, resolved once from *this* process's PATH.
 *
 * Absolute, so the child's PATH can stay the deliberately bare one the rest of
 * the suite builds (`test/support/bare-path.ts`): a guard that had to put
 * `/usr/bin` on the child's PATH would quietly undo I-1's "no vendor CLI is
 * reachable" precondition in order to test something else.
 */
const SH = Bun.which("sh");
const CAT = Bun.which("cat");

/**
 * The left side of the pipeline, as one `sh -c` script.
 *
 * `$1` is the file the engine's exit code is written to and `$2` is `cat`'s
 * absolute path; `"$@"` after the two shifts is the command line. Nothing here
 * is interpolated — the argv arrives as arguments, so no path or flag can be
 * read as shell syntax.
 */
const SCRIPT = 'code_file=$1; cat_bin=$2; shift 2; { "$@"; echo $? > "$code_file"; } | "$cat_bin"';

/** Run `argv` with stdout on a real pipe. Throws if `sh` or `cat` is missing. */
export async function runThroughPipe(
  argv: readonly string[],
  options: PipeOptions = {},
): Promise<PipedRun> {
  if (SH === null || CAT === null) {
    const missing = [SH === null ? "sh" : undefined, CAT === null ? "cat" : undefined]
      .filter((name) => name !== undefined)
      .join(" and ");
    throw new Error(
      `this machine has no ${missing} on PATH, so a real pipe cannot be built and the check ` +
        `that depends on one did not run. This is red because the tool is missing, not because ` +
        `Mind printed the wrong thing — nothing here has been measured either way.`,
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "mind-pipe-"));
  const codeFile = join(dir, "code");
  try {
    const child = Bun.spawn([SH, "-c", SCRIPT, "sh", codeFile, CAT, ...argv], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env ?? {},
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;

    const written = (await readFile(codeFile, "utf8").catch(() => "")).trim();
    const code = written === "" ? -1 : Number(written);
    return { code, stdout, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
