/**
 * D-118's boundary, including the kernel rather than only the argv around it.
 *
 * The real cases use only synthetic files, loopback listeners and short-lived
 * processes. On a kernel without the required Landlock ABI they are skipped
 * under a title that carries the exact reason; the policy/parser cases still
 * run everywhere, as does `CliExec`'s refusal test in `cli-exec.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FENCE_TESTING,
  fenceSupport,
  fencedArgv,
  parseFenceHelperArgv,
  runFenceHelper,
  runFenceSupervisor,
  type FenceHelperRuntime,
} from "../../src/exec/fence.ts";
import { procStat } from "../../src/decide/runs.ts";
import { BUN } from "../support/bare-path.ts";
import { waitFor } from "../support/wait.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const ENTRY = join(ROOT, "bin", "mind.ts");
const support = fenceSupport();
const skipReason = support.ok ? "" : support.reason;
const dig = Bun.which("dig");
const digSkipReason = dig === null ? " — skipped: dig is not installed" : "";
const scratch: string[] = [];

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mind-fence-"));
  scratch.push(path);
  return path;
}

function helper(
  writable: readonly string[],
  tcpPorts: readonly number[],
  command: readonly string[],
): string[] {
  return [
    BUN,
    "run",
    ENTRY,
    "__fence",
    ...writable.flatMap((path) => ["--rw", path]),
    ...tcpPorts.flatMap((port) => ["--tcp-port", String(port)]),
    "--",
    ...command,
  ];
}

async function runHelper(
  writable: readonly string[],
  tcpPorts: readonly number[],
  command: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn(helper(writable, tcpPorts, command), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MIND_NO_UPDATE_CHECK: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("fence policy argv", () => {
  test("the shared builder preserves each path, port and command element", async () => {
    const writable = await temp();
    const argv = fencedArgv(["vendor", "one argument", "--flag"], {
      writable: [writable],
      tcpPorts: [10400, 11434],
    });
    expect(argv.slice(-10)).toEqual([
      "--rw",
      writable,
      "--tcp-port",
      "10400",
      "--tcp-port",
      "11434",
      "--",
      "vendor",
      "one argument",
      "--flag",
    ]);
    expect(argv[0]).toBe(process.execPath);
  });

  test("impossible policies are rejected before a helper can be spawned", async () => {
    const directory = await temp();
    const file = join(directory, "not-a-directory");
    await writeFile(file, "fixture");
    for (const [policy, phrase] of [
      [{ writable: ["relative"], tcpPorts: [] }, "not absolute"],
      [{ writable: [join(directory, "missing")], tcpPorts: [] }, "does not exist"],
      [{ writable: [file], tcpPorts: [] }, "not a directory"],
      [{ writable: [directory], tcpPorts: [0] }, "1 to 65535"],
      [{ writable: [directory], tcpPorts: [65_536] }, "1 to 65535"],
      [{ writable: [directory], tcpPorts: [1.5] }, "whole number"],
    ] as const) {
      expect(() => fencedArgv(["vendor"], policy)).toThrow(phrase);
    }
    expect(() => fencedArgv([], { writable: [], tcpPorts: [] })).toThrow("empty command");
  });

  test("the hidden helper parser is strict and keeps values verbatim", async () => {
    const directory = await temp();
    expect(
      parseFenceHelperArgv([
        "--rw",
        directory,
        "--tcp-port",
        "10400",
        "--",
        "vendor",
        "a b",
      ]),
    ).toEqual({
      ok: true,
      policy: { writable: [directory], tcpPorts: [10400] },
      command: ["vendor", "a b"],
    });

    for (const [argv, phrase] of [
      [["--rw", directory], "missing --"],
      [["--"], "no command"],
      [["--rw", "--", "vendor"], "missing value"],
      [["--wat", "x", "--", "vendor"], "unknown option"],
      [["--tcp-port", "word", "--", "vendor"], "invalid fence policy"],
    ] as const) {
      const parsed = parseFenceHelperArgv(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain(phrase);
    }
  });

  test("malformed direct helper use refuses with the reserved cannot-execute code", () => {
    const original = console.error;
    const said: string[] = [];
    console.error = (...parts: unknown[]) => said.push(parts.map(String).join(" "));
    try {
      expect(runFenceHelper(["--"])).toBe(126);
    } finally {
      console.error = original;
    }
    expect(said.join("\n")).toContain("no command");
  });

  test("the helper builds every native rule before exec, without fencing this test process", async () => {
    const directory = await temp();
    const calls: string[] = [];
    let nextFd = 20;
    const fakeLibc = {
      symbols: {
        syscall: (number: number) => {
          calls.push(`syscall:${number}`);
          return number === 444 ? 77n : 0n;
        },
        open: (path: string) => {
          calls.push(`open:${path}`);
          return nextFd++;
        },
        close: (fd: number) => {
          calls.push(`close:${fd}`);
          return 0;
        },
        prctl: () => {
          calls.push("no-new-privs");
          return 0;
        },
        execvp: () => {
          calls.push("execvp");
          throw new Error("synthetic exec stops here");
        },
        __errno_location: () => null,
        strerror: () => null,
      },
      close: () => calls.push("close-libc"),
    } as unknown as ReturnType<FenceHelperRuntime["openLibc"]>;
    const runtime: FenceHelperRuntime = {
      support: () => ({ ok: true, abi: 8 }),
      openLibc: () => fakeLibc,
      secureNetwork: () => calls.push("seccomp-supervisor"),
    };
    const original = console.error;
    const said: string[] = [];
    console.error = (...parts: unknown[]) => said.push(parts.map(String).join(" "));
    try {
      expect(
        runFenceHelper(
          ["--rw", directory, "--tcp-port", "10400", "--", "vendor", "one argument"],
          runtime,
        ),
      ).toBe(126);
    } finally {
      console.error = original;
    }

    expect(calls).toContain(`open:${directory}`);
    expect(calls).toContain("open:/dev");
    expect(calls.filter((call) => call === "syscall:445")).toHaveLength(3);
    expect(calls).toContain("no-new-privs");
    expect(calls).toContain("syscall:446");
    expect(calls).toContain("seccomp-supervisor");
    expect(calls).toContain("execvp");
    expect(calls.at(-1)).toBe("close-libc");
    expect(said.join("\n")).toContain("synthetic exec stops here");
  });

  test("the helper itself refuses when its support probe says the kernel is too old", async () => {
    const directory = await temp();
    let opened = false;
    const original = console.error;
    console.error = () => undefined;
    try {
      expect(
        runFenceHelper(["--rw", directory, "--", "vendor"], {
          support: () => ({ ok: false, reason: "synthetic ABI 3" }),
          openLibc: () => {
            opened = true;
            throw new Error("must not open libc");
          },
          secureNetwork: () => undefined,
        }),
      ).toBe(126);
    } finally {
      console.error = original;
    }
    expect(opened).toBe(false);
  });

  test("the helper reports a second libc-open failure instead of throwing past the refusal", async () => {
    const directory = await temp();
    const original = console.error;
    const said: string[] = [];
    console.error = (...parts: unknown[]) => said.push(parts.map(String).join(" "));
    try {
      expect(
        runFenceHelper(["--rw", directory, "--", "vendor"], {
          support: () => ({ ok: true, abi: 8 }),
          openLibc: () => {
            throw new Error("synthetic dlopen failure");
          },
          secureNetwork: () => undefined,
        }),
      ).toBe(126);
    } finally {
      console.error = original;
    }
    expect(said.join("\n")).toContain("synthetic dlopen failure");
  });

  test("a failed seccomp supervisor refuses before exec", async () => {
    const directory = await temp();
    const calls: string[] = [];
    let nextFd = 20;
    const fakeLibc = {
      symbols: {
        syscall: (number: number) => number === 444 ? 77n : 0n,
        open: () => nextFd++,
        close: () => 0,
        prctl: () => 0,
        execvp: () => calls.push("execvp"),
        __errno_location: () => null,
        strerror: () => null,
      },
      close: () => undefined,
    } as unknown as ReturnType<FenceHelperRuntime["openLibc"]>;
    const original = console.error;
    const said: string[] = [];
    console.error = (...parts: unknown[]) => said.push(parts.map(String).join(" "));
    try {
      expect(runFenceHelper(["--rw", directory, "--", "vendor"], {
        support: () => ({ ok: true, abi: 8 }),
        openLibc: () => fakeLibc,
        secureNetwork: () => { throw new Error("synthetic supervisor failure"); },
      })).toBe(126);
    } finally {
      console.error = original;
    }
    expect(calls).not.toContain("execvp");
    expect(said.join("\n")).toContain("synthetic supervisor failure");
  });

  test("support is cached and says either the ABI or an actionable reason", () => {
    expect(fenceSupport()).toBe(support);
    if (support.ok) expect(support.abi).toBeGreaterThanOrEqual(4);
    else expect(support.reason.length).toBeGreaterThan(20);
  });
});

describe("seccomp supervisor internals", () => {
  test("both release architectures compile the complete BPF programs", () => {
    for (const architecture of Object.values(FENCE_TESTING.architectures)) {
      expect(FENCE_TESTING.networkFilter(architecture).byteLength).toBeGreaterThan(300);
      expect(FENCE_TESTING.noSendmsgFilter(architecture).byteLength).toBe(56);
    }
    expect(() => FENCE_TESTING.bpf([{ code: 0x15, k: 0, jt: "missing" }])).toThrow("label is missing");
    expect(() => FENCE_TESTING.bpf([
      { code: 0x06, k: 0, label: "back" },
      { code: 0x15, k: 0, jt: "back" },
    ])).toThrow("out of range");
  });

  test("the target-side setup starts, transfers to and acknowledges the supervisor", () => {
    const calls: string[] = [];
    let filter = 0;
    const errno = new Int32Array([1]);
    const fake = {
      symbols: {
        syscall: () => ++filter === 1 ? 30n : 0n,
        socketpair: (_domain: number, _type: number, _protocol: number, pair: Int32Array) => {
          pair.set([40, 41]);
          return 0;
        },
        fcntl: (_fd: number, operation: number) => operation === 1 ? 1 : 0,
        posix_spawn: (pid: Int32Array) => { pid[0] = 77; return 0; },
        prctl: () => 0,
        sendmsg: () => 1n,
        read: (_fd: number, byte: Uint8Array) => { byte[0] = 1; return 1n; },
        close: (fd: number) => { calls.push(`close:${fd}`); return 0; },
        kill: () => 0,
        waitpid: () => 0,
        __errno_location: () => FENCE_TESTING.addressOf(new Uint8Array(errno.buffer)),
        strerror: () => null,
      },
      close: () => undefined,
    } as unknown as ReturnType<FenceHelperRuntime["openLibc"]>;
    FENCE_TESTING.secureNetwork(fake, [10400, 10400]);
    expect(calls).toContain("close:30");
    expect(calls).toContain("close:40");
    expect(filter).toBe(2);
  });

  test("a notification is connected from a stable sockaddr copy and atomically injected", () => {
    const ioctls: number[] = [];
    const closed: number[] = [];
    const errno = new Int32Array([1]);
    const sockaddr = (last: number) => {
      const address = new Uint8Array(16);
      const view = new DataView(address.buffer);
      view.setUint16(0, 2, true);
      view.setUint16(2, 10400, false);
      address.set([127, 0, 0, last], 4);
      return address;
    };
    let copied = sockaddr(1);
    const fake = {
      symbols: {
        process_vm_readv: (_pid: number, local: Uint8Array) => {
          const pointer = new DataView(local.buffer).getBigUint64(0, true);
          FENCE_TESTING.nativeBytes(pointer, 16).set(copied);
          return 16n;
        },
        ioctl: (_fd: number, operation: number) => { ioctls.push(operation); return 0; },
        socket: () => 55,
        connect: () => 0,
        fcntl: () => 0,
        close: (fd: number) => { closed.push(fd); return 0; },
        __errno_location: () => FENCE_TESTING.addressOf(new Uint8Array(errno.buffer)),
        strerror: () => null,
      },
      close: () => undefined,
    } as unknown as ReturnType<FenceHelperRuntime["openLibc"]>;
    const notification = new Uint8Array(80);
    const view = new DataView(notification.buffer);
    view.setBigUint64(0, 9n, true);
    view.setUint32(8, 1234, true);
    view.setBigUint64(32, 12n, true);
    view.setBigUint64(40, 0x1234n, true);
    view.setBigUint64(48, 16n, true);

    FENCE_TESTING.handleConnect(fake, 30, notification, new Set([10400]));
    expect(ioctls).toContain(0x4018_2103);
    expect(closed).toEqual([55]);

    ioctls.length = 0;
    copied = sockaddr(2);
    FENCE_TESTING.handleConnect(fake, 30, notification, new Set([10400]));
    expect(ioctls).toEqual([0xc018_2101]);
    expect(FENCE_TESTING.allowedAddress(sockaddr(1), new Set([10400]))).toBe(true);
    expect(FENCE_TESTING.allowedAddress(sockaddr(2), new Set([10400]))).toBe(false);
    expect(FENCE_TESTING.readSockaddr(fake, 1, 0n, 16n)).toBeUndefined();
  });

  test("the supervisor entry receives its listener and exits with its parent", () => {
    const errno = new Int32Array([2]);
    let parents = 0;
    const fake = {
      symbols: {
        recvmsg: (_fd: number, message: Uint8Array) => {
          const pointer = new DataView(message.buffer).getBigUint64(32, true);
          const control = new DataView(FENCE_TESTING.nativeBytes(pointer, 24).buffer);
          control.setBigUint64(0, 20n, true);
          control.setInt32(8, 1, true);
          control.setInt32(12, 1, true);
          control.setInt32(16, 30, true);
          return 1n;
        },
        write: () => 1n,
        close: () => 0,
        getppid: () => ++parents === 1 ? 900 : 901,
        fcntl: () => 0,
        poll: () => 0,
        ioctl: () => -1,
        __errno_location: () => FENCE_TESTING.addressOf(new Uint8Array(errno.buffer)),
        strerror: () => null,
      },
      close: () => undefined,
    } as unknown as ReturnType<FenceHelperRuntime["openLibc"]>;
    expect(runFenceSupervisor(["--control-fd", "8", "--tcp-port", "10400"], () => fake)).toBe(0);
    expect(runFenceSupervisor([], () => fake)).toBe(126);
    expect(runFenceSupervisor(["--wat", "x"], () => fake)).toBe(126);
    expect(runFenceSupervisor(["--control-fd"], () => fake)).toBe(126);
  });

  test("the receive loop treats a vanished target as a clean end", () => {
    const errno = new Int32Array([2]);
    const fake = {
      symbols: {
        fcntl: () => 0,
        getppid: () => 500,
        poll: () => 1,
        ioctl: () => -1,
        __errno_location: () => FENCE_TESTING.addressOf(new Uint8Array(errno.buffer)),
        strerror: () => null,
      },
      close: () => undefined,
    } as unknown as ReturnType<FenceHelperRuntime["openLibc"]>;
    expect(() => FENCE_TESTING.supervise(fake, 30, new Set([10400]), 500)).not.toThrow();
  });
});

describe.skipIf(!support.ok)(`real Landlock fence${skipReason === "" ? "" : ` — skipped: ${skipReason}`}`, () => {
  test("AC1: a restrained grant writes inside its scratch and zero files outside", async () => {
    const root = await temp();
    const scratchDir = join(root, "scratch");
    await mkdir(scratchDir);
    const outside = join(root, "outside.txt");
    const inside = join(scratchDir, "inside.txt");

    const result = await runHelper(
      [scratchDir],
      [],
      // A Bun script, not a shell: the helper refuses what the spawn chokepoint
      // refuses (sh, curl, …), so the probes use the runtime Mind already needs.
      [
        BUN,
        "-e",
        `const fs = require("node:fs");
         fs.writeFileSync(${JSON.stringify(inside)}, "allowed");
         try { fs.writeFileSync(${JSON.stringify(outside)}, "escaped"); console.log("escaped"); }
         catch { console.log("denied"); }`,
      ],
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("denied");
    expect(await readFile(inside, "utf8")).toBe("allowed");
    await expect(stat(outside)).rejects.toThrow();
  });

  test("AC2: a level-2 grant writes exactly beneath the named directory", async () => {
    const root = await temp();
    const granted = join(root, "repo");
    const sibling = join(root, "other");
    await mkdir(granted);
    await mkdir(sibling);

    const result = await runHelper(
      [granted],
      [],
      [
        BUN,
        "-e",
        `const fs = require("node:fs");
         fs.mkdirSync(${JSON.stringify(join(granted, "new-dir"))});
         fs.writeFileSync(${JSON.stringify(join(granted, "new-dir", "file"))}, "changed");
         fs.writeFileSync(${JSON.stringify(join(sibling, "file"))}, "no");`,
      ],
    );
    expect(result.code).not.toBe(0);
    expect(await readFile(join(granted, "new-dir", "file"), "utf8")).toBe("changed");
    await expect(stat(join(sibling, "file"))).rejects.toThrow();
  });

  test("AC4: the allowed loopback port connects and another port is denied by the kernel", async () => {
    const serve = () =>
      new Promise<ReturnType<typeof createServer>>((resolveServer) => {
        const server = createServer((_request, response) => response.end("ok"));
        server.listen(0, "127.0.0.1", () => resolveServer(server));
      });
    const allowed = await serve();
    const denied = await serve();
    try {
      const allowedAddress = allowed.address();
      const deniedAddress = denied.address();
      if (allowedAddress === null || typeof allowedAddress === "string") throw new Error("no allowed listener port");
      if (deniedAddress === null || typeof deniedAddress === "string") throw new Error("no denied listener port");

      const get = (port: number) =>
        runHelper(
          [],
          [allowedAddress.port],
          [
            BUN,
            "-e",
            `fetch("http://127.0.0.1:${port}/").then((r) => r.text()).then((t) => process.stdout.write(t), () => process.exit(7));`,
          ],
        );
      const yes = await get(allowedAddress.port);
      const no = await get(deniedAddress.port);
      expect(yes.code).toBe(0);
      expect(yes.stdout).toBe("ok");
      expect(no.code).not.toBe(0);

      // No NET_BIND_TCP allow rule is ever added. Even an ephemeral loopback
      // bind is denied, while the connect grant above still works.
      const bind = await runHelper(
        [],
        [allowedAddress.port],
        [
          BUN,
          "-e",
          'Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}});',
        ],
      );
      expect(bind.code).not.toBe(0);
    } finally {
      allowed.close();
      denied.close();
    }
  });

  test("AC1: UDP, IPv6, DNS and resolver Unix sockets are unavailable", async () => {
    const probes = [
      [
        "UDP socket",
        `const dgram=require("node:dgram");
         try { dgram.createSocket("udp4").bind(0, "127.0.0.1", () => process.exit(9)); }
         catch (e) { console.log(e.code); }`,
      ],
      [
        "IPv6 socket",
        `const net=require("node:net");
         const s=net.connect({host:"::1",port:9});
         s.on("connect",()=>process.exit(9)); s.on("error",e=>console.log(e.code));`,
      ],
      [
        "direct DNS datagram",
        `const dgram=require("node:dgram");
         try { const s=dgram.createSocket("udp4"); s.send(Buffer.from([0]),53,"127.0.0.53",e=>{ console.log(e?.code??"sent"); s.close(); }); }
         catch (e) { console.log(e.code); }`,
      ],
      [
        "getent DNS",
        `const c=Bun.spawn(["getent","hosts","example.com"],{stdout:"ignore",stderr:"ignore"});
         process.exit(await c.exited===0?9:0);`,
      ],
    ] as const;
    for (const [name, script] of probes) {
      const result = await runHelper([], [], [BUN, "-e", script]);
      expect(result.code, name).not.toBe(9);
    }

  }, 10_000);

  test.skipIf(dig === null)(`AC1: dig cannot send a DNS query${digSkipReason}`, async () => {
    const result = await runHelper([], [], [dig!, "+time=1", "+tries=1", "example.com"]);
    expect(result.code).not.toBe(0);
  });

  test("AC2: the allowed port on 127.0.0.2 is denied by address", async () => {
    const primary = createServer((_request, response) => response.end("one"));
    await new Promise<void>((resolveListen) => primary.listen(0, "127.0.0.1", resolveListen));
    const address = primary.address();
    if (address === null || typeof address === "string") throw new Error("no listener port");
    const other = createServer((_request, response) => response.end("two"));
    await new Promise<void>((resolveListen, rejectListen) => {
      other.once("error", rejectListen);
      other.listen(address.port, "127.0.0.2", resolveListen);
    });
    try {
      const result = await runHelper(
        [],
        [address.port],
        [BUN, "-e", `fetch("http://127.0.0.2:${address.port}/").then(()=>process.exit(9),()=>process.exit(0));`],
      );
      expect(result.code).toBe(0);
    } finally {
      primary.close();
      other.close();
    }
  });

  test("AC3: replacing the helper preserves a detached group and SIGTERM reaches its child", async () => {
    const directory = await temp();
    const pidFile = join(directory, "child.pid");
    const child = Bun.spawn(
      helper(
        [directory],
        [],
        [
          BUN,
          "-e",
          `const c = Bun.spawn(["sleep", "600"]);
           require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
           await c.exited;`,
        ],
      ),
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        env: { ...process.env, MIND_NO_UPDATE_CHECK: "1" },
      },
    );

    let grandchild = 0;
    try {
      // A deadline, not 100 tries of 10 ms: the fenced helper and a bun inside it start slowly on a loaded runner.
      await waitFor(async () => {
        const text = await readFile(pidFile, "utf8").catch(() => "");
        if (/^\d+\s*$/.test(text)) grandchild = Number(text.trim());
        return grandchild > 0;
      });
      expect(grandchild).toBeGreaterThan(0);
      expect(procStat(child.pid)?.pgid).toBe(child.pid);
      expect(procStat(grandchild)?.pgid).toBe(child.pid);

      process.kill(-child.pid, "SIGTERM");
      await child.exited;
      // Reaped, not only signalled: the grandchild's new parent collects it in its own time.
      await waitFor(() => procStat(grandchild) === null);
      expect(procStat(child.pid)).toBeNull();
      expect(procStat(grandchild)).toBeNull();
    } finally {
      if (procStat(child.pid) !== null) process.kill(-child.pid, "SIGKILL");
      if (grandchild > 0 && procStat(grandchild) !== null) process.kill(grandchild, "SIGKILL");
      await chmod(directory, 0o700).catch(() => undefined);
    }
  }, 60_000);

  test.skipIf(!support.ok || support.abi < 6)("ABI 6 scopes signals sent out of the fenced domain", async () => {
    const result = await runHelper([], [], ["/bin/kill", "-0", String(process.pid)]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/not permitted|operation not permitted/i);
  });
});
