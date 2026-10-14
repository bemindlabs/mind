/**
 * `mind proposal` — S5.2 AC2, and the two ACs this command is honest about not
 * being.
 *
 * **AC2 is what is built here.** A proposal is filed with what, why and what it
 * affects; somebody approves or refuses it; and a refusal is remembered, so the
 * same thing cannot be filed again without saying what is new. The store is
 * `src/decide/proposals.ts` — read its header for D-029, which put it outside
 * the ledger rather than in it.
 *
 * **AC1 — "every action that was not asked for comes out as a proposal" — is not
 * built, and could not be by adding code to this file.** Mind borrows vendor
 * CLIs (D-002) and sees a turn's stdout, stderr and exit code; it does not see
 * the tool calls inside one. The caller of `mind proposal new` is therefore a
 * person, or the script driving `mind turn` — not the model mid-turn. What
 * exists here is the store, the memory of a refusal, and the place a turn is
 * tied to an approval; an agent that files its own proposals needs something
 * this architecture does not have, and D-029 leaves that to its own decision.
 *
 * **AC3 — "proposal and outcome go into the ledger (S2.2)" — cannot be built as
 * worded.** D-029 decided on 2026-09-22 that they go into a store of their own,
 * *not* the ledger, precisely because AC2 needs them read back and D-022 forbids
 * reading the ledger back into a decision. Both cannot be true at once. The
 * wording has to change before anything can be ticked, and that is the owner's
 * to write; this command does not bend it by putting something ledger-shaped
 * here and calling it AC3.
 *
 * **AC4 — reporting inside the same turn at level 2 — is not built either**, and
 * for AC1's reason: what a turn reports is what the model chose to say, which is
 * not something Mind is in a position to require.
 *
 * ## Every run prints the refusals
 *
 * Not the ones a similarity score thinks are related — **all of them**, on
 * `new`, on `show` and on `decide`. The comparison this store makes is exact
 * (`proposalKey`), so one reworded sentence slips past it; the mitigation is a
 * person reading the list at the moment they decide, and a program that chose
 * which refusals were worth showing would be the same loose comparison wearing a
 * different hat.
 */

import {
  blockingProposal,
  claimRefile,
  decideProposal,
  describeProposal,
  ensureProposalsDir,
  findProposal,
  unboundReason,
  proposalKey,
  proposalLine,
  proposalsDir,
  readProposals,
  refileProblem,
  refileWritten,
  refusedProposals,
  writeProposal,
  writeProposalAt,
  type Decision,
  type Proposal,
  type ProposalInventory,
  type StoredProposal,
} from "../../src/decide/index.ts";
import { loadSoul } from "../../src/soul/index.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { readTriage, triageLabel, TRIAGE_NOTE } from "../../src/decide/triage.ts";
import { DIAL_REFUSED, dialEnv, whoIsSetting } from "../dial.ts";
import { triageAndStore, triageIfEnabled } from "../triage.ts";
import { ERR, OUT, parseArgs, report, usageError, type Sink } from "../shared.ts";

const PROPOSAL_USAGE =
  "usage: mind proposal new <dir> --subject <id>\n" +
  "                          (--what <text> --why <text> --impact <text> | --from <path|->)\n" +
  "                          [--changed <text>]\n" +
  "       mind proposal new <dir> --subject <id> --refile <proposal-id>\n" +
  "       mind proposal decide <proposal-id> <dir> --subject <id> (--approve | --refuse) [--note <text>]\n" +
  "       mind proposal list <dir> --subject <id> [--json]\n" +
  "       mind proposal show <proposal-id> <dir> --subject <id> [--json]\n" +
  "       mind proposal triage (<proposal-id> | --pending) <dir> --subject <id>";

/**
 * The flags `proposal` takes no value for.
 *
 * Exported for the reason {@link import("./turn.ts").TURN_BOOLEANS} is: one
 * list, in the command that parses with it. `--approve` and `--refuse` are here
 * because without them `--approve --note "…"` would read as `approve="--note"`
 * and the note would vanish from a record about somebody's decision.
 */
export const PROPOSAL_BOOLEANS: readonly string[] = ["json", "approve", "refuse"];

/**
 * Exit code for a proposal this subject has already been refused, or has
 * pending.
 *
 * Its own number rather than 1, and for the reason `DIAL_REFUSED` is 4: the
 * caller is usually a loop, and *this was already asked and answered* is a thing
 * a loop must be able to tell from *that failed, try again*. 2 is a usage error,
 * 3 is `erase`'s `nothing-found`, 4 is the dial or the brake; 5 was free.
 */
export const PROPOSAL_REPEATED = 5;

/** The `schema` of `proposal list --json`: a document a script may parse. Nothing in the engine reads it back. */
export const PROPOSAL_LIST_SCHEMA = "mind/proposal-list@1";

/** A validated `<dir> --subject <id>`, or the exit code for the complaint. */
type Place =
  | { readonly ok: true; readonly dir: string; readonly subject: SubjectId }
  | { readonly ok: false; readonly code: number };

/**
 * Resolve the pair every subcommand takes, checking the soul really is the
 * subject's.
 *
 * The directory is required and the subject is not inferred from it (I-3): there
 * is no subject→directory registry, so the directory is the answer and the
 * subject is the claim that has to check out. `loadSoul` is where that check
 * lives — the same call `turn` makes, for the same reason. Filing a proposal
 * against an identity whose soul is somewhere else is exactly the mistake that
 * puts one person's record under another's name.
 */
async function placeOf(
  positional: readonly string[],
  options: ReadonlyMap<string, string>,
  at: number,
): Promise<Place> {
  const dir = positional[at];
  const subject = options.get("subject");
  if (dir === undefined || subject === undefined || subject === "") {
    return { ok: false, code: usageError(PROPOSAL_USAGE) };
  }
  let id: SubjectId;
  try {
    id = subjectId(subject);
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return { ok: false, code: report(loaded.issues) };
  return { ok: true, dir, subject: id };
}

/** The store for one subject, read — or the exit code for why it could not be. */
async function inventoryFor(
  subject: SubjectId,
): Promise<{ ok: true; dir: string; inventory: ProposalInventory } | { ok: false; code: number }> {
  const dir = await proposalsDir(dialEnv(), subject);
  if (!dir.ok) {
    ERR.line(`mind: ${dir.reason}`);
    return { ok: false, code: 1 };
  }
  const inventory = await readProposals(dir.path);
  for (const bad of inventory.unreadable) {
    ERR.line(
      `mind: ${bad.path} is in the proposal store and is not a proposal: ${bad.reason}. It is ` +
        `counted in nothing below — if it was a refusal, this command has forgotten it.`,
    );
  }
  return { ok: true, dir: dir.path, inventory };
}

/**
 * Print every refusal this subject has had — all of them, every time.
 *
 * On stderr, so `--json` stdout stays one document, and because this is for the
 * person rather than for the script. See the header for why there is no
 * filtering: the key is exact, so the wide comparison is the reader's job and
 * this is the list they need to do it with.
 */
function sayRefusals(out: Sink, inventory: ProposalInventory): void {
  const refused = refusedProposals(inventory);
  out.line("");
  if (refused.length === 0) {
    out.line(out.dim("Nothing has been refused for this subject yet."));
    return;
  }
  out.line(out.bold(`${refused.length} thing(s) this subject has been refused, newest first:`));
  for (const proposal of refused) {
    out.line(`  ${proposalLine(proposal)}`);
    if (proposal.decision?.note != null) out.line(out.dim(`    note: ${proposal.decision.note}`));
  }
  out.line(
    out.dim(
      "  Printed in full on every run, and not filtered by anything that guesses at " +
        "similarity: Mind compares the text of `what` exactly, so one reworded sentence is a " +
        "new proposal to it. Reading this list is the part of the comparison a program cannot do.",
    ),
  );
}

/** The three fields, from the command line or from a file that is not in argv. */
async function textsFrom(
  options: ReadonlyMap<string, string>,
): Promise<
  | { readonly ok: true; readonly what: string; readonly why: string; readonly impact: string; readonly changed: string | null }
  | { readonly ok: false; readonly code: number }
> {
  const from = options.get("from");
  const direct = ["what", "why", "impact"].map((key) => options.get(key) ?? "");

  if (from !== undefined && from !== "") {
    if (direct.some((value) => value !== "")) {
      return {
        ok: false,
        code: usageError(
          "--from and --what/--why/--impact name two different proposals; pass one of them",
        ),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(from === "-" ? await Bun.stdin.text() : await Bun.file(from).text());
    } catch (error) {
      return { ok: false, code: usageError(`cannot read a proposal from ${from}: ${String(error)}`) };
    }
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, code: usageError(`${from} is not a JSON object`) };
    }
    const raw = parsed as Record<string, unknown>;
    const field = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string) : "");
    const what = field("what");
    const why = field("why");
    const impact = field("impact");
    if (what === "" || why === "" || impact === "") {
      return {
        ok: false,
        code: usageError(
          `${from} must hold non-empty "what", "why" and "impact" — AC1 asks for all three, and ` +
            `a proposal missing one of them is a proposal nobody can judge`,
        ),
      };
    }
    const changed = field("changed");
    return { ok: true, what, why, impact, changed: changed === "" ? null : changed };
  }

  const [what = "", why = "", impact = ""] = direct;
  if (what === "" || why === "" || impact === "") return { ok: false, code: usageError(PROPOSAL_USAGE) };
  const changed = options.get("changed") ?? "";
  return { ok: true, what, why, impact, changed: changed === "" ? null : changed };
}

/**
 * `--refile <id>` (D-144 §2): the three fields from a spent approval's own record, never from the command line.
 *
 * Only for an approval whose turn sent nothing, or one given before approvals named their action (D-153), which
 * no turn will run ({@link refileProblem}) — and once. What is filed is a new proposal — pending, needing a new
 * yes — that names the old one in `supersedes` and says why in `changed`, and keeps who first filed it
 * (`filedBy`, `fromTurn`): the text is still the agent's, or the person's, words.
 */
/** Why a refile was refused as used up — naming the new proposal only when there is one to find. */
async function filedAgainAlready(dir: string, id: string, as: string): Promise<string> {
  return (await refileWritten(dir, as))
    ? `mind: ${id} was filed again already, as ${as}. Nothing was filed.`
    : `mind: the refile of ${id} was used up by an attempt that did not finish; file the same text with ` +
        "`mind proposal new`. Nothing was filed.";
}

async function refileTexts(
  dir: string,
  inventory: ProposalInventory,
  id: string,
  subject: SubjectId,
): Promise<
  | {
      readonly ok: true;
      readonly what: string;
      readonly why: string;
      readonly impact: string;
      readonly changed: string;
      readonly from: StoredProposal;
    }
  | { readonly ok: false; readonly code: number }
> {
  const stored = findProposal(inventory, id);
  if (stored === undefined) {
    return { ok: false, code: usageError(`no proposal ${JSON.stringify(id)} for subject ${subject}; nothing was filed`) };
  }
  const problem = refileProblem(inventory, stored.proposal);
  if (problem?.kind === "already") {
    ERR.line(await filedAgainAlready(dir, id, problem.by));
    return { ok: false, code: PROPOSAL_REPEATED };
  }
  if (problem?.kind === "asked-again") {
    // The one twin rule (`askedAgain`): the lists ask it too, so what this refuses is not listed either.
    ERR.line(`mind: ${id} was asked again already, as ${problem.by.id}. Nothing was filed.`);
    ERR.line(`  ${proposalLine(problem.by)}`);
    if (problem.by.decision?.note != null) ERR.line(`    note: ${problem.by.decision.note}`);
    return { ok: false, code: PROPOSAL_REPEATED };
  }
  if (problem !== undefined) {
    ERR.line(`mind: ${id} cannot be filed again from its record: ${problem.reason}. Nothing was filed.`);
    ERR.line(`  ${proposalLine(stored.proposal)}`);
    return { ok: false, code: DIAL_REFUSED };
  }
  const { what, why, impact, usedByTurn, decision } = stored.proposal;
  const unbound = unboundReason(stored.proposal);
  const changed =
    unbound === "no-action"
      ? `filed again: approved ${decision?.at ?? ""} before approvals named their action (D-153), so that yes cannot run`
      : unbound === "changed"
        ? `filed again: approved ${decision?.at ?? ""}, and the record no longer holds the action that yes named (D-153), so it cannot run`
        : `filed again: turn ${usedByTurn} took its approval and sent nothing`;
  return { ok: true, what, why, impact, changed, from: stored };
}

async function cmdNew(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, PROPOSAL_BOOLEANS);
  const place = await placeOf(positional, options, 0);
  if (!place.ok) return place.code;

  const refile = options.get("refile");
  if (refile !== undefined && (refile === "" || ["what", "why", "impact", "from", "changed"].some((key) => options.has(key)))) {
    return usageError("--refile takes the id of an approved proposal, and its text comes from that record — pass no --what, --why, --impact, --from or --changed");
  }
  const typed = refile === undefined ? await textsFrom(options) : undefined;
  if (typed !== undefined && !typed.ok) return typed.code;

  const read = await inventoryFor(place.subject);
  if (!read.ok) return read.code;

  const refiled = typed === undefined ? await refileTexts(read.dir, read.inventory, refile!, place.subject) : undefined;
  if (refiled !== undefined && !refiled.ok) return refiled.code;
  // Both are the ok case by here: each failure returned above.
  const texts = typed ?? refiled!;
  const from = refiled?.ok === true ? refiled.from : undefined;

  const key = proposalKey(texts.what);
  // A refile has asked its twin question already, in `refileProblem` (`askedAgain`) — the same rule every list asks,
  // so a refile is never refused here for a twin the lists did not count (review of PR #29). A typed proposal asks
  // `blockingProposal`: a twin waiting or refused stops it unless --changed says what is new.
  const blocking = from === undefined ? blockingProposal(read.inventory, key) : undefined;
  if (blocking !== undefined && texts.changed === null) {
    ERR.line(
      `mind: this subject has already had that asked. Nothing was filed.\n` +
        `  ${proposalLine(blocking)}`,
    );
    if (blocking.decision?.note != null) ERR.line(`    note: ${blocking.decision.note}`);
    ERR.line(
      blocking.decision === null
        ? `  It has not been answered yet, so asking again would be two copies of one question.`
        : `  It was refused, and a refusal is remembered (S5.2 AC2).`,
    );
    ERR.line(
      `  To ask again, say what is new: --changed "<what is different this time>". That is ` +
        `recorded against the old proposal, so the person deciding can see both.`,
    );
    return PROPOSAL_REPEATED;
  }

  const dir = await ensureProposalsDir(dialEnv(), place.subject);
  if (!dir.ok) {
    ERR.line(`mind: ${dir.reason}`);
    return 1;
  }

  const proposal = describeProposal({
    id: crypto.randomUUID(),
    subject: place.subject,
    at: new Date(),
    what: texts.what,
    why: texts.why,
    impact: texts.impact,
    supersedes: refile !== undefined ? refile : (blocking?.id ?? null),
    changed: texts.changed,
    // Who first filed it, carried over: a refile is the same words asked again, not a person's new ones.
    ...(from === undefined ? {} : { filedBy: from.proposal.filedBy, fromTurn: from.proposal.fromTurn }),
  });

  // D-144 follow-up — a refile is claimed before its record is written, so of any number of processes filing the
  // same approval again at once, one does. A crash between the two uses the refile up (the same what can still
  // be filed by hand); it never files two.
  if (from !== undefined) {
    let claim;
    try {
      claim = await claimRefile(from, proposal.id, new Date());
    } catch (error) {
      ERR.line(`mind: the refile could not be claimed: ${error instanceof Error ? error.message : String(error)}. Nothing was filed.`);
      return 1;
    }
    if (!claim.ok) {
      ERR.line(await filedAgainAlready(dir.path, from.proposal.id, claim.as));
      return PROPOSAL_REPEATED;
    }
  }

  let path: string;
  try {
    path = await writeProposal(dir.path, proposal);
  } catch (error) {
    ERR.line(`mind: the proposal could not be written: ${String(error)}`);
    if (from !== undefined) {
      ERR.line(
        `  The refile of ${from.proposal.id} is used up by this attempt (D-144); file the same what with ` +
          `\`mind proposal new\` to ask again.`,
      );
    }
    return 1;
  }

  // stdout is the id and nothing else, so `id=$(mind proposal new …)` works.
  OUT.line(proposal.id);
  await triageIfEnabled(dir.path, proposal, place.subject);

  ERR.line(`filed: ${path}`);
  if (from !== undefined) {
    const first = from.proposal.filedBy === "agent" ? ` First filed by the agent${from.proposal.fromTurn === null ? "" : ` (turn ${from.proposal.fromTurn})`}.` : "";
    const unbound = unboundReason(from.proposal);
    const because =
      unbound === "no-action"
        ? `approved before approvals named their action (D-153), so no turn would run that yes. ${refile} leaves every list`
        : unbound === "changed"
          ? `whose record no longer holds the action its yes named (D-153), so no turn would run that yes. ${refile} leaves every list`
          : `whose turn sent nothing`;
    ERR.line(`  filed again from ${refile}, ${because}. It waits for a yes of its own; nothing was approved or run.${first}`);
  } else if (blocking !== undefined) {
    ERR.line(
      `  supersedes ${blocking.id} — ${blocking.decision === null ? "pending" : blocking.decision.outcome} ` +
        `— because --changed says: ${texts.changed}`,
    );
  }
  ERR.line(
    ERR.dim(
      `  what/why/impact are free text about what you do, so this file is personal and lives ` +
        `outside every git repository (D-014, D-025). \`mind erase <subject>\` removes it with ` +
        `the rest of the personal directory; \`observe purge\` does not — that command is about ` +
        `the capture tree only. One file per proposal, so \`rm\` reaches exactly one refusal.`,
    ),
  );
  sayRefusals(ERR, read.inventory);
  return 0;
}

async function cmdDecide(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, PROPOSAL_BOOLEANS);
  const id = positional[0];
  if (id === undefined) return usageError(PROPOSAL_USAGE);
  const place = await placeOf(positional, options, 1);
  if (!place.ok) return place.code;

  const approve = options.has("approve");
  const refuse = options.has("refuse");
  if (approve === refuse) {
    return usageError(
      "pass exactly one of --approve and --refuse. There is deliberately no default: a " +
        "decision Mind picked for you is not a decision.",
    );
  }

  const read = await inventoryFor(place.subject);
  if (!read.ok) return read.code;

  const stored = findProposal(read.inventory, id);
  if (stored === undefined) {
    ERR.line(
      `mind: no proposal ${JSON.stringify(id)} for subject ${place.subject}. ` +
        `\`mind proposal list ${place.dir} --subject ${place.subject}\` prints what is there.`,
    );
    return 1;
  }

  const note = options.get("note") ?? "";
  const decision: Decision = {
    outcome: approve ? "approved" : "refused",
    at: new Date().toISOString(),
    by: await whoIsSetting(place.dir),
    note: note === "" ? null : note,
  };
  const decided = decideProposal(stored.proposal, decision);
  if (typeof decided === "string") {
    ERR.line(`mind: ${decided}`);
    return 1;
  }

  try {
    // Where it was read from — never a path built from the id inside the file (D-144 review).
    await writeProposalAt(stored.path, decided);
  } catch (error) {
    ERR.line(`mind: the decision could not be written: ${String(error)}`);
    return 1;
  }

  OUT.line(`${decided.id} ${decision.outcome} by ${decision.by} at ${decision.at}`);
  if (decision.outcome === "approved") {
    ERR.line(
      `  Good for one turn, and for this action only (${decided.actionDigest}): \`mind turn <dir> --subject ` +
        `${place.subject} --proposal ${decided.id}\` runs its what. An approval is spent when a turn takes it, so a second turn needs a ` +
        `second approval — "I allowed it once" must not quietly become "it has done that ever ` +
        `since".`,
    );
  }
  // The list as it stands now: the inventory above was read before this decision, so printing it would leave out
  // the refusal just made and say "Nothing has been refused" about it (B6 of the first stranger run).
  sayRefusals(ERR, {
    ...read.inventory,
    proposals: read.inventory.proposals.map((entry) => (entry === stored ? { ...entry, proposal: decided } : entry)),
  });
  return 0;
}

/** What a `--json` document holds for a whole store. */
function asDocument(subject: SubjectId, dir: string, inventory: ProposalInventory): unknown {
  return {
    schema: PROPOSAL_LIST_SCHEMA,
    subject,
    dir,
    proposals: inventory.proposals.map((stored) => stored.proposal),
    unreadable: inventory.unreadable,
  };
}

async function cmdList(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, PROPOSAL_BOOLEANS);
  const place = await placeOf(positional, options, 0);
  if (!place.ok) return place.code;

  const read = await inventoryFor(place.subject);
  if (!read.ok) return read.code;

  if (options.has("json")) {
    // stdout is one document; the refusals a person needs still go to stderr,
    // because "printed every time" is every time and not "except when a script
    // is watching" (D-028 keeps the two streams apart so both can be true).
    OUT.line(JSON.stringify(asDocument(place.subject, read.dir, read.inventory), null, 2));
    sayRefusals(ERR, read.inventory);
    return 0;
  }

  OUT.line(read.dir);
  if (read.inventory.proposals.length === 0) {
    OUT.line("  nothing has been proposed for this subject.");
  }
  for (const stored of read.inventory.proposals) {
    const triage = await readTriage(read.dir, stored.proposal.id);
    OUT.line(`  ${proposalLine(stored.proposal)}${triage === undefined ? "" : OUT.dim(`  [${triageLabel(triage)}]`)}`);
  }
  sayRefusals(ERR, read.inventory);
  return 0;
}

/** Everything one record holds, for a person about to decide it. */
function sayProposal(out: Sink, proposal: Proposal): void {
  out.line(out.bold(proposal.id));
  out.line(`  filed   ${proposal.at}`);
  out.line(`  what    ${proposal.what}`);
  out.line(`  why     ${proposal.why}`);
  out.line(`  impact  ${proposal.impact}`);
  // D-153: what an approval runs, and the digest the approval is bound to.
  out.line(`  action  ${proposal.action.kind} — its what, as the prompt · ${proposal.actionDigest}`);
  if (proposal.supersedes !== null) out.line(`  after   ${proposal.supersedes}`);
  if (proposal.changed !== null) out.line(`  changed ${proposal.changed}`);
  if (proposal.decision === null) {
    out.line(`  status  pending`);
  } else {
    out.line(
      `  status  ${proposal.decision.outcome} by ${proposal.decision.by} at ${proposal.decision.at}`,
    );
    if (proposal.decision.note !== null) out.line(`  note    ${proposal.decision.note}`);
    out.line(
      proposal.decision.actionDigest === undefined
        ? `  bound   no action named — it will not run; approve it again as a new proposal`
        : `  bound   ${proposal.decision.actionDigest}${proposal.decision.actionDigest === proposal.actionDigest ? "" : " — NOT the action the record now holds; it will not run"}`,
    );
  }
  out.line(
    proposal.usedByTurn === null
      ? `  spent   no`
      : `  spent   by turn ${proposal.usedByTurn} at ${proposal.usedAt}`,
  );
  out.line(out.dim(`  key     ${JSON.stringify(proposal.key)} — compared exactly, never fuzzily`));
}

async function cmdShow(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, PROPOSAL_BOOLEANS);
  const id = positional[0];
  if (id === undefined) return usageError(PROPOSAL_USAGE);
  const place = await placeOf(positional, options, 1);
  if (!place.ok) return place.code;

  const read = await inventoryFor(place.subject);
  if (!read.ok) return read.code;

  const stored = findProposal(read.inventory, id);
  if (stored === undefined) {
    ERR.line(`mind: no proposal ${JSON.stringify(id)} for subject ${place.subject}.`);
    return 1;
  }

  // No `--json` here on purpose. `list --json` already puts every record in
  // one document, so a second JSON shape for a single record would be a second
  // thing to keep honest and one more place for the two to disagree — and
  // `jq '.proposals[] | select(.id == "…")'` is the same answer. This
  // subcommand is the one written for a person about to decide.
  sayProposal(OUT, stored.proposal);
  const triage = await readTriage(read.dir, stored.proposal.id);
  if (triage !== undefined) {
    const probs = Object.entries(triage.risk.probabilities).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" · ");
    OUT.line(`  triage  ${triageLabel(triage)} (${triage.model}, ${triage.at})`);
    OUT.line(OUT.dim(`          risk: ${probs}`));
    OUT.line(OUT.dim(`          ${TRIAGE_NOTE}`));
  }
  sayRefusals(ERR, read.inventory);
  return 0;
}

/**
 * `mind proposal triage` — ask Jev about one proposal, or every pending one
 * (D-059). On demand only; `MIND_TRIAGE=jev` is what makes filing do it.
 */
async function cmdTriage(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, [...PROPOSAL_BOOLEANS, "pending"]);
  const pending = options.has("pending");
  const at = pending ? 0 : 1;
  const id = pending ? undefined : positional[0];
  if (!pending && id === undefined) return usageError(PROPOSAL_USAGE);
  const place = await placeOf(positional, options, at);
  if (!place.ok) return place.code;
  const read = await inventoryFor(place.subject);
  if (!read.ok) return read.code;
  const targets = pending
    ? read.inventory.proposals.filter((s) => s.proposal.decision === null)
    : read.inventory.proposals.filter((s) => s.proposal.id === id);
  if (targets.length === 0) {
    ERR.line(pending ? "mind: nothing is pending." : `mind: no proposal ${JSON.stringify(id)} for subject ${place.subject}.`);
    return pending ? 0 : 1;
  }
  const loaded = await loadSoul(place.dir, place.subject);
  const inherits = loaded.ok ? loaded.soul.person.inherits_from : [];
  let failed = 0;
  for (const stored of targets) {
    const outcome = await triageAndStore(read.dir, stored.proposal, place.subject, inherits);
    if (outcome.kind !== "triaged") failed += 1;
  }
  return failed === 0 ? 0 : 1;
}

/** `mind proposal …` — new, decide, list, show. */
export async function cmdProposal(argv: readonly string[]): Promise<number> {
  const [sub = "", ...rest] = argv;
  switch (sub) {
    case "new":
      return cmdNew(rest);
    case "decide":
      return cmdDecide(rest);
    case "list":
      return cmdList(rest);
    case "show":
      return cmdShow(rest);
    case "triage":
      return cmdTriage(rest);
    default:
      return usageError(
        sub === ""
          ? PROPOSAL_USAGE
          : `unknown proposal subcommand ${JSON.stringify(sub)}\n${PROPOSAL_USAGE}`,
      );
  }
}
