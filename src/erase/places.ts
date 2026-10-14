/**
 * The five places S7.2 AC1 names, and the four of them that exist.
 *
 * AC1 reads *ลบครบ 5 ที่: soul · observer data · RAG collection · ledger · LoRA
 * adapter*. One of those five has no code in this repository at all: there is
 * no adapter (S6.3). The vector store arrived with S4.1 (D-038) and brought its
 * deleter in the same commit. A command that printed "5 of 5 deleted" would
 * therefore be making the exact claim I-4's second half forbids — *do not say
 * you deleted what you cannot delete* — about the place whose data is the
 * hardest to get back.
 *
 * So this file is a **closed registry with two statuses in it**, and the
 * string `5` never appears next to the word "deleted". Output and certificate
 * say `4 of 4 places that exist · 1 of 5 are not built`.
 *
 * Three properties are worth naming, because each one is a way this could have
 * gone quietly wrong:
 *
 * - **Closed at the type level.** `PLACES satisfies Record<PlaceId, Place>`, so
 *   a missing place and a sixth one are both `tsc` errors rather than a line
 *   nobody notices is gone.
 * - **`not-built` carries its debt.** The story that owes it, the address D-014
 *   reserves for it, and the five things it must bring when it registers. An
 *   erase run looks at that address: **something there with no deleter for it
 *   is an exit 1 and no certificate**, because the alternative is certifying a
 *   deletion over a directory nobody claimed.
 * - **The debt has a test, not a comment.** `test/erase/places.test.ts` fails
 *   if a derivation starts writing under the reserved address, or if anything
 *   in `src/` names an adapter path while `lora` still says `not-built`. The
 *   same test held `rag` to that until S4.1 paid it: the socket in the erase
 *   layer is one file (`src/memory/store-admin.ts`) that can `GET` and `DELETE`
 *   a collection by name and cannot send a body.
 *
 * ## The lists, by reference
 *
 * Every place carries the "what deletion cannot reach" lists it is responsible
 * for, and they are the **same array objects** that `ledger forget`,
 * `observe purge` and `guard status` already print — never copies. ADR 0002's
 * "when erase lands it must print this same list rather than a second copy of
 * it" is kept by `toBe`, which a copy would fail.
 *
 * The one new list is {@link WEIGHTS_UNDELETABLE}, owned by `lora`, because no
 * existing list says what a trained weight keeps: there was nothing to reuse.
 */

import { DERIVED_DIR } from "../agent/template.ts";
import { GIT_UNDELETABLE } from "../guard/history.ts";
import { IDENTITY_UNDELETABLE } from "../identity/dir.ts";
import { UNDELETABLE } from "../ledger/store.ts";
import { SUMMARY_PATH } from "../observer/actions.ts";
import { RAG_UNDELETABLE } from "../memory/store-admin.ts";
import { OBSERVER_UNDELETABLE } from "../observer/store.ts";
import { PLACE_IDS, type PlaceId } from "./place-id.ts";

/** The five places AC1 names — declared in `place-id.ts`, which says why. */
export type { PlaceId };

/** Whether Mind has code that deletes this place, or only an address for it. */
export type PlaceStatus =
  /** There is a planner, a deleter and a recount for it in this repository. */
  | "implemented"
  /** Nothing writes here yet, so nothing deletes here yet. Said, not hidden. */
  | "not-built";

/** One of the five, and everything a run has to be able to say about it. */
export interface Place {
  readonly id: PlaceId;
  /** One line, in the words the certificate uses. */
  readonly what: string;
  readonly status: PlaceStatus;
  /**
   * The lists this place is required to print, by reference.
   *
   * A list of lists rather than a flattened one, so the identity of each array
   * survives and a test can assert `toBe` against the module that owns it.
   */
  readonly undeletable: readonly (readonly string[])[];
  /** `not-built` only: the story that owes this place its deleter. */
  readonly owedBy?: string;
  /** `not-built` only: the address D-014 reserves, relative to the agent repo. */
  readonly reserved?: string;
  /** `not-built` only: what it has to bring on the day it registers. */
  readonly mustBring?: readonly string[];
  /** When the undeletable list has to be in front of a human. */
  readonly noticeAt: string;
}

/**
 * What a fine-tuned weight keeps — the one list with nothing to reuse.
 *
 * S7.2 AC4 names two undeletable things: git history, which
 * {@link GIT_UNDELETABLE} has covered since S0.4, and *weight ที่ fine-tune
 * แล้ว*, which nothing covered. It is printed by `mind new` before there is
 * any data to train on, which is the only moment at which it is useful.
 *
 * The first line is the one people are surprised by, and it is why S6.3 sits
 * behind a spike: deletion from a trained model is not a slow operation, it is
 * not an operation.
 */
export const WEIGHTS_UNDELETABLE: readonly string[] = [
  "a trained weight cannot have one person subtracted from it. Fine-tuning mixes every example " +
    "into the same parameters; there is no record of which weight came from which record, and " +
    "no `delete` that could use one. The only honest removal is to throw the adapter away and " +
    "train again from data that never held the withdrawn records.",
  "every copy of an adapter that was exported, uploaded or merged into a base model is beyond " +
    "this machine, exactly as a pushed commit is. Mind will not have a list of them.",
  "what a model that was trained on somebody can still say about them. An adapter reproduces " +
    "turns of phrase, habits and facts it was never told to keep, and discarding the training " +
    "data afterwards does not take them back out.",
  "Mind trains nothing today (S6.3 is behind SP-3). This list is printed before the first " +
    "capture rather than when somebody asks to delete, because after training it is advice " +
    "nobody can act on.",
];

/**
 * The registry. Closed by `satisfies`, so every id has exactly one entry.
 *
 * Order is the order AC1 lists them in, and the order every report prints them
 * in, so a reader comparing output against the backlog reads down one column.
 */
export const PLACES = {
  soul: {
    id: "soul",
    what:
      "the identity: soul/ in the agent's git working tree, Mind's block in every vendor " +
      "instruction file it was applied to, the backups taken before those writes, the " +
      "derived " + DERIVED_DIR + "/ beside them, and the agent's own signing key under the data " +
      "root (S15.8)",
    status: "implemented",
    // Git's list, and the key's: what the private key signed stays signed wherever it went.
    undeletable: [GIT_UNDELETABLE, IDENTITY_UNDELETABLE],
    noticeAt: "mind new, before the first commit",
  },
  observer: {
    id: "observer",
    what:
      "everything under the subject's personal directory, of which the raw capture tree " +
      "observer/ is one subtree and the proposal store proposals/ (S5.2, D-029) is another. " +
      "The place is named for the observer because that is what first wrote here; what goes is " +
      "the whole directory, and a certificate that said `observer record` while deleting " +
      "somebody's proposals would be naming less than it took. What is *derived* from it and " +
      "committed is not in there and " +
      "does not go: `" + SUMMARY_PATH + "` in the agent repository is the case that exists " +
      "today (S3.2, `mind observe actions --write`). It holds integers keyed by words Mind " +
      "holds in its own source — no path, no project, no session, no instant — so there is " +
      "nothing in it to find and nothing in it to delete, and this run searches the agent's " +
      "working tree for the identifier anyway rather than taking that on trust",
    status: "implemented",
    // Two lists, both by reference: the personal tree's own, and git's — because
    // a summary that has been committed is past the first and squarely inside
    // the second. OBSERVER_UNDELETABLE's third line already says so in words;
    // this is that sentence given the array it points at.
    undeletable: [OBSERVER_UNDELETABLE, GIT_UNDELETABLE],
    noticeAt:
      "mind new, again before the first capture (announceCapture), and again before " +
      "`observe actions --write` writes anything",
  },
  rag: {
    id: "rag",
    what:
      "the subject's vector collection in Qdrant (one per subject, named by collectionFor — D-007) " +
      "and the record of " +
      "where it was written, under the state root. The full-text index beside it lives in the " +
      "agent's " + DERIVED_DIR + "/ and goes with that tree (D-037, D-038)",
    status: "implemented",
    undeletable: [RAG_UNDELETABLE],
    noticeAt: "mind memory index, before the first piece is embedded",
  },
  ledger: {
    id: "ledger",
    what:
      "the turn ledger — one JSONL file per month under the state root — and the run records " +
      "beside it, which name the turns that had started and not finished. Both are the same " +
      "fact keyed by the same turn id; the difference is only that a run record describes a " +
      "turn still in flight, and it exists so that `mind stop` can find one (S5.4). Not a " +
      "sixth place: AC1 names five and this registry is closed to them",
    status: "implemented",
    undeletable: [UNDELETABLE],
    noticeAt: "mind new, and on every `ledger forget`",
  },
  lora: {
    id: "lora",
    what: "the LoRA/QLoRA adapter trained on this subject",
    status: "not-built",
    undeletable: [WEIGHTS_UNDELETABLE],
    owedBy: "S6.3",
    reserved: `${DERIVED_DIR}/adapters`,
    mustBring: [
      "a plan that names every adapter file and every base model it was merged into",
      "a commit that takes no environment",
      "a recount from disk after the deletion",
      "a search this command can run afterwards",
      "WEIGHTS_UNDELETABLE in front of a human *before* training, not after",
    ],
    noticeAt: "mind new, and before training starts",
  },
} as const satisfies Record<PlaceId, Place>;

/** Every id, in the order AC1 lists them — declared beside the type, in `place-id.ts`. */
export { PLACE_IDS };

/**
 * One place, widened to {@link Place}.
 *
 * `PLACES[id]` for a union `id` is a union of five distinct literal object
 * types, and reading a field off that union is either a type error or an
 * accident waiting for the sixth entry. One accessor, one type.
 */
export function placeOf(id: PlaceId): Place {
  return PLACES[id];
}

/** The places that have a deleter in this repository. */
export function implementedPlaces(): readonly Place[] {
  return PLACE_IDS.map(placeOf).filter((place) => place.status === "implemented");
}

/** The places that have an address and a debt, and nothing else. */
export function notBuiltPlaces(): readonly Place[] {
  return PLACE_IDS.map(placeOf).filter((place) => place.status === "not-built");
}

/** The lists one place must print, by reference. */
export function undeletableFor(id: PlaceId): readonly (readonly string[])[] {
  return placeOf(id).undeletable;
}

/**
 * How many places a run visited, out of how many exist — and the two that do not.
 *
 * A sentence rather than two numbers a caller might arrange into "5/5". The
 * word "deleted" never stands next to a 5 anywhere in Mind's output, and this
 * function is why: the first fraction counts only places that have a deleter,
 * and the second says plainly that the other two were never built.
 */
export function placeTally(visited: number): string {
  const exist = implementedPlaces().length;
  const missing = notBuiltPlaces();
  return (
    `${visited} of ${exist} places that exist were visited · ${missing.length} of ` +
    `${PLACE_IDS.length} are not built ` +
    `(${missing.map((place) => `${place.id}, owed by ${place.owedBy ?? "nobody"}`).join("; ")})`
  );
}
