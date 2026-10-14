/**
 * The brake — layer one, whose whole mechanism is that a file exists.
 *
 * The cases here are mostly about what the brake refuses to be: it has no
 * format, so it cannot be malformed; it is not in git, so it cannot travel to a
 * machine nobody stopped; and "I cannot tell" reads as stopped, because the safe
 * reading of an unanswerable question is the same as the safe reading of an
 * unparseable dial.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  STOP_CANNOT,
  STOP_FILE,
  arm,
  disarm,
  isStopped,
  resumePhrase,
  stopPath,
} from "../../src/decide/stop.ts";
import { stateRoot } from "../../src/state.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    // A case below makes a directory unreadable; put it back or the cleanup
    // fails and takes the next test's diagnosis with it.
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function sandbox(): Promise<{ home: string; env: Record<string, string> }> {
  const home = await mkdtemp(join(tmpdir(), "mind-stop-"));
  scratch.push(home);
  return { home, env: { XDG_STATE_HOME: join(home, "state") } };
}

describe("the brake is the existence of a file and nothing else", () => {
  test("it lives under the state root, beside everything else this machine keeps", async () => {
    const env = await sandbox();
    expect(stopPath(env)).toBe(join(stateRoot(env.home, env.env), STOP_FILE));
    // Under the state root and *not* in a repository: committed, it would travel
    // with every clone and stop a machine nobody stopped, with nobody there able
    // to say why.
    expect(stopPath(env)).toContain(join("state", "mind"));
  });

  test("off, then on, then off again", async () => {
    const env = await sandbox();
    expect(await isStopped(env)).toBe(false);
    await arm(env, new Date("2026-09-22T00:00:00.000Z"), "a test");
    expect(await isStopped(env)).toBe(true);
    expect(await disarm(env)).toBe(true);
    expect(await isStopped(env)).toBe(false);
    // Disarming something that was not armed is `false`, not an error: the
    // command that clears it has to be safe to run twice.
    expect(await disarm(env)).toBe(false);
  });

  test("`touch` sets it — no Mind code involved, which is the point of layer one", async () => {
    const env = await sandbox();
    await mkdir(stateRoot(env.home, env.env), { recursive: true });
    // An empty file. Nothing parses it, so there is nothing in it to be wrong.
    await writeFile(stopPath(env), "");
    expect(await isStopped(env)).toBe(true);
  });

  test("its contents are never read, so no content can make it fail", async () => {
    const env = await sandbox();
    await mkdir(stateRoot(env.home, env.env), { recursive: true });
    for (const contents of ["", "\0\0\0", "{ not json", "off", "false", "0"]) {
      await writeFile(stopPath(env), contents);
      expect(await isStopped(env), JSON.stringify(contents)).toBe(true);
    }
  });

  test("a file it wrote explains itself, because somebody will open it", async () => {
    const env = await sandbox();
    const path = await arm(env, new Date("2026-09-22T00:00:00.000Z"), "mind stop");
    const text = await readFile(path, "utf8");
    expect(text).toContain("Mind is stopped");
    expect(text).toContain("2026-09-22T00:00:00.000Z");
    expect(text).toContain("mind stop");
    // And says plainly that Mind does not own it.
    expect(text).toContain("`rm` clears it");
  });

  test("it is written 0600, like everything else under the state root", async () => {
    const env = await sandbox();
    const path = await arm(env, new Date(), "a test");
    const { statSync } = await import("node:fs");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("arming twice is the same as arming once", async () => {
    const env = await sandbox();
    await arm(env, new Date("2026-01-01T00:00:00.000Z"), "first");
    await arm(env, new Date("2026-01-02T00:00:00.000Z"), "second");
    expect(await isStopped(env)).toBe(true);
    expect(readFileSync(stopPath(env), "utf8")).toContain("second");
  });
});

describe("`I cannot tell` reads as stopped", () => {
  test("a directory where the file should be counts as on", async () => {
    // Not `ENOENT`, so not "no brake". Every answer other than "it is not
    // there" is the safe one, for the same reason an unparseable dial is 0.
    const env = await sandbox();
    await mkdir(stopPath(env), { recursive: true });
    expect(await isStopped(env)).toBe(true);
  });

  test("a state root that cannot be read counts as on", async () => {
    const env = await sandbox();
    const root = stateRoot(env.home, env.env);
    await mkdir(root, { recursive: true });
    await chmod(root, 0o000);
    scratch.push(root);
    try {
      // EACCES rather than ENOENT. Mind cannot show that it was told to run,
      // and the safe reading of that is the same as being told not to.
      expect(await isStopped(env)).toBe(true);
    } finally {
      await chmod(root, 0o700);
    }
  });
});

describe("what stopping cannot do, said in the command's own output", () => {
  test("the irreversible half is named first", () => {
    expect(STOP_CANNOT[0]).toContain("already been written");
    expect(STOP_CANNOT[0]).toContain("stops the next act, not the last one");
  });

  test("the Ctrl-C measurement is in the list, because that is the belief that costs", () => {
    // The answer that sounded right and was measured wrong: a background job
    // ignores SIGINT by POSIX default. Somebody who presses Ctrl-C and sees the
    // prompt come back has been told the turn ended, and may not have been.
    const all = STOP_CANNOT.join("\n");
    expect(all).toContain("Ctrl-C");
    expect(all).toContain("ignores SIGINT by default");
    expect(all).toContain("2026-09-22");
    // …and the thing that does work, so the line is actionable and not a shrug.
    expect(all).toContain("group SIGTERM");
    expect(all).toContain("kill -TERM -<pgid>");
  });

  test("every line is long enough to be worth reading", () => {
    expect(STOP_CANNOT.length).toBeGreaterThan(3);
    for (const line of STOP_CANNOT) expect(line.length).toBeGreaterThan(60);
  });
});

describe("clearing it costs a keystroke that setting it does not", () => {
  test("there is a phrase, and it is not a flag", () => {
    // The asymmetry is the design: stopping must be available to somebody in a
    // hurry on a machine where Mind may not work; starting again must cost a
    // moment's attention, and must not be something a program running as the
    // owner can pass on their behalf.
    expect(resumePhrase()).toBe("resume mind");
    expect(resumePhrase()).not.toContain("--");
  });
});
