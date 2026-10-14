/**
 * Two kinds of thing in memory/ (D-090): what the agent remembers of the person — notes, decisions, what
 * happened — and knowledge — documents, manuals, pages brought in to be looked things up in. The kind is
 * the path: everything under `memory/knowledge/` is knowledge, everything else is memory. A path is what
 * git shows, what `ls` shows, and what nobody can misread; a front-matter flag would be all three less.
 */

export const KNOWLEDGE_DIR = "memory/knowledge";

export type MemoryKind = "memory" | "knowledge";

/** What a search may look in. */
export const SCOPES = ["all", "memory", "knowledge"] as const;
export type Scope = (typeof SCOPES)[number];

export function memoryKind(path: string): MemoryKind {
  return path.startsWith(`${KNOWLEDGE_DIR}/`) ? "knowledge" : "memory";
}

export function inScope(path: string, scope: Scope): boolean {
  return scope === "all" || memoryKind(path) === scope;
}

/** Where a file goes when it changes kind: into knowledge/ keeping its name, or out of it to notes/. */
export function movedPath(path: string, to: MemoryKind): string {
  const name = path.split("/").pop()!;
  if (to === "knowledge") return memoryKind(path) === "knowledge" ? path : `${KNOWLEDGE_DIR}/${name}`;
  return memoryKind(path) === "memory" ? path : `memory/notes/${name}`;
}
