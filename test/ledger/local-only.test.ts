/**
 * AC4 — no network egress on the ledger path, proven two ways.
 *
 * Running the code and watching for a socket would only show that nothing
 * happened to open one this time. So the first and stronger check is
 * structural, in the same shape as `test/agent/no-vendor.test.ts`: walk the
 * import closure of `src/ledger/` and look for anything that could reach the
 * network or spawn a process. Not "it did not" — **it cannot, because nothing
 * in the graph knows how.**
 *
 * A scanner that finds nothing is worthless without a control, so the same
 * scanner is pointed at `src/exec/`, where it must find `fetch` in the ollama
 * backend and `Bun.spawn` in the CLI backend. If the control ever comes back
 * clean, the scan above is meaningless and this file says so.
 *
 * The second check is behavioural and covers what a source scan cannot: an
 * indirect call through something that does not look like a network primitive.
 * `globalThis.fetch` is replaced with a function that throws, and a full
 * append/query/forget cycle is run against a temporary state directory.
 *
 * This matters more here than anywhere else in Mind. The ledger is the one
 * place conversation is written down, which makes it the most valuable thing
 * on disk to anything that wanted to send data out (I-6).
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  append,
  commitForget,
  LEDGER_VERSION,
  planForget,
  query,
  removeLedgerDir,
  type LedgerEntry,
  type LedgerEnv,
} from "../../src/ledger/index.ts";
import { subjectId } from "../../src/types.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const LEDGER = join(ROOT, "src", "ledger");
const EXEC = join(ROOT, "src", "exec");

/**
 * Anything that could get a byte off this machine, or start something that
 * could. `child_process` and `Bun.spawn` are in the list because a subprocess
 * is a network stack with extra steps.
 */
const EGRESS = [
  /\bfetch\s*\(/,
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/,
  /\bEventSource\b/,
  /"node:https?"/,
  /"node:net"/,
  /"node:tls"/,
  /"node:dgram"/,
  /"node:child_process"/,
  /\bBun\.(connect|listen|serve|spawn|spawnSync|udpSocket)\b/,
  /\bnavigator\.sendBeacon\b/,
];

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

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
    for (const specifier of importsOf(source)) queue.push(resolve(dirname(path), specifier));
  }
  return seen;
}

/** Every `file:pattern` hit in a closure. */
async function egressHits(closure: Iterable<string>): Promise<string[]> {
  const hits: string[] = [];
  for (const path of closure) {
    const source = await Bun.file(path).text();
    for (const pattern of EGRESS) {
      if (pattern.test(source)) hits.push(`${relative(ROOT, path)}: ${pattern}`);
    }
  }
  return hits;
}

describe("the ledger path is local-only (AC4)", () => {
  test("nothing reachable from src/ledger/ can open a socket or spawn a process", async () => {
    const closure = await reachable(await sourceFiles(LEDGER));
    expect(await egressHits(closure)).toEqual([]);
  }, 30_000);

  test("the scanner would notice — src/exec/ is full of exactly what it looks for", async () => {
    const hits = await egressHits(await sourceFiles(EXEC));
    expect(hits.some((hit) => hit.includes("ollama-exec.ts"))).toBe(true);
    expect(hits.some((hit) => hit.includes("cli-exec.ts"))).toBe(true);
  }, 30_000);

  test("the closure really is transitive — it reaches beyond src/ledger/", async () => {
    // Without this, a walker that silently returned only its entry points
    // would make the first test pass by examining almost nothing.
    const closure = [...(await reachable(await sourceFiles(LEDGER)))];
    expect(closure.some((path) => !path.startsWith(LEDGER))).toBe(true);
    expect(closure.some((path) => path.endsWith(join("src", "state.ts")))).toBe(true);
  }, 30_000);

  test("a full append/query/forget cycle runs with fetch replaced by a trap", async () => {
    const root = await mkdtemp(join(tmpdir(), "mind-local-only-"));
    const env: LedgerEnv = {
      home: root,
      env: { XDG_STATE_HOME: join(root, "state") },
      now: () => new Date("2026-09-21T10:00:00.000Z"),
    };
    const subject = subjectId("example");
    const entry: LedgerEntry = {
      v: LEDGER_VERSION,
      kind: "turn",
      id: "line-1",
      turn: "turn-1",
      at: "2026-09-21T10:00:00.000Z",
      subject,
      backend: "ollama",
      model: null,
      content: "full",
      prompt: "canary-7f3a",
      prompt_bytes: 11,
      text: "hi",
      text_bytes: 2,
      confidence: "confirmed",
      exit: null,
      duration_ms: 1,
      cost: null,
      identity: "system",
      soul_sha: null,
    };

    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("the ledger path called fetch");
    }) as unknown as typeof fetch;

    try {
      await append(env, entry);
      expect((await query(env, subject)).entries.length).toBe(1);
      await commitForget(await planForget(env, subject, { kind: "all" }));
      await removeLedgerDir(env, subject);
    } finally {
      globalThis.fetch = realFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});
