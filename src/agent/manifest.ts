/**
 * `.mind/manifest.json` — what was built, from what, by which engine, and when.
 *
 * AC6 asks for a record of "what was made from what, when", and AC7 asks for a
 * rebuild to come out the same. Those pull in opposite directions, and this
 * file is where that is resolved rather than fudged: **`built_at` is the only
 * field allowed to change between two rebuilds of an unchanged repository.**
 * Everything else — the schema tag, the subject, the generator, every artefact
 * path and hash, every source path and hash — is a function of what git holds.
 * The test does not skip `built_at`; it asserts that it is the only line that
 * moved, which is the difference between a promise and a claim.
 *
 * The alternative considered was dating the build from the source commit, which
 * would make the file identical across rebuilds. It was not chosen because it
 * is wrong exactly when it matters: a working tree with uncommitted edits would
 * be dated by a commit that does not contain them.
 *
 * **Every path in here is relative to the repository** (AC5). An absolute path
 * would name the machine that happened to run the build, survive a `git clone`
 * into a container where it means nothing, and hand a reader of a private repo
 * a fact about somebody's home directory (D-021).
 */

import { isSubjectId, type SubjectId } from "../types.ts";
import { DERIVED_DIR } from "./template.ts";

/** Schema tag the manifest carries. Bumped when this shape changes. */
export const MANIFEST_SCHEMA = "mind/agent-manifest@1";

/** The manifest's filename, inside `.mind/`. */
export const MANIFEST_FILE = "manifest.json";

/** A repo-relative path for something that lives under `.mind/`. */
export function derivedPath(insideDerived: string): string {
  return `${DERIVED_DIR}/${insideDerived}`;
}

/** One input an artefact was derived from, as it stood at build time. */
export interface ManifestSource {
  /** Repo-relative, POSIX separators. */
  readonly path: string;
  readonly sha256: string;
}

/** One thing that was built. */
export interface ManifestArtefact {
  /** Which entry of the derivation register produced it. */
  readonly derivation: string;
  /** Repo-relative, POSIX separators. */
  readonly path: string;
  readonly sha256: string;
  readonly sources: readonly ManifestSource[];
}

/** The whole record. */
export interface DerivedManifest {
  readonly schema: string;
  readonly subject: SubjectId;
  /** The engine that built this, e.g. `mind@0.0.1`. */
  readonly generator: string;
  /** ISO-8601, UTC. The one field a rebuild is allowed to change. */
  readonly built_at: string;
  readonly artefacts: readonly ManifestArtefact[];
}

/**
 * Render a manifest, deterministically.
 *
 * Key order is written out rather than inherited from whatever order the
 * object was built in, for the same reason `serializeSoul` fixes its key
 * order: so that a diff after a change shows the change.
 */
export function serializeManifest(manifest: DerivedManifest): string {
  const plain = {
    schema: manifest.schema,
    subject: manifest.subject,
    generator: manifest.generator,
    built_at: manifest.built_at,
    artefacts: manifest.artefacts.map((artefact) => ({
      derivation: artefact.derivation,
      path: artefact.path,
      sha256: artefact.sha256,
      sources: artefact.sources.map((source) => ({
        path: source.path,
        sha256: source.sha256,
      })),
    })),
  };
  return `${JSON.stringify(plain, null, 2)}\n`;
}

/**
 * Read a manifest back, or decide it is not one.
 *
 * Returns `undefined` rather than throwing or repairing. A manifest Mind
 * cannot read is not an error a person needs a stack trace for — it means the
 * derived directory is stale, which is a state `doctor` already knows how to
 * report and `rebuild` already knows how to fix.
 */
export function parseManifest(text: string): DerivedManifest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw)) return undefined;

  const { schema, subject, generator, built_at: builtAt, artefacts } = raw;
  if (typeof schema !== "string") return undefined;
  if (!isSubjectId(subject)) return undefined;
  if (typeof generator !== "string") return undefined;
  if (typeof builtAt !== "string") return undefined;
  if (!Array.isArray(artefacts)) return undefined;

  const parsed: ManifestArtefact[] = [];
  for (const entry of artefacts) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry["derivation"] !== "string") return undefined;
    if (typeof entry["path"] !== "string") return undefined;
    if (typeof entry["sha256"] !== "string") return undefined;
    const sources = entry["sources"];
    if (!Array.isArray(sources)) return undefined;

    const parsedSources: ManifestSource[] = [];
    for (const source of sources) {
      if (!isRecord(source)) return undefined;
      if (typeof source["path"] !== "string") return undefined;
      if (typeof source["sha256"] !== "string") return undefined;
      parsedSources.push({ path: source["path"], sha256: source["sha256"] });
    }

    parsed.push({
      derivation: entry["derivation"],
      path: entry["path"],
      sha256: entry["sha256"],
      sources: parsedSources,
    });
  }

  return { schema, subject, generator, built_at: builtAt, artefacts: parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
