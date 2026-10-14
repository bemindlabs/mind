/**
 * Proposals — what was asked for before it was done, and the refusals nobody is
 * allowed to forget.
 *
 * ## Why this is not in the ledger (D-029)
 *
 * S5.2 AC2 asks for a memory: *การปฏิเสธถูกจำ — ไม่เสนอเรื่องเดิมซ้ำโดยไม่มีอะไรใหม่*.
 * A memory is something read back into the next decision, and the ledger is the
 * one store in Mind that may never be read back into one (S2.2 AC5, D-022):
 * `ledger forget` would otherwise bring back every proposal the owner had
 * already said no to. The owner decided on 2026-09-22 (D-029) that proposals and
 * their outcomes get a **store of their own**, D-022 is not relaxed, and the
 * guard over it (`test/ledger/read-back.test.ts`) is not touched.
 *
 * So nothing here imports `src/ledger/`, and nothing in `src/ledger/` knows this
 * file exists. The two record different things: the ledger records that a turn
 * *happened*, this records what was *asked and answered*.
 *
 * ## The address, and why it is not a sixth place
 *
 * `$XDG_DATA_HOME/mind/<subject>/personal/proposals/<id>.json` — under
 * {@link import("../guard/personal.ts").personalDir}, the same tree raw capture
 * lives in (D-025). `what`, `why` and `impact` are free text about what the
 * owner does, which is the one category that may not be in git at all (S3.2 AC5,
 * D-014), and three properties come with that address rather than being
 * re-implemented here: the path is refused outright if it resolves inside a git
 * repository, the pre-commit scan's `personal-path` rule blocks anything staged
 * under a `personal/` directory at any depth, and the tree is created 0700.
 *
 * It is deliberately *not* a sixth `PlaceId`. S7.2 AC1 names five places and
 * `src/erase/places.ts` is closed to exactly those five; D-025 refused to put a
 * personal record outside `personal/` for this reason, and the same argument
 * applies here word for word. The cost is that `tsc` would not go red if
 * somebody moved this store out from under `personal/` — so
 * `test/decide/proposals.test.ts` asserts the containment, and
 * `test/erase/plan.test.ts` measures the consequence: a canary seeded here is
 * gone after `erase`, and a control file placed outside `personal/` is not.
 *
 * ## Deleting this store is allowed to change something
 *
 * Unlike the ledger, whose whole promise is that removing it changes nothing,
 * removing this one makes the agent forget that it was told no. That is not a
 * side effect — it is this store's entire job, and `rm` is how an owner says
 * *ask me again*. One file per proposal, so that is true of one refusal too.
 *
 * ## "The same thing" is exact, and the miss is said out loud
 *
 * {@link proposalKey} is NFC, trim, collapse runs of whitespace, lower-case.
 * That is all of it, and it is describable in one sentence on purpose: a fuzzy
 * comparison decides for the owner which two requests are "really" the same, and
 * gets it wrong in both directions without saying so. The cost is real and is
 * not hidden — **change one word in `what` and the refusal no longer bites**. It
 * is paid for at the other end: every command that files or decides a proposal
 * prints the subject's refusals in full, every time, so that the wide comparison
 * is made by a person looking at the list rather than by a regular expression
 * pretending to.
 *
 * `--changed <text>` is the declared way past a refusal, and it is recorded:
 * {@link Proposal.supersedes} names the proposal it is answering and
 * {@link Proposal.changed} says what is new. Somebody who wants to slip a
 * refused idea through can still reword `what`; the difference is that this way
 * leaves a record saying they did.
 *
 * ## An approval is spent once
 *
 * The owner's decision, 2026-09-22: *"อนุมัติต่อ proposal และใช้ได้ครั้งเดียว"* —
 * per proposal, and good for one turn. A standing approval is how "I allowed it
 * once" becomes "it has been doing that ever since", with nothing to show when
 * the old permission was used again. {@link spendability} refuses a second turn.
 *
 * "Once" has to hold for two turns that start together, too: two taps on the
 * page's "Do it now", or the app's "Run now", are two `turn` processes that
 * each read the record as unspent (D-144). Reading and then rewriting a record
 * cannot settle that, however close together the two steps are — so the spend
 * is not a rewrite. {@link claimApproval} *creates* `spent/<id>.json` with
 * `link(2)`, which fails with `EEXIST` for everyone after the first: one
 * exclusive step, on any number of processes, with nothing to hold and so no
 * lock to go stale. The file is written whole and synced before it is linked,
 * so a turn that lost can always say which turn won. One claim per **id**, so
 * two records that carry the same id — a copy somebody made — are spent once
 * between them. {@link readProposals} folds every claim into its record, so each
 * reader sees the spend whether or not the record's own copy of it was
 * written; the copy is for somebody reading the file.
 *
 * Nothing takes a claim back (D-144 §2, the owner's decision of 2026-09-29): an
 * approval a failed turn took stays spent. A killed turn could not hand it back,
 * and one that reached a backend may have acted. When that turn sent nothing at
 * all, `turn` marks the record {@link Proposal.sentNothing}, and it may be
 * asked for again — a new proposal from its own record, once
 * ({@link refileProblem}). "Once" is claimed the way a spend is
 * ({@link claimRefile}, `refiled/<id>.json`), before the new record is
 * written: a bulk "File it again" read by six processes at once files one.
 *
 * ## Paths are never built from an argument
 *
 * A caller looks a proposal up by reading the directory and matching
 * {@link Proposal.id}, never by joining the id onto a path — see
 * {@link findProposal}. A record is only ever rewritten at the path it was read
 * from ({@link writeProposalAt}), never at one built from its `id` field; and an
 * id that is not one plain file name ({@link isProposalId}) makes the file no
 * record at all, so a hand-edited `../../escaped` can reach no path — not a
 * rewrite, not a claim, not a triage. `proposal new` mints ids with
 * `crypto.randomUUID()`. `../../etc/passwd` from a command line is therefore not
 * a filename here; it is an id that matches no record.
 *
 * ## An approval is bound to the action (D-153)
 *
 * Before this, `turn --proposal <id>` spent the approval on whatever prompt the
 * caller sent with it: an approval for "rotate the logs" paid for any turn
 * (e2e finding 6, `notes/2026-10-04_e2e-actions.md`). Now every record carries
 * a canonical {@link ProposalAction} — for a turn, the prompt, which is its
 * `what` word for word — and its digest ({@link actionDigest}). `proposal
 * decide --approve` writes that digest into the decision, so the yes names
 * exactly what it said yes to. {@link boundAction} is what a turn asks: the
 * action to run, built from the record and from nothing the caller sent, or
 * why it may not run — the record no longer matches the digest that was
 * approved. A turn that is handed a prompt as well refuses it unless it is the
 * approved one.
 *
 * An approval with no digest is refused, with "approve it again": one given
 * before this existed (D-144 is unreleased, and they are few), or one whose
 * digest was stripped. Honouring it would let an edit — `what` changed, the
 * digest and `action` deleted — run as a "legacy" approval (review of PR #18,
 * measured). Such an approval — like one whose record no longer matches its digest —
 * is never listed as runnable: {@link needsReapproval} lists it apart, and it is filed again from its own record as a new proposal
 * waiting for a new yes — once, claimed like any refile ({@link refileProblem}).
 * Asking again is safe whichever it was: nothing runs until somebody approves the
 * new record, whose digest is bound to its own `what`.
 *
 * **What the digest is, and is not.** It catches a record that *changed*
 * after the yes — a slip, a stale copy, an edit that did not bother to cover
 * itself. It does not stop somebody *determined* to edit the record: the
 * digest is a plain sha256 in the same file, and anything that can write the
 * state root — which a vendor CLI running as the owner can — can recompute it.
 * The same limit D-042 states for level-3 confirmations; the real boundary is
 * a separate uid or a sandbox, outside Mind.
 */

import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ensurePersonalDir,
  personalDir,
  type PersonalDir,
  type PersonalEnv,
} from "../guard/personal.ts";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";
import type { SubjectId } from "../types.ts";

/** Schema tag every proposal file carries. Bumped when the shape changes. */
export const PROPOSAL_SCHEMA = "mind/proposal@1";

/** The directory under a subject's personal directory. One word, declared once. */
export const PROPOSALS_DIR = "proposals";

/**
 * Where approvals are claimed (D-144): `proposals/spent/`, beside `triage/`.
 *
 * A directory rather than a suffix on the record's name, because
 * {@link readProposals} reads files and reports every one it cannot parse — a
 * claim beside the records would be announced as a broken proposal on every
 * run. Under `personal/` like the rest, so `erase` takes it with them.
 */
export const SPENT_DIR = "spent";

/** Schema tag every claim carries. */
export const SPEND_SCHEMA = "mind/proposal-spend@1";

/**
 * Where refiles are claimed (D-144, follow-up): `proposals/refiled/<old id>.json`, created the way a spend is,
 * so a spent approval is filed again once however many processes ask at the same moment — a bulk "File it
 * again", two pages, a page and a terminal.
 */
export const REFILED_DIR = "refiled";

/** Schema tag every refile claim carries. */
export const REFILE_SCHEMA = "mind/proposal-refile@1";

/**
 * What an approval pays for, in canonical form (D-153).
 *
 * One kind today: a `turn`, whose prompt is the proposal's `what`, word for
 * word, so what a person reads when they approve is exactly what runs. The
 * browser layer (E17 S17.7–S17.9) adds its own kinds — a step on an origin —
 * and they are bound and spent the same way.
 */
export type ProposalAction = { readonly kind: "turn"; readonly prompt: string };

/** Prefix of every action digest, so a digest says which hash it is. */
export const ACTION_DIGEST_PREFIX = "sha256:";

/**
 * The canonical text of an action: JSON with its keys sorted, no whitespace.
 * Two records that mean the same action produce the same bytes, whatever order
 * their fields were written in.
 */
export function canonicalAction(action: ProposalAction): string {
  const sorted = Object.fromEntries(Object.entries(action).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify(sorted);
}

/** `sha256:<hex>` of {@link canonicalAction}. */
export function actionDigest(action: ProposalAction): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalAction(action));
  return `${ACTION_DIGEST_PREFIX}${hasher.digest("hex")}`;
}

/** The action a turn proposal pays for: its `what`, as the prompt. */
export function turnAction(what: string): ProposalAction {
  return { kind: "turn", prompt: what };
}

/** The machine facts this store may see — all of them arguments, as ever. */
export type ProposalEnv = PersonalEnv;

/**
 * `personalDir(subject)/proposals/`, if that is outside git — resolved, not created.
 *
 * Split from {@link ensureProposalsDir} for the reason `personalDir` is split:
 * `proposal list` prints a path and must not bring it into existence by being
 * asked where it would be.
 */
export async function proposalsDir(env: ProposalEnv, subject: SubjectId): Promise<PersonalDir> {
  const parent = await personalDir(env, subject);
  if (!parent.ok) return parent;
  return { ok: true, path: join(parent.path, PROPOSALS_DIR) };
}

/** The same directory, created 0700 under a personal directory created 0700. */
export async function ensureProposalsDir(
  env: ProposalEnv,
  subject: SubjectId,
): Promise<PersonalDir> {
  const parent = await ensurePersonalDir(env, subject);
  if (!parent.ok) return parent;
  const path = join(parent.path, PROPOSALS_DIR);
  await mkdir(path, { recursive: true, mode: STATE_DIR_MODE });
  return { ok: true, path };
}

/** What an owner said. There is no third answer, and no "not yet" that is not `null`. */
export type Outcome = "approved" | "refused";

/** One answer, with who gave it and when. */
export interface Decision {
  readonly outcome: Outcome;
  /** ISO 8601, UTC. */
  readonly at: string;
  /**
   * Who decided, as the caller reports it.
   *
   * A parameter rather than something read from the machine here: nothing under
   * `src/` reads `process.env` or `userInfo()` (D-021), so the CLI supplies the
   * name the same way `autonomy set` records one.
   */
  readonly by: string;
  /** Why, in the decider's own words. Free text, so it stays in `personal/`. */
  readonly note: string | null;
  /**
   * The {@link actionDigest} of what was decided (D-153). Written by
   * {@link decideProposal}; absent on a decision made before approvals were
   * bound to their action.
   */
  readonly actionDigest?: string;
}

/** One proposal: the three things AC1 asks for, and what happened to it. */
export interface Proposal {
  readonly schema: string;
  readonly id: string;
  readonly subject: SubjectId;
  /** When it was filed. ISO 8601, UTC. */
  readonly at: string;
  /** What would be done. */
  readonly what: string;
  /** Why it would be done. */
  readonly why: string;
  /** What it would affect. */
  readonly impact: string;
  /** What an approval of it runs (D-153). For a turn, `what` as the prompt. */
  readonly action: ProposalAction;
  /** {@link actionDigest} of {@link action}, recomputed whenever the record is read. */
  readonly actionDigest: string;
  /** {@link proposalKey} of `what`, stored so a reader can see what was compared. */
  readonly key: string;
  /** The proposal this one is a second attempt at, when `--changed` was given. */
  readonly supersedes: string | null;
  /** What is new since that one — the owner's reason for letting it be asked again. */
  readonly changed: string | null;
  /** `null` until somebody answers. */
  readonly decision: Decision | null;
  /** The turn that spent this approval. An approval is good for one (D-029, I-6). */
  readonly usedByTurn: string | null;
  readonly usedAt: string | null;
  /**
   * Written, `true`, when the turn that spent this approval ended having sent nothing to any backend (D-144
   * §2). The approval stays spent all the same; this is what lets it be filed again ({@link refileProblem}).
   * Absent otherwise — including when a turn got further, or was killed before it could say.
   */
  readonly sentNothing?: true;
  /**
   * The proposal this one was filed again as, read from its refile claim (`refiled/<id>.json`) by
   * {@link readProposals}. Never read from the record itself: the claim is the only thing that says so.
   */
  readonly refiledAs?: string;
  /**
   * Who wrote it: a person at `proposal new`, or the agent in a level-1 turn
   * (D-045). A record from before the field existed was filed by a person.
   */
  readonly filedBy: "person" | "agent";
  /** The turn whose answer it came out of, when the agent filed it. */
  readonly fromTurn: string | null;
}

/**
 * The comparison key: NFC, trimmed, inner whitespace collapsed, lower-cased.
 *
 * Unicode normalisation first, because two visually identical Thai or accented
 * strings can be different byte sequences and telling somebody their proposal is
 * "new" on that basis would be nonsense. Everything after it is the ordinary
 * shape of a typed-twice sentence: a stray trailing space, a double space, a
 * capital at the start.
 *
 * What it deliberately does not do: stem, strip punctuation, drop stop words, or
 * measure a distance. Each of those would make the key match things the owner
 * did not say were the same, and the failure would be silent in the direction
 * that matters — a proposal refused as a repeat of something it is not.
 */
export function proposalKey(what: string): string {
  return what.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Everything {@link describeProposal} needs, with nothing inferred from the machine. */
export interface NewProposal {
  readonly id: string;
  readonly subject: SubjectId;
  readonly at: Date;
  readonly what: string;
  readonly why: string;
  readonly impact: string;
  readonly supersedes?: string | null;
  readonly changed?: string | null;
  readonly filedBy?: "person" | "agent";
  readonly fromTurn?: string | null;
}

/** A proposal record, before it has been anywhere near a disk. */
export function describeProposal(options: NewProposal): Proposal {
  const action = turnAction(options.what);
  return {
    schema: PROPOSAL_SCHEMA,
    id: options.id,
    subject: options.subject,
    at: options.at.toISOString(),
    what: options.what,
    why: options.why,
    impact: options.impact,
    action,
    actionDigest: actionDigest(action),
    key: proposalKey(options.what),
    supersedes: options.supersedes ?? null,
    changed: options.changed ?? null,
    decision: null,
    usedByTurn: null,
    usedAt: null,
    filedBy: options.filedBy ?? "person",
    fromTurn: options.fromTurn ?? null,
  };
}

/**
 * Whether an id is one plain file name: a letter or digit, then letters,
 * digits, `.`, `_` or `-`, at most 128 in all.
 *
 * Every id Mind mints is a UUID and passes. What does not pass is anything
 * that could be a path — `/`, `\`, `..`, a leading dot, NUL — which a record
 * only carries if somebody edited it by hand. {@link asProposal} refuses such a
 * record outright, so no id that reaches a caller can climb out of the store.
 */
export function isProposalId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

/**
 * Where a **new** record is written.
 *
 * Only ever called with an id this module minted — see the header; a record
 * that already exists is rewritten where it was read ({@link writeProposalAt}).
 * It is exported so a test can assert the containment that `tsc` cannot.
 */
export function proposalPath(dir: string, id: string): string {
  if (!isProposalId(id)) throw new Error(`${JSON.stringify(id)} is not a proposal id — it would not be one file name`);
  return join(dir, `${id}.json`);
}

/** File a new record under its own id. See {@link writeProposalAt}. */
export async function writeProposal(dir: string, proposal: Proposal): Promise<string> {
  const path = proposalPath(dir, proposal.id);
  await writeProposalAt(path, proposal);
  return path;
}

/**
 * Write a record at a path, whole or not at all.
 *
 * Through a temporary file in the same directory and a rename, like
 * `commitBlocks`: `decide` rewrites a record that already exists, and a record
 * truncated by a crash is a proposal whose outcome cannot be read — which this
 * store would then report as `pending` and let somebody answer a second time.
 *
 * A rewrite goes to {@link StoredProposal.path}, the file it was read from —
 * never to a path built from the `id` inside it, which is text in a file.
 */
export async function writeProposalAt(path: string, proposal: Proposal): Promise<void> {
  const temp = `${path}.mind-${process.pid}.tmp`;
  try {
    await writeWhole(temp, `${JSON.stringify(proposal, null, 2)}\n`, "w");
    await rename(temp, path);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

/** Write a file and flush it to the device before anyone renames or links it into place. */
export async function writeWhole(path: string, text: string, flag: "w" | "wx"): Promise<void> {
  const handle = await open(path, flag, STATE_FILE_MODE);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flush a directory's list of names, so a link just made in it survives a power cut. */
async function syncDir(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** A record read back off disk, with the path it came from. */
export interface StoredProposal {
  readonly path: string;
  readonly proposal: Proposal;
}

/** A file under `proposals/` that is not a record Mind wrote. */
export interface UnreadableProposal {
  readonly path: string;
  readonly reason: string;
}

/** Everything under `proposals/`, separated into what parsed and what did not. */
export interface ProposalInventory {
  /** Newest first — the order every list is printed in. */
  readonly proposals: readonly StoredProposal[];
  readonly unreadable: readonly UnreadableProposal[];
}

/** A decision read off disk, or the reason that file is not one. */
function asDecision(value: unknown): Decision | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const outcome = raw["outcome"];
  if (outcome !== "approved" && outcome !== "refused") return null;
  return {
    outcome,
    at: typeof raw["at"] === "string" ? raw["at"] : "",
    by: typeof raw["by"] === "string" ? raw["by"] : "",
    note: typeof raw["note"] === "string" ? raw["note"] : null,
    // Kept exactly as written, even when malformed: `boundAction` compares it, and a digest that was tampered
    // into nonsense must fail that comparison rather than read as "approved before digests existed".
    ...(raw["actionDigest"] === undefined ? {} : { actionDigest: typeof raw["actionDigest"] === "string" ? raw["actionDigest"] : "" }),
  };
}

/**
 * The action a record holds, or why it holds none this version runs.
 *
 * A record from before actions existed has none, and its action is its `what`. A record that carries one
 * must carry a `turn` whose prompt **is** its `what`: the text a person approves is the text that runs, and
 * a record where the two differ is one somebody edited, not one Mind wrote.
 */
function asAction(raw: unknown, what: string): ProposalAction | string {
  if (raw === undefined) return turnAction(what);
  if (typeof raw !== "object" || raw === null) return "action is not an object";
  const fields = raw as Record<string, unknown>;
  if (fields["kind"] !== "turn") return `action kind ${JSON.stringify(fields["kind"])} is not one this version runs`;
  const extra = Object.keys(fields).filter((key) => key !== "kind" && key !== "prompt");
  if (extra.length > 0) return `action has fields this version does not know: ${extra.join(", ")}`;
  if (fields["prompt"] !== what) return "action.prompt is not the proposal's what — what is approved is what runs, word for word";
  return turnAction(what);
}

/**
 * A record off disk, or a sentence saying why that file is not one.
 *
 * Refuses rather than repairs, for the reason `parseDial` gives: a file this
 * program cannot understand is not a file whose meaning may be guessed, and here
 * the guess would be about whether somebody said yes.
 */
export function asProposal(value: unknown): Proposal | string {
  if (typeof value !== "object" || value === null) return "not a JSON object";
  const raw = value as Record<string, unknown>;
  if (raw["schema"] !== PROPOSAL_SCHEMA) return `schema is not ${PROPOSAL_SCHEMA}`;
  const id = raw["id"];
  const subject = raw["subject"];
  const what = raw["what"];
  if (typeof id !== "string" || id === "") return "id is missing";
  // Before anything else is believed: an id is joined onto paths further down (a
  // claim, a triage), and one that could be a path is not an id Mind wrote.
  if (!isProposalId(id)) return `id ${JSON.stringify(id.slice(0, 80))} is not one plain file name`;
  if (typeof subject !== "string" || subject === "") return "subject is missing";
  if (typeof what !== "string" || what === "") return "what is missing";
  const action = asAction(raw["action"], what);
  if (typeof action === "string") return action;

  const text = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const orNull = (key: string): string | null =>
    typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : null;

  return {
    schema: PROPOSAL_SCHEMA,
    id,
    subject: subject as SubjectId,
    at: text("at"),
    what,
    why: text("why"),
    impact: text("impact"),
    action,
    // Recomputed rather than trusted, like the key: the digest the approval holds is compared against this.
    actionDigest: actionDigest(action),
    // Recomputed rather than trusted: the key is what decides whether a later
    // proposal is a repeat, and a file that carries a key which does not match
    // its own `what` would answer that question with something hand-edited.
    key: proposalKey(what),
    supersedes: orNull("supersedes"),
    changed: orNull("changed"),
    decision: asDecision(raw["decision"]),
    usedByTurn: orNull("usedByTurn"),
    usedAt: orNull("usedAt"),
    ...(raw["sentNothing"] === true ? { sentNothing: true as const } : {}),
    filedBy: raw["filedBy"] === "agent" ? "agent" : "person",
    fromTurn: orNull("fromTurn"),
  };
}

/**
 * Read every proposal for one subject.
 *
 * Never throws, and reports what it could not read instead of skipping it: a
 * file in here that does not parse may be a refusal, and silently not counting
 * one is how this store would go back on the only promise it makes. A missing
 * directory is an empty inventory — nothing has been proposed yet.
 *
 * Every record this store writes is `<id>.json`, so a `.json` name is what is
 * read. Anything else is not a record and is not read as one: a write in flight
 * (`<id>.json.mind-<pid>.tmp`) or a backup somebody made (`<id>.json.bak`) would otherwise be a second
 * copy of a record — and, before claims were keyed by id, a second approval to
 * spend.
 */
export async function readProposals(dir: string): Promise<ProposalInventory> {
  const proposals: StoredProposal[] = [];
  const unreadable: UnreadableProposal[] = [];

  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch {
    return { proposals, unreadable };
  }

  const claimed = await claimNames(join(dir, SPENT_DIR));
  const refiled = await claimNames(join(dir, REFILED_DIR));
  for (const name of names) {
    const path = join(dir, name);
    try {
      const parsed = asProposal(JSON.parse(await readFile(path, "utf8")));
      if (typeof parsed === "string") unreadable.push({ path, reason: parsed });
      else {
        const spent = claimed.has(`${parsed.id}.json`) ? await withClaim(parsed, claimPath(dir, SPENT_DIR, parsed.id)) : parsed;
        const again = refiled.has(`${parsed.id}.json`) ? await readRefileClaim(claimPath(dir, REFILED_DIR, parsed.id)) : undefined;
        proposals.push({ path, proposal: again === undefined ? spent : { ...spent, refiledAs: again.as } });
      }
    } catch (cause) {
      unreadable.push({ path, reason: String(cause) });
    }
  }

  proposals.sort((a, b) => b.proposal.at.localeCompare(a.proposal.at));
  return { proposals, unreadable };
}

/** The file names in a claims directory (`spent/`, `refiled/`) — one per claim — or none. */
async function claimNames(claimsDir: string): Promise<ReadonlySet<string>> {
  try {
    return new Set(await readdir(claimsDir));
  } catch {
    return new Set();
  }
}

/**
 * Where a claim on an id is: `spent/<id>.json` or `refiled/<id>.json`.
 *
 * Keyed by the id rather than the record's file, so every record that carries
 * one id shares one claim. Safe to join because an id that reaches here passed
 * {@link isProposalId} in {@link asProposal}; checked again all the same, since
 * this is the one line in the store that turns a record's text into a path.
 */
function claimPath(dir: string, claims: typeof SPENT_DIR | typeof REFILED_DIR, id: string): string {
  if (!isProposalId(id)) throw new Error(`${JSON.stringify(id)} is not a proposal id — it would not be one file name`);
  return join(dir, claims, `${id}.json`);
}

/** What a refile claim says: the proposal it was filed again as, and when. Unreadable is still a claim. */
async function readRefileClaim(path: string): Promise<{ readonly as: string; readonly at: string | null }> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const as = raw["as"];
    const at = raw["at"];
    return { as: typeof as === "string" && as !== "" ? as : "unknown", at: typeof at === "string" && at !== "" ? at : null };
  } catch {
    return { as: "unknown", at: null };
  }
}

/** What a claim says: the turn that took the approval, and when. */
async function readClaim(path: string): Promise<{ readonly turn: string; readonly at: string | null }> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const turn = raw["turn"];
    const at = raw["at"];
    return {
      turn: typeof turn === "string" && turn !== "" ? turn : "unknown",
      at: typeof at === "string" && at !== "" ? at : null,
    };
  } catch {
    // A claim is written whole before it appears, so this is a file somebody
    // edited. It is still a claim: its existence is the spend.
    return { turn: "unknown", at: null };
  }
}

/**
 * A record with its claim folded in. The record's own copy wins when it has
 * one — both name the same turn, and the record is the older fact.
 */
async function withClaim(proposal: Proposal, path: string): Promise<Proposal> {
  if (proposal.usedByTurn !== null) return proposal;
  const claim = await readClaim(path);
  return { ...proposal, usedByTurn: claim.turn, usedAt: claim.at };
}

/**
 * One proposal by id, matched against what is on disk.
 *
 * The only lookup there is, and the reason there is no `readProposal(dir, id)`:
 * an id that came off a command line must never become a path segment.
 */
export function findProposal(
  inventory: ProposalInventory,
  id: string,
): StoredProposal | undefined {
  return inventory.proposals.find((stored) => stored.proposal.id === id);
}

/** Every proposal this subject has had refused, newest first. */
export function refusedProposals(inventory: ProposalInventory): readonly Proposal[] {
  return inventory.proposals
    .map((stored) => stored.proposal)
    .filter((proposal) => proposal.decision?.outcome === "refused");
}

/**
 * The proposal that stops this one being filed, if there is one.
 *
 * A key that was **refused** or is still **pending**. An *approved* twin does
 * not block: an approval is spent once (see {@link spendability}), so asking
 * again is asking again rather than a repeat of something already answered no —
 * and the whole point of a single-use approval is that the second time has to be
 * asked for.
 */
export function blockingProposal(
  inventory: ProposalInventory,
  key: string,
): Proposal | undefined {
  return inventory.proposals
    .map((stored) => stored.proposal)
    .find(
      (proposal) =>
        proposal.key === key &&
        (proposal.decision === null || proposal.decision.outcome === "refused"),
    );
}

/**
 * Answer a proposal, or say why it cannot be answered.
 *
 * A second decision is refused rather than overwritten. Changing a recorded
 * "no" into a "yes" in place would leave no trace that the question was ever
 * answered differently, and the owner's memory of having refused something is
 * the one thing this store exists to keep.
 */
export function decideProposal(
  proposal: Proposal,
  decision: Decision,
): Proposal | string {
  if (proposal.decision !== null) {
    return (
      `${proposal.id} was already ${proposal.decision.outcome} at ${proposal.decision.at} by ` +
      `${proposal.decision.by}. A decision is not edited in place — file it again, with ` +
      `--changed saying what is different this time.`
    );
  }
  // D-153: the answer names exactly what it answered.
  return { ...proposal, decision: { ...decision, actionDigest: proposal.actionDigest } };
}

/** What {@link boundAction} found. */
export type Bound =
  /** Run this, and only this. */
  | { readonly ok: true; readonly action: ProposalAction; readonly digest: string }
  /** The record no longer holds what was approved, or the approval names no action. */
  | { readonly ok: false; readonly reason: string };

/**
 * The action an approved proposal pays for, built from its record and nothing else (D-153).
 *
 * Refused when the approval names an action digest the record's action no longer has — the record was
 * changed after the yes — so the yes cannot be spent on something it was not given for. Refused too when the
 * approval names no digest at all: there is nothing to say what it was given for, and a stripped digest
 * must not read as an old approval. A digest catches change, not a determined editor (see the header).
 */
export function boundAction(proposal: Proposal): Bound {
  const approved = proposal.decision?.actionDigest;
  if (approved === undefined) {
    return {
      ok: false,
      reason:
        "the approval names no action — it was given before approvals were bound to their action, or its digest " +
        "was removed — so nothing says what it was given for. Approve it again: press \"File it again for a yes\" " +
        `on the web page, or run \`mind proposal new <dir> --subject ${proposal.subject} --refile ${proposal.id}\`, ` +
        "and say yes to the new one.",
    };
  }
  if (approved !== proposal.actionDigest) {
    return {
      ok: false,
      reason:
        `the approval was given for action ${approved.slice(0, 19)}…, and the record now holds ` +
        `${proposal.actionDigest.slice(0, 19)}… — it was changed after the yes. An approval pays for what it was ` +
        `given for and nothing else. Ask for a new yes: press "File it again for a yes" on the web page, or run ` +
        `\`mind proposal new <dir> --subject ${proposal.subject} --refile ${proposal.id}\`.`,
    };
  }
  return { ok: true, action: proposal.action, digest: approved };
}

/** Whether an approval is there to be spent, and if not, what is in the way. */
export type Spendability =
  /** Approved, and not yet used by a turn. */
  | { readonly kind: "ready" }
  /** Nobody has answered it yet. */
  | { readonly kind: "undecided" }
  /** It was refused. */
  | { readonly kind: "refused" }
  /** It was approved and a turn has already had it. */
  | { readonly kind: "spent"; readonly turn: string };

/** Can this proposal pay for a turn? */
export function spendability(proposal: Proposal): Spendability {
  if (proposal.decision === null) return { kind: "undecided" };
  if (proposal.decision.outcome === "refused") return { kind: "refused" };
  if (proposal.usedByTurn !== null) return { kind: "spent", turn: proposal.usedByTurn };
  return { kind: "ready" };
}

/**
 * A record marked as spent by one turn — the record's own copy of a claim.
 *
 * Pure. What makes an approval spent is {@link claimApproval}; this is the
 * shape it writes back into the record so the file says so too.
 */
export function spendProposal(proposal: Proposal, turnId: string, at: Date): Proposal {
  return { ...proposal, usedByTurn: turnId, usedAt: at.toISOString() };
}

/** What {@link claimApproval} found. */
export type Claim =
  /** This turn has the approval. `copyFailed` says the record's own copy was not written (the claim was). */
  | { readonly ok: true; readonly proposal: Proposal; readonly copyFailed?: string }
  /** Another turn claimed it first. */
  | { readonly ok: false; readonly turn: string; readonly at: string | null };

/**
 * Spend an approval on one turn, or learn which turn already has (D-144).
 *
 * Called with a record whose {@link spendability} was `ready` when it was read —
 * and that reading may already be stale, which is the whole point: another
 * process can have claimed it since. The arbiter is `link(2)` from a claim
 * written whole and synced into a private temporary name onto `spent/<id>.json`.
 * The kernel lets exactly one link succeed; every other process gets `EEXIST`
 * and reads the winner's turn out of a file that was complete before it had
 * that name. The directory is synced after the link, as the ledger syncs after
 * an append, so a claim that was made survives a power cut.
 *
 * Called immediately before anything is sent, and never undone here — whether
 * a turn that then fails with nothing sent gets its approval back is D-144 §2,
 * decided by the caller.
 *
 * Throws when the claim cannot be made for any other reason — an approval that
 * cannot be recorded as spent is one that could be spent twice, so the caller
 * sends nothing. A filesystem without hard links is named as that. A failure to
 * write the record's own copy afterwards is *not* thrown: the claim exists,
 * every reader folds it in, and the turn may go ahead. The copy goes to the file
 * the record was read from, never to a path built from its id.
 */
export async function claimApproval(stored: StoredProposal, turnId: string, at: Date): Promise<Claim> {
  const claim = claimPath(dirname(stored.path), SPENT_DIR, stored.proposal.id);
  // The action digest goes in the claim too: what was spent, not only that something was.
  const body = { schema: SPEND_SCHEMA, proposal: stored.proposal.id, turn: turnId, at: at.toISOString(), action: stored.proposal.actionDigest };
  if ((await linkClaim(claim, body)) === "taken") return { ok: false, ...(await readClaim(claim)) };

  const spent = spendProposal(stored.proposal, turnId, at);
  try {
    await writeProposalAt(stored.path, spent);
  } catch (cause) {
    return { ok: true, proposal: spent, copyFailed: String(cause) };
  }
  return { ok: true, proposal: spent };
}

/** What {@link claimRefile} found. */
export type RefileClaim =
  /** This process files it again, as the id it was given. */
  | { readonly ok: true }
  /** Another process claimed the refile first; `as` is the proposal it named. */
  | { readonly ok: false; readonly as: string; readonly at: string | null };

/**
 * Claim the one refile a spent approval gets (D-144, follow-up), **before** the new record is written.
 *
 * `refileProblem` reads the store, and two processes reading it at once both find the approval not yet filed
 * again — six at once filed six. So the refile is claimed the way a spend is: `refiled/<old id>.json`, linked
 * into place, naming the new id; exactly one process gets it, and the rest are told which id did.
 *
 * The claim comes first and the record second, so a crash between them uses the refile up with no new record to
 * show for it. That is the safe side: the owner can still file the same what by hand, and never finds two.
 */
export async function claimRefile(stored: StoredProposal, newId: string, at: Date): Promise<RefileClaim> {
  const claim = claimPath(dirname(stored.path), REFILED_DIR, stored.proposal.id);
  const body = { schema: REFILE_SCHEMA, proposal: stored.proposal.id, as: newId, at: at.toISOString() };
  if ((await linkClaim(claim, body)) === "taken") return { ok: false, ...(await readRefileClaim(claim)) };
  return { ok: true };
}

/**
 * Create `claim` holding `body`, or learn that another process already has — one exclusive step on any number
 * of processes. Written whole and synced under a private name (`wx`), then `link(2)`ed into place, which only
 * one process can do; `EEXIST` for everyone else. The directory is synced after the link, as the ledger syncs
 * after an append. Claim temporaries a killed process left behind are swept on the way in.
 *
 * Throws for anything but `EEXIST`, and names a filesystem without hard links as that.
 */
export async function linkClaim(claim: string, body: Readonly<Record<string, string>>): Promise<"made" | "taken"> {
  const claimsDir = dirname(claim);
  await mkdir(claimsDir, { recursive: true, mode: STATE_DIR_MODE });
  await sweepOrphans(claimsDir, Date.now());
  const temp = `${claim}.mind-${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    // `wx`: a name nobody else is using, or nothing — never through a link that was waiting there.
    await writeWhole(temp, `${JSON.stringify(body, null, 2)}\n`, "wx");
    await link(temp, claim);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "taken";
    if (code !== undefined && NO_HARD_LINKS.has(code)) {
      throw new Error(
        `${claimsDir} is on a filesystem that refused a hard link (${code}). Approvals and refiles are claimed ` +
          `with link(2) so that exactly one process can take each; nothing was claimed. Keep the data directory ` +
          `($XDG_DATA_HOME) on a filesystem with hard links.`,
        { cause },
      );
    }
    throw cause;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  // Best effort: a filesystem that cannot sync a directory still has the link, and every reader sees it.
  await syncDir(claimsDir).catch(() => undefined);
  return "made";
}

/** The `link(2)` errors that mean "this filesystem does not do hard links", not "somebody got there first". */
const NO_HARD_LINKS: ReadonlySet<string> = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * How old a claim's temporary file must be before it is taken for an orphan.
 * A live one exists for the few milliseconds between its write and its link;
 * one this old belongs to a process that was killed in between.
 */
export const ORPHAN_TEMP_MS = 10 * 60_000;

/** Remove claim temporaries a killed process left behind. Best effort: another sweeper may get there first. */
async function sweepOrphans(claimsDir: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(claimsDir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.endsWith(".tmp"))) {
    const path = join(claimsDir, name);
    try {
      if (now - (await stat(path)).mtimeMs > ORPHAN_TEMP_MS) await unlink(path);
    } catch {
      // Gone already, or not ours to remove: either way it is not a claim.
    }
  }
}

/** Why an approved, unspent proposal cannot run as it was given ({@link unboundReason}). */
export type UnboundReason =
  /** The yes names no action: given before approvals were bound to their action (v0.10.0), or its digest stripped. */
  | "no-action"
  /** The yes names an action the record no longer holds: changed after the yes, or a digest that is not one. */
  | "changed";

/**
 * Why an approval cannot run as it was given, or `undefined` when it can, or is not an unspent approval at all
 * (D-153 follow-up). The rule is {@link boundAction}'s — the one `turn --proposal` asks — so what the page offers
 * with "Do it now" is exactly what a turn would run, and everything else approved and unspent is offered to be
 * asked for again ({@link refileProblem}).
 */
export function unboundReason(proposal: Proposal): UnboundReason | undefined {
  if (proposal.decision?.outcome !== "approved" || proposal.usedByTurn !== null) return undefined;
  if (boundAction(proposal).ok) return undefined;
  return proposal.decision.actionDigest === undefined ? "no-action" : "changed";
}

/** Approved, unspent, and refused by {@link boundAction}: a yes no turn will run ({@link unboundReason}). */
export function isUnboundApproval(proposal: Proposal): boolean {
  return unboundReason(proposal) !== undefined;
}

/** Why a proposal cannot be filed again from its own record, or `undefined` when it can. */
export type RefileProblem =
  /** It is not an approval a turn spent while sending nothing, nor an approval no turn will run. */
  | { readonly kind: "not-refileable"; readonly reason: string }
  /** It was filed again already; this is the proposal that did it. */
  | { readonly kind: "already"; readonly by: string }
  /** Its `what` was asked again already, by hand: this is that proposal ({@link askedAgain}). */
  | { readonly kind: "asked-again"; readonly by: Proposal };

/**
 * Whether an approval may be filed again as a new question from its own record — once — and, when not, why.
 *
 * Two kinds of approval may (the owner, 2026-09-29 and 2026-10-05):
 *   - **spent while sending nothing** (D-144 §2). An approval a failed turn took stays spent; when that turn sent
 *     nothing to any backend — and only then — it may be asked for again. Not when a turn answered or was handed
 *     the prompt: then it ran, or may have, and a second approval would run it a second time.
 *   - **one no turn will run** ({@link isUnboundApproval}, D-153 follow-up): never spent, refused by
 *     {@link boundAction}, so the only way forward is the same question asked again.
 *
 * What is filed is a **new** proposal with the same what, why and impact, waiting for a new yes. Once only: the
 * refile claim, or a proposal naming it in `supersedes`, is its second asking. And not when its `what` has been
 * asked again already by hand ({@link askedAgain}) — one rule, which `proposal new --refile` and every list ask.
 */
export function refileProblem(inventory: ProposalInventory, proposal: Proposal): RefileProblem | undefined {
  const unbound = isUnboundApproval(proposal);
  if (!unbound && (proposal.decision?.outcome !== "approved" || proposal.usedByTurn === null)) {
    return {
      kind: "not-refileable",
      reason: "it is not an approval a turn has spent, nor an approval no turn will run",
    };
  }
  if (!unbound && proposal.sentNothing !== true) {
    return {
      kind: "not-refileable",
      reason: `turn ${proposal.usedByTurn} ran it or may have — only an approval whose turn sent nothing is filed again`,
    };
  }
  // The refile claim first: it exists even when a crash left no new record behind it. Then any proposal filed
  // after the yes that names this one in `supersedes` — the only trace a refile made before refile claims existed
  // has. One filed before the yes is not a refile of it: it was asked past this record with --changed, and the
  // yes came after (review of PR #29).
  if (proposal.refiledAs !== undefined) return { kind: "already", by: proposal.refiledAs };
  const yes = yesAt(proposal);
  const again = inventory.proposals.find((stored) => stored.proposal.supersedes === proposal.id && Date.parse(stored.proposal.at) > yes);
  if (again !== undefined) return { kind: "already", by: again.proposal.id };
  const twin = askedAgain(inventory, proposal);
  return twin === undefined ? undefined : { kind: "asked-again", by: twin };
}

/**
 * The proposal that already asks again what an approval asked, if there is one: another record with the same
 * `what` (its key) that is
 *   - **still waiting**, whenever it was filed — filing this one again would be two copies of one question; or
 *   - **filed after the yes**, in any state — somebody asked again by hand, and it has been or is being answered
 *     on its own; a refusal there is the newer answer.
 *
 * Not a twin that was answered before the yes: the owner said yes after it, so a refusal before the yes is not
 * the newer answer — which is also why a refusal this record supersedes with `--changed` never counts: it was
 * filed, and answered, before this record existed, let alone its yes.
 *
 * Measured against the time of the **yes** (`decision.at`), not of the filing: a twin refused between the filing
 * and the yes is older than the yes, and the yes stands. Compared as instants ({@link yesAt}), not as strings.
 */
export function askedAgain(inventory: ProposalInventory, proposal: Proposal): Proposal | undefined {
  const yes = yesAt(proposal);
  return inventory.proposals
    .map((stored) => stored.proposal)
    .find(
      (other) =>
        other.id !== proposal.id &&
        other.key === proposal.key &&
        (other.decision === null || Date.parse(other.at) > yes),
    );
}

/**
 * When the yes was given, in milliseconds — or, for a record whose decision carries no time, when it was filed.
 * Parsed rather than compared as text: two ISO times in the same second with a different number of fractional
 * digits (`…:05Z`, `…:05.5Z`), or with an offset, sort wrong as strings. An unparseable time is `NaN`, which is
 * after nothing, so no twin counts against a yes nobody can date.
 */
function yesAt(proposal: Proposal): number {
  return Date.parse(proposal.decision?.at || proposal.at);
}

/**
 * Whether the proposal a refile claim names was written: read from the store, never from a path built from the
 * name, since the claim is a file anybody could edit.
 *
 * Waited for, up to `waitMs`, because the process that won the claim writes the record right after it, and a
 * process that lost the race can look in between. Still absent after that, it is an attempt that did not
 * finish — claimed, then a crash before the write — and "filed again already, as <id>" would name a proposal
 * nobody can find (D-144 follow-up).
 */
export async function refileWritten(dir: string, as: string, waitMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (findProposal(await readProposals(dir), as) !== undefined) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Every spent approval {@link refileProblem} lets be filed again, newest first (D-144 §2). Not the approvals no
 * turn will run: they are {@link needsReapproval}, a list of their own, because they were never spent.
 */
export function refileable(inventory: ProposalInventory): readonly Proposal[] {
  return inventory.proposals
    .map((stored) => stored.proposal)
    .filter((proposal) => !isUnboundApproval(proposal) && refileProblem(inventory, proposal) === undefined);
}

/**
 * Every approval no turn will run ({@link isUnboundApproval}) that still has to be asked for again, newest first
 * (D-153 follow-up). One already filed again — by the button, by `--refile`, or by hand as a twin — is not here:
 * it has left every list.
 */
export function needsReapproval(inventory: ProposalInventory): readonly Proposal[] {
  return inventory.proposals
    .map((stored) => stored.proposal)
    .filter((proposal) => isUnboundApproval(proposal) && refileProblem(inventory, proposal) === undefined);
}

/**
 * One line describing a proposal, for a list a person reads.
 *
 * Here rather than in the command, because `turn` prints it too when it refuses
 * one — and two accounts of the same record are two things to keep honest.
 */
export function proposalLine(proposal: Proposal): string {
  const state =
    proposal.decision === null
      ? "pending"
      : proposal.usedByTurn === null
        ? proposal.decision.outcome
        : `${proposal.decision.outcome}, spent${proposal.sentNothing === true ? " (sent nothing)" : ""}`;
  const by = proposal.filedBy === "agent" ? "  (filed by the agent)" : "";
  return `${proposal.id}  ${proposal.at}  ${state.padEnd(16)}  ${proposal.what}${by}`;
}
