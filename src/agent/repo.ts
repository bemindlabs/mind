/**
 * "Is this path inside a git repository?" — one walk, and nothing else.
 *
 * This lived in `src/agent/new.ts` until S3.5 (w2), and moving it was not
 * tidying. `new.ts` imports the spawn chokepoint, because `mind new` runs
 * `git init`. Every module that asked this question therefore dragged the
 * ability to start a process into its own import closure — including
 * `src/guard/personal.ts`, which is what the observer store is built on.
 *
 * S3.5 AC2 is checked by walking the observer's import closure and requiring
 * that `src/spawn.ts` and `src/exec/` are not in it: a module that cannot reach
 * a subprocess cannot reach a network stack with extra steps either. With this
 * function still in `new.ts`, the only ways to pass that check would have been
 * to exempt the chokepoint — which is how a gate stops being one — or to give
 * the observer its own copy of the walk, which is how two copies drift.
 *
 * So the walk sits on its own, importing `node:fs` and `node:path` and nothing
 * else. It is a question about the filesystem and never runs `git`: asking the
 * binary would need a subprocess for an answer a `stat` already has, and the
 * answer has to be available to code that is not allowed to spawn one.
 */

import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The nearest ancestor of `target` (inclusive) that is a git working tree.
 *
 * Three callers need it, each to refuse a destination rather than to use one:
 * `mind new` (an agent is its own repository), `soul import --out` (an
 * imported soul carries host paths and account names), and `personalDir` (data
 * flagged personal must not be inside version control at all — D-014, I-4).
 *
 * `.git` is checked for existence rather than for being a directory: in a
 * worktree or a submodule it is a file, and both of those are still very much
 * inside somebody's history.
 *
 * **Both the path as written and where it really is** (S15.8 security review,
 * L3). The walk used to be lexical only, so `$XDG_DATA_HOME/mind/<subject>`
 * symlinked into a checkout passed as "outside git" while `git status` listed
 * the private key under it. Now, when the written path is clear, the nearest
 * ancestor that exists is resolved with `realpath`, the rest of the path is put
 * back on, and that is walked too. Either one inside a repository is inside.
 */
export async function enclosingGitRepo(target: string): Promise<string | undefined> {
  const written = resolve(target);
  const lexical = await walkUp(written);
  if (lexical !== undefined) return lexical;
  const real = await realTarget(written);
  return real === written ? undefined : walkUp(real);
}

async function walkUp(start: string): Promise<string | undefined> {
  let current = start;
  for (;;) {
    if (await exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** `path` with its nearest existing ancestor resolved through every symlink, and the missing rest appended. */
async function realTarget(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
