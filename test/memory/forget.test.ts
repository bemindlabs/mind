/**
 * S4.4 — forgetting is removing the source, dropping the collection whole,
 * rebuilding, and looking again (D-041). Each AC has a case here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectionFor } from "../../src/memory/collection.ts";
import { EMBED_DIMENSIONS } from "../../src/memory/endpoints.ts";
import { commitForget, formatForgetPlan, planForget } from "../../src/memory/forget.ts";
import { buildFts, searchFts } from "../../src/memory/fts.ts";
import { writeRagMarker } from "../../src/memory/marker.ts";
import { readMemory } from "../../src/memory/sources.ts";
import type { Fetch } from "../../src/memory/store-admin.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("alpha");
const ENDPOINTS = { embedUrl: "http://127.0.0.1:1", qdrantUrl: "http://127.0.0.1:2" };
const NONE = { reason: "no endpoints in this test" };

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

async function agent(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mind-forget-"));
  scratch.push(d);
  const files: Record<string, string> = {
    "memory/infra.md": "# Ports\n\ndashboard on 30600\n",
    "memory/client.md": "# Client\n\nThe Jiancha invoice goes out monthly.\n\n# Other\n\nnothing\n",
    "memory/imported/owner/jiancha.md": "# Billing\n\njiancha billing is manual\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(d, rel)), { recursive: true });
    await Bun.write(join(d, rel), text);
  }
  await buildFts(d, (await readMemory(d)).chunks);
  return d;
}

/**
 * A stand-in for Ollama and Qdrant that remembers what it holds, by collection name. `initial` points sit under
 * `held` (the current name unless a test says it is the one an earlier release made); `points()` is the current one.
 */
function store(initial: number | null, held: string = collectionFor(SUBJECT)) {
  const collections = new Map<string, number>(initial === null ? [] : [[held, initial]]);
  const asked: string[] = [];
  const nameOf = (url: string): string => new URL(url).pathname.split("/")[2] ?? "";
  const network: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    asked.push(`${method} ${new URL(url).pathname}`);
    if (url.endsWith("/api/embed")) {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      return Response.json({ embeddings: input.map(() => new Array(EMBED_DIMENSIONS).fill(0)) });
    }
    if (url.endsWith("/points?wait=true")) {
      const name = nameOf(url);
      collections.set(name, (collections.get(name) ?? 0) + (JSON.parse(String(init?.body)) as { points: unknown[] }).points.length);
      return Response.json({ result: {} });
    }
    if (method === "GET") {
      const points = collections.get(nameOf(url));
      return points === undefined ? new Response("{}", { status: 404 }) : Response.json({ result: { points_count: points } });
    }
    if (method === "DELETE") {
      collections.delete(nameOf(url));
      return Response.json({ result: true });
    }
    if (method === "PUT") {
      collections.set(nameOf(url), 0);
      return Response.json({ result: true });
    }
    return new Response("", { status: 405 });
  };
  return { network, asked, collections, points: () => collections.get(collectionFor(SUBJECT)) ?? null };
}

const markerDir = (a: string) => join(a, "rag-marker");

describe("planning", () => {
  test("AC1: --match names whole files and lines, case-insensitively, and prints no text", async () => {
    const a = await agent();
    const plan = await planForget({
      agentDir: a, subject: SUBJECT, target: { kind: "match", text: "JIANCHA" },
      markerDir: markerDir(a), endpoints: NONE,
    });
    expect(plan.files.map((f) => `${f.path}:${f.lines.join(",")}`)).toEqual([
      "memory/client.md:3",
      "memory/imported/owner/jiancha.md:3",
    ]);
    const printed = formatForgetPlan(plan).join("\n");
    expect(printed).not.toContain("invoice");
    // AC2: an imported file says ingest can bring it back.
    expect(printed).toContain("memory ingest` brings it back");
  });

  test("AC1: --file must be under memory/ and must exist", async () => {
    const a = await agent();
    const plan = await planForget({
      agentDir: a, subject: SUBJECT,
      target: { kind: "files", files: ["./memory/infra.md", "soul/role.md", "memory/../x.md", "memory/nope.md"] },
      markerDir: markerDir(a), endpoints: NONE,
    });
    expect(plan.files.map((f) => f.path)).toEqual(["memory/infra.md"]);
    expect(plan.refusals.length).toBe(3);
  });

  test("a needle under three characters is refused", async () => {
    const a = await agent();
    const plan = await planForget({
      agentDir: a, subject: SUBJECT, target: { kind: "match", text: "on" }, markerDir: markerDir(a), endpoints: NONE,
    });
    expect(plan.refusals[0]).toContain("three characters");
  });

  test("AC3: vectors written and the store down — refused, nothing removed", async () => {
    const a = await agent();
    await writeRagMarker(markerDir(a), SUBJECT, "http://127.0.0.1:2", new Date());
    const down: Fetch = async () => {
      throw new Error("refused");
    };
    const plan = await planForget({
      agentDir: a, subject: SUBJECT, target: { kind: "match", text: "jiancha" },
      markerDir: markerDir(a), endpoints: ENDPOINTS, network: down,
    });
    expect(plan.refusals.join(" ")).toContain("would not be forgetting");
    await expect(commitForget(plan, ENDPOINTS, down)).rejects.toThrow("refused plan");
    expect(await Bun.file(join(a, "memory/client.md")).exists()).toBe(true);
  });

  test("an unreadable marker refuses too", async () => {
    const a = await agent();
    await mkdir(markerDir(a), { recursive: true });
    await Bun.write(join(markerDir(a), "collection.json"), "{");
    const plan = await planForget({
      agentDir: a, subject: SUBJECT, target: { kind: "match", text: "jiancha" }, markerDir: markerDir(a), endpoints: NONE,
    });
    expect(plan.refusals.join(" ")).toContain("cannot be read");
  });
});

describe("forgetting", () => {
  test("AC3+AC4: files go, the collection is dropped whole and rebuilt, and the second look is clean", async () => {
    const a = await agent();
    await writeRagMarker(markerDir(a), SUBJECT, ENDPOINTS.qdrantUrl, new Date());
    const s = store(9);
    const plan = await planForget({
      agentDir: a, subject: SUBJECT, target: { kind: "match", text: "jiancha" },
      markerDir: markerDir(a), endpoints: ENDPOINTS, network: s.network,
    });
    expect(formatForgetPlan(plan).join("\n")).toContain("dropped whole");

    const result = await commitForget(plan, ENDPOINTS, s.network);

    expect(result.removed).toEqual(["memory/client.md", "memory/imported/owner/jiancha.md"]);
    expect(result.dropped).toBe(true);
    expect(result.check).toEqual({
      filesStillMatching: [],
      ftsStillMatching: 0,
      pointsAfter: 1,
      piecesAfter: 1,
      passed: true,
    });
    expect(await searchFts(a, "jiancha", 10)).toEqual([]);
    // AC5: the store was never asked to delete a point.
    expect(s.asked.filter((line) => line.includes("points/delete"))).toEqual([]);
    // Two drops — forget's own, then the rebuild's, which always starts from
    // nothing — and both are the whole collection.
    const deletes = s.asked.filter((line) => line.startsWith("DELETE"));
    const whole = [collectionFor(SUBJECT)].map((name) => `DELETE /collections/${name}`);
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((line) => whole.includes(line))).toBe(true);
    expect(whole.every((line) => deletes.includes(line))).toBe(true);
    expect([...s.collections.keys()]).toEqual([collectionFor(SUBJECT)]);
  });

  test("AC3: embed down — the collection still goes, and recall waits for the next index", async () => {
    const a = await agent();
    await writeRagMarker(markerDir(a), SUBJECT, ENDPOINTS.qdrantUrl, new Date());
    const s = store(9);
    const plan = await planForget({
      agentDir: a, subject: SUBJECT, target: { kind: "files", files: ["memory/infra.md"] },
      markerDir: markerDir(a), endpoints: ENDPOINTS, network: s.network,
    });
    const result = await commitForget(plan, { reason: "embed is down" }, s.network);
    expect(result.dropped).toBe(true);
    expect(result.vectors).toEqual({ ok: false, reason: "embed is down" });
    expect(s.points()).toBeNull();
    expect(result.check.passed).toBe(true);
  });

  test("no store anywhere: files and full-text only, and that passes", async () => {
    const a = await agent();
    const plan = await planForget({
      agentDir: a, subject: SUBJECT, target: { kind: "files", files: ["memory/infra.md"] },
      markerDir: markerDir(a), endpoints: NONE,
    });
    expect(formatForgetPlan(plan).join("\n")).toContain("no store to ask");
    const result = await commitForget(plan, NONE);
    expect(result.dropped).toBeNull();
    expect(result.check.passed).toBe(true);
    expect(await Bun.file(join(a, "memory/infra.md")).exists()).toBe(false);
  });

  test("AC4: a rebuild that lands the wrong number of points fails the second look", async () => {
    const a = await agent();
    await writeRagMarker(markerDir(a), SUBJECT, ENDPOINTS.qdrantUrl, new Date());
    const s = store(9);
    const lying: Fetch = async (url, init) => {
      const r = await s.network(url, init);
      if ((init?.method ?? "GET") === "GET" && !url.endsWith("/api/embed") && s.points() !== null) {
        return Response.json({ result: { points_count: 99 } });
      }
      return r;
    };
    const plan = await planForget({
      agentDir: a, subject: SUBJECT, target: { kind: "files", files: ["memory/infra.md"] },
      markerDir: markerDir(a), endpoints: ENDPOINTS, network: lying,
    });
    const result = await commitForget(plan, ENDPOINTS, lying);
    expect(result.check.passed).toBe(false);
  });
});
