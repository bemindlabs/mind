/**
 * A PATH tripwire, not a wall. /bin/rm, python shutil.rmtree, perl, a script the model writes,
 * and other spellings of find deletion bypass it. A process can also change PATH or the shims.
 */
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isInside, realish } from "./workdir.ts";

export const MAX_DELETE_PATHS = 20; // Enough for ordinary cleanup; expanded broad globs stop at 21.
export const MAX_DELETE_FILES = 200; // Bound both accidental recursive cleanup and the inspection's work.
export const DELETE_COMMANDS = ["rm", "unlink", "shred", "rmdir", "find", "rsync"] as const;
/** The options of each command whose next argument is a value and not a target. Absent means none (rm, unlink, rmdir). */
const VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  rsync: ["--exclude", "--include", "--filter", "--exclude-from", "--include-from", "-e", "-f", "--rsh"],
  shred: ["-n", "-s", "--iterations", "--size", "--random-source"],
};
export interface DeleteContext {
  readonly home: string;
  readonly redLines: readonly string[];
  readonly cwd: string;
  readonly real: (path: string) => string;
  /** Return true if the tree exceeds the cap, or cannot be safely inspected. */
  readonly tooMany: (path: string) => boolean;
}

/** Pure decision: filesystem operations are supplied by the caller. */
export function deleteRefusal(command: string, args: readonly string[], context: DeleteContext): string | undefined {
  const find = command === "find";
  const rsync = command === "rsync";
  const deletingFind = find && (args.includes("-delete") || args.some((arg, i) =>
    (arg === "-exec" || arg === "-execdir") && basename(args[i + 1] ?? "") === "rm"));
  if ((find && !deletingFind) || (rsync && !args.some((arg) => arg.startsWith("--delete")))) return undefined;
  const targets: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === "--") { options = false; continue; }
    if (find && options && (arg.startsWith("-") || arg === "!" || arg === "(")) break;
    if (options && arg.startsWith("-")) {
      // Options whose next argument is a value, not a target — per command. `rm -f` and `rm -n` take no value, and
      // skipping the word after them would let `rm -r -f /` through unchecked.
      if (VALUE_OPTIONS[command]?.includes(arg)) i++;
      continue;
    }
    targets.push(arg);
  }
  if (find && targets.length === 0) targets.push(".");
  if (targets.length > MAX_DELETE_PATHS) return `more than ${MAX_DELETE_PATHS} paths`;
  const home = context.real(context.home);
  const red = context.redLines.map(context.real);
  const recursive = (command === "rm" && args.some((arg) => arg === "--recursive" || /^-[^-]*[rR]/.test(arg))) || (find && args.includes("-delete"));
  for (const target of targets) {
    const path = context.real(resolve(context.cwd, target));
    if (path === "/" || isInside(home, path) || red.some((line) => isInside(path, line))) return `protected target ${target}`;
    if (recursive && context.tooMany(path)) return `recursive target ${target} has more than ${MAX_DELETE_FILES} files or cannot be inspected`;
  }
  return undefined;
}

/** Walk incrementally, stop at 201 entries, and do not follow symlinks. */
export function treeTooLarge(path: string): boolean {
  let count = 0;
  const walk = (at: string): boolean => {
    let stat;
    try { stat = lstatSync(at); } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
    if (!stat.isDirectory()) return ++count > MAX_DELETE_FILES;
    let dir;
    try {
      dir = opendirSync(at);
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        // Count directories too: a tree of empty directories must also be bounded.
        if (++count > MAX_DELETE_FILES || (entry.isDirectory() && walk(join(at, entry.name)))) return true;
      }
      return false;
    } catch { return true; } finally { try { dir?.closeSync(); } catch { /* already closed */ } }
  };
  return walk(path);
}

/** `cwd` is the shell's working directory, handed in by `bin/` (D-021: nothing in `src/` reads the machine for itself). */
export function runDeleteCheck(argv: readonly string[], cwd: string): number {
  try {
    const [raw, command, ...args] = argv;
    const config = JSON.parse(raw ?? "") as { home: string; redLines: string[] };
    if (!command || !isAbsolute(config.home) || !Array.isArray(config.redLines)) throw new Error("invalid tripwire configuration");
    const real = (path: string) => { try { return realpathSync(path); } catch { return realish(path); } };
    const reason = deleteRefusal(command, args, { ...config, cwd, real, tooMany: treeTooLarge });
    if (reason !== undefined) { console.error(`mind deletion tripwire: ${reason}; stop and ask the person before deleting.`); return 97; }
    return 0;
  } catch { console.error("mind deletion tripwire: could not check the deletion; stop and ask the person."); return 97; }
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Install shell shims which check via the engine and then exec the original PATH program. */
export async function installDeleteTripwire(config: { home: string; redLines: readonly string[] }, path: string, entry: readonly string[], scratch: string): Promise<string> {
  const dir = await mkdtemp(join(scratch, "mind-delete-tripwire-"));
  try {
    for (const command of DELETE_COMMANDS) {
      const real = Bun.which(command, { PATH: path });
      if (real === null) continue;
      const check = [...entry, "__delete-check", JSON.stringify(config), command].map(quote).join(" ");
      const file = join(dir, command);
      await writeFile(file, `#!/bin/sh\n${check} "$@" || exit $?\nexec ${quote(real)} "$@"\n`);
      await chmod(file, 0o755);
    }
    return dir;
  } catch (cause) { await rm(dir, { recursive: true, force: true }); throw cause; }
}
