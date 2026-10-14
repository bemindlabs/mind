/**
 * Agent — the repository an identity lives in, and the derived state beside it.
 *
 * The layer that answers "what is an agent, on disk?" (D-013, D-014): a git
 * repository holding `soul/`, `memory/` and `consent/` as Markdown a human can
 * read without Mind installed, a `.gitignore` with one line in it, and a
 * `.mind/` directory that can be deleted at any moment because everything in it
 * is derived from what git holds.
 *
 * It is the sixth directory under `src/`, where D-002 named five. That is
 * deliberate and recorded in `docs/adr/0002-agent-repo-layout.md`: the five are
 * the parts of an agent's *mind*, and this is the container they are stored in,
 * which is a different kind of thing. Putting it inside `soul/` would have made
 * `soul/` own `memory/`'s layout too.
 *
 * Nothing under here reaches `src/exec/`, directly or transitively. `new` and
 * `rebuild` finish without a model or a vendor CLI anywhere in the picture
 * (I-1), and a test walks the import graph to keep that true.
 *
 * Re-exports only. Every line below is `export *` and nothing else, so the
 * coverage gate's exemption for this file says something checkable.
 */

export * from "./repo.ts";
export * from "./template.ts";
export * from "./derive.ts";
export * from "./manifest.ts";
export * from "./rebuild.ts";
export * from "./new.ts";
