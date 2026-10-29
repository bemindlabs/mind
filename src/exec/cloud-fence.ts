/**
 * The kernel fence around a vendor CLI whose model is in the cloud (D-192).
 *
 * D-118 and D-123 built the Landlock + seccomp fence for turns on a model on this machine. A cloud turn ran
 * outside it, as the owner's user: at level 2 its shell could read `~/.secrets` and `~/.ssh` and send what it
 * read to the vendor. The owner's rulings of 2026-10-19 (F1–F4) close that, and this file is where they live:
 *
 * - **F1, which turns.** Every cloud turn that has a tool, at every level. The one turn left out is a turn that
 *   is started with no tools at all (claude at level 1 with no browser: `noToolsWhenRestrained`), because a turn
 *   that cannot open a file has nothing for a fence to hold.
 * - **F2, the vendor's home.** Each vendor runs in a home of Mind's own, one per subject (I-3), under the state
 *   root: its config-dir variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and `HOME` point there. The only thing taken
 *   from the owner's real vendor home is the credential file, as a **managed copy**: copied in before the turn,
 *   and written back after it only when the vendor refreshed it and the owner's file is still the one that was
 *   copied. Measured: claude replaces `.credentials.json` through a temporary file and a rename in its directory
 *   (2.1.303), which a grant on one file cannot allow, and a grant on the directory would hand the turn every
 *   other session's transcripts. See {@link syncCredentialBack} for what the copy costs.
 * - **F3, the network.** Landlock allows TCP connect to port 443 only; the seccomp supervisor allows it at any
 *   address that is not loopback, and allows the name servers of `/etc/resolv.conf` on TCP port 53, nothing
 *   else. UDP stays refused, so the vendor is told to ask its resolver over TCP (`RES_OPTIONS=use-vc`).
 * - **F4, no Landlock.** Where the kernel has no Landlock, or an ABI below 4, the turn still runs — unlike a
 *   local turn, which is refused — and every such turn carries a notice that no fence is in force.
 *
 * A vendor whose home and credential have not been measured has no {@link CloudHomeSpec}: its turns run unfenced
 * with the same notice, and `mind backends` names it. Never silently.
 *
 * Nothing here reads `process.env` or `homedir()`: `cli-exec.ts` is the seam and passes both in.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateRoot, STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";
import type { TurnRequest } from "./backend.ts";
import { ipv4Bytes, type FencePolicy, type FenceSupport } from "./fence.ts";
import { expandPath, noToolsWhenRestrained, type VendorSpec } from "./registry.ts";

/** F3: the one TCP port a cloud turn may reach outside this machine. */
export const CLOUD_PORT = 443;

/** Where the C library is told which name servers to ask. */
export const RESOLV_CONF = "/etc/resolv.conf";

/**
 * How one cloud vendor is given a home of Mind's own (F2). Declared per vendor in the registry, and only for a
 * vendor whose home and credential were measured on a real turn: absence is the statement that it was not.
 */
export interface CloudHomeSpec {
  /** The variable that moves the vendor's whole config directory. */
  readonly configEnv: string;
  /** That directory's name inside Mind's home for the vendor. */
  readonly configDir: string;
  /** The owner's credential file, as a registry path (`~/…` or `${VAR:-…}/…`). */
  readonly credential: string;
  /** What the vendor calls that file inside its config directory. */
  readonly credentialName: string;
  /**
   * The instruction file the vendor reads from its config directory. Mind writes the turn's identity there when
   * the vendor has no flag that carries it, or the owner's own file when the turn carries none.
   */
  readonly identityFile?: string;
  /** Variables taken from the owner's environment, because they are how this vendor may be logged in. */
  readonly passEnv: readonly string[];
  /** Variables set to the turn's own temporary directory. */
  readonly tmpEnv: readonly string[];
  /** Switches set on every fenced turn. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The program to start in place of the one PATH finds, when that one is a launcher that starts the real CLI as a
   * child. The fence's supervisor may read the memory of the process it starts and of nothing below it (Yama,
   * `ptrace_scope` 1), so a vendor whose network calls come from a child would have every connect refused.
   * Given the launcher's real path, returns the program and the variables the launcher would have set, or
   * `undefined` to start what PATH found.
   */
  readonly program?: (
    launcher: string,
    arch: string,
  ) => { readonly path: string; readonly env: Readonly<Record<string, string>> } | undefined;
  /** What was measured about how the vendor reads and rewrites the credential, against which version. */
  readonly evidence: string;
}

/** The places one fenced cloud turn uses. */
export interface CloudHomePaths {
  /** Mind's home for this vendor and subject: `HOME` of the turn, and writable by it. */
  readonly home: string;
  /** The vendor's config directory inside it. */
  readonly config: string;
  /** The turn's temporary directory (`TMPDIR`). `/tmp` itself is not writable in the fence. */
  readonly tmp: string;
  /** The managed copy of the credential, inside {@link config}. */
  readonly credentialCopy: string;
  /** The owner's own credential file. */
  readonly ownerCredential: string;
}

/** Mind's home for one cloud vendor and one subject, under the state root. */
export function cloudHomePaths(
  spec: VendorSpec,
  cloud: CloudHomeSpec,
  subject: string,
  ownerHome: string,
  env: Readonly<Record<string, string | undefined>>,
): CloudHomePaths {
  const home = join(stateRoot(ownerHome, env), "vendors", spec.id, "subjects", subject);
  const config = join(home, cloud.configDir);
  return {
    home,
    config,
    tmp: join(home, "tmp"),
    credentialCopy: join(config, cloud.credentialName),
    ownerCredential: expandPath(cloud.credential, { home: ownerHome, env, cwd: ownerHome }),
  };
}

/**
 * What F1 and F4 make of one cloud turn.
 *
 * - `fenced`: the turn runs inside the fence.
 * - `local`: the request already carries a fence (a local turn, D-118). Not this file's.
 * - `tool-free`: started with no tools at all, so there is nothing to hold.
 * - `no-kernel`: F4 — the kernel cannot fence, the turn runs unfenced, with a notice.
 * - `unmeasured`: the vendor has no measured home, the turn runs unfenced, with a notice.
 */
export type CloudVerdict =
  | { readonly kind: "fenced"; readonly cloud: CloudHomeSpec }
  | { readonly kind: "local" }
  | { readonly kind: "tool-free" }
  | { readonly kind: "no-kernel"; readonly reason: string }
  | { readonly kind: "unmeasured" };

/** True when this turn starts with no tools at all: claude's empty allow list, below level 2, with no browser. */
export function startsWithoutTools(spec: VendorSpec, request: Pick<TurnRequest, "restraint" | "browser">): boolean {
  return !request.restraint.loosened && request.browser === undefined && noToolsWhenRestrained(spec.readOnly);
}

/** F1 and F4, asked of one request. `support` is the kernel's answer, probed once per process. */
export function cloudVerdict(
  spec: VendorSpec,
  request: Pick<TurnRequest, "restraint" | "browser" | "fence">,
  support: FenceSupport,
): CloudVerdict {
  if (request.fence !== undefined) return { kind: "local" };
  if (startsWithoutTools(spec, request)) return { kind: "tool-free" };
  if (spec.cloudHome === undefined) return { kind: "unmeasured" };
  if (!support.ok) return { kind: "no-kernel", reason: support.reason };
  return { kind: "fenced", cloud: spec.cloudHome };
}

/**
 * The notice an unfenced cloud turn with tools carries (F4), or `undefined` for a turn that is fenced, local or
 * has no tools. Printed before the turn and kept on its result, every turn.
 */
export function cloudFenceNotice(spec: VendorSpec, verdict: CloudVerdict): string | undefined {
  const tail =
    "it runs as you and its tools can open any file you can open (~/.secrets, ~/.ssh, other subjects' data) " +
    "and send it to the vendor (D-192).";
  if (verdict.kind === "no-kernel") {
    return `no kernel fence is in force for this ${spec.id} turn: ${verdict.reason}. The turn runs anyway (F4), and ${tail}`;
  }
  if (verdict.kind === "unmeasured") {
    return (
      `no kernel fence is in force for this ${spec.id} turn: Mind has not measured a home and credential for ` +
      `${spec.id}, so it is not fenced, and ${tail}`
    );
  }
  return undefined;
}

/** The IPv4 name servers a resolv.conf lists, in order and without repeats. Anything else is left out. */
export function resolversFrom(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*nameserver\s+(\S+)/.exec(line);
    if (match === null) continue;
    const address = match[1]!;
    if (ipv4Bytes(address) !== undefined && !found.includes(address)) found.push(address);
  }
  return found;
}

/** The name servers of this machine, or none when the file cannot be read (names then do not resolve). */
export async function readResolvers(path: string = RESOLV_CONF): Promise<string[]> {
  try {
    return resolversFrom(await readFile(path, "utf8"));
  } catch {
    return [];
  }
}

/** F1–F3 as a policy: the home always writable, the working directory too at level 2 and above. */
export function cloudFencePolicy(input: {
  readonly paths: CloudHomePaths;
  readonly cwd: string;
  readonly loosened: boolean;
  readonly resolvers: readonly string[];
  /**
   * The resolv.conf the name servers came from. Granted for reading, because the C library reads it inside the
   * fence and it is usually a link into `/run`, which no other grant covers (measured: EACCES, then EAI_AGAIN).
   */
  readonly resolvConf?: string;
  /** A task's browser: its loopback port, and the directory its MCP config is written to. */
  readonly browser?: { readonly port: number; readonly dir: string };
  /**
   * S22.8: `scope = machine`. The grants replace the working directory as what a loosened turn may write: a working
   * directory of `/` or `~` would otherwise be granted whole, red lines and all, because a grant cannot be carved.
   */
  readonly machine?: { readonly grants: readonly string[] };
}): FencePolicy {
  const readable = [
    ...(input.resolvConf !== undefined && input.resolvers.length > 0 ? [input.resolvConf] : []),
    ...(input.browser === undefined ? [] : [input.browser.dir]),
  ];
  return {
    writable: [
      input.paths.home,
      ...(input.loosened ? (input.machine === undefined ? [input.cwd] : input.machine.grants) : []),
    ],
    tcpPorts: input.browser === undefined ? [] : [input.browser.port],
    remotePorts: [CLOUD_PORT],
    ...(input.resolvers.length > 0 ? { resolvers: [...input.resolvers] } : {}),
    ...(readable.length > 0 ? { readable } : {}),
  };
}

/**
 * The child's whole environment on a fenced turn: no inheritance (the owner's other keys stay out), the few
 * variables a CLI needs, the vendor's own login variables, and the home Mind made for it.
 */
export function cloudEnvironment(
  cloud: CloudHomeSpec,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const passed: Record<string, string> = {};
  for (const name of cloud.passEnv) {
    const value = env[name];
    if (value !== undefined && value !== "") passed[name] = value;
  }
  return {
    PATH: env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    SHELL: env["SHELL"] ?? "/bin/bash",
    USER: env["USER"] ?? "mind",
    LOGNAME: env["LOGNAME"] ?? env["USER"] ?? "mind",
    TERM: env["TERM"] ?? "dumb",
    LANG: env["LANG"] ?? "C.UTF-8",
    ...passed,
    ...cloud.env,
  };
}

/** What no caller may change on a fenced turn: where the vendor's home is, and how names are resolved. */
export function cloudForcedEnvironment(cloud: CloudHomeSpec, paths: CloudHomePaths): Record<string, string> {
  return {
    HOME: paths.home,
    [cloud.configEnv]: paths.config,
    TMPDIR: paths.tmp,
    ...Object.fromEntries(cloud.tmpEnv.map((name) => [name, paths.tmp])),
    // F3: the seccomp filter allows no datagram socket, so the C library asks its resolver over TCP.
    RES_OPTIONS: "use-vc",
  };
}

/** sha256 of a file's bytes, or `undefined` when there is no such file. The content is never returned. */
async function digestOf(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Write `bytes` to `path` through a private temporary file beside it and a rename. */
async function replaceFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${path}.mind-${process.pid}-${crypto.randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(temporary, "wx", STATE_FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, STATE_FILE_MODE);
    await rename(temporary, path);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

/** What was copied before a turn, by digest: enough to tell afterwards who changed what. */
export interface CredentialSnapshot {
  readonly owner?: string;
  readonly copy?: string;
}

/**
 * Make Mind's home for this turn: the directories, private, and a fresh copy of the owner's credential. The
 * owner's file wins over whatever an earlier turn left in the copy. A missing credential is not an error here:
 * the vendor then says it is not logged in, which is the true answer.
 */
export async function prepareCloudHome(paths: CloudHomePaths): Promise<CredentialSnapshot> {
  for (const directory of [paths.home, paths.config, paths.tmp]) {
    await mkdir(directory, { recursive: true, mode: STATE_DIR_MODE });
    await chmod(directory, STATE_DIR_MODE);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(paths.ownerCredential);
  } catch {
    await rm(paths.credentialCopy, { force: true });
    return {};
  }
  await mkdir(dirname(paths.credentialCopy), { recursive: true, mode: STATE_DIR_MODE });
  await replaceFile(paths.credentialCopy, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { owner: digest, copy: digest };
}

/**
 * The identity file in the vendor's config directory: the turn's own system text when the vendor has no flag to
 * carry it, else the owner's instruction file as `soul apply` left it (what an unfenced turn would have read), or
 * nothing. Removed when there is nothing to say, so a file an earlier turn left is never read by this one.
 */
export async function writeCloudIdentity(
  spec: VendorSpec,
  cloud: CloudHomeSpec,
  paths: CloudHomePaths,
  request: Pick<TurnRequest, "system">,
  ownerHome: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  if (cloud.identityFile === undefined) return;
  const target = join(paths.config, cloud.identityFile);
  let content = "";
  if (request.system !== undefined && spec.identity.appendPromptFlag === undefined) {
    content = request.system;
  } else if (request.system === undefined) {
    const declared = spec.identity.instructionFiles.find((file) => !file.startsWith("./"));
    if (declared !== undefined) {
      content = await readFile(expandPath(declared, { home: ownerHome, env, cwd: ownerHome }), "utf8").catch(() => "");
    }
  }
  if (content === "") {
    await rm(target, { force: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true, mode: STATE_DIR_MODE });
  await replaceFile(target, content);
}

/** What {@link syncCredentialBack} did. */
export type CredentialSync =
  /** Nothing was copied, or the vendor did not change its copy. */
  | "unchanged"
  /** The vendor refreshed its login; the owner's file now holds the refreshed one. */
  | "synced"
  /** Both changed during the turn: the owner's file is newer and is left alone. */
  | "owner-changed"
  /** The vendor's copy is not one JSON document (cut short?), so it is not written over the owner's. */
  | "copy-unreadable";

/**
 * After the turn: if the vendor refreshed its login, put the refreshed credential back where the owner's CLI reads
 * it — but only when the owner's file is still the one that was copied, so a login the owner made meanwhile is
 * never overwritten.
 *
 * Why it must go back: an OAuth refresh can rotate the refresh token, and the owner's file would then hold one the
 * vendor no longer honours — the owner's own CLI would be logged out by a turn Mind ran.
 *
 * What the copy costs, said plainly: the credential is in a home the turn can read, so the vendor's own tools can
 * read the vendor's own login. Landlock cannot tell the vendor from the shell it runs. That is F2's one read grant,
 * in the only form that keeps a refresh working.
 */
export async function syncCredentialBack(paths: CloudHomePaths, snapshot: CredentialSnapshot): Promise<CredentialSync> {
  if (snapshot.copy === undefined) return "unchanged";
  let bytes: Buffer;
  try {
    bytes = await readFile(paths.credentialCopy);
  } catch {
    return "unchanged";
  }
  if (createHash("sha256").update(bytes).digest("hex") === snapshot.copy) return "unchanged";
  try {
    JSON.parse(bytes.toString("utf8"));
  } catch {
    return "copy-unreadable";
  }
  if ((await digestOf(paths.ownerCredential)) !== snapshot.owner) return "owner-changed";
  await replaceFile(paths.ownerCredential, bytes);
  return "synced";
}

/** One line about the vendor's login after a fenced turn, or `undefined` when there is nothing to say. */
export function credentialSyncNote(spec: VendorSpec, outcome: CredentialSync, paths: CloudHomePaths): string | undefined {
  if (outcome === "owner-changed") {
    return (
      `${spec.id} refreshed its login during this turn while ${paths.ownerCredential} changed too; ` +
      "yours was kept, and the turn's refresh was dropped (D-192)."
    );
  }
  if (outcome === "copy-unreadable") {
    return `${spec.id} left a credential Mind could not read; ${paths.ownerCredential} was not touched (D-192).`;
  }
  return undefined;
}

/**
 * The truth about one vendor's cloud turns, derived from the registry and the kernel: for `mind backends` and
 * `mind autonomy show`. `support` is the kernel's answer on this machine.
 */
export function cloudFenceSummary(spec: VendorSpec, support: FenceSupport): string {
  const toolFree = noToolsWhenRestrained(spec.readOnly) ? " (level 1 has no tools and is not fenced)" : "";
  if (spec.cloudHome === undefined) return `not fenced: no measured home and credential${toolFree}`;
  if (!support.ok) return `not fenced on this kernel (${support.reason}); runs with a notice${toolFree}`;
  return `fenced at every level with a tool${toolFree}`;
}

/**
 * What the fence does and does not do for cloud turns, derived from the registry — the sentences `mind backends`
 * and `mind autonomy show` print in place of "can open any file you can open".
 */
export function cloudFenceLimits(vendors: readonly VendorSpec[], support: FenceSupport): string[] {
  const named = (list: readonly VendorSpec[]) => list.map((spec) => spec.id).join(", ");
  const measured = vendors.filter((spec) => spec.cloudHome !== undefined);
  const unmeasured = vendors.filter((spec) => spec.cloudHome === undefined);
  const lines: string[] = [];
  if (measured.length > 0) {
    lines.push(
      `${named(measured)} run inside the kernel fence on every turn that has a tool (D-192): they read only the ` +
        "system directories, the working directory, their own program and a home Mind keeps for each vendor and " +
        "subject, which holds a copy of the vendor's login and nothing else of yours; they write only that home, " +
        "and the working directory at level 2 and above; they connect only to TCP port 443 of an address that is " +
        `not this machine's loopback, and to the name servers on port 53. ${support.ok ? "" : `Not on this kernel: ${support.reason}, so each of their turns runs unfenced with a notice. `}` +
        "What the turn reads in its working directory it can still send to the vendor.",
    );
  }
  if (unmeasured.length > 0) {
    lines.push(
      `${named(unmeasured)} are not fenced: Mind has not measured a home and credential for them. Their turns ` +
        "run as you and can open any file you can open (~/.secrets, ~/.ssh, other subjects' data) and send it to " +
        "that vendor; each such turn says so.",
    );
  }
  return lines;
}
