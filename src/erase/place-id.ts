/**
 * The five place ids S7.2 AC1 names — the type alone, in a file of its own.
 *
 * It lived in `places.ts`, and `places.ts` imports `GIT_UNDELETABLE` from
 * `src/guard/history.ts` (which reaches the spawn chokepoint) and
 * `RAG_UNDELETABLE` from `src/memory/store-admin.ts` (which uses `fetch`).
 * The import-closure checks follow `import type` as well as value imports, so
 * the data map (`map.ts`) naming its places through `places.ts` would have put
 * a subprocess and a socket into the closure of everything that reads the map
 * — including `src/deploy/`, whose whole claim is that it starts nothing and
 * sends nothing (S13.1). One type, one file, and the closures stay what they say.
 *
 * `places.ts` re-exports it, so every existing import keeps working and the
 * registry there is still closed by `satisfies Record<PlaceId, Place>`.
 */

/** The five places AC1 names. Closed: a sixth id does not type-check. */
export type PlaceId = "soul" | "observer" | "rag" | "ledger" | "lora";

/**
 * Every id, in the order AC1 lists them — beside the type it enumerates, so the
 * two are read together. `places.ts` re-exports it.
 */
export const PLACE_IDS: readonly PlaceId[] = ["soul", "observer", "rag", "ledger", "lora"];
