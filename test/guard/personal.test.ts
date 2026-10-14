/**
 * Where personal data goes (AC4), and the two ways that could go wrong.
 *
 * **Inside a repository.** `XDG_DATA_HOME` is a variable and a variable can
 * point anywhere, including into a checkout somebody keeps their notes in.
 * The resolver refuses rather than writing there, because the whole point of
 * AC4 is that this data is never in version control — not ignored, not
 * untracked, not there.
 *
 * **Under the wrong identity.** The subject is an argument and is never
 * inferred from a directory name (I-3). Two subjects get two directories, and
 * nothing about the agent's folder decides which is which.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePersonalDir, personalDir } from "../../src/guard/personal.ts";
import { subjectId } from "../../src/types.ts";
import { git } from "../support/trap-git.ts";

const SUBJECT = subjectId("example");
const OTHER = subjectId("somebody-else");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-personal-"));
  scratch.push(dir);
  return dir;
}

describe("where it resolves to", () => {
  test("XDG_DATA_HOME when it is set, ~/.local/share when it is not", async () => {
    const home = await sandbox();

    const configured = await personalDir({ home, env: { XDG_DATA_HOME: join(home, "data") } }, SUBJECT);
    expect(configured.path).toBe(join(home, "data", "mind", SUBJECT, "personal"));

    const fallback = await personalDir({ home, env: {} }, SUBJECT);
    expect(fallback.path).toBe(join(home, ".local", "share", "mind", SUBJECT, "personal"));

    // An exported-but-empty variable is an unset one, not a path at the root.
    const empty = await personalDir({ home, env: { XDG_DATA_HOME: "" } }, SUBJECT);
    expect(empty.path).toBe(fallback.path);
  });

  test("I-3 — two subjects never share a directory, whatever the agent is called", async () => {
    const home = await sandbox();
    const env = { home, env: {} };

    const mine = await personalDir(env, SUBJECT);
    const theirs = await personalDir(env, OTHER);
    expect(mine.path).not.toBe(theirs.path);
    expect(mine.path).toContain(SUBJECT);
    expect(theirs.path).toContain(OTHER);
  });

  test("it is outside every agent repository by construction, not by ignore rule", async () => {
    const home = await sandbox();
    const agent = join(home, "agents", "example");
    const resolved = await personalDir({ home, env: {} }, SUBJECT);
    expect(resolved.path.startsWith(agent)).toBe(false);
  });
});

describe("when it refuses", () => {
  test("a subject directory symlinked into a checkout is refused too — the walk follows where it really is (S15.8 review, L3)", async () => {
    const parent = await sandbox();
    const checkout = join(parent, "notes");
    expect((await git(parent, ["init", "-q", checkout])).code).toBe(0);
    await mkdir(join(parent, "data", "mind"), { recursive: true });
    await mkdir(join(checkout, "hidden"));
    await symlink(join(checkout, "hidden"), join(parent, "data", "mind", SUBJECT));

    const resolved = await personalDir({ home: parent, env: { XDG_DATA_HOME: join(parent, "data") } }, SUBJECT);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toContain(checkout);
    // And a path that is merely missing, with nothing symlinked, is still fine.
    const clean = await personalDir({ home: parent, env: { XDG_DATA_HOME: join(parent, "elsewhere") } }, SUBJECT);
    expect(clean.ok).toBe(true);
  });

  test("a data root inside a git repository is refused, and nothing is created", async () => {
    const parent = await sandbox();
    const checkout = join(parent, "notes");
    expect((await git(parent, ["init", "-q", checkout])).code).toBe(0);

    const resolved = await personalDir({ home: parent, env: { XDG_DATA_HOME: checkout } }, SUBJECT);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.reason).toContain(checkout);
    expect(resolved.reason).toContain("D-014");

    const created = await ensurePersonalDir(
      { home: parent, env: { XDG_DATA_HOME: checkout } },
      SUBJECT,
    );
    expect(created.ok).toBe(false);
    expect(await Bun.file(join(resolved.path, ".keep")).exists()).toBe(false);
  });
});

describe("when it creates", () => {
  test("the directory is the owner's alone", async () => {
    const home = await sandbox();
    const created = await ensurePersonalDir({ home, env: { XDG_DATA_HOME: join(home, "data") } }, SUBJECT);

    expect(created.ok).toBe(true);
    expect((await stat(created.path)).mode & 0o777).toBe(0o700);
  });

  test("resolving does not create — asking where something goes is not putting it there", async () => {
    const home = await sandbox();
    const resolved = await personalDir({ home, env: { XDG_DATA_HOME: join(home, "data") } }, SUBJECT);

    expect(resolved.ok).toBe(true);
    expect(await Bun.file(resolved.path).exists()).toBe(false);
  });
});
