/**
 * S1.6 AC5 — one identity's personal data must not appear in another's.
 *
 * D-011 calls this the most serious failure this system has: *ข้อมูลส่วนตัวของ
 * คนหนึ่งโผล่ในปากของ agent อีกตัว*. `test/guard/personal.test.ts` already
 * checks that two subjects resolve to two directories. This file checks the
 * property that actually follows from it, which is stronger and is the one AC5
 * asks for:
 *
 * - **every** path either identity resolves is outside the other's tree, at
 *   whole path segments, so `alpha` and `alpha-keeper` cannot nest;
 * - data planted under one is invisible to a walk of everything the other
 *   resolves — not filtered out, not found and skipped: not reachable;
 * - and there is **one** place in the engine — `src/` and `bin/` both — that
 *   composes a personal path, so the two properties above are facts about the
 *   address rather than habits of the callers.
 *
 * The third is the tripwire, and it is the only one that survives a refactor.
 * Nothing here unwraps a `Personal<T>` or reads a record's contents; the test
 * is about where bytes live, not what they say.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { ensurePersonalDir, personalDir } from "../../src/guard/personal.ts";
import { observerDir } from "../../src/observer/store.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { literalArguments, sourceFiles } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");
const BIN = join(ROOT, "bin");
/** The one file allowed to say where personal data lives. */
const RESOLVER = join("src", "guard", "personal.ts");
/** Named so the scan's scope cannot go quiet — see the tripwire's guard. */
const ENTRY = join("bin", "mind.ts");

// Deliberately a prefix pair. `alpha` is a prefix of `alpha-keeper` as a
// *string*, and a resolver that compared strings rather than segments would
// call one tree part of the other.
const A = subjectId("alpha");
const B = subjectId("alpha-keeper");

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-disjoint-"));
  scratch.push(dir);
  return dir;
}

/** True when `inner` is inside `outer`, compared segment by segment. */
function inside(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/** Every path a subject's personal data can be addressed at today. */
async function placesOf(
  env: { readonly home: string; readonly env: Record<string, string> },
  subject: SubjectId,
): Promise<readonly string[]> {
  const personal = await personalDir(env, subject);
  const observer = await observerDir(env, subject);
  expect(personal.ok && observer.ok).toBe(true);
  return [personal.path, observer.path];
}

/** Every file under `dir`, recursively. Empty when it does not exist. */
async function walk(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

describe("two identities, two trees", () => {
  test("every address of one is outside every address of the other", async () => {
    const home = await sandbox();
    const env = { home, env: { XDG_DATA_HOME: join(home, "data") } };

    const mine = await placesOf(env, A);
    const theirs = await placesOf(env, B);

    for (const ours of mine) {
      for (const other of theirs) {
        expect(inside(ours, other), `${ours} is inside ${other}`).toBe(false);
        expect(inside(other, ours), `${other} is inside ${ours}`).toBe(false);
      }
    }

    // The observer tree is inside its *own* subject's personal directory, which
    // is what makes `erase --personal` reach it in one move (S7.2).
    expect(inside(mine[1]!, mine[0]!)).toBe(true);
    expect(inside(theirs[1]!, theirs[0]!)).toBe(true);
  });

  test("what is planted under one is not reachable from anything the other resolves", async () => {
    const home = await sandbox();
    const env = { home, env: { XDG_DATA_HOME: join(home, "data") } };

    const mine = await ensurePersonalDir(env, A);
    const theirs = await ensurePersonalDir(env, B);
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;

    // Synthetic on both sides (D-021), and distinguishable, so "found nothing"
    // cannot be confused with "found the wrong one".
    await writeFile(join(mine.path, "note.txt"), "alpha's own sentence, kept out of git\n");
    await writeFile(join(theirs.path, "note.txt"), "alpha-keeper's own sentence, kept out of git\n");

    for (const place of await placesOf(env, B)) {
      for (const file of await walk(place)) {
        expect(inside(file, mine.path), `${file} is inside ${mine.path}`).toBe(false);
        expect(await Bun.file(file).text()).not.toContain("alpha's own sentence");
      }
    }

    // And the same in the other direction, because AC5 is symmetric and a
    // one-way check would pass on a resolver that always returned A's tree.
    for (const place of await placesOf(env, A)) {
      for (const file of await walk(place)) {
        expect(await Bun.file(file).text()).not.toContain("alpha-keeper's own sentence");
      }
    }
  });

  test("a data root that is inside git refuses for both, rather than for one", async () => {
    // The refusal is a property of the root, so it cannot be true of one
    // identity and false of the next — which would be a tree half in git.
    const home = await sandbox();
    const env = { home, env: { XDG_DATA_HOME: ROOT } };

    for (const subject of [A, B]) {
      const resolved = await personalDir(env, subject);
      expect(resolved.ok, subject).toBe(false);
    }
  });
});

describe("the tripwire — one place composes a personal path", () => {
  test("nothing outside the resolver joins a `personal` segment", async () => {
    // `src/` **and** `bin/`. This scanned `src/` alone while the CLI was one
    // file that only printed; `bin/` is now fourteen files that parse `--personal`
    // and decide what `erase` deletes, and a path composed there would have been
    // invisible to the one check whose job is to notice. The other gates over
    // this repository (`no-push`, `personal-type`, `egress`, `capture-notice`)
    // already scan both — this one had fallen behind them. Widened over a `bin/`
    // that composes no such path today, so the list below was `[]` before and
    // after.
    const files = [...(await sourceFiles(SRC)), ...(await sourceFiles(BIN))];
    // Guards the scope: an empty or src-only file list makes the assertion
    // vacuous, and `src/` alone already clears 20.
    expect(files.length).toBeGreaterThan(20);
    expect(files.map((path) => relative(ROOT, path))).toContain(ENTRY);

    const offenders: string[] = [];
    for (const path of files) {
      const rel = relative(ROOT, path);
      if (rel === RESOLVER) continue;
      for (const hit of literalArguments(path, await Bun.file(path).text(), "join", ["personal"])) {
        offenders.push(`${rel}: ${hit}`);
      }
    }

    expect(
      offenders,
      "personal data has one address and `personalDir` is it. A second place composing that " +
        "path is a second answer to which identity a file belongs to (I-3, D-014)",
    ).toEqual([]);
  }, 30_000);

  test("the control: it fires on a second resolver and not on ordinary source", () => {
    const second = `const dir = join(dataRoot(home, env), subject, "personal");`;
    expect(literalArguments("x.ts", second, "join", ["personal"])).toEqual([
      `1: join("personal")`,
    ]);

    // The words that must not trip it: a scope comparison and a sentence.
    const scope = `if (scope === "personal") return planPersonal();`;
    expect(literalArguments("x.ts", scope, "join", ["personal"])).toEqual([]);
    const prose = `// data flagged personal lives under join(root, "personal")\nexport const x = 1;`;
    expect(literalArguments("x.ts", prose, "join", ["personal"])).toEqual([]);
    // And the one `bin/` really contains, now that `bin/` is in the scan:
    // `--personal` as the name of a flag that takes no value. A gate that called
    // this a violation would be a gate somebody deletes.
    const flag = `const { options } = parseArgs(argv, ["yes", "json", "personal"]);`;
    expect(literalArguments("x.ts", flag, "join", ["personal"])).toEqual([]);
  });

  test("the control: the resolver it exempts really is the one doing it", async () => {
    const source = await Bun.file(join(ROOT, RESOLVER)).text();
    expect(
      literalArguments(RESOLVER, source, "join", ["personal"]),
      `${RESOLVER} is exempt but composes no personal path`,
    ).not.toEqual([]);
  });
});
