/**
 * Observer — turning what actually happened into memory worth keeping.
 *
 * S3.5 (w2) built the gate before the data exists: the one address raw capture
 * may use, a count that can be taken and re-taken, a purge that proves itself
 * by recounting, and the limits of all three. The capture that fills it is
 * S3.1/S3.2 (w4), reshaped by D-024 from mining transcripts into recording at
 * the moment something happens.
 *
 * The boundary this directory draws is the reason it is a directory: S3.5 AC2
 * is checked by walking the import closure that starts here, and a closure
 * needs somewhere to start. Nothing under `src/observer/` may reach
 * `src/spawn.ts` or `src/exec/`, so the observer cannot open a socket and
 * cannot start a process that would.
 *
 * Re-exports only. Every line below is `export *` and nothing else, so the
 * coverage gate's exemption for this file says something checkable — the file
 * moved from "placeholder" to "barrel" in the same commit that gave it
 * something to re-export.
 */

export * from "./store.ts";
export * from "./record.ts";
export * from "./origin.ts";
export * from "./consent.ts";
export * from "./capture-store.ts";
export * from "./reader.ts";
export * from "./seed.ts";
export * from "./actions.ts";
export * from "./audit.ts";
export * from "./fleet.ts";
export * from "./adapters/vocabulary.ts";
export * from "./adapters/claude-hook.ts";
export * from "./adapters/claude-transcript.ts";
export * from "./adapters/grok-session.ts";
export * from "./adapters/turn.ts";
