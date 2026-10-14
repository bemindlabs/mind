/**
 * A `git` that writes down every argv it is given, and refuses to touch a
 * network.
 *
 * S0.4 AC2's static checks say Mind's source cannot reach a remote. This is
 * the layer that watches what actually ran, which is the only one that can
 * catch a push arriving by a route nobody wrote down — a helper invoked with a
 * name that is not `git`, a command built from data, a library doing it on the
 * engine's behalf.
 *
 * The reason the behavioural layer is worth anything at all is `dependencies`
 * being empty, which the static layer pins: with no libgit in the tree, there
 * is no way to write a remote ref except by executing the `git` binary — and
 * the binary the child finds is this script, because it is first on a PATH that
 * holds nothing else.
 *
 * The trap exits 97 on a network verb rather than running it, so a test that
 * regresses fails instead of reaching whatever the argv named. Everything else
 * is handed to the real git, because the commands under test have to actually
 * work: a trap that broke `git init` would make the whole run pass for the
 * wrong reason.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The real git, found once, before any PATH in this file exists. */
export const REAL_GIT = Bun.which("git") ?? "git";

/**
 * Verbs the trap refuses, and the set the allowlist in `src/spawn.ts` is
 * checked against. Anything here reaches something that is not this machine.
 */
export const NETWORK_VERBS: readonly string[] = [
  "push",
  "fetch",
  "pull",
  "clone",
  "remote",
  "ls-remote",
  "send-pack",
  "receive-pack",
  "upload-pack",
  "submodule",
  "bundle",
  "daemon",
  "request-pull",
  "svn",
  "p4",
  "credential",
];

/** Enough git config to make a commit without reading anybody's real config. */
export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "mind test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "mind test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** A trap: a directory to put on PATH, and the log everything lands in. */
export interface GitTrap {
  /** Put this first on PATH. It holds one file, called `git`. */
  readonly dir: string;
  /** Where argvs are appended, one per line, tab separated. */
  readonly log: string;
  /** Every argv seen so far, in order. */
  seen(): Promise<readonly (readonly string[])[]>;
}

/**
 * Write a trap `git` under `home` and return where it lives.
 *
 * Exit code 97 is arbitrary and deliberately not 1: a test asserting on it
 * cannot be satisfied by git failing for an ordinary reason.
 */
export async function installTrapGit(home: string): Promise<GitTrap> {
  const dir = join(home, "trap-bin");
  const log = join(home, "git-argv.log");
  await mkdir(dir, { recursive: true });
  await writeFile(log, "");

  const script = `#!/bin/sh
{ printf '%s\\t' "$@"; printf '\\n'; } >> ${JSON.stringify(log)}
for mind_arg in "$@"; do
  case "$mind_arg" in
${NETWORK_VERBS.map((verb) => `    ${verb}) exit 97 ;;`).join("\n")}
  esac
done
exec ${JSON.stringify(REAL_GIT)} "$@"
`;

  const path = join(dir, "git");
  await writeFile(path, script);
  await chmod(path, 0o755);

  return {
    dir,
    log,
    async seen() {
      const text = await readFile(log, "utf8");
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split("\t").filter((part) => part !== ""));
    },
  };
}

/** Run the real git, outside the trap — the test playing the part of a human. */
export async function git(
  cwd: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([REAL_GIT, ...argv], {
    cwd,
    env: { ...GIT_ENV, PATH: process.env["PATH"] ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** Create a bare repository to act as a remote, reachable as a `file://` URL. */
export async function bareRemote(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  const result = await git(parent, ["init", "--bare", "-q", path]);
  if (result.code !== 0) throw new Error(`could not create a bare remote: ${result.stderr}`);
  return path;
}

/** Every ref in a bare repository. Empty means nothing was ever pushed to it. */
export async function refsIn(bare: string): Promise<readonly string[]> {
  const result = await git(bare, ["--git-dir", bare, "for-each-ref", "--format=%(refname)"]);
  return result.stdout.split("\n").filter((line) => line.trim() !== "");
}
