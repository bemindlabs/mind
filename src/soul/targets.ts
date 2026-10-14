/**
 * Where an identity has to land, per backend, on this machine.
 *
 * The registry knows which files each vendor reads; this file turns that into
 * a concrete list of places, resolved against a home and an environment that
 * are both arguments. Nothing here reads `process.env` or `homedir()` on its
 * own — a test that resolved the real home would be a test that plans a write
 * into the operator's live `CLAUDE.md`.
 *
 * Two facts the caller has to be told rather than shielded from:
 *
 * - **Not every backend takes a file.** `ollama` has no instruction file at
 *   any scope; its only channel is the system field of each request. So it is
 *   a target of a different *kind*, not a target that failed. Reporting it as
 *   "nothing to do" would read as a gap, and reporting it as a written file
 *   would be a lie. I-1 means the local backend is a first-class citizen here,
 *   including when the commercial CLIs are not installed at all.
 * - **One file can serve several vendors.** `grok` reads Anthropic's
 *   `CLAUDE.md` as a documented compatibility feature. Writing it once and
 *   naming both readers is the truth; writing it twice would be a bug, and
 *   naming one reader would hide where the identity actually went.
 */

import { dirname, join } from "node:path";
import { realpath } from "node:fs/promises";
import type { IdentityStrength } from "../exec/backend.ts";
import { expandPath, vendor, VENDORS, type PathContext, type VendorSpec } from "../exec/registry.ts";

/** A file on disk that a vendor reads for user-level instructions. */
/** A file a vendor reads besides the one Mind writes for it. */
export interface AlsoRead {
  readonly path: string;
  readonly by: string;
}

export interface FileTarget {
  readonly kind: "file";
  readonly backend: string;
  readonly display: string;
  /** Absolute path, symlinks resolved. */
  readonly path: string;
  /** The registry spec, unexpanded, so a report can show why this path. */
  readonly declaredAs: string;
  readonly strength: IdentityStrength;
  /** Other backends that read this same file. Informational. */
  readonly alsoReadBy: readonly string[];
  /**
   * Other files the vendor reads, which Mind does not write (kimi's home AGENTS.md), each with the backend
   * that reads it — kept through a merge, so a shared target still carries every reader's extra files.
   */
  readonly alsoReads: readonly AlsoRead[];
  /** False when the vendor's binary is not on PATH. */
  readonly reachable: boolean;
  /** Set when `path` differs from where the vendor says to look. */
  readonly symlinkedFrom?: string;
}

/** A backend whose only identity channel is a field on each request. */
export interface FieldTarget {
  readonly kind: "system-field";
  readonly backend: string;
  readonly display: string;
  readonly strength: IdentityStrength;
}

export type Target = FileTarget | FieldTarget;

/** Everything target resolution is allowed to know about this machine. */
export interface TargetContext extends PathContext {
  /** Resolves a binary name on PATH. Injected so a test can empty it. */
  readonly which: (binary: string) => Promise<boolean>;
}

/** The default `which`: PATH lookup, no subprocess, no network. */
export function whichOnPath(binary: string): Promise<boolean> {
  return Promise.resolve(Bun.which(binary) !== null);
}

/** Backends `soul apply` knows how to reach. Anything else is a usage error. */
export function isKnownBackend(id: string): boolean {
  return id === "ollama" || VENDORS.some((v) => v.id === id);
}

/**
 * Resolve a path as far as the filesystem allows.
 *
 * A file that does not exist yet still has a parent that might be a symlink,
 * and writing through an unresolved parent is how two "different" targets turn
 * out to be one file. Resolving what exists and appending the rest is the most
 * that can be known before the write.
 */
async function resolveReal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Not there yet.
  }
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Every vendor that reads `path`, by id. */
async function readersOf(path: string, context: TargetContext): Promise<string[]> {
  const readers: string[] = [];
  for (const spec of VENDORS) {
    for (const file of spec.identity.instructionFiles) {
      if ((await resolveReal(expandPath(file, context))) === path) {
        readers.push(spec.id);
        break;
      }
    }
  }
  return readers;
}

async function alsoReadsOf(spec: VendorSpec, files: readonly string[], target: string, context: TargetContext): Promise<AlsoRead[]> {
  const out: AlsoRead[] = [];
  for (const file of files) {
    const path = await resolveReal(expandPath(file, context));
    if (path !== target && !out.some((known) => known.path === path)) out.push({ path, by: spec.id });
  }
  return out;
}

async function fileTargetFor(spec: VendorSpec, context: TargetContext): Promise<FileTarget> {
  const [declaredAs, ...rest] = spec.identity.instructionFiles;
  const wanted = expandPath(declaredAs!, context);
  const path = await resolveReal(wanted);
  const readers = await readersOf(path, context);

  return {
    kind: "file",
    backend: spec.id,
    display: spec.display,
    path,
    declaredAs: declaredAs!,
    strength: spec.identity.strength,
    alsoReadBy: readers.filter((id) => id !== spec.id),
    // Resolved like the target itself: a link here (kimi's home AGENTS.md pointing into dotfiles, say) is the file
    // it points to — what `worn` reads and `erase` strips — and one that lands on the target is not a second file.
    alsoReads: await alsoReadsOf(spec, rest, path, context),
    reachable: await context.which(spec.binary),
    ...(path === wanted ? {} : { symlinkedFrom: wanted }),
  };
}

/**
 * Turn backend ids into the places an identity has to be written.
 *
 * Targets that resolve to the same file are merged, keeping the first backend
 * that asked for it and crediting the rest under `alsoReadBy`. Order follows
 * the ids given, so a report reads in the order the operator typed.
 */
export async function resolveTargets(
  backendIds: readonly string[],
  context: TargetContext,
): Promise<readonly Target[]> {
  const targets: Target[] = [];
  const byPath = new Map<string, number>();

  for (const id of backendIds) {
    if (id === "ollama") {
      targets.push({
        kind: "system-field",
        backend: "ollama",
        display: "Ollama",
        // A field on the request is a real system prompt, which is stronger
        // than what either file-based vendor here can offer.
        strength: "system",
      });
      continue;
    }

    const target = await fileTargetFor(vendor(id), context);
    const existing = byPath.get(target.path);
    if (existing !== undefined) {
      const first = targets[existing] as FileTarget;
      targets[existing] = {
        ...first,
        alsoReadBy: [...new Set([...first.alsoReadBy, target.backend])],
        // Merged, not dropped: copilot and kimi share ./AGENTS.md, and only kimi also reads a home file.
        alsoReads: [...first.alsoReads, ...target.alsoReads.filter((extra) => !first.alsoReads.some((known) => known.path === extra.path))],
      };
      continue;
    }
    byPath.set(target.path, targets.length);
    targets.push(target);
  }

  // A file one vendor also reads may be another's target (kimi's home AGENTS.md linked to ~/.claude/CLAUDE.md):
  // it is read and stripped once, as that target.
  return targets.map((t) => (t.kind === "file" ? { ...t, alsoReads: t.alsoReads.filter((extra) => !byPath.has(extra.path)) } : t));
}
