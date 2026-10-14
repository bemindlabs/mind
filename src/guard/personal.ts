/**
 * Where data flagged `personal` lives: outside the repository, and checked.
 *
 * S0.4 AC4 is a claim about a *location*, and D-014 explains why it could not
 * have been a `.gitignore` line instead. Three ordinary things defeat an ignore
 * rule: `git clean -fdx` deletes ignored files, so "ignored" is not "kept";
 * `cp -r agent/ elsewhere/` carries them along with no git involved at all; and
 * one edit to `.gitignore` commits them, after which git remembers what it was
 * asked to forget. A different filesystem tree survives all three.
 *
 * Two things are enforced here and neither is a convention:
 *
 * - **The directory is per subject, and the subject is an argument.** Never
 *   inferred from the agent's directory name (I-3). A directory name is a hint;
 *   an identity is a claim, and letting the first become the second is how one
 *   identity's data ends up under another's name.
 * - **The resolved path must not be inside any git repository.** `XDG_DATA_HOME`
 *   is a variable, a variable can point anywhere, and `~/work/notes` being a git
 *   checkout is not unusual. {@link personalDir} refuses rather than writing
 *   there, using the same walk `mind new` and `soul import` already refuse by.
 *
 * What is *not* here is the flag itself. `personal` has no shape in any type
 * yet — that is S3.5 (w2). w1 enforces the place, and the pre-commit scan
 * refuses anything staged under a `personal/` directory so that the place
 * cannot be quietly moved back inside the repository.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { enclosingGitRepo } from "../agent/repo.ts";
import { dataRoot, STATE_DIR_MODE } from "../state.ts";
import type { SubjectId } from "../types.ts";

/** The machine facts this resolver is allowed to see — all of them arguments. */
export interface PersonalEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Where a subject's personal data goes, or why it may not go there. */
export type PersonalDir =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly path: string; readonly reason: string };

/**
 * `$XDG_DATA_HOME/mind/<subject>/personal/` — the address, and nothing asked of it.
 *
 * Pure, so the data map (`src/erase/map.ts`) can name it for a machine that is
 * not this one: `mind deploy plan` evaluates every resolver with the
 * remote's roots, and walking *this* filesystem for a `.git` above a path that
 * only exists there would answer a question about the wrong machine.
 * {@link personalDir} is the half that checks.
 */
export function personalPath(env: PersonalEnv, subject: SubjectId): string {
  return join(dataRoot(env.home, env.env), subject, "personal");
}

/**
 * `$XDG_DATA_HOME/mind/<subject>/personal/`, if that is outside git.
 *
 * Resolves and checks; writes nothing. {@link ensurePersonalDir} is the half
 * that creates, so that a caller which only wants to print the path — `guard
 * status`, `doctor` later — cannot create one as a side effect of asking.
 */
export async function personalDir(env: PersonalEnv, subject: SubjectId): Promise<PersonalDir> {
  const path = personalPath(env, subject);

  const repo = await enclosingGitRepo(path);
  if (repo !== undefined) {
    return {
      ok: false,
      path,
      reason:
        `${path} is inside the git repository at ${repo}. Data flagged personal must not be in ` +
        `version control at all (D-014, AC4) — not ignored, not untracked, not there. Point ` +
        `XDG_DATA_HOME somewhere outside a checkout.`,
    };
  }

  return { ok: true, path };
}

/**
 * The same directory, created 0700.
 *
 * The mode is the one the state root already uses: what lands here is the most
 * private thing Mind holds, and on a shared machine a default umask would
 * make it world-readable.
 */
export async function ensurePersonalDir(
  env: PersonalEnv,
  subject: SubjectId,
): Promise<PersonalDir> {
  const resolved = await personalDir(env, subject);
  if (!resolved.ok) return resolved;
  await mkdir(resolved.path, { recursive: true, mode: STATE_DIR_MODE });
  return resolved;
}
