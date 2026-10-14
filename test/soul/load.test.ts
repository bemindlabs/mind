/**
 * Loading a soul from a directory, for a named subject.
 *
 * The test that matters most here is the mismatch one. Loading the right files
 * for the wrong subject is not a typo — it is the shape of an identity leak
 * (I-3), and it has to fail loudly while the files themselves are perfectly
 * valid.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { subjectId } from "../../src/types.ts";
import { loadSoul, resolveSoulDir } from "../../src/soul/load.ts";
import { SOUL_DIR } from "../../src/agent/template.ts";
import { mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const EXAMPLE = subjectId("example");

describe("loadSoul", () => {
  test("loads a valid soul and sets the AI disclosure itself", async () => {
    const loaded = await loadSoul(join(FIXTURES, "soul-valid"), EXAMPLE);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.soul.subject).toBe(EXAMPLE);
    expect(loaded.soul.role.name).toBe("Example Keeper");
    expect(loaded.soul.person.addresses_user_as).toBe("friend");
    expect(loaded.soul.disclosesAi).toBe(true);
  });

  test("refuses a soul that belongs to a different subject", async () => {
    const loaded = await loadSoul(join(FIXTURES, "soul-valid"), subjectId("other"));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;

    // Both halves complain: neither file may be borrowed on its own.
    expect(loaded.issues.map((issue) => issue.file).sort()).toEqual(["person.md", "role.md"]);
    for (const issue of loaded.issues) expect(issue.message).toContain("example");
  });

  test("reports every problem in a broken soul, with line numbers", async () => {
    const loaded = await loadSoul(join(FIXTURES, "soul-broken"), EXAMPLE);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;

    const paths = loaded.issues.map((issue) => issue.path);
    expect(paths).toContain("roll");
    expect(paths).toContain("role");
    expect(paths).toContain("prohibitions");
    expect(paths).toContain("scope.does_not");

    expect(loaded.issues.find((issue) => issue.path === "roll")?.line).toBe(5);
    expect(loaded.issues.find((issue) => issue.path === "prohibitions")?.line).toBe(6);
    for (const issue of loaded.issues) expect(issue.file).toBe("role.md");
  });

  test("a missing half is an issue, not an exception — and the issue says where it looked", async () => {
    const dir = join(FIXTURES, "does-not-exist");
    const loaded = await loadSoul(dir, EXAMPLE);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.issues.map((issue) => issue.file).sort()).toEqual(["person.md", "role.md"]);
    for (const issue of loaded.issues) {
      expect(issue.line).toBe(0);
      // Both places, by name (D-033): the directory given and its soul/.
      expect(issue.message).toContain(dir);
      expect(issue.message).toContain(join(dir, "soul"));
    }
  });
});

/**
 * D-033 — one rule for "which directory", under every caller.
 * `new` writes `<repo>/soul/`; `turn` was handed `<repo>` and said the files
 * were not found. Now either address loads, and the resolution is a function
 * with a name so the help text can point at it.
 */
describe("loadSoul accepts an agent repository as well as its soul/ (D-033)", () => {
  test("the spelling of soul/ here is the one the agent template uses", () => {
    // `src/soul` cannot import `src/agent` (the dependency runs the other
    // way), so the word is spelled twice and held equal here.
    expect(SOUL_DIR).toBe("soul");
  });

  test("a repository with soul/ inside resolves to it; a soul directory resolves to itself", async () => {
    const repo = await mkdtemp(join(tmpdir(), "mind-repo-"));
    try {
      await mkdir(join(repo, "soul"));
      await cp(join(FIXTURES, "soul-valid"), join(repo, "soul"), { recursive: true });
      expect(await resolveSoulDir(repo)).toBe(join(repo, "soul"));
      expect(await resolveSoulDir(join(repo, "soul"))).toBe(join(repo, "soul"));
      // And the load itself, through the repository path, is the same soul.
      const viaRepo = await loadSoul(repo, EXAMPLE);
      const viaSoul = await loadSoul(join(repo, "soul"), EXAMPLE);
      expect(viaRepo.ok).toBe(true);
      expect(viaRepo).toEqual(viaSoul);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a directory with neither resolves to itself, so the message names what was given", async () => {
    const empty = await mkdtemp(join(tmpdir(), "mind-empty-"));
    try {
      expect(await resolveSoulDir(empty)).toBe(empty);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("a half-present soul directory is not skipped over in favour of a nested one", async () => {
    // One file at the top and a full soul in soul/: the top wins, and the
    // load reports the top's missing half rather than silently reading the
    // nested pair — a directory with a role.md in it is the soul the caller
    // meant, complete or not.
    const repo = await mkdtemp(join(tmpdir(), "mind-half-"));
    try {
      await mkdir(join(repo, "soul"));
      await cp(join(FIXTURES, "soul-valid"), join(repo, "soul"), { recursive: true });
      await cp(join(FIXTURES, "soul-valid", "role.md"), join(repo, "role.md"));
      expect(await resolveSoulDir(repo)).toBe(repo);
      const loaded = await loadSoul(repo, EXAMPLE);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.issues.map((issue) => issue.file)).toEqual(["person.md"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
