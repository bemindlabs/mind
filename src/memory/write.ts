/**
 * One memory file, created or replaced by hand (D-081) — what the web page's
 * Memories editor saves through `mind memory write`.
 *
 * The same gates as `memory ingest`, for one file instead of a folder: the
 * path must be a `.md` file really under `memory/` (no `..`, no link on the
 * way), the text must pass the credential scan (D-051), and the caller checks
 * the S7.3 basis before this is reached. After the write the indexes are
 * rebuilt the way `memory index` does — the vector collection dropped whole and
 * written again (D-035), because an edit that takes text out must take it out
 * of the store too, and dropping the collection is the only removal that does.
 */

import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { scanStaged, type Finding } from "../guard/scan.ts";
import { MEMORY_DIR } from "./sources.ts";

export const MAX_MEMORY_BYTES = 256 * 1024;

/** Why this cannot be a memory path, or `undefined`. */
export function memoryPathProblem(path: string): string | undefined {
  if (!/^memory\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/.test(path)) {
    return `a memory is memory/<folders>/<name>.md, with letters, digits, ".", "_" and "-" — not ${JSON.stringify(path)}`;
  }
  if (path.split("/").some((part) => part === ".." || part === "." || part.startsWith("."))) return `${JSON.stringify(path)} has a hidden or relative part`;
  return undefined;
}

export interface WritePlan {
  readonly path: string;
  readonly kind: "new" | "replace" | "same";
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly blocked: readonly Finding[];
  readonly refusal: string | undefined;
}

/** What writing this text at this path would do, and whether it may. Reads, never writes. */
export async function planWrite(agentDir: string, path: string, text: string): Promise<WritePlan> {
  const bytes = new TextEncoder().encode(text);
  const base = { path, bytesAfter: bytes.length, linesAdded: 0, linesRemoved: 0, blocked: [] as readonly Finding[] };
  const problem = memoryPathProblem(path);
  if (problem !== undefined) return { ...base, kind: "new", bytesBefore: 0, refusal: problem };
  if (bytes.length > MAX_MEMORY_BYTES) return { ...base, kind: "new", bytesBefore: 0, refusal: `over ${MAX_MEMORY_BYTES / 1024} KB — split it into more than one note` };
  if (text.trim() === "") return { ...base, kind: "new", bytesBefore: 0, refusal: "an empty memory — to remove one, forget it" };

  // Every existing step on the way must be a real directory inside memory/, and the file itself not a link.
  const root = join(agentDir, MEMORY_DIR);
  const absolute = join(agentDir, ...path.split("/"));
  let before: string | undefined;
  try {
    const info = await lstat(absolute);
    if (!info.isFile()) return { ...base, kind: "new", bytesBefore: 0, refusal: `${path} is not a plain file` };
    before = await readFile(absolute, "utf8");
  } catch {
    before = undefined;
  }
  let probe = dirname(absolute);
  while (probe.length >= root.length) {
    try {
      const info = await lstat(probe);
      if (info.isSymbolicLink()) return { ...base, kind: "new", bytesBefore: 0, refusal: `${path} goes through a link` };
      const real = await realpath(probe);
      const realRoot = await realpath(root).catch(() => root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) return { ...base, kind: "new", bytesBefore: 0, refusal: `${path} is not under memory/` };
      break;
    } catch {
      probe = dirname(probe);
    }
  }

  const blocked = scanStaged([{ path, bytes }]);
  const beforeLines = new Set((before ?? "").split("\n"));
  const afterLines = new Set(text.split("\n"));
  return {
    path,
    kind: before === undefined ? "new" : before === text ? "same" : "replace",
    bytesBefore: before === undefined ? 0 : new TextEncoder().encode(before).length,
    bytesAfter: bytes.length,
    linesAdded: [...afterLines].filter((l) => !beforeLines.has(l)).length,
    linesRemoved: before === undefined ? 0 : [...beforeLines].filter((l) => !afterLines.has(l)).length,
    blocked,
    refusal: blocked.length > 0 ? "it holds something that looks like a credential — take it out first" : undefined,
  };
}

/** Write the file the plan allowed. Takes the plan's path and the same text. */
export async function commitWrite(agentDir: string, plan: WritePlan, text: string): Promise<void> {
  if (plan.refusal !== undefined) throw new Error(plan.refusal);
  const absolute = join(agentDir, ...plan.path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text);
}

export interface MovePlan {
  readonly from: string;
  readonly to: string;
  /** The write the move makes; its refusal (a name taken, a credential) is the move's. */
  readonly write: WritePlan;
  readonly refusal: string | undefined;
}

/** Moving a memory is writing it at the new path and removing the old one — planned together (D-090). */
export async function planMove(agentDir: string, from: string, to: string): Promise<MovePlan> {
  const problem = memoryPathProblem(from) ?? (from === to ? "it is already there" : undefined);
  let text = "";
  let found = problem === undefined;
  if (found) {
    try {
      const info = await lstat(join(agentDir, ...from.split("/")));
      found = info.isFile();
      if (found) text = await readFile(join(agentDir, ...from.split("/")), "utf8");
    } catch {
      found = false;
    }
  }
  const write = await planWrite(agentDir, to, found ? text : "x");
  const refusal =
    problem ?? (!found ? `${from} is not a memory file` : write.refusal ?? (write.kind !== "new" ? `${to} is already a memory — pick another name` : undefined));
  return { from, to, write, refusal };
}

/** Write the new file, then remove the old one. The caller rebuilds the indexes. */
export async function commitMove(agentDir: string, plan: MovePlan): Promise<void> {
  if (plan.refusal !== undefined) throw new Error(plan.refusal);
  const text = await readFile(join(agentDir, ...plan.from.split("/")), "utf8");
  await commitWrite(agentDir, plan.write, text);
  await unlink(join(agentDir, ...plan.from.split("/")));
}
