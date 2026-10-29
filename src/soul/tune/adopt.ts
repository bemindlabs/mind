/**
 * S21.5 (D-193) — adopting a candidate, and taking it back. Shut behind the proof of S21.7.
 *
 * T5 (revised 2026-10-19): when a candidate passes T6, Mind commits it to the agent repository itself; no
 * yes is asked. What stands in for the yes (the owner's list, in order):
 *
 * 1. only the T4 surface can change: the commit is the base's tree with `role.md` replaced, so prohibitions,
 *    scope, `autonomy.md`, `triggers.md` and `person.md` stay human-only (I-5, I-6);
 * 2. the commit is authored by the agent's own identity, never the owner's (I-5), and its message carries the
 *    run id, the base and candidate SHAs and the held-out numbers;
 * 3. the brake halts it: nothing is committed while STOP is set;
 * 4. `mind soul tune undo` reverts the last tune commit;
 * 5. the owner is told after each adoption (`notice`, printed and kept with the tune record).
 *
 * **The gate.** The owner's second condition is that this stays shut until S21.7 has proved the tuner. A tune
 * adopts nothing and `adopt` refuses unless `personal/evals/tuner-proof.json` is a valid proof for this
 * engine (`proof.ts`: version, git commit, a digest of the tuner's sources, its own digest, four controls
 * passed and four sabotaged twins caught). `mind soul tune --selftest` (S21.7, `selftest.ts`) writes it.
 */

import type { SubjectId } from "../../types.ts";
import { loadSoul } from "../load.ts";
import { soulVersion } from "../eval-runs.ts";
import { blobAt, commitWithBlob, moveHead, readCommit, recentCommits, repoFacts, type Identity } from "./git.ts";
import { checkProof, type EngineIdentity } from "./proof.ts";
import { agentIdentity, branchIntact, readTuneRun, writeTuneRun, type TuneRunRecord } from "./round.ts";

export interface AdoptEnv {
  readonly subject: SubjectId;
  readonly soulDir: string;
  readonly runsDir: string;
  readonly stateRoot: string;
  /** The environment git runs in, read by the caller. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly engine: EngineIdentity;
  readonly stopped: () => Promise<boolean>;
  readonly now: () => Date;
}

export type AdoptResult = { readonly ok: true; readonly commit: string; readonly notice: readonly string[] } | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): AdoptResult => ({ ok: false, reason });

/** The tune commit's trailer: how `undo` finds it again. */
const TRAILER = "Mind-Tune-Run:";
const UNDO_TRAILER = "Mind-Tune-Undo:";

/** A clean, committed soul on a repository with a commit, or why not. */
async function cleanBase(env: AdoptEnv) {
  const repo = await repoFacts(env.soulDir);
  if (!repo.ok) return { ok: false as const, reason: repo.reason };
  const version = await soulVersion(env.soulDir);
  if (version.gitTree === null || version.dirty !== false) return { ok: false as const, reason: "the soul has edits that are not committed: commit or discard them first" };
  return { ok: true as const, facts: repo.facts };
}

/**
 * Adopt the winner of a tune run: a commit on the current branch, authored by the agent, whose tree is the
 * current one with the candidate's `role.md`. Refuses, in this order: no proof, no such run, no winner,
 * already adopted, a brake, a soul that moved or has edits, a candidate branch that is not what the record says.
 */
export async function adoptRun(env: AdoptEnv, runId: string): Promise<AdoptResult> {
  const proof = await checkProof(env.runsDir, env.engine);
  if (!proof.ok) return refuse(proof.reason);
  const read = await readTuneRun(env.runsDir, runId);
  if (!read.ok) return refuse(read.reason);
  const { record } = read;
  const winner = record.candidates.find((c) => c.dimension === record.verdict.winner);
  if (record.verdict.winner === null || winner === undefined || winner.branch === null || winner.commit === null) return refuse(`${runId} has no winner: ${record.verdict.reason}`);
  if (record.adopted !== null) return refuse(`${runId} was adopted already, as ${record.adopted.commit.slice(0, 8)}`);
  if (await env.stopped()) return refuse("the brake is on (STOP, mind stop): nothing is committed while it is set");
  const base = await cleanBase(env);
  if (!base.ok) return refuse(base.reason);
  if (base.facts.head !== record.base.commit) return refuse(`the agent has moved on since the round: HEAD is ${base.facts.head.slice(0, 8)}, the round's base was ${record.base.commit.slice(0, 8)}. Run the tune again`);
  if (!(await branchIntact(env.soulDir, winner))) return refuse(`the branch ${winner.branch} is gone or no longer names ${winner.commit.slice(0, 8)}: the candidate cannot be trusted`);
  const loaded = await loadSoul(env.soulDir, env.subject);
  if (!loaded.ok) return refuse("the soul does not load");
  const rolePath = `${base.facts.prefix}role.md`;
  const blob = await blobAt(env.soulDir, winner.commit, rolePath);
  if (blob === null) return refuse(`${winner.commit.slice(0, 8)} has no ${rolePath}`);
  const h = winner.heldout;
  const message = [
    `tune: adopt ${winner.dimension} candidate of ${record.runId}`,
    "",
    `The harness tuner's ${winner.dimension} candidate for role.md, adopted by the agent itself after passing the held-out rule (T6).`,
    `Held-out pass rate ${h === null ? "n/a" : `${h.base}% -> ${h.candidate}% over ${h.tasks} task(s)`}; base ${record.base.commit.slice(0, 12)}, candidate ${winner.commit.slice(0, 12)}.`,
    "Undo with: mind soul tune undo",
    "",
    `${TRAILER} ${record.runId}`,
    `Mind-Tune-Base: ${record.base.commit}`,
    `Mind-Tune-Candidate: ${winner.commit}`,
    "",
  ].join("\n");
  const when = env.now();
  const commit = await commitWithBlob({ cwd: env.soulDir, stateRoot: env.stateRoot, parent: base.facts.head, path: rolePath, blob: blob.sha, message, author: agentIdentity(loaded.soul), at: when, env: env.env });
  await moveHead(env.soulDir, base.facts.head, commit, `mind soul tune adopt ${record.runId}`);
  const adopted: TuneRunRecord = { ...record, adopted: { commit, at: when.toISOString(), branch: winner.branch } };
  await writeTuneRun(env.runsDir, adopted);
  return { ok: true, commit, notice: adoptionNotice(record, winner.dimension, commit, h) };
}

/** The owner's notice after an adoption: what changed, on whose authority, how to take it back. */
export function adoptionNotice(record: TuneRunRecord, dimension: string, commit: string, held: { readonly base: number; readonly candidate: number; readonly tasks: number } | null): string[] {
  return [
    `Mind adopted a tuned role.md for ${record.subject}: the ${dimension} candidate of ${record.runId}, commit ${commit.slice(0, 8)}.`,
    `Held-out ${held === null ? "n/a" : `${held.base}% -> ${held.candidate}% over ${held.tasks} task(s)`}; only the body of role.md changed. The commit is authored by the agent, not by you.`,
    "To take it back: mind soul tune undo",
  ];
}

/**
 * Revert the most recent tune commit that has not been undone: a new commit with the current tree but the
 * `role.md` the tune commit's parent had. Refuses when `role.md` has changed since, because then a revert
 * would also throw away somebody's later edit.
 */
export async function undoLast(env: AdoptEnv): Promise<AdoptResult> {
  if (await env.stopped()) return refuse("the brake is on (STOP, mind stop): nothing is committed while it is set");
  const base = await cleanBase(env);
  if (!base.ok) return refuse(base.reason);
  const undone = new Set<string>();
  let target: { readonly sha: string; readonly run: string; readonly parent: string } | null = null;
  for (const sha of await recentCommits(env.soulDir, 200)) {
    const c = await readCommit(env.soulDir, sha);
    if (c === null) continue;
    const undoes = c.message.split("\n").find((l) => l.startsWith(UNDO_TRAILER));
    if (undoes !== undefined) undone.add(undoes.slice(UNDO_TRAILER.length).trim());
    const run = c.message.split("\n").find((l) => l.startsWith(TRAILER));
    if (run !== undefined && c.parents.length === 1 && !undone.has(sha)) {
      target = { sha, run: run.slice(TRAILER.length).trim(), parent: c.parents[0]! };
      break;
    }
  }
  if (target === null) return refuse("no tune commit to undo in the last 200 commits");
  const rolePath = `${base.facts.prefix}role.md`;
  const [current, adopted, before] = await Promise.all([blobAt(env.soulDir, "HEAD", rolePath), blobAt(env.soulDir, target.sha, rolePath), blobAt(env.soulDir, target.parent, rolePath)]);
  if (current === null || adopted === null || before === null) return refuse(`${rolePath} is missing at HEAD, at the tune commit or before it`);
  if (current.sha !== adopted.sha) return refuse(`${rolePath} has changed since the tune commit ${target.sha.slice(0, 8)}: a revert would drop that later edit too, so undo it by hand`);
  const loaded = await loadSoul(env.soulDir, env.subject);
  if (!loaded.ok) return refuse("the soul does not load");
  const who: Identity = agentIdentity(loaded.soul);
  const message = `tune: undo ${target.run}\n\nReverts ${target.sha}: role.md goes back to what it was before the adopted candidate.\n\n${UNDO_TRAILER} ${target.sha}\n`;
  const commit = await commitWithBlob({ cwd: env.soulDir, stateRoot: env.stateRoot, parent: base.facts.head, path: rolePath, blob: before.sha, message, author: who, at: env.now(), env: env.env });
  await moveHead(env.soulDir, base.facts.head, commit, `mind soul tune undo ${target.run}`);
  return { ok: true, commit, notice: [`Mind reverted the tuned role.md of ${target.run} (${target.sha.slice(0, 8)}) as ${commit.slice(0, 8)}.`] };
}
