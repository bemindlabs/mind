/**
 * S2.2 AC5 / D-022 — nothing reads the ledger back into a decision.
 *
 * The sentence being guarded is: *"ledger ไม่เป็นแหล่งความจริงของสิ่งใดที่ agent
 * ต้องใช้ — ไม่มีโค้ดใดอ่าน ledger กลับเข้า prompt/ความจำ/การตัดสินใจ · ลบทิ้งแล้ว
 * พฤติกรรม agent เท่าเดิมทุกอย่าง"*. `recon1` measured on 2026-09-22 that it held:
 * exactly one caller of `query()` existed, in `bin/commands/ledger.ts`, and it
 * called it to print a table. What it also found is that **nothing tested it** —
 * so a task that read the ledger back into a prompt would have landed green, and
 * E5 is the epic whose whole job is to give an agent something to decide with.
 *
 * Two layers, because one of them alone would be the wrong shape.
 *
 * ## Layer A — structural, over the whole tree
 *
 * The question is *who receives ledger content?*, and the answer is pinned as an
 * **allowance on the write side** rather than a denylist of read verbs. A
 * denylist has to name `query`, then `read`, then `tail`, then whatever the next
 * reader is called, and it is wrong the moment somebody picks a word nobody
 * thought of — that is the lesson `w9`/grok left behind, and it is the one that
 * matters here. The write side is the opposite kind of list: S2.2 AC2 closed it
 * (`append` is the only writing operation there is, and there will not be a
 * second), so it is a list that stays still.
 *
 * So: any file outside `src/ledger/` may take a name out of `src/ledger/` only if
 * the name is on {@link WRITE_SIDE}, or the file is one of the {@link READERS}
 * and the name is one that reader declares. Everything else is a read, whether it
 * is called `query` today or `tail` tomorrow.
 *
 * Erased names are free, and the freedom is checked at the declaration rather
 * than at the import: `LedgerEntry` is an interface, so no spelling of importing
 * it can move a byte. `import type { query }` would be free too and would also be
 * useless, which is the same fact from the other side.
 *
 * ## Layer B — behavioural, over the sentence itself
 *
 * Layer A guards a mechanism. D-022's promise is about behaviour, and the two are
 * not the same claim: a mechanism can be intact while the promise is broken by a
 * path the mechanism does not cover. So a ledger holding a canary is put on disk,
 * a real `mind turn` is run against a stub daemon that records what it was
 * handed, and then the ledger is deleted and the same turn is run again. The
 * canary must never reach the backend, stdout or stderr; and the two runs must
 * agree byte for byte on what the backend received, on stdout, and on the exit
 * code.
 *
 * ## What neither layer can see, stated rather than implied
 *
 * - **`scripts/`.** The walk covers `src/` and `bin/` — what ships. A script that
 *   read the ledger would not be caught here.
 * - **A path with no `ledger` in it.** The indirect rule below refuses
 *   `join(…, "ledger", …)` outside the ledger itself; an absolute path typed out
 *   in full, or a segment built by concatenation, is invisible to it.
 * - **Layer B covers `turn` only.** `as`, `soul verify` and every later command
 *   are outside it.
 * - **A new read inside the two allowed files.** `bin/commands/ledger.ts` is
 *   allowed to call `query`; nothing here stops it from putting the result
 *   somewhere it does not belong. That is the residue of allowing a reader at all,
 *   and it is why the allowance records a *verb* per file and not just a name.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  formatLine,
  LEDGER_VERSION,
  monthFileName,
  parseLine,
  type LedgerEntry,
} from "../../src/ledger/index.ts";
import { STATE_FILE_MODE } from "../../src/state.ts";
import { subjectId } from "../../src/types.ts";
import { barePath, BUN } from "../support/bare-path.ts";
import {
  exportedNames,
  importedNames,
  literalArguments,
  assertionEscapes,
  sourceFiles,
  SIDE_EFFECT_ONLY,
  WHOLE_MODULE,
} from "../support/ast.ts";
import { serveOllama } from "../support/stub-ollama.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const LEDGER = join(ROOT, "src", "ledger");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");

/**
 * What to do when layer A goes red — in the message, not in somebody's head.
 *
 * The day D-029 is decided, somebody may want this guard gone because it is in
 * the way. Making the right path easier than the wrong one is the only thing that
 * decides which one gets taken, so the right path is spelled out here, at the
 * moment of the failure, in the order the steps have to happen.
 */
const RED =
  "S2.2 AC5 · D-022 — the ledger must not be the source of truth for anything the agent needs. " +
  "No code may read it back into a prompt, into memory, or into a decision, and deleting it must " +
  "leave the agent's behaviour unchanged.\n" +
  "Each line above is a name taken out of src/ledger/ that this guard does not recognise as " +
  "write-side, so it is treated as a read.\n" +
  "  · If it really is a write or a constant, add it to WRITE_SIDE in this file **with its verb** " +
  "— the allowance records why each name is safe, not merely that it is listed.\n" +
  "  · If it is a read, the decision has to move first: amend D-022 (D-029 is where a relaxation " +
  "would be argued) and only then widen the allowance to match the amended decision.\n" +
  "Deleting this test is not one of those two options.";

/**
 * Names any file may take out of `src/ledger/`, each with the verb that makes it
 * safe.
 *
 * All five are either a write or a string constant. None of them can return a
 * line of the ledger to its caller, which is the property being bought — not
 * "these are the ones currently imported".
 *
 * Every entry is asserted to be *in use* below. An allowance nobody uses is a
 * door left open for the next person to walk through unnoticed, which is what
 * `gate2` found in `EXEMPT`: four entries whose stated reasons were false and
 * which nothing had needed for weeks.
 */
const WRITE_SIDE: ReadonlyMap<string, string> = new Map([
  ["RecordingExec", "write — wraps one backend and appends one line per prompt it is handed"],
  ["canAppend", "write — the probe `turn` runs before a prompt goes out, so it can refuse to send"],
  ["UNDELETABLE", "constant — the sentences `ledger forget` and `erase` print about what deletion cannot reach"],
  ["VENDORS_HOLD", "constant — one of those sentences, said again before a cloud send (S7.2 AC4)"],
  ["append", "write — one line in, the file's path out; A2A records every message before it is delivered or sent (S8.2 AC5, D-063)"],
  [
    "ledgerDir",
    "path — a `join` over the state root that opens nothing. The data map (src/erase/map.ts) names " +
      "the ledger's directory with it so erase and `deploy plan` (S13.1) agree on where it is; deploy " +
      "plan stats its size and never opens a line. Reading what is in it is still a READERS verb",
  ],
  [
    "modelOfTurn",
    "write — the model facts of the line about to be written (D-142), computed from the turn that just ran; " +
      "`turn --json` says the same of the answering backend. Pure over that turn's own result: it opens no " +
      "file and returns no line",
  ],
]);

/** A file allowed to read the ledger, the verb that allows it, and why. */
interface Reader {
  /** Repo-relative, so a rename is a red test rather than a silent pass. */
  readonly file: string;
  readonly verb: "show" | "delete" | "report";
  readonly why: string;
  readonly names: readonly string[];
}

/**
 * The four files allowed to read the ledger back, with the verb each reads for.
 *
 * The verb is the whole allowance. D-022 does not forbid reading the ledger — it
 * forbids reading it *into a decision*. Showing an owner their own record and
 * deleting it on their instruction are the two operations I-4 **requires**, and
 * neither one feeds anything the agent then acts on. The third verb, `report`, is
 * D-106's: a signed usage report is made from the ledger, per turn, and handed to
 * whoever the owner sends it to — metadata only, and read back by nothing the agent
 * runs (D-138).
 */
const READERS: readonly Reader[] = [
  {
    file: join("bin", "commands", "ledger.ts"),
    verb: "show",
    why:
      "reads to print. `ledger show` puts the owner's own record in front of them and the process " +
      "exits; nothing downstream consumes what it read. I-2 is the reason this exists at all — a " +
      "record only the program can read is not the owner's.",
    names: ["query", "ledgerDir", "planForget", "commitForget", "removeLedgerDir"],
  },
  {
    file: join("src", "erase", "plan.ts"),
    verb: "delete",
    why:
      "reads to delete, which I-4 leaves no way around: `erase` has to say what would go before it " +
      "goes, and `planForget` reads the lines to answer that. It is the one read the agent's own " +
      "behaviour cannot depend on, because what it produces is the absence of the thing it read.",
    names: ["planForget", "commitForget", "removeLedgerDirAt"],
  },
  {
    file: join("bin", "commands", "web.ts"),
    verb: "show",
    why:
      "reads to show, as `ledger show` does, in a page instead of a terminal (D-060): the ten latest " +
      "turns under \"Recently\". The list goes to the owner's browser and nowhere else; no button on " +
      "the page and nothing the agent runs reads it back.",
    names: ["query"],
  },
  {
    file: join("src", "identity", "report.ts"),
    verb: "report",
    why:
      "reads to report, as D-106 decided: the usage report is the owner's own ledger, one row per model " +
      "delivery, signed with the agent's key (S15.8, D-138). It copies ids, times, backend, model and token " +
      "counts by name — never a prompt, an answer or their sizes — and nothing the agent runs reads a report " +
      "back, so deleting the ledger changes what a report lists and not what the agent does.",
    names: ["query"],
  },
];

/** The `import * as`/`await import()`/bare-import shapes, plus a default nobody exports. */
const TAKES_EVERYTHING: readonly string[] = [WHOLE_MODULE, SIDE_EFFECT_ONLY, "default"];

/** One name one file takes out of `src/ledger/`. */
interface Edge {
  /** Repo-relative path of the file doing the importing. */
  readonly file: string;
  readonly name: string;
  readonly line: number;
}

/** Whether `path` is inside `src/ledger/`, which is allowed to be itself. */
function insideLedger(path: string): boolean {
  return path === LEDGER || path.startsWith(LEDGER + sep);
}

/** Every name `source` — saved at `absPath` — takes out of `src/ledger/`. */
function ledgerEdges(absPath: string, source: string): Edge[] {
  if (insideLedger(absPath)) return [];
  const file = relative(ROOT, absPath);
  return importedNames(absPath, source)
    .filter((binding) => binding.specifier.startsWith("."))
    .filter((binding) => insideLedger(resolve(dirname(absPath), binding.specifier)))
    .map((binding) => ({ file, name: binding.name, line: binding.line }));
}

/** What an edge is, once the ledger's own exports have had their say. */
type Verdict =
  | { readonly kind: "erased" }
  | { readonly kind: "write-side"; readonly why: string }
  | { readonly kind: "reader"; readonly verb: string }
  | { readonly kind: "read-back"; readonly why: string };

function classify(edge: Edge, valueExports: ReadonlySet<string>): Verdict {
  if (TAKES_EVERYTHING.includes(edge.name)) {
    return {
      kind: "read-back",
      why:
        `takes the whole module (\`${edge.name}\`) — every read in it arrives too, and no list of ` +
        `names can narrow that`,
    };
  }
  // Not a value at run time, so no spelling of importing it moves a byte.
  if (!valueExports.has(edge.name)) return { kind: "erased" };

  const writeSide = WRITE_SIDE.get(edge.name);
  if (writeSide !== undefined) return { kind: "write-side", why: writeSide };

  const reader = READERS.find((candidate) => candidate.file === edge.file);
  if (reader !== undefined && reader.names.includes(edge.name)) {
    return { kind: "reader", verb: reader.verb };
  }
  return {
    kind: "read-back",
    why: `\`${edge.name}\` is not on the write-side allowance, so this guard reads it as a read`,
  };
}

/** Every `file:line: why` a file reads the ledger it is not allowed to read. */
function readBackHits(absPath: string, source: string, valueExports: ReadonlySet<string>): string[] {
  const hits: string[] = [];
  for (const edge of ledgerEdges(absPath, source)) {
    const verdict = classify(edge, valueExports);
    if (verdict.kind === "read-back") hits.push(`${edge.file}:${edge.line}: ${verdict.why}`);
  }
  return hits;
}

/** The ledger's exported names, split into the ones that exist at run time and the rest. */
async function ledgerExports(): Promise<{ values: Set<string>; types: Set<string> }> {
  const values = new Set<string>();
  const types = new Set<string>();
  for (const path of await sourceFiles(LEDGER)) {
    for (const exported of exportedNames(path, await Bun.file(path).text())) {
      if (exported.kind === "value") values.add(exported.name);
      else types.add(exported.name);
    }
  }
  return { values, types };
}

/** `src/identity/report.ts`, a declared reader, and the names of it that hand ledger content on (review L6). */
const REPORT = join(ROOT, "src", "identity", "report.ts");
const CARRIES = ["buildUsageReport", "usagePayload", "usageRow"];
const CARRIES_TO = [join("bin", "commands", "usage.ts")];

/**
 * A module path as a resolver would find it, whatever the spelling: no extension (`.ts`, `.js` and their
 * variants), and no trailing `/index`. `"../identity/report"`, `"../identity/report.js"` and
 * `"../identity/report.ts"` are one module to a bundler, so they are one module here (S15.8 re-review).
 */
function moduleOf(path: string): string {
  return path.replace(/[?#].*$/, "").replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/[\\/]index$/, "");
}

/** Every import of a ledger-carrying name out of the report module, split into allowed and not. */
function secondHop(absPath: string, source: string): { hits: string[]; allowed: string[] } {
  const hits: string[] = [];
  const allowed: string[] = [];
  if (moduleOf(absPath) === moduleOf(REPORT)) return { hits, allowed };
  const rel = relative(ROOT, absPath);
  for (const binding of importedNames(absPath, source)) {
    if (!binding.specifier.startsWith(".") || moduleOf(resolve(dirname(absPath), binding.specifier)) !== moduleOf(REPORT)) continue;
    if (!TAKES_EVERYTHING.includes(binding.name) && !CARRIES.includes(binding.name)) continue;
    if (CARRIES_TO.includes(rel)) allowed.push(`${rel}:${binding.name}`);
    else hits.push(`${rel}:${binding.line}: \`${binding.name}\` from src/identity/report.ts carries ledger content`);
  }
  return { hits, allowed };
}

describe("nothing reads the ledger back into a decision (S2.2 AC5, D-022)", () => {
  test("every name taken out of src/ledger/ is write-side, erased, or a declared reader's", async () => {
    const { values } = await ledgerExports();
    const files = [
      ...(await sourceFiles(join(ROOT, "src"))),
      ...(await sourceFiles(join(ROOT, "bin"))),
    ];

    // Scope guards. An empty file list or an empty export set would make the
    // assertion below vacuously true, and both are one typo away.
    expect(files.length).toBeGreaterThan(50);
    expect(values.size).toBeGreaterThan(5);

    const hits: string[] = [];
    const edges: Edge[] = [];
    for (const path of files) {
      const source = await Bun.file(path).text();
      edges.push(...ledgerEdges(path, source));
      hits.push(...readBackHits(path, source, values));
    }

    // And a guard on the walk itself: the edges have to exist. `turn` imports
    // the recorder and `erase` imports the deleter, so zero here would mean the
    // resolver stopped working, not that the tree got cleaner.
    expect(edges.length).toBeGreaterThan(5);

    expect(hits, RED).toEqual([]);
  }, 30_000);

  test("every allowance entry is in use — a door nobody walks through is still a door", async () => {
    const { values, types } = await ledgerExports();
    const files = [
      ...(await sourceFiles(join(ROOT, "src"))),
      ...(await sourceFiles(join(ROOT, "bin"))),
    ];

    const edges: Edge[] = [];
    for (const path of files) edges.push(...ledgerEdges(path, await Bun.file(path).text()));

    const stale: string[] = [];

    // (a) Every write-side name is imported by at least one file outside the
    // ledger, and is really a value the ledger exports. A name that no longer
    // exists, or that nobody needs any more, is an allowance that is silently
    // wider than the code it was written for.
    for (const [name, why] of WRITE_SIDE) {
      if (!values.has(name)) {
        stale.push(
          `WRITE_SIDE lists \`${name}\`, which src/ledger/ does not export as a value` +
            (types.has(name) ? " (it is a type — types need no allowance)" : ""),
        );
      } else if (!edges.some((edge) => edge.name === name)) {
        stale.push(`WRITE_SIDE lists \`${name}\` (${why}) and nothing outside src/ledger/ imports it`);
      }
    }

    // (b) The same, per reader: the file has to exist, has to import from the
    // ledger at all, and every name it claims has to be a name it really takes.
    for (const reader of READERS) {
      const own = edges.filter((edge) => edge.file === reader.file);
      if (own.length === 0) {
        stale.push(
          `READERS lists ${reader.file} as a reader (${reader.verb}) and it imports nothing from ` +
            `src/ledger/ — was it renamed, or did it stop needing the read?`,
        );
        continue;
      }
      for (const name of reader.names) {
        if (!values.has(name)) {
          stale.push(`${reader.file} is allowed \`${name}\`, which src/ledger/ no longer exports`);
        } else if (!own.some((edge) => edge.name === name)) {
          stale.push(
            `${reader.file} is allowed \`${name}\` to ${reader.verb} with, and does not import it`,
          );
        }
      }
    }

    expect(
      stale,
      "an unused allowance is the shape of gate2's EXEMPT: four entries with false reasons that " +
        "nothing had needed for weeks, each one a hole the next task could have walked through " +
        "without anybody noticing. Remove what is no longer used rather than leaving it listed.",
    ).toEqual([]);
  }, 30_000);

  test("the allowed readers are the ones the decisions name, with their verbs", () => {
    // Pinned as a value on purpose, unlike the name lists above. *How many files
    // may read the ledger* is the decision itself, not an implementation detail,
    // so a new one appearing has to be somebody's deliberate edit here. The third,
    // `web`, is D-060's: the same `show` as `ledger show`, in a browser. The fourth,
    // the usage report, is D-106's, placed by D-138.
    expect(READERS.map((reader) => `${reader.file} (${reader.verb})`)).toEqual([
      `${join("bin", "commands", "ledger.ts")} (show)`,
      `${join("src", "erase", "plan.ts")} (delete)`,
      `${join("bin", "commands", "web.ts")} (show)`,
      `${join("src", "identity", "report.ts")} (report)`,
    ]);
    // Every allowance carries its reason, which is the part a later reader needs:
    // seeing that a file is on a list says nothing about why it was allowed.
    for (const reader of READERS) expect(reader.why.length).toBeGreaterThan(80);
  });

  test("the second hop: what the report reader hands out, only `usage` takes (S15.8 review, L6)", async () => {
    // Layer A stops at the first import. `src/identity/report.ts` is allowed `query`, and exports functions that
    // return what it read — so without this, any file could import `buildUsageReport` and have the ledger in
    // hand without naming `src/ledger/` at all. The names that carry ledger content go to one command.
    const files = [...(await sourceFiles(join(ROOT, "src"))), ...(await sourceFiles(join(ROOT, "bin")))];
    const hits: string[] = [];
    const allowed: string[] = [];
    for (const path of files) {
      const found = secondHop(path, await Bun.file(path).text());
      hits.push(...found.hits);
      allowed.push(...found.allowed);
    }
    expect(hits, RED).toEqual([]);
    // Control: the allowance is in use — `usage report` does build a report — so the walk found the edge.
    expect(allowed).toContain(`${join("bin", "commands", "usage.ts")}:buildUsageReport`);
    // And the rule fires: the same import from anywhere else, or the whole module, is caught.
    const elsewhere = join(ROOT, "src", "soul", "render.ts");
    expect(secondHop(elsewhere, `import { buildUsageReport } from "../identity/report.ts";\n`).hits.length).toBe(1);
    expect(secondHop(elsewhere, `import * as report from "../identity/report.ts";\n`).hits.length).toBe(1);
    expect(secondHop(elsewhere, `import { printable, verifyUsageReport } from "../identity/report.ts";\n`).hits).toEqual([]);
    // Every spelling of the same module is the same module: extensionless, `.js`, and a directory index.
    for (const spelling of ["../identity/report", "../identity/report.js", "../identity/report.mts", "../identity/report.ts?x", "../identity/report#frag"]) {
      expect(secondHop(elsewhere, `import { buildUsageReport } from "${spelling}";\n`).hits.length, spelling).toBe(1);
    }
    expect(moduleOf(join(ROOT, "src", "identity", "report", "index.ts"))).toBe(moduleOf(join(ROOT, "src", "identity", "report.ts")));
    expect(secondHop(elsewhere, `import { buildUsageReport } from "../identity/reports";\n`).hits).toEqual([]);
  }, 30_000);

  test("nothing outside src/ledger/ builds a path with `ledger` in it, or parses a line", async () => {
    const files = [
      ...(await sourceFiles(join(ROOT, "src"))),
      ...(await sourceFiles(join(ROOT, "bin"))),
    ];

    // The second way in, and the one layer A cannot see: reading the files
    // directly and never importing the ledger at all. `ledgerDir` is the only
    // place that segment is written, and `parseLine` the only thing that turns a
    // line back into an entry, so both are kept where they are.
    const indirect: string[] = [];
    for (const path of files) {
      if (insideLedger(path)) continue;
      const source = await Bun.file(path).text();
      const rel = relative(ROOT, path);
      for (const callee of ["join", "resolve"]) {
        for (const hit of literalArguments(path, source, callee, ["ledger"])) {
          indirect.push(`${rel}:${hit}`);
        }
      }
      for (const hit of assertionEscapes(path, source, [], ["parseLine"])) {
        indirect.push(`${rel}:${hit}`);
      }
    }

    expect(
      indirect,
      "reading the ledger's files without importing the ledger is the same read wearing a " +
        "different hat. " + RED,
    ).toEqual([]);

    // The control lives in the sibling test below; this one would pass on an
    // empty tree, so the tree is checked to be non-empty here.
    expect(files.length).toBeGreaterThan(50);
  }, 30_000);

  test("the control — the checks fire on code that violates them, and not on code that does not", () => {
    const values = new Set(["query", "append", "canAppend", "parseLine", "RecordingExec"]);
    // `append` became a write-side name with D-063; `parseLine` stands in as the
    // name no declared reader asked for.
    const elsewhere = join(ROOT, "src", "soul", "render.ts");
    const allowed = join(ROOT, "bin", "commands", "ledger.ts");

    // Caught: the plain read, from a file with no allowance.
    expect(
      readBackHits(elsewhere, `import { query } from "../ledger/store.ts";\n`, values),
    ).toEqual([`${join("src", "soul", "render.ts")}:1: \`query\` is not on the write-side allowance, so this guard reads it as a read`]);

    // Caught: the three shapes that take everything, so no name list can help.
    for (const source of [
      `import * as ledger from "../ledger/index.ts";\n`,
      `import "../ledger/index.ts";\n`,
      `const { query } = await import("../ledger/store.ts");\n`,
    ]) {
      expect(readBackHits(elsewhere, source, values).length).toBe(1);
      expect(readBackHits(elsewhere, source, values)[0]).toContain("takes the whole module");
    }

    // Caught: laundering the read through a re-export in a third module. The
    // importer downstream would then be taking `query` from `src/soul/`, where
    // nothing is looking — so the re-export is where it has to be caught.
    expect(
      readBackHits(elsewhere, `export { query } from "../ledger/store.ts";\n`, values).length,
    ).toBe(1);

    // Caught: a rename does not help, because the name is read as the module
    // exports it and not as the importer spells it.
    expect(
      readBackHits(elsewhere, `import { query as look } from "../ledger/store.ts";\n`, values).length,
    ).toBe(1);

    // Not caught: the write side, from anywhere.
    expect(
      readBackHits(
        elsewhere,
        `import { RecordingExec, canAppend } from "../ledger/index.ts";\n`,
        values,
      ),
    ).toEqual([]);

    // Not caught: a name the ledger does not export as a value — erased, so it
    // can carry nothing, however it is spelled.
    expect(
      readBackHits(elsewhere, `import { LedgerEntry } from "../ledger/entry.ts";\n`, values),
    ).toEqual([]);

    // Not caught: the declared reader taking the name it declared.
    expect(
      readBackHits(allowed, `import { query } from "../../src/ledger/index.ts";\n`, values),
    ).toEqual([]);

    // Not caught: the declared reader is allowed *its* names and no others.
    expect(
      readBackHits(allowed, `import { parseLine } from "../../src/ledger/index.ts";\n`, values).length,
    ).toBe(1);

    // Not caught: an import that does not reach the ledger at all.
    expect(readBackHits(elsewhere, `import { sha256 } from "./index.ts";\n`, values)).toEqual([]);

    // And the indirect rule, both ways: a path built with the segment is a hit,
    // the same word as a place id or a property value is not.
    const built = `import { join } from "node:path";\nexport const d = join(root, "ledger", s);\n`;
    expect(literalArguments("x.ts", built, "join", ["ledger"]).length).toBe(1);
    const named = `export const p = { place: "ledger" };\nconst same = id === "ledger";\n`;
    expect(literalArguments("x.ts", named, "join", ["ledger"])).toEqual([]);
    expect(assertionEscapes("x.ts", `const p = parseLine(line);\n`, [], ["parseLine"]).length).toBe(1);
    expect(assertionEscapes("x.ts", `// parseLine is not called here\n`, [], ["parseLine"])).toEqual([]);
  });
});

/**
 * Names that vary between two identical runs, declared so a reader can see what
 * is being forgiven.
 *
 * `cli-parity.ts` opens with the sentence this list exists to honour: a declared
 * normalisation is ordinary, and a silent one is where a real difference goes to
 * hide. So each one is named, applied to both runs, and its hit count printed —
 * a normaliser that turns out to be dormant is worth knowing about too, because
 * it means the comparison below is stricter than it looks.
 */
interface Normaliser {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

const NORMALISED: readonly Normaliser[] = [
  {
    name: "the wall-clock duration on `turn`'s route line (`· 0.1s`)",
    pattern: /\b\d+\.\d+s\b/g,
    replacement: "<took>",
  },
  {
    name: "a uuid — the turn id, and the id of each ledger line",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: "<uuid>",
  },
  {
    name: "the loopback port the stub daemon was given",
    pattern: /127\.0\.0\.1:\d+/g,
    replacement: "127.0.0.1:<port>",
  },
];

/** Apply every normaliser, and say how many spans each one swallowed. */
function normalise(text: string): { text: string; applied: string[] } {
  let out = text;
  const applied: string[] = [];
  for (const rule of NORMALISED) {
    const hits = (out.match(rule.pattern) ?? []).length;
    applied.push(`${hits}× ${rule.name}`);
    out = out.replaceAll(rule.pattern, rule.replacement);
  }
  return { text: out, applied };
}

/** A fixed token, not a random one: the two runs have to be comparable. */
const TOKEN = "t0d022a5";
const CANARY = "canary-d022-4e91c7";

describe("deleting the ledger leaves the agent's behaviour unchanged (S2.2 AC5, D-022)", () => {
  test("a ledger full of canaries reaches nothing, and removing it changes nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-read-back-"));
    const state = join(home, "state");
    const bare = await barePath(home);
    const ollama = serveOllama();
    const subject = subjectId("example");
    const ledgerRoot = join(state, "mind", "ledger");
    const subjectDir = join(ledgerRoot, String(subject));

    /** One real line, in a month of its own so `at` does not depend on today. */
    const seeded: LedgerEntry = {
      v: LEDGER_VERSION,
      kind: "turn",
      id: "seed-line-1",
      turn: "seed-turn-1",
      at: "2026-01-15T10:00:00.000Z",
      subject,
      backend: "ollama",
      model: "stub",
      content: "full",
      prompt: `remember this: ${CANARY}`,
      prompt_bytes: `remember this: ${CANARY}`.length,
      text: `acknowledged, ${CANARY}`,
      text_bytes: `acknowledged, ${CANARY}`.length,
      confidence: "confirmed",
      exit: 0,
      duration_ms: 12,
      cost: null,
      identity: "system",
      soul_sha: null,
    };
    const seedFile = join(subjectDir, monthFileName(new Date(seeded.at)));

    const runTurn = async () => {
      const child = Bun.spawn(
        [
          BUN, "run", BIN, "turn", SOUL,
          "--subject", "example",
          "--prompt", `Reply with the token ${TOKEN} and nothing else.`,
          "--backend", "ollama",
          "--model", "stub",
        ],
        {
          cwd: ROOT,
          env: {
            HOME: home,
            PATH: bare,
            XDG_STATE_HOME: state,
            CODEX_HOME: join(home, ".codex"),
            OLLAMA_HOST: ollama.url,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      await child.exited;
      return { code: child.exitCode ?? -1, stdout, stderr };
    };

    try {
      // The seed is a line the real reader would accept. A malformed one would
      // be counted `unreadable` and skipped, and this test would then be proving
      // that Mind ignores garbage — which it is not what D-022 says.
      await mkdir(subjectDir, { recursive: true });
      await writeFile(seedFile, formatLine(seeded), { mode: STATE_FILE_MODE });
      expect(parseLine((await readFile(seedFile, "utf8")).trim()).ok).toBe(true);

      const withLedger = await runTurn();

      // The ledger really was there while the turn ran, and is still there
      // after — append-only, so the canary cannot have been consumed.
      expect(await readFile(seedFile, "utf8")).toContain(CANARY);

      // The turn worked, so the rest of this test is about a real turn.
      expect(withLedger.code).toBe(0);
      expect(withLedger.stdout.trim()).toBe(`${TOKEN} from ollama with-soul`);

      // D-022's first half: the record did not become context. Nothing on the
      // wire, and nothing on either stream either — a canary echoed into a
      // warning is still a canary that left the ledger.
      expect(ollama.systems.length).toBe(1);
      expect(ollama.systems[0]).not.toContain(CANARY);
      expect(ollama.prompts[0]).not.toContain(CANARY);
      expect(withLedger.stdout).not.toContain(CANARY);
      expect(withLedger.stderr).not.toContain(CANARY);

      // D-022's second half, and the reason this is a behavioural test rather
      // than a structural one: take the whole thing away.
      await rm(ledgerRoot, { recursive: true, force: true });
      expect(await Bun.file(seedFile).exists()).toBe(false);

      const withoutLedger = await runTurn();

      // Byte for byte, unnormalised, on the three things a caller can observe.
      expect(ollama.systems.length).toBe(2);
      expect(ollama.systems[1]).toBe(ollama.systems[0]!);
      expect(ollama.prompts[1]).toBe(ollama.prompts[0]!);
      expect(withoutLedger.stdout).toBe(withLedger.stdout);
      expect(withoutLedger.code).toBe(withLedger.code);

      // Stderr is compared through the declared normalisers, and what they
      // swallowed is printed rather than assumed — including when the answer is
      // zero, which means the comparison was exact after all.
      const before = normalise(withLedger.stderr);
      const after = normalise(withoutLedger.stderr);
      console.log(
        `stderr comparison — raw bytes ${
          withLedger.stderr === withoutLedger.stderr ? "already identical" : "differ"
        }; normalised away:\n  with a ledger:    ${before.applied.join(" · ")}\n` +
          `  without a ledger: ${after.applied.join(" · ")}`,
      );
      expect(after.text).toBe(before.text);

      // And the guard on the comparison itself: an empty stderr would make the
      // three assertions above agree about nothing.
      expect(before.text.length).toBeGreaterThan(20);
      expect(before.text).toContain("answered by ollama");
    } finally {
      await ollama.server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("the normalisers are named, and each does what it says", () => {
    // A control for the comparison above: a normaliser that matched everything
    // would make two different stderrs equal, and one that matched nothing would
    // make the comparison brittle for no reason. Both are checked here rather
    // than being trusted from their names.
    const sample =
      "mind: answered by ollama · identity arrived as system · 0.4s\n" +
      "turn 2f1c8a90-1b2c-4d5e-8f90-aabbccddeeff at 127.0.0.1:41234\n";
    const { text, applied } = normalise(sample);
    expect(text).toBe(
      "mind: answered by ollama · identity arrived as system · <took>\n" +
        "turn <uuid> at 127.0.0.1:<port>\n",
    );
    expect(applied).toEqual([
      "1× the wall-clock duration on `turn`'s route line (`· 0.1s`)",
      "1× a uuid — the turn id, and the id of each ledger line",
      "1× the loopback port the stub daemon was given",
    ]);

    // What they must *not* swallow: the words the comparison rests on.
    expect(normalise("answered by ollama").text).toBe("answered by ollama");
    expect(normalise(`${TOKEN} from ollama with-soul`).text).toBe(`${TOKEN} from ollama with-soul`);
    expect(normalise(CANARY).text).toBe(CANARY);
  });
});
