/**
 * S4.1 in-process — cutting, both indexes, and the merge (D-037, D-038).
 *
 * The network is a function here (`Fetch`), so every branch a real server
 * could take — a cold model's empty reply, a vector of the wrong length, a
 * store that refuses — is reachable without one. `test/cli/memory.test.ts`
 * runs the same path through the binary against real sockets.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MEMORY_README } from "../../src/agent/template.ts";
import { collectionFor } from "../../src/memory/collection.ts";
import { buildFts, ftsPath, searchFts } from "../../src/memory/fts.ts";
import { readRagMarker } from "../../src/memory/marker.ts";
import { indexAgent, recall, RRF_K } from "../../src/memory/recall.ts";
import { CHUNK_MAX, chunkId, chunkMarkdown, readMemory } from "../../src/memory/sources.ts";
import type { Fetch } from "../../src/memory/store-admin.ts";
import { DEFAULT_EMBED_URL, EMBED_DIMENSIONS, vectorEndpoints } from "../../src/memory/endpoints.ts";
import { embed, replaceCollection, searchVectors } from "../../src/memory/vector.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("alpha");
const ENDPOINTS = { embedUrl: "http://127.0.0.1:1", qdrantUrl: "http://127.0.0.1:2" };
/** The name of the subject's collection on a store. */
const NAMES = [collectionFor(SUBJECT)];

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function agentWith(files: Record<string, string>): Promise<string> {
  const agent = await mkdtemp(join(tmpdir(), "mind-recall-"));
  scratch.push(agent);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(agent, rel)), { recursive: true });
    await Bun.write(join(agent, rel), text);
  }
  return agent;
}

const vec = (hot: number): number[] => {
  const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
  v[hot] = 1;
  return v;
};

/** A stand-in for both servers, in-process. */
function network(options: { embedFailures?: number; dims?: number; storeStatus?: number } = {}) {
  let failures = options.embedFailures ?? 0;
  const calls: { method: string; url: string; body: unknown }[] = [];
  const points = new Map<string, { vector: number[]; payload: Record<string, unknown> }>();
  const doFetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    if (url.endsWith("/api/embed")) {
      if (failures > 0) {
        failures -= 1;
        throw new Error("empty reply from server");
      }
      const input = (body as { input: string[] }).input;
      return Response.json({
        embeddings: input.map((text) =>
          options.dims !== undefined ? new Array(options.dims).fill(0) : vec(text.includes("deploy") ? 1 : 0),
        ),
      });
    }
    if (options.storeStatus !== undefined) return new Response("", { status: options.storeStatus });
    if (url.endsWith("/points?wait=true")) {
      for (const p of (body as { points: { id: string; vector: number[]; payload: Record<string, unknown> }[] }).points) {
        points.set(p.id, { vector: p.vector, payload: p.payload });
      }
      return Response.json({ result: {} });
    }
    if (url.endsWith("/points/search")) {
      const q = (body as { vector: number[] }).vector;
      const result = [...points.entries()]
        .map(([id, p]) => ({ id, payload: p.payload, score: p.vector.reduce((t, x, i) => t + x * (q[i] ?? 0), 0) }))
        .sort((a, b) => b.score - a.score);
      return Response.json({ result });
    }
    return Response.json({ result: true });
  };
  return { doFetch, calls, points };
}

describe("cutting memory into pieces", () => {
  test("at headings, with the heading kept, and a code fence is not a heading", () => {
    const chunks = chunkMarkdown(
      "memory/a.md",
      "intro\n\n# One\n\nbody one\n\n```sh\n# not a heading\n```\n\n## Two\n\nbody two\n",
    );
    expect(chunks.map((c) => c.heading)).toEqual(["", "One", "Two"]);
    expect(chunks[1]?.text).toContain("# not a heading");
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  test("ids are a function of the address only, and shaped like a UUID Qdrant accepts", () => {
    const id = chunkId("memory/a.md", 3);
    expect(id).toBe(chunkId("memory/a.md", 3));
    expect(id).not.toBe(chunkId("memory/a.md", 4));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("a long section is cut at blank lines, and a long paragraph at the limit", () => {
    const para = "x".repeat(CHUNK_MAX - 10);
    const huge = "y".repeat(CHUNK_MAX * 2 + 5);
    const chunks = chunkMarkdown("m.md", `# H\n\n${para}\n\n${para}\n\n${huge}`);
    expect(chunks.every((c) => c.text.length <= CHUNK_MAX)).toBe(true);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.every((c) => c.heading === "H")).toBe(true);
  });

  test("an empty file is no pieces, and CRLF is read as LF", () => {
    expect(chunkMarkdown("e.md", "")).toEqual([]);
    expect(chunkMarkdown("c.md", "# A\r\nbody\r\n")[0]?.heading).toBe("A");
  });

  test("readMemory walks memory/ in path order, skips non-markdown, and does not follow links", async () => {
    const agent = await agentWith({
      "memory/b.md": "# B\nb",
      "memory/sub/a.md": "# A\na",
      "memory/notes.txt": "not markdown",
      "outside/secret.md": "# S\nsecret",
    });
    await symlink(join(agent, "outside", "secret.md"), join(agent, "memory", "link.md"));
    const read = await readMemory(agent);
    expect(read.files).toEqual(["memory/b.md", "memory/sub/a.md"]);
    expect(read.chunks.map((c) => c.path)).toEqual(["memory/b.md", "memory/sub/a.md"]);
    expect(read.unreadable).toEqual([]);
  });

  test("the untouched template README is not memory; an edited one is", async () => {
    const agent = await agentWith({ "memory/README.md": MEMORY_README });
    expect((await readMemory(agent)).chunks).toEqual([]);
    await Bun.write(join(agent, "memory/README.md"), `${MEMORY_README}\n# Mine\n\nport 30600\n`);
    expect((await readMemory(agent)).files).toEqual(["memory/README.md"]);
  });

  test("no memory/ at all is an empty result, not an error", async () => {
    const agent = await agentWith({});
    expect((await readMemory(agent)).chunks).toEqual([]);
  });
});

describe("the full-text half", () => {
  test("Thai without spaces, a ticket number, and a short word", async () => {
    const agent = await agentWith({});
    const chunks = chunkMarkdown("memory/t.md", "# ราคา\n\nราคาทองวันนี้ขึ้น AIT-52\n\n# Other\n\nnothing here at all\n");
    expect(await buildFts(agent, chunks)).toBe(2);

    expect((await searchFts(agent, "ทองวัน", 5))[0]?.heading).toBe("ราคา");
    expect((await searchFts(agent, "AIT-52", 5)).length).toBe(1);
    // Two characters: under a trigram, so matched by a scan instead of nothing.
    expect((await searchFts(agent, "ทอ", 5)).length).toBe(1);
    // Mixed: the long word narrows, the short one filters.
    expect((await searchFts(agent, "nothing at", 5))[0]?.heading).toBe("Other");
  });

  test("FTS5 syntax typed by a person is text, not an operator", async () => {
    const agent = await agentWith({});
    await buildFts(agent, chunkMarkdown("m.md", '# Q\n\nsay "NEAR" OR not\n'));
    expect((await searchFts(agent, '"NEAR" OR', 5)).length).toBe(1);
    expect(await searchFts(agent, "   ", 5)).toEqual([]);
    expect(await searchFts(agent, "100%_", 5)).toEqual([]);
  });

  test("no file is no hits", async () => {
    const agent = await agentWith({});
    expect(await searchFts(agent, "anything", 5)).toEqual([]);
  });
});

describe("the endpoints", () => {
  test("defaults are the real Ollama and the local Qdrant, both loopback", () => {
    const checked = vectorEndpoints({});
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.endpoints.embedUrl).toBe(DEFAULT_EMBED_URL);
  });

  test("a name, however local it looks, is refused — for either endpoint", () => {
    expect(vectorEndpoints({ MIND_EMBED_URL: "http://localhost:11435" }).ok).toBe(false);
    const q = vectorEndpoints({ MIND_QDRANT_URL: "http://gpu-box:10300/" });
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.reason).toContain("MIND_QDRANT_URL");
  });
});

describe("the vector half", () => {
  test("a cold model's first empty reply is retried once", async () => {
    const net = network({ embedFailures: 1 });
    expect((await embed(ENDPOINTS, ["a"], net.doFetch)).length).toBe(1);
    expect(net.calls.length).toBe(2);
  });

  test("two failures in a row are an error, and so is a vector of the wrong size", async () => {
    await expect(embed(ENDPOINTS, ["a"], network({ embedFailures: 2 }).doFetch)).rejects.toThrow("empty reply");
    await expect(embed(ENDPOINTS, ["a"], network({ dims: 768 }).doFetch)).rejects.toThrow("768");
    expect(await embed(ENDPOINTS, [], network().doFetch)).toEqual([]);
  });

  test("an embed server that answers the wrong count is an error", async () => {
    const short: Fetch = async () => Response.json({ embeddings: [vec(0)] });
    await expect(embed(ENDPOINTS, ["a", "b"], short)).rejects.toThrow("1 vector(s) for 2");
    const odd: Fetch = async () => new Response("no", { status: 500 });
    await expect(embed(ENDPOINTS, ["a"], odd)).rejects.toThrow("500");
  });

  test("replace drops the collection first, then creates it, then writes in batches", async () => {
    const net = network();
    const chunks = chunkMarkdown("m.md", "# A\na\n# B\nb\n# C\nc");
    expect(await replaceCollection(ENDPOINTS, SUBJECT, chunks, net.doFetch, 2)).toBe(3);
    const store = net.calls.filter((c) => !c.url.endsWith("/api/embed"));
    // The collection is dropped, then created under the same name.
    expect(store.map((c) => c.method)).toEqual(["DELETE", "PUT", "PUT", "PUT"]);
    expect(store.slice(0, 2).map((c) => c.url.split("/collections/")[1])).toEqual([...NAMES, collectionFor(SUBJECT)]);
    // Nothing but this subject's name was addressed.
    const mine = new Set<string>(NAMES);
    expect(store.every((c) => mine.has(c.url.split("/collections/")[1]!.split("/")[0]!))).toBe(true);
  });

  test("a store that refuses to create or to write is an error", async () => {
    const chunks = chunkMarkdown("m.md", "# A\na");
    await expect(replaceCollection(ENDPOINTS, SUBJECT, chunks, network({ storeStatus: 500 }).doFetch)).rejects.toThrow(
      `creating ${collectionFor(SUBJECT)}`,
    );
    // The drops (one per name) and the create are answered; the first write of points is refused.
    const writeFails: Fetch = async (url) => {
      if (url.endsWith("/api/embed")) return Response.json({ embeddings: [vec(0)] });
      return new Response("{}", { status: url.endsWith("/points?wait=true") ? 400 : 200 });
    };
    await expect(replaceCollection(ENDPOINTS, SUBJECT, chunks, writeFails)).rejects.toThrow("writing points");
  });

  test("search: an absent collection is no hits; an odd answer is an error; a missing payload is empty text", async () => {
    const absent: Fetch = async (url) =>
      url.endsWith("/api/embed") ? Response.json({ embeddings: [vec(0)] }) : new Response("{}", { status: 404 });
    expect(await searchVectors(ENDPOINTS, SUBJECT, "q", 3, absent)).toEqual([]);

    const broken: Fetch = async (url) =>
      url.endsWith("/api/embed") ? Response.json({ embeddings: [vec(0)] }) : new Response("{}", { status: 502 });
    await expect(searchVectors(ENDPOINTS, SUBJECT, "q", 3, broken)).rejects.toThrow("502");

    const bare: Fetch = async (url) =>
      url.endsWith("/api/embed")
        ? Response.json({ embeddings: [vec(0)] })
        : Response.json({ result: [{ id: 7, score: "x" }] });
    expect(await searchVectors(ENDPOINTS, SUBJECT, "q", 3, bare)).toEqual([
      { id: "7", score: 0, path: "", heading: "", text: "" },
    ]);
    const notList: Fetch = async (url) =>
      url.endsWith("/api/embed") ? Response.json({ embeddings: [vec(0)] }) : Response.json({ result: {} });
    expect(await searchVectors(ENDPOINTS, SUBJECT, "q", 3, notList)).toEqual([]);
  });
});

describe("index and recall", () => {
  const FILES = {
    "memory/ops.md": "# Deploy\n\nrun deploy.sh from the Mac\n\n# Ports\n\ndashboard on 30600\n",
  };

  test("both halves built, the marker written before the collection, and a merged recall", async () => {
    const agent = await agentWith(FILES);
    const markerDir = join(agent, "state-rag");
    const net = network();
    const report = await indexAgent(agent, SUBJECT, ENDPOINTS, {
      markerDir,
      now: () => new Date("2026-09-23T00:00:00Z"),
      network: net.doFetch,
    });
    expect(report).toMatchObject({ files: 1, chunks: 2, fts: 2, vectors: { ok: true, points: 2 } });
    const marker = await readRagMarker(markerDir);
    expect(marker !== null && marker !== "unreadable" && marker.collection).toBe(collectionFor(SUBJECT));
    expect(marker !== null && marker !== "unreadable" && marker.schema).toMatch(/^mind\//);

    const result = await recall(agent, SUBJECT, "deploy", 5, ENDPOINTS, net.doFetch);
    expect(result.fts).toBe("ok");
    expect(result.vector).toBe("ok");
    const top = result.hits[0]!;
    expect(top.heading).toBe("Deploy");
    expect([...top.via].sort()).toEqual(["fts", "vector"]);
    // Found by both, at rank 1 in both: exactly twice the share of one list.
    expect(top.score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  test("no endpoints: full-text only, and the reason is carried to the report", async () => {
    const agent = await agentWith(FILES);
    const report = await indexAgent(agent, SUBJECT, { reason: "MIND_EMBED_URL: not loopback" }, {
      markerDir: join(agent, "m"),
      now: () => new Date(),
    });
    expect(report.vectors).toEqual({ ok: false, reason: "MIND_EMBED_URL: not loopback" });
    expect(await Bun.file(ftsPath(agent)).exists()).toBe(true);
    // Nothing was going to be written, so no marker claims otherwise.
    expect(await readRagMarker(join(agent, "m"))).toBeNull();

    const result = await recall(agent, SUBJECT, "Ports", 5, { reason: "down" });
    expect(result.vector).toEqual({ failed: "down" });
    expect(result.hits[0]?.via).toEqual(["fts"]);
  });

  test("a store that fails mid-index leaves the marker behind, which is the point of writing it first", async () => {
    const agent = await agentWith(FILES);
    const report = await indexAgent(agent, SUBJECT, ENDPOINTS, {
      markerDir: join(agent, "m"),
      now: () => new Date(),
      network: network({ storeStatus: 500 }).doFetch,
    });
    expect(report.vectors.ok).toBe(false);
    expect(await readRagMarker(join(agent, "m"))).not.toBeNull();
  });

  test("a search that fails is reported, and no index at all says absent", async () => {
    const agent = await agentWith(FILES);
    const down: Fetch = async () => {
      throw new Error("refused");
    };
    const result = await recall(agent, SUBJECT, "deploy", 5, ENDPOINTS, down);
    expect(result.fts).toBe("absent");
    expect(result.vector).toEqual({ failed: "refused" });
    expect(result.hits).toEqual([]);
  });
});

/**
 * A stand-in Qdrant with collections by name, for the questions the plain `network()` cannot answer: which name
 * was asked, which was created, which is left (E1). The embed endpoint is the same.
 */
function namedStore(held: Record<string, Map<string, { vector: number[]; payload: Record<string, unknown> }>> = {}) {
  const collections = new Map(Object.entries(held));
  const asked: string[] = [];
  const doFetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (url.endsWith("/api/embed")) {
      return Response.json({ embeddings: (body as { input: string[] }).input.map((text) => vec(text.includes("deploy") ? 1 : 0)) });
    }
    const [name = "", rest = ""] = (url.split("/collections/")[1] ?? "").split(/\/(.*)/s);
    asked.push(`${method} ${name}${rest === "" ? "" : `/${rest}`}`);
    const found = collections.get(name);
    if (method === "DELETE") return Response.json({ result: collections.delete(name) });
    if (method === "PUT" && rest === "") {
      collections.set(name, new Map());
      return Response.json({ result: true });
    }
    if (found === undefined) return new Response("{}", { status: 404 });
    if (method === "GET") return Response.json({ result: { points_count: found.size } });
    if (rest === "points?wait=true") {
      for (const p of (body as { points: { id: string; vector: number[]; payload: Record<string, unknown> }[] }).points) {
        found.set(p.id, { vector: p.vector, payload: p.payload });
      }
      return Response.json({ result: {} });
    }
    const q = (body as { vector: number[] }).vector;
    const result = [...found.entries()]
      .map(([id, p]) => ({ id, payload: p.payload, score: p.vector.reduce((t, x, i) => t + x * (q[i] ?? 0), 0) }))
      .sort((a, b) => b.score - a.score);
    return Response.json({ result });
  };
  return { doFetch, asked, collections };
}

describe("a subject with no collection", () => {
  test("has no vector hits, and says so by finding nothing, not by failing", async () => {
    const none = namedStore({ docs: new Map() });
    expect(await searchVectors(ENDPOINTS, SUBJECT, "deploy", 5, none.doFetch)).toEqual([]);
  });
});
