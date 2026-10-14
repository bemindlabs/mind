/**
 * S0.1 AC4 — every interface that reaches a subject's data takes a
 * `SubjectId`, enforced by the type rather than by intention (D-003).
 *
 * "Reaches" is made precise as a **door**: an exported function that resolves
 * *where* one subject's data lives, or reads or writes it by subject. A door
 * must have `SubjectId` somewhere in its parameters — directly, or as a field
 * of an options object — and `SubjectId` is a brand (`src/types.ts`) that only
 * `subjectId()` and `isSubjectId()` mint. So a caller cannot reach a subject's
 * data by passing a bare string, and cannot forget which subject it means.
 *
 * Everything else these modules export is **downstream**: it operates on a
 * path, a plan or a record that a door already produced, and it is listed with
 * the reason. A new export in any of these modules that is in neither list
 * turns this file red — that is what keeps the rule from being an intention.
 *
 * Checked with the TypeScript type checker, not by reading text: a parameter
 * typed through an alias or an interface is followed to what it really is.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import ts from "typescript";
import { subjectId, type SubjectId } from "../../src/types.ts";

const ROOT = resolve(import.meta.dir, "..", "..");

/** Module → its doors, and its downstream exports with why. */
const MODULES: Readonly<Record<string, { doors: readonly string[]; downstream: Readonly<Record<string, string>> }>> = {
  "src/ledger/store.ts": {
    // `append` takes a LedgerEntry, whose `subject` field is the brand.
    doors: ["ledgerDir", "canAppend", "query", "planForget", "append", "removeLedgerDir"],
    downstream: {
      monthFileName: "a file name from a date",
      commitForget: "takes the plan planForget made",
      removeLedgerDirAt: "takes the directory ledgerDir resolved",
    },
  },
  "src/observer/store.ts": {
    doors: ["observerDir", "ensureObserverDir", "planPurge"],
    downstream: {
      announceCapture: "prints the capture notice; no data",
      census: "counts a directory it is handed",
      planPurgeDir: "plans over a directory a door resolved (SubjectId carried for the report)",
      commitPurge: "takes the plan",
    },
  },
  "src/decide/proposals.ts": {
    doors: ["proposalsDir", "ensureProposalsDir", "describeProposal"],
    downstream: {
      proposalKey: "normalises a sentence",
      proposalPath: "joins a directory a door resolved with an id",
      writeProposal: "writes into a directory a door resolved",
      asProposal: "validates parsed JSON",
      readProposals: "reads a directory a door resolved",
      findProposal: "searches an inventory already read",
      refusedProposals: "filters an inventory already read",
      blockingProposal: "searches an inventory already read",
      decideProposal: "returns a new record from one already read",
      spendability: "reads one record",
      spendProposal: "returns a new record from one already read",
      claimApproval: "claims a record already read, beside it in the directory a door resolved (D-144)",
      linkClaim: "creates one claim file at a path its caller already resolved (D-144's exclusive step)",
      writeWhole: "writes one file at a path its caller already resolved",
      claimRefile: "claims the refile of a record already read, beside it in the directory a door resolved (D-144)",
      isProposalId: "checks one string",
      writeProposalAt: "rewrites a record at the path it was read from",
      refileProblem: "reads one record against an inventory already read",
      refileWritten: "reads the directory a door resolved, for an id a refile claim named",
      refileable: "filters an inventory already read",
      unboundReason: "reads one record (D-153 follow-up)",
      isUnboundApproval: "reads one record (D-153 follow-up)",
      askedAgain: "searches an inventory already read (D-153 follow-up)",
      needsReapproval: "filters an inventory already read (D-153 follow-up)",
      proposalLine: "formats one record",
      canonicalAction: "formats one action (D-153)",
      actionDigest: "hashes one action (D-153)",
      turnAction: "builds an action from one string (D-153)",
      boundAction: "reads one record already read (D-153)",
    },
  },
  "src/decide/runs.ts": {
    // The two that take a RunRecord are doors through its `subject` field.
    doors: ["runsDirFor", "describeRun", "runRecordPath", "writeRunRecord", "noteEnded"],
    downstream: {
      runsRoot: "the directory above every subject's — used only to list them for `stop`, which is told no subject on purpose",
      procStat: "reads /proc",
      procAvailable: "reads /proc",
      removeRunRecord: "takes a path a door resolved",
      readRuns: "lists every subject for `stop`, deliberately",
      readRunsAt: "lists the runs directory a plan already resolved (`erase` ending a subject's tasks), every subject as readRuns does",
      livenessOf: "compares a record with /proc",
      childrenOf: "reads /proc",
      strangersInGroup: "reads /proc",
      detachedDescendants: "reads /proc",
      signalTree: "signals a process tree it reads from /proc",
      signalSurvivors: "signals what a tree signal watched",
      terminateRun: "takes a stored record",
      manualCommand: "formats a command",
      readEnded: "lists every subject's ended loosened turns, deliberately: a turn of any agent taints an approval claimed while it ran (review of PR #24, round 3)",
    },
  },
  "src/decide/triggers.ts": {
    doors: ["triggersDirFor"],
    downstream: {
      parseEvery: "reads a duration",
      parseTriggers: "validates a file's text",
      exampleTriggers: "prints a template",
      firedPath: "joins a directory triggersDirFor resolved with a hash",
      readFired: "reads a path a door resolved",
      markFired: "writes a path a door resolved",
      nextDue: "arithmetic on a record already read",
      dueTriggers: "arithmetic on a record already read",
      triggeredCeiling: "compares an environment value",
      lockFired: "locks a path a door resolved",
    },
  },
  "src/a2a/peers.ts": {
    doors: ["a2aDirFor"],
    downstream: {
      peersPath: "joins a directory a2aDirFor resolved",
      allowPhrase: "formats a phrase",
      peerProblem: "checks a name and a URL",
      readPeers: "reads a directory a door resolved",
      writePeers: "writes a directory a door resolved",
      newToken: "makes random bytes",
      peerForBearer: "searches a list already read",
      findPeer: "searches a list already read",
    },
  },
  "src/memory/marker.ts": {
    doors: ["ragDirFor", "writeRagMarker"],
    downstream: { readRagMarker: "reads a directory ragDirFor resolved" },
  },
  "src/memory/collection.ts": {
    doors: ["collectionFor", "collidesWith"],
    downstream: { subjectOfCollection: "the inverse: a name in, a SubjectId (or nothing) out" },
  },
  "src/memory/store-admin.ts": {
    doors: ["collectionState", "dropCollection"],
    downstream: {},
  },
  "src/memory/vector.ts": {
    doors: ["replaceCollection", "searchVectors"],
    downstream: { embed: "turns text into vectors; stores nothing" },
  },
  "src/memory/recall.ts": {
    doors: ["indexAgent", "recall"],
    downstream: {},
  },
  "src/memory/forget.ts": {
    doors: ["planForget"],
    downstream: { commitForget: "takes the plan", formatForgetPlan: "formats the plan" },
  },
  "src/soul/load.ts": {
    doors: ["loadSoul", "parseRole", "parsePerson", "parseSoul"],
    downstream: { resolveSoulDir: "finds which directory holds a soul; reads no subject's data" },
  },
  "src/guard/personal.ts": {
    // `personalPath` is the address alone (S13.1): the data map names the
    // personal directory with it for this machine and for a remote one.
    doors: ["personalDir", "ensurePersonalDir", "personalPath"],
    downstream: {},
  },
  // The data map (S7.1, S13.1): every place one subject's data lives, resolved.
  "src/erase/map.ts": {
    doors: ["subjectTrees", "dataMap"],
    downstream: {},
  },
};

/** Does this type, or one level of its properties, mention the SubjectId brand? */
function mentionsSubject(checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean {
  if (checker.typeToString(type).includes("SubjectId")) return true;
  if (type.isUnion() || type.isIntersection()) {
    if (type.types.some((t) => mentionsSubject(checker, t, depth))) return true;
  }
  if (type.aliasSymbol?.name === "SubjectId") return true;
  if (depth >= 2) return false;
  for (const prop of type.getProperties()) {
    const decl = prop.valueDeclaration ?? prop.declarations?.[0];
    if (decl === undefined) continue;
    const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
    if (checker.typeToString(propType).includes("SubjectId")) return true;
    if (depth < 1 && mentionsSubject(checker, propType, depth + 1)) return true;
  }
  return false;
}

function exportedFunctions(program: ts.Program, file: string): Map<string, ts.Signature[]> {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file)!;
  const module = checker.getSymbolAtLocation(source)!;
  const out = new Map<string, ts.Signature[]>();
  for (const symbol of checker.getExportsOfModule(module)) {
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (!(resolved.flags & ts.SymbolFlags.Function)) continue;
    const type = checker.getTypeOfSymbolAtLocation(resolved, source);
    out.set(symbol.name, [...type.getCallSignatures()]);
  }
  return out;
}

const files = Object.keys(MODULES).map((rel) => join(ROOT, rel));
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  strict: true,
  types: ["bun"],
});
const checker = program.getTypeChecker();

describe("S0.1 AC4 — a subject's data is reached only through a SubjectId", () => {
  for (const [rel, spec] of Object.entries(MODULES)) {
    test(`${rel}: every export is a door or named downstream, and every door takes a SubjectId`, () => {
      const exported = exportedFunctions(program, join(ROOT, rel));
      expect(exported.size, `${rel} exports no function — is the path right?`).toBeGreaterThan(0);

      const classified = new Set([...spec.doors, ...Object.keys(spec.downstream)]);
      const unclassified = [...exported.keys()].filter((name) => !classified.has(name));
      expect(unclassified, `${rel}: new exports must be classified as a door or downstream`).toEqual([]);
      const gone = [...classified].filter((name) => !exported.has(name));
      expect(gone, `${rel}: listed but no longer exported`).toEqual([]);

      for (const door of spec.doors) {
        const takes = exported.get(door)!.some((signature) =>
          signature.getParameters().some((param) =>
            mentionsSubject(checker, checker.getTypeOfSymbolAtLocation(param, param.valueDeclaration!)),
          ),
        );
        expect(takes, `${rel}: ${door} reaches a subject's data and takes no SubjectId`).toBe(true);
      }
    });
  }

  test("the brand is a brand: a bare string is not a SubjectId", () => {
    // The whole rule rests on this. If `SubjectId` were `string`, every door
    // above would accept any string and the check would be decoration. The
    // proof is `tsc` itself, which runs over this file (`include` has `test`):
    // the directive below fails the typecheck the day the assignment compiles.
    // @ts-expect-error — a bare string must not be assignable to SubjectId
    const bare: SubjectId = "anyone";
    expect(typeof bare).toBe("string");
    expect(subjectId("example")).toBe("example" as SubjectId);
  });

  test("the control: the check fails on a door that takes a string", () => {
    const host = ts.createCompilerHost({});
    const fake = "/virtual/door.ts";
    const original = host.getSourceFile;
    host.getSourceFile = (name, lang) =>
      name === fake
        ? ts.createSourceFile(name, "export function leaky(subject: string): string { return subject; }", lang)
        : original.call(host, name, lang);
    const p = ts.createProgram([fake], { noEmit: true }, host);
    const c = p.getTypeChecker();
    const sig = exportedFunctions(p, fake).get("leaky")![0]!;
    const takes = sig.getParameters().some((param) =>
      mentionsSubject(c, c.getTypeOfSymbolAtLocation(param, param.valueDeclaration!)),
    );
    expect(takes).toBe(false);
  }, 30_000);
});
