/**
 * Ledger — what happened, kept where it can be deleted.
 *
 * The seventh directory under `src/`, where D-002 named five and ADR 0002 §4
 * added a sixth. It is not part of an agent's mind and not the container that
 * mind is stored in: it is the record of what the mind did, and it lives
 * outside both git and `.mind/` because it can be derived from nothing and
 * must be withdrawable by the owner (ADR 0002 §3).
 *
 * It is a directory rather than `src/exec/ledger.ts` because `turn` is only
 * its first writer — S5.2 records proposals here and S8.2/S9.1 record every
 * message in and out, and none of those are execution. The other half of the
 * reason is testability: AC4 ("no network egress on this path") is checked by
 * walking an import closure, and a closure needs a boundary to start from.
 *
 * Re-exports only. Every line below is `export *` and nothing else, so the
 * coverage gate's exemption for this file says something checkable.
 */

export * from "./entry.ts";
export * from "./store.ts";
export * from "./lock.ts";
export * from "./recording.ts";
