/**
 * Where recall's two servers are, and the check that they cannot be anywhere
 * but this machine (D-038).
 *
 * Kept apart from `vector.ts` because `erase` needs to know the address and
 * must not be able to reach the client that sends text to it
 * (`test/erase/no-network.test.ts`).
 */

import { readEnv } from "../env.ts";
import { notLoopbackLiteral } from "../loopback.ts";

/** Default embed endpoint: the real Ollama, not the shim (D-038). */
export const DEFAULT_EMBED_URL = "http://127.0.0.1:11435";
/** Default vector store. */
export const DEFAULT_QDRANT_URL = "http://127.0.0.1:10300";
/** The model D-007 / S4.1 AC3 fixed, and the size of what it returns. */
export const EMBED_MODEL = "bge-m3";
export const EMBED_DIMENSIONS = 1024;

/** Where recall's two endpoints are, once checked. */
export interface VectorEndpoints {
  readonly embedUrl: string;
  readonly qdrantUrl: string;
}

/** Read and check both endpoints from the environment. */
export function vectorEndpoints(
  env: Readonly<Record<string, string | undefined>>,
): { readonly ok: true; readonly endpoints: VectorEndpoints } | { readonly ok: false; readonly reason: string } {
  const embedUrl = trimSlash(readEnv("EMBED_URL", env) ?? DEFAULT_EMBED_URL);
  const qdrantUrl = trimSlash(readEnv("QDRANT_URL", env) ?? DEFAULT_QDRANT_URL);
  for (const [name, url] of [
    ["MIND_EMBED_URL", embedUrl],
    ["MIND_QDRANT_URL", qdrantUrl],
  ] as const) {
    const why = notLoopbackLiteral(url);
    if (why !== undefined) return { ok: false, reason: `${name}: ${why}` };
  }
  return { ok: true, endpoints: { embedUrl, qdrantUrl } };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

