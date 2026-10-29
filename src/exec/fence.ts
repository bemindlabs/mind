/**
 * The kernel fence around a vendor CLI that talks to a model on this machine.
 *
 * A vendor's tool list is a request, not a boundary. SP-5 measured Bash in two
 * vendors writing outside the working directory and reaching the network, so
 * D-118 requires a boundary the vendor inherits and cannot remove. Landlock
 * supplies filesystem and TCP-port rules; D-123 adds seccomp for transport and
 * address rules Landlock cannot express.
 *
 * The awkward part is the word "thread". `landlock_restrict_self` restricts
 * only the calling thread; asking Bun to spawn after the syscall could hand the
 * spawn to another runtime thread. The hidden helper therefore makes no Bun
 * spawn at all. In one synchronous FFI path it installs Landlock, starts a
 * fixed supervisor with libc `posix_spawn`, installs seccomp and calls libc
 * `execvp`. The supervisor performs allowed connects from a copied sockaddr
 * and injects the connected fd; it never continues the target syscall, so a
 * second target thread cannot win the documented sockaddr TOCTOU. The vendor
 * still replaces the helper — same pid and process group — and the supervisor
 * joins that group, so S5.4 reaches both.
 */

import { CString, dlopen, ptr, read, toArrayBuffer } from "bun:ffi";
import { closeSync, existsSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isInside } from "./workdir.ts";

/** Paths and loopback service ports a local turn may change or connect to. */
export interface FencePolicy {
  readonly writable: readonly string[];
  /** TCP ports on 127.0.0.1 only: the local services a turn may reach (LiteLLM, a task's browser). */
  readonly tcpPorts: readonly number[];
  /**
   * D-192, a cloud turn: TCP ports the turn may connect to at any address that is not loopback (`127.0.0.0/8`)
   * or `0.0.0.0/8`. Absent or empty on a local turn, which keeps D-123's loopback-only rule unchanged.
   */
  readonly remotePorts?: readonly number[];
  /**
   * D-192: the name servers a cloud turn may ask, as IPv4 literals, reached on TCP port 53 and nowhere else.
   * UDP stays refused (the seccomp filter allows no datagram socket), so the vendor is started with
   * `RES_OPTIONS=use-vc` and the C library asks over TCP.
   */
  readonly resolvers?: readonly string[];
  /** D-192: paths (files or directories) the turn may read beyond {@link readGrants}' own list. */
  readonly readable?: readonly string[];
}

/** The port a name server listens on; granted only towards {@link FencePolicy.resolvers}. */
export const DNS_PORT = 53;

/** Every TCP port Landlock must allow for this policy: the loopback ones, the remote ones, and DNS when asked. */
export function landlockPorts(policy: FencePolicy): number[] {
  return [
    ...new Set([
      ...policy.tcpPorts,
      ...(policy.remotePorts ?? []),
      ...((policy.resolvers ?? []).length > 0 ? [DNS_PORT] : []),
    ]),
  ];
}

const IPV4_LITERAL = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An IPv4 dotted literal as the four bytes a `sockaddr_in` carries, or `undefined` when it is not one. */
export function ipv4Bytes(literal: string): readonly [number, number, number, number] | undefined {
  if (!IPV4_LITERAL.test(literal)) return undefined;
  const [a, b, c, d] = literal.split(".").map(Number) as [number, number, number, number];
  return [a, b, c, d];
}

/** What this kernel can enforce, probed once because its ABI cannot change. */
export type FenceSupport =
  | { readonly ok: true; readonly abi: number }
  | { readonly ok: false; readonly reason: string };

const SYS_LANDLOCK_CREATE_RULESET = 444;
const SYS_LANDLOCK_ADD_RULE = 445;
const SYS_LANDLOCK_RESTRICT_SELF = 446;
const LANDLOCK_CREATE_RULESET_VERSION = 1;
const LANDLOCK_RULE_PATH_BENEATH = 1;
const LANDLOCK_RULE_NET_PORT = 2;
const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;
const PR_SET_NO_NEW_PRIVS = 38;
const PR_SET_PTRACER = 0x5961_6d61;

// Seccomp syscall numbers are architecture-specific even though its UAPI is
// otherwise shared. Linux has no socketcall on either 64-bit target: x86_64
// has direct socket syscalls and arm64 uses the generic table.
interface SeccompArchitecture {
  readonly audit: number;
  readonly seccomp: number;
  readonly socket: number;
  readonly socketpair: number;
  readonly connect: number;
  readonly sendto: number;
  readonly sendmsg: number;
  readonly sendmmsg: number;
  readonly ioUringSetup: number;
  readonly closeRange: number;
}

const SECCOMP_ARCHITECTURES: Readonly<Record<string, SeccompArchitecture>> = {
  x64: {
    audit: 0xc000_003e,
    seccomp: 317,
    socket: 41,
    connect: 42,
    sendto: 44,
    sendmsg: 46,
    socketpair: 53,
    sendmmsg: 307,
    ioUringSetup: 425,
    closeRange: 436,
  },
  arm64: {
    audit: 0xc000_00b7,
    seccomp: 277,
    socket: 198,
    socketpair: 199,
    connect: 203,
    sendto: 206,
    sendmsg: 211,
    sendmmsg: 269,
    ioUringSetup: 425,
    closeRange: 436,
  },
};

const SECCOMP_SET_MODE_FILTER = 1;
const SECCOMP_GET_ACTION_AVAIL = 2;
const SECCOMP_GET_NOTIF_SIZES = 3;
const SECCOMP_FILTER_FLAG_NEW_LISTENER = 1 << 3;
const SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV = 1 << 5;
const SECCOMP_RET_KILL_PROCESS = 0x8000_0000;
const SECCOMP_RET_ERRNO = 0x0005_0000;
const SECCOMP_RET_USER_NOTIF = 0x7fc0_0000;
const SECCOMP_RET_ALLOW = 0x7fff_0000;

const AF_UNIX = 1;
const AF_INET = 2;
const AF_INET6 = 10;
const SOCK_STREAM = 1;
const SOCK_SEQPACKET = 5;
const SOCK_DGRAM = 2;
const IPPROTO_UDP = 17;
const SO_TYPE = 3;
const MSG_DONTWAIT = 0x40;
const MSG_NOSIGNAL = 0x4000;
/** Unified syscall numbers (x86_64 and the generic table alike), Linux 5.3 and 5.6. */
const SYS_PIDFD_OPEN = 434;
const SYS_PIDFD_GETFD = 438;
const SOCK_CLOEXEC = 0x08_0000;
const IPPROTO_TCP = 6;
const SOL_SOCKET = 1;
const SCM_RIGHTS = 1;
const MSG_CMSG_CLOEXEC = 0x4000_0000;

const EPERM = 1;
const ENOENT = 2;
const EINTR = 4;
const EAGAIN = 11;
const EAFNOSUPPORT = 97;
const F_GETFD = 1;
const F_SETFD = 2;
const F_SETFL = 4;
const FD_CLOEXEC = 1;
const O_NONBLOCK = 0x800;
const POLLIN = 1;
const SIGKILL = 9;

// `_IO*('!', …)` values from linux/seccomp.h. They are identical on the two
// 64-bit release architectures because all four structures have the same UAPI
// layout there.
const SECCOMP_IOCTL_NOTIF_RECV = 0xc050_2100;
const SECCOMP_IOCTL_NOTIF_SEND = 0xc018_2101;
const SECCOMP_IOCTL_NOTIF_ID_VALID = 0x4008_2102;
const SECCOMP_IOCTL_NOTIF_ADDFD = 0x4018_2103;
const SECCOMP_ADDFD_FLAG_SETFD = 1;
const SECCOMP_ADDFD_FLAG_SEND = 2;

// Network access control arrived in ABI 4 (Linux 6.2). That kernel is newer
// than seccomp notification ADDFD (5.9) and WAIT_KILLABLE_RECV (5.19), so the
// Landlock minimum plus the action/structure probes cover every UAPI used here.
// ABI 4 also includes REFER (ABI 2)
// and TRUNCATE (ABI 3), so every write-shaped filesystem operation below can
// be handled. An older ABI would leave one of the rules D-118 needs unenforced.
const MINIMUM_ABI = 4;

const FS_READ_FILE = 1n << 2n;
const FS_READ_DIR = 1n << 3n;
const FS_READ_MASK = FS_READ_FILE | FS_READ_DIR;
const FS_WRITE_FILE = 1n << 1n;
const FS_REMOVE_DIR = 1n << 4n;
const FS_REMOVE_FILE = 1n << 5n;
const FS_MAKE_CHAR = 1n << 6n;
const FS_MAKE_DIR = 1n << 7n;
const FS_MAKE_REG = 1n << 8n;
const FS_MAKE_SOCK = 1n << 9n;
const FS_MAKE_FIFO = 1n << 10n;
const FS_MAKE_BLOCK = 1n << 11n;
const FS_MAKE_SYM = 1n << 12n;
const FS_REFER = 1n << 13n;
const FS_TRUNCATE = 1n << 14n;
const FS_MASK =
  FS_WRITE_FILE |
  FS_REMOVE_DIR |
  FS_REMOVE_FILE |
  FS_MAKE_CHAR |
  FS_MAKE_DIR |
  FS_MAKE_REG |
  FS_MAKE_SOCK |
  FS_MAKE_FIFO |
  FS_MAKE_BLOCK |
  FS_MAKE_SYM |
  FS_REFER |
  FS_TRUNCATE;

const NET_BIND_TCP = 1n << 0n;
const NET_CONNECT_TCP = 1n << 1n;
const SCOPE_ABSTRACT_UNIX_SOCKET = 1n << 0n;
const SCOPE_SIGNAL = 1n << 1n;

// Linux values, stable UAPI rather than libc-private flags.
const O_PATH = 0x20_0000;
const O_CLOEXEC = 0x08_0000;

/** libc is opened lazily: importing this module on macOS must remain harmless. */
function libc() {
  return dlopen("libc.so.6", {
    syscall: {
      // `syscall` is variadic. Six zero-filled argument slots cover every
      // Landlock call here and follow the Linux syscall calling convention.
      args: ["i64", "u64", "u64", "u64", "u64", "u64", "u64"],
      returns: "i64",
    },
    open: { args: ["cstring", "i32"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    execvp: { args: ["cstring", "ptr"], returns: "i32" },
    getenv: { args: ["cstring"], returns: "ptr" },
    setenv: { args: ["cstring", "cstring", "i32"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
    strerror: { args: ["i32"], returns: "ptr" },
    socketpair: { args: ["i32", "i32", "i32", "ptr"], returns: "i32" },
    socket: { args: ["i32", "i32", "i32"], returns: "i32" },
    connect: { args: ["i32", "ptr", "u32"], returns: "i32" },
    getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
    sendto: { args: ["i32", "ptr", "u64", "i32", "ptr", "u32"], returns: "i64" },
    fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
    posix_spawn: { args: ["ptr", "cstring", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    sendmsg: { args: ["i32", "ptr", "i32"], returns: "i64" },
    recvmsg: { args: ["i32", "ptr", "i32"], returns: "i64" },
    read: { args: ["i32", "ptr", "u64"], returns: "i64" },
    write: { args: ["i32", "ptr", "u64"], returns: "i64" },
    ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" },
    process_vm_readv: { args: ["i32", "ptr", "u64", "ptr", "u64", "u64"], returns: "i64" },
    kill: { args: ["i32", "i32"], returns: "i32" },
    waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
    getppid: { args: [], returns: "i32" },
  });
}

type Libc = ReturnType<typeof libc>;

/** Injection seam for testing the irreversible helper without fencing the test runner. */
export interface FenceHelperRuntime {
  readonly support: () => FenceSupport;
  readonly openLibc: () => Libc;
  readonly secureNetwork: (lib: Libc, tcpPorts: readonly number[], remote?: RemoteRule) => void;
  /** The directory the helper was started in; the kernel's own record of it when left out. */
  readonly cwd?: () => string;
}

/**
 * The helper's working directory, from the kernel's record of it. Read here and not from the process object
 * because `src/` takes ambient state as arguments (D-021, `test/guard/ambient-env.test.ts`); the helper is Linux
 * only and this is the one process whose working directory is an input.
 */
function ownWorkingDirectory(): string {
  return readlinkSync("/proc/self/cwd");
}

const REAL_HELPER_RUNTIME: FenceHelperRuntime = {
  support: fenceSupport,
  openLibc: libc,
  secureNetwork,
};

/** What the not-dumpable call needs of a C library: that one call, the way to say why it failed, and `close`. */
type PrctlLib = Pick<Libc, "close"> & {
  readonly symbols: Pick<Libc["symbols"], "prctl" | "__errno_location" | "strerror">;
};

/**
 * The names a C library goes by on Linux for this architecture: glibc's, then musl's (Alpine and its kin have no
 * `libc.so.6`). Only the not-dumpable call tries the second; the fence itself still needs glibc.
 */
export function libcNames(arch: string = process.arch): readonly string[] {
  const musl = arch === "x64" ? "libc.musl-x86_64.so.1" : arch === "arm64" ? "libc.musl-aarch64.so.1" : undefined;
  return musl === undefined ? ["libc.so.6"] : ["libc.so.6", musl];
}

/** The first of `names` that `open` accepts; when none does, the first failure, which names the library tried first. */
export function openFirst<T>(names: readonly string[], open: (name: string) => T): T {
  let first: unknown;
  for (const name of names) {
    try {
      return open(name);
    } catch (cause) {
      first ??= cause;
    }
  }
  throw first ?? new Error("no C library name to try");
}

/** libc, opened for `prctl` alone: glibc's name first, musl's after it. */
function prctlLibc(): PrctlLib {
  return openFirst(libcNames(), (name) =>
    dlopen(name, {
      prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
      strerror: { args: ["i32"], returns: "ptr" },
    }),
  );
}

/** The last libc error, copied before another native call can replace it. */
function lastError(lib: Pick<PrctlLib, "symbols">): string {
  const location = lib.symbols.__errno_location();
  const errno = location === null ? 0 : read.i32(location);
  const message = new CString(lib.symbols.strerror(errno));
  return `${message || "unknown error"} (errno ${errno})`;
}

/**
 * A variable of this process's own environment, as libc will hand it to the next program. Read through libc, not
 * through the process object, because it is the C environment that `execvp` passes on and the one the helper
 * edits just before it does (`src/` takes ambient state as arguments: D-021, `test/guard/ambient-env.test.ts`).
 */
function environmentValue(lib: Libc, name: string): string | undefined {
  const address = lib.symbols.getenv(name);
  return address === null ? undefined : String(new CString(address));
}

/** One fixed-arity wrapper around libc's variadic syscall. */
function syscall(
  lib: Libc,
  number: number,
  arg1: number | bigint = 0,
  arg2: number | bigint = 0,
  arg3: number | bigint = 0,
  arg4: number | bigint = 0,
  arg5: number | bigint = 0,
  arg6: number | bigint = 0,
): bigint {
  return lib.symbols.syscall(number, arg1, arg2, arg3, arg4, arg5, arg6);
}

const addressOf = (bytes: Uint8Array): bigint => BigInt(ptr(bytes));

let support: FenceSupport | undefined;

/**
 * Ask the kernel which Landlock ABI it supports.
 *
 * This does not install a domain in the Mind process — restriction is
 * irreversible and belongs only in the helper. The version query is the
 * kernel's side-effect-free feature probe. A ruleset can still fail for a bad
 * policy path; the helper reports that and exits 126 rather than running the
 * vendor without the rule.
 */
export function fenceSupport(): FenceSupport {
  if (support !== undefined) return support;
  if (process.platform !== "linux") {
    support = { ok: false, reason: `the Landlock/seccomp fence is only available on Linux (this is ${process.platform})` };
    return support;
  }

  const architecture = SECCOMP_ARCHITECTURES[process.arch];
  if (architecture === undefined) {
    support = {
      ok: false,
      reason: `the seccomp fence supports linux-x64 and linux-arm64, not ${process.arch}`,
    };
    return support;
  }

  let lib: Libc;
  try {
    lib = libc();
  } catch (cause) {
    support = { ok: false, reason: `the Linux C library could not be opened (${String(cause)})` };
    return support;
  }
  try {
    const abi = Number(syscall(lib, SYS_LANDLOCK_CREATE_RULESET, 0, 0, LANDLOCK_CREATE_RULESET_VERSION));
    if (abi < 0) {
      support = { ok: false, reason: `Landlock is unavailable: ${lastError(lib)}` };
    } else if (abi < MINIMUM_ABI) {
      support = {
        ok: false,
        reason: `Landlock ABI ${abi} is too old; ABI ${MINIMUM_ABI} is required for TCP and complete write rules`,
      };
    } else {
      const action = new Uint32Array([SECCOMP_RET_USER_NOTIF]);
      if (
        syscall(
          lib,
          architecture.seccomp,
          SECCOMP_GET_ACTION_AVAIL,
          0,
          addressOf(new Uint8Array(action.buffer)),
        ) !== 0n
      ) {
        support = { ok: false, reason: `seccomp user notification is unavailable: ${lastError(lib)}` };
      } else {
        const sizes = new Uint16Array(3);
        if (
          syscall(
            lib,
            architecture.seccomp,
            SECCOMP_GET_NOTIF_SIZES,
            0,
            addressOf(new Uint8Array(sizes.buffer)),
          ) !== 0n
        ) {
          support = { ok: false, reason: `seccomp notification sizes are unavailable: ${lastError(lib)}` };
        } else if (sizes[0]! < 80 || sizes[1]! < 24 || sizes[2]! < 64) {
          support = {
            ok: false,
            reason: `seccomp notification structures are too small (${sizes.join("/")}; need 80/24/64)`,
          };
        } else {
          support = { ok: true, abi };
        }
      }
    }
    return support;
  } finally {
    lib.close();
  }
}

/** What {@link engineNotDumpable} found. */
export type NotDumpable = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * `prctl(PR_SET_DUMPABLE, 0)` on an already-open libc, asked back to make sure it took. Never throws.
 */
function setNotDumpable(lib: PrctlLib): NotDumpable {
  try {
    if (lib.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) {
      return { ok: false, reason: `prctl(PR_SET_DUMPABLE, 0): ${lastError(lib)}` };
    }
    // Asked back, because "the call returned 0" and "the flag is 0" are two claims.
    if (lib.symbols.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) !== 0) {
      return { ok: false, reason: "prctl(PR_SET_DUMPABLE, 0) returned 0 and the process is still dumpable" };
    }
    return { ok: true };
  } catch (cause) {
    return { ok: false, reason: `prctl could not be called (${String(cause)})` };
  }
}

/**
 * Make this process not dumpable (EXEC-02).
 *
 * A process of the same user can read `/proc/<pid>/environ` and `/proc/<pid>/mem` of any process that is
 * dumpable, which is every process by default. The engine's environment holds the owner's cloud keys and
 * `MIND_*` settings, and every vendor CLI the engine starts, and every command that CLI's Bash tool runs, is
 * the same user. With the flag at 0 the kernel gives those files to root and refuses the read.
 *
 * Linux only, through the C library (glibc's name first, then musl's: {@link libcNames}). It is the flag of one
 * process: `execve` of an ordinary program sets it back to 1, so it protects the process that calls it for as long
 * as that process stays the engine. A child that is a new program must call it for itself.
 *
 * Off Linux there is no `/proc` to close, and it says so rather than pretending.
 */
export function engineNotDumpable(
  platform: string = process.platform,
  openLibc: () => PrctlLib = prctlLibc,
): NotDumpable {
  if (platform !== "linux") return { ok: false, reason: `PR_SET_DUMPABLE is Linux's; this is ${platform}` };
  let lib: PrctlLib;
  try {
    lib = openLibc();
  } catch (cause) {
    return { ok: false, reason: `libc could not be opened (${String(cause)})` };
  }
  try {
    return setNotDumpable(lib);
  } finally {
    lib.close();
  }
}

/**
 * The one line to tell the owner when {@link engineNotDumpable} could not do it, or `undefined` when there is
 * nothing to say: it worked, or this is not Linux and there is nothing to close.
 */
export function notDumpableNote(result: NotDumpable, platform: string = process.platform): string | undefined {
  if (result.ok || platform !== "linux") return undefined;
  return (
    `mind: could not close this process's /proc/<pid>/environ (${result.reason}); ` +
    "a program this command starts, running as you, can read the environment it holds."
  );
}

/** Validate at the seam, before a helper is spawned with an impossible policy. */
function policyProblem(policy: FencePolicy): string | undefined {
  for (const path of policy.writable) {
    if (!isAbsolute(path)) return `writable path is not absolute: ${JSON.stringify(path)}`;
    if (!existsSync(path)) return `writable path does not exist: ${JSON.stringify(path)}`;
    try {
      if (!statSync(path).isDirectory()) return `writable path is not a directory: ${JSON.stringify(path)}`;
    } catch (cause) {
      return `writable path could not be inspected: ${JSON.stringify(path)} (${String(cause)})`;
    }
  }
  for (const port of [...policy.tcpPorts, ...(policy.remotePorts ?? [])]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return `TCP port is not a whole number from 1 to 65535: ${JSON.stringify(port)}`;
    }
  }
  for (const resolver of policy.resolvers ?? []) {
    if (ipv4Bytes(resolver) === undefined) return `name server is not an IPv4 literal: ${JSON.stringify(resolver)}`;
  }
  for (const path of policy.readable ?? []) {
    if (!isAbsolute(path)) return `readable path is not absolute: ${JSON.stringify(path)}`;
    if (!existsSync(path)) return `readable path does not exist: ${JSON.stringify(path)}`;
  }
  return undefined;
}

/**
 * Build the argv that re-enters this engine as its hidden Landlock helper.
 *
 * There is no shell and therefore no quoting grammar. Each path and port is a
 * separate argv element, and `--` is the only boundary the helper accepts.
 *
 * Reads are confined for every turn built here (EXEC-02): `--confine-reads` comes first. The helper started
 * without it, as the tests that drive the helper directly start it, reads freely as it always did.
 */
export function fencedArgv(argv: readonly string[], policy: FencePolicy): string[] {
  if (argv.length === 0 || argv[0] === "") throw new Error("a fence cannot run an empty command");
  const problem = policyProblem(policy);
  if (problem !== undefined) throw new Error(`invalid fence policy: ${problem}`);
  return [
    // The same two runtime shapes as the CLI's hook launcher, kept local so a
    // type-only `TurnRequest` import does not make ledger code structurally
    // reachable from the subprocess chokepoint. In a checkout Bun.main is the
    // real TypeScript entry; in a compiled executable it is embedded and does
    // not exist as a file, so the executable re-enters itself directly.
    ...(Bun.main.endsWith(".ts") && isAbsolute(Bun.main) && existsSync(Bun.main)
      ? [process.execPath, "run", Bun.main]
      : [process.execPath]),
    "__fence",
    "--confine-reads",
    ...policy.writable.flatMap((path) => ["--rw", path]),
    ...policy.tcpPorts.flatMap((port) => ["--tcp-port", String(port)]),
    ...(policy.remotePorts ?? []).flatMap((port) => ["--remote-port", String(port)]),
    ...(policy.resolvers ?? []).flatMap((resolver) => ["--resolver", resolver]),
    ...(policy.readable ?? []).flatMap((path) => ["--ro", path]),
    "--",
    ...argv,
  ];
}

type ParsedHelper =
  | {
      readonly ok: true;
      readonly policy: FencePolicy;
      /** Present, and `true`, exactly when `--confine-reads` was given: reads are confined to {@link readGrants}. */
      readonly confineReads?: true;
      readonly command: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** Strict parsing is part of fail-closed: an ignored option is an ignored rule. */
export function parseFenceHelperArgv(argv: readonly string[]): ParsedHelper {
  const boundary = argv.indexOf("--");
  if (boundary < 0) return { ok: false, reason: "missing -- before the command" };
  const command = argv.slice(boundary + 1);
  if (command.length === 0 || command[0] === "") return { ok: false, reason: "no command was given" };

  const writable: string[] = [];
  const tcpPorts: number[] = [];
  const remotePorts: number[] = [];
  const resolvers: string[] = [];
  const readable: string[] = [];
  let confineReads = false;
  let index = 0;
  while (index < boundary) {
    const flag = argv[index];
    if (flag === "--confine-reads") {
      confineReads = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || index + 1 >= boundary) {
      return { ok: false, reason: `missing value for ${flag ?? "an option"}` };
    }
    if (flag === "--rw") writable.push(value);
    else if (flag === "--tcp-port") tcpPorts.push(Number(value));
    else if (flag === "--remote-port") remotePorts.push(Number(value));
    else if (flag === "--resolver") resolvers.push(value);
    else if (flag === "--ro") readable.push(value);
    else return { ok: false, reason: `unknown option ${JSON.stringify(flag)}` };
    index += 2;
  }
  // The cloud fields only when given, so a local turn's policy reads exactly as it always has.
  const policy: FencePolicy = {
    writable,
    tcpPorts,
    ...(remotePorts.length > 0 ? { remotePorts } : {}),
    ...(resolvers.length > 0 ? { resolvers } : {}),
    ...(readable.length > 0 ? { readable } : {}),
  };
  const problem = policyProblem(policy);
  if (problem !== undefined) return { ok: false, reason: `invalid fence policy: ${problem}` };
  return confineReads ? { ok: true, policy, confineReads: true, command } : { ok: true, policy, command };
}

function u64(view: DataView, offset: number, value: bigint): void {
  view.setBigUint64(offset, value, true);
}

/** A `struct landlock_ruleset_attr`, including ABI-6 process scoping. */
function rulesetAttributes(abi: number, confineReads = false): Uint8Array {
  // `scoped` joined the UAPI struct in ABI 6. Passing the ABI-4/5 size keeps
  // support honest on those kernels instead of relying on their treatment of
  // an unknown, zero-filled trailing field.
  const bytes = new Uint8Array(abi >= 6 ? 24 : 16);
  const view = new DataView(bytes.buffer);
  // Read rights are handled only when the helper was told to confine reads: a ruleset that handles them
  // denies every read no rule grants, which is the whole point and also why it is not the default of the
  // hidden helper that older callers and tests drive directly.
  u64(view, 0, confineReads ? FS_MASK | FS_READ_MASK : FS_MASK);
  // Handle both operations even when there are no allow rules. That means an
  // empty `tcpPorts` list denies every TCP bind and connect; it never means
  // "network unrestricted".
  u64(view, 8, NET_BIND_TCP | NET_CONNECT_TCP);
  if (abi >= 6) u64(view, 16, SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL);
  return bytes;
}

/** Packed UAPI `struct landlock_path_beneath_attr` (8-byte mask + 4-byte fd). */
function pathRule(fd: number, access: bigint = FS_MASK): Uint8Array {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  u64(view, 0, access);
  view.setInt32(8, fd, true);
  return bytes;
}

/** `struct landlock_net_port_attr`. */
function portRule(port: number): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  u64(view, 0, NET_CONNECT_TCP);
  u64(view, 8, BigInt(port));
  return bytes;
}

/** Add one rule or throw while the errno still describes that syscall. */
function addRule(lib: Libc, ruleset: number, type: number, rule: Uint8Array, what: string): void {
  const result = syscall(lib, SYS_LANDLOCK_ADD_RULE, ruleset, type, addressOf(rule), 0);
  if (result !== 0n) throw new Error(`${what}: ${lastError(lib)}`);
}

interface FilterInstruction {
  readonly code: number;
  readonly jt?: number | string;
  readonly jf?: number | string;
  readonly k: number;
  readonly label?: string;
}

/** Build classic BPF with named forward jumps, then encode `struct sock_filter[]`. */
function bpf(instructions: readonly FilterInstruction[]): Uint8Array {
  const labels = new Map<string, number>();
  instructions.forEach((instruction, index) => {
    if (instruction.label !== undefined) labels.set(instruction.label, index);
  });
  const jump = (at: number, target: number | string | undefined): number => {
    if (target === undefined || typeof target === "number") return target ?? 0;
    const destination = labels.get(target);
    if (destination === undefined) throw new Error(`internal seccomp label is missing: ${target}`);
    const distance = destination - at - 1;
    if (distance < 0 || distance > 255) throw new Error(`internal seccomp jump is out of range: ${target}`);
    return distance;
  };
  const bytes = new Uint8Array(instructions.length * 8);
  const view = new DataView(bytes.buffer);
  instructions.forEach((instruction, index) => {
    const offset = index * 8;
    view.setUint16(offset, instruction.code, true);
    view.setUint8(offset + 2, jump(index, instruction.jt));
    view.setUint8(offset + 3, jump(index, instruction.jf));
    view.setUint32(offset + 4, instruction.k >>> 0, true);
  });
  return bytes;
}

const LD_W_ABS = 0x20;
const ALU_AND_K = 0x54;
const JMP_JEQ_K = 0x15;
const JMP_JSET_K = 0x45;
const RET_K = 0x06;

/**
 * The first filter owns every network-shaped syscall. `sendmsg` remains open
 * for exactly long enough to pass the new listener over the already-created
 * AF_UNIX socket; a second stacked filter closes it before exec.
 */
function networkFilter(architecture: SeccompArchitecture, datagram = false): Uint8Array {
  // D-192: a cloud turn's name lookups. With `datagram`, an AF_INET UDP socket may be created and a `sendto`
  // that names a destination goes to the supervisor, which sends it itself — only to a name server on port 53.
  // Without it (every local turn) both stay refused, exactly as D-123 built them.
  return bpf([
    { code: LD_W_ABS, k: 4 },
    { code: JMP_JEQ_K, k: architecture.audit, jt: 1 },
    { code: RET_K, k: SECCOMP_RET_KILL_PROCESS },
    { code: LD_W_ABS, k: 0 },
    // x32 shares AUDIT_ARCH_X86_64 but ORs this bit into every syscall
    // number. Without this check its alternate table would miss every rule.
    { code: JMP_JSET_K, k: 0x4000_0000, jt: "kill" },
    { code: JMP_JEQ_K, k: architecture.socket, jt: "socket" },
    { code: JMP_JEQ_K, k: architecture.socketpair, jt: "socketpair" },
    { code: JMP_JEQ_K, k: architecture.connect, jt: "notify" },
    { code: JMP_JEQ_K, k: architecture.sendto, jt: "sendto" },
    { code: JMP_JEQ_K, k: architecture.sendmmsg, jt: "eperm" },
    { code: JMP_JEQ_K, k: architecture.ioUringSetup, jt: "eperm" },
    { code: RET_K, k: SECCOMP_RET_ALLOW },

    // `sendto(fd, …, NULL, 0)` is the ordinary connected-TCP send used by
    // Bun/libuv. Its destination is the already-supervised socket, and both
    // halves of the captured 64-bit pointer are immutable scalar arguments.
    { code: LD_W_ABS, k: 48, label: "sendto" },
    { code: JMP_JEQ_K, k: 0, jf: datagram ? "notify" : "eperm" },
    { code: LD_W_ABS, k: 52 },
    { code: JMP_JEQ_K, k: 0, jt: "send_allowed", jf: datagram ? "notify" : "eperm" },
    { code: RET_K, k: SECCOMP_RET_ALLOW, label: "send_allowed" },

    { code: LD_W_ABS, k: 16, label: "socket" },
    { code: JMP_JEQ_K, k: AF_INET, jt: "inet_socket" },
    { code: JMP_JEQ_K, k: AF_UNIX, jt: "unix_socket" },
    { code: JMP_JEQ_K, k: AF_INET6, jt: "eafnosupport", jf: "eperm" },

    { code: LD_W_ABS, k: 24, label: "inet_socket" },
    { code: ALU_AND_K, k: 0xf },
    { code: JMP_JEQ_K, k: SOCK_STREAM, jt: "inet_protocol", jf: "inet_dgram" },
    { code: LD_W_ABS, k: 32, label: "inet_protocol" },
    { code: JMP_JEQ_K, k: 0, jt: "allow" },
    { code: JMP_JEQ_K, k: IPPROTO_TCP, jt: "allow", jf: "eperm" },
    { code: JMP_JEQ_K, k: datagram ? SOCK_DGRAM : 0xffff_ffff, jt: "udp_protocol", jf: "eperm", label: "inet_dgram" },
    { code: LD_W_ABS, k: 32, label: "udp_protocol" },
    { code: JMP_JEQ_K, k: 0, jt: "allow" },
    { code: JMP_JEQ_K, k: IPPROTO_UDP, jt: "allow", jf: "eperm" },

    { code: LD_W_ABS, k: 24, label: "unix_socket" },
    { code: ALU_AND_K, k: 0xf },
    { code: JMP_JEQ_K, k: SOCK_STREAM, jt: "allow" },
    { code: JMP_JEQ_K, k: SOCK_SEQPACKET, jt: "allow", jf: "eperm" },

    { code: LD_W_ABS, k: 16, label: "socketpair" },
    { code: JMP_JEQ_K, k: AF_UNIX, jt: "unix_socketpair" },
    { code: JMP_JEQ_K, k: AF_INET6, jt: "eafnosupport", jf: "eperm" },
    { code: LD_W_ABS, k: 24, label: "unix_socketpair" },
    { code: ALU_AND_K, k: 0xf },
    { code: JMP_JEQ_K, k: SOCK_STREAM, jt: "allow" },
    { code: JMP_JEQ_K, k: SOCK_SEQPACKET, jt: "allow", jf: "eperm" },

    { code: RET_K, k: SECCOMP_RET_USER_NOTIF, label: "notify" },
    { code: RET_K, k: SECCOMP_RET_ALLOW, label: "allow" },
    { code: RET_K, k: SECCOMP_RET_ERRNO | EAFNOSUPPORT, label: "eafnosupport" },
    { code: RET_K, k: SECCOMP_RET_ERRNO | EPERM, label: "eperm" },
    { code: RET_K, k: SECCOMP_RET_KILL_PROCESS, label: "kill" },
  ]);
}

/** Close the one bootstrap syscall that the listener-transfer protocol used. */
function noSendmsgFilter(architecture: SeccompArchitecture): Uint8Array {
  return bpf([
    { code: LD_W_ABS, k: 4 },
    { code: JMP_JEQ_K, k: architecture.audit, jt: 1 },
    { code: RET_K, k: SECCOMP_RET_KILL_PROCESS },
    { code: LD_W_ABS, k: 0 },
    { code: JMP_JEQ_K, k: architecture.sendmsg, jt: 1 },
    { code: RET_K, k: SECCOMP_RET_ALLOW },
    { code: RET_K, k: SECCOMP_RET_ERRNO | EPERM },
  ]);
}

/** Install one filter and return its listener fd, or -1 for a filter without one. */
function installFilter(lib: Libc, architecture: SeccompArchitecture, filter: Uint8Array, listener: boolean): number {
  const program = new Uint8Array(16);
  const view = new DataView(program.buffer);
  view.setUint16(0, filter.byteLength / 8, true);
  view.setBigUint64(8, addressOf(filter), true);
  const flags = listener
    ? SECCOMP_FILTER_FLAG_NEW_LISTENER | SECCOMP_FILTER_FLAG_WAIT_KILLABLE_RECV
    : 0;
  const result = Number(
    syscall(lib, architecture.seccomp, SECCOMP_SET_MODE_FILTER, flags, addressOf(program)),
  );
  if (result < 0) throw new Error(`seccomp(SECCOMP_SET_MODE_FILTER): ${lastError(lib)}`);
  return result;
}

/** One `sendmsg(SCM_RIGHTS)`, used before the second filter closes sendmsg. */
function sendFd(lib: Libc, channel: number, fd: number): void {
  const byte = new Uint8Array([1]);
  const iovec = new Uint8Array(16);
  const iov = new DataView(iovec.buffer);
  iov.setBigUint64(0, addressOf(byte), true);
  iov.setBigUint64(8, 1n, true);

  const control = new Uint8Array(24);
  const cmsg = new DataView(control.buffer);
  cmsg.setBigUint64(0, 20n, true);
  cmsg.setInt32(8, SOL_SOCKET, true);
  cmsg.setInt32(12, SCM_RIGHTS, true);
  cmsg.setInt32(16, fd, true);

  const message = new Uint8Array(56);
  const msg = new DataView(message.buffer);
  msg.setBigUint64(16, addressOf(iovec), true);
  msg.setBigUint64(24, 1n, true);
  msg.setBigUint64(32, addressOf(control), true);
  msg.setBigUint64(40, BigInt(control.byteLength), true);
  if (lib.symbols.sendmsg(channel, message, 0) !== 1n) {
    throw new Error(`sendmsg(seccomp listener): ${lastError(lib)}`);
  }
}

/** Start the clean supervisor process under Landlock but before seccomp. */
function spawnSupervisor(lib: Libc, channel: number, tcpPorts: readonly number[], remote: RemoteRule = NO_REMOTE): number {
  const prefix = Bun.main.endsWith(".ts") && isAbsolute(Bun.main) && existsSync(Bun.main)
    ? [process.execPath, "run", Bun.main]
    : [process.execPath];
  const argv = nativeArgv([
    ...prefix,
    "__fence-supervisor",
    "--control-fd",
    String(channel),
    ...tcpPorts.flatMap((port) => ["--tcp-port", String(port)]),
    ...remote.ports.flatMap((port) => ["--remote-port", String(port)]),
    ...remote.resolvers.flatMap((resolver) => ["--resolver", resolver]),
  ]);
  // The supervisor needs no ambient configuration, and inheriting the
  // vendor's credential-bearing environment would widen what this fixed child
  // can see for no purpose.
  const environment = new BigUint64Array(1);
  const pid = new Int32Array(1);
  void argv.strings;
  const result = lib.symbols.posix_spawn(
    pid,
    process.execPath,
    null,
    null,
    argv.pointers,
    environment,
  );
  if (result !== 0) throw new Error(`posix_spawn(seccomp supervisor): ${result}`);
  return pid[0]!;
}

/**
 * Start the supervisor, install both filters, transfer the listener, and wait
 * for its acknowledgement. Any missing step throws before the vendor execs.
 */
function secureNetwork(lib: Libc, tcpPorts: readonly number[], remote: RemoteRule = NO_REMOTE): void {
  const architecture = SECCOMP_ARCHITECTURES[process.arch];
  if (architecture === undefined) throw new Error(`unsupported seccomp architecture ${process.arch}`);

  const pair = new Int32Array(2);
  if (lib.symbols.socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, pair) !== 0) {
    throw new Error(`socketpair(seccomp supervisor): ${lastError(lib)}`);
  }
  const targetChannel = pair[0]!;
  const supervisorChannel = pair[1]!;
  let supervisor = -1;
  let listener = -1;
  try {
    const fdFlags = lib.symbols.fcntl(supervisorChannel, F_GETFD, 0);
    if (fdFlags < 0 || lib.symbols.fcntl(supervisorChannel, F_SETFD, fdFlags & ~FD_CLOEXEC) !== 0) {
      throw new Error(`fcntl(seccomp supervisor channel): ${lastError(lib)}`);
    }
    supervisor = spawnSupervisor(lib, supervisorChannel, [...new Set(tcpPorts)], {
      ports: [...new Set(remote.ports)],
      resolvers: [...new Set(remote.resolvers)],
    });
    lib.symbols.close(supervisorChannel);
    // The notifier is a child of this helper, while process_vm_readv normally
    // grants a parent access to its child. Name this one fixed child explicitly
    // so Yama cannot make every otherwise-valid connect fail at the read step.
    if (lib.symbols.prctl(PR_SET_PTRACER, supervisor, 0, 0, 0) !== 0) {
      throw new Error(`prctl(PR_SET_PTRACER, seccomp supervisor): ${lastError(lib)}`);
    }

    listener = installFilter(lib, architecture, networkFilter(architecture, remote.resolvers.length > 0), true);
    sendFd(lib, targetChannel, listener);
    installFilter(lib, architecture, noSendmsgFilter(architecture), false);
    lib.symbols.close(listener);
    listener = -1;

    const acknowledgement = new Uint8Array(1);
    if (lib.symbols.read(targetChannel, acknowledgement, 1) !== 1n || acknowledgement[0] !== 1) {
      throw new Error("the seccomp supervisor did not acknowledge its listener");
    }
  } catch (cause) {
    if (supervisor > 0) {
      lib.symbols.kill(supervisor, SIGKILL);
      const status = new Int32Array(1);
      lib.symbols.waitpid(supervisor, status, 0);
    }
    throw cause;
  } finally {
    if (listener >= 0) lib.symbols.close(listener);
    lib.symbols.close(targetChannel);
    if (supervisor < 0) lib.symbols.close(supervisorChannel);
  }
}

/** Turn strings into stable NUL-terminated buffers and one native `char **`. */
function nativeArgv(argv: readonly string[]): { readonly strings: Uint8Array[]; readonly pointers: BigUint64Array } {
  const encoder = new TextEncoder();
  const strings = argv.map((arg) => {
    if (arg.includes("\0")) throw new Error("an argv element contains NUL");
    const encoded = encoder.encode(arg);
    const nul = new Uint8Array(encoded.length + 1);
    nul.set(encoded);
    return nul;
  });
  const pointers = new BigUint64Array(strings.length + 1);
  strings.forEach((string, index) => {
    pointers[index] = BigInt(ptr(string));
  });
  return { strings, pointers };
}

function errnoNumber(lib: Libc): number {
  const location = lib.symbols.__errno_location();
  return location === null ? EPERM : read.i32(location);
}

function receiveFd(lib: Libc, channel: number): number {
  const byte = new Uint8Array(1);
  const iovec = new Uint8Array(16);
  const iov = new DataView(iovec.buffer);
  iov.setBigUint64(0, addressOf(byte), true);
  iov.setBigUint64(8, 1n, true);
  const control = new Uint8Array(24);
  const message = new Uint8Array(56);
  const msg = new DataView(message.buffer);
  msg.setBigUint64(16, addressOf(iovec), true);
  msg.setBigUint64(24, 1n, true);
  msg.setBigUint64(32, addressOf(control), true);
  msg.setBigUint64(40, BigInt(control.byteLength), true);
  if (lib.symbols.recvmsg(channel, message, MSG_CMSG_CLOEXEC) !== 1n) {
    throw new Error(`recvmsg(seccomp listener): ${lastError(lib)}`);
  }
  const cmsg = new DataView(control.buffer);
  if (
    cmsg.getBigUint64(0, true) < 20n ||
    cmsg.getInt32(8, true) !== SOL_SOCKET ||
    cmsg.getInt32(12, true) !== SCM_RIGHTS
  ) {
    throw new Error("the seccomp supervisor received no listener fd");
  }
  return cmsg.getInt32(16, true);
}

function sendNotificationError(lib: Libc, listener: number, id: bigint, error: number): void {
  const response = new Uint8Array(24);
  const view = new DataView(response.buffer);
  view.setBigUint64(0, id, true);
  view.setBigInt64(8, 0n, true);
  view.setInt32(16, -Math.abs(error), true);
  if (lib.symbols.ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, response) !== 0) {
    const errno = errnoNumber(lib);
    if (errno !== ENOENT) throw new Error(`ioctl(SECCOMP_IOCTL_NOTIF_SEND): ${lastError(lib)}`);
  }
}

function readSockaddr(lib: Libc, pid: number, remoteAddress: bigint, length: bigint): Uint8Array | undefined {
  if (remoteAddress === 0n || length < 16n) return undefined;
  const address = new Uint8Array(16);
  const local = new Uint8Array(16);
  const remote = new Uint8Array(16);
  const localView = new DataView(local.buffer);
  const remoteView = new DataView(remote.buffer);
  localView.setBigUint64(0, addressOf(address), true);
  localView.setBigUint64(8, 16n, true);
  remoteView.setBigUint64(0, remoteAddress, true);
  remoteView.setBigUint64(8, 16n, true);
  return lib.symbols.process_vm_readv(pid, local, 1, remote, 1, 0) === 16n ? address : undefined;
}

/**
 * What a cloud turn may reach besides loopback ports (D-192): TCP ports at any address that is not loopback, and
 * the name servers on {@link DNS_PORT}. Empty for a local turn.
 */
export interface RemoteRule {
  readonly ports: readonly number[];
  readonly resolvers: readonly string[];
}

const NO_REMOTE: RemoteRule = { ports: [], resolvers: [] };

/** The supervisor's own copy of a {@link RemoteRule}, in the shapes it compares against. */
interface RemoteSets {
  readonly ports: ReadonlySet<number>;
  readonly resolvers: ReadonlySet<string>;
}

const NO_REMOTE_SETS: RemoteSets = { ports: new Set(), resolvers: new Set() };

/**
 * One copied `sockaddr_in`, judged. Three ways in and no other:
 * - `127.0.0.1` on one of the loopback `ports` (D-123, the local turn's rule, unchanged);
 * - a name server of `remote.resolvers` on port 53 (D-192);
 * - any address that is not loopback (`127.0.0.0/8`) nor `0.0.0.0/8` on one of `remote.ports` (D-192).
 * Anything that is not AF_INET is refused: IPv6 sockets are never created and AF_UNIX connects come here too.
 */
function allowedAddress(address: Uint8Array, ports: ReadonlySet<number>, remote: RemoteSets = NO_REMOTE_SETS): boolean {
  const view = new DataView(address.buffer, address.byteOffset, address.byteLength);
  if (view.getUint16(0, true) !== AF_INET) return false;
  const port = view.getUint16(2, false);
  const host = `${address[4]}.${address[5]}.${address[6]}.${address[7]}`;
  if (host === "127.0.0.1" && ports.has(port)) return true;
  if (port === DNS_PORT && remote.resolvers.has(host)) return true;
  const loopback = address[4] === 127 || address[4] === 0;
  return !loopback && remote.ports.has(port);
}

/**
 * Whether the target's own socket was non-blocking, from `/proc/<pid>/fdinfo/<fd>` (the `flags:` field, octal).
 * Unreadable means yes, the behaviour before D-192, because every runtime the fence was measured with (Bun, Node)
 * uses non-blocking sockets. It decides only whether a call on the socket waits; nothing about where it goes.
 */
export function targetNonBlocking(pid: number, fd: number, read: (path: string) => string = readProc): boolean {
  try {
    const flags = /^flags:\s*([0-7]+)/m.exec(read(`/proc/${pid}/fdinfo/${fd}`));
    return flags === null ? true : (parseInt(flags[1]!, 8) & O_NONBLOCK) !== 0;
  } catch {
    return true;
  }
}

function readProc(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Handle one notification by connecting a fresh supervisor-owned socket and
 * atomically replacing the target fd. The target's sockaddr is only input to
 * this local copy; its original `connect` is never continued.
 */
function handleConnect(
  lib: Libc,
  listener: number,
  notification: Uint8Array,
  ports: ReadonlySet<number>,
  remote: RemoteSets = NO_REMOTE_SETS,
): void {
  const view = new DataView(notification.buffer, notification.byteOffset, notification.byteLength);
  const id = view.getBigUint64(0, true);
  const pid = view.getUint32(8, true);
  const targetFd = view.getBigUint64(32, true);
  const remoteAddress = view.getBigUint64(40, true);
  const length = view.getBigUint64(48, true);
  const address = readSockaddr(lib, pid, remoteAddress, length);
  if (address === undefined || !allowedAddress(address, ports, remote) || targetFd > 0x7fff_ffffn) {
    sendNotificationError(lib, listener, id, EPERM);
    return;
  }

  const validId = new BigUint64Array([id]);
  if (lib.symbols.ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, validId) !== 0) return;

  // D-192. A cloud turn may hold UDP sockets (its name lookups), and an address allowed for TCP is not allowed
  // for UDP: QUIC to port 443 is not F3's "TCP to port 443". So the target's socket is looked at first. A UDP
  // socket may be connected to a name server on port 53 and to nothing else, and it is connected here, on the
  // target's own socket, from this supervisor's copy of the address.
  if (remote.resolvers.size > 0) {
    const target = targetSocket(lib, pid, Number(targetFd));
    if (target === undefined) {
      sendNotificationError(lib, listener, id, EPERM);
      return;
    }
    try {
      if (target.type === SOCK_DGRAM) {
        if (!resolverAddress(address, remote)) {
          sendNotificationError(lib, listener, id, EPERM);
          return;
        }
        const result = lib.symbols.connect(target.fd, address, address.byteLength);
        sendNotificationValue(lib, listener, id, result === 0 ? 0n : -1n, result === 0 ? 0 : errnoNumber(lib));
        return;
      }
      if (target.type !== SOCK_STREAM) {
        sendNotificationError(lib, listener, id, EPERM);
        return;
      }
    } finally {
      lib.symbols.close(target.fd);
    }
  }

  const connected = lib.symbols.socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
  if (connected < 0) {
    sendNotificationError(lib, listener, id, errnoNumber(lib));
    return;
  }
  try {
    if (lib.symbols.connect(connected, address, address.byteLength) !== 0) {
      const error = errnoNumber(lib);
      sendNotificationError(lib, listener, id, error);
      return;
    }
    // The injected socket is a new open file description, so it carries none of the target's status flags.
    // Copy the one that matters: a runtime's event loop (Bun, libuv) made its socket non-blocking, while the C
    // library's resolver (`RES_OPTIONS=use-vc`, D-192) made a blocking one and fails on the first EAGAIN.
    if (targetNonBlocking(pid, Number(targetFd)) && lib.symbols.fcntl(connected, F_SETFL, O_NONBLOCK) !== 0) {
      sendNotificationError(lib, listener, id, errnoNumber(lib));
      return;
    }
    const add = new Uint8Array(24);
    const addView = new DataView(add.buffer);
    addView.setBigUint64(0, id, true);
    addView.setUint32(8, SECCOMP_ADDFD_FLAG_SETFD | SECCOMP_ADDFD_FLAG_SEND, true);
    addView.setUint32(12, connected, true);
    addView.setUint32(16, Number(targetFd), true);
    addView.setUint32(20, O_CLOEXEC, true);
    if (lib.symbols.ioctl(listener, SECCOMP_IOCTL_NOTIF_ADDFD, add) < 0) {
      const error = errnoNumber(lib);
      if (error !== ENOENT) sendNotificationError(lib, listener, id, error);
    }
  } finally {
    lib.symbols.close(connected);
  }
}

/** True when this copied `sockaddr_in` is one of the turn's name servers on port 53. */
function resolverAddress(address: Uint8Array, remote: RemoteSets): boolean {
  const view = new DataView(address.buffer, address.byteOffset, address.byteLength);
  return (
    view.getUint16(0, true) === AF_INET &&
    view.getUint16(2, false) === DNS_PORT &&
    remote.resolvers.has(`${address[4]}.${address[5]}.${address[6]}.${address[7]}`)
  );
}

/**
 * A copy of the target's socket (`pidfd_getfd`, Linux 5.6) and its `SO_TYPE`, or `undefined` when it cannot be
 * had — then the call is refused. The copy shares the target's open file description: what the supervisor does
 * on it, it does to the target's socket. Needs the same ptrace access as reading the target's memory, which
 * `PR_SET_PTRACER` gives for the vendor's own process.
 */
function targetSocket(lib: Libc, pid: number, fd: number): { readonly fd: number; readonly type: number } | undefined {
  // A notification names the calling thread. `pidfd_open` wants a process, so a thread that is not its group's
  // leader is opened by its group (measured: codex's resolver runs on a worker thread, and every lookup failed).
  const pidfd = Number(syscall(lib, SYS_PIDFD_OPEN, threadGroup(pid), 0));
  if (pidfd < 0) return undefined;
  try {
    const copy = Number(syscall(lib, SYS_PIDFD_GETFD, pidfd, fd, 0));
    if (copy < 0) return undefined;
    const type = new Int32Array(1);
    const size = new Uint32Array([4]);
    if (lib.symbols.getsockopt(copy, SOL_SOCKET, SO_TYPE, type, size) !== 0) {
      lib.symbols.close(copy);
      return undefined;
    }
    return { fd: copy, type: type[0]! };
  } finally {
    lib.symbols.close(pidfd);
  }
}

/** The thread group (process) a thread id belongs to, from `/proc/<tid>/status`; the id itself when unreadable. */
export function threadGroup(tid: number, read: (path: string) => string = readProc): number {
  try {
    const found = /^Tgid:\s*(\d+)/m.exec(read(`/proc/${tid}/status`));
    return found === null ? tid : Number(found[1]);
  } catch {
    return tid;
  }
}

/** Answer a notification with a return value (`error` 0) or an errno (`val` ignored). */
function sendNotificationValue(lib: Libc, listener: number, id: bigint, value: bigint, error: number): void {
  if (error !== 0) {
    sendNotificationError(lib, listener, id, error);
    return;
  }
  const response = new Uint8Array(24);
  const view = new DataView(response.buffer);
  view.setBigUint64(0, id, true);
  view.setBigInt64(8, value, true);
  view.setInt32(16, 0, true);
  if (lib.symbols.ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, response) !== 0) {
    const errno = errnoNumber(lib);
    if (errno !== ENOENT) throw new Error(`ioctl(SECCOMP_IOCTL_NOTIF_SEND): ${lastError(lib)}`);
  }
}

/** The largest datagram the supervisor will carry: a DNS query over UDP is far smaller (EDNS0 caps at 4096). */
const MAX_DATAGRAM = 4096;

/**
 * D-192. A `sendto` that names a destination, from a cloud turn: a name lookup over UDP (musl's resolver, and
 * codex's own, send that way and never fall back to TCP). Sent by the supervisor itself, from its own copies of
 * the destination and the bytes, on a copy of the target's UDP socket — only to a name server on port 53, and
 * never continued, so no second thread can change either after the check.
 */
function handleSendto(lib: Libc, listener: number, notification: Uint8Array, remote: RemoteSets): void {
  const view = new DataView(notification.buffer, notification.byteOffset, notification.byteLength);
  const id = view.getBigUint64(0, true);
  const pid = view.getUint32(8, true);
  const targetFd = view.getBigUint64(32, true);
  const buffer = view.getBigUint64(40, true);
  const length = view.getBigUint64(48, true);
  const destination = view.getBigUint64(64, true);
  const addressLength = view.getBigUint64(72, true);
  const address = readSockaddr(lib, pid, destination, addressLength);
  if (address === undefined || !resolverAddress(address, remote) || targetFd > 0x7fff_ffffn || length > BigInt(MAX_DATAGRAM)) {
    sendNotificationError(lib, listener, id, EPERM);
    return;
  }
  const bytes = new Uint8Array(Math.max(1, Number(length)));
  if (length > 0n) {
    const local = new Uint8Array(16);
    const remoteIov = new Uint8Array(16);
    const localView = new DataView(local.buffer);
    const remoteView = new DataView(remoteIov.buffer);
    localView.setBigUint64(0, addressOf(bytes), true);
    localView.setBigUint64(8, length, true);
    remoteView.setBigUint64(0, buffer, true);
    remoteView.setBigUint64(8, length, true);
    if (lib.symbols.process_vm_readv(pid, local, 1, remoteIov, 1, 0) !== length) {
      sendNotificationError(lib, listener, id, EPERM);
      return;
    }
  }
  const validId = new BigUint64Array([id]);
  if (lib.symbols.ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, validId) !== 0) return;
  const target = targetSocket(lib, pid, Number(targetFd));
  if (target === undefined || target.type !== SOCK_DGRAM) {
    if (target !== undefined) lib.symbols.close(target.fd);
    sendNotificationError(lib, listener, id, EPERM);
    return;
  }
  try {
    const sent = lib.symbols.sendto(target.fd, bytes, length, MSG_DONTWAIT | MSG_NOSIGNAL, address, address.byteLength);
    sendNotificationValue(lib, listener, id, sent, sent < 0n ? errnoNumber(lib) : 0);
  } finally {
    lib.symbols.close(target.fd);
  }
}

/** One notification, by the syscall it is about: `connect` always, `sendto` only on a cloud turn. */
function handleNotification(
  lib: Libc,
  listener: number,
  notification: Uint8Array,
  ports: ReadonlySet<number>,
  remote: RemoteSets,
  architecture: SeccompArchitecture | undefined = SECCOMP_ARCHITECTURES[process.arch],
): void {
  const nr = new DataView(notification.buffer, notification.byteOffset, notification.byteLength).getInt32(16, true);
  if (architecture !== undefined && nr === architecture.sendto) {
    if (remote.resolvers.size > 0) handleSendto(lib, listener, notification, remote);
    else sendNotificationError(lib, listener, new DataView(notification.buffer, notification.byteOffset).getBigUint64(0, true), EPERM);
    return;
  }
  handleConnect(lib, listener, notification, ports, remote);
}

function supervise(
  lib: Libc,
  listener: number,
  ports: ReadonlySet<number>,
  targetPid: number,
  remote: RemoteSets = NO_REMOTE_SETS,
): void {
  if (lib.symbols.fcntl(listener, F_SETFL, O_NONBLOCK) !== 0) {
    throw new Error(`fcntl(seccomp listener, O_NONBLOCK): ${lastError(lib)}`);
  }
  const pollfd = new Uint8Array(8);
  const pollView = new DataView(pollfd.buffer);
  pollView.setInt32(0, listener, true);
  pollView.setInt16(4, POLLIN, true);
  while (true) {
    if (lib.symbols.getppid() !== targetPid) return;
    const ready = lib.symbols.poll(pollfd, 1, 100);
    if (ready < 0) {
      if (errnoNumber(lib) === EINTR) continue;
      throw new Error(`poll(seccomp listener): ${lastError(lib)}`);
    }
    if (ready === 0) continue;
    const notification = new Uint8Array(80);
    if (lib.symbols.ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, notification) !== 0) {
      const error = errnoNumber(lib);
      if (error === EINTR || error === EAGAIN) continue;
      // ENOENT means the filtered process tree is gone and no future request
      // can arrive. Any other error is fatal; closing the listener makes any
      // blocked or later connect fail rather than run unsupervised.
      if (error === ENOENT) return;
      throw new Error(`ioctl(SECCOMP_IOCTL_NOTIF_RECV): ${lastError(lib)}`);
    }
    handleNotification(lib, listener, notification, ports, remote);
  }
}

/** Entry point for the separate process which owns the notification listener. */
export function runFenceSupervisor(
  argv: readonly string[],
  openLibc: () => Libc = libc,
): number {
  let control = -1;
  const ports = new Set<number>();
  const remotePorts = new Set<number>();
  const resolvers = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const raw = argv[index + 1];
    if (raw === undefined) {
      console.error(`mind fence supervisor: missing value for ${flag ?? "an option"}`);
      return 126;
    }
    const value = Number(raw);
    if (flag === "--control-fd" && Number.isInteger(value) && value >= 0) control = value;
    else if (flag === "--tcp-port" && Number.isInteger(value) && value >= 1 && value <= 65_535) ports.add(value);
    else if (flag === "--remote-port" && Number.isInteger(value) && value >= 1 && value <= 65_535) remotePorts.add(value);
    else if (flag === "--resolver" && ipv4Bytes(raw) !== undefined) resolvers.add(raw);
    else {
      console.error(`mind fence supervisor: invalid option ${JSON.stringify(flag)}=${JSON.stringify(raw)}`);
      return 126;
    }
  }
  if (control < 0) {
    console.error("mind fence supervisor: no control fd was given");
    return 126;
  }

  let lib: Libc;
  try {
    lib = openLibc();
  } catch (cause) {
    console.error(`mind fence supervisor: libc could not be opened (${String(cause)})`);
    return 126;
  }
  // The supervisor is a child of the process it supervises, so by ancestry the vendor may read and write its
  // memory (`/proc/<pid>/mem`, ptrace) under Yama's default. Not dumpable, the kernel refuses that for any
  // process but root. The supervisor is a new program, so unlike the helper's, this flag lasts.
  void setNotDumpable(lib);
  let listener = -1;
  try {
    const targetPid = lib.symbols.getppid();
    listener = receiveFd(lib, control);
    const acknowledgement = new Uint8Array([1]);
    if (lib.symbols.write(control, acknowledgement, 1) !== 1n) {
      throw new Error(`write(seccomp acknowledgement): ${lastError(lib)}`);
    }
    lib.symbols.close(control);
    control = -1;
    // These are copies of the target's pipes. Keeping them open would make a
    // caller wait for supervisor EOF after the vendor itself had exited.
    lib.symbols.close(1);
    lib.symbols.close(2);
    supervise(lib, listener, ports, targetPid, { ports: remotePorts, resolvers });
    return 0;
  } catch (cause) {
    console.error(
      `mind fence supervisor: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return 126;
  } finally {
    if (listener >= 0) lib.symbols.close(listener);
    if (control >= 0) lib.symbols.close(control);
    lib.close();
  }
}

/**
 * Native pieces exposed only so tests can drive the supervisor in-process.
 * The real entry points above remain the only production callers.
 */
export const FENCE_TESTING = {
  architectures: SECCOMP_ARCHITECTURES,
  bpf,
  networkFilter,
  noSendmsgFilter,
  secureNetwork,
  receiveFd,
  sendNotificationError,
  readSockaddr,
  allowedAddress,
  handleConnect,
  handleSendto,
  handleNotification,
  targetSocket,
  resolverAddress,
  sendNotificationValue,
  supervise,
  addressOf,
  nativeBytes: (address: bigint, length: number) =>
    new Uint8Array(toArrayBuffer(address, 0, length)),
} as const;

/** Directories every program needs and that hold no one's files: code, libraries, configuration, devices. */
export const SYSTEM_READ_DIRS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/sys",
  // Granted whole because a Bun or Node program, the vendor's own helper processes and the supervisor among
  // them, reads /proc/self/maps of ITS OWN pid at start and aborts when it cannot (measured), and Landlock
  // names a path, never "my own pid". What that leaves open is the command line of every process, which any
  // local user can read anyway. The environment, memory and open files of a process outside the fence are
  // refused by the kernel on their own: Landlock denies ptrace-mode access to a task outside the domain, and
  // /proc/<pid>/environ is such an access (measured: 2 of 2610 readable inside, 515 outside).
  "/proc",
];

export interface ReadGrantInput {
  /** What the turn may write; each is readable too and needs no entry of its own. */
  readonly writable: readonly string[];
  /** The vendor command, as it will be exec'd. */
  readonly command: readonly string[];
  readonly cwd: string;
  readonly execPath: string;
  readonly main: string;
  /** D-192: more paths the turn may read, each kept or dropped by the same rule as the working directory. */
  readonly readable?: readonly string[];
}

export interface ReadGrantPlan {
  /** Real paths the ruleset reads from: directories and single files, with none inside another. */
  readonly paths: readonly string[];
  /** Why something that would normally be readable is not, one line each. */
  readonly notes: readonly string[];
  /**
   * The vendor as PATH finds it. Exec'd by this path, so that it does not depend on a PATH entry that
   * {@link readablePath} takes out.
   */
  readonly program?: string;
  /** Where the vendor and its interpreters were found: those PATH entries stay, though not readable. */
  readonly via: readonly string[];
}

/** The first line of a file when it starts `#!`, else `undefined`. */
function shebangOf(file: string): string | undefined {
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const bytes = Buffer.alloc(256);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, length).toString("latin1");
    return text.startsWith("#!") ? text.slice(2).split("\n")[0]!.trim() : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** The outermost `node_modules` directory above `file`, which holds a Node package and what it depends on. */
function outermostNodeModules(file: string): string | undefined {
  const parts = file.split("/");
  const at = parts.indexOf("node_modules");
  return at < 0 ? undefined : parts.slice(0, at + 1).join("/");
}

/**
 * The files a program needs in order to run, and the trees that hold its code: itself, the interpreter its
 * `#!` line names (an `env` one is looked up on this process's PATH), and for a script the directory it is in,
 * or `node_modules` when it is inside a package. A compiled vendor (claude, grok) is one file. `via` lists the
 * paths PATH gave for the program and its interpreters, before links are followed.
 */
function programFiles(
  start: string,
  cwd: string,
  depth = 0,
): { readonly files: string[]; readonly trees: string[]; readonly via: string[] } {
  let real: string;
  try {
    real = realpathSync(start);
  } catch {
    return { files: [], trees: [], via: [] };
  }
  const files = [real];
  const trees: string[] = [];
  const via = [start];
  const modules = outermostNodeModules(real);
  if (modules !== undefined) trees.push(modules);
  const line = depth < 3 ? shebangOf(real) : undefined;
  // A script Bun runs is looked up by listing its directory (measured: "Module not found" when the listing is
  // refused), so the directory that holds a script is the install tree of a script that is not in a package.
  if (line !== undefined && modules === undefined) trees.push(dirname(real));
  if (line !== undefined && line !== "") {
    const [interpreter, ...rest] = line.split(/\s+/);
    const program = basename(interpreter ?? "") === "env"
      ? rest.find((word) => !word.startsWith("-") && !word.includes("="))
      : interpreter;
    const found = program === undefined
      ? null
      : isAbsolute(program)
        ? program
        : Bun.which(program, { cwd });
    if (found !== null && found !== undefined) {
      const inner = programFiles(found, cwd, depth + 1);
      files.push(...inner.files);
      trees.push(...inner.trees);
      via.push(...inner.via);
    }
  }
  return { files, trees, via };
}

/**
 * Everything a confined turn may read, and nothing else (EXEC-02).
 *
 * Landlock denies a read that no rule grants, so this list is the whole of what the vendor and every command
 * its Bash tool runs can open: the system directories (and `/proc`, see {@link SYSTEM_READ_DIRS}), what the
 * turn may write, its working directory, the vendor program and its interpreter, and the engine's own
 * executable (the supervisor starts from it after the ruleset is in force).
 *
 * Nothing under the owner's home is granted by default. A grant that is not a system directory is dropped,
 * with a note, when it would hold a place the turn may write: the vendor's home is always one of those and
 * lies in Mind's state, so a working directory of `~` yields a turn that cannot read it, not one that reads
 * everything. What the turn may write is already readable and needs no grant of its own.
 */
export function readGrants(input: ReadGrantInput): ReadGrantPlan {
  const paths = new Set<string>();
  const notes: string[] = [];
  const real = (path: string): string | undefined => {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  };
  const writable = input.writable.map((path) => real(path) ?? path);
  const system = (path: string): void => {
    const resolved = real(path);
    if (resolved !== undefined) paths.add(resolved);
  };
  const derived = (label: string, path: string): void => {
    const resolved = real(path);
    if (resolved === undefined) return;
    if (resolved === "/") {
      notes.push(`${label} is / and is not readable in this turn`);
      return;
    }
    const held = writable.find((place) => place !== resolved && isInside(place, resolved));
    if (held !== undefined) {
      notes.push(`${label} ${resolved} is not readable in this turn: it holds ${held}, which this turn writes`);
      return;
    }
    paths.add(resolved);
  };

  for (const directory of SYSTEM_READ_DIRS) system(directory);

  // The engine itself: the supervisor is this same executable, started after the ruleset is in force. From a
  // checkout (`bun run bin/mind.ts`) it also reads the source tree, which is the nearest directory above the
  // entry that holds a package.json.
  derived("the engine's executable", input.execPath);
  if (input.main.endsWith(".ts") && isAbsolute(input.main) && existsSync(input.main)) {
    let root = dirname(input.main);
    for (let at = root; at !== dirname(at); at = dirname(at)) {
      if (existsSync(join(at, "package.json"))) {
        root = at;
        break;
      }
    }
    derived("the engine's source tree", root);
  }

  derived("the working directory", input.cwd);
  for (const path of input.readable ?? []) derived("a path this turn was granted", path);

  const command0 = input.command[0];
  let program: string | undefined;
  const via: string[] = [];
  if (command0 !== undefined) {
    // Looked up as `execvp` will, on this process's own PATH.
    const found = isAbsolute(command0) ? command0 : Bun.which(command0, { cwd: input.cwd });
    if (found !== null && found !== undefined) {
      program = found;
      const files = programFiles(found, input.cwd);
      via.push(...files.via);
      for (const file of files.files) derived("the vendor program", file);
      for (const tree of files.trees) derived("the vendor's package tree", tree);
    }
  }

  // No grant inside another, and none inside what the turn may already write.
  const kept = [...paths].filter(
    (path) =>
      !writable.some((place) => isInside(path, place)) &&
      ![...paths].some((other) => other !== path && isInside(path, other)),
  );
  return { paths: kept.sort(), notes, ...(program === undefined ? {} : { program }), via };
}

/**
 * `PATH` as the confined turn can use it: the entries it may read, and the ones the vendor and its
 * interpreters were found in.
 *
 * Why it is not left alone: the shell finds a program by looking at the entry, not by opening it, so with
 * `~/.pyenv/shims` ahead of `/usr/bin` a `python3` that exists in both resolves to the one the fence refuses
 * to read, and the command fails with "Permission denied" instead of running the system's. Measured in the
 * fence on this machine: `python3`, `node`, `pip3` and `rg` all failed that way. Relative entries go too: they
 * mean "wherever the working directory is".
 */
export function readablePath(
  value: string,
  grants: readonly string[],
  via: readonly string[],
): { readonly path: string; readonly left: number } {
  const real = (path: string): string | undefined => {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  };
  const keep = new Set(via.map((path) => real(dirname(path))).filter((path): path is string => path !== undefined));
  const readable = grants.map((path) => real(path) ?? path);
  const kept: string[] = [];
  let left = 0;
  for (const entry of value.split(":")) {
    if (entry === "") continue;
    const resolved = isAbsolute(entry) ? real(entry) : undefined;
    if (resolved === undefined) {
      // Not there, or not absolute: nothing to run from it, and not worth a line.
      if (isAbsolute(entry)) continue;
      left += 1;
      continue;
    }
    if (keep.has(resolved) || readable.some((place) => isInside(resolved, place))) kept.push(entry);
    else left += 1;
  }
  return { path: kept.join(":"), left };
}

/**
 * Install the irreversible domain and replace this helper with the vendor.
 * Returns only on refusal; success never comes back from `execvp`.
 */
export function runFenceHelper(
  argv: readonly string[],
  runtime: FenceHelperRuntime = REAL_HELPER_RUNTIME,
): number {
  const parsed = parseFenceHelperArgv(argv);
  if (!parsed.ok) {
    console.error(`mind fence: ${parsed.reason}`);
    return 126;
  }
  const available = runtime.support();
  if (!available.ok) {
    console.error(`mind fence: ${available.reason}`);
    return 126;
  }

  let lib: Libc;
  try {
    lib = runtime.openLibc();
  } catch (cause) {
    console.error(`mind fence: refused to run: the Linux C library could not be opened (${String(cause)})`);
    return 126;
  }
  // Before anything else is built. `execvp` below sets the flag back to 1 for the vendor, so this closes only the
  // window in which the helper itself holds the child's environment; what lasts is the supervisor's own call.
  void setNotDumpable(lib);
  // Decided while this process can still read everything: the program, its interpreter and the working directory
  // are looked up here, and whatever is not found now is not readable later.
  const reads = parsed.confineReads === true
    ? readGrants({
        writable: parsed.policy.writable,
        command: parsed.command,
        cwd: (runtime.cwd ?? ownWorkingDirectory)(),
        execPath: process.execPath,
        main: Bun.main,
        ...(parsed.policy.readable === undefined ? {} : { readable: parsed.policy.readable }),
      })
    : undefined;
  for (const note of reads?.notes ?? []) console.error(`mind fence: ${note}`);
  // The PATH the vendor will have: only entries it may read, so that a program found in a system directory is not
  // shadowed by one of the same name in a directory the fence refuses (see {@link readablePath}).
  let runPath: string | undefined;
  if (reads !== undefined) {
    const current = environmentValue(lib, "PATH");
    if (current !== undefined) {
      const narrowed = readablePath(current, [...reads.paths, ...parsed.policy.writable, "/dev"], reads.via);
      runPath = narrowed.path;
      if (narrowed.left > 0) {
        console.error(`mind fence: ${narrowed.left} PATH entr${narrowed.left === 1 ? "y" : "ies"} this turn may not read left out`);
      }
    }
  }
  let ruleset = -1;
  try {
    const attributes = rulesetAttributes(available.abi, reads !== undefined);
    ruleset = Number(
      syscall(lib, SYS_LANDLOCK_CREATE_RULESET, addressOf(attributes), attributes.byteLength, 0),
    );
    if (ruleset < 0) throw new Error(`landlock_create_ruleset: ${lastError(lib)}`);

    // `/dev` is the prototype's one implicit writable tree: CLIs and their
    // runtimes need ordinary device files, while Unix permissions still deny
    // devices this uid could not use before entering the fence.
    for (const directory of [...new Set([...parsed.policy.writable, "/dev"])]) {
      const fd = lib.symbols.open(directory, O_PATH | O_CLOEXEC);
      if (fd < 0) throw new Error(`open writable path ${JSON.stringify(directory)}: ${lastError(lib)}`);
      try {
        // What may be written may be read, or the grant would be a place to put files nobody can open.
        const access = reads === undefined ? FS_MASK : FS_MASK | FS_READ_MASK;
        addRule(lib, ruleset, LANDLOCK_RULE_PATH_BENEATH, pathRule(fd, access), `add writable path ${JSON.stringify(directory)}`);
      } finally {
        lib.symbols.close(fd);
      }
    }
    for (const path of reads?.paths ?? []) {
      let directory: boolean;
      try {
        directory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      const fd = lib.symbols.open(path, O_PATH | O_CLOEXEC);
      // A path that was there a moment ago and cannot be opened is one the turn does not read: closed, not
      // widened.
      if (fd < 0) continue;
      try {
        addRule(
          lib,
          ruleset,
          LANDLOCK_RULE_PATH_BENEATH,
          pathRule(fd, directory ? FS_READ_MASK : FS_READ_FILE),
          `add readable path ${JSON.stringify(path)}`,
        );
      } finally {
        lib.symbols.close(fd);
      }
    }
    for (const port of landlockPorts(parsed.policy)) {
      addRule(lib, ruleset, LANDLOCK_RULE_NET_PORT, portRule(port), `add TCP port ${port}`);
    }

    if (lib.symbols.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) !== 0) {
      throw new Error(`prctl(PR_SET_NO_NEW_PRIVS): ${lastError(lib)}`);
    }
    if (syscall(lib, SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0) !== 0n) {
      throw new Error(`landlock_restrict_self: ${lastError(lib)}`);
    }
    lib.symbols.close(ruleset);
    ruleset = -1;

    // Landlock has now removed every port except the policy's, and seccomp
    // closes what Landlock cannot express: address, UDP, IPv6 and AF_UNIX.
    // The injected runtime seam keeps the irreversible sequence unit-testable.
    runtime.secureNetwork(lib, parsed.policy.tcpPorts, {
      ports: parsed.policy.remotePorts ?? [],
      resolvers: parsed.policy.resolvers ?? [],
    });

    // Do not hand the vendor an already-open socket it could write through.
    // After this point every socket is one the filter saw being created, so a
    // NULL-destination sendto can only use an AF_INET stream or local stream.
    const architecture = SECCOMP_ARCHITECTURES[process.arch]!;
    if (syscall(lib, architecture.closeRange, 3, 0xffff_ffff, 0) !== 0n) {
      throw new Error(`close_range(inherited descriptors): ${lastError(lib)}`);
    }

    const native = nativeArgv(parsed.command);
    if (runPath !== undefined && lib.symbols.setenv("PATH", runPath, 1) !== 0) {
      throw new Error(`setenv(PATH): ${lastError(lib)}`);
    }
    // Keep `native.strings` alive until execvp: the pointer table points into
    // those buffers, and successful exec never returns to let them be freed.
    void native.strings;
    // The program as PATH found it, when reads are confined: the PATH entry it came from may be one that was just
    // left out, and a name searched on the narrowed PATH would not find it. `argv[0]` stays what the caller named.
    lib.symbols.execvp(reads?.program ?? parsed.command[0]!, native.pointers);
    throw new Error(`execvp ${JSON.stringify(parsed.command[0])}: ${lastError(lib)}`);
  } catch (cause) {
    console.error(`mind fence: refused to run: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 126;
  } finally {
    if (ruleset >= 0) lib.symbols.close(ruleset);
    lib.close();
  }
}
