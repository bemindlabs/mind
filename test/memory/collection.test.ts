/**
 * S1.6 AC4, the half that exists — the address, and the tripwire under it.
 *
 * AC4 asks that a query by B cannot reach A's memory. There is no store in this
 * repository (`rag` is registered `not-built`), so the query half cannot be
 * exercised and S4.1 owes it. What *can* be settled now is the half that would
 * otherwise be decided by whoever writes the client first: **the address**.
 *
 * Two identities are isolated in a vector store exactly when they address
 * different collections, so the two things checked here are that the name is a
 * function of the subject and that there is nowhere else in the engine — `src/`
 * or `bin/` — a name can be made. The second is the tripwire, and it is why this
 * file is not just three assertions about string concatenation: a naming rule
 * with a second implementation is not a naming rule.
 */

import { describe, expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";
import {
  collectionFor,
  collidesWith,
  COLLECTION_LIMITS,
  COLLECTION_PREFIX,
  subjectOfCollection,
} from "../../src/memory/collection.ts";
import { placeOf } from "../../src/erase/places.ts";
import { subjectId } from "../../src/types.ts";
import { globalsUsed, sourceFiles } from "../support/ast.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");
const BIN = join(ROOT, "bin");
const HOME = join("src", "memory", "collection.ts");
/** Named so the scan's scope cannot go quiet — see the tripwire's guard. */
const ENTRY = join("bin", "mind.ts");

const ALPHA = subjectId("alpha-keeper");
const BETA = subjectId("beta-keeper");

describe("the address", () => {
  test("D-007's name, derived from the subject and nothing else", () => {
    expect(collectionFor(ALPHA)).toBe("mind__alpha-keeper");
    expect(COLLECTION_PREFIX).toBe("mind__");
    // Twice is the same answer: a name with a timestamp or a counter in it
    // would make "drop this subject's collection" a search rather than a name.
    expect(collectionFor(ALPHA)).toBe(collectionFor(ALPHA));
  });

  test("I-3 — two subjects can never share one", () => {
    expect(collectionFor(ALPHA)).not.toBe(collectionFor(BETA));
    expect(collidesWith(ALPHA, BETA)).toBe(false);
    expect(collidesWith(ALPHA, ALPHA)).toBe(true);
  });

  test("every subject id is already a valid name — nothing is folded away", () => {
    // If two subjects could be sanitised onto one name, isolation would fail
    // silently for exactly the pair nobody thought of. The alphabet a subject
    // id is validated against is what makes that impossible.
    const edges = ["a", "z9", "a-b_c", "0", "a".repeat(64)].map(subjectId);
    const names = edges.map((subject) => collectionFor(subject));
    expect(new Set(names).size).toBe(edges.length);
    for (const [index, name] of names.entries()) {
      expect(subjectOfCollection(name)).toBe(edges[index]!);
    }
  });
});

describe("reading a name Mind did not write", () => {
  test("a collection that is not Mind's is not claimed", () => {
    // An erase run lists a store and has to decide what is its own. Guessing
    // wrong in this direction drops somebody else's data.
    expect(subjectOfCollection("docs")).toBeUndefined();
    expect(subjectOfCollection(`${COLLECTION_PREFIX.slice(0, -1)}alpha`)).toBeUndefined();
    expect(subjectOfCollection("other__alpha-keeper")).toBeUndefined();
    expect(subjectOfCollection("")).toBeUndefined();
  });

  test("the prefix alone is not enough — what follows must be a subject id", () => {
    const prefix = COLLECTION_PREFIX;
    expect(subjectOfCollection(prefix)).toBeUndefined();
    expect(subjectOfCollection(`${prefix}Alpha`)).toBeUndefined();
    expect(subjectOfCollection(`${prefix}-leading-dash`)).toBeUndefined();
    expect(subjectOfCollection(`${prefix}has spaces`)).toBeUndefined();
    expect(subjectOfCollection(`${prefix}${"a".repeat(65)}`)).toBeUndefined();
  });
});

describe("whose a collection is", () => {
  test("the name carries the subject, and an erase of one subject never names another's", () => {
    expect(collectionFor(ALPHA)).toBe(`${COLLECTION_PREFIX}alpha-keeper`);
    expect(subjectOfCollection(collectionFor(ALPHA))).toBe(ALPHA);
    expect(collectionFor(ALPHA)).not.toBe(collectionFor(BETA));
  });
});

describe("what the name does not prove", () => {
  test("the limits refuse the over-promise AC4 invites", () => {
    const text = COLLECTION_LIMITS.join("\n");
    // The over-promise AC4 invites is "isolated", and the store has no access
    // control of its own. The limits say where the isolation stops.
    expect(text).toContain("S4.1");
    expect(text).toContain("no per-collection access control");
    expect(placeOf("rag").status).toBe("implemented");
  });

  test("the place that holds the store names the function that names it", () => {
    expect(placeOf("rag").what).toContain("collectionFor");
  });
});

describe("the tripwire — one name, one place it is made", () => {
  /**
   * Every file of the engine — `src/` and `bin/` — in one list.
   *
   * Both, because `erase` is a CLI command: the place most likely to build a
   * collection name by hand is the one that has to name every collection it is
   * about to drop, and that code is in `bin/commands/erase.ts`. This scanned
   * `src/` alone, from when `bin/` was one file. Widened over a `bin/` that
   * names neither the prefix nor the constant today, so both lists below were
   * what they are now before the widening too.
   */
  async function engineFiles(): Promise<string[]> {
    return [...(await sourceFiles(SRC)), ...(await sourceFiles(BIN))];
  }

  /** Every engine file whose text holds the literal prefix. */
  async function filesNaming(needle: string): Promise<string[]> {
    const hits: string[] = [];
    for (const path of await engineFiles()) {
      if ((await Bun.file(path).text()).includes(needle)) hits.push(relative(ROOT, path));
    }
    return hits;
  }

  test("the scan looks at both halves of the engine", async () => {
    // Guards the two tests below: each of them asserts that a list is short, and
    // a scan that had quietly stopped looking at `bin/` would make them shorter
    // still while reading exactly the same.
    const files = (await engineFiles()).map((path) => relative(ROOT, path));
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(ENTRY);
    expect(files).toContain(HOME);
  });

  test("the literal collection prefix appears in exactly one source file", async () => {
    // A second place writing this string is a second naming rule, and the day
    // the two disagree is the day one subject's records land in another's
    // collection with nothing in review to show it.
    expect(await filesNaming(COLLECTION_PREFIX)).toEqual([HOME]);
  });

  test("and the constant is referenced only where it is defined", async () => {
    // Importing the prefix and building a name elsewhere would pass the check
    // above while doing exactly what it forbids. So the identifier is pinned
    // too, on the syntax tree rather than in the text.
    const elsewhere: string[] = [];
    for (const path of await engineFiles()) {
      const rel = relative(ROOT, path);
      if (rel === HOME) continue;
      const source = await Bun.file(path).text();
      for (const hit of globalsUsed(path, source, ["COLLECTION_PREFIX"])) {
        elsewhere.push(`${rel}: ${hit}`);
      }
    }
    expect(
      elsewhere,
      "a collection name must come from collectionFor, so that `erase` can name every one of " +
        "them and two subjects can never be given the same",
    ).toEqual([]);
  });

  test("the control: both checks really fire", () => {
    // The identifier check, on source that does the forbidden thing.
    const sneaky = `import { COLLECTION_PREFIX } from "../memory/collection.ts";\n` +
      `export const name = \`\${COLLECTION_PREFIX}shared\`;`;
    expect(globalsUsed("x.ts", sneaky, ["COLLECTION_PREFIX"])).toHaveLength(2);

    // And not on the same word inside a comment or a string, which is what
    // keeps this file's own prose from tripping it.
    const talkative = `// COLLECTION_PREFIX is defined in src/memory/collection.ts\nexport const x = 1;`;
    expect(globalsUsed("x.ts", talkative, ["COLLECTION_PREFIX"])).toEqual([]);
  });
});
