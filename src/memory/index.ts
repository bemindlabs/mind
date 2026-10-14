/**
 * Memory — what the agent knows, per subject, and can be made to forget.
 *
 * Filled by E3/E4. Two constraints are already fixed and constrain the
 * design more than any feature will:
 *
 * - I-2: git is the truth; `.mind/` is derived and must rebuild from it.
 *   Anything that cannot be rebuilt does not belong in `.mind/`.
 * - I-4: an owner can withdraw their data, and Mind must not claim a
 *   deletion it cannot perform. What git history already holds is named
 *   plainly rather than reported as erased.
 *
 * S1.6 (w7) put one thing here ahead of the rest of E4: the **address** a
 * subject's recall would live at (`collection.ts`). It is a naming rule and
 * nothing else — no client, no connection, no filesystem — because I-3 in a
 * vector store is exactly the question of which collection a query names, and
 * a store that arrives already holding that answer cannot arrive holding a
 * shared one. `test/erase/places.test.ts` keeps this directory that way: while
 * `rag` is registered `not-built`, nothing under `src/memory/` may reach a
 * store, a socket, a process or a file.
 */
export * from "./attach.ts";
export * from "./collection.ts";
export * from "./endpoints.ts";
export * from "./forget.ts";
export * from "./fts.ts";
export * from "./ingest.ts";
export * from "./marker.ts";
export * from "./recall.ts";
export * from "./sources.ts";
export * from "./store-admin.ts";
export * from "./vector.ts";
