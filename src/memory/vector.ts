/**
 * The semantic half of recall — `bge-m3` on the real Ollama, and one Qdrant
 * collection per subject (D-007, D-038).
 *
 * ## Two endpoints, both loopback literals
 *
 * The text of an agent's memory leaves the Mind process twice: to be
 * embedded, and as a payload beside its vector. Both endpoints are held to the
 * rule `asLocal` holds a turn to (`src/exec/local.ts`): a loopback **literal**,
 * never a name. D-038 measured why the embed endpoint is `:11435` and not the
 * `:11434` everything else on this machine uses: that port is a shim that
 * forwards to LiteLLM and replaces a model name it does not know with a
 * different model, silently. A recall built on vectors from a model nobody
 * asked for is wrong in a way no test here would see.
 *
 * ## What this client cannot do, on purpose
 *
 * It has no call that deletes points. D-035 measured Qdrant 1.18.2 keeping the
 * bytes of 96% of a collection's points on disk after they were deleted by
 * filter, so the only removal Mind offers is `dropCollection` in
 * `store-admin.ts` — the whole collection, whose directory Qdrant does remove.
 * `test/memory/store-admin.test.ts` goes red if a per-point delete path appears in
 * any file under `src/memory/`.
 */

import type { SubjectId } from "../types.ts";
import { collectionFor } from "./collection.ts";
import { dropCollection, type Fetch } from "./store-admin.ts";
import { EMBED_DIMENSIONS, EMBED_MODEL, type VectorEndpoints } from "./endpoints.ts";
import type { MemoryChunk } from "./sources.ts";

const realFetch: Fetch = (url, init) => fetch(url, init);

async function json(
  doFetch: Fetch,
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<{ status: number; body: unknown }> {
  const response = await doFetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/**
 * Embed texts, in order.
 *
 * Retried once: a cold `bge-m3` load was measured answering the first request
 * with an empty reply and the second in four seconds (D-038). A vector of the
 * wrong length is an error, not a result — it would be stored and then match
 * nothing, silently.
 */
export async function embed(
  endpoints: VectorEndpoints,
  texts: readonly string[],
  doFetch: Fetch = realFetch,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { status, body } = await json(doFetch, `${endpoints.embedUrl}/api/embed`, {
        method: "POST",
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
        timeoutMs: 120_000,
      });
      if (status !== 200) throw new Error(`embed answered ${status}`);
      const vectors = (body as { embeddings?: unknown }).embeddings;
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error(`embed returned ${Array.isArray(vectors) ? vectors.length : "no"} vector(s) for ${texts.length} text(s)`);
      }
      for (const vector of vectors) {
        if (!Array.isArray(vector) || vector.length !== EMBED_DIMENSIONS) {
          throw new Error(`embed returned a vector of ${Array.isArray(vector) ? vector.length : "no"} dimension(s), not ${EMBED_DIMENSIONS}`);
        }
      }
      return vectors as number[][];
    } catch (cause) {
      last = cause;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Drop and recreate a subject's collection, then fill it.
 *
 * Recreated rather than upserted into: a rebuild must be able to *lose* a
 * piece that was deleted from `memory/`, and the only removal this client has
 * is the whole collection. That is also what makes a rebuild provably equal to
 * its sources rather than to its sources plus history.
 *
 */
export async function replaceCollection(
  endpoints: VectorEndpoints,
  subject: SubjectId,
  chunks: readonly MemoryChunk[],
  doFetch: Fetch = realFetch,
  batch = 32,
): Promise<number> {
  await dropCollection(endpoints.qdrantUrl, subject, doFetch);
  const base = `${endpoints.qdrantUrl}/collections/${collectionFor(subject)}`;
  const created = await json(doFetch, base, {
    method: "PUT",
    body: JSON.stringify({ vectors: { size: EMBED_DIMENSIONS, distance: "Cosine" } }),
  });
  if (created.status !== 200) throw new Error(`creating ${collectionFor(subject)}: Qdrant answered ${created.status}`);

  for (let start = 0; start < chunks.length; start += batch) {
    const slice = chunks.slice(start, start + batch);
    const vectors = await embed(endpoints, slice.map((chunk) => chunk.text), doFetch);
    const upserted = await json(doFetch, `${base}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({
        points: slice.map((chunk, i) => ({
          id: chunk.id,
          vector: vectors[i],
          payload: { path: chunk.path, heading: chunk.heading, ordinal: chunk.ordinal, text: chunk.text },
        })),
      }),
      timeoutMs: 60_000,
    });
    if (upserted.status !== 200) throw new Error(`writing points: Qdrant answered ${upserted.status}`);
  }
  return chunks.length;
}

/** One semantic hit, best first. `score` is cosine similarity: higher is better. */
export interface VectorHit {
  readonly id: string;
  readonly path: string;
  readonly heading: string;
  readonly text: string;
  readonly score: number;
}

/**
 * Search a subject's collection. Absent collection = no hits.
 */
export async function searchVectors(
  endpoints: VectorEndpoints,
  subject: SubjectId,
  query: string,
  limit: number,
  doFetch: Fetch = realFetch,
): Promise<VectorHit[]> {
  const [vector] = await embed(endpoints, [query], doFetch);
  const search = (name: string) =>
    json(doFetch, `${endpoints.qdrantUrl}/collections/${name}/points/search`, {
      method: "POST",
      body: JSON.stringify({ vector, limit, with_payload: true }),
    });
  const { status, body } = await search(collectionFor(subject));
  if (status === 404) return [];
  if (status !== 200) throw new Error(`search: Qdrant answered ${status}`);
  const result = (body as { result?: unknown }).result;
  if (!Array.isArray(result)) return [];
  return result.map((raw) => {
    const hit = raw as { id: unknown; score: unknown; payload?: Record<string, unknown> };
    return {
      id: String(hit.id),
      score: typeof hit.score === "number" ? hit.score : 0,
      path: String(hit.payload?.["path"] ?? ""),
      heading: String(hit.payload?.["heading"] ?? ""),
      text: String(hit.payload?.["text"] ?? ""),
    };
  });
}
