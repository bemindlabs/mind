/**
 * S22.8 (D-197) — `scope = machine`: a fleet bot that may work anywhere on this machine, except the red lines.
 *
 * The owner's ruling of 2026-10-27 is that fleet agents start from the machine's root so they can do anything on
 * this server. Two things stand in the way, and this file is how both are met without giving either up.
 *
 * - **A fence cannot be punched.** Landlock is an allow-list: a grant on `/` is a grant on everything under it, and
 *   no rule can carve `~/.secrets` back out. So "everything except" cannot be said as `/`. It is said as the list of
 *   directories that remain once every red line has been walked around: each directory that holds a red line is
 *   opened and its children granted one by one, and each that holds none is granted whole.
 * - **D-163 refuses a working directory that contains `~/.secrets`.** It was right while the fence held only the
 *   working directory. Under this scope the red lines are held by the kernel instead, so the "contains" half of
 *   D-163 is not asked (the "lies inside" half still is) and the turn is refused outright where the kernel cannot
 *   fence it. See {@link machineVerdict}.
 *
 * ## The red lines (fixed at every level)
 *
 * Mind's own data and state, `~/.secrets`, `~/.ssh`, `~/.claude`, `~/.gnupg`, `~/.config/gh`, `~/.docker`
 * (`fixedPlaces` in `workdir.ts`), the agent's own repository, and whatever the owner adds with `deny`. Nothing
 * under them is granted for reading or writing, so a vendor's shell cannot open them and cannot send what it cannot
 * read. Never granted either: `/proc`, `/sys` and `/dev` (the fence already reads the first two and needs the third
 * as it is), `/run` and `/var/run` (agent sockets), `/boot`; and the system directories the fence already reads.
 *
 * ## What this does not do
 *
 * It does not let a turn list a directory that is only *above* a red line: `ls ~` and `ls /` are refused, because a
 * listing right on a directory covers everything under it, red lines included. A bot reaches things by path.
 *
 * The deletion tripwire catches some broad commands on PATH, but /bin/rm, python shutil.rmtree, perl, a script
 * the model writes, and other spellings of find deletion bypass it. It does not
 * cover what is created after the turn starts: a new directory beside a granted one is not granted. And it is
 * Linux-only, because Landlock is: where the kernel cannot fence, this scope is refused, never run unfenced.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInside, realish } from "./workdir.ts";

export type Scope = "worktree" | "machine";
export const SCOPES: readonly Scope[] = ["worktree", "machine"];

/** More grants than this is a sign the walk is going somewhere nobody meant; the scope is refused. */
export const MAX_GRANTS = 2048;

/** Paths that are never granted whole: volatile, or reachable only as something the fence handles itself. */
const NEVER = ["/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/lost+found"];

export interface MachineInput {
  /** The red lines: absolute paths, each a directory or a file. */
  readonly redLines: readonly string[];
  /** Directories the fence already reads (`SYSTEM_READ_DIRS`): not granted again for writing. */
  readonly system: readonly string[];
  /** Entries of a directory, names only; `undefined` when it cannot be listed. */
  readonly listDir: (path: string) => readonly string[] | undefined;
  /** Whether a real path is a directory. */
  readonly isDir: (path: string) => boolean;
  /** The real path, symlinks followed the way the kernel does. */
  readonly real: (path: string) => string;
  /** Where the walk starts: `/` for the machine. A test starts it in a directory of its own. */
  readonly root?: string;
}

export interface MachinePlan {
  /** Directories to grant for reading and writing. */
  readonly grants: readonly string[];
  /** What was left out and why, one short line each: files at the top, and anything that could not be listed. */
  readonly notes: readonly string[];
}

export type MachineVerdict =
  | { readonly ok: true; readonly plan: MachinePlan }
  | { readonly ok: false; readonly reason: string };

/**
 * The directories a `machine` turn may use, or the reason it may not be started.
 *
 * Pure but for what `listDir`, `isDir` and `real` read. The walk only goes deeper along a red line, so its depth is
 * the depth of the deepest red line and it lists a handful of directories, not the disk.
 */
export function machinePlan(input: MachineInput): MachineVerdict {
  const red = input.redLines.map((path) => input.real(path));
  const never = [...NEVER, ...input.system].map((path) => input.real(path));
  const grants: string[] = [];
  const notes: string[] = [];

  const insideRed = (path: string): boolean => red.some((line) => isInside(path, line));
  const holdsRed = (path: string): boolean => red.some((line) => isInside(line, path));

  let failure: string | undefined;
  const walk = (path: string): void => {
    if (failure !== undefined) return;
    const real = input.real(path);
    if (never.some((place) => isInside(real, place)) || insideRed(real)) return;
    if (!input.isDir(real)) {
      notes.push(`${real} is not a directory and is not granted`);
      return;
    }
    if (!holdsRed(real)) {
      grants.push(real);
      if (grants.length > MAX_GRANTS) failure = `more than ${MAX_GRANTS} directories would be granted`;
      return;
    }
    const entries = input.listDir(real);
    if (entries === undefined) {
      // A directory that holds a red line and cannot be listed must not be granted whole: that is the one error
      // that would hand over what the line was drawn to keep.
      failure = `${real} holds a red line and cannot be listed, so the rest of it cannot be granted safely`;
      return;
    }
    for (const entry of [...entries].sort()) walk(join(real, entry));
  };

  walk(input.root ?? "/");
  if (failure !== undefined) return { ok: false, reason: failure };
  // A red line that is inside no granted directory would mean the walk left something unsaid; asserted, not assumed.
  for (const line of red) {
    if (grants.some((grant) => isInside(line, grant))) {
      return { ok: false, reason: `the plan would grant a directory that holds ${line}` };
    }
  }
  return { ok: true, plan: { grants, notes } };
}

/** {@link machinePlan} over the real filesystem. */
export function machineVerdict(redLines: readonly string[], system: readonly string[], root?: string): MachineVerdict {
  return machinePlan({
    redLines,
    system,
    ...(root === undefined ? {} : { root }),
    listDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return undefined;
      }
    },
    isDir: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    real: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return realish(path);
      }
    },
  });
}

/** The one line printed before a `machine` turn: what it may do, and what it may not. */
export function machineNotice(plan: MachinePlan, redLines: readonly string[]): string {
  return (
    `mind: scope machine — this turn may read and write ${plan.grants.length} directories across this machine, ` +
    `as you, except ${redLines.length} red line${redLines.length === 1 ? "" : "s"} it cannot open at all ` +
    `(${redLines.join(", ")}). A PATH tripwire catches some broad deletes, but can be bypassed.`
  );
}
