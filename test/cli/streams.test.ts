/**
 * Which stream a byte lands on — measured first, then enforced.
 *
 * Under bun 1.4.2 a `console` method called with **no arguments** writes its
 * lone newline to **stdout**, whichever stream that method is documented to
 * use. `console.error()` as a blank-line spacer therefore does two wrong things
 * at once: it appends a blank line to the output somebody is piping, and it
 * puts nothing at all in front of the message it was written to separate.
 *
 * This is not a claim taken from a changelog. {@link MEASURED} below spawns a
 * child per method and reads the two pipes, so the rule this file enforces is
 * exactly as wide as what was watched happen — `console.debug()` also lands on
 * stdout and is *not* banned, because stdout is where `debug` is supposed to go.
 * The day bun fixes this, the canary goes red and says so; the fix is to delete
 * the rule, not to re-green the canary.
 *
 * ## The rule, and how a spacer is decided
 *
 * stderr exists to carry a reason, so its first byte should be a reason. At a
 * spacer, look at what the same run has already written to stderr:
 *
 * - something already there → the blank line is a separator *within* stderr,
 *   and `console.error("")` is how to write it (with the argument, it really
 *   does go to stderr — asserted below);
 * - nothing there yet → the blank line was separating stderr from stdout on a
 *   terminal. That is the terminal's business and not the stream's, and the
 *   spacer is deleted.
 *
 * ## The second measured fact: a long write through a pipe, and a race
 *
 * Added by odd3, and it is about the same two streams. Under bun 1.4.2 on
 * Linux, **reading the `process.stdout` getter can change what that stream then
 * does**: after the read, one `console.log` longer than {@link SURVIVED} bytes
 * into a real pipe(2) can arrive cut to exactly that many bytes, silently, with
 * no error and no short write reported. `bin/shared.ts` read
 * `process.stdout.isTTY` at import, so every command was exposed —
 * `mind help | less` showed 8192 of its 17363 bytes and stopped just after
 * `erase`'s usage line — and no test could see it, because `Bun.spawn`'s
 * "pipe" is not a pipe(2) and delivers all 20001 bytes either way.
 *
 * **"Can", not "does", and that is the whole shape of it.** The same probe on
 * the same machine on 2026-09-22 came back whole 40 times out of 40 while the
 * machine was quiet — including under a CPU busy loop, and at every requested
 * size from 8000 to 65536 — and cut 15 times out of 15 while `npm test` was
 * running, and 15 out of 15 with half a dozen other bun processes about. So
 * 8192 is not a ceiling the runtime declares; it is how much got through before
 * the process ended, and whether anything is lost at all is a race that busy
 * machines lose. That makes it *worse* than a fixed limit, not better: it is
 * invisible to anyone who tries it once on an idle laptop and concludes there
 * is no problem, and it bites in CI and during a parallel run, which is to say
 * while somebody is working.
 *
 * It also decides what this file may assert. The two things that are true in
 * both conditions — `isatty(1)` and touching nothing deliver every byte — are
 * asserted. What the getter does is **measured and printed on every run, red or
 * green, with the machine's state beside it**, in the shape
 * `scripts/check-coverage.ts` prints the half of the repository it cannot see.
 * A test whose colour tracks the load average is a test people stop believing
 * inside a week, and red has to mean something broke, not that something might
 * have improved.
 *
 * What is known here is behaviour: nobody read bun's source, and no other OS or
 * bun release has been measured. If the printed report ever shows every run
 * whole under load, that is a prompt for a person to measure it by hand and
 * consider deleting the rule — not for this file to delete it.
 *
 * ## What the checker cannot see
 *
 * {@link bareConsoleCalls} matches the shape `console.<method>()` and nothing
 * else. An alias, `console["error"]()`, `.call`/`.apply`, the method passed as
 * a value, and a local binding named `console` are all invisible to it — each
 * one is *demonstrated* below rather than merely admitted, so the size of the
 * guard is a measured fact for whoever reads it next. Compile-time enforcement
 * was considered and is not possible: declaration merging can add an overload
 * to `Console["error"]` but cannot withdraw the zero-argument one, and a
 * wrapper helper does not stop anybody from typing the original.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { bareConsoleCalls, memberReads, sourceFiles } from "../support/ast.ts";
import { runThroughPipe } from "../support/real-pipe.ts";
import { git, GIT_ENV } from "../support/trap-git.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SUBJECT = "example";

/** Assembled at run time (D-021): no string shaped like a live credential is committed here. */
const AWS_KEY = "AK" + "IA" + "ABCDEFGHIJKLMNOP";

const scratch: string[] = [];

afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// The canary: what this runtime actually does
// ---------------------------------------------------------------------------

/**
 * The methods measured, and where each one is *documented* to write.
 *
 * `log`, `info` and `debug` are stdout methods; `error`, `warn` and `trace` are
 * stderr methods. The second group is the interesting one — for those, landing
 * on stdout is a fault. The first group is the control: if the measurement
 * below ever showed one of *them* on stderr, the measurement itself would be
 * what to distrust.
 */
const DOCUMENTED = {
  log: "stdout",
  info: "stdout",
  debug: "stdout",
  error: "stderr",
  warn: "stderr",
  trace: "stderr",
} as const;

type Method = keyof typeof DOCUMENTED;

/**
 * The methods {@link bareConsoleCalls} is asked about, in `bin/`, `src/`,
 * `scripts/`, `test/` and `notes/`.
 *
 * Every stderr method, and no stdout one. A rule that banned more than was
 * measured would be a rule people route around; `console.debug()` writing to
 * stdout is `console.debug` working.
 */
const MISROUTED: readonly Method[] = ["error", "warn", "trace"];

interface Streams {
  readonly stdout: string;
  readonly stderr: string;
}

/** Run one expression in a child bun and read both pipes separately. */
async function evaluate(expression: string): Promise<Streams> {
  const child = Bun.spawn([process.execPath, "-e", expression], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "" },
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { stdout, stderr };
}

/** Measured once, read by several assertions. */
const MEASURED = new Map<Method, Streams>();

async function measure(method: Method): Promise<Streams> {
  const cached = MEASURED.get(method);
  if (cached !== undefined) return cached;
  const streams = await evaluate(`console.${method}()`);
  MEASURED.set(method, streams);
  return streams;
}

describe("the canary — argument-less console methods, on this runtime", () => {
  test("every stderr method writes its newline to stdout instead", async () => {
    const wrong: string[] = [];
    for (const method of MISROUTED) {
      const { stdout, stderr } = await measure(method);
      if (stdout === "" || stderr !== "") wrong.push(`${method}: stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
    }

    // If this is red, read it as good news and then do the work: bun has
    // started routing argument-less calls to the documented stream, so the
    // reason for the ban is gone. Remove the offending method from MISROUTED,
    // and `console.error("")` at the guard's spacers may go back to
    // `console.error()` — or, better, stay as it is, since the empty string
    // says out loud that a byte is meant.
    expect(
      wrong,
      `bun ${Bun.version} no longer misroutes these; MISROUTED is now wider than what is measured`,
    ).toEqual([]);
  }, 30_000);

  test("the control: the stdout methods land on stdout, which is not a fault", async () => {
    for (const method of ["log", "info", "debug"] as const) {
      const { stdout, stderr } = await measure(method);
      expect(DOCUMENTED[method], method).toBe("stdout");
      expect(stdout, method).toBe("\n");
      expect(stderr, method).toBe("");
      // …and so they are deliberately absent from the ban.
      expect(MISROUTED as readonly string[], method).not.toContain(method);
    }
  }, 30_000);

  test("`console.error()` writes exactly one newline, and it is on stdout", async () => {
    const { stdout, stderr } = await measure("error");
    expect(stdout).toBe("\n");
    expect(stderr).toBe("");
  }, 30_000);

  test("an argument is all it takes — `console.error(\"\")` really is a stderr byte", async () => {
    const empty = await evaluate('console.error("")');
    expect(empty.stderr).toBe("\n");
    expect(empty.stdout).toBe("");

    const text = await evaluate('console.error("reason")');
    expect(text.stderr).toBe("reason\n");
    expect(text.stdout).toBe("");
  }, 30_000);

  test("the compiled binary does the same thing — so the rule is not source-only", async () => {
    // `bun build --compile` is the only other way this engine is ever run
    // (`scripts/demo-bare-container.sh` ships it), and a runtime quirk is
    // exactly the kind of thing that could differ between the two. Measured
    // rather than assumed.
    const dir = await sandbox("mind-streams-compile-");
    const source = join(dir, "spacer.ts");
    const binary = join(dir, "spacer");
    await writeFile(source, 'console.error();\nconsole.error("reason");\n');

    const build = Bun.spawn([process.execPath, "build", source, "--compile", "--outfile", binary], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env["PATH"] ?? "", HOME: dir },
    });
    const failure = await new Response(build.stderr).text();
    await build.exited;
    expect(build.exitCode, failure).toBe(0);

    const child = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe", env: { PATH: "" } });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;

    expect(stdout).toBe("\n");
    expect(stderr).toBe("reason\n");
  }, 180_000);
});

// ---------------------------------------------------------------------------
// The second canary: a long line through a pipe, and the part that is a race
// ---------------------------------------------------------------------------

/**
 * How many bytes survive when the cut happens — observed, never required.
 *
 * Every truncated run measured on 2026-09-22 came back at exactly this, for
 * every requested size from 8192 to 200000, so it reads like a limit. It is
 * not one: on the same machine, idle, nothing was lost at any size. Treat it
 * as "how much got out before the process ended", which is why it appears in
 * the report below and in no assertion about the `touches` probe.
 */
const SURVIVED = 8192;

/** Longer than {@link SURVIVED} by enough that no rounding could explain a short read. */
const LONG = 20000;

/** A whole write, as the reader counts it: the line, plus the newline `console.log` adds. */
const WHOLE = LONG + 1;

/** Runs per probe per condition. One run says nothing about something that is a race. */
const RUNS = 4;

/** Bun processes started beside the measurement, to lose the race on purpose. */
const RIVALS = 3;

/**
 * What a rival does: allocate and parse in a loop, with a deadline of its own.
 *
 * A plain CPU spin was measured *not* to provoke the truncation on a quiet
 * machine; what did was other bun processes. So the rivals are bun, and they do
 * work a runtime notices rather than arithmetic a compiler could hoist. The
 * deadline is a safety net — {@link underLoad} kills them — so that a crashed
 * run cannot leave three of them burning a core each.
 */
const RIVAL_WORK =
  "const until = Date.now() + 60000;\n" +
  "while (Date.now() < until) JSON.parse(JSON.stringify({ n: Math.random(), s: 'x'.repeat(256) }));\n";

/** Three programs that differ only in how they ask whether stdout is a terminal. */
const PROBES = {
  /** Reads the getter. This is what `bin/shared.ts` did, and what can truncate. */
  touches: `void (process.stdout.isTTY === true);\nconsole.log("x".repeat(${LONG}));\n`,
  /** Asks the same question of the file descriptor. This is what it does now. */
  isatty: `import { isatty } from "node:tty";\nvoid isatty(1);\nconsole.log("x".repeat(${LONG}));\n`,
  /** Asks nobody. The control that says the truncation is about the getter. */
  neither: `console.log("x".repeat(${LONG}));\n`,
} as const;

type Probe = keyof typeof PROBES;

/** Write one probe to disk and return its path. */
async function probeFile(dir: string, probe: Probe): Promise<string> {
  const path = join(dir, `${probe}.ts`);
  await writeFile(path, PROBES[probe]);
  return path;
}

/** One probe, `runs` times, through a real pipe. Returns the byte count of each. */
async function throughPipe(dir: string, probe: Probe, runs: number): Promise<number[]> {
  const sizes: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const ran = await runThroughPipe([process.execPath, "run", await probeFile(dir, probe)], {
      env: { PATH: process.env["PATH"] ?? "", HOME: dir },
    });
    expect(ran.code, `${probe}: ${ran.stderr}`).toBe(0);
    sizes.push(ran.stdout.length);
  }
  return sizes;
}

/** The same, through the `Bun.spawn` "pipe" every other test in the repository uses. */
async function throughSpawn(dir: string, probe: Probe, runs: number): Promise<number[]> {
  const sizes: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const child = Bun.spawn([process.execPath, "run", await probeFile(dir, probe)], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env["PATH"] ?? "", HOME: dir },
    });
    const stdout = await new Response(child.stdout).text();
    await child.exited;
    sizes.push(stdout.length);
  }
  return sizes;
}

/**
 * Run `body` with {@link RIVALS} other bun processes working beside it.
 *
 * The truncation is a race, and a race measured only on an idle machine is
 * measured in the one condition where it does not happen. So the busy condition
 * is made here rather than waited for — which is also the only way the report
 * below can say anything about whether the rule could be withdrawn.
 */
async function underLoad<T>(body: () => Promise<T>): Promise<T> {
  const rivals = Array.from({ length: RIVALS }, () =>
    Bun.spawn([process.execPath, "-e", RIVAL_WORK], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: process.env["PATH"] ?? "" },
    }),
  );
  try {
    return await body();
  } finally {
    for (const rival of rivals) rival.kill();
    for (const rival of rivals) await rival.exited;
  }
}

describe("the canary — a long line through a pipe a person could have typed", () => {
  test("with `isatty(1)`, and with nothing read at all, every byte arrives", async () => {
    // The deterministic half, and the only half worth a red: these two were
    // whole in every condition anyone has measured — quiet, under a CPU spin,
    // under `npm test`, under six rival bun processes. They are what the fix in
    // `bin/shared.ts` buys, so if either goes short, something really did break.
    const dir = await sandbox("mind-streams-pipe-");
    for (const probe of ["isatty", "neither"] as const) {
      const quiet = await throughPipe(dir, probe, RUNS);
      expect(quiet, `${probe}, ${RUNS} run(s) with nothing else started`).toEqual(
        Array<number>(RUNS).fill(WHOLE),
      );
      const busy = await underLoad(() => throughPipe(dir, probe, RUNS));
      expect(busy, `${probe}, ${RUNS} run(s) beside ${RIVALS} rival bun process(es)`).toEqual(
        Array<number>(RUNS).fill(WHOLE),
      );
    }
  }, 240_000);

  test("what reading `process.stdout` does here is measured and printed, not required", async () => {
    const dir = await sandbox("mind-streams-report-");
    const alone = await throughPipe(dir, "touches", RUNS);
    const busy = await underLoad(() => throughPipe(dir, "touches", RUNS));
    const spawned = await throughSpawn(dir, "touches", RUNS);
    const control = await throughSpawn(dir, "neither", RUNS);

    const allWhole = [...alone, ...busy].every((size) => size === WHOLE);
    const oneMinute = loadavg()[0] ?? 0;
    const report = [
      `a long single write (${LONG} bytes) through a real pipe, on this machine, this run:`,
      `  process.stdout read, no rivals   ${alone.join(" ")}`,
      `  process.stdout read, +${RIVALS} rivals   ${busy.join(" ")}   (bun processes this test started)`,
      `  the same, through Bun.spawn      ${spawned.join(" ")}   (the transport every other test uses)`,
      `  whole would be ${WHOLE}; a cut run has always left exactly ${SURVIVED}`,
      `  load average ${oneMinute.toFixed(2)} over ${cpus().length} cpu(s) — and "no rivals" still means`,
      `  inside a bun test run, which is itself load: neither row is an idle machine.`,
      allWhole
        ? `  Every run above was whole — which is NOT permission to delete the ban below. The same` +
          `\n  probe was measured cut 15/15 on 2026-09-22 with other bun processes about and whole` +
          `\n  40/40 minutes later on the same machine, so an all-whole report is what a lucky run` +
          `\n  looks like, not what a fixed runtime looks like. Measure it by hand under a real` +
          `\n  parallel run before withdrawing anything; this test will not withdraw it, and will` +
          `\n  not go red to ask.`
        : `  The read still loses bytes here, so the ban below is still earning its place.`,
    ];
    // Printed before the one assertion below and on every run, red or green,
    // the way `scripts/check-coverage.ts` prints the half of the repository it
    // cannot judge: what cannot be required can still be said out loud.
    for (const line of report) console.error(line);

    // The instrument, and the only assertion here. A program that reads neither
    // getter came back whole through `Bun.spawn` in every condition measured;
    // if that stopped being true, the rows above would be unreadable and this
    // test would be printing numbers that meant nothing while presenting them
    // as if they did. Nothing in this test asserts what `touches` did.
    expect(control, "Bun.spawn lost bytes for a program that reads neither getter").toEqual(
      Array<number>(RUNS).fill(WHOLE),
    );
  }, 300_000);

  test("the compiled engine prints the whole help text through a pipe", async () => {
    // Measured rather than inferred from a two-line file: `bun build --compile`
    // is how `scripts/demo-bare-container.sh` ships this, every module is
    // flattened into the executable, and a runtime quirk is exactly the kind of
    // thing that could differ between the two. Before odd3 this arrived cut at
    // 8192 bytes, ending mid-page one line after `mind erase <subject>`.
    const dir = await sandbox("mind-streams-help-");
    const binary = join(dir, "mind");
    const build = Bun.spawn(
      [process.execPath, "build", BIN, "--compile", "--outfile", binary],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { PATH: process.env["PATH"] ?? "", HOME: dir } },
    );
    const failure = await new Response(build.stderr).text();
    await build.exited;
    expect(build.exitCode, failure).toBe(0);

    const piped = await runThroughPipe([binary, "help"], { env: { PATH: "", HOME: dir } });
    expect(piped.code, piped.stderr).toBe(0);
    expect(piped.stdout.length).toBeGreaterThan(SURVIVED);
    expect(piped.stdout).toContain("mind erase <subject>");
    expect(piped.stdout).toContain("mind soul revoke");
  }, 300_000);
});

// ---------------------------------------------------------------------------
// The checker, and both of its controls
// ---------------------------------------------------------------------------

describe("what bareConsoleCalls sees", () => {
  test("it catches every banned method, by line", () => {
    const source = [
      "console.error();",
      'console.error("kept");',
      "console.warn();",
      "console.trace();",
      "console.log();",
    ].join("\n");

    expect(bareConsoleCalls("synthetic.ts", source, MISROUTED)).toEqual([
      "1: console.error()",
      "3: console.warn()",
      "4: console.trace()",
    ]);
  });

  test("the control, the other way: what it must not flag", () => {
    const source = [
      '// A comment about console.error() is not a call to it.',
      'const advice = "write console.error() and the newline goes to stdout";',
      'console.error("");',
      'console.error("reason");',
      "console.log();",
      "console.info();",
      "console.debug();",
    ].join("\n");

    expect(bareConsoleCalls("synthetic.ts", source, MISROUTED)).toEqual([]);
  });

  test("the holes, demonstrated rather than admitted", () => {
    // Each of these reaches the same misrouted newline and the checker returns
    // nothing for it. Written down here so the next reader knows the size of
    // the guard, not merely that there is one.
    const holes = [
      "const say = console.error; say();",
      'console["error"]();',
      "console.error.call(console);",
      "console.error.apply(console, []);",
      "[1].forEach(console.error);",
      "const console2 = { error: () => {} }; console2.error();",
    ];
    for (const source of holes) {
      expect(bareConsoleCalls("synthetic.ts", source, MISROUTED), source).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The rule, over the whole repository
// ---------------------------------------------------------------------------

/**
 * Lines allowed to keep a bare call, each with the reason it needs one.
 *
 * Empty, and the shape matters more than the contents: an exemption costs a
 * line and a written reason, the same way `EXEMPT` does in
 * `scripts/check-coverage.ts`. Cutting a whole directory out of the scan would
 * cost nothing and teach nothing — which is why `test/` and `notes/` are in it
 * even though neither has ever had a hit. Somebody copying an idiom out of a
 * test file into `bin/` should meet the rule in the file they copied from.
 */
const EXEMPT = new Map<string, string>();

/** Every `.ts` file this rule covers. */
async function scanned(): Promise<string[]> {
  const dirs = ["bin", "src", "scripts", "test", "notes"];
  const found: string[] = [];
  for (const dir of dirs) found.push(...(await sourceFiles(join(ROOT, dir))));
  return found.sort();
}

describe("no bare call to a misrouted console method, anywhere", () => {
  test("the scan covers the whole engine and its tools", async () => {
    const files = (await scanned()).map((path) => relative(ROOT, path));

    // Guards the gate's own scope: a scan that silently went empty would make
    // the assertion below vacuously true, which is the failure mode of every
    // whole-tree check in this repository.
    expect(files.length).toBeGreaterThan(60);
    expect(files).toContain(join("bin", "commands", "erase.ts"));
    expect(files).toContain(join("bin", "commands", "guard.ts"));
    expect(files).toContain(join("bin", "commands", "observe.ts"));
    expect(files).toContain(join("scripts", "cli-parity.ts"));
    expect(files).toContain(join("notes", "odd2-driver.ts"));
    expect(files).toContain(join("test", "cli", "streams.test.ts"));
  }, 30_000);

  test("every hit is either gone or exempted with a reason", async () => {
    const hits: string[] = [];
    for (const path of await scanned()) {
      const rel = relative(ROOT, path);
      const source = await Bun.file(path).text();
      for (const hit of bareConsoleCalls(path, source, MISROUTED)) {
        const at = `${rel}:${hit.split(":")[0]}`;
        if (!EXEMPT.has(at)) hits.push(`${rel}:${hit}`);
      }
    }
    expect(hits).toEqual([]);
  }, 30_000);

  test("an exemption that no longer names a real line fails rather than lingers", async () => {
    const live = new Set<string>();
    for (const path of await scanned()) {
      const rel = relative(ROOT, path);
      const source = await Bun.file(path).text();
      for (const hit of bareConsoleCalls(path, source, MISROUTED)) {
        live.add(`${rel}:${hit.split(":")[0]}`);
      }
    }
    for (const [at, reason] of EXEMPT) {
      expect(live.has(at), `${at} is exempted ("${reason}") and has no bare call on it`).toBe(true);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The second rule: neither getter is read in the engine at all
// ---------------------------------------------------------------------------

/**
 * The two members of `process` no file under `bin/` or `src/` may read.
 *
 * `process.stdin` is **not** here: it was measured beside the other two and was
 * never seen to cost a byte, and `observe enable` genuinely has to ask whether
 * a person is at the keyboard. A rule wider than the measurement is a rule
 * people route around.
 *
 * Reading is the whole offence. `process.stdout.write` was not seen to lose its
 * own output — but reaching it means reading the getter, and a later
 * `console.log` in that process is then the one at risk. So the member access
 * is what is refused, not any particular call on it.
 *
 * The rule is wider than any single run's evidence on purpose. Whether the read
 * costs bytes depends on how busy the machine is, so "I tried it and it was
 * fine" is the expected result of trying it once and no reason to read the
 * getter: see the report the canary above prints on every run.
 */
const FORBIDDEN_STREAMS: readonly string[] = ["stdout", "stderr"];

/**
 * Lines allowed to read one anyway, each with the reason it must.
 *
 * Empty, and shaped like {@link EXEMPT} above and `EXEMPT` in
 * `scripts/check-coverage.ts` for the same reason: an exemption costs a line
 * and a written reason. `scripts/` is outside this scan — `cli-parity.ts`
 * writes progress with `process.stderr.write` and is a tool, not the engine —
 * and `test/` is outside it because a test that needs the getter is measuring
 * the getter, which is what this file does.
 */
const STREAM_EXEMPT = new Map<string, string>();

/** Every `.ts` file the getter ban covers: the engine, and only the engine. */
async function engineFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const dir of ["bin", "src"]) found.push(...(await sourceFiles(join(ROOT, dir))));
  return found.sort();
}

describe("no file in the engine reads process.stdout or process.stderr", () => {
  test("the scan covers bin/ and src/, and is not empty", async () => {
    const files = (await engineFiles()).map((path) => relative(ROOT, path));
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain(join("bin", "shared.ts"));
    expect(files).toContain(join("bin", "commands", "observe.ts"));
    expect(files).toContain(join("src", "observer", "consent.ts"));
  });

  test("every read is either gone or exempted with a reason", async () => {
    const hits: string[] = [];
    for (const path of await engineFiles()) {
      const rel = relative(ROOT, path);
      const source = await Bun.file(path).text();
      for (const hit of memberReads(path, source, "process", FORBIDDEN_STREAMS)) {
        const at = `${rel}:${hit.split(":")[0]}`;
        if (!STREAM_EXEMPT.has(at)) hits.push(`${rel}:${hit}`);
      }
    }
    expect(
      hits,
      "reading either getter can cut a later long console write short through a pipe — " +
        "measured under bun 1.4.2, silently, and only when the machine is busy, so an idle " +
        "run proves nothing. Ask `isatty(1)`/`isatty(2)` from `node:tty` instead.",
    ).toEqual([]);
  });

  test("an exemption that no longer names a real read fails rather than lingers", async () => {
    const live = new Set<string>();
    for (const path of await engineFiles()) {
      const rel = relative(ROOT, path);
      const source = await Bun.file(path).text();
      for (const hit of memberReads(path, source, "process", FORBIDDEN_STREAMS)) {
        live.add(`${rel}:${hit.split(":")[0]}`);
      }
    }
    for (const [at, reason] of STREAM_EXEMPT) {
      expect(live.has(at), `${at} is exempted ("${reason}") and reads neither getter`).toBe(true);
    }
  });

  test("the control: the checker does see one when there is one", async () => {
    // The rule is only worth anything if it bites, and `memberReads` is shared
    // with three other gates — a change there could make this vacuous without
    // touching this file. Synthetic source, both directions.
    const caught = [
      "const t = process.stdout.isTTY;",
      "process.stderr.write('x');",
      "if (process.stdout.columns > 80) {}",
    ].join("\n");
    expect(memberReads("synthetic.ts", caught, "process", FORBIDDEN_STREAMS)).toEqual([
      "1: process.stdout",
      "2: process.stderr",
      "3: process.stdout",
    ]);

    const allowed = [
      "// process.stdout in a comment is not a read of it",
      'const advice = "never touch process.stdout";',
      "const tty = process.stdin.isTTY === true;",
      "const pid = process.pid;",
      "const home = process.env.HOME;",
    ].join("\n");
    expect(memberReads("synthetic.ts", allowed, "process", FORBIDDEN_STREAMS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What the rule is for: the commands, run for real
// ---------------------------------------------------------------------------

interface Ran extends Streams {
  readonly code: number;
}

async function run(home: string, args: readonly string[], stdin?: string): Promise<Ran> {
  const child = Bun.spawn([process.execPath, "run", BIN, ...args], {
    cwd: ROOT,
    env: {
      HOME: home,
      PATH: process.env["PATH"] ?? "",
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      MIND_QDRANT_URL: "http://127.0.0.1:9",
      ...GIT_ENV,
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

async function makeAgent(home: string): Promise<string> {
  const parent = await sandbox("mind-streams-agents-");
  const made = await run(home, ["new", "example", "--subject", SUBJECT, "--dir", parent]);
  expect(made.code, made.stderr).toBe(0);
  return join(parent, "example");
}

describe("guard scan — the stream that is piped stays empty", () => {
  test("a blocked commit writes zero bytes to stdout", async () => {
    const home = await sandbox("mind-streams-home-");
    const agent = await makeAgent(home);
    await writeFile(join(agent, "memory", "notes.md"), `aws_key = ${AWS_KEY}\n`);
    expect((await git(agent, ["add", "-A"])).code).toBe(0);

    const blocked = await run(home, ["guard", "scan", "--staged", agent]);

    expect(blocked.code).toBe(1);
    // The whole point of the command's header comment: stdout belongs to
    // whoever piped this. Three bare spacers used to put `\n\n\n` here.
    expect(blocked.stdout).toBe("");
    expect(blocked.stderr).toContain("commit blocked");
    // …and the separators are on stderr, where the block they separate is, so
    // `2> guard.log` keeps a readable file rather than one solid paragraph.
    expect(blocked.stderr).toContain("\n\n");
    expect(blocked.stderr.startsWith("\n")).toBe(false);
  }, 60_000);

  test("a passing scan writes zero bytes to stdout too", async () => {
    const home = await sandbox("mind-streams-home-");
    const agent = await makeAgent(home);
    await writeFile(join(agent, "memory", "notes.md"), "nothing secret here\n");
    expect((await git(agent, ["add", "-A"])).code).toBe(0);

    const passed = await run(home, ["guard", "scan", "--staged", agent]);

    expect(passed.code).toBe(0);
    expect(passed.stdout).toBe("");
  }, 60_000);
});

describe("the commands whose first stderr byte is a reason", () => {
  test("observe enable, refused: no blank line leads either stream", async () => {
    const home = await sandbox("mind-streams-home-");
    const refused = await run(home, ["observe", "enable", "--subject", SUBJECT], "");

    expect(refused.code).toBe(1);
    expect(refused.stderr.startsWith("mind: ")).toBe(true);
    // Exactly one blank line at the end, not two. The remaining one is the
    // deliberate `console.log()` after the capture notice, which is a stdout
    // spacer written on the stream it belongs to; the one that is gone is the
    // bare `console.error()` that landed on the same stream by accident.
    expect(refused.stdout.endsWith("\n\n")).toBe(true);
    expect(refused.stdout.endsWith("\n\n\n")).toBe(false);
  }, 60_000);

  test("erase, refused before anything is deleted: the refusal is the first line", async () => {
    const home = await sandbox("mind-streams-home-");
    const agent = await makeAgent(home);
    // A reserved address with data at it. `src/erase/plan.ts` has no deleter
    // for this and refuses the whole run rather than certifying around it.
    await Bun.write(join(agent, ".mind", "adapters", "lora.bin"), "weights\n");

    const refused = await run(home, ["erase", SUBJECT, "--agent", agent, "--by", "tester"]);

    expect(refused.code).toBe(1);
    expect(refused.stderr.startsWith("mind: ")).toBe(true);
    expect(refused.stderr).toContain("S6.3");
    // The plan is on stdout and ends where it ends.
    expect(refused.stdout.endsWith("\n\n")).toBe(false);
  }, 60_000);

  test("erase, verdict erased-with-remainder: the verdict is the first line", async () => {
    const home = await sandbox("mind-streams-home-");
    const agent = await makeAgent(home);
    // Committed, so the search after the deletion still finds the identifier
    // and the verdict is neither `erased-and-verified` nor `nothing-found` —
    // the one branch that ends at the last spacer in bin/commands/erase.ts.
    await writeFile(join(agent, "memory", "note.md"), `worked with ${SUBJECT} on the migration\n`);
    expect((await git(agent, ["add", "-A"])).code).toBe(0);
    expect((await git(agent, ["commit", "-q", "-m", "note"])).code).toBe(0);

    const erased = await run(home, ["erase", SUBJECT, "--agent", agent, "--by", "tester", "--yes"]);

    expect(erased.code).toBe(1);
    expect(erased.stderr.startsWith("mind: verdict ")).toBe(true);
    expect(erased.stderr).not.toContain("nothing-found");
    // Nothing is appended to the certificate a reader is keeping.
    expect(erased.stdout.endsWith("\n\n")).toBe(false);
  }, 60_000);
});
