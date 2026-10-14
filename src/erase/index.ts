/**
 * Erase — the eighth directory under `src/`, and the one that only composes.
 *
 * D-002 named five (`soul`, `memory`, `observer`, `decide`, `exec`); ADR 0002
 * §4 added `agent` as the container the mind is stored in and `ledger` as the
 * record of what the mind did. This is the eighth and it is neither: it is the
 * operation that runs **across** all of them for one subject, which is why it
 * cannot live inside any one of them. Putting `erase` in `src/soul/` would have
 * given the soul layer a reason to import the ledger and the observer.
 *
 * ## The import rule this directory carries
 *
 * Nothing under `src/erase/` may reach `src/exec/`. Erasing somebody's data is
 * not an operation that needs a model, and a directory that could reach one is
 * a directory that could send what it read somewhere on its way to deleting it
 * (I-6). The one thing it does reach is `src/spawn.ts`, and only through
 * `src/guard/history.ts`, which counts commits with `git rev-list` — a local
 * verb on the allowlist. `test/erase/no-network.test.ts` walks the closure and
 * asserts exactly that, with a control that points the same scanner at
 * `src/exec/` and requires it to find a socket there.
 *
 * A consequence worth stating: the vendor instruction files to visit are
 * **passed in** by the caller rather than resolved here, because
 * `resolveTargets` lives in `src/soul/targets.ts` and imports the vendor
 * registry, which is under `src/exec/`. `bin/commands/erase.ts` resolves them and hands
 * over a list of paths; this layer unions that with every path in a backup
 * manifest, which is how a CLI uninstalled since still gets its block removed.
 *
 * Re-exports only, like the other barrels, so the coverage gate's exemption on
 * this file says something a reader can check.
 */

export * from "./places.ts";
export * from "./map.ts";
export * from "./search.ts";
export * from "./soul.ts";
export * from "./plan.ts";
export * from "./certificate.ts";
