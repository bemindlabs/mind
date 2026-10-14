/**
 * Where a turn that may write must not be started (D-163, Q4-D2, second rule).
 *
 * A turn with write at 2 or above, whose working directory is, contains, or lies inside the agent's own repo,
 * the Mind state roots, `~/.secrets` or `~/.ssh`, is **refused** — not downgraded. The owner chose refuse.
 * Applies to fenced backends too: the fence makes the working directory writable, so it is the directory
 * itself that must be somewhere the agent may write.
 *
 * Compared on resolved real paths (symlinks and `..` followed by the filesystem, not by string), as a path
 * relation and never as a string prefix: `/a/repo-two` is not inside `/a/repo`.
 */

import { lstatSync, readlinkSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataRoot, stateRoot } from "../state.ts";

const MAX_LINKS = 40;

/**
 * The real path of `path`, walked one component at a time the way the kernel does it: a symlink is followed
 * to its target, and a `..` after a link goes to the **link target's** parent. `path.resolve`, `join`,
 * `fs.realpathSync` and even `.native` (in Bun) all collapse `..` by string first, which answers a different
 * question — `link/..` is the link's own folder, not the folder the link points into.
 *
 * A relative path is made absolute first (callers pass an absolute one). Components that do not exist (yet) are kept as written, after the real part. `.` is dropped.
 */
export function realish(path: string): string {
  let pending = (isAbsolute(path) ? path : resolve(path)).split(sep).filter((part) => part !== "" && part !== ".");
  let current: string = sep;
  let links = 0;
  while (pending.length > 0) {
    const [part, ...rest] = pending as [string, ...string[]];
    pending = rest;
    if (part === ".." ) {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let target: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
    } catch {
      // Does not exist: the rest is taken as written (a `..` still goes up lexically — nothing there to follow).
      current = next;
      continue;
    }
    if (target === undefined) {
      current = next;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return resolve(path);
    if (isAbsolute(target)) current = sep;
    pending = [...target.split(sep).filter((piece) => piece !== "" && piece !== "."), ...pending];
  }
  return current;
}

/** True when `inner` is `outer` or lies under it. Both must already be real, absolute paths. */
export function isInside(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface ProtectedPlace {
  readonly label: string;
  readonly path: string;
}

/** The places a writing turn may not have as, around, or inside its working directory. */
export function protectedPlaces(
  agentDir: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): readonly ProtectedPlace[] {
  return [{ label: "the agent's repo", path: agentDir }, ...fixedPlaces(home, env)];
}

/** The places that are protected whatever the agent: state, credentials, and the tools' own logins. */
export function fixedPlaces(home: string, env: Readonly<Record<string, string | undefined>>): readonly ProtectedPlace[] {
  return [
    { label: "Mind's data root", path: dataRoot(home, env) },
    { label: "Mind's state root", path: stateRoot(home, env) },
    { label: "~/.secrets", path: join(home, ".secrets") },
    { label: "~/.ssh", path: join(home, ".ssh") },
    { label: "~/.claude", path: join(home, ".claude") },
    { label: "~/.gnupg", path: join(home, ".gnupg") },
    { label: "~/.config/gh", path: join(home, ".config", "gh") },
    { label: "~/.docker", path: join(home, ".docker") },
  ];
}

/** Units that start `mind turn` for the owner (the web page, the trigger timers). */
const UNIT_NAME = /^(?:mind-web-|mind-triggers-).+\.service$/;

/**
 * Read-only: the user units that start turns whose `WorkingDirectory` a loosened turn would be refused in
 * (D-163), each as one short line. Nothing is edited. An agent directory is any absolute directory named on
 * the unit's `ExecStart` line, plus `agent` when `mind doctor --agent` named one.
 */
export async function unitWorkdirHints(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  agent?: string,
): Promise<readonly string[]> {
  const dir = join(home, ".config", "systemd", "user");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => UNIT_NAME.test(name)).sort();
  } catch {
    return [];
  }
  const expand = (value: string): string => value.replace(/^~(?=\/|$)/, home).replaceAll("%h", home);
  const hints: string[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = await readFile(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const where = /^WorkingDirectory=(.*)$/m.exec(text)?.[1]?.trim().replace(/^[-!+]+/, "");
    if (where === undefined || where === "") continue;
    const workdir = expand(where);
    const exec = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? "";
    const agents = new Set<string>(agent === undefined ? [] : [agent]);
    for (const token of exec.split(/\s+/).map((part) => expand(part.replace(/^["']|["']$/g, "")))) {
      if (!isAbsolute(token)) continue;
      try {
        if (statSync(token).isDirectory()) agents.add(token);
      } catch {
        // not a directory
      }
    }
    const places = [...[...agents].map((path) => ({ label: "the agent's repo", path })), ...fixedPlaces(home, env)];
    const refused = isAbsolute(workdir) ? workdirRefusal(workdir, places) : undefined;
    if (refused === undefined) continue;
    const what = /(lies inside|contains) ([^(]*)\(/.exec(refused);
    hints.push(
      `${name}: WorkingDirectory=${workdir} ${what === null ? "is protected" : `${what[1]} ${what[2]!.trim()}`}, so a turn that may write ` +
        `is refused there (D-163). Point WorkingDirectory at a scratch directory.`,
    );
  }
  return hints;
}

/**
 * Why a turn with this working directory may not write, or `undefined` when it may.
 *
 * Pure but for the filesystem reads that resolve links; `cwd`, the places and the home arrive as arguments.
 */
export function workdirRefusal(
  cwd: string,
  places: readonly ProtectedPlace[],
): string | undefined {
  const here = realish(cwd);
  for (const place of places) {
    const there = realish(place.path);
    if (isInside(here, there)) {
      return refusal(cwd, here, `lies inside ${place.label} (${there})`);
    }
    if (isInside(there, here)) {
      return refusal(cwd, here, `contains ${place.label} (${there})`);
    }
  }
  return undefined;
}

function refusal(cwd: string, real: string, what: string): string {
  const shown = cwd === real ? real : `${cwd} (really ${real})`;
  return (
    `the working directory ${shown} ${what}, and this turn may write (write 2 or above). Refused, nothing was ` +
    `sent: name another workdir — start the turn from a scratch directory that is not the agent's repo, ` +
    `Mind's state, ~/.secrets or ~/.ssh and does not contain them. (D-163)`
  );
}
