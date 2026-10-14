/**
 * The ledger's lock (D-145) — waited for, broken only when provably stale, and never held by two at once.
 *
 * The bug this file exists for: the lock used to throw the moment it was taken, so of two turns that
 * finished together one was "sent and not recorded" — and a turn killed while holding it left a directory
 * that made every later turn the same. Wherever the claim is about processes, real processes make it
 * (`lock-child.ts`), with a temporary HOME and state directory and a Qdrant URL nothing listens on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir, uptime } from "node:os";
import { join } from "node:path";
import {
  append,
  canAppend,
  LEDGER_VERSION,
  ledgerDir,
  LedgerLocked,
  LOCK_TIMING,
  query,
  RECORD_TIMING,
  withLock,
  type LedgerEntry,
  type LedgerEnv,
  type LockTiming,
  type ThisMachine,
} from "../../src/ledger/index.ts";
import { subjectId } from "../../src/types.ts";

const A = subjectId("alpha");
const CHILD = join(import.meta.dir, "lock-child.ts");
/** The real rules with a short wait, for the tests that are about giving up. */
const QUICK: LockTiming = { ...LOCK_TIMING, waitMs: 300 };
const OWNER_FILE = /^owner\.[0-9a-f-]{36}\.json$/;
/** This machine, read the way `ledgerEnv()` reads it — the children use `ledgerEnv()` itself. */
const HERE: ThisMachine = { host: hostname(), bootedAt: Date.now() - uptime() * 1000 };

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** `null` for a caller that cannot say which machine this is. */
async function makeEnv(
  machine: ThisMachine | null = HERE,
): Promise<LedgerEnv & { readonly root: string; readonly dir: string; readonly lock: string }> {
  const root = await mkdtemp(join(tmpdir(), "mind-lock-"));
  scratch.push(root);
  const env = {
    home: root,
    env: { XDG_STATE_HOME: join(root, "state") },
    now: () => new Date("2026-09-21T10:00:00.000Z"),
    ...(machine === null ? {} : { machine }),
  };
  const dir = ledgerDir(env, A);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return { ...env, root, dir, lock: join(dir, ".lock") };
}

let counter = 0;
function entry(): LedgerEntry {
  counter++;
  return {
    v: LEDGER_VERSION,
    kind: "turn",
    id: `id-${counter}`,
    turn: "turn-1",
    at: "2026-09-21T10:00:00.000Z",
    subject: A,
    backend: "ollama",
    model: null,
    content: "full",
    prompt: "hello",
    prompt_bytes: 5,
    text: "hi",
    text_bytes: 2,
    confidence: "confirmed",
    exit: null,
    duration_ms: 1,
    cost: null,
    identity: "system",
    soul_sha: null,
  } as LedgerEntry;
}

/**
 * Put an owner into `.lock` by hand, the way a writer would have left it — last heard from when it started,
 * which is when a writer that stopped its heartbeat (stopped, killed, wedged) last touched it.
 */
async function placeOwner(lock: string, owner: { pid: number; host: string | null; started: string } | string): Promise<string> {
  await mkdir(lock, { recursive: true, mode: 0o700 });
  const path = join(lock, `owner.${crypto.randomUUID()}.json`);
  await writeFile(path, typeof owner === "string" ? owner : `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  if (typeof owner !== "string") await utimes(path, new Date(owner.started), new Date(owner.started));
  return path;
}

/** A pid that was a process a moment ago and is not one now. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

function spawnChild(root: string, args: string[]) {
  return Bun.spawn([process.execPath, "run", CHILD, ...args], {
    env: { PATH: process.env["PATH"] ?? "", HOME: root, XDG_STATE_HOME: join(root, "state"), MIND_QDRANT_URL: "http://127.0.0.1:9" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Resolve once a child has printed `word` on a line of its own. */
async function waitFor(stream: ReadableStream<Uint8Array>, word: string): Promise<void> {
  const decoder = new TextDecoder();
  let seen = "";
  for await (const chunk of stream) {
    seen += decoder.decode(chunk);
    if (seen.split("\n").includes(word)) return;
  }
  throw new Error(`the child ended without printing ${word}: ${seen}`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function past(path: string, ms: number): Promise<void> {
  const then = new Date(Date.now() - ms);
  await utimes(path, then, then);
}

test("the numbers are the ones D-145 records", () => {
  expect(LOCK_TIMING).toEqual({ waitMs: 5_000, graceMs: 2_000, maxAgeMs: 600_000 });
  // After the send: a minute, the rules otherwise the same.
  expect(RECORD_TIMING).toEqual({ waitMs: 60_000, graceMs: 2_000, maxAgeMs: 600_000 });
});

describe("turns that finish together are all recorded", () => {
  test("eight processes appending at once: eight lines, none torn, no lock left behind", async () => {
    const env = await makeEnv();
    // Every child waits for the same instant, so the eight appends really do arrive together.
    const at = String(Date.now() + 1500);
    const children = Array.from({ length: 8 }, (_, i) => spawnChild(env.root, ["append", `p${i}`, at]));
    const outputs = await Promise.all(children.map(async (child) => {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { out, err, code };
    }));

    for (const { out, err, code } of outputs) {
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(out).ok).toBe(true);
    }
    const read = await query(env, A);
    expect(read.unreadable).toBe(0);
    expect(read.entries.map((e) => e.id).sort()).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]);

    // And on disk: eight whole lines, each one entry's own text from end to end.
    const text = await readFile(join(env.dir, "2026-09.jsonl"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.slice(0, -1).split("\n");
    expect(lines.length).toBe(8);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { id: string; prompt: string };
      expect(parsed.prompt).toBe(`${parsed.id} `.repeat(1024));
    }
    expect(await exists(env.lock)).toBe(false);
  }, 20_000);

  test("a lock a live process holds is waited for, and the line lands when it lets go", async () => {
    const env = await makeEnv();
    const holder = spawnChild(env.root, ["hold", env.dir, "600"]);
    await waitFor(holder.stdout, "held");

    const began = performance.now();
    await append(env, entry());
    expect(performance.now() - began).toBeGreaterThan(200);
    expect((await query(env, A)).entries.length).toBe(1);
    expect(await holder.exited).toBe(0);
    expect(await exists(env.lock)).toBe(false);
  }, 10_000);
});

describe("a holder's heartbeat", () => {
  test("a live hold longer than the max age is not broken by it", async () => {
    // Max age 400 ms, so the heartbeat is every 100 ms. The hold lasts 1.5 s. Without the heartbeat the waiter
    // would find an owner 400 ms old and break it while it is held.
    const env = await makeEnv();
    const timing: LockTiming = { ...LOCK_TIMING, maxAgeMs: 400 };
    let inside = 0;
    let most = 0;
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const holder = withLock(
      env.dir,
      async () => {
        inside++;
        most = Math.max(most, inside);
        holding();
        await Bun.sleep(1_500);
        inside--;
      },
      timing,
      HERE,
    );
    // The waiter starts once the holder really holds the lock — not 50 ms later on the hope that it does. Had
    // the waiter won the race, the order below would fail for a reason that has nothing to do with heartbeats.
    await held;
    const order: string[] = [];
    const waiter = withLock(
      env.dir,
      async () => {
        inside++;
        most = Math.max(most, inside);
        order.push("waiter");
        inside--;
      },
      timing,
      HERE,
    );
    await holder.then(() => order.push("holder done"));
    await waiter;
    expect(most).toBe(1);
    expect(order).toEqual(["holder done", "waiter"]);
  }, 10_000);

  test("a holder that stops beating is broken by age — the heartbeat is what keeps it, not the pid", async () => {
    // This process's pid, alive, last heard from longer ago than the max age: an owner that is stopped or wedged.
    const env = await makeEnv();
    const timing: LockTiming = { ...QUICK, maxAgeMs: 400 };
    const silent = await placeOwner(env.lock, { pid: process.pid, host: HERE.host, started: new Date(Date.now() - 1_000).toISOString() });
    await append(env, entry(), timing);
    expect(await exists(silent)).toBe(false);
  });

  test("a heartbeat never brings back an owner file that was removed, and stops when the lock is let go", async () => {
    const env = await makeEnv();
    await withLock(
      env.dir,
      async () => {
        // Broken under it, as a waiter breaks a lock it judged stale.
        const [mine] = await readdir(env.lock);
        await rm(join(env.lock, mine!));
        await rm(env.lock, { recursive: true });
        await Bun.sleep(250); // ten heartbeats at a max age of 100 ms
        expect(await exists(env.lock)).toBe(false);
      },
      { ...LOCK_TIMING, maxAgeMs: 100 },
      HERE,
    );
    await Bun.sleep(100);
    expect(await exists(env.lock)).toBe(false);
  });
});

describe("a lock held past the wait", () => {
  test("append fails naming the lock and its holder, canAppend refuses first, and the lock is left alone", async () => {
    const env = await makeEnv();
    const holder = spawnChild(env.root, ["hold", env.dir, "8000"]);
    try {
      await waitFor(holder.stdout, "held");
      const [owner] = await readdir(env.lock);

      const began = performance.now();
      const failed = await append(env, entry(), QUICK).then(() => undefined, (error: Error) => error);
      expect(performance.now() - began).toBeGreaterThanOrEqual(QUICK.waitMs);
      expect(failed?.message).toContain("ledger is locked");
      expect(failed?.message).toContain(env.lock);
      expect(failed?.message).toContain(`pid ${holder.pid} on ${hostname()}`);
      expect(failed?.message).toContain("still held after 0.3 s");
      expect(failed).toBeInstanceOf(LedgerLocked);

      const writable = await canAppend(env, A, QUICK);
      expect(writable.ok).toBe(false);
      if (!writable.ok) {
        expect(writable.kind).toBe("locked");
        expect(writable.reason).toContain(env.lock);
        expect(writable.reason).toContain(`pid ${holder.pid}`);
        // It passes, or clears by itself — and the ledger is never the thing to delete.
        expect(writable.remedy).toContain("Another turn is writing this agent's ledger — try again in a moment.");
        expect(writable.remedy).toContain("If no mind process is running");
        expect(writable.remedy).toContain("the next turn clears it by itself");
        expect(writable.remedy).toContain("once it is 10 minutes old");
        expect(writable.remedy).not.toMatch(/delete the ledger directory|fresh one/);
      }

      expect(await readdir(env.lock)).toEqual([owner!]);
      expect((await query(env, A)).entries).toEqual([]);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
  }, 10_000);

  test("a writer killed while holding it leaves it behind, and the next turn clears it before sending", async () => {
    // The reported case: `mind stop` during the fsync used to make every later turn unrecorded.
    const env = await makeEnv();
    const holder = spawnChild(env.root, ["hold", env.dir, "60000"]);
    await waitFor(holder.stdout, "held");
    holder.kill("SIGKILL");
    await holder.exited;
    expect((await readdir(env.lock)).filter((name) => OWNER_FILE.test(name)).length).toBe(1);

    expect(await canAppend(env, A)).toEqual({ ok: true, dir: env.dir });
    expect(await exists(env.lock)).toBe(false);
    await append(env, entry());
    expect((await query(env, A)).entries.length).toBe(1);
  }, 10_000);
});

describe("a stale lock is broken — only on evidence", () => {
  test("an owner on this host whose process is gone", async () => {
    const env = await makeEnv();
    const owner = await placeOwner(env.lock, { pid: await deadPid(), host: HERE.host, started: new Date().toISOString() });
    await append(env, entry(), QUICK);
    expect(await exists(owner)).toBe(false);
    expect(await exists(env.lock)).toBe(false);
    expect((await query(env, A)).entries.length).toBe(1);
  });

  test("an owner alive, but under another user (EPERM), is alive", async () => {
    const env = await makeEnv();
    const owner = await placeOwner(env.lock, { pid: 1, host: HERE.host, started: new Date().toISOString() });
    await expect(append(env, entry(), QUICK)).rejects.toThrow(/pid 1 on/);
    expect(await exists(owner)).toBe(true);
  });

  test("an owner that started before this machine booted is gone, whatever its pid is now", async () => {
    // Booted an hour ago. The pid is this process — alive — and no age limit applies: only the boot can
    // say the owner is gone.
    const env = await makeEnv({ host: HERE.host, bootedAt: Date.now() - 3_600_000 });
    const forever: LockTiming = { ...QUICK, maxAgeMs: Number.MAX_SAFE_INTEGER };
    const since = await placeOwner(env.lock, { pid: process.pid, host: HERE.host, started: new Date(Date.now() - 3_000_000).toISOString() });
    await expect(append(env, entry(), forever)).rejects.toThrow(/locked/);
    await rm(since);
    const before = await placeOwner(env.lock, { pid: process.pid, host: HERE.host, started: new Date(Date.now() - 7_200_000).toISOString() });
    await append(env, entry(), forever);
    expect(await exists(before)).toBe(false);
  });

  test("a writer that cannot say which machine it is on names none, and judges every owner by age alone", async () => {
    const env = await makeEnv(null);
    await withLock(env.dir, async () => {
      const [name] = await readdir(env.lock);
      expect(JSON.parse(await readFile(join(env.lock, name!), "utf8")).host).toBeNull();
    });
    // A dead pid proves nothing to a writer that does not know it is on the owner's machine.
    const dead = await placeOwner(env.lock, { pid: await deadPid(), host: HERE.host, started: new Date().toISOString() });
    await expect(append(env, entry(), QUICK)).rejects.toThrow(/locked/);
    expect(await exists(dead)).toBe(true);

    // And an owner that named no machine is judged the same way by one that knows its own.
    await rm(env.lock, { recursive: true });
    const unnamed = await placeOwner(env.lock, { pid: await deadPid(), host: null, started: new Date().toISOString() });
    const known = { ...env, machine: HERE };
    await expect(append(known, entry(), QUICK)).rejects.toThrow(/on a machine it did not name/);
    await rm(unnamed);
    await placeOwner(env.lock, { pid: await deadPid(), host: null, started: new Date(Date.now() - LOCK_TIMING.maxAgeMs - 60_000).toISOString() });
    await append(known, entry(), QUICK);
    expect(await exists(env.lock)).toBe(false);
  });

  test("an owner on another host is judged by its age alone", async () => {
    const env = await makeEnv();
    // Its pid is dead here, which says nothing about a process on another machine.
    const pid = await deadPid();
    const young = await placeOwner(env.lock, { pid, host: "another-machine", started: new Date().toISOString() });
    await expect(append(env, entry(), QUICK)).rejects.toThrow(/pid \d+ on another-machine/);
    expect(await exists(young)).toBe(true);

    await rm(young);
    const old = await placeOwner(env.lock, {
      pid,
      host: "another-machine",
      started: new Date(Date.now() - LOCK_TIMING.maxAgeMs - 60_000).toISOString(),
    });
    await append(env, entry(), QUICK);
    expect(await exists(old)).toBe(false);
  });

  test("an empty lock — an older release's, or a writer that died after mkdir — waits out the grace period", async () => {
    const env = await makeEnv();
    await mkdir(env.lock);
    // Younger than the grace period: somebody may be about to write their owner into it.
    await expect(append(env, entry(), QUICK)).rejects.toThrow(/still taking it/);
    expect(await exists(env.lock)).toBe(true);

    await past(env.lock, LOCK_TIMING.graceMs + 1000);
    await append(env, entry(), QUICK);
    expect(await exists(env.lock)).toBe(false);
    expect((await query(env, A)).entries.length).toBe(1);
  });

  for (const [what, name, text] of [
    ["a half-written owner", `owner.${crypto.randomUUID()}.json`, "{\"pid\":"],
    ["an owner still being renamed into place", `owner.${crypto.randomUUID()}.json.tmp`, "{}"],
    ["an owner with no usable pid", `owner.${crypto.randomUUID()}.json`, JSON.stringify({ pid: -1, host: "h", started: "2026-09-29T00:00:00Z" })],
  ] as const) {
    test(`${what} is stale only once it is older than the grace period`, async () => {
      const env = await makeEnv();
      await mkdir(env.lock);
      const path = join(env.lock, name);
      await writeFile(path, text);
      await expect(append(env, entry(), QUICK)).rejects.toThrow(/still taking it/);
      expect(await exists(path)).toBe(true);

      await past(path, LOCK_TIMING.graceMs + 1000);
      await append(env, entry(), QUICK);
      expect(await exists(env.lock)).toBe(false);
    });
  }

  test("something in the way that Mind cannot read or remove is named at once, never waited for, never removed", async () => {
    const env = await makeEnv();
    await writeFile(env.lock, "not a directory");
    const began = performance.now();
    // The full five-second wait, and it does not use it: nothing Mind may remove will move by itself.
    const failed = await append(env, entry()).then(() => undefined, (error: Error) => error);
    expect(performance.now() - began).toBeLessThan(LOCK_TIMING.waitMs / 2);
    expect(failed).not.toBeInstanceOf(LedgerLocked);
    expect(failed?.message).toMatch(/blocked by something that is not a lock Mind can read \(ENOTDIR\)/);
    expect(failed?.message).toContain("move it out of the way");
    expect(await readFile(env.lock, "utf8")).toBe("not a directory");

    // `canAppend` calls it what it is: a path for a person to fix, not a turn to wait for.
    const writable = await canAppend(env, A);
    expect(writable.ok).toBe(false);
    if (!writable.ok) {
      expect(writable.kind).toBe("unwritable");
      expect(writable.remedy).toContain("Fix what the line above names");
      expect(writable.remedy).not.toContain("clears it by itself");
    }

    await rm(env.lock);
    await mkdir(join(env.lock, "a directory"), { recursive: true });
    await past(join(env.lock, "a directory"), LOCK_TIMING.graceMs + 1000);
    await expect(append(env, entry(), QUICK)).rejects.toThrow(/a directory, which Mind cannot remove/);
    expect(await exists(join(env.lock, "a directory"))).toBe(true);
  });
});

describe("one holder at a time", () => {
  test("the lock on disk: one owner file naming this process, private, gone afterwards", async () => {
    const env = await makeEnv();
    const began = Date.now();
    await withLock(
      env.dir,
      async () => {
        const names = await readdir(env.lock);
        expect(names.length).toBe(1);
        expect(names[0]).toMatch(OWNER_FILE);
        const path = join(env.lock, names[0]!);
        const owner = JSON.parse(await readFile(path, "utf8")) as { pid: number; host: string; started: string };
        expect(owner).toEqual({ pid: process.pid, host: HERE.host, started: owner.started });
        expect(Date.parse(owner.started)).toBeGreaterThanOrEqual(began - 1000);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(env.lock)).mode & 0o777).toBe(0o700);
      },
      LOCK_TIMING,
      HERE,
    );
    expect(await exists(env.lock)).toBe(false);
  });

  // Below zero, every waiter removes every lock that has no owner yet the instant it sees one: the case the
  // check after the rename exists for, at its worst. Mutual exclusion must not depend on the grace period.
  for (const graceMs of [LOCK_TIMING.graceMs, -1_000]) {
    test(`waiters racing to break the same stale lock hold it one at a time (grace ${graceMs} ms)`, async () => {
      const env = await makeEnv();
      await placeOwner(env.lock, { pid: await deadPid(), host: HERE.host, started: new Date().toISOString() });
      let inside = 0;
      let most = 0;
      let entered = 0;
      await Promise.all(
        Array.from({ length: 8 }, async (_, i) => {
          // Staggered, so some waiters judge the old owner stale only after another has broken it and taken over.
          await Bun.sleep(i % 4);
          for (let round = 0; round < 5; round++) {
            await withLock(
              env.dir,
              async () => {
                inside++;
                entered++;
                most = Math.max(most, inside);
                await Bun.sleep(1);
                inside--;
              },
              { ...LOCK_TIMING, graceMs },
              HERE,
            );
          }
        }),
      );
      expect(entered).toBe(40);
      expect(most).toBe(1);
      expect(await exists(env.lock)).toBe(false);
    }, 10_000);

    test(`…and so do separate processes (grace ${graceMs} ms)`, async () => {
      const env = await makeEnv();
      await placeOwner(env.lock, { pid: await deadPid(), host: HERE.host, started: new Date().toISOString() });
      const marker = join(env.root, "inside");
      const at = String(Date.now() + 1500);
      const children = Array.from({ length: 8 }, () => spawnChild(env.root, ["crit", env.dir, marker, at, String(graceMs), "40"]));
      const outputs = await Promise.all(children.map(async (child) => {
        const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        return { out: out.trim(), code };
      }));
      expect(outputs).toEqual(Array.from({ length: 8 }, () => ({ out: "done", code: 0 })));
      expect(await exists(env.lock)).toBe(false);
    }, 20_000);
  }

  test("letting go removes only its own owner — a lock broken and retaken meanwhile stays the new holder's", async () => {
    const env = await makeEnv();
    let theirs = "";
    await withLock(
      env.dir,
      async () => {
        // What a waiter does to a lock it judged older than the max age, and the next holder after it.
        const [mine] = await readdir(env.lock);
        await rm(join(env.lock, mine!));
        await rm(env.lock, { recursive: true });
        theirs = await placeOwner(env.lock, { pid: process.pid, host: HERE.host, started: new Date().toISOString() });
      },
      LOCK_TIMING,
      HERE,
    );
    expect(await exists(theirs)).toBe(true);
  });
});

describe("errors that are not the lock", () => {
  test.skipIf(process.getuid?.() === 0)("a mkdir error other than EEXIST is thrown as it came, without waiting", async () => {
    const env = await makeEnv();
    await chmod(env.dir, 0o500);
    const began = performance.now();
    const failed = await append(env, entry())
      .then(() => undefined, (error: NodeJS.ErrnoException) => error)
      .finally(() => chmod(env.dir, 0o700));
    expect(performance.now() - began).toBeLessThan(LOCK_TIMING.waitMs / 2);
    expect(failed?.code).toBe("EACCES");
    expect(failed?.syscall).toBe("mkdir");
    expect(failed?.path).toBe(env.lock);
    expect(failed?.message).not.toContain("locked");
  });
});
