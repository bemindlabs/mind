/**
 * S21.5 test support: an agent repository, a task set with a train and a held-out side, a fake evaluator that
 * grades by what the role body says, and a scripted proposer. No model, no network.
 *
 * The fake agent answers `ok-<id>` to a task exactly when the role body it is wearing holds `RULE-<id>`, so a
 * candidate's effect on any task is a fact of its text. The base body holds RULE-t5 and RULE-h3.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalRunRecord, repeatedReport, runAttempts, sha256, type EvalRunRecord } from "../../src/soul/eval-runs.ts";
import type { EvalTask } from "../../src/soul/evals.ts";
import { BODY_CLOSE, BODY_OPEN } from "../../src/soul/tune/prompts.ts";
import { blobAt } from "../../src/soul/tune/git.ts";
import type { TuneContext, TuneCost, TuneDeps } from "../../src/soul/tune/round.ts";
import { subjectId } from "../../src/types.ts";

export const SOUL = join(import.meta.dir, "..", "fixtures", "soul-valid");
export const PERSON_MARK = "PERSON-MARK-7f3a";
export const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Owner Person", GIT_AUTHOR_EMAIL: "owner@example.test", GIT_COMMITTER_NAME: "Owner Person", GIT_COMMITTER_EMAIL: "owner@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export async function g(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: GIT_ENV });
  const out = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(child.stderr).text()}`);
  return out.trim();
}

export const task = (id: string, split: "train" | "heldout", extra: Partial<EvalTask> = {}): EvalTask => ({ id, kind: "ports", ask: `Question ${id}?`, expect: [`ok-${id}`], reject: [`bad-${id}`], source: "", split, ...extra });

export const TRAIN = ["t1", "t2", "t3", "t4", "t5"];
export const HELD = ["h1", "h2", "h3", "h4", "h5", "h6"];
export const tasksOf = (heldout: readonly string[] = HELD): EvalTask[] => [...TRAIN.map((id) => task(id, "train")), ...heldout.map((id) => task(id, "heldout"))];

export interface Fixture {
  readonly home: string;
  readonly agent: string;
  readonly soulDir: string;
  readonly state: string;
  readonly runs: string;
  readonly head: string;
  readonly baseRole: string;
  readonly subject: ReturnType<typeof subjectId>;
  readonly cleanup: () => Promise<void>;
}

/** An agent repository with one commit: the fixture soul, its role body holding RULE-t5 and RULE-h3, and a marked person.md. */
export async function makeFixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), "mind-tune-"));
  const agent = join(home, "agent");
  await cp(SOUL, join(agent, "soul"), { recursive: true });
  const rolePath = join(agent, "soul", "role.md");
  await writeFile(rolePath, `${await readFile(rolePath, "utf8")}\nKnown: RULE-t5 RULE-h3\n`);
  const personPath = join(agent, "soul", "person.md");
  await writeFile(personPath, `${await readFile(personPath, "utf8")}\n${PERSON_MARK}\n`);
  await writeFile(join(agent, "soul", "autonomy.md"), "autonomy: unchanged\n");
  await writeFile(join(agent, ".gitignore"), "/.mind/\n");
  await g(agent, "init", "-q");
  await g(agent, "add", "-A");
  await g(agent, "commit", "-q", "-m", "the soul");
  await mkdir(join(home, "state"), { recursive: true });
  return { home, agent, soulDir: join(agent, "soul"), state: join(home, "state"), runs: join(home, "data", "evals"), head: await g(agent, "rev-parse", "HEAD"), baseRole: await readFile(rolePath, "utf8"), subject: subjectId("example"), cleanup: () => rm(home, { recursive: true, force: true }) };
}

export function contextOf(fx: Fixture, tasks: readonly EvalTask[] = tasksOf(), repeat = 1): TuneContext {
  return { subject: fx.subject, soulDir: fx.soulDir, tasks, setText: "the task set, as text", repeat, backend: "stub", model: "stub", stateRoot: fx.state, runsDir: fx.runs, env: GIT_ENV };
}

/** The role body with these rules added: a candidate that answers those tasks right. */
export const withRules = (fx: Fixture, ...rules: string[]): string => `${fx.baseRole.slice(fx.baseRole.indexOf("\n+++\n") + 5)}\nAdded: ${rules.map((r) => `RULE-${r}`).join(" ")}\n`;

export const proposal = (body: string, notes = "answers the failed tasks"): string => `${BODY_OPEN}\n${body.trim()}\n${BODY_CLOSE}\n<notes>\n${notes}\n</notes>`;
export const NO_LESSON_ANSWER = "<verdicts>\n</verdicts>\nNO_LESSON";
export const KEEP = "KEEP_BASE\n<notes>\nthe evidence does not argue for a change\n</notes>";

/** One run of the fake agent, as a recorded run (answers kept when asked). */
export async function fakeRun(roleText: string, tasks: readonly EvalTask[], repeat: number, subject: string, keep: boolean, tree: string | null): Promise<EvalRunRecord> {
  const rows = await runAttempts(tasks, repeat, async (t) => ({ answer: roleText.includes(`RULE-${t.id}`) ? `ok-${t.id}` : "nope", route: "stub" }), keep);
  const soul = { gitTree: tree, dirty: false, contentSha256: sha256(roleText), files: ["role.md"] };
  return evalRunRecord({ startedAt: new Date(), subject, soul, setText: "the task set, as text", backend: "stub", model: "stub", recallChars: 0, tasks, split: "all", keptAnswers: keep, results: rows, report: repeatedReport(tasks, rows, repeat) });
}

export interface Script {
  /** What the proposer answers, per dimension and attempt (1-based); default KEEP_BASE. */
  proposer?: (dimension: "INV" | "DOM", attempt: 1 | 2, prompt: string) => string;
  /** What the reflection answers, per attempt (1-based); default: no verdict rows and NO_LESSON. */
  reflector?: (attempt: 1 | 2, prompt: string) => string;
  /** The brake: asked once per `stopped()` call; true from the call numbered `stopAt` (1-based) on. */
  stopAt?: number;
  cost?: TuneCost;
}

export interface Fake {
  readonly deps: TuneDeps;
  readonly prompts: { dimension: string; attempt: number; prompt: string }[];
  /** Every prompt the reflection received. */
  readonly reflections: { attempt: number; prompt: string }[];
  readonly calls: { baseRuns: number; candidateRuns: string[]; stoppedAsked: number };
}

/** The engine's three reaches, faked; the base is HEAD's role.md, a candidate is the role.md on its branch. */
export function fakeDeps(fx: Fixture, tasks: readonly EvalTask[], script: Script = {}, repeat = 1): Fake {
  const prompts: Fake["prompts"] = [];
  const reflections: Fake["reflections"] = [];
  const calls: Fake["calls"] = { baseRuns: 0, candidateRuns: [], stoppedAsked: 0 };
  const deps: TuneDeps = {
    stopped: async () => {
      calls.stoppedAsked += 1;
      return script.stopAt !== undefined && calls.stoppedAsked >= script.stopAt;
    },
    propose: async (prompt, dimension, attempt) => {
      prompts.push({ dimension, attempt, prompt });
      return (script.proposer ?? (() => KEEP))(dimension, attempt, prompt);
    },
    reflect: async (prompt, attempt) => {
      reflections.push({ attempt, prompt });
      return (script.reflector ?? (() => NO_LESSON_ANSWER))(attempt, prompt);
    },
    evalBase: async () => {
      calls.baseRuns += 1;
      return fakeRun(fx.baseRole, tasks, repeat, fx.subject, true, await g(fx.agent, "rev-parse", "HEAD:soul"));
    },
    evalCandidate: async (ref) => {
      calls.candidateRuns.push(ref);
      const role = await blobAt(fx.agent, ref, "soul/role.md");
      return fakeRun(role!.text, tasks, repeat, fx.subject, false, await g(fx.agent, "rev-parse", `${ref}:soul`));
    },
    cost: async () => script.cost ?? { turns: 42, tokens: 1234, tokensUnknown: 0 },
    recordedBase: async () => null,
    now: () => new Date(),
    say: () => undefined,
  };
  return { deps, prompts, reflections, calls };
}

/** HEAD, the index and the working tree, as one comparable string. */
export async function repoState(fx: Fixture): Promise<string> {
  return [await g(fx.agent, "rev-parse", "HEAD"), await g(fx.agent, "symbolic-ref", "HEAD"), await g(fx.agent, "ls-files", "--stage"), await g(fx.agent, "status", "--porcelain"), sha256(await readFile(join(fx.soulDir, "role.md")))].join("\n");
}

export const branches = async (fx: Fixture): Promise<string[]> => (await g(fx.agent, "branch", "--list", "tune/*", "--format=%(refname:short)")).split("\n").filter((l) => l !== "");
