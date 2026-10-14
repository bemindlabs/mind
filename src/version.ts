/**
 * One place that says which engine this is.
 *
 * It used to be a literal in the CLI's entry file under `bin/`. `.mind/manifest.json` has to
 * record which engine built it — a rebuild is only reproducible against the
 * same renderer — and a second copy of the version string is a second thing to
 * forget. The test beside this file checks it against `package.json`, so the
 * two cannot drift in silence.
 */

/** The engine's version. Kept equal to `package.json`, checked by a test. */
export const VERSION = "0.11.1";

/** What a derived artefact records as the thing that produced it. */
export const GENERATOR = `mind@${VERSION}`;
