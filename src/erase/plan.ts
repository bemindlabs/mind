/**
 * `mind erase <subject>` — compose the deleters that exist, and refuse to
 * certify what was not looked at.
 *
 * Three commands could already delete something before this story:
 * `ledger forget --all`, `observe purge`, and `soul apply`'s inverse
 * {@link import("../soul/block.ts").strip}. What was missing was not a fourth
 * deleter; it was the thing that runs all of them for one subject, counts what
 * is left **from disk**, searches for the identifier afterwards, and says out
 * loud which of AC1's five places it did not visit because they do not exist
 * yet. So this file writes no new deletion logic: every removal below goes
 * through `planPurgeDir`/`commitPurge`, `planForget`/`commitForget`, or
 * `strip`.
 *
 * ## Three functions, and the split is the safety property
 *
 * {@link planErase} reads and decides and writes nothing. {@link commitErase}
 * takes the plan and **no environment**, so it cannot act on a path the plan
 * never resolved. {@link verifyErase} runs afterwards and re-reads the
 * filesystem: every count in the report comes back off the disk rather than out
 * of the plan's own arithmetic, which is the difference between evidence and a
 * tautology (`test/observer/purge.test.ts` has the control that shows why).
 *
 * A dry run is the absence of the second call, exactly as in `soul apply`.
 *
 * ## What refuses the whole run
 *
 * `refusals` is non-empty and the command exits 1 **without a certificate**
 * when any of these holds:
 *
 * - a `not-built` place has something at the address D-014 reserves for it.
 *   Mind has no deleter for a vector collection or an adapter, and a
 *   certificate that listed the place as handled would be the precise lie AC1
 *   invites;
 * - a vendor instruction file holds a block whose body was hand-edited, or a
 *   marker Mind cannot read. `strip` refuses those, and so does this;
 * - a tree that has to go is a symlink, so deleting it would reach outside the
 *   path the certificate names;
 * - a local backend's home is there and cannot be read: Mind cannot say whether
 *   this subject's transcripts are in it, and will not certify over it.
 *
 * ## The local backends' homes
 *
 * The vendor CLI behind `claude-local` and `grok-local` writes the transcript of
 * every turn into a home of Mind's own, one per backend, shared by every subject
 * (S7.1, S7.2). It cannot be erased per subject, so a home that this subject is
 * tied to — by a ledger line naming the backend, or by a needle inside it — goes
 * **whole**, as a tree of the plan, and says so; a home nothing ties the subject
 * to is left alone, and says that. `src/erase/local-cli-plan.ts` decides, and
 * `verifyErase` names every file still there afterwards.
 *
 * ## `--personal`, and the part the owner decided
 *
 * `--personal` (AC5, D-010) removes `person.md`, the whole personal directory,
 * the applied blocks, the backups, `.mind/` — and **the whole ledger**. The
 * ledger has no per-record personal flag, so it cannot be split; D-022 records
 * that nothing reads it back into any behaviour, so nothing an agent does is
 * lost. That is a decision about what Mind *cannot* separate, and the output
 * says so in those words rather than implying the ledger was personal.
 *
 * What stays: `role.md`, `memory/`, `consent/`. And then their contents are
 * *checked*, because separate files are not separate contents: the values
 * `person.md` held are searched for in what was kept, reported as `file:line`,
 * and never deleted for you (see {@link verifyErase}).
 */

import { endTasksForErase, type EndedTask } from "../task/control.ts";
import { personalPath } from "../guard/personal.ts";
import { isFinal, listTasks, TASKS_DIR } from "../task/store.ts";
import { RUNS_DIR } from "../decide/runs.ts";
import { rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dockerIo, killContainer, readBrowserRecords, type DockerIo } from "../browser/store.ts";
import { historyFacts, historySentence, type HistoryFacts } from "../guard/history.ts";
import { personalDir } from "../guard/personal.ts";
import { identityDirFor, keyPath } from "../identity/dir.ts";
import { readAgentKey } from "../identity/key.ts";
import {
  commitForget,
  ledgerDir,
  planForget,
  removeLedgerDirAt,
  type ForgetPlan,
  type ForgetResult,
  type LedgerEnv,
} from "../ledger/store.ts";
import type { ThisMachine } from "../ledger/lock.ts";
import {
  census,
  commitPurge,
  planPurgeDir,
  type Census,
  type PurgePlan,
} from "../observer/store.ts";
import { collectionFor } from "../memory/collection.ts";
import { ragDirFor, readRagMarker, type RagMarker } from "../memory/marker.ts";
import {
  collectionState,
  dropCollection,
  type CollectionState,
} from "../memory/store-admin.ts";
import { vectorEndpoints } from "../memory/endpoints.ts";
import { dataRoot, stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";
import { dataMap, subjectTrees } from "./map.ts";
import { tieLocalCliHomes, type HomeCandidate, type LocalCliHome } from "./local-cli-plan.ts";
import { notBuiltPlaces, type PlaceId } from "./places.ts";
import {
  searchScopes,
  searchTree,
  type Needle,
  type Scope,
  type SearchReport,
} from "./search.ts";
import {
  backupTree,
  commitBlocks,
  manifestTargets,
  personFile,
  planBlocks,
  type BlockRemoval,
  type BlockRemovalResult,
} from "./soul.ts";

/** Everything the engine is allowed to know about this machine. */
export interface EraseEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  /**
   * This machine's name and boot time, for the ledger's lock (D-145) — handed
   * on to the ledger's plan as `ledgerEnv()` hands it to a turn. Without it the
   * erase judged every lock by age alone: a killed turn's lock held it up for
   * ten minutes, and its own lock, left by a killed erase, named no machine and
   * refused every turn for as long.
   */
  readonly machine?: ThisMachine;
}

/** Everything Mind deletes, or only the personal half of it (AC5). */
export type EraseScope = "all" | "personal";

/** What the command line asked for, with nothing inferred. */
export interface EraseRequest {
  readonly subject: SubjectId;
  /**
   * The agent repository, or `null` for `--no-agent`.
   *
   * Required rather than inferred: there is no subject→repository registry, and
   * a directory name is a hint while an identity is a claim (I-3). `--no-agent`
   * is recorded on the certificate as *not examined, at the requester's word*.
   */
  readonly agentDir: string | null;
  readonly scope: EraseScope;
  /** Who asked, in their own words. Recorded as claimed; Mind checks nothing. */
  readonly by: string;
  /** Extra text to look for. Counted on the certificate, never quoted. */
  readonly needles: readonly string[];
  /** Instruction files the vendor registry resolves. Unioned with the manifests. */
  readonly instructionFiles: readonly string[];
  /** The soul's display name, read before anything is deleted. */
  readonly soulName: string | null;
  /** Values `person.md` held, so AC5 can look for them in what is kept. */
  readonly personalValues: readonly string[];
}

/** One tree that goes whole, planned by the observer's walker. */
export interface TreeTarget {
  readonly place: PlaceId;
  readonly label: string;
  readonly plan: PurgePlan;
}

/** A reserved address for a place that has no deleter, and what is at it now. */
export interface ReservedProbe {
  readonly place: PlaceId;
  readonly owedBy: string;
  readonly path: string | null;
  readonly census: Census | null;
}

/**
 * The subject's vector collection, as the plan found it (S4.1, D-038).
 *
 * `url` is where the commit will drop it, resolved here so the commit takes no
 * environment. `null` when there is nowhere to ask: the environment names no
 * loopback store and Mind holds no marker saying it ever wrote one.
 */
export interface VectorProbe {
  readonly collection: string;
  readonly url: string | null;
  /** The marker `memory index` leaves before it writes, or why it could not be read. */
  readonly marker: RagMarker | "unreadable" | null;
  /** `null` when {@link url} is. */
  readonly state: CollectionState | null;
}

/** Everything a run would do, worked out before anything is touched. */
export interface ErasePlan {
  readonly subject: SubjectId;
  readonly scope: EraseScope;
  readonly by: string;
  /** ISO instant the plan was made, from the injected clock. */
  readonly at: string;
  readonly agentDir: string | null;
  readonly stateRoot: string;
  readonly dataRoot: string;
  readonly trees: readonly TreeTarget[];
  /** The subject's tasks that had not ended at planning time (D-154); every unfinished one is ended at commit. */
  readonly tasks: readonly string[];
  /** Where the subject's tasks are (`personal/tasks/`). */
  readonly tasksAt: string;
  /**
   * The subject's browser tasks (D-151) whose containers `docker kill` ends
   * before their records go with the `browser` tree. Killed first: a running
   * container still writes into the recording and names the subject in its
   * record.
   */
  readonly browsers: readonly { readonly task: string; readonly container: string }[];
  /** Single files that go — `person.md` under `--personal`, nothing otherwise. */
  readonly files: readonly string[];
  /**
   * Directories left holding nothing but the subject's name.
   *
   * `$XDG_DATA_HOME/mind/<subject>/` is the case: its only children are
   * `personal/` and `identity/` (S15.8), which both go whole, and what would be left is an empty directory
   * whose *name* is the identifier AC3 says must be findable nowhere. Removed
   * with a plain `rmdir`, which fails harmlessly if anything else is in there —
   * Mind has then miscounted and leaving the evidence is the right move.
   */
  readonly emptyParents: readonly string[];
  readonly blocks: readonly BlockRemoval[];
  /**
   * The local backends' homes that hold something, and what was decided about each (S7.1, S7.2).
   *
   * A home is shared by every subject, so it is not one of the subject's trees: the ones tied to this subject are in
   * {@link trees} (counted, removed, recounted and searched like any other) and are listed here with the words that
   * say they go whole; the others are listed here and are not touched. `src/erase/local-cli-plan.ts` says how a
   * subject is tied to a home.
   */
  readonly localCli: readonly LocalCliHome[];
  readonly ledger: ForgetPlan;
  readonly reserved: readonly ReservedProbe[];
  readonly vector: VectorProbe;
  /** Backup manifests that could not be read. Reported, never fatal. */
  readonly unreadableManifests: readonly string[];
  /** What the verification will look for. Built before deletion, on purpose. */
  readonly needles: readonly Needle[];
  /** AC5's needles: the values `person.md` held. Empty outside `--personal`. */
  readonly personalNeedles: readonly Needle[];
  readonly scopes: readonly Scope[];
  /**
   * What git already holds, counted locally and never searched.
   *
   * `null` under `--no-agent`, and **only** under `--no-agent`: "nobody asked"
   * and "asked, and git would not say" are two different things to tell the
   * person holding the certificate, so the second lives in
   * {@link HistoryFacts}'s own unreadable arm rather than in this `null`.
   *
   * The commit count is read with `git rev-list`, which is on `spawnGuarded`'s
   * allowlist and reaches no remote; the *contents* of the object database are
   * deliberately not grepped, because a zero there would take a history rewrite
   * to become true and Mind does not rewrite history for anybody
   * (GIT_UNDELETABLE's last line).
   */
  readonly git: HistoryFacts | null;
  /** Non-empty means: do not delete, do not certify, exit 1. */
  readonly refusals: readonly string[];
  /** Things a reader is entitled to know that are not refusals. */
  readonly notes: readonly string[];
}


/** A subject id is not a word; the needle is, and this is how it is labelled. */
const SUBJECT_NEEDLE = "subject id";

/**
 * Decide what would happen, touching nothing.
 *
 * Read-only by construction: the only filesystem calls reachable from here are
 * `readdir`, `stat` and reads.
 */
export async function planErase(
  env: EraseEnv,
  request: EraseRequest,
): Promise<ErasePlan> {
  const { subject, agentDir, scope } = request;
  const state = stateRoot(env.home, env.env);
  const data = dataRoot(env.home, env.env);
  const refusals: string[] = [];
  const notes: string[] = [];

  // --- what the verification will look for --------------------------------
  // Deduplicated by text. A soul whose display name is its subject id is
  // ordinary, and counting the same byte sequence twice would double every
  // number a reader is meant to act on.
  const needles: Needle[] = [];
  const addNeedle = (needle: Needle): void => {
    if (needle.text === "" || needles.some((seen) => seen.text === needle.text)) return;
    needles.push(needle);
  };
  addNeedle({ label: SUBJECT_NEEDLE, text: subject, boundary: true, quotable: true });
  if (request.soulName !== null) {
    addNeedle({ label: "soul name", text: request.soulName, boundary: false, quotable: false });
  }
  request.needles.forEach((text, index) => {
    addNeedle({ label: `--needle #${index + 1}`, text, boundary: false, quotable: false });
  });

  const personalNeedles: Needle[] =
    scope === "personal"
      ? request.personalValues
          .filter((value) => value !== "")
          .map((value, index) => ({
            label: `person.md value #${index + 1}`,
            text: value,
            boundary: false,
            quotable: false,
          }))
      : [];

  // --- the trees, and the one file ---------------------------------------
  // The trees are the data map's (`map.ts`), in its order: `mind deploy
  // plan` reads the same list, so a place added there is a place both erase
  // and deploy know about, rather than one of them.
  //
  // Why the run records, the trigger times and the rest are under `ledger`
  // rather than a sixth id, and why a record left behind is not a politeness
  // question: `verifyErase` searches the whole state root for the identifier
  // afterwards, so anything the list forgot would turn every erase into
  // `erased-with-remainder` — a true report of a mess this file made.
  const files: string[] = [];

  if (agentDir === null) {
    notes.push(
      "--no-agent: no repository was examined. soul/, .mind/ and the working tree are recorded " +
        "on the certificate as not examined, at the requester's word.",
    );
  } else if (scope === "personal") {
    files.push(personFile(agentDir));
    notes.push(
      "--personal keeps role.md, memory/ and consent/. The soul will not load again until a " +
        "new person.md is written: a soul is two files and the loader requires both.",
    );
  }
  // Only a key that is really there is kept, and only then is it said: with no key, nothing under
  // `<subject>/` is anybody's reason to stay, and a hit there is a leftover (S15.8 re-review).
  const keyFile = keyPath(identityDirFor(env, subject));
  // A key, read the way `key` reads it (it creates nothing): any other file at that path — text, a link, a key
  // someone else could read — is not the agent's identity and is not kept (S15.8 third review).
  const keyKept = scope === "personal" && (await readAgentKey(identityDirFor(env, subject))).state === "present";
  if (keyKept) {
    notes.push(
      `--personal keeps the agent's signing key (${keyFile}), as it keeps role.md: the key is the agent's ` +
        "identity, not the person's data (D-138). Its path names the subject; the search below reports that as " +
        "kept only while nothing else is left beside it. A full erase, without --personal, removes it.",
    );
  }

  const emptyParents: string[] = [];
  const personal = await personalDir(env, subject);
  if (!personal.ok) {
    refusals.push(`the personal directory cannot be resolved: ${personal.reason}`);
  } else {
    emptyParents.push(dirname(personal.path));
  }
  // The personal directory goes only where it resolved outside git. Its raw
  // capture tree and the proposal store (S5.2, D-029) are both under it, which
  // is why the map labels it for what goes rather than for its place id.
  const wanted = subjectTrees(env, subject, agentDir, scope === "all").filter(
    (tree) => tree.key !== "personal" || personal.ok,
  );
  const ragDir = ragDirFor(env.home, env.env, subject);

  const trees: TreeTarget[] = [];
  for (const target of wanted) {
    const planned = await planPurgeDir(subject, target.dir);
    if ("ok" in planned) {
      refusals.push(`${target.label}: ${planned.reason}`);
      continue;
    }
    trees.push({ place: target.place, label: target.label, plan: planned });
  }

  // --- the local backends' homes (S7.1, S7.2, I-4) --------------------------
  // A local turn leaves the vendor CLI's transcripts in a home of Mind's own — one per backend, for every subject.
  // Nothing in it is keyed by subject, so it is not in `subjectTrees`; it is removed whole when this subject is
  // tied to it, and said to be left when not (`local-cli-plan.ts`).
  const homeCandidates: HomeCandidate[] = [];
  for (const home of dataMap(env, subject, null).shared) {
    homeCandidates.push({ tree: home, dir: home.dir, ledger: ledgerDir(env, subject) });
  }
  const localCli = await tieLocalCliHomes(subject, homeCandidates, needles);
  for (const home of localCli) {
    if (home.handling === "unreadable") {
      refusals.push(home.sentence);
      continue;
    }
    notes.push(home.sentence);
    if (home.handling === "left-alone") continue;
    if (scope === "personal") {
      notes.push(
        `--personal removes ${home.backend}'s home whole as well: a vendor transcript carries no personal flag, so ` +
          `it cannot be split into personal and not — the same reason the whole ledger goes.`,
      );
    }
    const planned = await planPurgeDir(subject, home.dir);
    if ("ok" in planned) {
      refusals.push(`${home.label}: ${planned.reason}`);
      continue;
    }
    trees.push({ place: "ledger", label: home.label, plan: planned });
  }

  // --- the blocks ---------------------------------------------------------
  const manifests = await manifestTargets(backupTree(env, subject));
  const blocks = await planBlocks(
    [...request.instructionFiles, ...manifests.paths],
    subject,
  );
  for (const block of blocks) {
    if (block.outcome === "refused") {
      refusals.push(`${block.path}: ${block.reason ?? "refused"}`);
    }
  }

  // --- the ledger ---------------------------------------------------------
  const ledgerEnv: LedgerEnv = {
    home: env.home,
    env: env.env,
    now: env.now,
    ...(env.machine === undefined ? {} : { machine: env.machine }),
  };
  const ledger = await planForget(ledgerEnv, subject, { kind: "all" });
  if (scope === "personal" && ledger.matched.length > 0) {
    notes.push(
      `the whole ledger goes (${ledger.matched.length} line(s)) because Mind cannot split it, ` +
        `not because all of it is personal: a ledger line carries no per-record personal flag, ` +
        `so there is no query that would keep the work turns and drop the rest. D-022 records ` +
        `that nothing reads the ledger back into an agent's behaviour, so no work knowledge is ` +
        `lost with it — but conversations about work are in there and they are going too.`,
    );
  }

  // --- the vector collection (S4.1, D-038) --------------------------------
  const vector = await probeVector(env, subject, ragDir, refusals, notes);

  // --- the places that are not built --------------------------------------
  const reserved: ReservedProbe[] = [];
  for (const place of notBuiltPlaces()) {
    const path =
      agentDir === null || place.reserved === undefined ? null : join(agentDir, place.reserved);
    const counted = path === null ? null : await census(path);
    reserved.push({ place: place.id, owedBy: place.owedBy ?? "unassigned", path, census: counted });
    if (counted !== null && counted.files > 0) {
      refusals.push(
        `${path} holds ${counted.files} file(s), and the ${place.id} place has no deleter ` +
          `(${place.owedBy} owes it). Mind will not certify a deletion over a directory ` +
          `nothing in this repository claims — remove it yourself, or land ${place.owedBy} first.`,
      );
    }
  }

  const scopes: Scope[] = [
    { label: "state root", kind: "deletable", tree: state },
    {
      label: "data root",
      kind: "deletable",
      tree: data,
      ...(keyKept ? { kept: [keyFile] } : {}),
    },
    {
      label: "vendor instruction files",
      kind: "deletable",
      files: [...new Set([...request.instructionFiles, ...manifests.paths])],
    },
  ];
  if (agentDir !== null) {
    scopes.push({ label: "the agent working tree (minus .git)", kind: "git", tree: agentDir });
  }

  if (manifests.unreadable.length > 0) {
    notes.push(
      `${manifests.unreadable.length} backup manifest(s) could not be read, so any instruction ` +
        `file named only by them was not visited. They are deleted with the backup tree either ` +
        `way; the files they pointed at may still hold a block.`,
    );
  }
  // `null` means `--no-agent` — nobody was asked. It no longer doubles as
  // "asked, and the answer could not be read": `historyFacts` says that itself
  // now, because the `.catch(() => null)` here never fired (`runGuarded`
  // returns a non-zero code rather than throwing) and a certificate was
  // printing `0 commit(s) · no remote configured` about repositories git had
  // declined to read (odd2 H3).
  const git = agentDir === null ? null : await historyFacts(agentDir);
  if (git !== null) {
    notes.push(
      `Mind does not commit and does not rewrite history (D-013, S0.4 AC2). Removing files ` +
        `from the working tree leaves the repository dirty, and every version already committed ` +
        `stays reachable — \`git log -p\` still prints what it held. ${historySentence(git)}.`,
    );
    if (git.readable && git.remotes.length > 0) {
      notes.push(
        `every copy those remotes hold is beyond this command, and Mind cannot see what a ` +
          `remote it does not know about received.`,
      );
    }
    if (!git.readable && git.why === "unreadable") {
      notes.push(
        `this directory is a repository that git declined to read, so nothing below is a ` +
          `statement about its history. A count of zero would have been one.`,
      );
    }
    if (!git.readable && git.why === "no-git") {
      notes.push(
        `there is no git on this machine, so this directory was never asked whether it is a ` +
          `repository. The working tree was still visited and is still erased from; what a ` +
          `history here might hold is outside every number below, and so is whether there is ` +
          `one at all.`,
      );
    }
  }

  // Review of PR #22: a running task would go on writing (its next step's turn, a ledger line) after the
  // certificate. Its unfinished tasks are ended first, at commit; listed here so the dry run says so.
  const tasksAt = join(personalPath(env, subject), TASKS_DIR);
  const tasks = (await listTasks(tasksAt, subject)).records.filter((record) => !isFinal(record.status)).map((record) => record.id);
  if (tasks.length > 0) {
    notes.push(`${tasks.length} task(s) of this subject have not ended (${tasks.join(", ")}); they are stopped, and their step's turn ended, before anything is removed.`);
  }

  const browsers = (await readBrowserRecords(env, subject)).records.map((record) => ({
    task: record.task,
    container: record.container,
  }));
  if (browsers.length > 0) {
    notes.push(
      `${browsers.length} browser task(s) of this subject are recorded; their containers are docker-killed ` +
        `before the records and the recordings go.`,
    );
  }

  return {
    subject,
    scope,
    by: request.by,
    at: env.now().toISOString(),
    agentDir,
    stateRoot: state,
    dataRoot: data,
    trees,
    tasks,
    tasksAt,
    browsers,
    files,
    emptyParents,
    blocks,
    localCli,
    ledger,
    reserved,
    vector,
    unreadableManifests: manifests.unreadable,
    needles,
    personalNeedles,
    scopes,
    git,
    refusals,
    notes,
  };
}

/**
 * Find the collection, and decide whether this run may certify over it.
 *
 * The marker wins over the environment: it says where Mind actually wrote,
 * and an `MIND_QDRANT_URL` changed since then would otherwise send the
 * question to a store that was never written to and hear "absent".
 */
async function probeVector(
  env: EraseEnv,
  subject: SubjectId,
  ragDir: string,
  refusals: string[],
  notes: string[],
): Promise<VectorProbe> {
  const collection = collectionFor(subject);
  const marker = await readRagMarker(ragDir);
  const configured = vectorEndpoints(env.env);
  const url =
    marker !== null && marker !== "unreadable"
      ? marker.qdrantUrl
      : configured.ok
        ? configured.endpoints.qdrantUrl
        : null;

  if (url === null) {
    if (marker === "unreadable") {
      refusals.push(
        `${ragDir} records that vectors were written for this subject, and cannot be read to say ` +
          `where. Nothing was certified: the collection ${collection} may still exist.`,
      );
    } else if (!configured.ok) {
      notes.push(
        `no vector store was asked (${configured.reason}), and Mind holds no record of writing ` +
          `one for this subject.`,
      );
    }
    return { collection, url: null, marker, state: null };
  }

  const state = await collectionState(url, subject);
  if (state.kind === "unreachable") {
    if (marker !== null) {
      refusals.push(
        `Mind wrote vectors for this subject to ${url} and cannot reach it now ` +
          `(${state.reason}). Nothing was certified: the collection ${collection} may still hold ` +
          `their text. Run again when the store is up.`,
      );
    } else {
      notes.push(
        `the vector store at ${url} did not answer (${state.reason}). Mind holds no record of ` +
          `writing to it for this subject, so this is reported rather than refused — a ` +
          `collection written there by something else is outside this run.`,
      );
    }
  }
  return { collection, url, marker, state };
}

/** One tree, after the deletions, counted again from disk. */
export interface TreeResult {
  readonly place: PlaceId;
  readonly label: string;
  readonly dir: string;
  readonly removed: number;
  readonly failed: readonly { readonly path: string; readonly reason: string }[];
  readonly remaining: Census;
  readonly dirRemoved: boolean;
}

/** What the run actually did. Every number here is observed, none derived. */
export interface EraseResult {
  /** The subject's unfinished tasks, ended before anything was removed (review of PR #22). */
  readonly tasks: readonly EndedTask[];
  /** Each recorded browser task's container, and whether `docker kill` ended it. */
  readonly browsers: readonly { readonly task: string; readonly container: string; readonly ok: boolean; readonly detail: string }[];
  readonly trees: readonly TreeResult[];
  readonly files: readonly { readonly path: string; readonly removed: boolean; readonly reason?: string }[];
  /** Directories whose only remaining content was the subject's own name. */
  readonly emptyParents: readonly { readonly path: string; readonly removed: boolean }[];
  readonly blocks: readonly BlockRemovalResult[];
  readonly ledger: ForgetResult;
  readonly ledgerDirRemoved: boolean;
  /** `null` when the plan found no collection to drop. */
  readonly vector: { readonly dropped: boolean; readonly reason?: string } | null;
}

/**
 * Carry out the plan.
 *
 * Takes no {@link EraseEnv}. Everything it needs was resolved by
 * {@link planErase}, which is what makes "the dry run and the write agree about
 * what would happen" a property of the code rather than a hope.
 *
 * @throws {Error} when the ledger lock is held. A partial deletion reported as
 *   a success is the worst outcome available here, so it is not swallowed.
 */
export async function commitErase(plan: ErasePlan, docker: DockerIo = dockerIo(), endTasks: typeof endTasksForErase = endTasksForErase): Promise<EraseResult> {
  // First of all: the subject's tasks, so no step starts and no step's turn writes a ledger line after this.
  const tasks = await endTasks(plan.tasksAt, plan.subject, join(plan.stateRoot, RUNS_DIR), { now: new Date() });
  // Then, before anything is removed: a running container writes into the recording below.
  const browsers: { task: string; container: string; ok: boolean; detail: string }[] = [];
  for (const browser of plan.browsers) {
    browsers.push({ ...browser, ...(await killContainer(docker, browser.container)) });
  }

  const trees: TreeResult[] = [];
  for (const tree of plan.trees) {
    const result = await commitPurge(tree.plan);
    trees.push({
      place: tree.place,
      label: tree.label,
      dir: tree.plan.dir,
      removed: result.removed.length,
      failed: result.failed,
      remaining: result.remaining,
      dirRemoved: result.dirRemoved,
    });
  }

  const files: { path: string; removed: boolean; reason?: string }[] = [];
  for (const path of plan.files) {
    try {
      await unlink(path);
      files.push({ path, removed: true });
    } catch (cause) {
      files.push({ path, removed: false, reason: String(cause) });
    }
  }

  const blocks = await commitBlocks(plan.blocks);

  const emptyParents: { path: string; removed: boolean }[] = [];
  for (const path of plan.emptyParents) {
    emptyParents.push({
      path,
      removed: await rmdir(path).then(
        () => true,
        () => false,
      ),
    });
  }

  const ledger = await commitForget(plan.ledger);
  // The lock lives inside the directory, so it can only go once `commitForget`
  // has released it — the same order `ledger forget --all` uses.
  const ledgerDirRemoved =
    plan.ledger.matched.length > 0 ? await removeLedgerDirAt(plan.ledger.dir) : false;

  // The collection goes whole or not at all: D-035 measured per-point deletes
  // leaving the text on disk, and the client has no such call.
  const vector =
    plan.vector.url !== null && plan.vector.state?.kind === "present"
      ? await dropCollection(plan.vector.url, plan.subject)
      : null;

  return { tasks, browsers, trees, files, emptyParents, blocks, ledger, ledgerDirRemoved, vector };
}

/** The verdict. Never a boolean: "clean" and "clean enough" are different facts. */
export type EraseVerdict =
  /** Nothing was written. What is printed is what `--yes` would do. */
  | "dry-run"
  /**
   * Nothing of this subject was here, so nothing was erased.
   *
   * Not a certificate of erasure, and the certificate says so in words. It is
   * its own verdict rather than a flavour of `erased-and-verified` because the
   * two are different sentences: *this machine held nothing under that id* and
   * *what this machine held under that id is gone*. The first is also what a
   * mistyped id produces, with the real data sitting untouched one character
   * away, which is the failure I-4 is about.
   *
   * It does **not** distinguish "never existed here" from "an earlier run
   * erased it". Nothing can: both leave the same bytes on disk by design
   * (`search.ts` says so, `commitForget` leaves no tombstone, and the
   * certificate is issued and never kept). The only thing that could tell them
   * apart is a retained record that this subject was erased — itself a trace of
   * the subject, and one the next run's AC3 search would find.
   */
  | "nothing-found"
  /** Everything deletable went, and the identifier is findable nowhere in it. */
  | "erased-and-verified"
  /** It went, and something the owner has to decide about is still findable. */
  | "erased-with-remainder";

/**
 * What was there **before** anything was deleted, out of the plan.
 *
 * The plan is the only place this can come from: after the deletion these are
 * all zero on a run that worked and on a run that had nothing to do, which is
 * the very collapse this file exists to undo.
 */
export interface EraseFound {
  readonly files: number;
  readonly ledgerLines: number;
  /** 1 when the subject's vector collection existed, else 0. */
  readonly collections: number;
  /**
   * Applied blocks in vendor instruction files that are **this subject's**.
   *
   * `other-subject` is not counted, and the distinction is I-3's: a block
   * belonging to somebody else in a file this run happened to open is not a
   * trace of this subject, and counting it would let a machine full of other
   * people's identities turn a mistyped id into a run that "found" something.
   */
  readonly blocks: number;
  readonly total: number;
}

/**
 * What the run actually removed, counted from {@link EraseResult}.
 *
 * Directories are counted beside files, and that is a decision rather than
 * bookkeeping: `$XDG_DATA_HOME/mind/<subject>/` with nothing in it is still
 * the identifier AC3 says must be findable nowhere, and removing it is a real
 * removal. A `census` cannot see such a directory at all — an empty one and an
 * absent one are both `0 files, 0 directories` — so the *only* evidence that
 * one was there is that `rmdir` succeeded. Measured, not assumed:
 * `commitPurge`'s `dirRemoved` is true for a directory that existed and false
 * for one that never did.
 */
export interface EraseRemoved {
  readonly files: number;
  readonly directories: number;
  readonly ledgerLines: number;
  /** 1 when the collection was dropped, else 0. */
  readonly collections: number;
  readonly blocks: number;
  readonly total: number;
}

/** Add up what the plan saw, before a single unlink. */
export function whatWasFound(plan: ErasePlan): EraseFound {
  const files = plan.trees.reduce((total, tree) => total + tree.plan.before.files, 0);
  const ledgerLines = plan.ledger.matched.length;
  const blocks = plan.blocks.filter((block) => block.outcome === "strip").length;
  const collections = plan.vector.state?.kind === "present" ? 1 : 0;
  return { files, ledgerLines, collections, blocks, total: files + ledgerLines + collections + blocks };
}

/** Add up what really went, from the result and never from the plan. */
export function whatWasRemoved(result: EraseResult): EraseRemoved {
  const files =
    result.trees.reduce((total, tree) => total + tree.removed, 0) +
    result.files.filter((file) => file.removed).length;
  const directories =
    result.trees.filter((tree) => tree.dirRemoved).length +
    result.emptyParents.filter((parent) => parent.removed).length +
    (result.ledgerDirRemoved ? 1 : 0);
  const ledgerLines = result.ledger.removed;
  const blocks = result.blocks.filter((block) => block.removed).length;
  const collections = result.vector?.dropped === true ? 1 : 0;
  return {
    files,
    directories,
    ledgerLines,
    collections,
    blocks,
    total: files + directories + ledgerLines + collections + blocks,
  };
}

/** The re-read. Every number is taken from the filesystem after the deletions. */
export interface EraseVerification {
  readonly search: SearchReport;
  /** AC5: the values `person.md` held, looked for in the files that were kept. */
  readonly personal: SearchReport | null;
  /** Files still under a tree that was supposed to be emptied. */
  readonly remainingFiles: number;
  /**
   * Every one of those files, by path and by the tree it is under — read back from disk after the deletions.
   *
   * A count says that something is left; a transcript left in a local backend's home has to be *named*, or the
   * certificate says "1 file remains" and nothing about whose text it holds or where to find it (S7.2, I-4). The
   * certificate prints each under `verification`, besides the hits the search found.
   */
  readonly leftover: readonly { readonly path: string; readonly tree: string }[];
  /** Files Mind tried and failed to delete. */
  readonly failures: number;
  /**
   * The collection, asked about again after the drop. `null` when there was
   * nowhere to ask; otherwise what the store said *now*, never what the drop
   * returned.
   */
  readonly vectorAfter: CollectionState | null;
  /** What the plan saw before the deletion. The verdict turns on this. */
  readonly found: EraseFound;
  /** What the run removed. `erased-and-verified` requires this to be non-zero. */
  readonly removed: EraseRemoved;
  /**
   * Regular files whose bytes the search really read, over every scope.
   *
   * Evidence of *how much was looked at*, never a verdict on its own: a zero is
   * an empty machine **or** an id whose data is somewhere this run cannot see,
   * and a number above zero is a machine with other people's data on it and
   * nothing of this subject's — which is precisely what a mistyped id looks
   * like. It goes on the certificate so a reader can tell those apart; the
   * verdict is decided by {@link found} and {@link removed}.
   */
  readonly filesRead: number;
  /**
   * Scopes the search could not read at all, by label.
   *
   * `searchTree` answers zero hits for a root it could not open, exactly as it
   * does for a root that is not there, and only `unreadable` separates them. A
   * scope nobody could look into is not a scope that was found clean, so any
   * entry here keeps the verdict away from `erased-and-verified` **and** away
   * from `nothing-found`.
   */
  readonly unreadableScopes: readonly string[];
  readonly verdict: EraseVerdict;
}

/**
 * Read it all back, and decide.
 *
 * `erased-and-verified` needs five things at once: nothing left under any tree,
 * no deletion that failed, zero hits in every `deletable` scope, no scope that
 * could not be read — and **something actually removed**. A hit in the agent's
 * working tree — `memory/` naming its own subject is the ordinary case — is a
 * **remainder**: it is reported with `file:line`, it is never deleted, and it
 * makes the verdict `erased-with-remainder`. A real agent whose notes mention
 * the subject may never get a clean verdict, and that is the honest answer
 * rather than a gate that opens by not looking.
 *
 * ## Why `removed > 0` is in that list
 *
 * Every other arm is a count that reads zero for *clean* and zero for *there
 * was never anything here*, so a run over a subject this machine has never held
 * used to earn the full verdict having read no file at all. The discriminator
 * is not how much was read: a **mistyped id on a machine holding somebody
 * else's data** reads plenty of files, finds nothing, removes nothing, and is
 * the most dangerous shape this command has — a confident certificate while the
 * real data sits one character away, untouched. What separates a withdrawal
 * from a misfire is whether anything was *found before* and *went*, and both of
 * those are already known: {@link whatWasFound} from the plan, and
 * {@link whatWasRemoved} from the result.
 */
export async function verifyErase(
  plan: ErasePlan,
  result: EraseResult,
): Promise<EraseVerification> {
  const search = await searchScopes(plan.scopes, plan.needles);

  let personal: SearchReport | null = null;
  if (plan.personalNeedles.length > 0 && plan.agentDir !== null) {
    const kept = await searchTree(
      "files kept by --personal (role.md, memory/, consent/)",
      plan.agentDir,
      plan.personalNeedles,
    );
    personal = { scopes: [{ ...kept, kind: "git" }], deletableHits: 0, gitHits: kept.hits.length, keptHits: 0 };
  }

  // Counted from disk rather than from `result`: a commit that subtracted its
  // own successes from its own plan would report zero on a run where a file it
  // never managed to unlink is still sitting there.
  let remainingFiles = 0;
  const leftover: { path: string; tree: string }[] = [];
  for (const tree of plan.trees) {
    const left = await census(tree.plan.dir);
    remainingFiles += left.files;
    for (const path of left.paths) leftover.push({ path, tree: tree.label });
  }

  const vectorAfter =
    plan.vector.url === null || plan.vector.state?.kind === "unreachable"
      ? null
      : await collectionState(plan.vector.url, plan.subject);
  const vectorLeft = vectorAfter !== null && vectorAfter.kind !== "absent";

  // A browser container docker would not kill still runs with this subject's recording mounted.
  const failures =
    result.browsers.filter((browser) => !browser.ok).length +
    result.tasks.filter((task) => task.turn !== null && task.turn.survivors.length > 0).length +
    (result.vector !== null && !result.vector.dropped ? 1 : 0) +
    result.files.filter((file) => !file.removed).length +
    result.blocks.filter((block) => block.outcome === "refused").length +
    result.trees.reduce((total, tree) => total + tree.failed.length, 0);

  const filesRead = search.scopes.reduce((total, scope) => total + scope.filesRead, 0);
  const unreadableScopes = [...search.scopes, ...(personal?.scopes ?? [])]
    .filter((scope) => scope.unreadable !== undefined)
    .map((scope) => scope.label);

  const found = whatWasFound(plan);
  const removed = whatWasRemoved(result);

  const clean =
    !vectorLeft &&
    remainingFiles === 0 &&
    failures === 0 &&
    search.deletableHits === 0 &&
    search.gitHits === 0 &&
    search.keptHits === 0 &&
    unreadableScopes.length === 0 &&
    (personal === null || personal.gitHits === 0);

  // The order is the argument. Anything not clean is a remainder whatever else
  // happened; a clean run that removed something is a withdrawal; a clean run
  // that found nothing and removed nothing is a run over a subject that is not
  // here. The last line is the state that should not occur — the plan saw
  // something, nothing went, and nothing was left to find — and it is given the
  // conservative verdict rather than the flattering one.
  const verdict: EraseVerdict = !clean
    ? "erased-with-remainder"
    : removed.total > 0
      ? "erased-and-verified"
      : found.total === 0
        ? "nothing-found"
        : "erased-with-remainder";

  return {
    search,
    personal,
    remainingFiles,
    leftover,
    failures,
    vectorAfter,
    found,
    removed,
    filesRead,
    unreadableScopes,
    verdict,
  };
}
