/**
 * The two hooks, as text — and the reasons they are shaped the way they are.
 *
 * ## Why they are generated rather than shipped as files
 *
 * `.git/hooks` is not in git and is not carried by `git clone`, so a hook is
 * not something a repository can contain; it is something a machine has to be
 * given. Generating them from constants means the sentences in the hook and the
 * sentences `mind guard status` prints are the same sentences — there is no
 * second copy to drift.
 *
 * ## Fail closed
 *
 * The pre-commit hook runs the engine, so it embeds an absolute path to it.
 * That path can stop being true: the engine moves, the checkout is deleted, bun
 * is upgraded somewhere else. When it does, the hook **blocks the commit** and
 * says how to reinstall. The alternative — warn and continue — would mean the
 * one run where the guard was broken is the run where it silently agreed.
 *
 * Embedding a path is chosen over looking `mind` up on PATH because Mind is
 * not on PATH on the machine this was written on, and a hook that resolved to
 * nothing would have been the warn-and-continue case wearing a better excuse.
 *
 * ## The pre-push hook is a speed bump, and says so
 *
 * It refuses when `MIND_SUBJECT` is in the environment, which is the marker
 * `cli-exec` puts on every child it starts: a push happening underneath an
 * mind turn is a push nobody typed. Otherwise it prints what a commit costs
 * (`GIT_UNDELETABLE`), says plainly that Mind cannot see whether the remote
 * is private, and gets out of the way — because publishing is a human act
 * (D-013) and a tool that blocked it would be making that decision instead.
 *
 * `git push --no-verify` skips it entirely. That is stated in the hook's own
 * output, in `GUARD_LIMITS`, and in ADR 0002.
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { GUARD_LIMITS, runGuarded } from "../spawn.ts";
import { GIT_UNDELETABLE } from "./history.ts";
import { SCAN_BLIND_SPOTS } from "./scan.ts";

/** Marks a hook as Mind's, so an installer can tell it from somebody else's. */
export const HOOK_MARKER = "mind guard hook v1";

/** The hooks Mind installs, in the order `guard status` reports them. */
export const HOOK_NAMES: readonly string[] = ["pre-commit", "pre-push"];

/** Hooks are executable by their owner and nobody else, like the rest of Mind's files. */
const HOOK_MODE = 0o700;

/** How to start the engine from a hook, and which paths have to exist first. */
export interface EngineCommand {
  /** argv, ready to be quoted into a script. */
  readonly argv: readonly string[];
  /** Paths the hook checks before running anything (fail closed). */
  readonly paths: readonly string[];
}

/**
 * Work out how this engine would have to be invoked from a shell.
 *
 * Two shapes, and the difference is whether the entry point is a file on disk:
 * a checkout runs `bun run /…/bin/mind.ts`, while `bun build --compile`
 * produces a single binary whose `import.meta.path` names a file inside the
 * executable that no shell can reach. Hence the existence check rather than a
 * test on the extension alone — the compiled entry point also ends in `.ts`.
 *
 * Pure, with the existence check injected, because the compiled case is
 * otherwise only reachable by building a binary in a test.
 */
export function hookCommand(
  execPath: string,
  mainPath: string,
  exists: (path: string) => boolean,
): EngineCommand {
  if (mainPath.endsWith(".ts") && isAbsolute(mainPath) && exists(mainPath)) {
    return { argv: [execPath, "run", mainPath], paths: [execPath, mainPath] };
  }
  return { argv: [execPath], paths: [execPath] };
}

/**
 * How the engine running right now would be started from a hook.
 *
 * The one function here that reads ambient state, kept to three lines so that
 * everything above it stays testable without a process to look at.
 */
export function engineCommand(): EngineCommand {
  return hookCommand(process.execPath, Bun.main, existsSync);
}

/** Single-quote for `sh`, including the one character that cannot be quoted inside. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Render a list of notes as shell that prints them, without any expansion. */
function heredoc(lines: readonly string[]): string {
  return [
    "cat >&2 <<'MIND_NOTE'",
    ...lines.map((line) => `  - ${line}`),
    "MIND_NOTE",
  ].join("\n");
}

const HEADER = (name: string) =>
  `#!/bin/sh
# ${HOOK_MARKER} — ${name}
#
# Written by \`mind guard install\`. This file is not in git: .git/hooks is not
# cloned, so a fresh clone of this agent has no guard until that command is run
# there. Delete this file to remove the hook.
set -u
`;

/** The pre-commit hook: scan the index, block on a finding, fail closed. */
export function preCommitScript(command: EngineCommand): string {
  const quoted = command.argv.map(shellQuote).join(" ");
  const paths = command.paths.map(shellQuote).join(" ");

  return `${HEADER("pre-commit")}
# Fail closed. If the engine is not where it was when this hook was written,
# nothing scanned what is staged — so this is a blocked commit, not a pass.
for mind_path in ${paths}; do
  if [ ! -e "$mind_path" ]; then
    printf '%s\\n' "mind guard: $mind_path is not there, so nothing scanned what you staged." >&2
    printf '%s\\n' "This commit is blocked rather than waved through. To fix it:" >&2
    printf '%s\\n' "  mind guard install <this directory>   # rewrite the hook for where the engine is now" >&2
    printf '%s\\n' "  rm .git/hooks/pre-commit                # or remove the guard, knowing it is gone" >&2
    exit 1
  fi
done

exec ${quoted} guard scan --staged .
`;
}

/** The pre-push hook: refuse a push Mind is underneath, inform a human one. */
export function prePushScript(): string {
  return `${HEADER("pre-push")}
# \`cli-exec\` puts MIND_SUBJECT in the environment of every process it starts,
# so this variable being set means the push is happening underneath a Mind
# turn — which is to say, nobody typed it. Publishing an identity is a human
# act (D-013).
if [ -n "\${MIND_SUBJECT-}" ]; then
  printf '%s\\n' "mind guard: refusing a push running underneath mind (MIND_SUBJECT=\${MIND_SUBJECT})." >&2
  printf '%s\\n' "Publishing an identity is a human act (D-013). Push it yourself if you meant to." >&2
${heredoc(GUARD_LIMITS)}
  exit 1
fi

printf '%s\\n' "mind guard: pushing to \${1-?} (\${2-?})." >&2
printf '%s\\n' "Mind cannot see whether that remote is private. It never created it and never asks a" >&2
printf '%s\\n' "host anything, so it will not tell you the repository is private — only that it cannot see." >&2
printf '%s\\n' "What a push puts beyond reach:" >&2
${heredoc(GIT_UNDELETABLE)}
printf '%s\\n' "This hook is a speed bump: \\\`git push --no-verify\\\` skips it. It does not block you." >&2
exit 0
`;
}

/** The script for a hook by name, or undefined when Mind does not install one. */
export function hookScript(name: string, command: EngineCommand): string | undefined {
  if (name === "pre-commit") return preCommitScript(command);
  if (name === "pre-push") return prePushScript();
  return undefined;
}

/**
 * Where this repository keeps its hooks.
 *
 * Asked of git rather than assumed to be `.git/hooks`: `.git` is a file in a
 * worktree and a submodule, and `core.hooksPath` moves the directory outright.
 * Guessing would install a guard somewhere git never looks, which is the one
 * failure that looks exactly like success.
 */
export async function hooksDir(repo: string): Promise<string> {
  const result = await runGuarded(["git", "rev-parse", "--git-path", "hooks"], { cwd: repo });
  if (result.code !== 0) {
    throw new Error(
      `${repo} does not look like a git repository: \`git rev-parse --git-path hooks\` exited ` +
        `${result.code}${result.stderr === "" ? "" : ` (${result.stderr})`}`,
    );
  }
  const printed = new TextDecoder().decode(result.stdout).trim();
  return resolve(repo, printed);
}

/** This repository's git directory, absolute. `.git` is a file in a worktree. */
async function gitDirOf(repo: string): Promise<string> {
  const result = await runGuarded(["git", "rev-parse", "--git-dir"], { cwd: repo });
  if (result.code !== 0) {
    throw new Error(
      `${repo} does not look like a git repository: \`git rev-parse --git-dir\` exited ` +
        `${result.code}${result.stderr === "" ? "" : ` (${result.stderr})`}`,
    );
  }
  return resolve(repo, new TextDecoder().decode(result.stdout).trim());
}

/** Is `path` the directory `root`, or somewhere below it? */
function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/** What is at a hook path now. `foreign` is somebody else's hook, never overwritten. */
export type HookState = "installed" | "absent" | "foreign";

/** One hook, where it is, and whose it is. */
export interface HookReport {
  readonly name: string;
  readonly path: string;
  readonly state: HookState;
}

async function stateOf(path: string): Promise<HookState> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "absent";
  const text = await file.text();
  return text.includes(HOOK_MARKER) ? "installed" : "foreign";
}

/** What Mind's hooks look like in this repository right now. */
export async function hookStatus(repo: string): Promise<readonly HookReport[]> {
  const dir = await hooksDir(repo);
  const reports: HookReport[] = [];
  for (const name of HOOK_NAMES) {
    const path = join(dir, name);
    reports.push({ name, path, state: await stateOf(path) });
  }
  return reports;
}

/** What happened when the hooks were installed. */
export type InstallOutcome =
  | { readonly ok: true; readonly written: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Write both hooks into `repo`, refusing to overwrite anybody else's.
 *
 * A hook that Mind did not write is somebody's work — a formatter, a linter,
 * a project convention — and replacing it silently would be the kind of thing
 * that makes people uninstall the tool that did it. Mind's own hooks are
 * recognised by {@link HOOK_MARKER} and are always rewritten, so reinstalling
 * after the engine moves is one command and not a merge.
 */
export async function installHooks(repo: string, command: EngineCommand): Promise<InstallOutcome> {
  let dir: string;
  let gitDir: string;
  try {
    dir = await hooksDir(repo);
    gitDir = await gitDirOf(repo);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  // `core.hooksPath` is often set *globally* — that is how husky and friends
  // work — and `git rev-parse --git-path hooks` honours it. Writing there
  // would install Mind's pre-commit scan into every repository on the
  // machine, including ones that have nothing to do with Mind. A tool that
  // did that as a side effect of `mind new` would deserve to be uninstalled.
  const root = resolve(repo);
  if (!within(dir, root) && !within(dir, gitDir)) {
    return {
      ok: false,
      reason:
        `git resolves this repository's hooks to ${dir}, which is outside ${root} — a shared ` +
        `core.hooksPath. Mind will not write there: the hook would then run in every ` +
        `repository that shares it. Unset core.hooksPath for this repository, or call ` +
        `\`mind guard scan --staged .\` from the hook you already have there.`,
    };
  }

  const foreign: string[] = [];
  for (const name of HOOK_NAMES) {
    const path = join(dir, name);
    if ((await stateOf(path)) === "foreign") foreign.push(path);
  }
  if (foreign.length > 0) {
    return {
      ok: false,
      reason:
        `${foreign.join(", ")} already exists and Mind did not write it. Nothing was changed — ` +
        `move the existing hook aside, or call Mind's guard from inside it with ` +
        `\`mind guard scan --staged .\`, and run this again.`,
    };
  }

  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const name of HOOK_NAMES) {
    const script = hookScript(name, command);
    if (script === undefined) continue;
    const path = join(dir, name);
    await writeFile(path, script, { mode: HOOK_MODE });
    // `writeFile`'s mode applies on creation only, so an existing hook keeps
    // whatever mode it had — including a non-executable one, which git ignores
    // in silence. Set it every time.
    await chmod(path, HOOK_MODE);
    written.push(path);
  }
  return { ok: true, written };
}

/**
 * The same three lists the hooks print, for the commands that print them too.
 *
 * Exported as one object so a caller cannot print two of the three and leave
 * out the one that would have changed somebody's mind.
 */
export const GUARD_NOTES: {
  readonly limits: readonly string[];
  readonly undeletable: readonly string[];
  readonly blindSpots: readonly string[];
} = {
  limits: GUARD_LIMITS,
  undeletable: GIT_UNDELETABLE,
  blindSpots: SCAN_BLIND_SPOTS,
};
