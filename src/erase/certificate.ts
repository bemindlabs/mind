/**
 * AC2 — the certificate: what, how many records, when, and who asked.
 *
 * ## Issued, never kept
 *
 * The certificate is printed to stdout, and written to a file only when
 * `--out` says where. Mind retains no copy of its own, and the reason is the
 * same one that made `commitForget` remove its files rather than leave a
 * tombstone: a record saying *subject X existed and was erased on this date* is
 * itself a trace of the thing somebody asked to have removed. Worse, a stored
 * one would sit inside the state root, where the very next run's AC3 search
 * would find the subject id and report it as a remainder. A certificate that
 * fails the check it certifies is not a certificate.
 *
 * `--out` is refused inside the state root or the data root for exactly that
 * reason, and the refusal happens in the command, before anything is deleted.
 *
 * ## "ใครสั่ง", honestly
 *
 * Two fields, and they are labelled differently because they are different
 * kinds of thing. `claimed` is whatever `--by` said; Mind authenticates
 * nobody and does not pretend to. `observed` is the OS account the process ran
 * as, which is a fact about this machine and not about a person. The
 * certificate says both of those sentences out loud, so that nothing here reads
 * as an attestation of identity.
 *
 * ## What is deliberately absent
 *
 * No hash of anything that was deleted. A hash of a short prompt, a name or an
 * address is guessable by anybody holding a word list — the reasoning that
 * keeps `--private` from storing one — and a "proof of what was removed" that
 * leaks what was removed is a poor trade.
 *
 * No needle text either. `--needle` counts appear; the text never does.
 *
 * ## What the document has to be able to say, and could not at `@1`
 *
 * A `@1` certificate's whole verification section is four numbers that read
 * zero when everything was cleaned and zero when nothing was ever there, beside
 * `ran: true` — which means only that {@link import("./plan.ts").verifyErase}
 * was *called*. A reader holding one cannot tell a withdrawal from a misfire.
 * `@2` adds three things and they are the answer to that: {@link
 * EraseCertificate.statement}, the sentences for this verdict in plain words;
 * `found` and `removed`, so a claim of erasure is beside the evidence for it;
 * and `filesRead`, per scope, so a zero says over how much.
 */

import { sep } from "node:path";
import { PLACE_IDS, placeOf, placeTally, type Place, type PlaceId } from "./places.ts";
import {
  whatWasFound,
  whatWasRemoved,
  type EraseFound,
  type ErasePlan,
  type EraseRemoved,
  type EraseResult,
  type EraseVerdict,
  type EraseVerification,
} from "./plan.ts";
import { NOT_SEARCHED, SEARCH_LIMITS, SEARCHED } from "./search.ts";
import type { ScopeKind } from "./search.ts";

/**
 * The schema tag every machine-readable certificate carries.
 *
 * `@2` was fix1, and the bump was not additive politeness: the verdict
 * vocabulary narrowed. Every `@1` document reading `erased-and-verified` was
 * issued by an engine that would also have said it over a subject it never
 * found, so the same words do not mean the same thing under the two tags.
 *
 * `@3` is fix2, and it is the same kind of narrowing one field over. Under `@2`
 * a `commits: 0` beside an empty `remotes` was issued for a repository with no
 * commits **and** for one git refused to read (odd2 H3): a document that said
 * *less* than the truth about what git is keeping, which is what S0.4 AC5 is
 * written against. Under `@3` that number is `null` whenever it was not
 * counted, and {@link EraseCertificate.agent}'s new `history` field says which
 * of the four reasons it is. D-026 item 6 is the rule being followed here, and
 * it is followed even though `@2` is a day old: a tag nobody can date a meaning
 * to is worth nothing, and a rule that bends for a convenient case is not one.
 *
 * `@4` is dod1, and it adds a **fifth** value to that field — `no-git`, for a
 * machine with no git on it — without changing what any of the four already
 * mean. By the letter of D-026 item 6 ("bump when a verdict's meaning narrows")
 * this would not need a tag at all, and that is the rule being too narrow
 * rather than this bump being ceremonial. The rule it is read as here:
 *
 * > **Bump when a reader written against the old tag could mishandle a new
 * > document.** Narrowing a verdict is one way that happens. Adding a value to
 * > a field somebody switches on is another: a reader that handled all four
 * > states of `@3` meets a fifth it has no arm for, and the state it cannot
 * > read is precisely the one that says *there may be history here nobody
 * > counted*.
 *
 * The cost is one line and the alternative is teaching ourselves that this rule
 * is negotiable when the last bump was recent — which is the thing D-027 and
 * D-028 both say a discipline must not be.
 *
 * `@5` is S15.8's, by the same rule: a scope may now be of kind `kept` — what
 * `--personal` keeps on purpose outside git, the agent's signing key — and
 * `verification.keptHits` counts its hits. A reader that switched on `deletable`
 * and `git` meets a third kind it has no arm for.
 */
export const CERTIFICATE_SCHEMA = "mind/erase-certificate@5";

/**
 * Why the certificate does or does not carry a commit count.
 *
 * Five states rather than a number-or-null, for the reason ADR 0001 §2 gives
 * about `silent`: a reader who is told `null` and not why cannot tell "nobody
 * looked" from "we looked and were refused", and only the second one means
 * *there may be history here that Mind could not see*.
 */
export type CertificateHistory =
  /** `--no-agent`: no repository was examined, at the requester's word. */
  | "not-examined"
  /** Counted. `commits` is a number and `remotes` is the list git gave. */
  | "read"
  /** The path given is no repository. Nothing to count, and nothing hidden. */
  | "not-a-repository"
  /** A repository git declined to read. The count and the remotes are unknown. */
  | "unreadable"
  /**
   * There is no git on this machine, so nothing was asked.
   *
   * Not a weaker `unreadable`: that one is a fact about the repository and this
   * one is a fact about the host, and they are fixed by different people doing
   * different things. The bare container the MVP-lite DoD is defined by is in
   * exactly this state.
   */
  | "no-git";

/** One of AC1's five places, as the certificate reports it. */
export interface CertificatePlace {
  readonly place: PlaceId;
  readonly what: string;
  readonly status: Place["status"];
  /** Files removed. Zero for a place that had nothing, and for a dry run. */
  readonly files: number;
  /** Bytes that were there before the deletion. */
  readonly bytes: number;
  /** Records, where the place counts in records rather than files. */
  readonly records: number;
  /** Anything a reader needs in order to read the numbers correctly. */
  readonly detail: readonly string[];
  /** `not-built` only: the address D-014 reserves and what was at it. */
  readonly reserved?: { readonly path: string | null; readonly files: number | null };
  /** `not-built` only: the story that owes it. */
  readonly owedBy?: string;
}

/** One place the search looked, and how much of it it really read. */
export interface CertificateScope {
  readonly label: string;
  readonly kind: ScopeKind;
  /** Regular files whose bytes were read. Zero is a fact, not a verdict. */
  readonly filesRead: number;
  /** Set when the scope could not be read at all, rather than being empty. */
  readonly unreadable?: string;
}

/** The whole document, in the shape `--json` emits. */
export interface EraseCertificate {
  readonly schema: string;
  readonly verdict: EraseVerdict;
  /**
   * What this verdict means, and what it does not, in sentences.
   *
   * On the page these go directly under `verdict`, because the one thing a
   * document like this is used for is being quoted later by somebody who was
   * not at the terminal. A `nothing-found` that only said `nothing-found` would
   * be read as "it is gone" by exactly the reader it is written for.
   */
  readonly statement: readonly string[];
  readonly subject: string;
  readonly scope: ErasePlan["scope"];
  /** When the plan was made, and when the document was issued. */
  readonly plannedAt: string;
  readonly issuedAt: string;
  readonly engine: string;
  readonly by: {
    readonly claimed: string;
    readonly observed: string;
    readonly note: string;
  };
  readonly agent: {
    readonly dir: string | null;
    readonly examined: boolean;
    /**
     * Commits already in this repository's history.
     *
     * `null` whenever the number was **not counted** — which is four of the
     * five {@link CertificateHistory} states, and not only `--no-agent`. A
     * reader who wants to know which reads `history` beside it.
     */
    readonly commits: number | null;
    /**
     * Configured remote names. Mind never asks a host anything about them.
     *
     * Empty means "git listed none" only when `history` is `read`. In the other
     * four states it means the list was never obtained, which is why the
     * printed form says so in words rather than printing an absence.
     */
    readonly remotes: readonly string[];
    /** Why there is, or is not, a number above. */
    readonly history: CertificateHistory;
    readonly note: string;
  };
  readonly tally: string;
  readonly places: readonly CertificatePlace[];
  readonly verification: {
    /**
     * Whether the re-read happened at all — **the function was called**.
     *
     * That is the whole of what it says, and it is why it is not enough on its
     * own: it is `true` for a run that walked four trees and for one that found
     * no directory to walk. `filesRead` below is the number that separates
     * those, and `found`/`removed` are what the verdict is decided on.
     */
    readonly ran: boolean;
    /** Regular files whose bytes the search read, summed over the scopes. */
    readonly filesRead: number;
    /** What the plan saw before the deletion. Present on a dry run too. */
    readonly found: EraseFound;
    /** What went. All zeros on a dry run, where nothing was written. */
    readonly removed: EraseRemoved;
    /** Where the search looked, and how much of each it read. */
    readonly scopes: readonly CertificateScope[];
    readonly remainingFiles: number;
    readonly failures: number;
    readonly deletableHits: number;
    readonly gitHits: number;
    /** Hits in what `--personal` keeps on purpose — the signing key's path names the subject (D-138). */
    readonly keptHits: number;
    readonly personalHits: number | null;
    /**
     * `path:line` for every hit, with the needle's label and never its text — and then every file still there under
     * a tree that was to be emptied, by path, with the tree's name, so a transcript that survived is named and not
     * only counted (S7.2, I-4).
     */
    readonly where: readonly string[];
    readonly searched: readonly string[];
    readonly notSearched: readonly string[];
    readonly limits: readonly string[];
  };
  /** What deletion cannot reach, per place, in the words the owner already saw. */
  readonly undeletable: readonly { readonly place: PlaceId; readonly lines: readonly string[] }[];
  readonly notes: readonly string[];
}

/** Everything a certificate is built from. `result` is null on a dry run. */
export interface CertificateInput {
  readonly plan: ErasePlan;
  readonly result: EraseResult | null;
  readonly verification: EraseVerification | null;
  /** The OS account the process ran as. A machine fact, never a person. */
  readonly observedAccount: string;
  /** The engine version, so a document can be read against the code that made it. */
  readonly engine: string;
  /** ISO instant the document was issued. */
  readonly issuedAt: string;
}

/** Nothing removed, and nothing of this subject found: what that does and does not mean. */
const NOTHING_FOUND: readonly string[] = [
  "NOTHING WAS ERASED. Nothing held under this subject id was found, so there was nothing to " +
    "erase. This document is not a certificate of erasure: it records that Mind looked, where " +
    "it looked, and how much it read.",
  'Mind cannot tell "this subject never existed here" from "an earlier run erased it". It ' +
    "keeps no record of past erasures, on purpose — such a record would itself be a trace of the " +
    "subject, and the next run's search would find it. If an earlier run erased this subject, " +
    "the certificate that run issued is the evidence. This one is not.",
];

/**
 * The sentences under the verdict, chosen by what actually happened.
 *
 * The `filesRead` arm is the one worth reading twice. Files read and nothing of
 * this subject in them is what a **mistyped id** looks like on a machine that
 * holds somebody else's data — and the document says to check the spelling
 * without naming any other subject that is here. Which other identities a
 * machine holds is not this document's to disclose: it may be handed to the
 * person whose data was withdrawn, and a list of the neighbours would be a leak
 * committed by the instrument of privacy itself. A count of files is not one.
 */
export function statementFor(
  plan: ErasePlan,
  verdict: EraseVerdict,
  found: EraseFound,
  verification: EraseVerification | null,
): readonly string[] {
  const lines: string[] = [];

  if (verdict === "nothing-found") {
    lines.push(...NOTHING_FOUND);
    lines.push(
      (verification?.filesRead ?? 0) > 0
        ? `Other data is here — ${verification?.filesRead ?? 0} file(s) were read — and none of ` +
          `it names this subject. If you expected data under this id, check the spelling: an id ` +
          `one character off is a different subject, and its data has not been touched.`
        : "No file exists in any place searched. Either Mind has stored nothing under this " +
          "home, or HOME / XDG_STATE_HOME / XDG_DATA_HOME point somewhere other than where the " +
          "data is.",
    );
  }

  if (verdict === "dry-run" && found.total === 0) {
    lines.push(
      "Nothing was found to remove. Nothing has been written either way — this is a dry run — " +
        "and --yes would remove nothing and would issue no erasure verdict.",
    );
    lines.push(...NOTHING_FOUND.slice(1));
  }

  if (verdict === "erased-and-verified") {
    lines.push(
      `Something was found and something went: ${found.total} thing(s) were there before, and ` +
        `the search afterwards found the identifier nowhere it must not be. What that search ` +
        `does not cover is listed below, and this document certifies nothing about it.`,
    );
  }

  lines.push(...localCliStatement(plan, verification));

  for (const label of verification?.unreadableScopes ?? []) {
    lines.push(
      `The scope "${label}" could not be read at all. A place nobody could look into is not a ` +
        `place that was found clean, so this run does not certify it.`,
    );
  }

  // In the sentences, not only in the fields. The verdict is the part of this
  // document that gets quoted, and a `git` row reading UNKNOWN three sections
  // further down is not where somebody will meet it.
  if (plan.git !== null && !plan.git.readable && plan.git.why === "unreadable") {
    lines.push(
      `The repository at ${plan.agentDir ?? "the agent directory"} could not be read by git ` +
        `(${plan.git.detail}). How many commits it holds, and what remotes it has, are UNKNOWN ` +
        `to this document — not zero. Everything already committed is still reachable, and this ` +
        `certificate cannot say how much that is.`,
    );
  }

  // The same sentence for the other way the count is missing, and it is a
  // separate arm because it sends the reader somewhere else. This is the state
  // the bare container is in, which makes it the state the DoD's own evidence
  // is issued under — the last place a reader should have to infer anything.
  if (plan.git !== null && !plan.git.readable && plan.git.why === "no-git") {
    lines.push(
      `There is no git on this machine (${plan.git.detail}), so ${plan.agentDir ?? "the agent directory"} ` +
        `was never asked what it holds. Whether it is a repository at all, how many commits it ` +
        `has, and what remotes it has are UNKNOWN to this document — not zero. Files were ` +
        `removed from the working tree; anything already committed is untouched by that, and ` +
        `this certificate cannot say how much there is.`,
    );
  }

  if (plan.agentDir === null && verdict !== "dry-run") {
    lines.push(
      "--no-agent: no repository was examined, at the requester's word. Anything in a working " +
        "tree is outside every number above.",
    );
  }

  return lines;
}

/**
 * What happened to the local backends' homes, in sentences under the verdict (S7.1, S7.2, I-4).
 *
 * Only once the run has happened: before it, the plan's notes say what would. A home that went is said to have gone
 * *whole* and why, so nobody reads "removed" as "this subject's sessions, and no others"; a home that was left is
 * said to be uncertified; and a transcript still in a home that was to go is named as remaining, in the words the
 * verdict is quoted in.
 */
function localCliStatement(plan: ErasePlan, verification: EraseVerification | null): readonly string[] {
  if (verification === null) return [];
  const lines: string[] = [];
  for (const home of plan.localCli) {
    if (home.handling === "left-alone") {
      lines.push(`NOT TOUCHED, AND NOT CERTIFIED: ${home.sentence}`);
      continue;
    }
    if (home.handling !== "removed-whole") continue;
    const left = verification.leftover.filter((entry) => entry.path === home.dir || entry.path.startsWith(home.dir + sep));
    lines.push(
      left.length === 0
        ? `${home.backend}'s home was removed whole, not per subject — ${home.files} file(s) of vendor session ` +
            `transcripts, history and scratch shared by every subject on this machine (${home.dir}) — and read ` +
            `back: none is left.`
        : `TRANSCRIPTS REMAIN: ${left.length} file(s) are still in ${home.backend}'s home (${home.dir}) after the ` +
            `erase, named under "verification" below. This subject is NOT erased from them.`,
    );
  }
  return lines;
}

/** Which of the five reasons this document has, or has not, a commit count. */
function historyState(plan: ErasePlan): CertificateHistory {
  if (plan.git === null) return "not-examined";
  return plan.git.readable ? "read" : plan.git.why;
}

/** The sentence beside the agent directory, chosen by the same five states. */
function agentNote(plan: ErasePlan): string {
  switch (historyState(plan)) {
    case "not-examined":
      return (
        "--no-agent: no repository was examined. soul/, .mind/ and the working tree were not " +
        "visited, at the requester's word."
      );
    case "read":
      return (
        "the repository was read and nothing was committed. The commit count is from " +
        "`git rev-list`; the object database was never searched, so nothing here is a claim " +
        "about what those commits contain."
      );
    case "not-a-repository":
      return (
        "this directory is not a git repository, so there was no history to count. Nothing was " +
        "committed, because there is nothing here to commit to."
      );
    case "unreadable":
      return (
        "this IS a git repository and git declined to read it, so the commit count and the " +
        "remote list on this document are unknown rather than zero. Anything in that history " +
        "is still in it, and this document does not say how much."
      );
    case "no-git":
      return (
        "there is no git on this machine, so this directory was never asked anything — not " +
        "whether it is a repository, not how many commits it holds, not what remotes it has. " +
        "All three are unknown rather than zero. Install git and run `mind guard status` " +
        "here if you need those numbers; nothing in this document is a claim about them."
      );
  }
}

/** Build the certificate. Pure: it reads nothing and writes nothing. */
export function certificate(input: CertificateInput): EraseCertificate {
  const { plan, result, verification } = input;
  const verdict: EraseVerdict = verification?.verdict ?? "dry-run";
  // From the plan, so that a dry run says what is there rather than a row of
  // zeros that reads the same as a clean machine.
  const found = verification?.found ?? whatWasFound(plan);
  const removed =
    verification?.removed ??
    (result === null
      ? { files: 0, directories: 0, ledgerLines: 0, collections: 0, blocks: 0, total: 0 }
      : whatWasRemoved(result));

  return {
    schema: CERTIFICATE_SCHEMA,
    verdict,
    statement: statementFor(plan, verdict, found, verification),
    subject: plan.subject,
    scope: plan.scope,
    plannedAt: plan.at,
    issuedAt: input.issuedAt,
    engine: input.engine,
    by: {
      claimed: plan.by,
      observed: input.observedAccount,
      note:
        "Mind authenticates neither. `claimed` is the text passed to --by; `observed` is the " +
        "OS account this process ran as. Nothing here is evidence that a particular person " +
        "asked for this.",
    },
    agent: {
      dir: plan.agentDir,
      examined: plan.agentDir !== null,
      commits: plan.git !== null && plan.git.readable ? plan.git.commits : null,
      remotes: plan.git !== null && plan.git.readable ? plan.git.remotes.map((r) => r.name) : [],
      history: historyState(plan),
      note: agentNote(plan),
    },
    tally: placeTally(visitedPlaces(plan)),
    places: PLACE_IDS.map((id) => placeRow(id, plan, result)),
    verification: {
      ran: verification !== null,
      filesRead: verification?.filesRead ?? 0,
      found,
      removed,
      scopes:
        verification?.search.scopes.map((scope) => ({
          label: scope.label,
          kind: scope.kind,
          filesRead: scope.filesRead,
          ...(scope.unreadable === undefined ? {} : { unreadable: scope.unreadable }),
        })) ?? [],
      remainingFiles: verification?.remainingFiles ?? 0,
      failures: verification?.failures ?? 0,
      deletableHits: verification?.search.deletableHits ?? 0,
      gitHits: verification?.search.gitHits ?? 0,
      keptHits: verification?.search.keptHits ?? 0,
      personalHits: verification?.personal?.gitHits ?? null,
      where: verification === null ? [] : hitLines(verification),
      searched: SEARCHED,
      notSearched: NOT_SEARCHED,
      limits: SEARCH_LIMITS,
    },
    undeletable: PLACE_IDS.map((id) => ({
      place: id,
      lines: placeOf(id).undeletable.flat(),
    })).filter((entry) => entry.lines.length > 0),
    notes: plan.notes,
  };
}

/**
 * How many places with a deleter this run actually reached.
 *
 * Counted rather than assumed, because `--no-agent` and an unresolvable
 * personal directory each drop one, and a run that says "3 of 3" having looked
 * at two is the arithmetic-instead-of-evidence failure this whole story is
 * about.
 */
function visitedPlaces(plan: ErasePlan): number {
  const reached = new Set<PlaceId>();
  for (const tree of plan.trees) reached.add(tree.place);
  if (plan.files.length > 0 || plan.blocks.some((block) => block.outcome !== "absent")) {
    reached.add("soul");
  }
  // The ledger is always planned: it needs no agent directory and no personal
  // directory, only the state root, which is always resolvable.
  reached.add("ledger");
  return [...reached].filter((id) => placeOf(id).status === "implemented").length;
}

/**
 * `path:line — needle` for every hit, in scope order, never the needle's text; then every file still under a tree
 * that was to be emptied, unless a hit above already names it.
 */
function hitLines(verification: EraseVerification): readonly string[] {
  const lines: string[] = [];
  const named = new Set<string>();
  for (const report of [verification.search, verification.personal]) {
    if (report === null) continue;
    for (const scope of report.scopes) {
      for (const hit of scope.hits) {
        named.add(hit.path);
        lines.push(
          `${hit.path}:${hit.line} — ${hit.needle}${hit.inName ? " (in the path, not the bytes)" : ""}` +
            ` [${scope.kind}]`,
        );
      }
    }
  }
  for (const entry of verification.leftover) {
    if (!named.has(entry.path)) lines.push(`${entry.path} — still there after the erase [${entry.tree}]`);
  }
  return lines;
}

/** One place's row: what it is, how much went, and what a reader must know. */
function placeRow(id: PlaceId, plan: ErasePlan, result: EraseResult | null): CertificatePlace {
  const place = placeOf(id);
  const base = { place: id, what: place.what, status: place.status };

  if (place.status === "not-built") {
    const probe = plan.reserved.find((entry) => entry.place === id);
    return {
      ...base,
      files: 0,
      bytes: 0,
      records: 0,
      detail: [
        `not built: nothing in Mind writes here, so nothing in Mind deletes here. ` +
          `${place.owedBy} owes it, and must bring: ${(place.mustBring ?? []).join("; ")}.`,
        probe?.path === null || probe === undefined
          ? "the reserved address was not looked at, because no agent directory was given."
          : `the reserved address ${probe.path} held ${probe.census?.files ?? 0} file(s) when ` +
            `this ran. Anything there with no deleter for it refuses the whole run.`,
      ],
      reserved: {
        path: probe?.path ?? null,
        files: probe?.census?.files ?? null,
      },
      owedBy: place.owedBy ?? "unassigned",
    };
  }

  if (id === "ledger") {
    const removed = result?.ledger.removed ?? 0;
    return {
      ...base,
      files: (result?.ledger.filesRemoved.length ?? 0) + (result?.ledger.filesRewritten.length ?? 0),
      bytes: 0,
      records: removed,
      detail: [
        `${plan.ledger.matched.length} line(s) matched · ${removed} removed · directory ` +
          `${result?.ledgerDirRemoved === true ? "removed" : "left in place"} (${plan.ledger.dir}).`,
        plan.ledger.backends.length === 0
          ? "no backend is named in these lines, because there are none."
          : `already received by, and Mind cannot take it back from: ` +
            `${plan.ledger.backends.join(", ")}. That list disappears with the lines, which is ` +
            `why it is on this document.`,
        plan.scope === "personal"
          ? "the whole ledger went. A ledger line carries no per-record personal flag, so Mind " +
            "cannot split it — this is a statement about what cannot be separated, not a claim " +
            "that every line was personal."
          : "the whole ledger went, which is what this scope asks for.",
        // The vendor's copy of a turn: counted in `found` and `removed` with the trees, and named here.
        ...plan.localCli.map(
          (home) =>
            `${home.backend}'s own home, shared by every subject — ` +
            `${home.handling === "removed-whole" ? "removed whole" : home.handling === "left-alone" ? "NOT touched" : "NOT readable"}: ` +
            `${home.dir} (${home.files} file(s) before; the notes below say why).`,
        ),
      ],
    };
  }

  const trees = plan.trees.filter((tree) => tree.place === id);
  const bytes = trees.reduce((total, tree) => total + tree.plan.before.bytes, 0);
  const planned = trees.reduce((total, tree) => total + tree.plan.before.files, 0);
  const removed =
    result === null
      ? 0
      : result.trees
          .filter((tree) => tree.place === id)
          .reduce((total, tree) => total + tree.removed, 0);

  const detail = trees.map(
    (tree) =>
      `${tree.label}: ${tree.plan.before.files} file(s), ${tree.plan.before.bytes} byte(s) at ` +
      `${tree.plan.dir}`,
  );

  if (id === "soul") {
    for (const file of plan.files) detail.push(`single file: ${file}`);
    for (const block of plan.blocks) {
      if (block.outcome === "absent") continue;
      detail.push(`block in ${block.path}: ${block.outcome}${block.reason === undefined ? "" : ` — ${block.reason}`}`);
    }
    detail.push(
      "an identity lives in three places, not one: the repository, Mind's block inside every " +
        "vendor instruction file it was applied to, and the backups taken before those writes. " +
        "A backup made before a later apply contains the earlier block, which is why the backup " +
        "tree goes whole.",
    );
  }

  if (id === "rag") {
    const probe = plan.vector;
    const present = probe.state?.kind === "present" ? probe.state.points : null;
    detail.push(
      probe.url === null
        ? `collection ${probe.collection}: no store was asked, and Mind holds no record of writing one.`
        : probe.state?.kind === "unreachable"
          ? `collection ${probe.collection} at ${probe.url}: the store did not answer (${probe.state.reason}).`
          : present === null
            ? `collection ${probe.collection} at ${probe.url}: not there when this ran.`
            : `collection ${probe.collection} at ${probe.url}: ${present} point(s) · ` +
              (result === null
                ? "would be dropped whole"
                : result.vector?.dropped === true
                  ? "dropped whole"
                  : `NOT dropped (${result.vector?.reason ?? "no attempt"})`),
    );
    detail.push(
      "dropped whole or not at all: per-point deletes were measured leaving the text on disk " +
        "(D-035), and Mind has no such call.",
    );
    const points = present ?? 0;
    return {
      ...base,
      files: result === null ? planned : removed,
      bytes,
      records: result === null || result.vector?.dropped === true ? points : 0,
      detail,
    };
  }

  return {
    ...base,
    files: result === null ? planned : removed,
    bytes,
    records: result === null ? planned : removed,
    detail,
  };
}

/**
 * The `git` row, which may not print a number it does not have.
 *
 * Four of the five states print no number at all, and none of them prints
 * `0 commit(s)`: a zero on this line is the sentence a reader is most likely to
 * quote later, and under `@2` it was issued for a repository that had one
 * commit and a remote and a `.git/config` git could not parse.
 */
function gitLine(cert: EraseCertificate): string {
  switch (cert.agent.history) {
    case "not-examined":
      return "not examined — --no-agent";
    case "not-a-repository":
      return "no repository at this path — nothing was counted, and nothing is hidden by that";
    case "unreadable":
      return (
        "UNKNOWN — this is a repository and git would not read it. The commit count and the " +
        "remote list are not zero; they were never obtained"
      );
    case "no-git":
      return (
        "UNKNOWN — there is no git on this machine, so nothing was asked. Whether this is a " +
        "repository, what it holds and where it was pushed are all unobtained, not zero"
      );
    case "read":
      return (
        `${cert.agent.commits === 0 ? "no commit yet" : `${cert.agent.commits} commit(s)`} · ` +
        `${cert.agent.remotes.length === 0 ? "no remote configured" : `remotes: ${cert.agent.remotes.join(", ")}`}`
      );
  }
}

/** The human form: the same document, as lines to print. */
export function formatCertificate(cert: EraseCertificate): readonly string[] {
  const lines: string[] = [
    `erase certificate — ${cert.schema}`,
    `verdict      ${cert.verdict}`,
  ];

  for (const sentence of cert.statement) lines.push(`             ${sentence}`);

  lines.push(
    `subject      ${cert.subject} · scope ${cert.scope}`,
    `when         planned ${cert.plannedAt} · issued ${cert.issuedAt} · engine ${cert.engine}`,
    `who          claimed "${cert.by.claimed}" · observed account "${cert.by.observed}"`,
    `             ${cert.by.note}`,
    `agent        ${cert.agent.dir ?? "(none given)"} — ${cert.agent.note}`,
    `git          ${gitLine(cert)}`,
    "",
    `places       ${cert.tally}`,
  );

  for (const place of cert.places) {
    lines.push(
      `  ${place.place.padEnd(9)} ${place.status.padEnd(12)} ` +
        `${place.records} record(s) · ${place.bytes} byte(s)`,
    );
    lines.push(`             ${place.what}`);
    for (const note of place.detail) lines.push(`             - ${note}`);
  }

  lines.push("");
  // Before the verification block on purpose: what was there and what went are
  // the two numbers a claim of erasure rests on, and a reader who stops at the
  // first line of a section has to have met them.
  const { found, removed } = cert.verification;
  lines.push(
    `found        before deletion: ${found.files} file(s) · ${found.ledgerLines} ledger line(s) · ` +
      `${found.collections} vector collection(s) · ${found.blocks} applied block(s)`,
  );
  lines.push(
    `removed      ${removed.total} thing(s): ${removed.files} file(s) · ` +
      `${removed.directories} directory(ies) · ${removed.ledgerLines} ledger line(s) · ` +
      `${removed.collections} collection(s) · ${removed.blocks} block(s)`,
  );
  if (cert.verification.ran) {
    lines.push(
      `read         after: ${cert.verification.filesRead} file(s) — ` +
        cert.verification.scopes
          .map(
            (scope) =>
              `${scope.label} ${scope.filesRead}` +
              (scope.unreadable === undefined ? "" : " (UNREADABLE)"),
          )
          .join(" · "),
    );
  }

  // No blank line between these and the verification line below: they are one
  // block — what was there, what went, how much was read back — and a reader
  // who meets the last of them without the first two has the same problem a
  // `@1` document gave them.
  if (!cert.verification.ran) {
    lines.push("verification did not run: nothing was deleted, so there is nothing to re-read.");
  } else {
    lines.push(
      `verification remaining ${cert.verification.remainingFiles} file(s) · ` +
        `${cert.verification.failures} failure(s) · ` +
        `${cert.verification.deletableHits} hit(s) where there must be none · ` +
        `${cert.verification.gitHits} hit(s) in git-tracked files` +
        (cert.verification.keptHits === 0 ? "" : ` · ${cert.verification.keptHits} hit(s) in what --personal keeps (the signing key)`) +
        (cert.verification.personalHits === null
          ? ""
          : ` · ${cert.verification.personalHits} personal value(s) still in kept files`),
    );
    for (const where of cert.verification.where) lines.push(`             ${where}`);
  }

  lines.push("");
  lines.push("searched:");
  for (const note of cert.verification.searched) lines.push(`  - ${note}`);
  lines.push("not searched, and therefore not certified:");
  for (const note of cert.verification.notSearched) lines.push(`  - ${note}`);
  lines.push("how coarse this search is:");
  for (const note of cert.verification.limits) lines.push(`  - ${note}`);

  lines.push("");
  for (const entry of cert.undeletable) {
    lines.push(`what deletion does not reach — ${entry.place}:`);
    for (const note of entry.lines) lines.push(`  - ${note}`);
  }

  if (cert.notes.length > 0) {
    lines.push("");
    for (const note of cert.notes) lines.push(`note: ${note}`);
  }

  return lines;
}
