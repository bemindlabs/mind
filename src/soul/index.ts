/**
 * Soul — the identity Mind wears, and the only thing it truly owns.
 *
 * Filled by S1.1 (schema), S1.2 (apply), S1.3 (verify). Empty on purpose
 * rather than absent: the layer boundary is a decision, and a missing
 * directory reads as an oversight.
 *
 * The shape this layer must respect, decided before it was written:
 *
 * - A soul belongs to a `SubjectId`. Mind wears identities rather than
 *   having one (D-011), so nothing here may read a "current" soul from
 *   ambient state — the subject is always an argument.
 * - Rendering a soul for a backend is lossy in a way that must be reported,
 *   not hidden: two vendors take it as a system prompt, three only as a file
 *   of user-level text. `apply` records which one each backend got.
 * - `apply` never swallows what a human wrote. It writes into a delimited
 *   block, backs up what was there, and defaults to a dry run.
 *
 * S1.1 landed the schema half: two files per soul (`role.md`, `person.md`),
 * TOML frontmatter over Markdown, validated against a `SubjectId` the caller
 * supplies. There is still no registry — one soul, loaded by directory — but
 * every signature already carries the subject, so growing into one (AC2) is a
 * new entry point rather than a new parameter everywhere.
 *
 * S1.3 landed the half that makes the other two checkable: `verify` asks each
 * backend three questions only this soul can answer, reports four levels rather
 * than a boolean, and keeps every raw answer so a human can disagree with it.
 *
 * S1.2 landed the apply half, in five pieces that are deliberately separable:
 * `render` (soul → text, deterministic, also what S2.3 will pass as a system
 * prompt), `block` (the delimited region Mind owns, and the `strip` that
 * S1.5 will reuse for `revoke`), `diff`, `targets` (registry → places on this
 * machine) and `apply` (plan, then commit — a dry run is the absence of the
 * second call, not a flag).
 */

export * from "./schema.ts";
export * from "./frontmatter.ts";
export * from "./serialize.ts";
export * from "./load.ts";
export * from "./import-map.ts";
export * from "./bwoc.ts";
export * from "./render.ts";
export * from "./block.ts";
export * from "./diff.ts";
export * from "./targets.ts";
export * from "./apply.ts";
export * from "./revoke.ts";
export * from "./verify.ts";
export * from "./worn.ts";
export * from "./isolation.ts";
