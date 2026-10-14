/**
 * `bin/shared.ts` — the one thing in it that can be wrong while everything
 * stays green.
 *
 * `ENGINE_ROOT` is `resolve(import.meta.dir, "..")`, and under
 * `bun build --compile` every module is flattened into the executable, so that
 * expression answers with a path inside a virtual filesystem. Nothing crashes.
 * Nothing is red. `doctor` simply scanned a directory that is not there, read
 * nothing, found nothing, and printed `ok`.
 *
 * {@link checkoutRoot} is the answer, and it is tested here rather than only
 * through the binary because the rule it encodes is worth arguing with on its
 * own: *is the engine's source where this process thinks it is?* — asked as
 * evidence on disk, never as a test on what the virtual path happens to be
 * called. `test/cli/binary.test.ts` is the other half, and builds a real
 * binary to check the answer end to end.
 *
 * ## And the rest of the file, called rather than spawned
 *
 * Everything else here is a function that takes values and returns them, and
 * every one of them was reached only through `Bun.spawn` of the CLI — which
 * bun does not measure, so `bin/shared.ts` read 29.21% while eight commands
 * leaned on it. {@link parseArgs} is the one that most deserves its own test:
 * its `booleans` list exists because `--apply ./soul` without it swallows the
 * directory into the flag and the positional vanishes silently, and "silently"
 * is not something a spawned end-to-end test notices either.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir, uptime } from "node:os";
import { join, resolve } from "node:path";
import { isatty } from "node:tty";
import {
  ENGINE_CHECKOUT,
  ERR,
  OUT,
  bold,
  boldErr,
  checkoutRoot,
  dim,
  dimErr,
  indent,
  ledgerEnv,
  parseArgs,
  printPlaceNotices,
  report,
  usageError,
} from "../../bin/shared.ts";
import { PLACE_IDS, placeOf } from "../../src/erase/index.ts";
import type { SoulIssue } from "../../src/soul/index.ts";

const ROOT = resolve(import.meta.dir, "..", "..");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * Run something that writes to stderr, and hand back what it wrote.
 *
 * `report` and `usageError` return an exit code *and* print, and the printing
 * is the half a caller cannot check. Swapped rather than spied on so the lines
 * do not also land in the test runner's output, where a reader would have to
 * decide whether each one is a failure.
 */
function captureErr<T>(run: () => T): { readonly value: T; readonly lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { value: run(), lines };
  } finally {
    console.error = original;
  }
}

/** Directories that exist, as an injected answer — no filesystem needed. */
function present(...paths: readonly string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

/**
 * The real predicate, for the cases that ask the filesystem instead.
 *
 * A missing path and a path that is a file both answer `false`, which is the
 * distinction the "a *file* called `bin`" case below exists to pin: the engine
 * needs `bin/` to be a directory, and `statSync` throwing is the same answer as
 * it returning something that is not one.
 */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

describe("checkoutRoot — is the engine's source really there", () => {
  test("a root with both src/ and bin/ under it is the checkout", () => {
    const root = join("/", "somewhere", "mind");
    expect(checkoutRoot(root, present(join(root, "src"), join(root, "bin")))).toBe(root);
  });

  test("either one missing is not a checkout — half an engine is not the engine", () => {
    const root = join("/", "somewhere", "mind");
    expect(checkoutRoot(root, present(join(root, "src")))).toBeUndefined();
    expect(checkoutRoot(root, present(join(root, "bin")))).toBeUndefined();
    expect(checkoutRoot(root, () => false)).toBeUndefined();
  });

  test("the virtual root a compiled binary resolves to has nothing under it", () => {
    // The shape `bun build --compile` produces. It is named here as an input
    // and never as a rule: the string belongs to one version of one runtime on
    // one OS, and the check has to keep working when it changes.
    expect(checkoutRoot("/$bunfs/root", () => false)).toBeUndefined();
  });

  test("it asks the filesystem, not the spelling of the path", () => {
    // The same virtual-looking root, with the two directories really present,
    // is a checkout — because the question is what is on disk. This is what
    // keeps the rule honest for a checkout that has been moved or packaged.
    const odd = "/$bunfs/root";
    expect(checkoutRoot(odd, present(join(odd, "src"), join(odd, "bin")))).toBe(odd);
  });

  test("against a real directory, it answers from what is actually written", async () => {
    const root = await mkdtemp(join(tmpdir(), "mind-checkout-"));
    scratch.push(root);
    expect(checkoutRoot(root, isDir)).toBeUndefined();
    await mkdir(join(root, "src"), { recursive: true });
    expect(checkoutRoot(root, isDir)).toBeUndefined();
    // A *file* called `bin` is not the engine's `bin/`, and the check says so.
    await writeFile(join(root, "bin"), "not a directory\n");
    expect(checkoutRoot(root, isDir)).toBeUndefined();
    await rm(join(root, "bin"));
    await mkdir(join(root, "bin"), { recursive: true });
    expect(checkoutRoot(root, isDir)).toBe(root);
  });
});

describe("ENGINE_CHECKOUT", () => {
  test("run from this checkout, it is this repository", () => {
    // The control for every "it is undefined in the binary" assertion
    // elsewhere: if this were undefined too, those would pass for free.
    expect(ENGINE_CHECKOUT).toBe(ROOT);
  });
});

describe("parseArgs — the two spellings, and the flag that takes no value", () => {
  test("`--key value` and `--key=value` mean the same thing", () => {
    const spaced = parseArgs(["--subject", "alpha-keeper"]);
    const equals = parseArgs(["--subject=alpha-keeper"]);
    expect([...spaced.options]).toEqual([["subject", "alpha-keeper"]]);
    expect([...equals.options]).toEqual([...spaced.options]);
    expect(spaced.positional).toEqual([]);
  });

  test("a value is only taken when the flag is not declared a boolean", () => {
    // The failure this list exists for, written as the two readings of one
    // command line. Without `booleans`, `./soul` is the value of `--apply` and
    // the command is handed no directory at all — which for a command that
    // writes files is the worst available outcome, because nothing says so.
    const wrong = parseArgs(["--apply", "./soul"]);
    expect(wrong.options.get("apply")).toBe("./soul");
    expect(wrong.positional).toEqual([]);

    const right = parseArgs(["--apply", "./soul"], ["apply"]);
    expect(right.options.get("apply")).toBe("");
    expect(right.positional).toEqual(["./soul"]);
  });

  test("a flag with nothing after it, and a flag followed by another flag", () => {
    // Both are a flag with no value, and neither may eat the next token.
    expect([...parseArgs(["--subject"]).options]).toEqual([["subject", ""]]);
    const two = parseArgs(["--subject", "--json"]);
    expect([...two.options]).toEqual([["subject", ""], ["json", ""]]);
    expect(two.positional).toEqual([]);
  });

  test("`--key=` is an empty value, not a missing one, and `=` in the value survives", () => {
    expect(parseArgs(["--out="]).options.get("out")).toBe("");
    expect(parseArgs(["--prompt=a=b=c"]).options.get("prompt")).toBe("a=b=c");
  });

  test("positionals keep their order, and a later flag does not disturb them", () => {
    const { positional, options } = parseArgs(
      ["soul", "verify", "./dir", "--subject", "alpha-keeper", "--json", "tail"],
      ["json"],
    );
    expect(positional).toEqual(["soul", "verify", "./dir", "tail"]);
    expect(options.get("subject")).toBe("alpha-keeper");
    expect(options.get("json")).toBe("");
  });

  test("the last spelling of a repeated flag wins, and nothing throws", () => {
    // Not a rule anyone designed — a fact about the Map, asserted so that
    // changing it is a decision rather than a surprise at a call site.
    expect(parseArgs(["--subject", "a", "--subject=b"]).options.get("subject")).toBe("b");
    expect(parseArgs([]).positional).toEqual([]);
  });
});

describe("what the CLI prints when something is wrong", () => {
  const issue = (over: Partial<SoulIssue> = {}): SoulIssue => ({
    file: "role.md",
    line: 4,
    path: "scope.does",
    message: "must be one sentence",
    ...over,
  });

  test("report prints every issue, then the count, and asks for exit 1", () => {
    const { value, lines } = captureErr(() => report([issue(), issue({ line: 9, path: "" })]));
    expect(value).toBe(1);
    expect(lines).toEqual([
      "role.md:4: scope.does — must be one sentence",
      "role.md:9: must be one sentence",
      "\n2 problems.",
    ]);
  });

  test("one problem is singular, and no problems is still a count", () => {
    expect(captureErr(() => report([issue()])).lines.at(-1)).toBe("\n1 problem.");
    // Nobody calls it with an empty list today. If someone does, it must not
    // print `0 problem` and then hand back a failing exit code silently — the
    // count is there, and the 1 is asserted so the shape is a decision.
    const empty = captureErr(() => report([]));
    expect(empty.lines).toEqual(["\n0 problems."]);
    expect(empty.value).toBe(1);
  });

  test("usageError is exit 2, and says who is speaking", () => {
    // 2, not 1: a command line this CLI cannot read is a different answer from
    // a soul this CLI read and rejected, and `test/cli/` asserts both codes.
    const { value, lines } = captureErr(() => usageError("soul verify needs a directory"));
    expect(value).toBe(2);
    expect(lines).toEqual(["mind: soul verify needs a directory"]);
  });
});

describe("indent", () => {
  test("every line gets the prefix, including blank ones and the last", () => {
    expect(indent("a\n\nb", "  ")).toBe("  a\n  \n  b");
    expect(indent("only", "> ")).toBe("> only");
    expect(indent("", "  ")).toBe("  ");
    // A trailing newline is a last line that is empty, and it is prefixed too —
    // which is what keeps a block of quoted output rectangular.
    expect(indent("a\n", "| ")).toBe("| a\n| ");
  });
});

describe("colour is a question about the stream, asked once", () => {
  test("under a piped test runner, every helper returns the text unchanged", () => {
    // `bun test` is not a terminal here, so this is the branch that matters for
    // `mind doctor > report.txt`: no escape codes anywhere in the output.
    expect(dim("x")).toBe("x");
    expect(bold("x")).toBe("x");
    expect(dimErr("x")).toBe("x");
    expect(boldErr("x")).toBe("x");
    // The precondition, asked the way `bin/shared.ts` asks it since odd3:
    // `isatty(1)`, not `process.stdout.isTTY` — reading that getter can cut a
    // later long write to a pipe short, which is why the engine no longer does.
    expect(isatty(1)).toBe(false);
    expect(isatty(2)).toBe(false);
  });

  test("the sinks carry the stream's own answer about colour with them", () => {
    // `erase --json` writes every human line through `ERR` and the document
    // through `OUT`; if the styling did not travel with the line, `2> log`
    // would collect escape codes whenever stdout happened to be a terminal.
    expect(OUT.dim).toBe(dim);
    expect(OUT.bold).toBe(bold);
    expect(ERR.dim).toBe(dimErr);
    expect(ERR.bold).toBe(boldErr);

    const said: string[] = [];
    const spy = (line: string) => void said.push(line);
    const restore = console.log;
    console.log = spy as typeof console.log;
    try {
      OUT.line("a line");
      OUT.line();
    } finally {
      console.log = restore;
    }
    // A bare `line()` writes one blank line, and it does it with an argument:
    // `console.error()` with none puts its newline on stdout (see
    // `test/cli/streams.test.ts`), which is what `ERR.line()` must not do.
    expect(said).toEqual(["a line", ""]);
  });
});

describe("ledgerEnv — the machine facts the ledger is allowed to see", () => {
  test("home, env, a clock and — for the lock alone — the machine, and nothing else", () => {
    const env = ledgerEnv();
    expect(Object.keys(env).sort()).toEqual(["env", "home", "machine", "now"]);
    expect(env.home).toBe(homedir());
    expect(env.env).toBe(process.env);
    // D-145: the name and boot time that let a writer tell a killed turn's lock from a live one.
    expect(env.machine?.host).toBe(hostname());
    expect(Math.abs(env.machine!.bootedAt - (Date.now() - uptime() * 1000))).toBeLessThan(5_000);
  });

  test("`now` is a function, so every entry reads the clock when it is written", () => {
    // Not a captured `new Date()`: a long-running command would otherwise stamp
    // every entry with the time the process started.
    const before = Date.now();
    const at = ledgerEnv().now();
    expect(at).toBeInstanceOf(Date);
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("printPlaceNotices — AC4, the five places and what deleting cannot reach", () => {
  /**
   * The notice as `new` and `erase` would show it, collected instead of printed.
   *
   * A `Sink` since odd3, because `erase --json` sends these lines to stderr and
   * the styling has to travel with them: a writer that wrote to one stream
   * while `dim` answered a question about the other is the bug this type exists
   * to make unspellable. The pair here is the no-colour one, which is what both
   * real sinks are under a pipe.
   */
  function notices(): string[] {
    const lines: string[] = [];
    printPlaceNotices({
      line: (text = "") => void lines.push(text),
      dim: (text) => text,
      bold: (text) => text,
    });
    return lines;
  }

  test("all five are named, in the order the module declares them", () => {
    const written = notices();
    expect(written[0]).toContain("The five places a subject's data can end up");

    const named = PLACE_IDS.filter((id) =>
      written.some((line) => line.startsWith(`  ${id.padEnd(9)} `)),
    );
    expect(named).toEqual([...PLACE_IDS]);
    expect(PLACE_IDS.length).toBe(5);
  });

  test("a place that is not built says so, and says who owes it", () => {
    // The half a reader is most easily left with a false impression of: three
    // places exist, two do not, and printing only the three would be a lie by
    // omission. So the `not-built` ones must carry their own sentence.
    const written = notices().join("\n");
    const notBuilt = PLACE_IDS.filter((id) => placeOf(id).status === "not-built");
    expect(notBuilt.length).toBeGreaterThan(0);

    for (const id of notBuilt) {
      const place = placeOf(id);
      expect(written).toContain(`${place.owedBy} owes it, reserved at ${place.reserved}/`);
    }
    expect(written).toContain("nothing in Mind writes here yet, so nothing deletes here yet");
  });

  test("every undeletable note the places declare is printed, and so is where it was said", () => {
    const written = notices().join("\n");
    let counted = 0;
    for (const id of PLACE_IDS) {
      const place = placeOf(id);
      for (const list of place.undeletable) {
        for (const note of list) {
          expect(written, `${id}: ${note}`).toContain(note);
          counted += 1;
        }
      }
      expect(written).toContain(`said at: ${place.noticeAt}`);
    }
    // Control: the loop above asserted something. A places module with empty
    // lists would otherwise pass it without printing a word.
    expect(counted).toBeGreaterThan(3);
  });
});

describe("readTerminalLine — one line per call, however the lines arrive (D-072)", () => {
  test("three answers piped at once come back as three answers, then empty at the end", async () => {
    const script = `import { readTerminalLine } from ${JSON.stringify(join(import.meta.dir, "..", "..", "bin", "shared.ts"))};
for (let i = 0; i < 4; i++) console.log(JSON.stringify(await readTerminalLine()));`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: new TextEncoder().encode("y\nn\nq\n"), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(child.stdout).text();
    await child.exited;
    expect(out.trim().split("\n")).toEqual(['"y"', '"n"', '"q"', '""']);
  });
});

describe("lineReader, in process", () => {
  test("lines split across chunks, several in one chunk, and the tail at the end", async () => {
    const chunks = ["ye", "s\nno\nma", "ybe", ""];
    const stream = () => new ReadableStream<Uint8Array>({ pull(c) { const next = chunks.shift(); if (next === undefined) c.close(); else c.enqueue(new TextEncoder().encode(next)); } });
    const { lineReader } = await import("../../bin/shared.ts");
    const read = lineReader(stream);
    expect([await read(), await read(), await read(), await read()]).toEqual(["yes", "no", "maybe", ""]);
  });
});

describe("typedPhrase (D-077)", () => {
  test("paste codes, a carriage return, copied quotes and extra spaces are not the phrase; the words are", async () => {
    const { typedPhrase } = await import("../../bin/shared.ts");
    expect(typedPhrase("\u001b[200~record basis for om-bmt\u001b[201~\r")).toBe("record basis for om-bmt");
    expect(typedPhrase("  `record basis for om-bmt`  ")).toBe("record basis for om-bmt");
    expect(typedPhrase("\"record  basis for   om-bmt\"")).toBe("record basis for om-bmt");
    expect(typedPhrase("record basis for om-bm")).toBe("record basis for om-bm");
    expect(typedPhrase("")).toBe("");
  });
});

describe("readPhrase (D-077)", () => {
  test("blank lines left in the terminal are passed over; the first real line is the answer", async () => {
    const { readPhrase } = await import("../../bin/shared.ts");
    const lines = ["", "  ", "\r", "record basis for x"];
    expect(await readPhrase(async () => lines.shift() ?? "")).toBe("record basis for x");
    // At the end of input it gives up rather than waiting forever.
    expect(await readPhrase(async () => "")).toBe("");
  });
});
