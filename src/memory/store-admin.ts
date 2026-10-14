/**
 * The only door from `erase` to another program over a socket (D-038).
 *
 * `test/erase/no-network.test.ts` holds the erase layer to a rule: nothing it
 * can reach opens a socket, because a layer that deletes somebody's data and
 * could also send what it read would be the worst place in the program for a
 * leak (I-6). The `rag` place cannot keep that rule literally — its data lives
 * in Qdrant — so it keeps it the way the spawn chokepoint keeps the rule about
 * processes: **one file**, and that file can do very little.
 *
 * - Two methods: `GET` a collection's description, `DELETE` a collection.
 * - No request body, ever. The only thing that leaves is a URL built from a
 *   loopback address and a name from {@link collectionFor} — never a byte the erase
 *   layer read off disk.
 * - The address was checked with `notLoopbackLiteral` when it was resolved
 *   (`vectorEndpoints`, or the marker `memory index` left).
 *
 * `test/memory/store-admin.test.ts` asserts all three against the syntax tree.
 */

import type { SubjectId } from "../types.ts";
import { collectionFor } from "./collection.ts";

/** The injectable network, so tests can stand in for the servers. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const realFetch: Fetch = (url, init) => fetch(url, init);

/** Ask, with a deadline. The method is one of two; there is no body parameter. */
async function ask(
  doFetch: Fetch,
  url: string,
  method: "GET" | "DELETE",
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const response = await doFetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  try {
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  } catch {
    return { status: response.status, body: null };
  }
}

/** What the store says about one subject's collection. */
export type CollectionState =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly points: number }
  | { readonly kind: "unreachable"; readonly reason: string };

/** One collection, by its name on the store. */
async function stateOf(qdrantUrl: string, name: string, doFetch: Fetch): Promise<CollectionState> {
  try {
    const { status, body } = await ask(doFetch, `${qdrantUrl}/collections/${name}`, "GET", 10_000);
    if (status === 404) return { kind: "absent" };
    if (status !== 200) return { kind: "unreachable", reason: `Qdrant answered ${status}` };
    const points = (body as { result?: { points_count?: unknown } }).result?.points_count;
    return { kind: "present", points: typeof points === "number" ? points : 0 };
  } catch (cause) {
    return { kind: "unreachable", reason: String(cause) };
  }
}

/**
 * Ask whether a subject's collection exists, and how many points it holds.
 *
 * `unreachable` if the store could not be asked, else `present` with its points, else `absent`.
 */
export async function collectionState(
  qdrantUrl: string,
  subject: SubjectId,
  doFetch: Fetch = realFetch,
): Promise<CollectionState> {
  return stateOf(qdrantUrl, collectionFor(subject), doFetch);
}

/**
 * Remove a subject's whole collection. The only removal Mind has (D-035).
 *
 * Returns whether the store answered as if it were gone afterwards; a
 * collection that was not there is gone.
 */
export async function dropCollection(
  qdrantUrl: string,
  subject: SubjectId,
  doFetch: Fetch = realFetch,
): Promise<{ readonly dropped: boolean; readonly reason?: string }> {
  try {
    const { status } = await ask(doFetch, `${qdrantUrl}/collections/${collectionFor(subject)}`, "DELETE", 60_000);
    return status === 200 || status === 404 ? { dropped: true } : { dropped: false, reason: `Qdrant answered ${status}` };
  } catch (cause) {
    return { dropped: false, reason: String(cause) };
  }
}

/** What dropping a collection does not reach. Printed by `erase` and `memory index`. */
export const RAG_UNDELETABLE: readonly string[] = [
  "Qdrant removes a dropped collection's directory, and D-035 measured that. It does not " +
    "overwrite the blocks it occupied: on an SSD, a journal or a filesystem snapshot the " +
    "bytes may survive, exactly as for the observer's files.",
  "a snapshot or backup of the Qdrant storage directory taken by anything else on this machine.",
  "a collection is only as isolated as its name: removing points one at a time was measured " +
    "leaving their text on disk (D-035), so Mind has no such call and only drops whole " +
    "collections — a collection written by something other than Mind is outside this.",
  "the text of every piece was sent to the embed endpoint. Ollama does not keep request " +
    "bodies, but a proxy placed on that port would see them; Mind checks that the address " +
    "is a loopback literal and cannot check what listens there.",
  "a vector is derived from text and is not a hash of it: inversion attacks that recover " +
    "text from embeddings exist. Dropping the collection removes both; keeping one while " +
    "deleting the other would not be a deletion (D-035).",
];
