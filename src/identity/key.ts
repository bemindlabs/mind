/**
 * The agent's own ed25519 keypair on disk (S15.8, D-108, D-138): made once, read many times, never shown.
 *
 * One file, `$XDG_DATA_HOME/mind/<subject>/identity/ed25519.pem` — the private key as PKCS#8 PEM, from which
 * the public half is derived whenever it is needed, so the two can never disagree. Mode 600 in a directory of
 * mode 700, outside every git repository, and refused otherwise:
 *
 * - **Made once.** {@link ensureAgentKey} writes only where nothing is, and a second call reads what the first
 *   wrote. Nothing here overwrites a key, because a replaced key is a different agent to everyone who knew the
 *   old one — replacing it is a decision for a person with `rm`, not a side effect.
 * - **Written whole or not at all.** The key is written to a new file beside the final name (`wx`, 600, named
 *   for this process), flushed, and then *linked* to the final name. `link` fails if the name exists, so two
 *   processes racing to make a key end with one key, and a crash leaves either no key or a whole one — never
 *   half a PEM under the real name. What a crash can leave is the temporary file; the next `ensureAgentKey`
 *   removes any whose process is gone.
 * - **Read through one open file.** The key is opened with `O_NOFOLLOW` (a symlink is refused by the kernel,
 *   not by an earlier `lstat` that could be raced) and `O_NONBLOCK` (a FIFO put there cannot hang the read),
 *   and every check — a regular file, this user's, no bits for group or others, at most 4 KiB — is made on
 *   *that handle* with `fstat`, and the bytes are read from it (S15.8 security review, L8).
 * - **Refused when anyone else could read it**, or could have swapped it: a key that group or others can read
 *   may already be somebody else's, so signing with it would put the agent's name on whatever they sign. The
 *   same rule `mind web --key-file` keeps (D-069), with the `chmod` that fixes it in the reason. Above the
 *   file, OpenSSH's StrictModes: `identity/` must be this user's and 700, and `<subject>/` and the data root
 *   `mind/` above it this user's (or root's) and not writable by group or others — a directory someone else
 *   can write to is one they can put their own key in.
 * - **Never shown.** Nothing returns the private key: an {@link AgentKey} carries the public half and a `sign`
 *   function that closes over the private one, so no property, `JSON.stringify` or log line can reach it.
 *
 * What this cannot stop: a program running as the owner's uid can read the file, as it can read every other
 * secret Mind keeps (the page key, the A2A tokens). A separate uid is outside Mind.
 */

import { constants } from "node:fs";
import { generateKeyPairSync, createPrivateKey, type KeyObject } from "node:crypto";
import { link, lstat, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { enclosingGitRepo } from "../agent/repo.ts";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";
import { KEY_FILE, keyPath } from "./dir.ts";
import { fingerprintOf, publicKeyText, signEnvelope, SIGNATURE_ALGORITHM, type Payload, type SignedEnvelope } from "./sign.ts";

/** A PKCS#8 PEM of an ed25519 key is 119 bytes; anything past this is not one, and is not read into memory. */
export const MAX_KEY_BYTES = 4096;

const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** `ed25519.pem.new-<pid>-<random>`: a key being written, or one a crash left behind. */
const TEMP = new RegExp(`^${KEY_FILE.replace(".", "\\.")}\\.new-(\\d+)-[0-9a-f]{8}$`);

/** The agent's key, as far as anything outside this file may see it. */
export interface AgentKey {
  readonly path: string;
  readonly algorithm: typeof SIGNATURE_ALGORITHM;
  /** 32 raw bytes, base64url — what the agent card and every envelope carry. */
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly sign: (payload: Payload) => SignedEnvelope;
}

export type KeyRead =
  | { readonly state: "present"; readonly key: AgentKey }
  | { readonly state: "absent"; readonly path: string }
  | { readonly state: "refused"; readonly path: string; readonly reason: string };

export type KeyEnsured =
  | { readonly state: "present"; readonly key: AgentKey; readonly created: boolean }
  | { readonly state: "refused"; readonly path: string; readonly reason: string };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toAgentKey(path: string, privateKey: KeyObject): AgentKey {
  const publicKey = publicKeyText(privateKey);
  return {
    path,
    algorithm: SIGNATURE_ALGORITHM,
    publicKey,
    fingerprint: fingerprintOf(publicKey),
    sign: (payload) => signEnvelope(payload, privateKey),
  };
}

/** The refusal for a key directory inside a checkout — said before anything is created there. */
function inGit(dir: string, repo: string): string {
  return (
    `${dir} is inside the git repository at ${repo}. An agent's private key must not be in version control ` +
    `at all (D-108) — point XDG_DATA_HOME somewhere outside a checkout.`
  );
}

const mine = (uid: number) => uid === process.getuid?.();

/**
 * Why this directory may not hold the key, or undefined — the StrictModes walk. `identity/` itself: a real
 * directory (not a symlink), this user's, 700. `<subject>/` and the data root above it: this user's or root's,
 * and not writable by group or others. And none of it inside a git repository, followed through symlinks.
 */
async function dirProblem(dir: string): Promise<string | undefined> {
  const repo = await enclosingGitRepo(dir);
  if (repo !== undefined) return inGit(dir, repo);
  const info = await lstat(dir);
  if (!info.isDirectory()) return `${dir} is not a directory`;
  if (!mine(info.uid)) return `${dir} belongs to another user`;
  if ((info.mode & 0o077) !== 0) {
    return `${dir} can be entered by others (mode ${(info.mode & 0o777).toString(8)}) — chmod 700 ${dir} first`;
  }
  for (const above of [dirname(dir), dirname(dirname(dir))]) {
    const up = await stat(above);
    if (!mine(up.uid) && up.uid !== 0) return `${above} belongs to another user, who could put a key of theirs under it`;
    if ((up.mode & 0o022) !== 0) {
      return `${above} can be written by others (mode ${(up.mode & 0o777).toString(8)}), who could put a key of theirs under it — chmod go-w ${above} first`;
    }
  }
  return undefined;
}

/**
 * The key in `dir`, if there is one and it may be used. Creates nothing.
 *
 * Refused — never silently skipped — when the file is a symlink or not a regular file, is not this user's, has
 * any bit for group or others, is larger than {@link MAX_KEY_BYTES}, sits under a directory that fails the
 * StrictModes walk, or is not an ed25519 private key.
 */
export async function readAgentKey(dir: string): Promise<KeyRead> {
  const path = keyPath(dir);
  let handle;
  try {
    handle = await open(path, READ_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "absent", path };
    if (code === "ELOOP") return { state: "refused", path, reason: `${path} is a symbolic link — Mind reads its key only from a regular file` };
    return { state: "refused", path, reason: describe(error) };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { state: "refused", path, reason: `${path} is not a regular file — Mind reads its key only from one` };
    if (!mine(info.uid)) return { state: "refused", path, reason: `${path} belongs to another user` };
    if ((info.mode & 0o077) !== 0) {
      return {
        state: "refused",
        path,
        reason:
          `${path} can be read by others (mode ${(info.mode & 0o777).toString(8)}) — a private key anyone else could ` +
          `read may already be theirs too. chmod 600 ${path}, and if others really could read it, make a new key.`,
      };
    }
    if (info.size > MAX_KEY_BYTES) return { state: "refused", path, reason: `${path} is ${info.size} bytes, which is not an ed25519 key` };
    const problem = await dirProblem(dir);
    if (problem !== undefined) return { state: "refused", path, reason: problem };

    const buffer = Buffer.alloc(MAX_KEY_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_KEY_BYTES) return { state: "refused", path, reason: `${path} grew past ${MAX_KEY_BYTES} bytes while it was read` };
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      // The parser's message is not repeated: it can quote what it failed to read.
      return { state: "refused", path, reason: `${path} does not hold a private key Mind can read` };
    } finally {
      buffer.fill(0);
    }
    if (privateKey.asymmetricKeyType !== SIGNATURE_ALGORITHM) {
      return { state: "refused", path, reason: `${path} holds a ${privateKey.asymmetricKeyType ?? "non-asymmetric"} key, not an ed25519 one` };
    }
    return { state: "present", key: toAgentKey(path, privateKey) };
  } finally {
    await handle.close();
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and is somebody else's. Only "no such process" means the writer is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Temporary key files a crashed writer left behind. A live writer's is its own business. */
async function removeStale(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const match = TEMP.exec(name);
    if (match !== null && !alive(Number(match[1]))) await unlink(join(dir, name)).catch(() => undefined);
  }
}

/**
 * The key in `dir`, made first if there is none. Never replaces one.
 *
 * The directory is created 700 when missing; one that exists with a wider mode is refused rather than
 * changed, because something else put it there and Mind does not know what else relies on it.
 */
export async function ensureAgentKey(dir: string): Promise<KeyEnsured> {
  const existing = await readAgentKey(dir);
  if (existing.state === "present") return { state: "present", key: existing.key, created: false };
  if (existing.state === "refused") return existing;
  const path = existing.path;
  let linked = false;

  try {
    // The git question first: a directory must not be created inside a checkout just to be refused there.
    const repo = await enclosingGitRepo(dir);
    if (repo !== undefined) return { state: "refused", path, reason: inGit(dir, repo) };
    await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
    const problem = await dirProblem(dir);
    if (problem !== undefined) return { state: "refused", path, reason: problem };
    await removeStale(dir);

    const { privateKey } = generateKeyPairSync(SIGNATURE_ALGORITHM);
    const pem = privateKey.export({ format: "pem", type: "pkcs8" });
    const temp = `${path}.new-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    const handle = await open(temp, "wx", STATE_FILE_MODE);
    try {
      // 600 whatever the umask did, before a byte of the key is in it.
      await handle.chmod(STATE_FILE_MODE);
      await handle.writeFile(pem);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, path);
      linked = true;
    } catch (error) {
      // Another process made one in between: keep theirs, which is the only one anybody has seen.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    const directory = await open(dir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    return { state: "refused", path, reason: describe(error) };
  }

  const made = await readAgentKey(dir);
  if (made.state === "present") return { state: "present", key: made.key, created: linked };
  return made.state === "refused" ? made : { state: "refused", path, reason: `${path} was written and then could not be found` };
}
