/**
 * Guard — the fence around an agent's repository (S0.4).
 *
 * Four things, and it is worth naming what each one can actually promise:
 *
 * - **No path in Mind pushes** (AC2). Enforced at `src/spawn.ts`, which every
 *   subprocess in the engine goes through, and checked three ways in
 *   `test/guard/no-push.test.ts`. The claim is about Mind's code, not about
 *   the machine — `GUARD_LIMITS` says so wherever the guard speaks.
 * - **A pre-commit scan of the index** (AC3), which blocks on what it
 *   recognises and prints what it cannot see on every run, including the ones
 *   that pass.
 * - **Personal data outside the repository** (AC4) — a filesystem location,
 *   checked, rather than a line in `.gitignore`.
 * - **What git keeps anyway** (AC5, half) — printed before the first commit
 *   rather than when somebody asks to delete something. `mind erase` is S7.2.
 *
 * Nothing here reaches `src/exec/`: the guard runs with no model and no vendor
 * CLI in the picture (I-1), and nothing in its import closure can open a socket.
 *
 * Re-exports only, like the other barrels, so the coverage exemption on this
 * file says something a reader can check.
 */

export * from "./history.ts";
export * from "./hooks.ts";
export * from "./personal.ts";
export * from "./scan.ts";
export * from "./staged.ts";
