/**
 * S21.5 (D-193) — one round of `mind soul tune`: propose, probe, select. Nothing is adopted here.
 *
 * The round is a function of what it is handed: the engine's three ways of reaching a model or a clock
 * (`TuneDeps`) are passed in, so a scripted proposer and a fake evaluator run the very code the command
 * runs. What is not injected is the part that must not be faked: the leak guard, the T4 check, the git
 * plumbing and the T6 rule.
 *
 * ```
 *  preflight ──► base run (train + held-out, k repeats, recorded)
 *            ──► INV and DOM proposer calls, train failures only (T2)
 *            ──► candidate branches tune/<runId>-inv|dom (plumbing, never the working tree)
 *            ──► probe: the same tasks on each candidate, compared to the base (S21.3)
 *            ──► verdict per candidate (T6, and keep-base under 6 held-out tasks), one winner or KEEP_BASE
 *            ──► mind/tune-run@1 in personal/evals/ (outside git, 0600)
 * ```
 *
 * The brake (`STOP`, `mind stop`) is asked between every step. When it is on, the round ends, the branches
 * it made are deleted again, and no record is written: nothing is left behind a stop that the stop did not
 * find (the eval runs a child had already finished are the ordinary records of those runs).
 */

import { basename, dirname, join } from "node:path";
import { VERSION } from "../../version.ts";
import type { SubjectId } from "../../types.ts";
import { unifiedDiff } from "../diff.ts";
import { compareSides, selectByRule, type SplitDelta, type TaskChange } from "../eval-compare.ts";
import { privateDir, soulVersion, sha256, type EvalRunRecord, type Style } from "../eval-runs.ts";
import { MIN_HELDOUT, type EvalTask } from "../evals.ts";
import { lessonKey, readDecisions, readLessons, selectLessons } from "../lessons.ts";
import { loadSoul } from "../load.ts";
import { formatIssue, type Soul } from "../schema.ts";
import { replaceFile } from "../../task/store.ts";
import { askProposer, evidenceFrom, leakSources, missionFor, relaxedGuard, type Guard, type ProposerOutcome } from "./candidate.ts";
import { blobAt, branchCommit, changedPaths, commitWithBlob, createBranch, deleteBranch, repoFacts, writeBlob, type Identity, type RepoFacts } from "./git.ts";
import { DIMENSIONS, PROMPTS_VERSION, type Dimension, type LeakSources, type Lesson } from "./prompts.ts";
import { reflectOnRound, type ReflectionRecord } from "./reflect.ts";

export const TUNE_SCHEMA = "mind/tune-run@1";

const TUNE_ID = /^tn-\d{8}T\d{6}Z-[0-9a-f]{4}$/;

export const isTuneRunId = (id: string): boolean => TUNE_ID.test(id);

/** `tn-` + UTC time to the second + 4 hex, like an eval run id. */
export function newTuneRunId(at: Date): string {
  return `tn-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${crypto.randomUUID().slice(0, 4)}`;
}

/** The agent's own identity for a commit (I-5): its name and a subject address that is nobody's mailbox. */
export function agentIdentity(soul: Soul): Identity {
  return { name: `${soul.role.name} (Mind agent)`, email: `${soul.subject}@agents.mind.invalid` };
}

export interface TuneCost {
  readonly turns: number;
  readonly tokens: number;
  /** Turns whose backend printed no token count: the sum is then a floor. */
  readonly tokensUnknown: number;
}

export interface TuneDeps {
  /** True while the brake is on (any doubt counts as on). */
  readonly stopped: () => Promise<boolean>;
  /** One proposer prompt through the engine's normal turn path; the answer text, or a throw. */
  readonly propose: (prompt: string, dimension: Dimension, attempt: 1 | 2) => Promise<string>;
  /** One reflection prompt (S21.6) through the same engine path as the proposer: the agent's own backend, the egress notice, the ledger, the fence. The answer text, or a throw. */
  readonly reflect: (prompt: string, attempt: 1 | 2) => Promise<string>;
  /** The base soul on train + held-out, `repeat` times, answers kept, recorded. */
  readonly evalBase: () => Promise<EvalRunRecord>;
  /** The soul at `ref` on the same tasks, compared with the recorded `base`, recorded. */
  readonly evalCandidate: (ref: string, base: EvalRunRecord) => Promise<EvalRunRecord>;
  /** Turns and tokens in the ledger from `since` on. */
  readonly cost: (since: Date) => Promise<TuneCost>;
  /** A recorded run of exactly this soul and task set that kept its answers, for `--dry-run`; null when there is none. */
  readonly recordedBase: () => Promise<EvalRunRecord | null>;
  readonly now: () => Date;
  readonly say: (line: string) => void;
}

export interface TuneContext {
  readonly subject: SubjectId;
  /** The soul directory, resolved. */
  readonly soulDir: string;
  /** The agent's repository root, where `evals.md` and `lessons.md` are; the parent of a `soul/` directory when absent. */
  readonly agentDir?: string;
  readonly tasks: readonly EvalTask[];
  readonly setText: string;
  readonly repeat: number;
  readonly backend: string | null;
  readonly model: string | null;
  readonly stateRoot: string;
  /** `personal/evals/`. */
  readonly runsDir: string;
  /** The environment git runs in, read by the caller. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface TuneCandidate {
  readonly dimension: Dimension;
  readonly outcome: "edit" | "keep-base";
  /** The proposer's notes, or why the dimension kept the base (cut to 2000 characters). */
  readonly reason: string;
  readonly tries: number;
  readonly branch: string | null;
  readonly commit: string | null;
  /** The eval run of the candidate soul. */
  readonly runId: string | null;
  readonly train: SplitDelta | null;
  readonly heldout: SplitDelta | null;
  /** Every task × mode whose verdict moved. */
  readonly changes: readonly TaskChange[];
  /** T6 on this candidate alone. */
  readonly selection: { readonly verdict: "adopt" | "keep-base"; readonly reason: string } | null;
  /** After the small-set rule. */
  readonly verdict: "adopt" | "keep-base";
  readonly why: string;
}

export interface TuneRunRecord {
  readonly schema: typeof TUNE_SCHEMA;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly subject: string;
  readonly engine: string;
  readonly prompts: string;
  readonly backend: string | null;
  readonly model: string | null;
  readonly repeat: number;
  readonly base: { readonly commit: string; readonly runId: string; readonly soulTree: string | null; readonly evalsSha256: string; readonly train: number; readonly heldout: number; readonly heldoutTasks: number };
  readonly candidates: readonly TuneCandidate[];
  readonly verdict: { readonly winner: Dimension | null; readonly reason: string };
  readonly cost: TuneCost;
  /** S21.6: the run ids of the accepted lessons the proposers were shown (`lessons.md`, matched to the train failures). Absent on a record from before. */
  readonly lessonsShown?: readonly string[];
  /** S21.6 (D-196): verdict rows and the at most one proposed lesson; a lesson waits here for `mind soul tune lessons accept`. Absent on a record from before. */
  readonly reflection?: ReflectionRecord;
  /** Set by `mind soul tune adopt`. */
  readonly adopted: { readonly commit: string; readonly at: string; readonly branch: string } | null;
}

export type TuneOutcome =
  | { readonly kind: "refused"; readonly reasons: readonly string[] }
  | { readonly kind: "stopped"; readonly where: string }
  | { readonly kind: "dry-run"; readonly illustrative: boolean; readonly missions: readonly { readonly dimension: Dimension; readonly mission: string }[] }
  | { readonly kind: "done"; readonly record: TuneRunRecord; readonly path: string; readonly diffs: Readonly<Record<string, string>> };

interface Pre {
  readonly soul: Soul;
  readonly roleText: string;
  readonly personText: string;
  readonly repo: RepoFacts;
  readonly rolePath: string;
}

/** Every precondition as a refusal that says what to do. Empty `reasons` and a `pre` when all hold. */
export async function preflight(ctx: TuneContext, deps: Pick<TuneDeps, "stopped">, dryRun: boolean): Promise<{ readonly ok: true; readonly pre: Pre } | { readonly ok: false; readonly reasons: readonly string[] }> {
  const reasons: string[] = [];
  const loaded = await loadSoul(ctx.soulDir, ctx.subject);
  if (!loaded.ok) reasons.push(`the soul does not load: ${loaded.issues.map(formatIssue).join("; ")}`);
  const train = ctx.tasks.filter((t) => t.split === "train").length;
  const held = ctx.tasks.filter((t) => t.split === "heldout").length;
  if (train === 0) reasons.push('evals.md has no train task: a tune needs failures to learn from (a task is train unless it says split = "heldout")');
  if (held === 0) reasons.push('evals.md has no held-out task: a candidate is judged on tasks the proposer never saw (mind eval split --heldout <n> --write)');
  if (!dryRun && (await deps.stopped())) reasons.push("the brake is on (STOP, mind stop): nothing starts while it is set (mind autonomy resume clears it)");
  const repo = await repoFacts(ctx.soulDir);
  if (!repo.ok) reasons.push(repo.reason);
  else {
    const version = await soulVersion(ctx.soulDir);
    if (version.gitTree === null || version.dirty !== false) reasons.push("the soul has edits that are not committed: the base of a tune must be a commit, so commit or discard them first");
  }
  if (reasons.length > 0 || !loaded.ok || !repo.ok) return { ok: false, reasons };
  const rolePath = `${repo.facts.prefix}role.md`;
  const roleBlob = await blobAt(ctx.soulDir, "HEAD", rolePath);
  const personBlob = await blobAt(ctx.soulDir, "HEAD", `${repo.facts.prefix}person.md`);
  if (roleBlob === null || personBlob === null) return { ok: false, reasons: ["role.md and person.md are not both in HEAD: the base of a tune must be a commit"] };
  return { ok: true, pre: { soul: loaded.soul, roleText: roleBlob.text, personText: personBlob.text, repo: repo.facts, rolePath } };
}

/** The newest recorded plain run of exactly this soul and task set that kept its answers: what `--dry-run` shows evidence from. */
export function usableBase(runs: readonly EvalRunRecord[], evalsSha256: string, contentSha256: string): EvalRunRecord | null {
  return runs.find((r) => r.compare === undefined && r.keptAnswers && r.split === "all" && r.evalsSha256 === evalsSha256 && r.soul.contentSha256 === contentSha256 && r.soul.dirty !== true) ?? null;
}

const PLACEHOLDER = "(illustrative: no recorded run with answers yet; a real round shows the agent's own answer here)";

/** Sum a ledger window into turns and tokens (total when printed, else input + output; unknown when neither). */
export function costOf(entries: readonly { readonly usage?: { readonly total: number | null; readonly input: number | null; readonly output: number | null } }[]): TuneCost {
  let tokens = 0;
  let unknown = 0;
  for (const e of entries) {
    const u = e.usage;
    const n = u === undefined ? null : (u.total ?? (u.input !== null && u.output !== null ? u.input + u.output : null));
    if (n === null) unknown += 1;
    else tokens += n;
  }
  return { turns: entries.length, tokens, tokensUnknown: unknown };
}

const lower = (d: Dimension) => d.toLowerCase();

/** The agent's repository root: where `evals.md` and `lessons.md` sit. */
export function agentRootOf(ctx: Pick<TuneContext, "agentDir" | "soulDir">): string {
  return ctx.agentDir ?? (basename(ctx.soulDir) === "soul" ? dirname(ctx.soulDir) : ctx.soulDir);
}

/**
 * The accepted lessons whose cue matches this round's train failures (the rule is `selectLessons`): only what is
 * in `lessons.md` exists as far as the proposer is concerned (T7). A file that cannot be read gives none, with a line.
 */
async function lessonsFor(ctx: TuneContext, failedAsks: readonly string[], sources: LeakSources, personText: string, say: (line: string) => void): Promise<{ readonly lessons: readonly Lesson[]; readonly shown: readonly string[] }> {
  const read = await readLessons(agentRootOf(ctx));
  if (!read.ok) {
    say(`lessons.md is not read: ${read.reason}`);
    return { lessons: [], shown: [] };
  }
  const { chosen, refused } = selectLessons(read.entries, failedAsks, { sources, personText });
  if (refused > 0) say(`${refused} lesson(s) of lessons.md left out: each holds something the tuner may not carry (T2, I-6)`);
  return { lessons: chosen.map((l) => ({ cue: l.cue, lesson: l.lesson, evidence: l.evidence })), shown: chosen.map((l) => l.run) };
}

/**
 * The three parts of a round that S21.7's controls replace, one at a time, to prove each control can fail: the
 * selection rule, the mission builder and the leak guard. A real round passes none of them.
 */
export interface TuneParts {
  readonly select?: typeof selectByRule;
  readonly mission?: (dimension: Dimension, base: Soul, evidence: ReturnType<typeof evidenceFrom>, sources: LeakSources, lessons?: readonly Lesson[]) => string;
  readonly guard?: Guard;
  /** S21.7: rewrites the reflection's mission before the guard sees it; a sabotaged twin leaks through it. A real round passes none. */
  readonly reflection?: (mission: string, sources: LeakSources) => string;
}

/** One round. See the file header; `dryRun` builds and checks the missions and calls no model. */
export async function runTune(ctx: TuneContext, deps: TuneDeps, dryRun: boolean, parts: TuneParts = {}): Promise<TuneOutcome> {
  const select = parts.select ?? selectByRule;
  const guard = parts.guard ?? relaxedGuard;
  const build = parts.mission ?? ((d: Dimension, b: Soul, e: ReturnType<typeof evidenceFrom>, s: LeakSources, l?: readonly Lesson[]) => missionFor(d, b, e, s, guard, l));
  const started = deps.now();
  const runId = newTuneRunId(started);
  const checked = await preflight(ctx, deps, dryRun);
  if (!checked.ok) return { kind: "refused", reasons: checked.reasons };
  const { pre } = checked;
  const sources = leakSources(ctx.tasks);
  const stopped = (where: string): TuneOutcome => ({ kind: "stopped", where });

  if (dryRun) {
    const recorded = await deps.recordedBase();
    const train = ctx.tasks.filter((t) => t.split === "train");
    const evidence = recorded !== null ? evidenceFrom(ctx.tasks, recorded.results) : { failures: train.map((t) => ({ id: t.id, kind: t.kind, ask: t.ask, answer: PLACEHOLDER, attempts: ctx.repeat * 2, passed: 0 })), passes: [] };
    try {
      const { lessons } = await lessonsFor(ctx, evidence.failures.map((f) => f.ask), sources, pre.personText, deps.say);
      return { kind: "dry-run", illustrative: recorded === null, missions: DIMENSIONS.map((dimension) => ({ dimension, mission: missionFor(dimension, pre.soul, evidence, sources, relaxedGuard, lessons) })) };
    } catch (cause) {
      return { kind: "refused", reasons: [cause instanceof Error ? cause.message : String(cause)] };
    }
  }

  if (await deps.stopped()) return stopped("before the base run");
  deps.say(`base run: ${ctx.tasks.length} task(s) × 2 modes × ${ctx.repeat}`);
  const base = await deps.evalBase();
  if (await deps.stopped()) return stopped("after the base run");

  // 2. The proposer, one call per dimension (plus one retry), on train failures alone.
  const evidence = evidenceFrom(ctx.tasks, base.results);
  const { lessons, shown } = await lessonsFor(ctx, evidence.failures.map((f) => f.ask), sources, pre.personText, deps.say);
  if (shown.length > 0) deps.say(`lessons shown to the proposers: ${shown.join(", ")}`);
  const proposals: ProposerOutcome[] = [];
  for (const dimension of DIMENSIONS) {
    if (evidence.failures.length === 0) {
      proposals.push({ outcome: "keep-base", dimension, reason: "no train task failed in the base run: there is nothing to learn from", tries: 0 });
      continue;
    }
    let mission: string;
    try {
      mission = build(dimension, pre.soul, evidence, sources, lessons);
    } catch (cause) {
      return { kind: "refused", reasons: [cause instanceof Error ? cause.message : String(cause)] };
    }
    deps.say(`proposer ${dimension}: ${evidence.failures.length} train failure(s)`);
    let leak: unknown;
    const proposal = await askProposer({
      dimension,
      mission,
      roleText: pre.roleText,
      personText: pre.personText,
      subject: ctx.subject,
      base: pre.soul,
      sources,
      guard,
      ask: (prompt, attempt) => deps.propose(prompt, dimension, attempt),
      stopped: deps.stopped,
    }).catch((cause: unknown) => {
      leak = cause;
      return null;
    });
    if (leak !== undefined) return { kind: "refused", reasons: [leak instanceof Error ? leak.message : String(leak)] };
    if (proposal === null) return stopped(`during the ${dimension} proposal`);
    proposals.push(proposal);
  }

  // 3. Candidates are branches, made from the base's tree without touching the working tree.
  const identity = agentIdentity(pre.soul);
  const created: { readonly name: string; readonly commit: string }[] = [];
  const abort = async (where: string): Promise<TuneOutcome> => {
    for (const c of created) await deleteBranch(ctx.soulDir, c.name, c.commit);
    return stopped(where);
  };
  try {
    const made = new Map<Dimension, { readonly branch: string; readonly commit: string; readonly body: string }>();
    for (const p of proposals) {
      if (p.outcome !== "edit") continue;
      if (await deps.stopped()) return abort("before making the candidate branches");
      const blob = await writeBlob(ctx.soulDir, ctx.stateRoot, p.text);
      const message = `tune candidate ${p.dimension} of ${runId}\n\nA candidate role.md body from the harness tuner. It is a branch, not adopted.\n\nMind-Tune-Run: ${runId}\nMind-Tune-Base: ${pre.repo.head}\n`;
      const commit = await commitWithBlob({ cwd: ctx.soulDir, stateRoot: ctx.stateRoot, parent: pre.repo.head, path: pre.rolePath, blob, message, author: identity, at: started, env: ctx.env });
      const touched = await changedPaths(ctx.soulDir, pre.repo.head, commit);
      if (touched.length !== 1 || touched[0] !== pre.rolePath) throw new Error(`candidate ${p.dimension} changes ${touched.join(", ")}: only ${pre.rolePath} may differ (T4)`);
      const name = `tune/${runId}-${lower(p.dimension)}`;
      await createBranch(ctx.soulDir, name, commit);
      created.push({ name, commit });
      made.set(p.dimension, { branch: name, commit, body: p.body });
    }
  
    // 4. Probe each candidate on the same tasks, then judge it (T6 + the small-set rule).
    const candidates: TuneCandidate[] = [];
    const runs = new Map<Dimension, EvalRunRecord>();
    const diffs: Record<string, string> = {};
    for (const p of proposals) {
      const branch = made.get(p.dimension);
      if (p.outcome !== "edit" || branch === undefined) {
        candidates.push({ dimension: p.dimension, outcome: "keep-base", reason: p.outcome === "keep-base" ? p.reason : "", tries: p.tries, branch: null, commit: null, runId: null, train: null, heldout: null, changes: [], selection: null, verdict: "keep-base", why: "the proposer kept the base" });
        continue;
      }
      if (await deps.stopped()) return abort(`before probing ${p.dimension}`);
      deps.say(`probe ${p.dimension}: ${branch.branch}`);
      const run = await deps.evalCandidate(branch.branch, base);
      runs.set(p.dimension, run);
      if (await deps.stopped()) return abort(`after probing ${p.dimension}`);
      const { rows, bySplit } = compareSides(base, run);
      const selection = select(base, run);
      const small = selection.heldout.tasks < MIN_HELDOUT;
      const verdict = selection.verdict === "adopt" && !small ? "adopt" : "keep-base";
      candidates.push({
        dimension: p.dimension,
        outcome: "edit",
        reason: p.notes,
        tries: p.tries,
        branch: branch.branch,
        commit: branch.commit,
        runId: run.runId,
        train: bySplit.find((s) => s.split === "train") ?? null,
        heldout: bySplit.find((s) => s.split === "heldout") ?? null,
        changes: rows.filter((r) => r.change !== "same"),
        selection: { verdict: selection.verdict, reason: selection.reason },
        verdict,
        why: selection.verdict === "adopt" && small ? `forced keep-base: the held-out set has ${selection.heldout.tasks} task(s), fewer than ${MIN_HELDOUT}, too few to judge on (${selection.reason})` : selection.reason,
      });
      diffs[p.dimension] = unifiedDiff(pre.soul.role.body, branch.body, { beforeLabel: "role.md body (base)", afterLabel: `role.md body (${p.dimension})` });
    }
  
    // 5. One winner or none: the larger held-out gain; a tie is no winner.
    const gain = (c: TuneCandidate) => (c.heldout === null ? 0 : c.heldout.delta);
    const adopters = candidates.filter((c) => c.verdict === "adopt");
    const best = Math.max(0, ...adopters.map(gain));
    const top = adopters.filter((c) => gain(c) === best);
    const winner = top.length === 1 ? top[0]! : null;
    const verdict: TuneRunRecord["verdict"] =
      winner !== null
        ? { winner: winner.dimension, reason: adopters.length === 2 ? `${winner.dimension} passes T6 with the larger held-out gain (+${gain(winner)} points)` : `${winner.dimension} passes T6: ${winner.why}` }
        : { winner: null, reason: adopters.length === 0 ? "KEEP_BASE: no candidate passes T6" : `KEEP_BASE: ${adopters.map((c) => c.dimension).join(" and ")} pass T6 with the same held-out gain (+${best} points), and a tie keeps the base` };
  
    // 6. Reflection (S21.6): what each edit did, and at most one lesson for the owner. The verdict above is final.
    if (await deps.stopped()) return abort("before the reflection");
    const known = new Set<string>((await readDecisions(ctx.runsDir)).filter((d) => d.outcome === "refused").map((d) => d.key));
    const accepted = await readLessons(agentRootOf(ctx));
    if (accepted.ok) for (const l of accepted.entries) known.add(lessonKey(l));
    deps.say("reflection: verdict rows and at most one lesson");
    const reflection = await reflectOnRound({
      soul: pre.soul,
      tasks: ctx.tasks,
      repeat: ctx.repeat,
      base,
      candidates: proposals.map((p) => ({ dimension: p.dimension, proposal: p, run: runs.get(p.dimension) ?? null })),
      sources,
      personText: pre.personText,
      known,
      ask: deps.reflect,
      stopped: deps.stopped,
      guard,
      ...(parts.reflection === undefined ? {} : { rewrite: parts.reflection }),
    });
    if (reflection === null) return abort("during the reflection");

    if (await deps.stopped()) return abort("before writing the record");
    const split = (name: "train" | "heldout") => base.report.bySplit.find((s) => s.split === name);
    const record: TuneRunRecord = {
      schema: TUNE_SCHEMA,
      runId,
      startedAt: started.toISOString(),
      finishedAt: deps.now().toISOString(),
      subject: ctx.subject,
      engine: `mind@${VERSION}`,
      prompts: PROMPTS_VERSION,
      backend: ctx.backend,
      model: ctx.model,
      repeat: ctx.repeat,
      base: { commit: pre.repo.head, runId: base.runId, soulTree: base.soul.gitTree, evalsSha256: sha256(ctx.setText), train: split("train")?.percent ?? 0, heldout: split("heldout")?.percent ?? 0, heldoutTasks: split("heldout")?.tasks ?? 0 },
      candidates,
      verdict,
      cost: await deps.cost(started),
      lessonsShown: shown,
      reflection,
      adopted: null,
    };
    const path = await writeTuneRun(ctx.runsDir, record);
    return { kind: "done", record, path, diffs };
  } catch (cause) {
    for (const c of created) await deleteBranch(ctx.soulDir, c.name, c.commit);
    throw cause;
  }
}

/** Write a tune record: the directory 0700, the file 0600, whole or not at all. */
export async function writeTuneRun(dir: string, record: TuneRunRecord): Promise<string> {
  if (!isTuneRunId(record.runId)) throw new Error(`not a tune run id: ${JSON.stringify(record.runId)}`);
  await privateDir(join(dir, ".."));
  await privateDir(dir);
  const path = join(dir, `${record.runId}.json`);
  await replaceFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** A tune record by id, or why it cannot be read. */
export async function readTuneRun(dir: string, runId: string): Promise<{ readonly ok: true; readonly record: TuneRunRecord } | { readonly ok: false; readonly reason: string }> {
  if (!isTuneRunId(runId)) return { ok: false, reason: `${JSON.stringify(runId)} is not a tune run id (tn-<time>-<4 hex>)` };
  try {
    const parsed = JSON.parse(await Bun.file(join(dir, `${runId}.json`)).text()) as Partial<TuneRunRecord>;
    if (parsed.schema !== TUNE_SCHEMA || parsed.runId !== runId || !Array.isArray(parsed.candidates) || typeof parsed.base !== "object" || parsed.base === null) return { ok: false, reason: `${runId}.json is not a tune run record (${TUNE_SCHEMA})` };
    return { ok: true, record: parsed as TuneRunRecord };
  } catch {
    return { ok: false, reason: `no readable tune run ${runId} in ${dir}` };
  }
}

/** Does this branch still name the commit the record says (for the adopt path, and for tests)? */
export async function branchIntact(cwd: string, c: TuneCandidate): Promise<boolean> {
  return c.branch !== null && c.commit !== null && (await branchCommit(cwd, c.branch)) === c.commit;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n === 0 ? "±0" : String(n));

/** The round as a person reads it: per candidate the deltas, the flips, the verdict and the body diff; then the winner and the cost. */
export function tuneLines(record: TuneRunRecord, diffs: Readonly<Record<string, string>>, { bold, dim }: Style): string[] {
  const out = [bold(`\n${record.runId} — harness tuning of ${record.subject}, ${record.engine}, each task × 2 modes × ${record.repeat}`)];
  out.push(`  base       ${record.base.commit.slice(0, 8)}  run ${record.base.runId}  train ${record.base.train}%  held-out ${record.base.heldout}% (${record.base.heldoutTasks} task(s))`);
  for (const c of record.candidates) {
    out.push(bold(`\n${c.dimension} — ${c.outcome === "keep-base" ? "KEEP_BASE" : c.branch}${c.tries > 1 ? ` (second try)` : ""}`));
    if (c.outcome === "keep-base") {
      out.push(`  the proposer kept the base${c.reason === "" ? "" : `: ${c.reason.split("\n")[0]!.slice(0, 200)}`}`);
      continue;
    }
    const d = (s: SplitDelta | null) => (s === null || s.tasks === 0 ? "—" : `${s.base}% → ${s.candidate}% (${signed(s.delta)})`);
    out.push(`  train      ${d(c.train)}`);
    out.push(`  held-out   ${d(c.heldout)}`);
    out.push(`  run ${c.runId}, ${c.changes.length} task × mode change(s)`);
    for (const r of c.changes) out.push(`    ${r.task.padEnd(24)} ${r.mode.padEnd(9)} ${r.split.padEnd(8)} ${r.change}`);
    out.push(`  verdict    ${c.verdict} — ${c.why}`);
    const diff = diffs[c.dimension];
    if (diff !== undefined && diff !== "") out.push("", ...diff.split("\n").map((l) => `  ${l}`));
  }
  const w = record.verdict.winner;
  out.push(bold(`\nverdict: ${w === null ? "KEEP_BASE" : `adopt ${w}`} — ${record.verdict.reason}`));
  const reflection = record.reflection;
  if (reflection !== undefined) {
    out.push(bold("\nreflection"));
    if (reflection.status !== "done") out.push(`  ${reflection.status}: ${reflection.reason}`);
    for (const r of reflection.rows) out.push(`  row ${r.row}  ${r.verdict.padEnd(18)} ${r.candidates.join(", ")}: ${r.passage.slice(0, 100)}`);
    if (reflection.status === "done" && reflection.rows.length === 0) out.push("  no edited passage to say anything about");
    if (reflection.lesson !== null) {
      out.push(`  proposed lesson — cue: ${reflection.lesson.cue}`, `                   lesson: ${reflection.lesson.lesson}`, dim(`  It is only a proposal: mind soul tune lessons accept ${record.runId} <dir> --subject ${record.subject}`));
    } else if (reflection.status === "done" && reflection.reason !== "") out.push(`  no lesson: ${reflection.reason}`);
  }
  const cost = record.cost;
  out.push(`cost: ${cost.turns} turn(s) in the ledger, ${cost.tokens} token(s)${cost.tokensUnknown > 0 ? ` at least (${cost.tokensUnknown} turn(s) printed none)` : ""}`);
  out.push(dim(`Candidates are branches of the agent repository; the working tree and HEAD were not touched. ${w === null ? "Delete them with git branch -D when you are done." : `To adopt: mind soul tune adopt ${record.runId} (refused until the tuner is proved, S21.7).`}`));
  return out;
}

/** The two missions of a dry run, as printed. */
export function dryRunLines(outcome: Extract<TuneOutcome, { kind: "dry-run" }>, { bold, dim }: Style): string[] {
  const out: string[] = [];
  for (const m of outcome.missions) {
    out.push(bold(`\n=== ${m.dimension} mission — ${[...m.mission].length} characters ===`), m.mission);
  }
  out.push(bold("\nleak guard: passed — no expect or reject phrase outside the fenced evidence, no held-out ask anywhere"));
  out.push(dim(outcome.illustrative ? "Evidence is illustrative: no recorded run with kept answers matches this soul and task set. No model was called, nothing was written." : "Evidence is from the newest recorded run of this soul and task set. No model was called, nothing was written."));
  return out;
}
