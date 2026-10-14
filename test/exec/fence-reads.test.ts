/**
 * EXEC-02 part three: the Landlock ruleset handles reads, and a fenced child reads only what it was given.
 *
 * Before this, `FS_MASK` held write rights only, so a fenced turn with Bash could read every file its user
 * could: `~/.secrets`, `~/.ssh`, another subject's data. The helper now handles `READ_FILE | READ_DIR` when it
 * is started with `--confine-reads` (which `fencedArgv` always adds) and grants reads on the system
 * directories, what the turn may write, its working directory, the vendor program and its interpreter, and the
 * engine's own executable. Nothing else.
 *
 * The kernel cases use a canary file in a temporary directory that no grant covers, a stand-in vendor (a Bun
 * script, as the other fence tests do) and the same canary read by a grandchild process. A control run without
 * `--confine-reads` reads the canary, so the denial is the ruleset's and not an accident of the fixture.
 * Nothing here reads the owner's files: `HOME` is a temporary directory and every fixture lives in one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  FENCE_TESTING,
  fencedArgv,
  fenceSupport,
  parseFenceHelperArgv,
  readablePath,
  readGrants,
  runFenceHelper,
  type FenceHelperRuntime,
} from "../../src/exec/fence.ts";
import { BUN } from "../support/bare-path.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const ENTRY = join(ROOT, "bin", "mind.ts");
const support = fenceSupport();
const scratch: string[] = [];

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  // Resolved, because a symlinked temp root would make "inside" a statement about two spellings.
  const path = realpathSync(await mkdtemp(join(tmpdir(), "mind-reads-")));
  scratch.push(path);
  return path;
}

interface Fixture {
  readonly root: string;
  readonly work: string;
  readonly vendorHome: string;
  readonly canary: string;
  readonly sibling: string;
}

/** `work` (the working directory), `vendor-home` (writable) and a canary that no grant covers. */
async function fixture(): Promise<Fixture> {
  const root = await temp();
  const work = join(root, "work");
  const vendorHome = join(root, "vendor-home");
  const outside = join(root, "outside");
  for (const dir of [work, vendorHome, outside]) await mkdir(dir);
  await writeFile(join(work, "in.txt"), "inside the working directory");
  await writeFile(join(outside, "canary.txt"), "CANARY: nothing may read this");
  await writeFile(join(root, "sibling.txt"), "CANARY: next to the vendor home");
  return { root, work, vendorHome, canary: join(outside, "canary.txt"), sibling: join(root, "sibling.txt") };
}

/** A script with a `#!/usr/bin/env bun` line: the stand-in for a vendor CLI the engine did not compile. */
async function standIn(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/usr/bin/env bun\n${body}\n`);
  await chmod(path, 0o755);
}

describe("readGrants — what a confined turn may read", () => {
  const engine = { execPath: BUN, main: "/$bunfs/root/mind" } as const;

  test("the system directories and /proc, and nothing under the owner's home", async () => {
    const f = await fixture();
    const plan = readGrants({ writable: [f.vendorHome], command: [BUN], cwd: f.work, ...engine });
    for (const system of ["/usr", "/etc", "/sys", "/proc"]) expect(plan.paths).toContain(system);
    expect(plan.paths).toContain(f.work);
    // The owner's home, and every directory above it, is not a grant of its own.
    const home = realpathSync(homedir());
    for (const path of plan.paths) expect(home === path || home.startsWith(`${path}/`)).toBe(false);
    expect(plan.notes).toEqual([]);
  });

  test("what the turn may write is readable without a grant of its own, and no grant sits inside another", async () => {
    const f = await fixture();
    const plan = readGrants({ writable: [f.vendorHome, f.work], command: [BUN], cwd: f.work, ...engine });
    expect(plan.paths).not.toContain(f.work);
    expect(plan.paths).not.toContain(f.vendorHome);
    for (const path of plan.paths) {
      for (const other of plan.paths) {
        if (path !== other) expect(path.startsWith(`${other}/`), `${path} inside ${other}`).toBe(false);
      }
    }
  });

  test("a working directory that holds what the turn writes is not readable: it says so, and does not widen", async () => {
    const f = await fixture();
    const plan = readGrants({ writable: [f.vendorHome], command: [BUN], cwd: f.root, ...engine });
    expect(plan.paths).not.toContain(f.root);
    expect(plan.notes.join("\n")).toContain(`the working directory ${f.root} is not readable in this turn: it holds ${f.vendorHome}`);
  });

  test("a working directory of / is never granted", async () => {
    const f = await fixture();
    const plan = readGrants({ writable: [f.vendorHome], command: [BUN], cwd: "/", ...engine });
    expect(plan.paths).not.toContain("/");
    expect(plan.notes).toContain("the working directory is / and is not readable in this turn");
  });

  test("a vendor script: itself, the interpreter its #! line names, and the directory Bun lists to find it", async () => {
    const f = await fixture();
    const stub = join(f.root, "bin", "vendor");
    await standIn(stub, "console.log(1)");
    const plan = readGrants({ writable: [f.vendorHome], command: [stub], cwd: f.work, ...engine });
    expect(plan.paths).toContain(join(f.root, "bin"));
    // The interpreter is `env bun`: looked up on PATH and granted as the one file it is.
    expect(plan.paths).toContain(realpathSync(Bun.which("bun")!));
  });

  test("a vendor inside a Node package: the outermost node_modules, not the directory above it", async () => {
    const f = await fixture();
    const modules = join(f.root, "prefix", "lib", "node_modules");
    const script = join(modules, "@vendor", "cli", "bin", "cli.js");
    await standIn(script, "console.log(1)");
    const link = join(f.root, "bin", "cli");
    await mkdir(dirname(link), { recursive: true });
    await symlink(script, link);
    const plan = readGrants({ writable: [f.vendorHome], command: [link], cwd: f.work, ...engine });
    expect(plan.paths).toContain(modules);
    // The directory that holds the symlink is not the install tree; the real file's tree is.
    expect(plan.paths).not.toContain(join(f.root, "bin"));
    expect(plan.paths).not.toContain(join(f.root, "prefix"));
  });

  test("a compiled vendor is the one file it is, with no directory around it", async () => {
    const f = await fixture();
    const plan = readGrants({ writable: [f.vendorHome], command: [BUN], cwd: f.work, ...engine });
    expect(plan.paths).toContain(realpathSync(BUN));
    expect(plan.paths).not.toContain(dirname(realpathSync(BUN)));
  });

  test("a script that names another script as its interpreter stops at a bounded depth", async () => {
    const f = await fixture();
    const a = join(f.root, "bin", "a");
    const b = join(f.root, "bin", "b");
    await mkdir(dirname(a), { recursive: true });
    await writeFile(a, `#!${b}\n`);
    await writeFile(b, `#!${a}\n`);
    await chmod(a, 0o755);
    await chmod(b, 0o755);
    const plan = readGrants({ writable: [f.vendorHome], command: [a], cwd: f.work, ...engine });
    expect(plan.paths).toContain(join(f.root, "bin"));
  });

  test("a vendor that is not found grants nothing for it, and a missing engine path is not an error", async () => {
    const f = await fixture();
    const plan = readGrants({
      writable: [f.vendorHome],
      command: [join(f.root, "no-such-vendor")],
      cwd: f.work,
      execPath: join(f.root, "no-such-engine"),
      main: "/$bunfs/root/mind",
    });
    expect(plan.paths).toContain("/usr");
    expect(plan.notes).toEqual([]);
  });

  test("from a checkout the engine's source tree is read, and only the tree that holds the entry", async () => {
    const f = await fixture();
    const plan = readGrants({ writable: [f.vendorHome], command: [BUN], cwd: f.work, execPath: BUN, main: ENTRY });
    expect(plan.paths).toContain(ROOT);
  });

  test("an entry with no package.json above it grants its own directory", async () => {
    const f = await fixture();
    const entry = join(f.root, "engine", "entry.ts");
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "export {};");
    const plan = readGrants({ writable: [f.vendorHome], command: [BUN], cwd: f.work, execPath: BUN, main: entry });
    expect(plan.paths).toContain(dirname(entry));
  });
});

describe("readablePath — the PATH a confined turn can use", () => {
  test("keeps what the turn may read and where the vendor was found; drops the rest, relative entries included", async () => {
    const f = await fixture();
    const unreadable = join(f.root, "unreadable");
    const found = join(f.root, "found-in");
    const granted = join(f.vendorHome, "bin");
    for (const dir of [unreadable, found, granted]) await mkdir(dir, { recursive: true });
    const narrowed = readablePath(
      [unreadable, found, granted, "/usr/bin", "relative/bin", ".", join(f.root, "does-not-exist"), ""].join(":"),
      [f.vendorHome, "/usr"],
      [join(found, "vendor")],
    );
    expect(narrowed.path.split(":")).toEqual([found, granted, "/usr/bin"]);
    // The unreadable directory and the two relative entries are counted; a directory that is not there is not.
    expect(narrowed.left).toBe(3);
  });

  test("a PATH entry that is a link to a readable directory is kept, and one to an unreadable one is not", async () => {
    const f = await fixture();
    const link = join(f.root, "link-to-granted");
    const other = join(f.root, "link-to-outside");
    await symlink(f.vendorHome, link);
    await symlink(join(f.root, "outside"), other);
    const narrowed = readablePath(`${link}:${other}`, [f.vendorHome], []);
    expect(narrowed.path).toBe(link);
    expect(narrowed.left).toBe(1);
  });

  test("nothing readable leaves an empty PATH rather than the old one", () => {
    expect(readablePath("/home/nobody/bin:/opt/none", [], [])).toEqual({ path: "", left: 0 });
    expect(readablePath("", ["/usr"], [])).toEqual({ path: "", left: 0 });
  });
});

describe("the helper's argv", () => {
  test("--confine-reads is a switch with no value, and the older shape is unchanged", async () => {
    const f = await fixture();
    expect(parseFenceHelperArgv(["--confine-reads", "--rw", f.vendorHome, "--tcp-port", "10400", "--", "vendor"])).toEqual({
      ok: true,
      policy: { writable: [f.vendorHome], tcpPorts: [10400] },
      confineReads: true,
      command: ["vendor"],
    });
    expect(parseFenceHelperArgv(["--confine-reads", "--", "vendor"])).toEqual({
      ok: true,
      policy: { writable: [], tcpPorts: [] },
      confineReads: true,
      command: ["vendor"],
    });
    const open = parseFenceHelperArgv(["--rw", f.vendorHome, "--", "vendor"]);
    expect(open.ok && open.confineReads).toBeFalsy();
    const missing = parseFenceHelperArgv(["--confine-reads", "--rw", "--", "vendor"]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain("missing value for --rw");
  });

  test("every turn the engine builds is confined: the switch comes right after __fence", async () => {
    const f = await fixture();
    const argv = fencedArgv(["vendor"], { writable: [f.vendorHome], tcpPorts: [10400] });
    expect(argv[argv.indexOf("__fence") + 1]).toBe("--confine-reads");
    const parsed = parseFenceHelperArgv(argv.slice(argv.indexOf("__fence") + 1));
    expect(parsed.ok && parsed.confineReads).toBe(true);
  });
});

describe("the helper builds read rules from the plan, in process, without fencing the test runner", () => {
  /** A libc that records every landlock call: the ruleset's handled rights and each rule's rights and kind. */
  function recordingLibc() {
    const rules: { access: bigint; path: string }[] = [];
    let handled = 0n;
    const opened = new Map<number, string>();
    let nextFd = 20;
    const fake = {
      symbols: {
        syscall: (number: number, a1: number | bigint, a2: number | bigint, a3: number | bigint) => {
          if (number === 444) {
            handled = new DataView(FENCE_TESTING.nativeBytes(BigInt(a1), 16).buffer).getBigUint64(0, true);
            return 77n;
          }
          if (number === 445 && Number(a2) === 1) {
            const bytes = FENCE_TESTING.nativeBytes(BigInt(a3), 12);
            const view = new DataView(bytes.buffer, bytes.byteOffset, 12);
            rules.push({ access: view.getBigUint64(0, true), path: opened.get(view.getInt32(8, true)) ?? "?" });
          }
          return 0n;
        },
        open: (path: string) => {
          opened.set(nextFd, path);
          return nextFd++;
        },
        close: () => 0,
        prctl: () => 0,
        getenv: () => null,
        setenv: () => 0,
        execvp: () => {
          throw new Error("synthetic exec stops here");
        },
        __errno_location: () => null,
        strerror: () => null,
      },
      close: () => undefined,
    } as unknown as ReturnType<FenceHelperRuntime["openLibc"]>;
    return { fake, rules, handled: () => handled };
  }

  async function run(confine: boolean) {
    const f = await fixture();
    const record = recordingLibc();
    const original = console.error;
    const said: string[] = [];
    console.error = (...parts: unknown[]) => said.push(parts.map(String).join(" "));
    try {
      const code = runFenceHelper(
        [...(confine ? ["--confine-reads"] : []), "--rw", f.vendorHome, "--", BUN, "-e", "1"],
        {
          support: () => ({ ok: true, abi: 8 }),
          openLibc: () => record.fake,
          secureNetwork: () => undefined,
          cwd: () => f.work,
        },
      );
      expect(code).toBe(126);
    } finally {
      console.error = original;
    }
    return { f, record, said };
  }

  test("confined: read rights are handled, writable paths get them too, and the other paths get reads only", async () => {
    const { f, record, said } = await run(true);
    const READ_FILE = 1n << 2n;
    const READ_DIR = 1n << 3n;
    expect(record.handled() & (READ_FILE | READ_DIR)).toBe(READ_FILE | READ_DIR);
    const writable = record.rules.filter((rule) => rule.path === f.vendorHome || rule.path === "/dev");
    expect(writable).toHaveLength(2);
    for (const rule of writable) {
      expect(rule.access & (READ_FILE | READ_DIR)).toBe(READ_FILE | READ_DIR);
      expect(rule.access & (1n << 1n)).toBe(1n << 1n);
    }
    const readOnly = record.rules.filter((rule) => !writable.includes(rule));
    expect(readOnly.length).toBeGreaterThan(3);
    for (const rule of readOnly) {
      // Directories read and list; a single file is read. Nothing else, so nothing here can be written.
      expect([READ_FILE | READ_DIR, READ_FILE]).toContain(rule.access);
    }
    expect(readOnly.map((rule) => rule.path)).toContain("/usr");
    expect(readOnly.map((rule) => rule.path)).toContain(f.work);
    expect(said.join("\n")).toContain("synthetic exec stops here");
  });

  test("not confined: only write rights are handled, and every rule is the one the helper always built", async () => {
    const { record } = await run(false);
    expect(record.handled() & ((1n << 2n) | (1n << 3n))).toBe(0n);
    expect(record.rules).toHaveLength(2);
    for (const rule of record.rules) expect(rule.access & ((1n << 2n) | (1n << 3n))).toBe(0n);
  });
});

describe.skipIf(!support.ok)(`the real kernel${support.ok ? "" : ` — skipped: ${support.reason}`}`, () => {
  async function runHelper(options: {
    readonly writable: readonly string[];
    readonly cwd: string;
    readonly command: readonly string[];
    readonly confine?: boolean;
    readonly env?: Record<string, string>;
  }): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
    const child = Bun.spawn(
      [
        BUN,
        "run",
        ENTRY,
        "__fence",
        ...(options.confine === false ? [] : ["--confine-reads"]),
        ...options.writable.flatMap((path) => ["--rw", path]),
        "--",
        ...options.command,
      ],
      {
        cwd: options.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, MIND_NO_UPDATE_CHECK: "1", ...options.env },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  }

  /** What a vendor and the commands under it find: each read says "ok" or the error code. */
  function probe(f: Fixture): string {
    return `
      const fs = require("node:fs");
      const out = {};
      const read = (name, path) => { try { out[name] = fs.readFileSync(path, "utf8").slice(0, 8); } catch (cause) { out[name] = cause.code; } };
      read("workdir", ${JSON.stringify(join(f.work, "in.txt"))});
      read("system", "/etc/passwd");
      read("canary", ${JSON.stringify(f.canary)});
      read("sibling", ${JSON.stringify(f.sibling)});
      try { fs.readdirSync(${JSON.stringify(dirname(f.canary))}); out.listing = "ok"; } catch (cause) { out.listing = cause.code; }
      try { fs.readdirSync(${JSON.stringify(f.work)}); out.workdirListing = "ok"; } catch (cause) { out.workdirListing = cause.code; }
      // A grandchild, as the Bash tool is: the domain is inherited, so it is refused too.
      const cat = Bun.spawnSync(["cat", ${JSON.stringify(f.canary)}], { stdout: "pipe", stderr: "pipe" });
      out.grandchild = cat.exitCode === 0 ? "read it" : new TextDecoder().decode(cat.stderr).trim().split(": ").pop();
      try { fs.writeFileSync(${JSON.stringify(join(f.vendorHome, "made.txt"))}, "written"); out.writeHome = fs.readFileSync(${JSON.stringify(join(f.vendorHome, "made.txt"))}, "utf8"); } catch (cause) { out.writeHome = cause.code; }
      try { fs.writeFileSync(${JSON.stringify(join(f.work, "new.txt"))}, "x"); out.writeWork = "wrote"; } catch (cause) { out.writeWork = cause.code; }
      console.log(JSON.stringify(out));
    `;
  }

  test("a canary outside the grants cannot be read, listed or cat'd by a grandchild, while the stand-in vendor runs", async () => {
    const f = await fixture();
    const result = await runHelper({ writable: [f.vendorHome], cwd: f.work, command: [BUN, "-e", probe(f)] });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim()), result.stderr).toEqual({
      workdir: "inside t",
      system: "root:x:0",
      canary: "EACCES",
      sibling: "EACCES",
      listing: "EACCES",
      workdirListing: "ok",
      grandchild: "Permission denied",
      writeHome: "written",
      // The working directory is read-only here: it was not listed as writable.
      writeWork: "EACCES",
    });
  });

  test("the control: the same vendor, started without --confine-reads, reads the canary", async () => {
    const f = await fixture();
    const result = await runHelper({ writable: [f.vendorHome], cwd: f.work, command: [BUN, "-e", probe(f)], confine: false });
    expect(result.code, result.stderr).toBe(0);
    const seen = JSON.parse(result.stdout.trim());
    expect(seen.canary).toBe("CANARY: ");
    expect(seen.sibling).toBe("CANARY: ");
    expect(seen.listing).toBe("ok");
    expect(seen.grandchild).toBe("read it");
  });

  test("a working directory that holds the vendor's home is refused, with a line on stderr, not read in full", async () => {
    const f = await fixture();
    const result = await runHelper({ writable: [f.vendorHome], cwd: f.root, command: [BUN, "-e", probe(f)] });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim()).sibling).toBe("EACCES");
    expect(result.stderr).toContain(`mind fence: the working directory ${f.root} is not readable in this turn: it holds ${f.vendorHome}`);
  });

  test("a vendor script found by name on PATH runs, with its interpreter and its directory granted", async () => {
    const f = await fixture();
    const bin = join(f.root, "bin");
    await standIn(join(bin, "stand-in-vendor"), probe(f));
    const result = await runHelper({
      writable: [f.vendorHome],
      cwd: f.work,
      command: ["stand-in-vendor"],
      env: { PATH: `${bin}:${dirname(BUN)}:/usr/bin:/bin` },
    });
    expect(result.code, result.stderr).toBe(0);
    const seen = JSON.parse(result.stdout.trim());
    expect(seen.workdir).toBe("inside t");
    expect(seen.canary).toBe("EACCES");
  });

  test("the environment of a process outside the fence is refused whether or not reads are confined", async () => {
    // Landlock denies ptrace-mode access to a task outside its domain, and /proc/<pid>/environ is one. The parent
    // here is this test process, same user and dumpable.
    const script = `
      let out;
      try { require("node:fs").readFileSync("/proc/" + process.ppid + "/environ"); out = "readable"; } catch (cause) { out = cause.code; }
      console.log(out);
    `;
    const f = await fixture();
    for (const confine of [true, false]) {
      const result = await runHelper({ writable: [f.vendorHome], cwd: f.work, command: [BUN, "-e", script], confine });
      expect(result.stdout.trim(), `confine=${confine}: ${result.stderr}`).toBe("EACCES");
    }
  });

  test("a program in an unreadable PATH entry does not shadow the readable one of the same name", async () => {
    const f = await fixture();
    const unreadable = join(f.root, "unreadable");
    const fallback = join(f.vendorHome, "bin");
    for (const [dir, word] of [[unreadable, "shadow"], [fallback, "fallback"]] as const) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "tool"), `#!/bin/sh\necho ${word}\n`);
      await chmod(join(dir, "tool"), 0o755);
    }
    const script = `
      const run = Bun.spawnSync(["tool"], { stdout: "pipe", stderr: "pipe" });
      console.log(JSON.stringify({
        out: new TextDecoder().decode(run.stdout).trim(),
        err: new TextDecoder().decode(run.stderr).trim(),
        path: process.env.PATH,
      }));
    `;
    const env = { PATH: `${unreadable}:${fallback}:${dirname(BUN)}:/usr/bin:/bin` };

    const fenced = await runHelper({ writable: [f.vendorHome], cwd: f.work, command: [BUN, "-e", script], env });
    expect(fenced.code, fenced.stderr).toBe(0);
    const seen = JSON.parse(fenced.stdout.trim());
    expect(seen.out).toBe("fallback");
    expect(seen.path.split(":")).not.toContain(unreadable);
    expect(seen.path.split(":")).toContain("/usr/bin");
    // The one entry the vendor itself was found in stays, though the directory is not readable.
    expect(seen.path.split(":")).toContain(dirname(BUN));
    expect(fenced.stderr).toContain("mind fence: 1 PATH entry this turn may not read left out");

    // The control: without the confinement the unreadable entry comes first and wins.
    const open = await runHelper({ writable: [f.vendorHome], cwd: f.work, command: [BUN, "-e", script], env, confine: false });
    expect(JSON.parse(open.stdout.trim()).out).toBe("shadow");
  });

  test("a vendor installed in a directory of its own: that directory is readable, its neighbours are not", async () => {
    const f = await fixture();
    const tree = join(f.root, "tools", "vendor-install");
    const neighbour = join(f.root, "tools", "other-tool-secret.txt");
    await writeFile(neighbour, "CANARY: a neighbour of the install tree").catch(async () => {
      await mkdir(dirname(neighbour), { recursive: true });
      await writeFile(neighbour, "CANARY: a neighbour of the install tree");
    });
    await standIn(
      join(tree, "vendor"),
      `const fs = require("node:fs");
       const out = {};
       try { out.beside = fs.readdirSync(__dirname).join(","); } catch (cause) { out.beside = cause.code; }
       try { fs.readFileSync(${JSON.stringify(neighbour)}); out.neighbour = "read"; } catch (cause) { out.neighbour = cause.code; }
       console.log(JSON.stringify(out));`,
    );
    const result = await runHelper({
      writable: [f.vendorHome],
      cwd: f.work,
      command: [join(tree, "vendor")],
      env: { PATH: `${dirname(BUN)}:/usr/bin:/bin` },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ beside: "vendor", neighbour: "EACCES" });
  });
});
