/**
 * S5.4 AC3 — *test พิสูจน์ว่าหยุดได้จริงกลางงาน* — and AC2, which is the half
 * that decides how this file is written.
 *
 * AC2 says the kill switch must work **even when the main agent is stuck**, so
 * `mind stop` is run here as a **separate process** against a `turn` that is
 * still going. Nothing is shared between them but the filesystem, which is the
 * whole claim.
 *
 * The stub vendor is what makes the mid-flight moment observable: it waits, and
 * *then* writes a file. So `did-it` existing afterwards means the turn ran to
 * completion, and `did-it` never existing means it was stopped while it was
 * still running. That is a fact about a file, not about a clock.
 *
 * ## D-028 — nothing here is asserted against the machine's speed
 *
 * Every wait is `while (!condition) await sleep(…)` with a bound that exists to
 * catch a structural break, never a busy machine. The one number that is
 * genuinely load-dependent — how long the stop took — is **printed with the
 * load average** and asserted about by nothing.
 *
 * ## Nothing here touches the real home
 *
 * `HOME`, `XDG_STATE_HOME` and `XDG_DATA_HOME` are temporary directories in
 * every case, and the PATH holds one symlink to `bun` plus the stub. Every
 * process this file signals is one it started, through `mind`, in that
 * sandbox.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { procStat, runsRoot } from "../../src/decide/runs.ts";
import { STOP_FILE } from "../../src/decide/stop.ts";
import { stateRoot } from "../../src/state.ts";
import { barePath, BUN, expectNoVendorOn } from "../support/bare-path.ts";
import { waitFor } from "../support/wait.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");

/** A port nothing listens on, so the local backend is genuinely unavailable. */
const NO_OLLAMA = "http://127.0.0.1:1";

const scratch: string[] = [];
const started: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    try {
      child.kill("SIGKILL");
      await child.exited;
    } catch {
      // Already gone — which is what most of these cases are about.
    }
  }
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * A stub `claude` that waits, then proves it finished.
 *
 * The wait is long enough that the turn is certainly still in flight when the
 * stop lands, and the *proof* is the file rather than the time: a turn that was
 * stopped never reaches the write, whatever the machine was doing.
 */
/** A vendor that ignores SIGTERM — what D-044's SIGKILL is for. */
const IGNORE_TERM = 'process.on("SIGTERM", () => {});';

function stubSource(marker: string, stubborn: boolean): string {
  return `#!/usr/bin/env bun
import { renameSync, writeFileSync } from "node:fs";
// The handler first: the pid file is the test's signal that this stub is ready to be stopped, so a stop can
// never arrive before a stubborn stub has started ignoring SIGTERM.
${stubborn ? IGNORE_TERM : ""}
// Its own pid and start, so the test can check this exact process is gone. Written whole, under a temporary
// name first, so a test that sees the file never reads it half-written.
writeFileSync(${JSON.stringify(`${marker}.pid.tmp`)}, String(process.pid));
renameSync(${JSON.stringify(`${marker}.pid.tmp`)}, ${JSON.stringify(`${marker}.pid`)});
// Alive for long enough that nothing here races. Nothing asserts on it.
await Bun.sleep(30000);
writeFileSync(${JSON.stringify(marker)}, "the turn ran to completion\\n");
console.log(JSON.stringify({ result: "finished" }));
`;
}

interface Harness {
  readonly home: string;
  readonly state: string;
  readonly path: string;
  readonly marker: string;
  readonly env: Record<string, string>;
}

async function harness(stubborn = false): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "mind-stop-cli-"));
  scratch.push(home);

  const bare = await barePath(home);
  expectNoVendorOn(bare);

  const stubs = join(home, "bin");
  await mkdir(stubs, { recursive: true });
  const marker = join(home, "did-it");
  const claude = join(stubs, "claude");
  await writeFile(claude, stubSource(marker, stubborn));
  await chmod(claude, 0o755);

  const state = join(home, "state");
  return {
    home,
    state,
    marker,
    path: `${stubs}:${bare}`,
    env: {
      HOME: home,
      PATH: `${stubs}:${bare}`,
      XDG_STATE_HOME: state,
      XDG_DATA_HOME: join(home, "data"),
      CODEX_HOME: join(home, ".codex"),
      OLLAMA_HOST: NO_OLLAMA,
    },
  };
}

function spawnCli(harness: Harness, args: readonly string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: ROOT,
    env: harness.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  started.push(child);
  return child;
}

async function runCli(harness: Harness, args: readonly string[]) {
  const child = spawnCli(harness, args);
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/**
 * Poll until `done`, giving up only after a minute. The bound catches a break, never a busy machine (D-028):
 * a count of attempts was a budget of wall-clock time in disguise, and a loaded runner spends it in oversleeps.
 */
const until = (done: () => boolean | Promise<boolean>): Promise<boolean> => waitFor(done, { within: 60_000, every: 25 });

/**
 * Is there anything at this path — file or directory?
 *
 * `stat` and not `Bun.file(path).exists()`: the latter answers **false** for a
 * directory, which would have made every check below pass for the wrong reason.
 * The same trap `test/scripts/cli-parity.test.ts` names about its fixtures.
 */
async function exists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The stub wrote its pid; wait until that exact process is no longer there. */
async function vendorGone(box: Harness): Promise<void> {
  const pid = Number(await Bun.file(`${box.marker}.pid`).text());
  expect(pid).toBeGreaterThan(1);
  const start = procStat(pid)?.startTicks;
  const gone = await until(() => {
    const now = procStat(pid);
    return now === null || now.startTicks !== start;
  });
  expect(gone, `vendor pid ${pid} is still running after stop`).toBe(true);
}

describe("AC3 — a turn really is stopped while it is running", () => {
  test("`mind stop`, as its own process, ends a turn mid-flight", async () => {
    const box = await harness();

    // (a) Start a turn. It will sit inside the stub for thirty seconds.
    const turn = spawnCli(box, [
      "turn",
      SOUL,
      "--subject",
      "example",
      "--prompt",
      "anything at all",
    ]);

    // (b) Wait for the run record — the thing that did not exist before S5.4,
    // and without which there is nothing for a kill switch to find. Polled,
    // never timed.
    const runs = runsRoot({ home: box.home, env: box.env });
    const recordAppeared = await until(async () => {
      const dir = join(runs, "example");
      if (!(await exists(dir))) return false;
      const { readdirSync } = await import("node:fs");
      return readdirSync(dir).length > 0;
    });
    expect(recordAppeared, "no run record appeared, so there was nothing to stop").toBe(true);

    // The vendor process really is running, and it really is a grandchild: the
    // turn spawned it, and this test spawned the turn.
    const vendorAlive = await until(() => {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      return readdirSync("/proc")
        .filter((name) => /^\d+$/.test(name))
        .map((name) => procStat(Number(name)))
        .some((stat) => stat !== null && stat.ppid === turn.pid);
    });
    expect(vendorAlive, "the turn never spawned a vendor process").toBe(true);

    // (c) Stop, from a **different process**. AC2: nothing is shared with the
    // turn but the filesystem.
    const startedAt = performance.now();
    const stop = await runCli(box, ["stop"]);
    const tookMs = Math.round(performance.now() - startedAt);

    // (d) The turn is gone, and so is the vendor process under it.
    expect(await until(() => turn.exitCode !== null || turn.killed)).toBe(true);

    // (d2) The vendor itself — not only the turn — is gone. Read by its own
    // pid and start time, so a reused number cannot pass for it (S5.4 AC3).
    await vendorGone(box);

    // (e) The assertion that is about the *work* rather than about a process:
    // the stub's file never appeared, so the turn never reached the end.
    expect(await exists(box.marker)).toBe(false);

    // (f) And the brake is on, so the next one will not start either.
    expect(await exists(join(stateRoot(box.home, box.env), STOP_FILE))).toBe(true);

    // (g) The record for the turn it ended is gone with it.
    expect(stop.stdout).toContain("everything this record named is gone");
    expect(stop.stdout).toContain("subject example");
    expect(stop.code).toBe(0);

    // Load-dependent, so printed rather than asserted (D-028): what this number
    // measures is how busy the machine is, not whether the switch works.
    console.log(
      `  stop took ${tookMs}ms · 1-minute load average ${loadavg()[0]!.toFixed(2)} — ` +
        `not asserted, because it depends on what else this machine is doing.`,
    );
  }, 120_000);
});

describe("AC2 — a vendor that ignores SIGTERM is still stopped (D-044)", () => {
  test("SIGTERM, then SIGKILL to what is still the same process, and it is gone", async () => {
    const box = await harness(true);
    const turn = spawnCli(box, ["turn", SOUL, "--subject", "example", "--prompt", "anything"]);

    // The stub writes its pid only once its SIGTERM handler is in, so from here the signal cannot beat it.
    expect(await until(async () => exists(`${box.marker}.pid`)), "the stub never started").toBe(true);

    const stop = await runCli(box, ["stop"]);

    expect(stop.stdout).toContain("SIGTERM");
    expect(stop.stdout).toContain("SIGKILL");
    await vendorGone(box);
    expect(await until(() => turn.exitCode !== null || turn.killed)).toBe(true);
    expect(await exists(box.marker)).toBe(false);
    expect(stop.stdout).toContain("everything this record named is gone");
  }, 120_000);
});

describe("AC1 — one command lowers every category and ends what is running", () => {
  test("it sets the brake, zeroes the dial, and says what it could not reach", async () => {
    const box = await harness();
    const agent = join(box.home, "agent");
    await mkdir(agent, { recursive: true });

    const stop = await runCli(box, ["stop", agent, "--subject", "example"]);
    expect(stop.code).toBe(0);

    // 1 — the brake, first, because it is the step that cannot really fail.
    expect(stop.stdout).toContain("1. the brake");
    expect(await exists(join(stateRoot(box.home, box.env), STOP_FILE))).toBe(true);

    // 2 — the dial, every category at 0, in a file `git diff` will show.
    expect(stop.stdout).toContain("every category set to 0");
    const dial = await Bun.file(join(agent, "autonomy.md")).text();
    for (const line of ["read = 0", "write = 0", "run = 0", "reach = 0"]) {
      expect(dial).toContain(line);
    }
    expect(dial).toContain("set_by");

    // 3 — the turns, of which there are none, said as a fact rather than a zero.
    expect(stop.stdout).toContain("3. turns that are running");
    expect(stop.stdout).toContain("none recorded");

    // …and the limits, in the command's own output rather than in a document.
    expect(stop.stdout).toContain("What this command cannot do:");
    expect(stop.stdout).toContain("Ctrl-C");
    expect(stop.stdout).toContain("kill -TERM -");
  }, 60_000);
});

describe("layer one does not need Mind at all", () => {
  test("a brake set with a plain file write refuses the next turn before it spawns", async () => {
    const box = await harness();

    // Set by writing the file directly — no Mind code involved, which is the
    // property AC2 is about. If this only worked through `mind stop`, the
    // brake would depend on the program it exists to stop.
    await mkdir(stateRoot(box.home, box.env), { recursive: true });
    await writeFile(join(stateRoot(box.home, box.env), STOP_FILE), "");

    const turn = await runCli(box, [
      "turn",
      SOUL,
      "--subject",
      "example",
      "--prompt",
      "anything at all",
    ]);

    // Refused, with its own exit code so a loop can tell "told not to" from
    // "that one failed, try again".
    expect(turn.code).toBe(4);
    expect(turn.stderr).toContain("nothing was sent");
    expect(turn.stderr).toContain("the autonomy dial is at 0");

    // The proof that it was refused *before* anything spawned: the stub writes
    // its marker at the end of a turn, and there was no turn.
    expect(await exists(box.marker)).toBe(false);
    // …and no run record was written either, because nothing ran.
    expect(await exists(runsRoot({ home: box.home, env: box.env }))).toBe(false);
  }, 60_000);

  test("and the same turn runs once the file is gone — the control", async () => {
    // Without this, the case above would pass just as happily over a `turn`
    // that had stopped working for some other reason entirely.
    const box = await harness();
    const stopFile = join(stateRoot(box.home, box.env), STOP_FILE);
    await mkdir(stateRoot(box.home, box.env), { recursive: true });
    await writeFile(stopFile, "");
    expect((await runCli(box, ["turn", SOUL, "--subject", "example", "--prompt", "x"])).code).toBe(4);

    await rm(stopFile);
    // The stub sleeps for thirty seconds, so this turn is killed by the harness
    // rather than completed — what is asserted is that it got as far as
    // spawning one, which the refusal above did not.
    const turn = spawnCli(box, ["turn", SOUL, "--subject", "example", "--prompt", "x"]);
    const spawned = await until(() => {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      return readdirSync("/proc")
        .filter((name) => /^\d+$/.test(name))
        .map((name) => procStat(Number(name)))
        .some((stat) => stat !== null && stat.ppid === turn.pid);
    });
    expect(spawned, "with the brake off the turn must reach the vendor").toBe(true);
  }, 120_000);
});
