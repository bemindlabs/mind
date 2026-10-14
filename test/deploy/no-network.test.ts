/**
 * S13.1 — `deploy plan` can start nothing and send nothing, and here is the whole closure.
 *
 * The plan's output is a list of `ssh`, `gcloud` and `aws` command lines, and
 * the one thing that must never happen while it is being made is that one of
 * them runs. `test/deploy/plan.test.ts` runs a plan with spawn and fetch taken
 * away; that proves the paths a test reaches. This proves the rest: nothing
 * reachable from `src/deploy/` by import names a process API, a network
 * module or a network global — **not even the spawn chokepoint**, which the
 * erase layer is allowed (it counts commits with `git rev-list`) and this one
 * is not.
 *
 * It holds because the data map lives in `src/erase/map.ts` and the place-id
 * type in `src/erase/place-id.ts`: `places.ts` reaches `src/guard/history.ts`
 * (the chokepoint) and `src/memory/store-admin.ts` (`fetch`), and the walk
 * follows `import type` too, so naming a place through it would have put both
 * here. The controls check those two are really outside, and that the same
 * scanners do see a socket and a spawn where they live.
 */

import { describe, expect, test } from "bun:test";
import { join, relative, resolve, sep } from "node:path";
import { networkEscapes, processEscapes, reachable, sourceFiles } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const DEPLOY = join(ROOT, "src", "deploy");

async function closure(): Promise<{ paths: Set<string>; rel: string[] }> {
  const paths = await reachable(await sourceFiles(DEPLOY));
  return { paths, rel: [...paths].map((path) => relative(ROOT, path)).sort() };
}

describe("the deploy layer's import closure", () => {
  test("it reaches the data map, the scanner and the resolvers — and walks past the directory", async () => {
    const { rel } = await closure();
    expect(rel.length).toBeGreaterThan(15);
    for (const file of [
      join("src", "deploy", "plan.ts"),
      join("src", "deploy", "target.ts"),
      join("src", "deploy", "commands.ts"),
      join("src", "deploy", "render.ts"),
      join("src", "erase", "map.ts"),
      join("src", "erase", "place-id.ts"),
      join("src", "guard", "scan.ts"),
      join("src", "guard", "personal.ts"),
      join("src", "ledger", "store.ts"),
      join("src", "state.ts"),
    ]) {
      expect(rel, file).toContain(file);
    }
  });

  test("and not erase's planner, its registry, git history or the vector store", async () => {
    const { rel } = await closure();
    for (const file of [
      join("src", "erase", "plan.ts"),
      join("src", "erase", "places.ts"),
      join("src", "erase", "index.ts"),
      join("src", "guard", "history.ts"),
      join("src", "memory", "store-admin.ts"),
      join("src", "spawn.ts"),
    ]) {
      expect(rel, file).not.toContain(file);
    }
    expect(rel.filter((path) => path.startsWith(join("src", "exec") + sep))).toEqual([]);
  });

  test("nothing in it names a process, a socket, or a way around either", async () => {
    const { paths } = await closure();
    const hits: string[] = [];
    for (const path of paths) {
      const source = await Bun.file(path).text();
      for (const hit of networkEscapes(path, source)) hits.push(`${relative(ROOT, path)}:${hit}`);
      for (const hit of processEscapes(path, source, false)) hits.push(`${relative(ROOT, path)}:${hit}`);
    }
    expect(hits).toEqual([]);
  });

  test("the control: the same scanners find both where they really live", async () => {
    const exec = await reachable([join(ROOT, "src", "exec", "index.ts")]);
    const sockets: string[] = [];
    const spawns: string[] = [];
    for (const path of exec) {
      const source = await Bun.file(path).text();
      if (networkEscapes(path, source).length > 0) sockets.push(relative(ROOT, path));
      if (processEscapes(path, source, false).length > 0) spawns.push(relative(ROOT, path));
    }
    expect(sockets).toContain(join("src", "exec", "ollama-exec.ts"));
    expect(spawns).toContain(join("src", "spawn.ts"));

    // And the one this layer was kept away from on purpose: through `places.ts`.
    const places = await reachable([join(ROOT, "src", "erase", "places.ts")]);
    const through = [...places].map((path) => relative(ROOT, path));
    expect(through).toContain(join("src", "spawn.ts"));
    expect(through).toContain(join("src", "memory", "store-admin.ts"));
  }, 30_000);
});
