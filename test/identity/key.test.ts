/**
 * S15.8 — the agent's key on disk: made once, 600 in a 700 directory, outside git, never shown (D-108, D-138).
 *
 * Every test works in a temporary directory of its own; nothing here can reach this machine's data root.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_DIR, identityDirFor, KEY_FILE, keyPath } from "../../src/identity/dir.ts";
import { ensureAgentKey, MAX_KEY_BYTES, readAgentKey } from "../../src/identity/key.ts";
import { verifyEnvelope } from "../../src/identity/sign.ts";
import { subjectId } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-key-"));
  scratch.push(dir);
  return dir;
}

/** The identity directory a subject gets under a sandbox's data root. */
async function identityIn(): Promise<string> {
  const home = await sandbox();
  return identityDirFor({ home, env: { XDG_DATA_HOME: join(home, "data") } }, subjectId("example"));
}

/** The base64 body of a PEM, line by line — what must never appear anywhere but the key file. */
async function pemBody(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split("\n").filter((line) => line !== "" && !line.startsWith("-----"));
}

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

describe("where the key lives", () => {
  test("under the data root, beside personal/, named for what it holds", async () => {
    const dir = identityDirFor({ home: "/h", env: {} }, subjectId("example"));
    expect(dir).toBe(join("/h", ".local", "share", "mind", "example", IDENTITY_DIR));
    expect(identityDirFor({ home: "/h", env: { XDG_DATA_HOME: "/d" } }, subjectId("example"))).toBe(join("/d", "mind", "example", "identity"));
    expect(keyPath(dir)).toBe(join(dir, KEY_FILE));
  });
});

describe("made once", () => {
  test("the first call makes it 600 in a 700 directory; later calls return the same key and change nothing", async () => {
    const dir = await identityIn();
    const first = await ensureAgentKey(dir);
    expect(first.state).toBe("present");
    if (first.state !== "present") return;
    expect(first.created).toBe(true);
    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(keyPath(dir))).toBe(0o600);
    expect(first.key.path).toBe(keyPath(dir));
    expect(first.key.algorithm).toBe("ed25519");
    expect(first.key.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.key.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // Only the key: the temporary file it was written through is gone.
    expect(await readdir(dir)).toEqual([KEY_FILE]);

    const bytes = await readFile(keyPath(dir));
    const second = await ensureAgentKey(dir);
    expect(second.state === "present" && second.created).toBe(false);
    expect(second.state === "present" && second.key.publicKey).toBe(first.key.publicKey);
    expect(await readFile(keyPath(dir))).toEqual(bytes);
    const read = await readAgentKey(dir);
    expect(read.state === "present" && read.key.publicKey).toBe(first.key.publicKey);
  });

  test("two racing to make it end with one key, and only one of them says it made it", async () => {
    const dir = await identityIn();
    const results = await Promise.all([ensureAgentKey(dir), ensureAgentKey(dir), ensureAgentKey(dir)]);
    const keys = results.map((r) => (r.state === "present" ? r.key.publicKey : r.reason));
    expect(new Set(keys).size).toBe(1);
    expect(results.filter((r) => r.state === "present" && r.created).length).toBe(1);
    expect(await readdir(dir)).toEqual([KEY_FILE]);
  });

  test("reading makes nothing: no key means absent, and no directory appears", async () => {
    const dir = await identityIn();
    expect(await readAgentKey(dir)).toEqual({ state: "absent", path: keyPath(dir) });
    expect(await Bun.file(dir).exists()).toBe(false);
    await expect(stat(dir)).rejects.toThrow();
  });

  test("what it signs verifies under its public key", async () => {
    const made = await ensureAgentKey(await identityIn());
    if (made.state !== "present") throw new Error(made.reason);
    const envelope = made.key.sign({ kind: "mind.test", n: 1 });
    expect(envelope.publicKey).toBe(made.key.publicKey);
    expect(verifyEnvelope(envelope, made.key.publicKey).ok).toBe(true);
  });
});

describe("never shown", () => {
  test("no property, JSON, string or inspection of the key reaches the private half", async () => {
    const made = await ensureAgentKey(await identityIn());
    if (made.state !== "present") throw new Error(made.reason);
    const body = await pemBody(made.key.path);
    expect(body.length).toBeGreaterThan(0);
    const views = [JSON.stringify(made.key), String(made.key), Bun.inspect(made.key), JSON.stringify(made.key.sign({ kind: "x" }))];
    for (const view of views) for (const line of body) expect(view).not.toContain(line);
    expect(Object.keys(made.key).sort()).toEqual(["algorithm", "fingerprint", "path", "publicKey", "sign"]);
  });
});

describe("refused, with the fix in the reason", () => {
  test("a key file group or others can read — and a directory others can enter", async () => {
    const dir = await identityIn();
    await ensureAgentKey(dir);
    await chmod(keyPath(dir), 0o640);
    const loose = await readAgentKey(dir);
    expect(loose.state).toBe("refused");
    if (loose.state === "refused") expect(loose.reason).toContain(`chmod 600 ${keyPath(dir)}`);
    // Refused by ensure too — and not replaced.
    const again = await ensureAgentKey(dir);
    expect(again.state).toBe("refused");

    await chmod(keyPath(dir), 0o600);
    await chmod(dir, 0o755);
    const open = await readAgentKey(dir);
    expect(open.state === "refused" && open.reason).toContain(`chmod 700 ${dir}`);
    await chmod(dir, 0o700);
    expect((await readAgentKey(dir)).state).toBe("present");
  });

  test("a directory that already exists wide open is refused before any key is made in it", async () => {
    const dir = await identityIn();
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);
    const made = await ensureAgentKey(dir);
    expect(made.state === "refused" && made.reason).toContain("chmod 700");
    expect(await readdir(dir)).toEqual([]);
  });

  test("L8: the key is opened without following a link, and checked on the open file — a FIFO does not hang it", async () => {
    const dir = await identityIn();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const elsewhere = join(await sandbox(), "real.pem");
    await writeFile(elsewhere, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    await symlink(elsewhere, keyPath(dir));
    const linked = await readAgentKey(dir);
    expect(linked.state === "refused" && linked.reason).toContain("symbolic link");
    await rm(keyPath(dir));

    expect(spawnSync("mkfifo", [keyPath(dir)]).status).toBe(0);
    await chmod(keyPath(dir), 0o600);
    const started = Date.now();
    const fifo = await readAgentKey(dir);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fifo.state === "refused" && fifo.reason).toContain("not a regular file");
    await rm(keyPath(dir));

    await writeFile(keyPath(dir), "x".repeat(MAX_KEY_BYTES + 1), { mode: 0o600 });
    const big = await readAgentKey(dir);
    expect(big.state === "refused" && big.reason).toContain(`${MAX_KEY_BYTES + 1} bytes`);
  });

  test("L8: StrictModes — a subject directory or data root others can write to is refused, with the fix", async () => {
    const dir = await identityIn();
    expect((await ensureAgentKey(dir)).state).toBe("present");
    for (const above of [join(dir, ".."), join(dir, "..", "..")]) {
      await chmod(above, 0o770);
      const loose = await readAgentKey(dir);
      expect(loose.state === "refused" && loose.reason).toContain("chmod go-w");
      await chmod(above, 0o755);
      expect((await readAgentKey(dir)).state).toBe("present");
      await chmod(above, 0o700);
    }
  });

  test("L3: an identity directory symlinked into a checkout is refused — the walk follows where it really is", async () => {
    const home = await sandbox();
    const repo = join(home, "notes");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, "keys"), { recursive: true, mode: 0o700 });
    await mkdir(join(home, "data", "mind"), { recursive: true, mode: 0o700 });
    await symlink(join(repo, "keys"), join(home, "data", "mind", "example"));
    const dir = identityDirFor({ home, env: { XDG_DATA_HOME: join(home, "data") } }, subjectId("example"));
    const made = await ensureAgentKey(dir);
    expect(made.state === "refused" && made.reason).toContain("inside the git repository");
    expect(await readdir(join(repo, "keys"))).toEqual([]);
  });

  test("a temporary file a crashed writer left is removed at the next run; a live writer's is not; neither is ever wider than 600", async () => {
    const dir = await identityIn();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const gone = spawnSync("true").pid;
    const stale = join(dir, `${KEY_FILE}.new-${gone}-0badc0de`);
    const live = join(dir, `${KEY_FILE}.new-${process.pid}-0badc0de`);
    const unrelated = join(dir, "notes.txt");
    for (const path of [stale, live, unrelated]) await writeFile(path, "partial", { mode: 0o600 });
    const made = await ensureAgentKey(dir);
    expect(made.state).toBe("present");
    expect((await readdir(dir)).sort()).toEqual([KEY_FILE, `${KEY_FILE}.new-${process.pid}-0badc0de`, "notes.txt"].sort());
    for (const name of await readdir(dir)) expect((await stat(join(dir, name))).mode & 0o077, name).toBe(0);
  });

  test("a symbolic link, garbage, and another algorithm's key — without quoting what was read", async () => {
    const dir = await identityIn();
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const elsewhere = join(await sandbox(), "real.pem");
    await writeFile(elsewhere, "x", { mode: 0o600 });
    await symlink(elsewhere, keyPath(dir));
    expect((await readAgentKey(dir)).state === "refused").toBe(true);
    expect((await ensureAgentKey(dir)).state).toBe("refused");
    await rm(keyPath(dir));

    await writeFile(keyPath(dir), "SECRET-LOOKING-GARBAGE\n", { mode: 0o600 });
    const garbage = await readAgentKey(dir);
    expect(garbage.state).toBe("refused");
    if (garbage.state === "refused") {
      expect(garbage.reason).toContain("does not hold a private key");
      expect(garbage.reason).not.toContain("SECRET-LOOKING-GARBAGE");
    }
    await rm(keyPath(dir));

    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" });
    await writeFile(keyPath(dir), rsa, { mode: 0o600 });
    const wrong = await readAgentKey(dir);
    expect(wrong.state === "refused" && wrong.reason).toContain("not an ed25519 one");
  });

  test("inside a git repository: refused, and nothing is created there", async () => {
    const repo = await sandbox();
    await mkdir(join(repo, ".git"));
    const dir = join(repo, "data", "mind", "example", "identity");
    const made = await ensureAgentKey(dir);
    expect(made.state === "refused" && made.reason).toContain("inside the git repository");
    expect(await readdir(repo)).toEqual([".git"]);

    // And a key someone put there by hand is not used either.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(keyPath(dir), generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const read = await readAgentKey(dir);
    expect(read.state === "refused" && read.reason).toContain("inside the git repository");
  });

  test("a directory it cannot write in, and a path through a file, are reasons rather than exceptions", async () => {
    const dir = await identityIn();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o500);
    const unwritable = await ensureAgentKey(dir);
    expect(unwritable.state).toBe("refused");
    await chmod(dir, 0o700);

    const home = await sandbox();
    await writeFile(join(home, "file"), "");
    const through = join(home, "file", "identity");
    expect((await readAgentKey(through)).state).toBe("refused");
    expect((await ensureAgentKey(through)).state).toBe("refused");
  });
});
