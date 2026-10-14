/**
 * **A command that is asked how does not do.**
 *
 * This file exists because of one measurement, taken on 2026-09-22 against the
 * tree E5 left behind. Somebody ran `mind stop` to find out whether the
 * command existed, then ran `mind stop --help` to find out how to use it —
 * and the second run **set the brake a second time**, on a real machine. It was
 * withdrawn and nothing was lost, but the shape of the failure is worth more
 * than the incident: `--help` is not in `stop`'s boolean list, so `parseArgs`
 * filed it as an option nothing reads, the positional list came back empty, and
 * `cmdStop` ran exactly as if it had been typed bare. Nothing was malformed
 * enough to refuse. The command that exists to stop a runaway was thrown by
 * somebody asking it how it worked.
 *
 * The same measurement, swept over every verb the entry point dispatches, found
 * `stop` was the only one — fourteen answered with a usage error and one acted.
 * That is not a reason to fix only `stop`: the next state-changing command will
 * be written by somebody who does not know this happened, so the rule is
 * enforced in front of the `switch`, once, and asked here about **every verb the
 * entry point dispatches** rather than about a list kept by hand.
 *
 * ## What makes this a guard rather than a claim
 *
 * The detector is *"the state root and the data root do not exist afterwards"*,
 * and a detector that cannot see a write would pass over a program that wrote
 * constantly. So the last describe block runs the same detector over `mind
 * stop` **without** `--help` and requires it to go the other way. Without that
 * control, every assertion in this file is as true of a broken sandbox.
 *
 * ## Nothing here touches the real home
 *
 * Every spawn gets its own temporary `HOME`, `XDG_STATE_HOME` and
 * `XDG_DATA_HOME`, and a PATH holding one symlink to `bun` — checked by
 * {@link expectNoVendorOn} to hold no vendor CLI, so nothing this file starts
 * can reach a network or an account.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asksForHelp, helpFor, HELP_FLAGS } from "../../bin/shared.ts";
import { USAGE } from "../../bin/usage.ts";
import { STOP_FILE } from "../../src/decide/stop.ts";
import { stateRoot } from "../../src/state.ts";
import { caseLabels } from "../support/ast.ts";
import { barePath, BUN, expectNoVendorOn } from "../support/bare-path.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const ENTRY = join(ROOT, "bin", "mind.ts");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Box {
  readonly home: string;
  readonly env: Record<string, string>;
}

async function sandbox(): Promise<Box> {
  const home = await mkdtemp(join(tmpdir(), "mind-help-"));
  scratch.push(home);
  const bare = await barePath(home);
  expectNoVendorOn(bare);
  return {
    home,
    env: {
      HOME: home,
      PATH: bare,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      CODEX_HOME: join(home, ".codex"),
      // A port nothing listens on, so no probe can reach a local model either.
      OLLAMA_HOST: "http://127.0.0.1:1",
    },
  };
}

async function runCli(box: Box, args: readonly string[]) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: ROOT,
    env: box.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** Anything at this path — file *or* directory. `Bun.file().exists()` says no to a directory. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Did mind write anything about this machine?
 *
 * Both roots, because the two halves of Mind's state live apart on purpose
 * (D-025): the ledger, the brake, the run records and the backups are under the
 * state root, and observer capture is under the data root. A check that watched
 * one would be blind to a command that wrote to the other.
 *
 * Deliberately *not* the whole sandbox `HOME`: bun writes its own install cache
 * under `$HOME/.bun` on every run, and a vendor CLI would write its own caches
 * too. Those are not Mind's writes and counting them would make this test
 * about bun.
 */
async function wroteState(box: Box): Promise<string[]> {
  const found: string[] = [];
  const state = stateRoot(box.home, box.env);
  const data = join(box.home, "data", "mind");
  if (await exists(state)) found.push(state);
  if (await exists(data)) found.push(data);
  return found;
}

/** Every verb the entry point really dispatches, aliases and `help` aside. */
async function verbs(): Promise<string[]> {
  return caseLabels(ENTRY, await readFile(ENTRY, "utf8"), ["command"]).filter(
    (label) => !label.startsWith("-") && label !== "help",
  );
}

describe("the parser, on prose it must read and prose it must not", () => {
  test("a help flag is recognised wherever it sits, and nothing else is one", () => {
    expect(asksForHelp(["--help"])).toBe(true);
    expect(asksForHelp(["-h"])).toBe(true);
    // Anywhere, because `mind stop ./agent --subject x --help` is the same
    // question as `mind stop --help`, and a first-token rule would have
    // answered the first of those by stopping the machine.
    expect(asksForHelp(["./agent", "--subject", "x", "--help"])).toBe(true);
    expect(asksForHelp([])).toBe(false);
    expect(asksForHelp(["--helpful"])).toBe(false);
    expect(asksForHelp(["-help"])).toBe(false);
    // A token that merely contains the word is not the flag: a prompt is a
    // single argv entry, so `--prompt "explain --help to me"` stays a turn.
    expect(asksForHelp(["--prompt", "explain --help to me"])).toBe(false);
    expect(HELP_FLAGS).toContain("--help");
  });

  test("after a bare --, a help flag is `memory ask`'s question — and still a help flag for every other command", () => {
    // `memory ask`: everything after `--` is the question (D-152).
    expect(asksForHelp(["ask", "./agent", "--", "--help"], "memory")).toBe(false);
    expect(asksForHelp(["ask", "./agent", "--", "-h"], "memory")).toBe(false);
    expect(asksForHelp(["ask", "./agent", "--help", "--", "q"], "memory")).toBe(true);
    // Everyone else: a `--` changes nothing, so a command asked how still does nothing.
    expect(asksForHelp(["--", "--help"], "stop")).toBe(true);
    expect(asksForHelp(["./agent", "--", "-h"], "turn")).toBe(true);
    expect(asksForHelp(["search", "./agent", "--", "--help"], "memory")).toBe(true);
    expect(asksForHelp(["--", "--help"])).toBe(true);
  });

  test("helpFor slices the entry for a verb and stops at the next one", () => {
    const synthetic = [
      "mind 0.0.0 — x",
      "",
      "Usage:",
      "  mind frobnicate [--twice]           Do the thing, and then",
      "                                        say what was done.",
      "  mind widget polish <dir>            Polish it",
      "  mind widget tarnish <dir>           Un-polish it",
      "  mind help                           This message",
      "",
      "Prose below the list mentioning `mind frobnicate` again.",
      "",
      "Not built yet (see .scrum/backlog.md):",
      "  mind frobnicate twice     Two of them     [S9.9]",
    ].join("\n");

    const frobnicate = helpFor(synthetic, "frobnicate")!;
    expect(frobnicate).toContain("Do the thing, and then");
    // The description's second line belongs to the entry…
    expect(frobnicate).toContain("say what was done.");
    // …and the next entry does not.
    expect(frobnicate).not.toContain("Polish it");
    // Prose below the list is not part of any entry, and neither is a line
    // under `Not built yet` — offering `frobnicate twice` as help for a
    // command nothing dispatches is the direction that wastes somebody's hour.
    expect(frobnicate).not.toContain("Prose below the list");
    expect(frobnicate).not.toContain("Two of them");

    // A verb takes all of its subcommands with it.
    const widget = helpFor(synthetic, "widget")!;
    expect(widget).toContain("Polish it");
    expect(widget).toContain("Un-polish it");
    expect(widget).not.toContain("Do the thing");

    // A verb the text does not describe is `undefined`, not an empty page —
    // the entry point needs to tell those apart, because the second is how a
    // typo would get answered with silence and exit 0.
    expect(helpFor(synthetic, "neverwritten")).toBeUndefined();
    expect(helpFor(synthetic, "frob")).toBeUndefined();
  });

  test("every verb the CLI dispatches has an entry in the real help text", async () => {
    const missing = (await verbs()).filter((verb) => helpFor(USAGE, verb) === undefined);
    expect(
      missing.map(
        (verb) =>
          `mind ${verb} — dispatched, and helpFor found no entry for it in bin/usage.ts, ` +
          `so \`mind ${verb} --help\` falls through to \`unknown command\`.`,
      ),
    ).toEqual([]);

    // Control: the list is populated and the slicing really returns prose,
    // rather than both halves being empty.
    const found = await verbs();
    expect(found.length).toBeGreaterThan(10);
    expect(found).toContain("stop");
    expect(helpFor(USAGE, "stop")).toContain("Stop everything");
  });
});

describe("asked how, every command answers and none of them acts", () => {
  test("`<verb> --help` exits 0, prints that verb's usage, and writes nothing", async () => {
    const all = await verbs();
    expect(all.length).toBeGreaterThan(10);

    const results = await Promise.all(
      all.map(async (verb) => {
        const box = await sandbox();
        const run = await runCli(box, [verb, "--help"]);
        return { verb, run, wrote: await wroteState(box) };
      }),
    );

    // Reported as one list rather than one failing case, so a change that
    // breaks the rule names every command it broke it for.
    expect(
      results
        .filter(({ run }) => run.code !== 0)
        .map(({ verb, run }) => `mind ${verb} --help exited ${run.code}, not 0`),
    ).toEqual([]);

    expect(
      results
        .filter(({ run, verb }) => !run.stdout.includes(`mind ${verb}`))
        .map(({ verb }) => `mind ${verb} --help printed no usage line for itself`),
    ).toEqual([]);

    expect(
      results
        .filter(({ wrote }) => wrote.length > 0)
        .map(
          ({ verb, wrote }) =>
            `mind ${verb} --help changed this machine: it wrote ${wrote.join(", ")}. ` +
            `A command that is asked how must not do.`,
        ),
    ).toEqual([]);

    // And the sentence that says so is in the output, so the person who typed
    // it is told rather than left to infer it from the absence of a report.
    expect(
      results.filter(({ run }) => !run.stdout.includes("Nothing was done.")).map(({ verb }) => verb),
    ).toEqual([]);
  }, 180_000);

  test("the incident itself: `stop --help` leaves no brake, in either position", async () => {
    // The two command lines that were actually typed on 2026-09-22, and the
    // one that would have been typed next.
    for (const argv of [
      ["stop", "--help"],
      ["stop", "-h"],
      ["stop", "./somewhere", "--subject", "example", "--help"],
      // A `--` in front changes nothing for stop: only `memory ask` reads words after it as a value.
      ["stop", "--", "--help"],
      ["stop", "./somewhere", "--", "-h"],
    ]) {
      const box = await sandbox();
      const run = await runCli(box, argv);
      expect(run.code, argv.join(" ")).toBe(0);
      expect(await exists(join(stateRoot(box.home, box.env), STOP_FILE)), argv.join(" ")).toBe(false);
      // It did not merely fail to write — it answered the question.
      expect(run.stdout).toContain("mind stop");
      expect(run.stdout).not.toContain("1. the brake");
    }
  }, 120_000);

  test("a verb nothing dispatches is still `unknown command`, not an empty page", async () => {
    // `--help` must not become a way of making a typo exit 0. There is no entry
    // for `frobnicate`, so the entry point falls through to its `default`.
    const box = await sandbox();
    const run = await runCli(box, ["frobnicate", "--help"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("unknown command");
  }, 60_000);

  test("`mind help --help` is still the whole help text", async () => {
    // The one verb excluded from the rule, because slicing the `help` entry out
    // of the help text and printing that instead would be a joke at the
    // expense of the person who typed it.
    const box = await sandbox();
    const run = await runCli(box, ["help", "--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage:");
    expect(run.stdout).toContain("mind erase");
    expect(run.stdout).toContain("mind stop");
  }, 60_000);
});

describe("the control — the detector above can see a write when there is one", () => {
  test("`mind stop` with no help flag does set the brake, in the same sandbox", async () => {
    // Without this case the block above is as true of a detector that looks in
    // the wrong directory, or of a sandbox in which mind cannot write at all.
    const box = await sandbox();
    const run = await runCli(box, ["stop"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("1. the brake");
    expect(await exists(join(stateRoot(box.home, box.env), STOP_FILE))).toBe(true);

    // …and the detector the other cases use says so too, in its own words.
    expect(await wroteState(box)).not.toEqual([]);
  }, 60_000);
});
