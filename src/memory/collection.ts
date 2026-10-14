/**
 * The address an identity's recall lives at — one definition, keyed by subject.
 *
 * This file holds a naming rule and nothing else. The store and its client
 * arrived with S4.1 (`vector.ts`, `store-admin.ts`, D-038) and both build every
 * address they use from {@link collectionFor}; this file is still the only
 * place the prefix is written.
 *
 * ## Why the name exists before the store does
 *
 * D-007 was a measurement, not a preference. The vector store already on this
 * class of machine had **one collection shared by everything** and the app in
 * front of it had **no delete at all**, so a person's records ingested there
 * could be neither separated nor withdrawn. The decision it produced has two
 * halves: Mind gets collections of its own, and they are **per subject** —
 * {@link COLLECTION_PREFIX} and then the subject id.
 *
 * A name is the whole of that guarantee. Two identities are isolated in a
 * vector store if and only if they address different collections, and "address"
 * means this string. If the string is computed at two call sites, isolation is
 * a convention two authors are keeping; if it is computed here from a
 * `SubjectId`, it is a property of the type — a caller with no subject cannot
 * name a collection at all, and a caller with one cannot name somebody else's
 * by accident.
 *
 * That is also what makes I-4 reachable later: `erase` can only drop what it
 * can name, and {@link subjectOfCollection} is how a list of collections on a
 * store turns back into a list of subjects.
 *
 * ## What this file may never grow into
 *
 * A client. The sockets under `src/memory/` are in two named files, and
 * `test/erase/places.test.ts` fails if a third appears.
 */

import type { SubjectId } from "../types.ts";

/**
 * The prefix D-007 fixed, and the one place it is written down.
 *
 * Two underscores, so that a collection Mind owns cannot be confused with one
 * created by anything else on the same store — including by a single-underscore
 * convention somebody else adopts later.
 */
export const COLLECTION_PREFIX = "mind__";

/**
 * Where `subject`'s recall is indexed.
 *
 * Total: every {@link SubjectId} is already a valid name, because the alphabet
 * a subject id is validated against (`src/types.ts`) is narrower than anything
 * a store would refuse. So there is no failure case to report and no
 * sanitisation step that could map two subjects onto one name.
 */
export function collectionFor(subject: SubjectId): string {
  return `${COLLECTION_PREFIX}${subject}`;
}

/**
 * Whose collection this is, or `undefined` when it is not Mind's.
 *
 * The inverse matters as much as the function. S4.1 owes "a plan that names
 * every collection it would drop", and a plan built by listing a store and
 * keeping what looks familiar would be a plan that drops somebody else's data
 * on a prefix collision. This answers the only question an erase run may ask of
 * a name it did not construct: *is this mine, and whose?*
 *
 * Returns `undefined` rather than throwing for a name outside the prefix: a
 * store holds other people's collections and listing them is not an error.
 */
export function subjectOfCollection(name: string): SubjectId | undefined {
  if (!name.startsWith(COLLECTION_PREFIX)) return undefined;
  const rest = name.slice(COLLECTION_PREFIX.length);
  // Validated rather than trusted. A name that carries the prefix and then
  // something a subject id may not contain was not written by this function,
  // and guessing that it was is how an erase run reaches past its own data.
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(rest) ? (rest as SubjectId) : undefined;
}

/** True when `a` and `b` would share storage. Never, for two different subjects. */
export function collidesWith(a: SubjectId, b: SubjectId): boolean {
  return collectionFor(a) === collectionFor(b);
}

/**
 * What the name buys, and what it does not — said here rather than assumed.
 *
 * S1.6 AC4 asks that a query by B cannot reach A's memory. Half of that is an
 * address, and this file is that half. The other half is a store that honours
 * it, and there is no store: claiming AC4 closed on the strength of a string
 * would be exactly the over-promise the backlog refuses ("AC ที่สัญญาเกินกว่า
 * ที่พิสูจน์ได้ คือ AC ที่ถูกติ๊กแล้วหลอกคนอ่าน").
 */
export const COLLECTION_LIMITS: readonly string[] = [
  "two subjects can never address the same collection: the name is derived from the subject id " +
    "and there is no other way to build one in this program.",
  "the store honours the name only as far as Mind's own requests do: every request S4.1 " +
    "makes addresses `collectionFor(subject)` and no other collection, and " +
    "`test/memory/vector.test.ts` asks for B's recall and checks that no request reached A's. " +
    "Qdrant itself has no per-collection access control on this machine — any process that " +
    "can reach :10300 can read every collection.",
  "a collection written by something other than Mind is outside all of this. The rule D-007 " +
    "set is that personal records go in a collection Mind named; it cannot make that true of " +
    "a store it did not write to.",
];
