/**
 * `mind soul tune <dir> --subject <id>` — one round of harness tuning (S21.5, D-193), and its adopt and undo.
 *
 * The command is the engine's side of `src/soul/tune/round.ts`: it hands the round the ways to reach a model
 * and the ledger, and prints what the round found. Every model call is a child `mind turn` or `mind eval`
 * through the same guarded spawn the rest of Mind uses, so the egress notice, the ledger, the fence and the
 * brake apply to the proposer exactly as to a typed message (the proposer turn is held at level 1, takes no
 * recall and no proposals). A proposer mission carries the agent's own answers, so it goes to the child in a
 * private file under the state root (`--prompt-file`), not on the command line, and the file is removed after.
 *
 * The cost line counts what `mind ledger show --json` reports from the round's start; the ledger is read by that command, the
 * one declared reader (D-022), not here.
 *
 * `--selftest` (S21.7, D-195) runs the tuner's four controls and their sabotaged twins on a throwaway agent and
 * writes the proof that opens `adopt`; `proof` says whether this build has one. Nothing else here adopts anything.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isatty } from "node:tty";
import { basename, join, resolve } from "node:path";
import { AUTONOMY_MAX_ENV } from "../../src/decide/effective.ts";
import { isStopped } from "../../src/decide/stop.ts";
import { triggeredCeiling } from "../../src/decide/triggers.ts";
import { engineCommand } from "../../src/guard/hooks.ts";
import { readMind } from "../../src/env.ts";
import { listEvalRuns, evalRunsDir, parseRepeat, readEvalRun, sha256, soulContentSha, soulFiles, type EvalRunRecord } from "../../src/soul/eval-runs.ts";
import { EVALS_FILE, parseEvals } from "../../src/soul/evals.ts";
import { resolveSoulDir } from "../../src/soul/load.ts";
import { adoptRun, undoLast, type AdoptEnv } from "../../src/soul/tune/adopt.ts";
import { acceptLesson, lessonLines, listProposed, rejectLesson, type LessonEnv } from "../../src/soul/tune/lesson-ops.ts";
import { checkProof, engineIdentity, proofLines, writeProof } from "../../src/soul/tune/proof.ts";
import { proofOf, runSelftest, selftestLines } from "../../src/soul/tune/selftest.ts";
import { costOf, dryRunLines, runTune, tuneLines, usableBase, type TuneContext, type TuneDeps } from "../../src/soul/tune/round.ts";
import { STATE_DIR_MODE, stateRoot } from "../../src/state.ts";
import { runGuarded } from "../../src/spawn.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { bold, dim, ENGINE_CHECKOUT, parseArgs, readPhrase, report, usageError } from "../shared.ts";

const USAGE = "usage: mind soul tune <dir> --subject <id> [--repeat <k>] [--backend <b>] [--model <m>] [--dry-run]";
const ADOPT_USAGE = "usage: mind soul tune adopt <runId> <dir> --subject <id>";
const UNDO_USAGE = "usage: mind soul tune undo <dir> --subject <id>";
const SELFTEST_USAGE = "usage: mind soul tune --selftest [--subject <id>]";
const PROOF_USAGE = "usage: mind soul tune proof --subject <id>";
const LESSONS_USAGE = "usage: mind soul tune lessons --subject <id> [--all]\n       mind soul tune lessons accept <runId> <dir> --subject <id>\n       mind soul tune lessons reject <runId> --subject <id>";

function subjectOf(raw: string | undefined): { readonly ok: true; readonly id: SubjectId } | { readonly ok: false; readonly reason: string } {
  if (raw === undefined || raw === "") return { ok: false, reason: "--subject is required" };
  try {
    return { ok: true, id: subjectId(raw) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function adoptEnv(dir: string, id: SubjectId): Promise<AdoptEnv | { readonly problem: string }> {
  const runs = await evalRunsDir({ home: homedir(), env: process.env }, id);
  if (!runs.ok) return { problem: runs.reason };
  return { subject: id, soulDir: await resolveSoulDir(resolve(dir)), runsDir: runs.path, stateRoot: stateRoot(homedir(), process.env), env: process.env, engine: await engineIdentity(ENGINE_CHECKOUT), stopped: () => isStopped({ home: homedir(), env: process.env }), now: () => new Date() };
}

async function cmdAdopt(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, []);
  const [runId, dir] = positional;
  const who = subjectOf(options.get("subject"));
  if (runId === undefined || dir === undefined || positional.length > 2 || !who.ok) return usageError(who.ok ? ADOPT_USAGE : `${ADOPT_USAGE}\n${who.reason}`);
  const env = await adoptEnv(dir, who.id);
  if ("problem" in env) {
    console.error(`mind: ${env.problem}`);
    return 1;
  }
  const done = await adoptRun(env, runId);
  if (!done.ok) {
    console.error(`mind: not adopted: ${done.reason}.`);
    return 1;
  }
  for (const line of done.notice) console.log(line);
  return 0;
}

async function cmdUndo(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, []);
  const who = subjectOf(options.get("subject"));
  if (positional.length !== 1 || !who.ok) return usageError(who.ok ? UNDO_USAGE : `${UNDO_USAGE}\n${who.reason}`);
  const env = await adoptEnv(positional[0]!, who.id);
  if ("problem" in env) {
    console.error(`mind: ${env.problem}`);
    return 1;
  }
  const done = await undoLast(env);
  if (!done.ok) {
    console.error(`mind: not undone: ${done.reason}.`);
    return 1;
  }
  for (const line of done.notice) console.log(line);
  return 0;
}

/** `mind soul tune proof --subject <id>`: is there a valid proof for this build, and if not, why not. */
async function cmdProof(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, []);
  const who = subjectOf(options.get("subject"));
  if (positional.length > 0 || !who.ok) return usageError(who.ok ? PROOF_USAGE : `${PROOF_USAGE}\n${who.reason}`);
  const runs = await evalRunsDir({ home: homedir(), env: process.env }, who.id);
  if (!runs.ok) {
    console.error(`mind: ${runs.reason}`);
    return 1;
  }
  const engine = await engineIdentity(ENGINE_CHECKOUT);
  const state = await checkProof(runs.path, engine);
  for (const line of proofLines(state, engine)) console.log(line);
  return state.ok ? 0 : 1;
}

/** `mind soul tune --selftest [--subject <id>]`: the four controls and their twins on a throwaway agent; the proof is written only when all behave, and only with a subject to write it for. */
async function cmdSelftest(positional: readonly string[], subject: string | undefined): Promise<number> {
  const who = subject === undefined ? null : subjectOf(subject);
  if (positional.length > 0 || (who !== null && !who.ok)) return usageError(who !== null && !who.ok ? `${SELFTEST_USAGE}\n${who.reason}` : SELFTEST_USAGE);
  const engine = await engineIdentity(ENGINE_CHECKOUT);
  const outcome = await runSelftest({ stateRoot: stateRoot(homedir(), process.env), env: process.env, now: () => new Date() });
  for (const line of selftestLines(outcome)) console.log(line);
  if (!outcome.ok) {
    console.error("mind: the selftest did not come out as required: no proof written, adopt stays shut.");
    return 1;
  }
  if (who === null) {
    console.log(dim("No --subject: nothing written. Add --subject <id> to write the proof that opens adopt for that agent."));
    return 0;
  }
  const proof = proofOf(outcome, engine, new Date());
  const runs = await evalRunsDir({ home: homedir(), env: process.env }, who.id as SubjectId);
  if (proof === null || !runs.ok) {
    console.error(`mind: no proof written: ${proof === null ? "this build has no source checkout to bind a proof to" : runs.ok ? "" : runs.reason}.`);
    return 1;
  }
  console.log(`Proof written to ${await writeProof(runs.path, proof)}, bound to mind ${engine.version}${engine.gitSha === null ? "" : ` @${engine.gitSha.slice(0, 8)}`} and the tuner's source ${engine.sourceSha256?.slice(0, 12)}. Changing the tuner voids it.`);
  return 0;
}

/**
 * `mind soul tune lessons`: what the reflection proposed (S21.6, D-196). Listing writes nothing. `accept` and `reject`
 * are the owner's, at a terminal; `accept` appends to `<dir>/lessons.md` and does not commit it.
 */
async function cmdLessons(argv: readonly string[]): Promise<number> {
  const action = argv[0] === "accept" || argv[0] === "reject" ? argv[0] : null;
  const { positional, options } = parseArgs(action === null ? argv : argv.slice(1), ["all"]);
  const who = subjectOf(options.get("subject"));
  if (!who.ok) return usageError(`${LESSONS_USAGE}\n${who.reason}`);
  const runs = await evalRunsDir({ home: homedir(), env: process.env }, who.id);
  if (!runs.ok) {
    console.error(`mind: ${runs.reason}`);
    return 1;
  }
  if (action === null) {
    if (positional.length > 1) return usageError(LESSONS_USAGE);
    for (const line of lessonLines(await listProposed(runs.path), { bold, dim }, options.has("all"))) console.log(line);
    return 0;
  }
  const [runId, dir] = positional;
  if (runId === undefined || positional.length > (action === "accept" ? 2 : 1) || (action === "accept" && dir === undefined)) return usageError(LESSONS_USAGE);
  const agentDir = resolve(dir ?? ".");
  const env: LessonEnv = {
    agentDir,
    runsDir: runs.path,
    interactive: process.stdin.isTTY === true && isatty(1),
    confirm: async (entry) => {
      console.error(`Adding to ${join(agentDir, "lessons.md")}:\n  cue:      ${entry.cue}\n  lesson:   ${entry.lesson}\n  evidence: ${entry.evidence}\n\nIt will be indexed by recall and shown to the next tune round's proposers when its cue matches. Mind will not commit it.\nType yes to add it:`);
      return (await readPhrase()).toLowerCase() === "yes";
    },
    now: () => new Date(),
  };
  let done: Awaited<ReturnType<typeof rejectLesson>>;
  if (action === "reject") done = await rejectLesson(env, runId);
  else {
    const parsed = parseEvals(EVALS_FILE, await readFile(join(agentDir, EVALS_FILE), "utf8").catch(() => ""));
    if (!parsed.ok) {
      console.error(`mind: the task set at ${join(agentDir, EVALS_FILE)} cannot be read, and a lesson is checked against it before it is kept.`);
      return 1;
    }
    const soulDir = await resolveSoulDir(agentDir);
    done = await acceptLesson(env, runId, parsed.value, await readFile(join(soulDir, "person.md"), "utf8").catch(() => ""));
  }
  if (!done.ok) {
    console.error(`mind: ${done.reason}.`);
    return 1;
  }
  for (const line of done.notice) console.log(line);
  return 0;
}

export async function cmdTune(argv: readonly string[]): Promise<number> {
  if (argv[0] === "adopt") return cmdAdopt(argv.slice(1));
  if (argv[0] === "undo") return cmdUndo(argv.slice(1));
  if (argv[0] === "proof") return cmdProof(argv.slice(1));
  if (argv[0] === "lessons") return cmdLessons(argv.slice(1));
  const { positional, options } = parseArgs(argv, ["dry-run", "selftest"]);
  if (options.has("selftest")) return cmdSelftest(positional, options.get("subject"));
  const dir = positional[0];
  const who = subjectOf(options.get("subject"));
  if (dir === undefined || positional.length > 1 || !who.ok) return usageError(who.ok ? USAGE : `${USAGE}\n${who.reason}`);
  const id = who.id;
  const repeat = parseRepeat(options.get("repeat"));
  if (!repeat.ok) return usageError(`${USAGE}\n${repeat.reason}`);
  const dryRun = options.has("dry-run");

  const setFile = Bun.file(join(dir, EVALS_FILE));
  if (!(await setFile.exists())) {
    console.error(`mind: no task set at ${join(dir, EVALS_FILE)}: a tune judges candidates on it.`);
    return 1;
  }
  const setText = await setFile.text();
  const parsed = parseEvals(EVALS_FILE, setText);
  if (!parsed.ok) return report(parsed.issues);
  const runs = await evalRunsDir({ home: homedir(), env: process.env }, id);
  if (!runs.ok) {
    console.error(`mind: ${runs.reason}`);
    return 1;
  }

  const soulDir = await resolveSoulDir(resolve(dir));
  const flags = ["backend", "model"].flatMap((name) => {
    const value = options.get(name);
    return value === undefined || value === "" ? [] : [`--${name}`, value];
  });
  const env = { ...process.env, [AUTONOMY_MAX_ENV]: triggeredCeiling(readMind(AUTONOMY_MAX_ENV, process.env)), MIND_NO_UPDATE_CHECK: "1" };
  const root = stateRoot(homedir(), process.env);
  const child = (args: readonly string[]) => runGuarded([...engineCommand().argv, ...args], { env });
  const subjectArgs = ["--subject", id];

  const recordFrom = async (path: unknown): Promise<EvalRunRecord> => {
    const runId = typeof path === "string" ? basename(path, ".json") : "";
    const read = await readEvalRun(runs.path, runId);
    if (!read.ok) throw new Error(read.reason);
    return read.run;
  };
  const json = (bytes: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

  /** One proposer or reflection prompt, through `mind turn` on the agent's own backend: level 1, no recall, no proposals. */
  const askModel = async (prompt: string): Promise<string> => {
    const scratch = join(root, "scratch", "tune");
    await mkdir(scratch, { recursive: true, mode: STATE_DIR_MODE });
    const temp = await mkdtemp(join(scratch, "mission-"));
    try {
      const file = join(temp, "mission.md");
      await writeFile(file, prompt, { mode: 0o600 });
      const run = await child(["turn", resolve(dir), ...subjectArgs, "--prompt-file", file, "--json", "--no-proposals", "--no-recall", ...flags]);
      let text: unknown;
      try {
        text = json(run.stdout)["text"];
      } catch {
        text = undefined;
      }
      if (typeof text !== "string" || text === "") throw new Error(`the proposer's turn gave no answer (exit ${run.code})`);
      return text;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  };

  const deps: TuneDeps = {
    stopped: () => isStopped({ home: homedir(), env: process.env }),
    propose: (prompt) => askModel(prompt),
    reflect: (prompt) => askModel(prompt),
    evalBase: async () => {
      const run = await child(["eval", resolve(dir), ...subjectArgs, "--repeat", String(repeat.value), "--keep-answers", "--json", ...flags]);
      if (run.code !== 0) throw new Error(`the base run failed (exit ${run.code}): ${run.stderr.split("\n").at(-1) ?? ""}`);
      return recordFrom(json(run.stdout)["record"]);
    },
    evalCandidate: async (ref, base) => {
      const run = await child(["eval", resolve(dir), ...subjectArgs, "--repeat", String(repeat.value), "--compare", ref, "--base-run", base.runId, "--keep-answers", "--json", ...flags]);
      if (run.code !== 0) throw new Error(`the probe of ${ref} failed (exit ${run.code}): ${run.stderr.split("\n").at(-1) ?? ""}`);
      return recordFrom((json(run.stdout)["candidate"] as { record?: unknown } | undefined)?.record);
    },
    // The ledger is read by its own command (`mind ledger show`), the one declared reader (D-022); here it is only counted.
    cost: async (since) => {
      const run = await child(["ledger", "show", ...subjectArgs, "--since", since.toISOString(), "--json"]);
      try {
        return costOf((json(run.stdout)["entries"] as Parameters<typeof costOf>[0]) ?? []);
      } catch {
        console.error(dim("tune: the ledger could not be read for the cost; the cost line is empty"));
        return { turns: 0, tokens: 0, tokensUnknown: 0 };
      }
    },
    recordedBase: async () => {
      const files = await soulFiles(soulDir);
      return usableBase((await listEvalRuns(runs.path)).runs, sha256(setText), await soulContentSha(soulDir, files));
    },
    now: () => new Date(),
    say: (line) => console.error(dim(`tune: ${line}`)),
  };
  const ctx: TuneContext = { subject: id, soulDir, agentDir: resolve(dir), tasks: parsed.value, setText, repeat: repeat.value, backend: options.get("backend") || null, model: options.get("model") || null, stateRoot: root, runsDir: runs.path, env: process.env };

  let outcome: Awaited<ReturnType<typeof runTune>>;
  try {
    outcome = await runTune(ctx, deps, dryRun);
  } catch (cause) {
    console.error(`mind: the tune stopped on an error: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  switch (outcome.kind) {
    case "refused":
      console.error("mind: will not tune:");
      for (const reason of outcome.reasons) console.error(`  - ${reason}`);
      return 1;
    case "stopped":
      console.error(`mind: the brake is on: the round ended ${outcome.where}. No branch, commit or tune record was left.`);
      return 1;
    case "dry-run":
      for (const line of dryRunLines(outcome, { bold, dim })) console.log(line);
      return 0;
    case "done":
      for (const line of tuneLines(outcome.record, outcome.diffs, { bold, dim })) console.log(line);
      console.log(dim(`Recorded as ${outcome.path}.`));
      return 0;
  }
}
