/**
 * The register of everything `.mind/` is allowed to contain.
 *
 * I-2 says the derived directory can be deleted and rebuilt. That promise is
 * only checkable if there is a list of what *ought* to be in there, so this
 * file is that list, and `rebuild` treats anything absent from it as debris to
 * be swept rather than state to be preserved. A thing that cannot be rebuilt
 * from what git holds does not belong under `.mind/` at all — it belongs in
 * git, or, if it is personal, outside the repository entirely (D-014).
 *
 * Two requirements on every entry, both load-bearing:
 *
 * - **`render` is a pure function of the soul.** Same soul in, same bytes out,
 *   with no clock, no hostname and no randomness. That is what makes AC7 — `rm
 *   -rf .mind` then rebuild, and get the same result — a real test rather than
 *   a tautology.
 * - **`sources` names every file the output is derived from.** The manifest
 *   records a hash of each one, which is how `doctor` can answer "is this
 *   stale?" without re-deriving anything.
 *
 * There is one entry today. That is not a placeholder: `rendered.md` is the
 * exact text `soul apply` writes into a vendor's instruction file and `turn`
 * passes as a system prompt, so having it on disk is what lets a person read
 * what the model was actually told without running anything. Both commands
 * still render from `soul/` themselves — deleting `.mind/` can therefore never
 * change an answer, which is the property that makes deleting it safe.
 */

import { renderSoul } from "../soul/render.ts";
import { PERSON_FILE, ROLE_FILE, type Soul } from "../soul/schema.ts";
import type { NonEmpty } from "../types.ts";
import { SOUL_DIR } from "./template.ts";

/** One rebuildable artefact, and everything needed to rebuild and date it. */
export interface Derivation {
  /** Stable id with a version in it, e.g. `soul-render@1`. */
  readonly id: string;
  /** Where it lands, relative to `.mind/`. POSIX separators. */
  readonly output: string;
  /** Repo-relative paths this is derived from, in a fixed order. */
  readonly sources: readonly string[];
  /** Deterministic: no clock, no environment, no randomness. */
  readonly render: (soul: Soul) => string;
}

/**
 * Everything `.mind/` may hold, besides the manifest itself.
 *
 * {@link NonEmpty} rather than `readonly Derivation[]`, and the difference is
 * the whole of odd2's H6. `derivedStatus` decides `fresh` by joining two sorted
 * lists of derivation ids and comparing the strings — and `"" === ""`. An
 * engine that derives nothing therefore agrees with a manifest that recorded
 * nothing, walks an artefact list of zero, and answers `fresh — 0 artefact(s)
 * match what the repository holds`, exit 0, to the `rebuild --check` a CI job
 * runs. Measured end to end through the CLI (`notes/odd2-driver.ts`, `D-P4b`).
 *
 * The same emptiness makes `doctor --agent` print `ok  fresh · 0 artefact(s)`,
 * which is the shape `test/cli/binary.test.ts` forbids everywhere else.
 *
 * `= []` no longer compiles, so neither state has to be guarded for at run time.
 */
export const DERIVATIONS: NonEmpty<Derivation> = [
  {
    id: "soul-render@1",
    output: "soul/rendered.md",
    sources: [`${SOUL_DIR}/${ROLE_FILE}`, `${SOUL_DIR}/${PERSON_FILE}`],
    // The trailing newline is added here rather than in `renderSoul`, whose
    // output is spliced into the middle of somebody else's file and must not
    // grow one.
    render: (soul) => `${renderSoul(soul)}\n`,
  },
];
