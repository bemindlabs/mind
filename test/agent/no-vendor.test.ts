/**
 * I-1, for `new` and `rebuild`: no model, no vendor CLI, not even reachable.
 *
 * The obvious test — empty `PATH`, run the command, see it work — does not
 * prove anything on this class of machine. A short `PATH` is not the absence of
 * a vendor CLI when one is installed in a system directory, and a subprocess
 * that inherits an environment can find things the test did not intend to give
 * it. What can be proven instead is stronger and cheaper: **there is no code
 * path from `src/agent/` to `src/exec/` at all.** Not "it did not call one this
 * time" — it cannot, because the module graph does not reach it.
 *
 * The check walks the graph transitively on purpose. `src/agent/*` imports from
 * `src/soul/`, and `src/soul/index.ts` re-exports `verify.ts`, which does reach
 * `src/exec/`. So the rule the agent layer actually lives by is "import the soul
 * modules you need, never the barrel" — and a test that only looked one level
 * deep would have missed the day somebody reached for the barrel instead.
 *
 * The last test covers the one subprocess this layer causes. It used to pin the
 * set of commands spawned under `src/agent/` by matching the text
 * `Bun.spawn(["…"`, and S0.4 retired that check for being exactly the kind of
 * gate this project is about: it could only see a spawn whose first argument
 * was a literal array, so it was blind to `Bun.spawn(argv)` in `cli-exec.ts`.
 * Since S0.4 there is one chokepoint, `src/spawn.ts`, and the property worth
 * asserting here is stronger and simpler — **nothing under `src/agent/` holds a
 * spawn primitive at all.** What it may do is go through the chokepoint, whose
 * argv policy is checked in `test/guard/no-push.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const AGENT = join(ROOT, "src", "agent");
const EXEC = join(ROOT, "src", "exec");

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** Relative import specifiers in a file, as written. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s+"(\.[^"]+)"/g)].map((match) => match[1]!);
}

/** Every file reachable from `entries` by following relative imports. */
async function reachable(entries: readonly string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const source = await Bun.file(path).text();
    for (const specifier of importsOf(source)) {
      queue.push(resolve(dirname(path), specifier));
    }
  }
  return seen;
}

describe("the agent layer stands on its own (I-1)", () => {
  test("nothing under src/agent/ can reach src/exec/, at any depth", async () => {
    const closure = await reachable(await sourceFiles(AGENT));
    const vendorward = [...closure]
      .filter((path) => path.startsWith(EXEC))
      .map((path) => relative(ROOT, path));

    expect(vendorward).toEqual([]);
  }, 30_000);

  test("the check would notice — src/exec/ does reach itself", async () => {
    // Without this, a bug in the walker would make the test above pass by
    // finding nothing at all.
    const closure = await reachable([join(EXEC, "index.ts")]);
    expect([...closure].some((path) => path.startsWith(EXEC))).toBe(true);
    expect(closure.size).toBeGreaterThan(1);
  }, 30_000);

  test("the layer holds no spawn primitive — it goes through the one chokepoint", async () => {
    const primitives = [/\bBun\.spawn(?:Sync)?\b/, /\bBun\.\$/, /"node:child_process"/];
    const hits: string[] = [];
    for (const path of await sourceFiles(AGENT)) {
      const source = await Bun.file(path).text();
      for (const pattern of primitives) {
        if (pattern.test(source)) hits.push(`${relative(ROOT, path)}: ${pattern}`);
      }
    }
    expect(hits).toEqual([]);

    // It does reach the chokepoint, which is the other half of the claim: a
    // layer that spawned nothing because it did nothing would pass the check
    // above and prove nothing.
    const closure = await reachable(await sourceFiles(AGENT));
    expect([...closure].some((path) => path === join(ROOT, "src", "spawn.ts"))).toBe(true);
  }, 30_000);
});
