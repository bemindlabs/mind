/**
 * EXEC-02 part one: the engine's `/proc/<pid>/environ` and `mem` are closed to a child of the same user.
 *
 * `mind turn` and `mind web` hold the owner's environment: cloud API keys, `MIND_*` paths, whatever the unit
 * file or the shell exported. A same-user process can read `/proc/<pid>/environ` of any process that is
 * dumpable, and an exec resets the flag, so a vendor CLI (or the Bash tool inside it) started by the engine
 * read the engine's own environment. `prctl(PR_SET_DUMPABLE, 0)` gives those files to root.
 *
 * Every case that changes the flag does it in a process of its own, so the test runner stays as it was.
 * `HOME` is a temporary directory throughout; nothing here reads the owner's files.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineNotDumpable, fenceSupport, libcNames, notDumpableNote, openFirst, runFenceHelper } from "../../src/exec/fence.ts";
import { barePath, BUN } from "../support/bare-path.ts";
import { waitFor } from "../support/wait.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const FENCE = join(ROOT, "src", "exec", "fence.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const LINUX = process.platform === "linux";

const scratch: string[] = [];
afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

/** Can this process read `/proc/<pid>/environ`? `"readable"`, or the error's code. */
async function environOf(pid: number): Promise<string> {
  try {
    await Bun.file(`/proc/${pid}/environ`).text();
    return "readable";
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code ?? String(cause);
  }
}

describe("engineNotDumpable", () => {
  test("off Linux it says so instead of pretending", () => {
    expect(engineNotDumpable("darwin")).toEqual({ ok: false, reason: "PR_SET_DUMPABLE is Linux's; this is darwin" });
  });

  test("a libc that cannot be opened, or a prctl that refuses, is reported with its reason", () => {
    expect(
      engineNotDumpable("linux", () => {
        throw new Error("no libc");
      }),
    ).toEqual({ ok: false, reason: "libc could not be opened (Error: no libc)" });

    const closed: string[] = [];
    const refusing = {
      symbols: {
        prctl: () => -1,
        __errno_location: () => null,
        strerror: () => null,
      },
      close: () => closed.push("libc"),
    };
    const refused = engineNotDumpable("linux", () => refusing as never);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("prctl(PR_SET_DUMPABLE, 0)");
    expect(closed).toEqual(["libc"]);
  });

  test("glibc's libc is tried first and musl's for the same architecture second, and no other architecture gets a guess", () => {
    expect(libcNames("x64")).toEqual(["libc.so.6", "libc.musl-x86_64.so.1"]);
    expect(libcNames("arm64")).toEqual(["libc.so.6", "libc.musl-aarch64.so.1"]);
    expect(libcNames("riscv64")).toEqual(["libc.so.6"]);
  });

  test("a system whose libc is musl's closes the flag too, instead of printing the 'could not close' line on every turn", () => {
    const tried: string[] = [];
    const musl = {
      symbols: { prctl: () => 0, __errno_location: () => null, strerror: () => null },
      close: () => undefined,
    };
    const opened = (name: string) => {
      tried.push(name);
      if (name !== "libc.musl-x86_64.so.1") throw new Error(`${name}: cannot open shared object file`);
      return musl as never;
    };
    expect(engineNotDumpable("linux", () => openFirst(libcNames("x64"), opened))).toEqual({ ok: true });
    expect(tried).toEqual(["libc.so.6", "libc.musl-x86_64.so.1"]);
  });

  test("when no name opens, the failure is the first one, which names glibc's library", () => {
    const answer = engineNotDumpable("linux", () =>
      openFirst(libcNames("x64"), (name) => {
        throw new Error(`${name}: cannot open shared object file`);
      }),
    );
    expect(answer).toEqual({
      ok: false,
      reason: "libc could not be opened (Error: libc.so.6: cannot open shared object file)",
    });
    expect(() => openFirst([], () => 1)).toThrow("no C library name to try");
  });

  test("a prctl that says yes but leaves the flag set is not reported as closed", () => {
    const calls: number[] = [];
    const lying = {
      symbols: {
        // PR_SET_DUMPABLE (4) answers 0; PR_GET_DUMPABLE (3) still says 1.
        prctl: (option: number) => {
          calls.push(option);
          return option === 4 ? 0 : 1;
        },
        __errno_location: () => null,
        strerror: () => null,
      },
      close: () => undefined,
    };
    const answer = engineNotDumpable("linux", () => lying as never);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.reason).toContain("still dumpable");
    expect(calls).toEqual([4, 3]);
  });

  test("the owner is told only when it matters: a failure on Linux, nothing off Linux or on success", () => {
    expect(notDumpableNote({ ok: true }, "linux")).toBeUndefined();
    expect(notDumpableNote({ ok: false, reason: "synthetic" }, "darwin")).toBeUndefined();
    const said = notDumpableNote({ ok: false, reason: "synthetic" }, "linux");
    expect(said).toContain("synthetic");
    expect(said).toContain("can read the environment");
  });

  test.skipIf(!LINUX)("in a process of its own: the flag is 0 and its environ and mem become root's", async () => {
    const child = Bun.spawn(
      [
        BUN,
        "-e",
        `const f = await import(${JSON.stringify(FENCE)});
         console.log(JSON.stringify(f.engineNotDumpable()));
         await Bun.sleep(5000);`,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, SECRET_FOR_TEST: "never-readable" } },
    );
    try {
      const reader = child.stdout.getReader();
      const line = new TextDecoder().decode((await reader.read()).value).trim();
      expect(line).toBe('{"ok":true}');
      expect(await waitFor(async () => (await stat(`/proc/${child.pid}/environ`)).uid === 0)).toBe(true);
      expect((await stat(`/proc/${child.pid}/mem`)).uid).toBe(0);
      expect(await environOf(child.pid)).toBe("EACCES");
    } finally {
      child.kill();
      await child.exited;
    }
  });
});

describe.skipIf(!LINUX)("the commands that hold the owner's environment", () => {
  async function engineEnv(home: string): Promise<Record<string, string>> {
    return {
      HOME: home,
      PATH: `${join(home, "bin")}:${await barePath(home)}`,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      CODEX_HOME: join(home, ".codex"),
      MIND_NO_UPDATE_CHECK: "1",
      MIND_QDRANT_URL: "http://127.0.0.1:9",
      OLLAMA_HOST: "http://127.0.0.1:1",
      // A value only the engine's own environment holds, and which a same-user reader would find.
      ENGINE_ONLY_SECRET: "cloud-key-that-must-stay-private",
    };
  }

  test("mind turn: a vendor CLI it starts cannot read the engine's /proc/<pid>/environ", async () => {
    const home = await temp("mind-dumpable-turn-");
    await mkdir(join(home, "bin"), { recursive: true });
    // A stand-in `claude`: it asks the kernel for its parent's (the engine's) environ and says what happened.
    const stub = join(home, "bin", "claude");
    await writeFile(
      stub,
      `#!/usr/bin/env bun
const fs = require("node:fs");
let answer;
try {
  const text = fs.readFileSync("/proc/" + process.ppid + "/environ", "utf8");
  answer = text.includes("cloud-key-that-must-stay-private") ? "environ:LEAKED" : "environ:empty";
} catch (cause) {
  answer = "environ:" + cause.code;
}
console.log(JSON.stringify({ result: answer, text: answer }));
`,
    );
    await chmod(stub, 0o755);

    const child = Bun.spawn(
      [BUN, "run", BIN, "turn", SOUL, "--subject", "example", "--prompt", "Reply with the token abc and nothing else.", "--backend", "claude"],
      { cwd: ROOT, env: await engineEnv(home), stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    expect(`${stdout}\n${stderr}`).toContain("environ:");
    expect(stdout.trim(), stderr).toBe("environ:EACCES");
  }, 60_000);

  test("mind web: the page's own /proc/<pid>/environ is closed to the same user", async () => {
    const home = await temp("mind-dumpable-web-");
    const soul = join(home, "agent", "soul");
    await cp(SOUL, soul, { recursive: true });
    const child = Bun.spawn([BUN, "run", BIN, "web", soul, "--subject", "example", "--port", "0"], {
      cwd: ROOT,
      env: await engineEnv(home),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    let out = "";
    const reading = (async () => {
      for await (const chunk of child.stdout) out += new TextDecoder().decode(chunk);
    })();
    try {
      expect(await waitFor(() => out.includes("Ctrl-C stops the page") || child.exitCode !== null)).toBe(true);
      expect(child.exitCode).toBeNull();
      expect(await environOf(child.pid)).toBe("EACCES");
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await reading;
    }
  }, 60_000);
});

describe("the fence helper and its supervisor", () => {
  test("the helper closes its own flag before it builds anything, and the failure of that call does not stop it", () => {
    const calls: string[] = [];
    const fake = {
      symbols: {
        // The two prctl options this test is about: 4 is SET_DUMPABLE and 3 is GET_DUMPABLE. A failing prctl
        // (here, an unknown option) is ignored by the helper: it still goes on to build the rules.
        prctl: (option: number) => {
          calls.push(`prctl:${option}`);
          return option === 4 ? -1 : 0;
        },
        syscall: (number: number) => {
          calls.push(`syscall:${number}`);
          return number === 444 ? -1n : 0n;
        },
        __errno_location: () => null,
        strerror: () => null,
      },
      close: () => undefined,
    };
    const original = console.error;
    console.error = () => undefined;
    try {
      const code = runFenceHelper(["--", "vendor"], {
        support: () => ({ ok: true, abi: 8 }),
        openLibc: () => fake as never,
        secureNetwork: () => undefined,
      });
      expect(code).toBe(126);
    } finally {
      console.error = original;
    }
    expect(calls[0]).toBe("prctl:4");
    expect(calls.indexOf("prctl:4")).toBeLessThan(calls.indexOf("syscall:444"));
  });

  const support = fenceSupport();
  test.skipIf(!support.ok || !LINUX)(
    "the vendor, which is the supervisor's parent, cannot open the supervisor's /proc/<pid>/mem or environ",
    async () => {
      const probe = `
        const fs = require("node:fs");
        const found = [];
        for (const entry of fs.readdirSync("/proc")) {
          if (!/^\\d+$/.test(entry)) continue;
          let cmdline = "";
          let stat = "";
          try {
            cmdline = fs.readFileSync("/proc/" + entry + "/cmdline", "utf8");
            stat = fs.readFileSync("/proc/" + entry + "/stat", "utf8");
          } catch { continue; }
          const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
          if (!cmdline.includes("__fence-supervisor") || parent !== process.pid) continue;
          const tried = {};
          for (const name of ["mem", "environ"]) {
            try { fs.closeSync(fs.openSync("/proc/" + entry + "/" + name, "r")); tried[name] = "readable"; }
            catch (cause) { tried[name] = cause.code; }
          }
          found.push(tried);
        }
        console.log(JSON.stringify(found));
      `;
      const home = await temp("mind-dumpable-fence-");
      const child = Bun.spawn(
        [BUN, "run", BIN, "__fence", "--rw", home, "--", BUN, "-e", probe],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, MIND_NO_UPDATE_CHECK: "1" } },
      );
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(await child.exited, stderr).toBe(0);
      // Exactly one supervisor is the vendor's child, and the kernel refuses both files.
      expect(JSON.parse(stdout.trim()), stderr).toEqual([{ mem: "EACCES", environ: "EACCES" }]);
    },
  );
});
