/** S21.3 — the soul at a ref, written out under the state root (never in the agent repository) and removed whatever happens. */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPARE_SCRATCH, withSoulAtRef } from "../../src/soul/eval-soul-at.ts";
import { soulVersion } from "../../src/soul/eval-runs.ts";
import { BUN } from "../support/bare-path.ts";

const SOUL = join(import.meta.dir, "..", "fixtures", "soul-valid");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  const out = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(child.stderr).text()}`);
  return out.trim();
}

/** An agent repo: two commits with different role text, extra soul files, and a derived index outside git. */
async function agentRepo() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mind-eval-at-")));
  scratch.push(home);
  const agent = join(home, "agent");
  await cp(SOUL, join(agent, "soul"), { recursive: true });
  await mkdir(join(agent, "soul", "notes"));
  await writeFile(join(agent, "soul", "notes", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await symlink("role.md", join(agent, "soul", "alias.md"));
  await writeFile(join(agent, ".gitignore"), "/.mind/\n");
  await writeFile(join(agent, "memory.md"), "not soul");
  await git(agent, "init", "-q");
  await git(agent, "add", "-A");
  await git(agent, "commit", "-q", "-m", "first soul");
  const first = await git(agent, "rev-parse", "HEAD");
  await writeFile(join(agent, "soul", "role.md"), (await Bun.file(join(agent, "soul", "role.md")).text()) + "\nsecond\n");
  await git(agent, "commit", "-q", "-am", "second soul");
  await mkdir(join(agent, ".mind"));
  await writeFile(join(agent, ".mind", "index"), "derived");
  return { home, agent, first, state: join(home, "state") };
}

const gitState = async (agent: string) => [await git(agent, "worktree", "list", "--porcelain"), await git(agent, "status", "--porcelain", "--ignored")].join("\n");
const leftovers = async (state: string) => readdir(join(state, COMPARE_SCRATCH));

describe("the soul at a ref", () => {
  test("the soul alone, from the ref, under the state root; the index linked from the base; all gone after", async () => {
    const r = await agentRepo();
    const before = await gitState(r.agent);
    const firstTree = await git(r.agent, "rev-parse", `${r.first}:soul`);
    const out = await withSoulAtRef(join(r.agent, "soul"), "HEAD~1", r.state, async (at) => {
      expect(at.commit).toBe(r.first);
      expect(at.soulTree).toBe(firstTree);
      expect(at.root.startsWith(join(r.state, COMPARE_SCRATCH))).toBe(true);
      expect(at.dir).toBe(join(at.root, "soul"));
      expect(await readdir(at.dir)).toEqual(expect.arrayContaining(["notes", "person.md", "role.md"]));
      expect(await readdir(at.dir)).not.toContain("alias.md");
      expect((await stat(join(at.dir, "notes", "run.sh"))).mode & 0o111).not.toBe(0);
      expect(await Bun.file(join(at.root, "memory.md")).exists()).toBe(false);
      const link = join(at.root, ".mind");
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(join(r.agent, ".mind"));
      // Its version names the ref's tree: the content of the first commit's soul.
      const v = await soulVersion(at.dir);
      expect(v.files).toEqual(["notes/run.sh", "person.md", "role.md"]);
      return Bun.file(join(at.dir, "role.md")).text();
    });
    if (!out.ok) throw new Error(out.reason);
    expect(out.value).not.toContain("second");
    expect(await leftovers(r.state)).toEqual([]);
    expect(await gitState(r.agent)).toBe(before);
    expect(await Bun.file(join(r.agent, ".mind", "index")).text()).toBe("derived");
    // Naming the agent directory works the same: its soul/ from the ref, and the index beside it.
    const whole = await withSoulAtRef(r.agent, "HEAD", r.state, async (at) => [at.dir === at.root, (await lstat(join(at.dir, ".mind"))).isSymbolicLink(), await Bun.file(join(at.dir, "soul", "role.md")).exists()]);
    expect(whole).toEqual({ ok: true, value: [true, true, true] });
  });

  test("a soul beside other files: only the named soul files come from the ref", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "mind-eval-at-")));
    scratch.push(home);
    const repo = join(home, "agent");
    await cp(SOUL, repo, { recursive: true });
    await writeFile(join(repo, "evals.md"), "the set");
    await git(repo, "init", "-q");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "soul at the root");
    // The soul is the repository root, so the agent is its parent: the index link lands above the mirror, still inside the scratch.
    await mkdir(join(home, ".mind"));
    const out = await withSoulAtRef(repo, "HEAD", join(home, "state"), async (at) => [(await readdir(at.dir)).sort(), (await lstat(join(at.root, "..", ".mind"))).isSymbolicLink()]);
    expect(out).toEqual({ ok: true, value: [["person.md", "role.md"], true] });
  });

  test("removed when the work throws", async () => {
    const r = await agentRepo();
    await expect(withSoulAtRef(r.agent, "HEAD~1", r.state, async () => {
      throw new Error("turn failed");
    })).rejects.toThrow("turn failed");
    expect(await leftovers(r.state)).toEqual([]);
    expect(await Bun.file(join(r.agent, ".mind", "index")).text()).toBe("derived");
  });

  test("refused, with the reason: not in git, no such ref, the soul absent at the ref", async () => {
    const r = await agentRepo();
    const outside = join(r.home, "loose");
    await cp(SOUL, outside, { recursive: true });
    const notGit = await withSoulAtRef(outside, "HEAD", r.state, async () => 1);
    expect(notGit.ok).toBe(false);
    if (!notGit.ok) expect(notGit.reason).toContain("is not in a git repository");
    const noRef = await withSoulAtRef(r.agent, "no-such-branch", r.state, async () => 1);
    expect(noRef.ok).toBe(false);
    if (!noRef.ok) expect(noRef.reason).toBe(`no commit "no-such-branch" in ${r.agent}`);
    await cp(SOUL, join(r.agent, "later", "soul"), { recursive: true });
    await git(r.agent, "add", "-A");
    await git(r.agent, "commit", "-q", "-m", "later");
    const absent = await withSoulAtRef(join(r.agent, "later"), "HEAD~1", r.state, async () => 1);
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.reason).toBe("later/soul does not exist at HEAD~1");
  });

  test("removed on Ctrl-C mid-run, and the process exits 130", async () => {
    const r = await agentRepo();
    const ready = join(r.home, "ready");
    const script = join(r.home, "hold.ts");
    await writeFile(
      script,
      `import { withSoulAtRef } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "soul", "eval-soul-at.ts"))};
await withSoulAtRef(${JSON.stringify(r.agent)}, "HEAD~1", ${JSON.stringify(r.state)}, async (at) => {
  await Bun.write(${JSON.stringify(ready)}, at.root);
  await new Promise(() => setInterval(() => undefined, 1000));
});
`,
    );
    const child = Bun.spawn([BUN, "run", script], { env: GIT_ENV, stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 200 && !(await Bun.file(ready).exists()); i++) await Bun.sleep(50);
    const held = await Bun.file(ready).text();
    expect(await Bun.file(join(held, "soul", "role.md")).exists()).toBe(true);
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    expect(await Bun.file(join(held, "soul", "role.md")).exists()).toBe(false);
    expect(await leftovers(r.state)).toEqual([]);
    expect(await Bun.file(join(r.agent, ".mind", "index")).text()).toBe("derived");
  }, 30_000);
});
