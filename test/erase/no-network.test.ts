/**
 * I-1 for `src/erase/` — and the exact size of what it proves.
 *
 * **Proven:** no module reachable from `src/erase/` names a network global,
 * imports a network module, or is anything under `src/exec/`. Deleting
 * somebody's data is not an operation that needs a model, and a layer that
 * could reach one is a layer that could send what it read somewhere on the way
 * to deleting it (I-6). The interesting form of that failure is not `fetch`: it
 * is an innocent-looking import of `resolveTargets`, which lives in
 * `src/soul/targets.ts` and pulls in the vendor registry. That is why
 * the CLI entry point in `bin/` resolves the instruction files and hands this layer a list of
 * strings, and why the assertion below is about a whole directory rather than
 * about one call.
 *
 * **Not proven, and deliberately allowed:** the closure *does* contain
 * `src/spawn.ts`, through `src/guard/history.ts`. Erase counts commits with
 * `git rev-list`, which is on `spawnGuarded`'s closed verb allowlist and
 * reaches no remote; `test/guard/no-push.test.ts` runs the real command under a
 * `git` that records its argv and asserts no network verb appears. So the check
 * here is not "nothing can start a process" — that would be false and the test
 * would be written to pass anyway — but "the only way it can is through the one
 * chokepoint, which has its own three layers".
 *
 * **Allowed since D-038, and only in one file:** `src/memory/store-admin.ts`
 * uses `fetch`. The `rag` place's data lives in Qdrant, so a deleter for it has
 * to reach Qdrant — and it does it the way the rule about processes is kept:
 * one chokepoint, which can `GET` or `DELETE` a collection by name on a
 * loopback literal and cannot send a body (`test/memory/store-admin.test.ts`).
 * Nothing the erase layer reads off disk has a way into a request.
 *
 * Both assertions have a control: the same scanners pointed at `src/exec/`,
 * where a socket really does live, and at synthetic source they must catch.
 */

import { describe, expect, test } from "bun:test";
import { join, relative, resolve, sep } from "node:path";
import * as erase from "../../src/erase/index.ts";
import { networkEscapes, processEscapes, reachable, sourceFiles } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const ERASE = join(ROOT, "src", "erase");
const SPAWN_CHOKEPOINT = join("src", "spawn.ts");
const EXEC_DIR = join("src", "exec") + sep;
const SOCKET_CHOKEPOINT = join("src", "memory", "store-admin.ts");

/** The closure, as repo-relative paths. */
async function eraseClosure(): Promise<{ paths: Set<string>; rel: string[] }> {
  const paths = await reachable(await sourceFiles(ERASE));
  return { paths, rel: [...paths].map((path) => relative(ROOT, path)).sort() };
}

describe("the erase layer's import closure", () => {
  test("it contains nothing under src/exec/", async () => {
    const { rel } = await eraseClosure();

    // Guards the gate's own scope: a closure that silently went empty would
    // make every assertion below vacuously true.
    expect(rel.length).toBeGreaterThan(8);
    expect(rel.filter((path) => path.startsWith(EXEC_DIR))).toEqual([]);
  });

  test("the control: the walk is transitive, and names what it went through", async () => {
    const { rel } = await eraseClosure();

    // None of these is imported by `src/erase/index.ts` directly; finding them
    // is evidence the walk did not stop at the barrel.
    expect(rel).toContain(join("src", "observer", "store.ts"));
    expect(rel).toContain(join("src", "ledger", "store.ts"));
    expect(rel).toContain(join("src", "guard", "personal.ts"));
    expect(rel).toContain(join("src", "soul", "block.ts"));
    expect(rel).toContain(join("src", "agent", "repo.ts"));
    expect(rel).toContain(join("src", "state.ts"));

    // And the one that would mean the rule had been broken: `targets.ts` is
    // how the vendor registry gets in, so the instruction files are an
    // argument rather than something this layer resolves.
    expect(rel).not.toContain(join("src", "soul", "targets.ts"));
    expect(rel).not.toContain(join("src", "soul", "index.ts"));
  });

  test("nothing in the closure opens a socket but the one chokepoint", async () => {
    const { paths, rel } = await eraseClosure();

    // The chokepoint is in the closure — otherwise the exemption below would
    // be exempting nothing and the rag place would have no deleter.
    expect(rel).toContain(SOCKET_CHOKEPOINT);
    // And the client that sends text is not.
    expect(rel).not.toContain(join("src", "memory", "vector.ts"));
    expect(rel).not.toContain(join("src", "memory", "recall.ts"));

    const hits: string[] = [];
    for (const path of paths) {
      if (relative(ROOT, path) === SOCKET_CHOKEPOINT) continue;
      const source = await Bun.file(path).text();
      for (const hit of networkEscapes(path, source)) hits.push(`${relative(ROOT, path)}:${hit}`);
    }
    expect(hits).toEqual([]);
  });

  test("the only way it can start a process is the one chokepoint", async () => {
    const { paths, rel } = await eraseClosure();

    // Stated rather than hidden: the chokepoint *is* in the closure, because
    // erase counts commits with `git rev-list` through `historyFacts`.
    expect(rel).toContain(SPAWN_CHOKEPOINT);
    expect(rel).toContain(join("src", "guard", "history.ts"));

    const hits: string[] = [];
    for (const path of paths) {
      const rel2 = relative(ROOT, path);
      if (rel2 === SPAWN_CHOKEPOINT) continue;
      const source = await Bun.file(path).text();
      for (const hit of processEscapes(path, source, false)) hits.push(`${rel2}:${hit}`);
    }
    expect(hits).toEqual([]);
  });

  test("the control: the same scanners find both where they really live", async () => {
    const exec = await reachable([join(ROOT, "src", "exec", "index.ts")]);

    const sockets: string[] = [];
    const spawns: string[] = [];
    for (const path of exec) {
      const source = await Bun.file(path).text();
      const rel = relative(ROOT, path);
      if (networkEscapes(path, source).length > 0) sockets.push(rel);
      if (processEscapes(path, source, false).length > 0) spawns.push(rel);
    }

    expect(sockets).toContain(join("src", "exec", "ollama-exec.ts"));
    expect(spawns).toContain(SPAWN_CHOKEPOINT);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The tripwire: a new export has to be named here
// ---------------------------------------------------------------------------

/**
 * Every runtime export of `src/erase/index.ts`.
 *
 * Listed rather than counted, so that a function added to this layer without a
 * test fails *this* file instead of quietly shrinking what the closure checks
 * are about. The same shape `test/observer/no-network.test.ts` uses for w4.
 */
const EXPORTED: readonly string[] = [
  "CERTIFICATE_SCHEMA",
  "NOT_SEARCHED",
  "PLACES",
  "PLACE_IDS",
  "SEARCHED",
  "SEARCH_LIMITS",
  "WEIGHTS_UNDELETABLE",
  "backupTree",
  "certificate",
  "commitBlocks",
  "commitErase",
  "derivedTree",
  "dataMap",
  "formatCertificate",
  "implementedPlaces",
  "linesMatching",
  "manifestTargets",
  "nameMatches",
  "notBuiltPlaces",
  "personFile",
  "placeOf",
  "placeTally",
  "planBlocks",
  "planErase",
  "searchFiles",
  "searchScopes",
  "searchTree",
  "soulTree",
  "statementFor",
  "subjectTrees",
  "undeletableFor",
  "verifyErase",
  "whatWasFound",
  "whatWasRemoved",
];

describe("the barrel", () => {
  test("every runtime export is named here, and every name still exists", () => {
    expect(Object.keys(erase).sort()).toEqual([...EXPORTED].sort());
    for (const name of EXPORTED) expect(Object.keys(erase)).toContain(name);
  });
});
