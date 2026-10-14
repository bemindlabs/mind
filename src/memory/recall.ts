/**
 * Build an agent's recall, and ask it something (S4.1, D-037).
 *
 * Two indexes over one source. The full-text file is local and always built;
 * the vector collection needs two servers and may not be (S4.1 AC4, I-1):
 * {@link indexAgent} reports which halves it built rather than failing the
 * whole run, and {@link recall} searches whichever halves answer.
 *
 * Results are merged by reciprocal rank fusion — each hit scores
 * `1 / (RRF_K + rank)` in every list it appears in, and the sums are sorted.
 * RRF needs no calibration between bm25 (lower is better, unbounded) and
 * cosine (higher is better, in [-1, 1]); it reads only positions.
 */

import { inScope, type Scope } from "./kinds.ts";
import type { SubjectId } from "../types.ts";
import { buildFts, ftsPath, searchFts } from "./fts.ts";
import { writeRagMarker } from "./marker.ts";
import { readMemory } from "./sources.ts";
import type { VectorEndpoints } from "./endpoints.ts";
import type { Fetch } from "./store-admin.ts";
import { replaceCollection, searchVectors } from "./vector.ts";

/** The constant from the RRF paper; large enough that rank 1 does not dominate. */
export const RRF_K = 60;

/** What building an agent's recall did. */
export interface IndexReport {
  readonly files: number;
  readonly chunks: number;
  readonly unreadable: readonly { readonly path: string; readonly reason: string }[];
  readonly fts: number;
  /** Points written, or why the vector half was not built. */
  readonly vectors: { readonly ok: true; readonly points: number } | { readonly ok: false; readonly reason: string };
}

/**
 * Read `memory/`, build the full-text file, then try the vector collection.
 *
 * The marker is written before the collection is touched — see `marker.ts`.
 */
export async function indexAgent(
  agentDir: string,
  subject: SubjectId,
  endpoints: VectorEndpoints | { readonly reason: string },
  options: { readonly markerDir: string; readonly now: () => Date; readonly network?: Fetch },
): Promise<IndexReport> {
  const doFetch = options.network;
  const sources = await readMemory(agentDir);
  const fts = await buildFts(agentDir, sources.chunks);
  let vectors: IndexReport["vectors"];
  if ("reason" in endpoints) {
    vectors = { ok: false, reason: endpoints.reason };
  } else {
    try {
      await writeRagMarker(options.markerDir, subject, endpoints.qdrantUrl, options.now());
      vectors = { ok: true, points: await replaceCollection(endpoints, subject, sources.chunks, doFetch) };
    } catch (cause) {
      vectors = { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return {
    files: sources.files.length,
    chunks: sources.chunks.length,
    unreadable: sources.unreadable,
    fts,
    vectors,
  };
}

/** One merged hit. `via` says which index found it, so a reader can see the black box open. */
export interface RecallHit {
  readonly id: string;
  readonly path: string;
  readonly heading: string;
  readonly text: string;
  readonly score: number;
  readonly via: readonly ("fts" | "vector")[];
  /**
   * The vector half's cosine for this piece, when that half found it (D-152). The fused score above reads only
   * ranks, so it cannot say "nothing here is close"; an ask needs to, and reads this.
   */
  readonly cosine?: number;
}

/** A recall, and which halves answered. */
export interface RecallResult {
  readonly hits: readonly RecallHit[];
  readonly fts: "ok" | "absent";
  readonly vector: "ok" | { readonly failed: string };
}

/** Search both halves and merge. A half that fails is reported, not thrown. */
export async function recall(
  agentDir: string,
  subject: SubjectId,
  query: string,
  limit: number,
  endpoints: VectorEndpoints | { readonly reason: string },
  doFetch?: Fetch,
  mode: "all" | "any" = "all",
  scope: Scope = "all",
): Promise<RecallResult> {
  // A scoped search throws some candidates away, so it asks each half for more of them first.
  const pool = limit * (scope === "all" ? 3 : 8);
  const text = await searchFts(agentDir, query, pool, mode);
  let semantic: Awaited<ReturnType<typeof searchVectors>> = [];
  let vector: RecallResult["vector"] = "ok";
  if ("reason" in endpoints) {
    vector = { failed: endpoints.reason };
  } else {
    try {
      semantic = await searchVectors(endpoints, subject, query, pool, doFetch);
    } catch (cause) {
      vector = { failed: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  const merged = new Map<string, { hit: Omit<RecallHit, "score" | "via" | "cosine">; score: number; via: ("fts" | "vector")[]; cosine?: number }>();
  const add = (list: readonly { id: string; path: string; heading: string; text: string; score?: number }[], via: "fts" | "vector"): void => {
    list.forEach((hit, rank) => {
      const seen = merged.get(hit.id);
      const share = 1 / (RRF_K + rank + 1);
      const cosine = via === "vector" && typeof hit.score === "number" ? hit.score : undefined;
      if (seen === undefined) {
        merged.set(hit.id, {
          hit: { id: hit.id, path: hit.path, heading: hit.heading, text: hit.text },
          score: share,
          via: [via],
          ...(cosine === undefined ? {} : { cosine }),
        });
      } else {
        seen.score += share;
        seen.via.push(via);
        if (cosine !== undefined) seen.cosine = cosine;
      }
    });
  };
  add(text.filter((hit) => inScope(hit.path, scope)).map(({ rank: _rank, ...hit }) => hit), "fts");
  add(semantic.filter((hit) => inScope(hit.path, scope)), "vector");

  const hits = [...merged.values()]
    .sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path))
    .slice(0, limit)
    .map((entry) => ({ ...entry.hit, score: entry.score, via: entry.via, ...(entry.cosine === undefined ? {} : { cosine: entry.cosine }) }));
  const fts = (await Bun.file(ftsPath(agentDir)).exists()) ? "ok" : "absent";
  return { hits, fts, vector };
}
