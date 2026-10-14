/**
 * Making an agent: a directory, five files, and `git init`. Nothing else.
 *
 * What this function does *not* do is most of its design. It does not commit,
 * does not add a remote, does not push, and does not offer a flag that would.
 * Publishing an identity is a human act (D-013), and the way to keep that true
 * is for the code path not to exist. S0.4 now checks that omission rather than
 * trusting it: `git init` goes through `src/spawn.ts`, whose verb allowlist has
 * no way to reach a remote, and `test/guard/no-push.test.ts` proves it three
 * ways. The first commit is therefore the owner's to make, which also means the
 * owner is the one who decides what the repository says on the day it starts
 * remembering.
 *
 * Since S0.4 the repository also gets its guard here, in the same breath as
 * `git init`. A pre-commit scan somebody has to remember to install is a scan
 * that is not installed on the day it would have mattered; and because
 * `.git/hooks` is not cloned, `mind guard install` exists for the clone on
 * the other machine. A repository whose hooks could not be written is reported
 * as `incomplete`, exactly like one `git init` failed in: the files are correct
 * and Mind will not delete them, but it will not pretend the guard is there.
 *
 * Three destinations are refused outright, each because of what it would do to
 * an invariant rather than because it would be untidy:
 *
 * - **Inside the engine's own repository.** The engine carries no identity data
 *   at all (D-021); a soul written under it is a soul one `git add` away from
 *   a repository that is designed to be opened to the public one day. This one
 *   needs an {@link NewAgentRequest.engineRoot} to compare against, and the
 *   compiled binary has none — see the note on that field for what holds
 *   instead, and for what does not.
 * - **Inside any other git repository.** An agent is its own repository or it
 *   is not portable, and a soul committed into somebody else's history cannot
 *   be withdrawn from it afterwards (I-4).
 * - **A directory that already has anything in it.** There is no merge here
 *   that could be got right, and the file this would overwrite is the one
 *   somebody would most want back.
 *
 * `git init` runs through a seam rather than directly so that a test can watch
 * what happens when it fails without breaking git on the machine. When it does
 * fail the files are left where they are and said so: they are correct, they
 * are simply not a repository yet, and deleting somebody's new agent to tidy up
 * after a failed subprocess would be the worse of the two outcomes.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { engineCommand, installHooks, type InstallOutcome } from "../guard/hooks.ts";
import { runGuarded } from "../spawn.ts";
import type { SubjectId } from "../types.ts";
import { enclosingGitRepo } from "./repo.ts";
import { templateFiles } from "./template.ts";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * What `new` says about living beside other agents, printed after every creation.
 *
 * It used to state D-020's hard stop — no second agent until soul isolation
 * (S1.6) — and kept saying it after S1.6 landed, which is the argument D-049
 * makes against a registry: a sentence that remembers a state goes stale, a
 * command that reads the state does not. So this one points at the readers.
 */
export const SIDE_BY_SIDE_NOTE =
  "Every agent is its own repository (D-013), and several can live on one machine: a soul " +
  "loads only for its own subject and each subject's data sits under its own id (S1.6). " +
  "Mind keeps no list of agents (D-049) — `mind worn` reads which identity this machine " +
  "is wearing from the vendors' own files.";

/** Run `git init` in `dir`. Injected so failure is testable. */
export type GitInit = (dir: string) => Promise<{ readonly ok: boolean; readonly detail: string }>;

/** Install the repository guard in `dir`. Injected for the same reason. */
export type GuardInstall = (dir: string) => Promise<InstallOutcome>;

/** The real one: `git init`, quietly, with no commit and no remote. */
export const gitInit: GitInit = async (dir) => {
  const result = await runGuarded(["git", "init", "-q", dir]);
  return result.code === 0
    ? { ok: true, detail: "" }
    : {
        ok: false,
        detail: result.stderr === "" ? `git init exited ${result.code}` : result.stderr,
      };
};

/** The real one: both hooks, pointed at whichever engine is running. */
export const guardInstall: GuardInstall = (dir) => installHooks(dir, engineCommand());

/** Everything `newAgent` needs, with nothing read from ambient state. */
export interface NewAgentRequest {
  /** Where the repository goes. Resolved against the caller's cwd, not ours. */
  readonly dir: string;
  /** Whose identity this is. Never inferred from the directory name (I-3). */
  readonly subject: SubjectId;
  /** The name the soul starts with, which the owner is expected to replace. */
  readonly name: string;
  /**
   * The engine's own root, so it can refuse to write inside itself.
   *
   * `undefined` when the engine is a compiled binary: `import.meta.dir` is
   * then a virtual path inside the executable, and comparing a destination
   * against it is a guard that can never fire. Said out loud rather than
   * papered over, because what keeps a soul out of the engine checkout in that
   * case is **not this guard** — it is the git check below, which refuses any
   * destination inside any repository, the engine's included. An engine
   * unpacked somewhere that is not a git repository has neither.
   */
  readonly engineRoot: string | undefined;
  readonly git?: GitInit;
  readonly guard?: GuardInstall;
}

/** What happened, and whether anything was left on disk. */
export type NewAgentOutcome =
  | {
      readonly ok: true;
      readonly dir: string;
      readonly files: readonly string[];
      /** Absolute paths of the hooks that were written (S0.4). */
      readonly hooks: readonly string[];
    }
  | {
      readonly ok: false;
      /** `refused` wrote nothing; `incomplete` wrote the files but not the repository. */
      readonly kind: "refused" | "incomplete";
      readonly reason: string;
    };

/** Create an agent repository. Writes nothing when it refuses. */
export async function newAgent(request: NewAgentRequest): Promise<NewAgentOutcome> {
  const target = resolve(request.dir);
  const engineRoot = request.engineRoot === undefined ? undefined : resolve(request.engineRoot);

  if (engineRoot !== undefined && (target === engineRoot || target.startsWith(engineRoot + sep))) {
    return {
      ok: false,
      kind: "refused",
      reason:
        `${target} is inside the engine repository (${engineRoot}) — the engine carries no ` +
        `identity data, so that it can be opened to the public one day (D-021)`,
    };
  }

  const enclosing = await enclosingGitRepo(target);
  if (enclosing !== undefined) {
    return {
      ok: false,
      kind: "refused",
      reason:
        `${target} is inside the git repository at ${enclosing} — an agent is its own repository ` +
        `or it is not portable, and a soul committed into someone else's history cannot be ` +
        `withdrawn from it (I-4). Pick a directory outside version control.`,
    };
  }

  try {
    const entries = await readdir(target);
    if (entries.length > 0) {
      return { ok: false, kind: "refused", reason: `${target} is not empty — refusing to write into it` };
    }
  } catch {
    // Does not exist yet, which is the expected case.
  }

  const files = templateFiles(request.subject, request.name);
  await mkdir(target, { recursive: true, mode: DIR_MODE });
  for (const file of files) {
    const path = join(target, file.path);
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    await writeFile(path, file.content, { mode: FILE_MODE });
  }

  const init = await (request.git ?? gitInit)(target);
  if (!init.ok) {
    return {
      ok: false,
      kind: "incomplete",
      reason:
        `the files were written to ${target}, but \`git init\` failed there: ${init.detail}. ` +
        `Run \`git init\` yourself — Mind will not delete what it just wrote.`,
    };
  }

  const guard = await (request.guard ?? guardInstall)(target);
  if (!guard.ok) {
    return {
      ok: false,
      kind: "incomplete",
      reason:
        `the repository was created at ${target}, but its guard was not installed: ${guard.reason}. ` +
        `Nothing scans what you stage there until \`mind guard install ${target}\` succeeds — ` +
        `Mind will not delete what it just wrote, and will not say the guard is on when it is not.`,
    };
  }

  return { ok: true, dir: target, files: files.map((file) => file.path), hooks: guard.written };
}
