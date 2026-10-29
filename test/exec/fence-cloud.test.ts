/**
 * D-192 — the fence's cloud rules: TCP to port 443 at an address that is not loopback, the name servers on port
 * 53 (TCP, and UDP through the supervisor), and nothing else. The parser and the supervisor's pieces run
 * everywhere; the cases that need the kernel are skipped, with the reason, where it cannot fence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DNS_PORT,
  FENCE_TESTING,
  fenceSupport,
  fencedArgv,
  ipv4Bytes,
  landlockPorts,
  parseFenceHelperArgv,
  readGrants,
  runFenceHelper,
  runFenceSupervisor,
  targetNonBlocking,
  threadGroup,
  type FenceHelperRuntime,
} from "../../src/exec/fence.ts";
import { readResolvers } from "../../src/exec/cloud-fence.ts";
import { BUN } from "../support/bare-path.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const ENTRY = join(ROOT, "bin", "mind.ts");
const support = fenceSupport();
const scratch: string[] = [];

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mind-fence-cloud-"));
  scratch.push(path);
  return path;
}

type Libc = ReturnType<FenceHelperRuntime["openLibc"]>;

function sockaddr(host: string, port: number): Uint8Array {
  const address = new Uint8Array(16);
  const view = new DataView(address.buffer);
  view.setUint16(0, 2, true);
  view.setUint16(2, port, false);
  address.set(ipv4Bytes(host)!, 4);
  return address;
}

const REMOTE = { ports: new Set([443]), resolvers: new Set(["127.0.0.53"]) };

describe("the policy, as argv and back", () => {
  test("remote ports, resolvers and read grants survive the round trip; a local policy reads as it always has", async () => {
    const dir = await temp();
    const file = join(dir, "resolv.conf");
    await writeFile(file, "nameserver 127.0.0.53\n");
    const argv = fencedArgv(["vendor"], { writable: [dir], tcpPorts: [30731], remotePorts: [443], resolvers: ["127.0.0.53"], readable: [file] });
    expect(argv.slice(argv.indexOf("--rw"))).toEqual([
      "--rw", dir, "--tcp-port", "30731", "--remote-port", "443", "--resolver", "127.0.0.53", "--ro", file, "--", "vendor",
    ]);
    expect(parseFenceHelperArgv(argv.slice(argv.indexOf("__fence") + 1))).toEqual({
      ok: true,
      confineReads: true,
      policy: { writable: [dir], tcpPorts: [30731], remotePorts: [443], resolvers: ["127.0.0.53"], readable: [file] },
      command: ["vendor"],
    });
    expect(parseFenceHelperArgv(["--rw", dir, "--", "vendor"])).toEqual({ ok: true, policy: { writable: [dir], tcpPorts: [] }, command: ["vendor"] });
  });

  test("an impossible cloud policy is refused before a helper is spawned", async () => {
    const dir = await temp();
    expect(() => fencedArgv(["v"], { writable: [], tcpPorts: [], remotePorts: [0] })).toThrow("1 to 65535");
    expect(() => fencedArgv(["v"], { writable: [], tcpPorts: [], resolvers: ["::1"] })).toThrow("not an IPv4 literal");
    expect(() => fencedArgv(["v"], { writable: [], tcpPorts: [], readable: ["relative"] })).toThrow("not absolute");
    expect(() => fencedArgv(["v"], { writable: [], tcpPorts: [], readable: [join(dir, "missing")] })).toThrow("does not exist");
    expect(parseFenceHelperArgv(["--resolver", "999.1.1.1", "--", "v"])).toEqual({ ok: false, reason: 'invalid fence policy: name server is not an IPv4 literal: "999.1.1.1"' });
  });

  test("Landlock gets the loopback ports, the remote ports and 53 only when there is a name server", () => {
    expect(landlockPorts({ writable: [], tcpPorts: [10400] })).toEqual([10400]);
    expect(landlockPorts({ writable: [], tcpPorts: [30731], remotePorts: [443, 443], resolvers: ["127.0.0.53"] })).toEqual([30731, 443, DNS_PORT]);
    expect(landlockPorts({ writable: [], tcpPorts: [], remotePorts: [443] })).toEqual([443]);
    expect(ipv4Bytes("10.0.0.255")).toEqual([10, 0, 0, 255]);
    for (const bad of ["1.2.3", "01.2.3.4", "256.0.0.1", "a.b.c.d", ""]) expect(ipv4Bytes(bad)).toBeUndefined();
  });

  test("a granted path is readable, and dropped like the working directory when it holds what the turn writes", async () => {
    const dir = await temp();
    const file = join(dir, "resolv.conf");
    await writeFile(file, "x");
    const plan = readGrants({ writable: [], command: [], cwd: "/", execPath: BUN, main: "", readable: [file] });
    expect(plan.paths).toContain(file);
    const held = readGrants({ writable: [join(dir)], command: [], cwd: "/", execPath: BUN, main: "", readable: [tmpdir()] });
    expect(held.notes.some((note) => note.startsWith("a path this turn was granted"))).toBe(true);
  });
});

describe("the supervisor's cloud rules", () => {
  test("allowedAddress: loopback ports as before; 443 anywhere but loopback; the resolver on 53 and nowhere else", () => {
    const { allowedAddress } = FENCE_TESTING;
    const local = new Set([10400]);
    expect(allowedAddress(sockaddr("127.0.0.1", 10400), local, REMOTE)).toBe(true);
    expect(allowedAddress(sockaddr("140.82.112.3", 443), local, REMOTE)).toBe(true);
    expect(allowedAddress(sockaddr("192.168.1.10", 443), local, REMOTE)).toBe(true);
    expect(allowedAddress(sockaddr("127.0.0.1", 443), local, REMOTE)).toBe(false);
    expect(allowedAddress(sockaddr("127.9.9.9", 443), local, REMOTE)).toBe(false);
    expect(allowedAddress(sockaddr("0.0.0.0", 443), local, REMOTE)).toBe(false);
    expect(allowedAddress(sockaddr("140.82.112.3", 80), local, REMOTE)).toBe(false);
    expect(allowedAddress(sockaddr("127.0.0.53", 53), local, REMOTE)).toBe(true);
    expect(allowedAddress(sockaddr("8.8.8.8", 53), local, REMOTE)).toBe(false);
    expect(allowedAddress(sockaddr("127.0.0.1", 10400), local)).toBe(true);
    expect(allowedAddress(sockaddr("140.82.112.3", 443), local)).toBe(false);
    const unix = new Uint8Array(16);
    unix[0] = 1;
    expect(allowedAddress(unix, local, REMOTE)).toBe(false);
    expect(FENCE_TESTING.resolverAddress(sockaddr("127.0.0.53", 53), REMOTE)).toBe(true);
    expect(FENCE_TESTING.resolverAddress(sockaddr("127.0.0.53", 54), REMOTE)).toBe(false);
  });

  test("the datagram filter compiles on both architectures, and only a cloud turn's allows UDP and a named sendto", () => {
    for (const architecture of Object.values(FENCE_TESTING.architectures)) {
      const local = FENCE_TESTING.networkFilter(architecture);
      const cloud = FENCE_TESTING.networkFilter(architecture, true);
      expect(cloud.byteLength).toBe(local.byteLength);
      expect(cloud).not.toEqual(local);
    }
  });

  test("the target's blocking mode and thread group are read from /proc, with safe answers when they cannot be", () => {
    expect(targetNonBlocking(1, 3, () => "pos:\t0\nflags:\t02004002\n")).toBe(true);
    expect(targetNonBlocking(1, 3, () => "pos:\t0\nflags:\t02000002\n")).toBe(false);
    expect(targetNonBlocking(1, 3, () => "no flags here")).toBe(true);
    expect(targetNonBlocking(1, 3, () => { throw new Error("gone"); })).toBe(true);
    expect(targetNonBlocking(process.pid, 0)).toBeBoolean();
    expect(threadGroup(42, () => "Name:\tx\nTgid:\t7\nPid:\t42\n")).toBe(7);
    expect(threadGroup(42, () => "nothing")).toBe(42);
    expect(threadGroup(42, () => { throw new Error("gone"); })).toBe(42);
    expect(threadGroup(process.pid)).toBe(process.pid);
  });

  test("the supervisor takes --remote-port and --resolver, and refuses a malformed one", () => {
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
    } as unknown as Libc;
    const original = console.error;
    console.error = () => undefined;
    try {
      expect(runFenceSupervisor(["--control-fd", "8", "--remote-port", "443", "--resolver", "127.0.0.53"], () => fake)).toBe(0);
      expect(runFenceSupervisor(["--control-fd", "8", "--resolver", "nope"], () => fake)).toBe(126);
      expect(runFenceSupervisor(["--control-fd", "8", "--remote-port", "0"], () => fake)).toBe(126);
    } finally {
      console.error = original;
    }
  });

  /** A libc that answers the supervisor's calls from a table, and records what it was asked. */
  function fakeLibc(options: {
    readonly address: Uint8Array;
    readonly payload?: Uint8Array;
    readonly type?: number;
    readonly pidfd?: number;
    readonly copy?: number;
    readonly connect?: number;
    readonly sent?: bigint;
    readonly getsockopt?: number;
  }) {
    const calls: string[] = [];
    const responses: { readonly value: bigint; readonly error: number }[] = [];
    const errno = new Int32Array([1]);
    const lib = {
      symbols: {
        process_vm_readv: (_pid: number, local: Uint8Array) => {
          const view = new DataView(local.buffer);
          const pointer = view.getBigUint64(0, true);
          const length = Number(view.getBigUint64(8, true));
          const source = length === 16 && options.payload?.length !== 16 ? options.address : (options.payload ?? options.address);
          FENCE_TESTING.nativeBytes(pointer, length).set(source.subarray(0, length));
          return BigInt(length);
        },
        ioctl: (_fd: number, operation: number, argument: Uint8Array | BigUint64Array) => {
          if (operation === 0xc018_2101) {
            const view = new DataView((argument as Uint8Array).buffer);
            responses.push({ value: view.getBigInt64(8, true), error: view.getInt32(16, true) });
          }
          calls.push(`ioctl:${operation.toString(16)}`);
          return 0;
        },
        syscall: (number: number) => {
          calls.push(`syscall:${number}`);
          return BigInt(number === 434 ? (options.pidfd ?? 70) : (options.copy ?? 71));
        },
        getsockopt: (_fd: number, _level: number, _name: number, value: Int32Array) => {
          value[0] = options.type ?? 2;
          return options.getsockopt ?? 0;
        },
        connect: (fd: number) => (calls.push(`connect:${fd}`), options.connect ?? 0),
        sendto: (fd: number, _bytes: Uint8Array, length: bigint) => (calls.push(`sendto:${fd}:${length}`), options.sent ?? length),
        socket: () => 55,
        fcntl: () => 0,
        close: (fd: number) => (calls.push(`close:${fd}`), 0),
        __errno_location: () => FENCE_TESTING.addressOf(new Uint8Array(errno.buffer)),
        strerror: () => null,
      },
      close: () => undefined,
    } as unknown as Libc;
    return { lib, calls, responses };
  }

  function notification(nr: number, args: readonly bigint[]): Uint8Array {
    const bytes = new Uint8Array(80);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 9n, true);
    view.setUint32(8, process.pid, true);
    view.setInt32(16, nr, true);
    args.forEach((arg, index) => view.setBigUint64(32 + index * 8, arg, true));
    return bytes;
  }

  const x64 = FENCE_TESTING.architectures["x64"]!;

  test("a UDP connect is made on the target's own socket, and only to a resolver; TCP is injected as before", () => {
    const dgram = fakeLibc({ address: sockaddr("127.0.0.53", 53), type: 2 });
    FENCE_TESTING.handleNotification(dgram.lib, 30, notification(x64.connect, [5n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(dgram.calls).toContain("connect:71");
    expect(dgram.responses).toEqual([{ value: 0n, error: 0 }]);

    const quic = fakeLibc({ address: sockaddr("140.82.112.3", 443), type: 2 });
    FENCE_TESTING.handleNotification(quic.lib, 30, notification(x64.connect, [5n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(quic.calls).not.toContain("connect:71");
    expect(quic.responses).toEqual([{ value: 0n, error: -1 }]);

    const failed = fakeLibc({ address: sockaddr("127.0.0.53", 53), type: 2, connect: -1 });
    FENCE_TESTING.handleNotification(failed.lib, 30, notification(x64.connect, [5n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(failed.responses[0]!.error).toBe(-1);

    const tcp = fakeLibc({ address: sockaddr("140.82.112.3", 443), type: 1 });
    FENCE_TESTING.handleNotification(tcp.lib, 30, notification(x64.connect, [5n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(tcp.calls).toContain("ioctl:40182103");

    const raw = fakeLibc({ address: sockaddr("140.82.112.3", 443), type: 3 });
    FENCE_TESTING.handleNotification(raw.lib, 30, notification(x64.connect, [5n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(raw.responses).toEqual([{ value: 0n, error: -1 }]);

    const unseen = fakeLibc({ address: sockaddr("140.82.112.3", 443), pidfd: -1 });
    FENCE_TESTING.handleNotification(unseen.lib, 30, notification(x64.connect, [5n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(unseen.responses).toEqual([{ value: 0n, error: -1 }]);
    const noCopy = fakeLibc({ address: sockaddr("140.82.112.3", 443), copy: -1 });
    expect(FENCE_TESTING.targetSocket(noCopy.lib, process.pid, 5)).toBeUndefined();
    const noType = fakeLibc({ address: sockaddr("140.82.112.3", 443), getsockopt: -1 });
    expect(FENCE_TESTING.targetSocket(noType.lib, process.pid, 5)).toBeUndefined();
  });

  test("a named sendto is sent by the supervisor from its own copies — to a resolver, on a UDP socket — or refused", () => {
    const query = new Uint8Array(29).fill(7);
    const sent = fakeLibc({ address: sockaddr("127.0.0.53", 53), payload: query, type: 2 });
    FENCE_TESTING.handleNotification(sent.lib, 30, notification(x64.sendto, [5n, 0x2000n, 29n, 0n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(sent.calls).toContain("sendto:71:29");
    expect(sent.responses).toEqual([{ value: 29n, error: 0 }]);

    const elsewhere = fakeLibc({ address: sockaddr("1.1.1.1", 53), payload: query, type: 2 });
    FENCE_TESTING.handleNotification(elsewhere.lib, 30, notification(x64.sendto, [5n, 0x2000n, 29n, 0n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(elsewhere.responses).toEqual([{ value: 0n, error: -1 }]);

    const tcp = fakeLibc({ address: sockaddr("127.0.0.53", 53), payload: query, type: 1 });
    FENCE_TESTING.handleNotification(tcp.lib, 30, notification(x64.sendto, [5n, 0x2000n, 29n, 0n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(tcp.responses).toEqual([{ value: 0n, error: -1 }]);

    const huge = fakeLibc({ address: sockaddr("127.0.0.53", 53), payload: query });
    FENCE_TESTING.handleNotification(huge.lib, 30, notification(x64.sendto, [5n, 0x2000n, 5000n, 0n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(huge.responses).toEqual([{ value: 0n, error: -1 }]);

    const failed = fakeLibc({ address: sockaddr("127.0.0.53", 53), payload: query, type: 2, sent: -1n });
    FENCE_TESTING.handleNotification(failed.lib, 30, notification(x64.sendto, [5n, 0x2000n, 29n, 0n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(failed.responses[0]!.error).toBe(-1);

    const empty = fakeLibc({ address: sockaddr("127.0.0.53", 53), type: 2 });
    FENCE_TESTING.handleNotification(empty.lib, 30, notification(x64.sendto, [5n, 0x2000n, 0n, 0n, 0x1000n, 16n]), new Set(), REMOTE, x64);
    expect(empty.responses).toEqual([{ value: 0n, error: 0 }]);

    // A local turn has no name servers: a named sendto that somehow reached it is refused.
    const local = fakeLibc({ address: sockaddr("127.0.0.53", 53), payload: query, type: 2 });
    FENCE_TESTING.handleNotification(local.lib, 30, notification(x64.sendto, [5n, 0x2000n, 29n, 0n, 0x1000n, 16n]), new Set(), { ports: new Set(), resolvers: new Set() }, x64);
    expect(local.responses).toEqual([{ value: 0n, error: -1 }]);
  });

  test("the helper adds the remote and DNS port rules and hands the supervisor its remote rule", async () => {
    const directory = await temp();
    const rules: number[] = [];
    let remote: unknown;
    let nextFd = 20;
    const fake = {
      symbols: {
        syscall: (number: number, _a: unknown, type: number) => {
          if (number === 445) rules.push(type);
          return number === 444 ? 77n : 0n;
        },
        open: () => nextFd++,
        close: () => 0,
        prctl: () => 0,
        execvp: () => {
          throw new Error("synthetic exec stops here");
        },
        __errno_location: () => null,
        strerror: () => null,
      },
      close: () => undefined,
    } as unknown as Libc;
    const original = console.error;
    console.error = () => undefined;
    try {
      expect(
        runFenceHelper(["--rw", directory, "--remote-port", "443", "--resolver", "127.0.0.53", "--", "vendor"], {
          support: () => ({ ok: true, abi: 8 }),
          openLibc: () => fake,
          secureNetwork: (_lib, _ports, given) => {
            remote = given;
          },
        }),
      ).toBe(126);
    } finally {
      console.error = original;
    }
    // Two path rules (the directory and /dev), then two port rules: 443 and 53.
    expect(rules.filter((type) => type === 2)).toHaveLength(2);
    expect(remote).toEqual({ ports: [443], resolvers: ["127.0.0.53"] });
  });
});

/** The first IPv4 address of this machine that is not loopback, or undefined on a machine with none. */
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return undefined;
}

const resolvers = await readResolvers();
const lan = lanAddress();

describe.skipIf(!support.ok || process.arch !== "x64")(`the cloud rules in the real kernel${support.ok ? "" : ` — skipped: ${support.reason}`}`, () => {
  test("loopback and a port that is not 443 are refused; UDP goes only to a name server, and only through the supervisor", async () => {
    const tcp = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });
    const udp = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0 });
    try {
      const resolver = resolvers[0] ?? "127.0.0.53";
      const script = `
        const { dlopen, ptr } = require("bun:ffi");
        const lib = dlopen("libc.so.6", {
          socket: { args: ["i32", "i32", "i32"], returns: "i32" },
          connect: { args: ["i32", "ptr", "u32"], returns: "i32" },
          sendto: { args: ["i32", "ptr", "u64", "i32", "ptr", "u32"], returns: "i64" },
          __errno_location: { args: [], returns: "ptr" },
        });
        const { read } = require("bun:ffi");
        const errno = () => read.i32(lib.symbols.__errno_location());
        const addr = (host, port) => {
          const a = new Uint8Array(16); const v = new DataView(a.buffer);
          v.setUint16(0, 2, true); v.setUint16(2, port, false); a.set(host.split(".").map(Number), 4); return a;
        };
        const out = {};
        const tcp = (host, port) => { const fd = lib.symbols.socket(2, 1, 0); return lib.symbols.connect(fd, addr(host, port), 16) === 0 ? "ok" : "errno " + errno(); };
        out.loopback = tcp("127.0.0.1", ${tcp.port});
        out.lanNot443 = ${lan === undefined ? '"skipped"' : `tcp(${JSON.stringify(lan)}, ${tcp.port})`};
        const udp = lib.symbols.socket(2, 2, 0);
        out.udpSocket = udp >= 0 ? "ok" : "errno " + errno();
        const q = new Uint8Array([0xab,0xcd,1,0,0,1,0,0,0,0,0,0,9,108,111,99,97,108,104,111,115,116,0,0,1,0,1]);
        const send = (host, port) => { const n = lib.symbols.sendto(udp, q, q.length, 0, addr(host, port), 16); return n >= 0 ? "sent " + n : "errno " + errno(); };
        out.udpElsewhere = send("127.0.0.1", ${udp.port});
        out.udpResolver = send(${JSON.stringify(resolver)}, 53);
        const u2 = lib.symbols.socket(2, 2, 0);
        out.udpConnectElsewhere = lib.symbols.connect(u2, addr("127.0.0.1", ${udp.port}), 16) === 0 ? "ok" : "errno " + errno();
        out.udpConnectResolver = lib.symbols.connect(u2, addr(${JSON.stringify(resolver)}, 53), 16) === 0 ? "ok" : "errno " + errno();
        console.log(JSON.stringify(out));
      `;
      const child = Bun.spawn(
        [BUN, "run", ENTRY, "__fence", "--remote-port", "443", "--resolver", resolver, "--", BUN, "-e", script],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, MIND_NO_UPDATE_CHECK: "1" } },
      );
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      await child.exited;
      const seen = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, string>;
      expect(seen["loopback"], stderr).toBe("errno 1");
      if (lan !== undefined) expect(seen["lanNot443"]).toMatch(/^errno (1|13)$/);
      expect(seen["udpSocket"]).toBe("ok");
      expect(seen["udpElsewhere"]).toBe("errno 1");
      expect(seen["udpResolver"]).toBe("sent 27");
      expect(seen["udpConnectElsewhere"]).toBe("errno 1");
      expect(seen["udpConnectResolver"]).toBe("ok");
    } finally {
      tcp.stop(true);
      udp.close();
    }
  }, 30_000);
});
