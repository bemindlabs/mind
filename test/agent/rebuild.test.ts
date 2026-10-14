/**
 * `rm -rf .mind` → rebuild → the same thing back. I-2, tested directly (AC7).
 *
 * "The same thing" is defined here rather than assumed, because AC6 and AC7 ask
 * for opposite things: AC6 wants the manifest to record *when* it was built,
 * and AC7 wants a rebuild to come out identical. The resolution is that
 * `built_at` is the one field allowed to move — and the test below does not
 * skip it, it asserts it is the *only* line that differs, with the clock
 * deliberately advanced between the two builds so that a build-time that never
 * changed could not pass by accident.
 *
 * Artefacts are compared byte for byte. File modes and mtimes are not compared:
 * a rebuild writes new inodes, and promising anything about their timestamps
 * would be promising something Mind does not control.
 *
 * Everything here happens under a temporary directory. No test in this file
 * reads `$HOME`, and none of them can: nothing in `rebuild` looks at it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DERIVATIONS } from "../../src/agent/derive.ts";
import { derivedPath, MANIFEST_FILE, parseManifest } from "../../src/agent/manifest.ts";
import { derivedStatus, rebuildDerived } from "../../src/agent/rebuild.ts";
import { DERIVED_DIR, SOUL_DIR, templateFiles } from "../../src/agent/template.ts";
import { renderSoul } from "../../src/soul/render.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("example");
const RENDERED = derivedPath("soul/rendered.md");
const MANIFEST = derivedPath(MANIFEST_FILE);

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A bare agent repository, with no `.git` and no `.mind`. */
async function makeRepo(name = "example"): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "mind-agent-"));
  scratch.push(repo);
  for (const file of templateFiles(SUBJECT, name)) {
    const path = join(repo, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  return repo;
}

/** A clock that hands out a different, increasing instant on every call. */
function ticking(startMs = Date.UTC(2026, 8, 21, 12, 0, 0)): () => Date {
  let ms = startMs;
  return () => new Date((ms += 60_000));
}

async function build(repo: string, now: () => Date) {
  const result = await rebuildDerived(repo, { subject: SUBJECT, now });
  if (!result.ok) throw new Error(`rebuild failed: ${JSON.stringify(result.issues)}`);
  return result;
}

describe("rebuild", () => {
  test("it writes every artefact the register names, and a manifest", async () => {
    const repo = await makeRepo();
    const result = await build(repo, ticking());

    // The full-text index is rebuilt from memory/ like any other artefact
    // (D-038), so `rebuild` owns it rather than sweeping it out.
    expect(result.built).toEqual([RENDERED, ".mind/index/fts.sqlite", MANIFEST]);
    expect(result.removed).toEqual([]);

    const rendered = await readFile(join(repo, RENDERED), "utf8");
    const loaded = await loadSoul(join(repo, SOUL_DIR), SUBJECT);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(rendered).toBe(`${renderSoul(loaded.soul)}\n`);
  });

  test("AC7 — rm -rf .mind, rebuild, and only built_at is different", async () => {
    const repo = await makeRepo();
    const clock = ticking();

    await build(repo, clock);
    const firstRendered = await readFile(join(repo, RENDERED), "utf8");
    const firstManifest = await readFile(join(repo, MANIFEST), "utf8");

    await rm(join(repo, DERIVED_DIR), { recursive: true, force: true });
    expect(await Bun.file(join(repo, MANIFEST)).exists()).toBe(false);

    await build(repo, clock);
    const secondRendered = await readFile(join(repo, RENDERED), "utf8");
    const secondManifest = await readFile(join(repo, MANIFEST), "utf8");

    expect(secondRendered).toBe(firstRendered);

    // Not "ignore built_at and compare the rest" — every line that differs has
    // to *be* built_at, and the clock moved, so at least one line must differ.
    const before = firstManifest.split("\n");
    const after = secondManifest.split("\n");
    expect(after).toHaveLength(before.length);
    const differing = before.map((line, index) => [line, after[index]!] as const).filter(([a, b]) => a !== b);
    expect(differing).toHaveLength(1);
    expect(differing[0]![0]).toContain("built_at");

    const parsed = parseManifest(secondManifest)!;
    expect(parsed.built_at).not.toBe(parseManifest(firstManifest)!.built_at);
    expect({ ...parsed, built_at: "" }).toEqual({ ...parseManifest(firstManifest)!, built_at: "" });
  });

  test("a rebuild over an existing .mind is the same as one over nothing", async () => {
    const repo = await makeRepo();
    const clock = ticking();

    await build(repo, clock);
    const fromNothing = await readFile(join(repo, RENDERED), "utf8");

    await build(repo, clock);
    expect(await readFile(join(repo, RENDERED), "utf8")).toBe(fromNothing);
  });

  test("a file no derivation owns is swept out, and named", async () => {
    const repo = await makeRepo();
    await build(repo, ticking());

    await mkdir(join(repo, DERIVED_DIR, "observer"), { recursive: true });
    await writeFile(join(repo, DERIVED_DIR, "observer", "raw.jsonl"), "{}\n");

    const stale = await derivedStatus(repo, SUBJECT);
    expect(stale.state).toBe("stale");
    expect(stale.unowned).toEqual([derivedPath("observer/raw.jsonl")]);

    const result = await build(repo, ticking());
    expect(result.removed).toEqual([derivedPath("observer/raw.jsonl")]);
    expect(await Bun.file(join(repo, DERIVED_DIR, "observer", "raw.jsonl")).exists()).toBe(false);
    expect((await derivedStatus(repo, SUBJECT)).state).toBe("fresh");
  });

  test("I-3 — a rebuild for the wrong subject is refused, and writes nothing", async () => {
    const repo = await makeRepo();
    const result = await rebuildDerived(repo, { subject: subjectId("somebody-else"), now: ticking() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.file === `${SOUL_DIR}/role.md`)).toBe(true);
    expect(await Bun.file(join(repo, MANIFEST)).exists()).toBe(false);
  });

  test("a soul that is not there is a list of issues, not an exception", async () => {
    const repo = await mkdtemp(join(tmpdir(), "mind-agent-"));
    scratch.push(repo);
    const result = await rebuildDerived(repo, { subject: SUBJECT, now: ticking() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.file).sort()).toEqual([
      `${SOUL_DIR}/person.md`,
      `${SOUL_DIR}/role.md`,
    ]);
  });

  test("an interrupted rebuild leaves no staging directory behind", async () => {
    const repo = await makeRepo();
    await build(repo, ticking());
    await rebuildDerived(repo, { subject: subjectId("somebody-else"), now: ticking() });

    const entries = await readdir(repo);
    expect(entries.filter((entry) => entry.includes("rebuilding") || entry.includes("replaced"))).toEqual([]);
  });
});

describe("derived status", () => {
  test("missing before anything is built — not an error, a fresh clone", async () => {
    const repo = await makeRepo();
    const status = await derivedStatus(repo, SUBJECT);
    expect(status.state).toBe("missing");
    expect(status.reason).toContain(MANIFEST_FILE);
  });

  test("fresh right after a build", async () => {
    const repo = await makeRepo();
    await build(repo, ticking());
    const status = await derivedStatus(repo, SUBJECT);
    expect(status.state).toBe("fresh");
    expect(status.reason).toContain(`${DERIVATIONS.length} artefact`);
  });

  test("AC6 — stale the moment a source file changes", async () => {
    const repo = await makeRepo();
    await build(repo, ticking());

    const role = join(repo, SOUL_DIR, "role.md");
    await writeFile(role, (await readFile(role, "utf8")).replace("not described yet", "tends a fixture"));

    const status = await derivedStatus(repo, SUBJECT);
    expect(status.state).toBe("stale");
    expect(status.reason).toContain(`${SOUL_DIR}/role.md`);

    await build(repo, ticking());
    expect((await derivedStatus(repo, SUBJECT)).state).toBe("fresh");
    expect(await readFile(join(repo, RENDERED), "utf8")).toContain("tends a fixture");
  });

  test("stale when an artefact was edited after it was built", async () => {
    const repo = await makeRepo();
    await build(repo, ticking());
    await writeFile(join(repo, RENDERED), "edited by hand\n");

    const status = await derivedStatus(repo, SUBJECT);
    expect(status.state).toBe("stale");
    expect(status.reason).toContain(RENDERED);
  });

  test("stale when an artefact was deleted on its own", async () => {
    const repo = await makeRepo();
    await build(repo, ticking());
    await rm(join(repo, RENDERED));

    expect((await derivedStatus(repo, SUBJECT)).state).toBe("stale");
  });

  test("stale for another subject's build (I-3)", async () => {
    const repo = await makeRepo();
    await build(repo, ticking());

    const status = await derivedStatus(repo, subjectId("somebody-else"));
    expect(status.state).toBe("stale");
    expect(status.reason).toContain("somebody-else");
  });

  test("stale when a different engine built it", async () => {
    const repo = await makeRepo();
    await build(repo, ticking());

    const status = await derivedStatus(repo, SUBJECT, "mind@99.0.0");
    expect(status.state).toBe("stale");
    expect(status.reason).toContain("99.0.0");
  });

  test("stale when the manifest is not readable as one", async () => {
    const repo = await makeRepo();
    await build(repo, ticking());
    await writeFile(join(repo, MANIFEST), "{ not json\n");

    const status = await derivedStatus(repo, SUBJECT);
    expect(status.state).toBe("stale");
    expect(status.reason).toContain("cannot be read");
  });
});

