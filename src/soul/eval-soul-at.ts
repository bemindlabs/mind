/**
 * S21.3 — the soul at a git ref, on disk for as long as a compare needs it.
 *
 * `mind eval --compare <ref>` must answer the same tasks with the soul the
 * agent repository held at `<ref>`. That soul is written out of git's object
 * store into a temporary working tree under the state root
 * (`<state>/scratch/eval-compare/`), never inside the agent repository.
 *
 * Not `git worktree add`: Mind may run only the local, read-only git verbs of
 * the spawn guard (S0.4 AC2, `src/spawn.ts`), and a checkout would also run the
 * repository's hooks and smudge filters (an LFS filter reaches a remote). So
 * the tree is read with `git cat-file` alone, which applies neither, and the
 * agent repository is left exactly as it was: no worktree to prune.
 *
 * Only the soul comes from the ref: every file under a `soul/` of its own, or
 * the named soul files when the soul sits beside other files (the same rule
 * `soulFiles` uses). Everything else a turn reads stays the base's: the derived
 * index (`.mind/`) is linked from the base agent directory, so recall finds the
 * same notes on both sides and only the soul differs.
 *
 * The tree is removed whatever happens: on return, on a throw, and on SIGINT
 * or SIGTERM (Ctrl-C mid-run), after which the process exits 130 or 143. The
 * index link is unlinked first, so nothing under the base's `.mind/` is
 * touched.
 */

import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DERIVED_DIR } from "../agent/template.ts";
import { runGuarded } from "../spawn.ts";
import { STATE_DIR_MODE } from "../state.ts";
import { NAMED_SOUL_FILES } from "./eval-runs.ts";
import { resolveSoulDir } from "./load.ts";

export const COMPARE_SCRATCH = join("scratch", "eval-compare");

export interface SoulAtRef {
  /** The `<dir>` the caller named, as it is laid out in the temporary tree. */
  readonly dir: string;
  /** The commit the ref named. */
  readonly commit: string;
  /** The git tree of the soul directory at that commit: what `soulVersion` calls `gitTree`. */
  readonly soulTree: string;
  /** The temporary tree's root (removed after). */
  readonly root: string;
}

const git = async (cwd: string, args: readonly string[]) => {
  try {
    const run = await runGuarded(["git", ...args], { cwd });
    return { code: run.code, bytes: run.stdout, out: new TextDecoder().decode(run.stdout).trim() };
  } catch {
    return { code: -1, bytes: new Uint8Array(), out: "" };
  }
};

const exists = async (path: string) => lstat(path).then(() => true, () => false);

/** One entry of `git cat-file -p <tree>`: `<mode> <type> <sha>\t<name>`. */
const ENTRY = /^(\d+) (blob|tree|commit) ([0-9a-f]+)\t(.+)$/;

/**
 * Write the tree `spec` into `to`. Regular files and directories only: a
 * symlink or a submodule in a soul is skipped (neither is soul text), and so is
 * a name that could leave `to`.
 */
async function writeTree(repo: string, spec: string, to: string, only?: ReadonlySet<string>): Promise<void> {
  await mkdir(to, { recursive: true });
  const listing = await git(repo, ["cat-file", "-p", spec]);
  for (const line of listing.out.split("\n")) {
    const m = ENTRY.exec(line);
    if (m === null) continue;
    const [, mode, type, sha, name] = m as unknown as [string, string, string, string, string];
    if (name === "." || name === ".." || name.includes("/") || name.includes(sep)) continue;
    if (only !== undefined && (type !== "blob" || !only.has(name))) continue;
    if (type === "tree") await writeTree(repo, sha, join(to, name));
    else if (type === "blob" && (mode === "100644" || mode === "100755")) {
      const blob = await git(repo, ["cat-file", "blob", sha]);
      await writeFile(join(to, name), blob.bytes);
      if (mode === "100755") await chmod(join(to, name), 0o755);
    }
  }
}

/**
 * Run `fn` with the soul of `ref` written out under `stateRoot`, and remove it
 * after, whatever happens.
 */
export async function withSoulAtRef<T>(
  dir: string,
  ref: string,
  stateRoot: string,
  fn: (at: SoulAtRef) => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }> {
  const abs = resolve(dir);
  const top = await git(abs, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || top.out === "") return { ok: false, reason: `${abs} is not in a git repository: --compare reads the candidate soul from the agent repository's history` };
  const repo = await realpath(top.out);
  const commit = await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (commit.code !== 0 || commit.out === "") return { ok: false, reason: `no commit ${JSON.stringify(ref)} in ${repo}` };
  // The turn's own rule (`recallFor` in bin/commands/turn.ts): `<dir>` names the soul, so the agent is its parent; else `<dir>` is the agent.
  const named = await resolveSoulDir(abs);
  const real = await realpath(abs);
  const soulDir = named === abs ? real : join(real, basename(named));
  const agentDir = named === abs ? dirname(real) : real;
  const soulRel = relative(repo, soulDir);
  const tree = await git(repo, ["rev-parse", "--verify", "--quiet", `${commit.out}:${soulRel}`]);
  const kind = tree.code === 0 ? await git(repo, ["cat-file", "-t", tree.out]) : undefined;
  if (kind?.out !== "tree") return { ok: false, reason: `${soulRel || "."} does not exist at ${ref}` };

  const scratch = join(stateRoot, COMPARE_SCRATCH);
  await mkdir(scratch, { recursive: true, mode: STATE_DIR_MODE });
  const temp = await mkdtemp(join(scratch, "soul-"));
  // The repository root, mirrored one level down so an agent directory just above it still fits inside `temp`.
  const root = join(temp, "repo");
  let link: string | undefined;
  let done: Promise<void> | undefined;
  const cleanup = () =>
    (done ??= (async () => {
      if (link !== undefined) await unlink(link).catch(() => undefined);
      await rm(temp, { recursive: true, force: true });
    })());
  const onSignal = (signal: NodeJS.Signals) => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const at = join(root, relative(repo, real));
    await writeTree(repo, tree.out, join(root, soulRel), basename(soulDir) === "soul" ? undefined : new Set(NAMED_SOUL_FILES));
    await mkdir(at, { recursive: true });
    const index = join(agentDir, DERIVED_DIR);
    const target = join(root, relative(repo, agentDir), DERIVED_DIR);
    if (target.startsWith(temp + sep) && (await exists(index))) {
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(index), target);
      link = target;
    }
    return { ok: true, value: await fn({ dir: at, commit: commit.out, soulTree: tree.out, root }) };
  } finally {
    await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
