/**
 * The manifest, read and written.
 *
 * Two properties matter here and neither is about JSON. The first is that the
 * serialiser is deterministic, because every claim about `.mind/` rebuilding
 * identically rests on it. The second is that the parser refuses rather than
 * repairs: a manifest Mind cannot read means "stale", and a parser that
 * guessed at a missing field would report "fresh" about a directory nobody
 * can account for.
 */

import { describe, expect, test } from "bun:test";
import {
  derivedPath,
  MANIFEST_SCHEMA,
  parseManifest,
  serializeManifest,
  type DerivedManifest,
} from "../../src/agent/manifest.ts";
import { DERIVED_DIR } from "../../src/agent/template.ts";
import { subjectId } from "../../src/types.ts";
import { GENERATOR, VERSION } from "../../src/version.ts";

const MANIFEST: DerivedManifest = {
  schema: MANIFEST_SCHEMA,
  subject: subjectId("example"),
  generator: "mind@0.0.0",
  built_at: "2026-09-21T00:00:00.000Z",
  artefacts: [
    {
      derivation: "soul-render@1",
      path: ".mind/soul/rendered.md",
      sha256: "a".repeat(64),
      sources: [{ path: "soul/role.md", sha256: "b".repeat(64) }],
    },
  ],
};

describe("derived manifest", () => {
  test("serialising twice gives the same bytes", () => {
    expect(serializeManifest(MANIFEST)).toBe(serializeManifest(MANIFEST));
  });

  test("key order does not depend on how the object was built", () => {
    const shuffled = {
      artefacts: MANIFEST.artefacts,
      built_at: MANIFEST.built_at,
      generator: MANIFEST.generator,
      subject: MANIFEST.subject,
      schema: MANIFEST.schema,
    } satisfies DerivedManifest;
    expect(serializeManifest(shuffled)).toBe(serializeManifest(MANIFEST));
  });

  test("built_at sits on a line of its own, so a diff can name it", () => {
    const lines = serializeManifest(MANIFEST).split("\n").filter((line) => line.includes("built_at"));
    expect(lines).toHaveLength(1);
  });

  test("it round-trips", () => {
    expect(parseManifest(serializeManifest(MANIFEST))).toEqual(MANIFEST);
  });

  test("anything that is not a manifest comes back undefined, not repaired", () => {
    const broken = [
      "",
      "not json at all",
      "[]",
      "null",
      JSON.stringify({ ...MANIFEST, subject: "Not A Subject Id" }),
      JSON.stringify({ ...MANIFEST, artefacts: "one" }),
      JSON.stringify({ ...MANIFEST, built_at: 1_700_000_000 }),
      JSON.stringify({ ...MANIFEST, artefacts: [{ derivation: "soul-render@1" }] }),
      JSON.stringify({
        ...MANIFEST,
        artefacts: [{ ...MANIFEST.artefacts[0]!, sources: [{ path: "soul/role.md" }] }],
      }),
    ];
    for (const text of broken) expect(parseManifest(text), text.slice(0, 40)).toBeUndefined();
  });

  test("AC5 — a recorded path is relative to the repository, never to a machine", () => {
    expect(derivedPath("soul/rendered.md")).toBe(`${DERIVED_DIR}/soul/rendered.md`);
    expect(derivedPath("soul/rendered.md").startsWith("/")).toBe(false);
  });
});

describe("engine version", () => {
  test("it matches package.json, so the manifest names something real", async () => {
    const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json();
    expect(pkg.version).toBe(VERSION);
    expect(GENERATOR).toBe(`mind@${VERSION}`);
  });
});
