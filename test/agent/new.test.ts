/**
 * Creating an agent, and the three places it will not create one.
 *
 * The refusals carry more weight than the happy path. Each of them is an
 * invariant being kept by a directory *not* existing: no soul under the engine
 * (D-021), no soul inside somebody else's git history (I-4), no write over a
 * file somebody would want back.
 *
 * Everything runs under a temporary directory, and `git init` runs for real —
 * with a temporary `HOME` so that no config of the person running the tests is
 * read, and with no commit, so no git identity is needed. The one case that
 * does not use real git is the failure case, which uses the seam, because
 * breaking git to test what happens when it breaks is not a trade worth making.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SIDE_BY_SIDE_NOTE, newAgent } from "../../src/agent/new.ts";
// Moved out of `new.ts` by S3.5 (w2) so that asking "is this inside git?" no
// longer drags the spawn chokepoint into the asker's import closure.
import { enclosingGitRepo } from "../../src/agent/repo.ts";
import { GITIGNORE_FILE, SOUL_DIR } from "../../src/agent/template.ts";
import { subjectId } from "../../src/types.ts";

const ENGINE_ROOT = resolve(import.meta.dir, "..", "..");
const SUBJECT = subjectId("example");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-new-"));
  scratch.push(dir);
  return dir;
}

function create(dir: string, overrides: Partial<Parameters<typeof newAgent>[0]> = {}) {
  return newAgent({ dir, subject: SUBJECT, name: "example", engineRoot: ENGINE_ROOT, ...overrides });
}

describe("mind new", () => {
  test("AC1 — it creates a repository with soul, memory, consent and .gitignore", async () => {
    const dir = join(await sandbox(), "example");
    const result = await create(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.files).toContain(GITIGNORE_FILE);
    expect(result.files).toContain(`${SOUL_DIR}/role.md`);
    for (const file of result.files) expect(await Bun.file(join(dir, file)).exists()).toBe(true);
    expect(await enclosingGitRepo(dir)).toBe(dir);
  });

  test("it commits nothing and sets no remote — publishing is a human act", async () => {
    const dir = join(await sandbox(), "example");
    await create(dir);

    const log = Bun.spawn(["git", "-C", dir, "log", "--oneline"], { stdout: "pipe", stderr: "pipe" });
    await log.exited;
    expect(log.exitCode).not.toBe(0);

    const remotes = Bun.spawn(["git", "-C", dir, "remote"], { stdout: "pipe", stderr: "pipe" });
    const listed = await new Response(remotes.stdout).text();
    await remotes.exited;
    expect(listed.trim()).toBe("");
  });

  test("D-021 — it refuses a destination inside the engine repository", async () => {
    const result = await create(join(ENGINE_ROOT, "agents", "example"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("refused");
    expect(result.reason).toContain("engine repository");
    expect(await Bun.file(join(ENGINE_ROOT, "agents", "example", GITIGNORE_FILE)).exists()).toBe(false);
  });

  test("I-4 — it refuses a destination inside another git repository", async () => {
    const outer = await sandbox();
    const init = Bun.spawn(["git", "init", "-q", outer], { stdout: "pipe", stderr: "pipe" });
    await init.exited;
    expect(init.exitCode).toBe(0);

    const dir = join(outer, "example");
    const result = await create(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("refused");
    expect(result.reason).toContain("git repository at");
    expect(await Bun.file(join(dir, GITIGNORE_FILE)).exists()).toBe(false);
  });

  test("it refuses a directory that already holds something, and writes nothing", async () => {
    const dir = join(await sandbox(), "example");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes.md"), "something somebody wrote\n");

    const result = await create(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("refused");
    expect(await readdir(dir)).toEqual(["notes.md"]);
  });

  test("a failed git init keeps the files and says so", async () => {
    const dir = join(await sandbox(), "example");
    const result = await create(dir, {
      git: async () => ({ ok: false, detail: "git: command not found" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("incomplete");
    expect(result.reason).toContain("git init");
    // The files are correct; they are simply not a repository yet.
    expect(await readFile(join(dir, GITIGNORE_FILE), "utf8")).toBe("/.mind/\n");
  });

  test("D-049 — the note points at the readers, not at a remembered state", () => {
    // It used to say "no second agent until S1.6" and went on saying it after
    // S1.6 landed. It may name S1.6 as the reason several can coexist; it may
    // not tell anyone to wait for it.
    expect(SIDE_BY_SIDE_NOTE).toContain("mind worn");
    expect(SIDE_BY_SIDE_NOTE).toContain("D-049");
    expect(SIDE_BY_SIDE_NOTE).not.toMatch(/until|hard stop|for now/i);
  });
});

describe("enclosingGitRepo", () => {
  test("it finds the repository a path is inside, and answers nothing outside one", async () => {
    const outside = await sandbox();
    expect(await enclosingGitRepo(join(outside, "nowhere", "deep"))).toBeUndefined();
    expect(await enclosingGitRepo(ENGINE_ROOT)).toBe(ENGINE_ROOT);
    expect(await enclosingGitRepo(join(ENGINE_ROOT, "src", "agent"))).toBe(ENGINE_ROOT);
  });
});
