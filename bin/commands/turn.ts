/** `mind turn` — one turn wearing this soul, and one ledger line per send. */

import { readEnv } from "../../src/env.ts";
import { chosenLanguage } from "../../src/lang.ts";
import {
  AnnouncedExec,
  LOCAL_BACKENDS,
  LOCAL_MODEL,
  LocalCliExec,
  OllamaExec,
  PHASE_A_BACKENDS,
  backend as buildBackend,
  fallbackTrail,
  loosenedNote,
  restrain,
  routeModels,
  turnChain,
  type TurnResult,
} from "../../src/exec/index.ts";
import {
  describeRun,
  noteEnded,
  removeRunRecord,
  writeRunRecord,
} from "../../src/decide/runs.ts";
import { judgeInput, judgeLayer, loadLexicon, recordBlocked, resolveJudgeMode, screen } from "../../src/egress/index.ts";
import { browserOnly } from "../../src/decide/effective.ts";
import { pendingAnywhere } from "../../src/task/screen.ts";
import { RecordingExec, canAppend, modelOfTurn, type RecordingOptions } from "../../src/ledger/index.ts";
import { loadPrices } from "../../src/pricing/table.ts";
import { printable } from "../../src/identity/shapes.ts";
import {
  AUTONOMY_FILE,
  PROPOSE_INSTRUCTION,
  SPENT_DIR,
  blockingProposal,
  boundAction,
  claimApproval,
  describeProposal,
  diffSnapshots,
  ensureProposalsDir,
  extractAsks,
  findProposal,
  formatTreeChange,
  proposalLine,
  proposalKey,
  proposalsDir,
  readProposals,
  snapshotTree,
  spendability,
  writeProposal,
  writeProposalAt,
  type Proposal,
  type StoredProposal,
} from "../../src/decide/index.ts";
import { conversationBlock, forCloud, parseHistory, type Exchange } from "../../src/exec/conversation.ts";
import { asLocal, LOCAL_CLI_SEES_PERSONAL } from "../../src/exec/local.ts";
import { engineNotDumpable, fenceSupport, notDumpableNote } from "../../src/exec/fence.ts";
import { chooseRoute, parseRoutePreference, type Route } from "../../src/exec/route.ts";
import { isLocalCliId } from "../../src/exec/local-cli.ts";
import { CappedExec, HELD_AT_ONE_TASK } from "../../src/exec/cap.ts";
import { protectedPlaces, workdirRefusal } from "../../src/exec/workdir.ts";
import {
  splitForCloud,
  DEFAULT_RECALL_CHARS,
  RECALL_HITS,
  describeAttachment,
  ftsPath,
  recall,
  vectorEndpoints,
  withRecall,
  type Attachment,
} from "../../src/memory/index.ts";
import { isKnownBackend, loadSoul, renderSoul, resolveSoulDir, sha256 } from "../../src/soul/index.ts";
import { isLocalBackend } from "../../src/web/turninfo.ts";
import { readBrowserRecords } from "../../src/browser/store.ts";
import { wiringDir } from "../../src/browser/paths.ts";
import type { BrowserHands } from "../../src/browser/mcp-config.ts";
import { browserTaskProblem, browserToolTimeoutMs, stepTimeoutMs, taskForTurn, type TaskRecord } from "../../src/task/index.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { DIAL_REFUSED, decideDial, dialEnv, dialLine, heldNote } from "../dial.ts";
import { triageIfEnabled } from "../triage.ts";
import { dimErr, ledgerEnv, parseArgs, report, usageError } from "../shared.ts";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { isatty } from "node:tty";
import {
  appendRecord,
  consentAllows,
  loadConsent,
  observerDir,
  turnRecord,
} from "../../src/observer/index.ts";

/**
 * One line naming who answered, who did not, and how long it took.
 *
 * Goes to stderr so that stdout is the answer and nothing else, and is never
 * optional: the chain's default starts with a cloud CLI, so "which backend
 * received this soul and this prompt" is a fact the person who typed the
 * command is entitled to without asking for it (I-4, I-6).
 */
function routeLine(result: TurnResult): string {
  const ms = result.evidence.durationMs;
  const took = ms === undefined ? "?" : `${(ms / 1000).toFixed(1)}s`;
  const trail = fallbackTrail(result.evidence.raw);
  const answered = result.confidence === "confirmed" || result.confidence === "partial";

  if (!answered) {
    return `no backend answered · ${took}${trail === undefined ? "" : ` · ${trail}`}`;
  }
  return (
    `answered by ${result.backend} · identity arrived as ${result.identityStrength} · ${took}` +
    (trail === undefined ? "" : ` · missed: ${trail}`)
  );
}

/**
 * Read a prompt from a file, or from standard input when the path is `-`.
 *
 * One trailing newline is removed, and only one. `echo hi | mind turn
 * --prompt-file -` should ask the same question as `--prompt hi`, and a shell
 * adds that newline without being asked. Everything else — interior newlines,
 * trailing spaces, a second blank line somebody meant — is sent verbatim,
 * because `TurnRequest.prompt` says verbatim.
 */
async function readPromptFrom(path: string): Promise<string> {
  const raw = path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
  return raw.replace(/\r?\n$/, "");
}

const TURN_USAGE =
  "usage: mind turn <dir> --subject <id> (--prompt <text> | --prompt-file <path> | --proposal <id>) " +
  "[--backend a,b,c] [--route auto|local|cloud] [--model <m> | --model <backend>=<m>,…] [--private] [--proposal <id>] [--no-recall] [--no-proposals] " +
  "[--recall-chars <n>] [--history-json <[{role,text}]>] [--task <id>] [--json]";

/**
 * The approval `--proposal` names, or the exit code that stops the turn.
 *
 * Read from the proposal store (`src/decide/proposals.ts`) and **never from the
 * ledger**: D-029 put proposals in a store of their own so that reading one back
 * into a decision — which is exactly what this is — stays outside D-022's reach.
 * Nothing here touches `src/ledger/`.
 *
 * `spent` is refused as firmly as `refused`, and that is the owner's decision of
 * 2026-09-22 rather than caution: an approval that keeps working is how *I
 * allowed it once* becomes *it has been doing that ever since*, with nothing
 * anywhere to say when the old permission was used again.
 *
 * Asked twice by a turn (D-144). First with no `claimFor`: a reading, early and
 * cheap, so an approval that is missing, pending, refused or spent stops the
 * turn before anything is written. Then with `claimFor`, as the last step before
 * the prompt goes: read again, and if it is still ready, **claimed in the same
 * step** ({@link claimApproval}) — one exclusive step across processes, so of
 * two turns started together exactly one gets it, and the other is refused here
 * with nothing sent and told which turn has it. Everything that does not depend
 * on the proposal — the ledger, the model and route, recall — is asked between
 * the two, so a turn that stops for one of those has spent nothing.
 */
async function approvalFor(
  subject: SubjectId,
  id: string,
  claimFor?: string,
  /** D-153: the action digest the first reading bound this turn to. The claim is refused if it moved since. */
  boundTo?: string,
): Promise<
  | { readonly ok: true; readonly stored: StoredProposal; readonly proposal: Proposal }
  | { readonly ok: false; readonly code: number }
> {
  const dir = await proposalsDir(dialEnv(), subject);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return { ok: false, code: 1 };
  }
  const inventory = await readProposals(dir.path);
  // Said on the first reading; the second would only say it again.
  if (claimFor === undefined) {
    for (const bad of inventory.unreadable) {
      console.error(`mind: ${bad.path} is in the proposal store and is not a proposal: ${bad.reason}`);
    }
  }

  const stored = findProposal(inventory, id);
  if (stored === undefined) {
    // A usage error rather than a refusal: the command line names something
    // that is not there, which is a different thing from being told no — and a
    // loop that retried this one would retry a typo forever.
    return {
      ok: false,
      code: usageError(
        `no proposal ${JSON.stringify(id)} for subject ${subject} in ${dir.path}. ` +
          `\`mind proposal list\` prints what is there; nothing was sent.`,
      ),
    };
  }

  const state = spendability(stored.proposal);
  if (state.kind === "ready") {
    // D-153 — the approval pays for the action it named, and the record must still hold it. Asked on both
    // readings, and on the second against what the first one bound the turn to: a record rewritten between
    // the two is not claimed.
    const bound = boundAction(stored.proposal);
    if (!bound.ok || (boundTo !== undefined && bound.digest !== boundTo)) {
      console.error(`mind: nothing was sent, and the approval is not spent — ${proposalLine(stored.proposal)}`);
      console.error(`  ${bound.ok ? "the record changed while this turn was getting ready; run it again to read it afresh." : bound.reason}`);
      return { ok: false, code: DIAL_REFUSED };
    }
    if (claimFor === undefined) return { ok: true, stored, proposal: stored.proposal };
    let claim;
    try {
      claim = await claimApproval(stored, claimFor, new Date());
    } catch (error) {
      console.error(`mind: the approval could not be marked as spent: ${error instanceof Error ? error.message : String(error)}`);
      console.error(
        `Nothing was sent. An approval that cannot be recorded as used is one that could be used ` +
          `again, and "good for one turn" would then be a sentence rather than a rule.`,
      );
      return { ok: false, code: 1 };
    }
    if (claim.ok) {
      if (claim.copyFailed !== undefined) {
        console.error(
          `mind: the approval is claimed in ${SPENT_DIR}/, but its record could not say so too ` +
            `(${claim.copyFailed}). Every reader of the store sees the claim; the turn goes ahead.`,
        );
      }
      console.error(
        dimErr(`mind: proposal ${stored.proposal.id} is spent on this turn (${claimFor}). Another turn needs another approval.`),
      );
      return { ok: true, stored, proposal: claim.proposal };
    }
    // Another turn claimed it between the reading and the claim: the race
    // D-144 closes. Said the way a spent one is said, naming the turn that has it.
    console.error(`mind: nothing was sent — ${proposalLine({ ...stored.proposal, usedByTurn: claim.turn })}`);
    console.error(`  ${spentLine(claim.turn)} Another turn took it${claim.at === null ? "" : ` at ${claim.at}`}, a moment before this one.`);
    return { ok: false, code: DIAL_REFUSED };
  }

  console.error(`mind: nothing was sent — ${proposalLine(stored.proposal)}`);
  console.error(
    state.kind === "undecided"
      ? `  It has not been answered. \`mind proposal decide ${id} <dir> --subject ${subject} ` +
          `--approve\` is the answer this turn is waiting for.`
      : state.kind === "refused"
        ? `  It was refused${
            stored.proposal.decision?.note == null ? "" : `: ${stored.proposal.decision.note}`
          }. A refusal is remembered (S5.2 AC2); file a new proposal saying what is different.`
        : `  ${spentLine(state.turn)}`,
  );
  return { ok: false, code: DIAL_REFUSED };
}

/** One sentence for an approval some turn already has — the same whether it was read spent or lost a race. */
function spentLine(turn: string): string {
  return (
    `Its approval was already spent by turn ${turn}. An approval is good for one ` +
    `turn, on purpose: ask again and it will be a decision somebody made today.`
  );
}

/** What a turn that claimed an approval knows about how far it got — told to `cmdTurn` as it goes. */
interface Took {
  /** Set the moment the approval is claimed. */
  claimed?: { readonly proposal: Proposal; readonly stored: StoredProposal; readonly turnId: string; readonly subject: SubjectId };
  /** Every backend whose own `run` was called — past the egress screen, so the request went out or may have. */
  readonly handed: string[];
  /** The backend that answered, if one did. */
  answered?: string;
  /** Set when an answer arrived and the ledger could not record it. */
  unrecorded?: boolean;
}

/**
 * The last line of a turn that claimed an approval and did not finish with 0
 * (D-144). What it says depends on how far the turn got, because what the owner
 * should do next does:
 *
 * - **it ran** — a backend answered, and the turn failed after that (the ledger
 *   could not record it, say). Filing it again would run it a second time.
 * - **it may have run** — the request reached a backend that did not answer. A
 *   vendor CLI at level 2 may have acted before it failed; Mind sees its
 *   output, not its tool calls. Look before asking again.
 * - **nothing was sent** — {@link afterUnsentFailure}: it stays spent, and may be
 *   filed again.
 */
async function afterClaimedFailure(took: Took): Promise<string | undefined> {
  const claimed = took.claimed;
  if (claimed === undefined) return undefined;
  const which = `proposal ${claimed.proposal.id} was spent by this turn (${claimed.turnId})`;
  if (took.answered !== undefined) {
    return (
      `mind: ${which} and it ran — ${took.answered} answered${took.unrecorded === true ? ", and the ledger did not record it" : ""}. ` +
      `Do not file it again to retry: that would run it a second time.`
    );
  }
  if (took.handed.length > 0) {
    return (
      `mind: ${which} and it may have run — the request reached ${took.handed.join(", ")} before the turn failed. ` +
      `Check what it did before asking for it again: a second approval would run it again.`
    );
  }
  return afterUnsentFailure(claimed);
}

/**
 * **D-144 §2 (the owner, 2026-09-29): an approval a failed turn took stays
 * spent.** This is the one place a turn is known to have claimed an approval and
 * then sent nothing to any backend — every backend unavailable, the egress
 * screen stopped the prompt, or the turn threw before its first `run`; every
 * check that does not depend on the proposal was asked before the claim, so only
 * these are left. It is also where a hand-back would go, and the owner chose
 * not to have one: a killed turn could not hand anything back, and a turn that
 * got further may have acted.
 *
 * The remedy is to ask again. The record is marked `sentNothing`, which is what
 * lets it be filed again from its own text — `proposal new --refile <id>`, or
 * "File it again" on the web page — as a new proposal waiting for a new yes.
 */
async function afterUnsentFailure(claimed: NonNullable<Took["claimed"]>): Promise<string> {
  const which = `mind: proposal ${claimed.proposal.id} stays spent — turn ${claimed.turnId} took its approval and nothing was sent (D-144).`;
  try {
    await writeProposalAt(claimed.stored.path, { ...claimed.proposal, sentNothing: true });
  } catch (error) {
    // Not marked, so it cannot be filed again from its record; the same what can still be filed by hand.
    return (
      `${which} It could not be marked as sent-nothing (${String(error)}); to ask again, file the same what ` +
      `with \`mind proposal new <dir> --subject ${claimed.subject}\` and approve the new one.`
    );
  }
  return (
    `${which} To ask again, file it again — \`mind proposal new <dir> --subject ${claimed.subject} ` +
    `--refile ${claimed.proposal.id}\`, or "File it again" on the web page — and approve the new one.`
  );
}

/**
 * The same backend, telling `took` when its own `run` is called, and when that
 * run comes back with an answer. Wrapped inside the egress announcement, so a
 * request the screen stopped is never counted: a backend in this list was
 * handed the prompt, or was about to be.
 *
 * The answer is recorded here, the moment it arrives, and not after the turn's
 * other work: anything that throws after an answer (the after-snapshot, the
 * report, the capture) must leave "it ran", not "it may have run".
 */
function counted<T extends { readonly id: string; run: (request: TurnRequestLike) => Promise<TurnResult> }>(exec: T, took: Took): T {
  return new Proxy(exec, {
    get(target, key, receiver) {
      if (key === "run") {
        return async (request: TurnRequestLike) => {
          took.handed.push(target.id);
          const result = await target.run(request);
          if (result.confidence === "confirmed" || result.confidence === "partial") took.answered = target.id;
          return result;
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The flags `turn` takes no value for.
 *
 * Exported because `--as` parses this command line too, and it needs the same
 * list to tell `--private` from a flag that swallows the next word. See
 * {@link import("./soul.ts").SOUL_CHECK_BOOLEANS} for why there is one copy.
 */
export const TURN_BOOLEANS: readonly string[] = ["json", "private", "no-recall", "no-proposals"];

/**
 * `mind turn` — spend one turn wearing a soul, on whichever backend answers.
 *
 * This is the command S2.1 AC6 is about. The soul is rendered once, by the
 * same renderer `soul apply` uses, and handed over as the system prompt; the
 * backends that have no such channel say so in the result rather than being
 * reported as if they carried it.
 *
 * S2.2 added the record. Each backend is wrapped so that a line lands in the
 * ledger for every backend that was really handed the prompt — one line, not
 * one per turn, because a chain that fell through to the local model gave the
 * text to two vendors and the owner is entitled to know both names.
 *
 * The ledger is checked for writability *before* the prompt goes out. A turn
 * that has already been sent cannot be un-sent by a later error, so "I cannot
 * record this" has to be an answer to a question asked first.
 *
 * A turn that claimed an approval and then did not finish with 0 — or threw —
 * says what became of it, on every way out (D-144): it ran, it may have, or
 * nothing was sent. The sentence is here rather than at each `return`, so a way
 * out added later cannot miss it.
 */
export async function cmdTurn(argv: readonly string[]): Promise<number> {
  // EXEC-02: before any CLI is started. This process holds the owner's environment, and every program it starts
  // runs as the same user; with the flag at 0 `/proc/<pid>/environ` and `mem` belong to root.
  const closed = notDumpableNote(engineNotDumpable());
  if (closed !== undefined) console.error(dimErr(closed));
  const took: Took = { handed: [] };
  let code: number | undefined;
  try {
    code = await turnOnce(argv, took);
    return code;
  } finally {
    if (code !== 0) {
      const line = await afterClaimedFailure(took);
      if (line !== undefined) console.error(line);
    }
  }
}

/** Everything `cmdTurn` does; `took` is told how far a turn with an approval got. */
async function turnOnce(argv: readonly string[], took: Took): Promise<number> {
  const { positional, options } = parseArgs(argv, TURN_BOOLEANS);
  const dir = positional[0];
  const subject = options.get("subject");
  const promptText = options.get("prompt");
  const promptFile = options.get("prompt-file");
  const routePreference = parseRoutePreference(options.get("route"));

  if (routePreference === undefined) {
    return usageError("--route must be one of auto, local or cloud");
  }

  if (promptText !== undefined && promptText !== "" && promptFile !== undefined && promptFile !== "") {
    return usageError("--prompt and --prompt-file name two different prompts; pass one of them");
  }
  // D-153: under `--proposal` the prompt is the approved action, read from its record, so none need be given.
  const underApproval = options.has("proposal");
  if (
    dir === undefined ||
    subject === undefined ||
    subject === "" ||
    (!underApproval && (promptText === undefined || promptText === "") && (promptFile === undefined || promptFile === ""))
  ) {
    return usageError(TURN_USAGE);
  }

  /** What the caller sent, if anything. Under an approval it is only ever compared, never run. */
  let given: string | undefined;
  if (promptFile !== undefined && promptFile !== "") {
    try {
      given = await readPromptFrom(promptFile);
    } catch (error) {
      return usageError(`cannot read the prompt from ${promptFile}: ${String(error)}`);
    }
    if (given === "") return usageError(`the prompt read from ${promptFile} is empty`);
  } else if (promptText !== undefined && promptText !== "") {
    given = promptText;
  }
  let prompt = given ?? "";

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  // D-095: the conversation this turn belongs to, sent by the web page's chat.
  let history: readonly Exchange[] = [];
  const historyRaw = options.get("history-json");
  if (historyRaw !== undefined && historyRaw !== "" && underApproval) {
    // D-153: an approved action runs as it was approved. A conversation sent with it would be a second prompt.
    return usageError("--history-json cannot go with --proposal: an approved action runs as it was approved, with no conversation added. Nothing was sent.");
  }
  if (historyRaw !== undefined && historyRaw !== "") {
    const parsedHistory = parseHistory(historyRaw);
    if (!parsedHistory.ok) return usageError(`${TURN_USAGE} — ${parsedHistory.reason}`);
    history = parsedHistory.items;
  }
  // D-154: a task's step. The task names this turn's timeout and — when it has one — its browser.
  const taskId = options.get("task");
  let task: TaskRecord | undefined;
  if (taskId !== undefined) {
    if (underApproval) return usageError("--task cannot go with --proposal: a step of a task is not an approved action. Nothing was sent.");
    const found = await taskForTurn(dialEnv(), id, taskId);
    if (!found.ok) return usageError(`${found.reason}. Nothing was sent.`);
    task = found.record;
  }
  const recallChars = Number(options.get("recall-chars") ?? String(DEFAULT_RECALL_CHARS));
  if (!Number.isInteger(recallChars) || recallChars < 0) {
    return usageError(`${TURN_USAGE} — --recall-chars is a whole number of characters, 0 or more`);
  }

  const named = (options.get("backend") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  for (const name of named) {
    if (!isKnownBackend(name) && !isLocalCliId(name)) {
      return usageError(`unknown backend ${JSON.stringify(name)}`);
    }
  }
  // D-142 — which step `--model` is for, and whether that step can take it, asked before anything is read or
  // sent. The default chain is checked as the usual one: every chain `turn` builds by itself has ollama in it,
  // and the local CLIs it may put first take no model, so no route can make a model valid here and not below.
  const modelRaw = options.get("model");
  const modelCheck = routeModels(modelRaw, named.length > 0 ? named : [...PHASE_A_BACKENDS]);
  if (!modelCheck.ok) return usageError(`${modelCheck.reason}. Nothing was sent.`);

  // I-3: the soul has to belong to the subject named on the command line, and
  // `loadSoul` is where that is checked — not here, and not by convention.
  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);

  // S5.1/S5.4, asked before anything is sent and before the ledger is even
  // checked. Level 0 — which is what an unreadable `autonomy.md`, a ceiling of
  // 0, or the stop flag all produce — means *do not run this turn*, and the
  // cheapest place to honour that is here, where no process has started.
  const verdict = await decideDial(dir, dialEnv(), id);
  for (const issue of verdict.issues) console.error(`mind: ${AUTONOMY_FILE}: ${issue.message}`);
  if (verdict.effective.act === 0) {
    console.error(`mind: nothing was sent — the autonomy dial is at 0 for this turn.`);
    for (const note of verdict.effective.notes) console.error(`  ${note}`);
    console.error(
      `  ${dialLine(verdict.effective)}\n` +
        `  the brake: ${verdict.stopPath} — ${verdict.effective.stopped ? "IS SET" : "not set"}\n` +
        `  \`mind autonomy show ${dir} --subject ${id}\` prints the whole picture.`,
    );
    return DIAL_REFUSED;
  }
  // S5.2 — asked here, after the brake and before anything is written, because
  // this is the cheapest refusal left: a proposal that was refused, is still
  // waiting, or has already been spent stops the turn with nothing done. Only
  // read here: it is claimed as the last step before the prompt goes (D-144),
  // once everything else that could stop this turn has been asked.
  const proposalId = options.get("proposal");
  let boundDigest: string | undefined;
  if (proposalId !== undefined) {
    // An empty value is a refusal rather than an absence. `--proposal` with
    // nothing after it is somebody asking for a turn *under an approval*, and
    // running it as an ordinary turn would be the free pass this flag exists
    // to make impossible — quietly, which is worse than loudly.
    if (proposalId === "") {
      return usageError("--proposal takes the id of a proposal; it was given nothing");
    }
    const asked = await approvalFor(id, proposalId);
    if (!asked.ok) return asked.code;
    // D-153 — the turn runs exactly the approved action. Its prompt comes from the record, never from the
    // caller; a caller who sent one as well is refused unless it is that action, word for word.
    const bound = boundAction(asked.proposal);
    // approvalFor has already refused a record whose binding fails; this narrows the type.
    if (!bound.ok) return DIAL_REFUSED;
    if (given !== undefined && given !== bound.action.prompt) {
      console.error(`mind: nothing was sent, and the approval is not spent — the prompt is not the approved action.`);
      console.error(`  approved (${bound.digest.slice(0, 19)}…): ${JSON.stringify(bound.action.prompt.slice(0, 200))}`);
      console.error(`  this turn was given:      ${JSON.stringify(given.slice(0, 200))}`);
      console.error(
        `  An approval pays for what it was given for, and nothing else (D-153). Leave out --prompt and the turn ` +
          `runs the approved action; for anything else, file a proposal and ask for a yes.`,
      );
      return DIAL_REFUSED;
    }
    prompt = bound.action.prompt;
    boundDigest = bound.digest;
    console.error(
      dimErr(
        `mind: proposal ${asked.proposal.id} runs the approved action ${bound.digest.slice(0, 19)}…`,
      ),
    );
  }

  // Review of PR #24, finding 1: a step of a task with a browser has the browser and nothing else.
  const effective = task !== undefined && task.operate >= 1 ? browserOnly(verdict.effective) : verdict.effective;
  const restraint = restrain(effective);
  // D-163 (Q4-D2, second rule): a turn that may write is not started in the agent's repo, Mind's state,
  // ~/.secrets or ~/.ssh, nor in a directory that holds or lies inside one of them. Refused, not downgraded —
  // and for a fenced backend too, because the fence makes the working directory writable.
  if (restraint.loosened) {
    const dialHome = dialEnv();
    const refusedDir = workdirRefusal(process.cwd(), protectedPlaces(resolve(dir), dialHome.home, dialHome.env));
    if (refusedDir !== undefined) {
      console.error(`mind: nothing was sent — ${refusedDir}`);
      return DIAL_REFUSED;
    }
  }
  // Review of PR #24, finding 2: a turn that can run commands does not start while one of this agent's tasks is
  // paused on the owner's answer — such a turn could reach the answer itself.
  if (restraint.loosened) {
    const waiting = await pendingAnywhere(dialEnv(), new Date());
    if (waiting.length > 0) {
      console.error(
        `mind: nothing was sent — task ${waiting[0]!.task} (agent ${waiting[0]!.subject}) is waiting on your answer to a held action (${waiting[0]!.id}). ` +
          "A turn that can run commands waits until it is answered: answer it on the web page or at a terminal (`mind task show`).",
      );
      return DIAL_REFUSED;
    }
  }
  if (effective !== verdict.effective) console.error(dimErr(`mind: task ${task!.id}: this step acts through the browser only — no shell, no file tools`));
  // S5.1 AC2 (D-052): the categories are set apart but act together, so a turn
  // whose settings disagree says which one is in force.
  const held = heldNote(effective.dial);
  if (held !== "") console.error(dimErr(`mind: acts at ${effective.act}${held}`));
  const loosened = loosenedNote(effective);
  // Printed before the prompt goes, not after: this is the one line that says a
  // turn may write to the disk, and it is worth nothing once it already has.
  if (loosened !== undefined) console.error(dimErr(`mind: ${loosened}`));

  // Asked before anything is sent. A prompt that has left this machine cannot
  // be recalled by an error message, so a ledger Mind cannot write is a
  // reason not to send — and the exit code says so rather than the turn
  // happening unrecorded.
  const ledger = ledgerEnv();
  const writable = await canAppend(ledger, id);
  if (!writable.ok) {
    console.error(`mind: ${writable.reason}`);
    // D-145: a held lock and an unwritable path want opposite advice, and neither is "delete the ledger".
    console.error(`Nothing was sent. ${writable.remedy}`);
    return 1;
  }

  const soulText = renderSoul(loaded.soul);

  // S4.3 (D-039) — recall is asked after every refusal above and before
  // anything is sent, and printed before it goes, because "what was attached"
  // is worth nothing once the backend already has it (AC3).
  // D-095 — the filter's own test, asked of each recalled piece and each earlier message on its own, so what
  // would stop a cloud turn is left out of the cloud's copy instead of stopping the turn.
  const { lexicon } = await loadLexicon(dialEnv(), id, loaded.soul.person.inherits_from);
  const clean = (text: string) => screen(text, lexicon).length === 0;
  const split = options.has("no-recall") || recallChars === 0 ? undefined : await recallFor(dir, id, prompt, recallChars, clean);
  const attachment = split?.local;
  const cloudAttachment = split?.cloud;
  const cloudHistory = forCloud(history, clean);
  if (split !== undefined && split.held > 0) console.error(dimErr(`mind: recall: ${split.held} piece(s) stay on this machine — a cloud backend gets the rest (personal words or contact details)`));
  if (cloudHistory.held > 0) console.error(dimErr(`mind: conversation: ${cloudHistory.held} earlier message(s) stay on this machine`));

  const localReady = await Promise.all(
    LOCAL_BACKENDS.map((backendId) => buildBackend(backendId).available()),
  );
  const localReadyNow = fenceSupport().ok && localReady.some((available) => available.ok);
  // This explicit constant is the D-123 door: `auto` may route held pieces to
  // a local CLI only while the complete address/transport fence is enabled.
  const localAvailable = LOCAL_CLI_SEES_PERSONAL && localReadyNow;
  const route: Route = named.length > 0
    ? {
        prefer: named.some(isLocalCliId) ? "local" : "cloud",
        reason: "You named the backend chain, so automatic routing did not change it.",
      }
    : chooseRoute({
        held: split?.held ?? 0,
        acting: effective.act >= 2,
        preference: routePreference,
        localAvailable,
      });
  const backendIds = named.length > 0
    ? named
    : route.prefer === "local"
      ? [...LOCAL_BACKENDS, ...PHASE_A_BACKENDS]
      : [...PHASE_A_BACKENDS];
  console.error(dimErr(`mind: route: ${route.reason}`));
  // D-142 — each step's own model. A model belongs to the backend it was chosen for: `backend()` binds it there,
  // and no other step of the chain sees it. Checked above against the usual chain; routed here on the real one.
  const routed = routeModels(modelRaw, backendIds);
  if (!routed.ok) return usageError(`${routed.reason}. Nothing was sent.`);
  if (routed.models.size > 0 && backendIds.length > 1) {
    const own = backendIds.filter((b) => !routed.models.has(b));
    const given = [...routed.models].map(([b, m]) => `${b} → ${m}`).join(", ");
    console.error(dimErr(`mind: model: ${given}${own.length === 0 ? "" : `; ${own.join(", ")} run their own default`}`));
  }

  // D-154/D-155 — a task with a browser hands this step its MCP config: claude and claude-local only (D-157),
  // and only while the dial lets the browser be used. Asked before anything is sent.
  let browser: BrowserHands | undefined;
  if (task?.browser != null) {
    const problem = browserTaskProblem(backendIds, restraint.operate);
    if (problem !== undefined) {
      console.error(`mind: nothing was sent — ${problem}`);
      return DIAL_REFUSED;
    }
    const { records } = await readBrowserRecords(dialEnv(), id);
    const record = records.find((entry) => entry.task === task!.browser!.task);
    if (record === undefined) {
      console.error(`mind: nothing was sent — task ${task.id}'s browser is not running (no record for ${task.browser.task}).`);
      return 1;
    }
    const toolTimeoutMs = browserToolTimeoutMs(task);
    browser = {
      port: record.port,
      token: record.token,
      operate: record.operate,
      dir: wiringDir(dialEnv(), id, record.task),
      ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
    };
    console.error(dimErr(`mind: task ${task.id}: this step has its browser (operate ${Math.min(restraint.operate, record.operate)}, ${record.allowed.join(", ")})`));
  }

  // D-045 — level 1 is "propose": the vendor is read-only already, and this
  // tells the model where to put what it would have done.
  const compose = (att: Attachment | undefined, talk: string) => {
    const parts = [att === undefined ? soulText : withRecall(soulText, att), talk].filter((p) => p !== "").join("\n\n");
    // A task's step reports in its own block (src/task/prompt.ts), not as proposals.
    return effective.act === 1 && task === undefined ? `${parts}\n\n${PROPOSE_INSTRUCTION}` : parts;
  };
  const system = compose(attachment, conversationBlock(history));
  const cloudSystem = compose(cloudAttachment, conversationBlock(cloudHistory.kept, cloudHistory.held));
  const writeFailures: Error[] = [];
  const turnId = crypto.randomUUID();
  // S15.9 — the price tables in force as this turn begins. An owner's file that
  // cannot be used is said here, once, and every line of this turn is recorded
  // as not charged rather than priced at a default the owner meant to replace.
  const prices = await loadPrices(ledger.home, ledger.env);
  if (prices.owner.state === "unusable") {
    // Escaped: the reason quotes the file (a field name it refused), and a file is somebody's text.
    console.error(
      `mind: the price file ${printable(prices.ownerPath)} cannot be used — ${printable(prices.owner.reason)}. ` +
        "This turn is recorded as not charged (table-unusable); `mind usage prices` shows the tables.",
    );
  }
  const recording: RecordingOptions = {
    ledger,
    turnId,
    newId: () => crypto.randomUUID(),
    content: options.has("private") ? "withheld" : "full",
    // Replaced per backend below: the model each one runs by construction (null for a vendor CLI, D-142).
    model: null,
    prices,
    // The soul text itself is in git; the hash is enough to say which version
    // was worn without keeping a second copy out here to delete later. Taken
    // from the soul alone: recall changes per turn, and a hash that moved with
    // it would stop naming which soul was worn (D-039).
    soulSha: sha256(soulText),
    onWriteFailure: (error) => writeFailures.push(error),
  };

  // Each member is wrapped, not the chain: `FallbackExec.run` is called once
  // per turn, but `RecordingExec.run` is called once per backend that was
  // really handed the text — which is the fact worth recording, and the same
  // fact `AnnouncedExec` says out loud one moment earlier (S7.2 AC4). The
  // notice goes to stderr, so a `--json` stdout stays parseable, and it is
  // asked of `raw` rather than of the recorder around it: a wrapper copies the
  // id it wraps, and a copied id is no evidence of where a turn goes.
  // D-181: the judge runs when MIND_EGRESS_JUDGE names one or a local model is configured; with neither, a prompt that
  // leaves is announced as screened by the filter alone, every time.
  const judge = resolveJudgeMode("cloud-turn", process.env);
  const blocked: Promise<void>[] = [];
  /** Per backend id, the model it runs by construction — null for a vendor CLI, which says what it ran (D-142). */
  const modelRun = new Map<string, string | null>();
  /** Backends in this chain that have no tools at all (D-149): they can answer, never act. */
  const toolless = new Set<string>();
  const workdir = process.cwd();
  const chain = turnChain(
    backendIds.map((backendId) => {
      const own = routed.models.get(backendId);
      const raw = buildBackend(backendId, own === undefined ? {} : { model: own });
      // D-163 (Q4-D2): the one place the cap on a backend that is not kernel-fenced is applied. Innermost, so
      // it sees the request exactly as this backend will run it (a local CLI's fence already on it).
      const guarded = new CappedExec(raw, (line) => console.error(dimErr(`mind: ${line}`)), task === undefined ? PROPOSE_INSTRUCTION : HELD_AT_ONE_TASK, raw instanceof OllamaExec);
      const localCli = raw instanceof LocalCliExec ? raw : undefined;
      // The model this backend runs by construction (S15.9, D-142): a local CLI
      // runs LiteLLM's `local-coder`; ollama runs its own `--model` or the
      // MIND_OLLAMA_MODEL default. A vendor CLI is handed its own `--model`,
      // if any, as a request: its line names the model its output reports.
      const ran = localCli !== undefined ? LOCAL_MODEL : raw instanceof OllamaExec ? (raw.defaultModel ?? null) : null;
      modelRun.set(backendId, ran);
      if (raw instanceof OllamaExec) toolless.add(backendId);
      // D-144: counted inside the announcement, so a prompt the egress screen stopped is not counted as sent.
      const announced = new AnnouncedExec(counted(new RecordingExec(guarded, { ...recording, model: ran }), took), {
        origin: raw,
        write: (line) => console.error(dimErr(line)),
        // S8.3 (D-048): prompt and system — the soul and whatever recall
        // attached — are screened before anything leaves this machine.
        screen: (request) => screen(`${request.prompt}\n${request.system ?? ""}`, lexicon),
        // D-061: a model on this machine reads meaning the filter cannot. Unsure
        // keeps the prompt in. D-071: it reads the question and the recall, not
        // the soul — the filter above reads all. D-181: it is on when the owner
        // named one or a local model is configured; else the line says the filter
        // alone screened this prompt.
        ...judgeLayer<TurnRequestLike>(
          judge,
          lexicon.needles,
          (request) => judgeInput(request.prompt, [cloudAttachment?.block ?? "", conversationBlock(cloudHistory.kept)].filter((b) => b !== "").join("\n\n")),
          chosenLanguage(process.env),
        ),
        onBlocked: (backendId, findings) => {
          blocked.push(
            recordBlocked(dialEnv(), id, { at: new Date().toISOString(), backend: backendId, findings }).then(
              () => undefined,
              (error: unknown) => console.error(`mind: the block was not recorded: ${String(error)}`),
            ),
          );
        },
      });
      if (localCli === undefined) {
        return asLocal(raw) === undefined ? withSystem(announced, cloudSystem) : announced;
      }
      // Locality is a fact about this prepared request, not the backend id: its
      // fence must name exactly the LiteLLM port. Make that check at dispatch,
      // then hand an inadmissible request the cloud copy as D-095 requires.
      return withRequest(announced, (request) => {
        const prepared = localCli.prepare(request);
        return asLocal(raw, prepared) === undefined
          ? { ...prepared, system: cloudSystem }
          : prepared;
      });
    }),
  );

  // S5.2 (D-144) — the approval is claimed **here**, as the last step before
  // the prompt goes, and read again in the same step: of two turns started
  // together, exactly one gets it, and the other stops here with nothing sent.
  // Here rather than at the reading above, so that nothing that does not depend
  // on the proposal — the ledger, the model and route, recall, the price file —
  // can stop the turn after its approval was spent.
  let approval: Proposal | undefined;
  if (proposalId !== undefined) {
    const claimed = await approvalFor(id, proposalId, turnId, boundDigest);
    if (!claimed.ok) return claimed.code;
    approval = claimed.proposal;
    took.claimed = { proposal: approval, stored: claimed.stored, turnId, subject: id };
  }

  // S5.4 — written **before** the prompt goes anywhere, and removed in a
  // `finally`. The ledger line is written after a backend answers, so a turn
  // killed mid-flight leaves nothing there; this is the only thing on disk that
  // says a turn is in progress, and it is what makes `mind stop` able to find
  // one. A failure to write it does not stop the turn — a kill switch that can
  // veto work is a worse failure than one that misses a turn — but it is said.
  let runRecordPath: string | undefined;
  const runRecord = describeRun({ turnId, subject: id, backends: backendIds, at: new Date(), loosened: restraint.loosened });
  try {
    runRecordPath = await writeRunRecord(dialEnv(), runRecord);
  } catch (error) {
    console.error(
      `mind: could not write the run record (${String(error)}). The turn is going ahead; ` +
        `\`mind stop\` will not be able to find it, and the process group is printed above ` +
        `by nothing, so Ctrl-C is all you have for this one.`,
    );
  }

  // S5.2 AC4 (D-043) — a turn allowed to act reports what it changed before
  // it ends. The snapshot is only taken when the vendor may write at all.
  const before = effective.act >= 2 ? await snapshotTree(workdir) : undefined;

  const sentAt = new Date();
  let result: TurnResult;
  try {
    result = await chain.run({
      subject: id,
      prompt,
      system,
      restraint,
      ...(browser === undefined ? {} : { browser }),
      ...(task === undefined ? {} : { timeoutMs: stepTimeoutMs(task) }),
    });
  } finally {
    // A loosened turn notes when it ran, so an approval claimed meanwhile is never signed (review of PR #24, round 3).
    if (restraint.loosened) await noteEnded(dialEnv(), runRecord, new Date());
    if (runRecordPath !== undefined) await removeRunRecord(runRecordPath);
  }

  // D-032 — the turn records itself, under the consent `observe enable` took
  // and through the store the hook writes to. After the answer and outside
  // the exit code: capture is the observer's business, not the turn's contract,
  // and a turn that failed because a counter could not be written would have
  // taught somebody to switch the counter off (the same reasoning that makes
  // the hook exit 0). The ledger above is different — it is the contract.
  await captureTurn({
    subject: id,
    turnId,
    at: sentAt,
    result,
    proposal: approval !== undefined,
  });

  await Promise.all(blocked);
  const change = before === undefined ? undefined : diffSnapshots(before, await snapshotTree(workdir));
  // Level 2 is "act, then report"; level 3 is "act" (S5.1 AC1, D-047). At 3
  // the report is still made — it is in --json — but it does not interrupt.
  if (change !== undefined && !restraint.unfenced) {
    for (const line of formatTreeChange(workdir, change)) console.error(`mind: ${line}`);
  }

  const answered = result.confidence === "confirmed" || result.confidence === "partial";
  // D-149 — a backend with no tools answers in words and nothing else. At a level that lets a turn act, its
  // answer is said for what it is, so a "done" from a model that could do nothing is not read as done.
  const notes: string[] = [];
  if (effective.act >= 2 && answered && toolless.has(result.backend)) {
    notes.push(`${result.backend} has no tools — it answered in words and could not act. Nothing it says it did was done (D-149).`);
  }
  for (const note of notes) console.error(`mind: ${note}`);
  // D-163: already printed when the turn was capped; kept in `notes` so the page and the app show it too.
  if (result.capped !== undefined) notes.push(result.capped);
  // `--no-proposals`: a measurement (`mind eval`) must not leave work in the owner's list —
  // what the agent would have asked is still printed, just not filed.
  const filed = (effective.act === 1 || result.capped !== undefined) && answered && task === undefined && !options.has("no-proposals") ? await fileAgentAsks(id, turnId, result.text, loaded.soul.person.inherits_from) : [];

  // The answering backend's model, told the way its ledger line tells it (D-142).
  const aboutModel = modelOfTurn(result.evidence.model, null, modelRun.get(result.backend) ?? null);

  if (options.has("json")) {
    console.log(
      JSON.stringify(
        {
          ...result,
          // The id the ledger line carries: a task's step records it, which is the link between the two (D-154).
          turn: turnId,
          task: task?.id ?? null,
          route: routeLine(result),
          // S12.4 — who handled this turn, so a caller (the web page) can say it
          // without parsing the route sentence. `local` is the display rule (an
          // id: ollama or *-local), not `asLocal`'s runtime check — see
          // src/web/turninfo.ts for why the two are deliberately different.
          local: isLocalBackend(result.backend),
          // The model the answering backend ran — the same value its ledger
          // line records (S15.9, D-142): for a vendor CLI the model its own
          // output named (`opus` asked, `claude-opus-5-5` ran), null when it
          // named none; for ollama the flag or MIND_OLLAMA_MODEL. What was
          // asked is `model_requested`, apart, and never presented as the model.
          model: aboutModel.model,
          model_requested: aboutModel.requested,
          // D-095 — how much of what this turn carried stayed on this machine
          // because a cloud backend may not see it. Meaningful when `local` is
          // false: a local backend is handed everything, nothing is held.
          held: split?.held ?? 0,
          heldMessages: cloudHistory.held,
          changed: change === undefined ? null : change === null ? "not-measured" : change,
          proposals: filed,
          // D-149: what a caller must show beside the answer — the page and the app read it here, not off stderr.
          notes,
          recall:
            attachment === undefined
              ? null
              : { chars: attachment.chars, ceiling: attachment.ceiling, skipped: attachment.skipped, attached: attachment.attached },
        },
        null,
        2,
      ),
    );
  } else {
    if (result.text !== "") console.log(result.text);
    console.error(dimErr(routeLine(result)));
  }

  // An answer that arrived is still printed — hiding it would lose something
  // real to punish a bookkeeping failure — but the exit code is not 0, because
  // this turn happened and the ledger does not know about it.
  if (writeFailures.length > 0) {
    took.unrecorded = true;
    for (const failure of writeFailures) console.error(`mind: ledger write failed: ${failure.message}`);
    console.error(
      `${writeFailures.length} turn(s) were sent and not recorded. The answer above is real; ` +
        `the record of it is missing.`,
    );
    return 1;
  }

  // Exit 1 when nothing answered, and say so rather than exiting 0 with an
  // empty stdout — the silent success is the failure this project exists to
  // catch.
  return answered ? 0 : 1;
}

/** One proposal block from the answer, and what became of it. */
interface FiledAsk {
  readonly what: string;
  readonly id: string | null;
  readonly outcome: "filed" | "already-asked" | "unreadable" | "not-written";
}

/**
 * S5.2 AC1 (D-045) — what the agent said it would do, into the proposal store.
 *
 * The same rules `proposal new` keeps: a thing already refused, or still
 * waiting, is not filed again. Every block is accounted for on stderr, filed
 * or not, because a proposal that silently went nowhere is the failure mode
 * this whole level exists to prevent.
 */
async function fileAgentAsks(
  subject: SubjectId,
  turnId: string,
  text: string,
  inheritsFrom: readonly string[],
): Promise<readonly FiledAsk[]> {
  const found = extractAsks(text);
  const out: FiledAsk[] = [];
  for (let i = 0; i < found.unreadable; i += 1) out.push({ what: "", id: null, outcome: "unreadable" });
  if (found.asks.length > 0) {
    const dir = await ensureProposalsDir(dialEnv(), subject);
    const inventory = dir.ok ? await readProposals(dir.path) : undefined;
    for (const ask of found.asks) {
      if (!dir.ok || inventory === undefined) {
        out.push({ what: ask.what, id: null, outcome: "not-written" });
        continue;
      }
      const blocking = blockingProposal(inventory, proposalKey(ask.what));
      if (blocking !== undefined) {
        out.push({ what: ask.what, id: blocking.id, outcome: "already-asked" });
        continue;
      }
      const proposal = describeProposal({
        id: crypto.randomUUID(),
        subject,
        at: new Date(),
        ...ask,
        filedBy: "agent",
        fromTurn: turnId,
      });
      try {
        await writeProposal(dir.path, proposal);
        out.push({ what: ask.what, id: proposal.id, outcome: "filed" });
        // D-059 — only when the owner set MIND_TRIAGE=jev. Advisory: it approves nothing.
        await triageIfEnabled(dir.path, proposal, subject, inheritsFrom);
      } catch {
        out.push({ what: ask.what, id: null, outcome: "not-written" });
      }
    }
  }
  for (const ask of out) {
    const line =
      ask.outcome === "filed"
        ? `proposal ${ask.id} filed by the agent: ${ask.what}`
        : ask.outcome === "already-asked"
          ? `not filed — already asked (${ask.id}), and a refusal or a pending question is not asked twice: ${ask.what}`
          : ask.outcome === "unreadable"
            ? "a proposal block was in the answer and could not be read (it needs what, why and impact) — nothing was filed for it"
            : `not filed — the proposal store could not be written: ${ask.what}`;
    console.error(`mind: ${line}`);
  }
  if (out.some((ask) => ask.outcome === "filed")) {
    console.error(
      dimErr(
        `mind: nothing was done. Approve with \`mind proposal decide <id> <dir> --subject ${subject} ` +
          `--approve\`, then run the turn again with --proposal <id> at level 2.`,
      ),
    );
  }
  return out;
}

/**
 * What this turn will carry from the agent's memory, printed before it goes.
 *
 * The agent repository is the soul directory's parent when `<dir>` named the
 * soul itself (D-033's rule, read back the other way). An agent with no index
 * has not been given recall — `mind memory index` is the step that gives it —
 * so nothing is asked, nothing is embedded and nothing is printed. A store that
 * is down leaves the full-text half (I-1).
 */
async function recallFor(
  dir: string,
  subject: SubjectId,
  prompt: string,
  ceiling: number,
  clean: (text: string) => boolean,
): Promise<ReturnType<typeof splitForCloud> | undefined> {
  const soulDir = await resolveSoulDir(dir);
  const agentDir = soulDir === dir ? dirname(dir) : dir;
  if (!(await Bun.file(ftsPath(agentDir)).exists())) return undefined;

  const checked = vectorEndpoints(process.env);
  const found = await recall(
    agentDir,
    subject,
    prompt,
    RECALL_HITS,
    checked.ok ? checked.endpoints : { reason: checked.reason },
    undefined,
    "any",
  );
  const split = splitForCloud(found.hits, ceiling, clean);
  if (found.vector !== "ok") console.error(dimErr(`mind: recall: vector half skipped — ${found.vector.failed}`));
  for (const line of describeAttachment(split.local)) console.error(dimErr(`mind: ${line}`));
  return split;
}

/**
 * The same backend, handed a different system prompt (D-095): the cloud's copy, from which what the egress
 * filter would stop has been left out. Everything else — its id, what it records, what it announces — is
 * the backend's own.
 */
function withSystem<T extends { run: (request: TurnRequestLike) => Promise<TurnResult> }>(exec: T, system: string): T {
  return new Proxy(exec, {
    get(target, key, receiver) {
      if (key === "run") return (request: TurnRequestLike) => target.run({ ...request, system });
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Apply a backend-specific request boundary before wrappers inspect or record it. */
function withRequest<T extends { run: (request: TurnRequestLike) => Promise<TurnResult> }>(
  exec: T,
  prepare: (request: TurnRequestLike) => TurnRequestLike,
): T {
  return new Proxy(exec, {
    get(target, key, receiver) {
      if (key === "run") return (request: TurnRequestLike) => target.run(prepare(request));
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

type TurnRequestLike = Parameters<AnnouncedExec["run"]>[0];

/**
 * Record that this turn happened, if — and only if — the owner has agreed to
 * capture. Silent when they have not: "capture is off" is this program's
 * default state, and a line printed on every turn about it is how people learn
 * to ignore the line that matters.
 *
 * The terminal test is the whole of the evidence for `origin` (D-032): both
 * stdin (fd 0) and stderr (fd 2), because a pipe on either side means a program
 * is at one end of this turn, and a program is not the owner.
 */
async function captureTurn(parts: {
  readonly subject: SubjectId;
  readonly turnId: string;
  readonly at: Date;
  readonly result: TurnResult;
  readonly proposal: boolean;
}): Promise<void> {
  // The same escape hatch the hook honours, so a fleet launcher that set it
  // once stays out of the data on both doors.
  if (readEnv("CAPTURE", process.env) === "off") return;

  const dir = await observerDir({ home: homedir(), env: process.env }, parts.subject);
  if (!dir.ok) {
    console.error(dimErr(`mind: this turn was not captured: ${dir.reason}`));
    return;
  }
  if (!consentAllows(await loadConsent(dir.path), "capture")) return;

  const record = turnRecord({
    turnId: parts.turnId,
    at: parts.at.toISOString(),
    project: process.cwd(),
    backend: parts.result.backend,
    confidence: parts.result.confidence,
    // `isatty` from node:tty, not `process.stderr.isTTY`: reading that getter
    // can cut a later long write short through a pipe (test/cli/streams.test.ts).
    terminal: isatty(0) && isatty(2),
    proposal: parts.proposal,
  });
  // `appendRecord` will not create the tree: a purge between the consent
  // check and here leaves this refused, which is the right answer (I-4).
  const outcome = await appendRecord(dir.path, record, parts.at);
  if (!outcome.ok) {
    console.error(dimErr(`mind: the turn happened and was not captured: ${outcome.reason}`));
  }
}
