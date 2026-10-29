/**
 * `mind eval <dir> --subject <id>` — run the job's task set and say how much
 * of it the agent does, per configuration and per kind of work (S6.5, D-073).
 *
 * Each task is a real `turn` (held at level 1: a measurement never acts), once
 * with `--no-recall` (the soul alone) and once with recall (soul + RAG). The
 * turns are in the ledger like any other; the grade is recomputed from the
 * answer, never asked of a model.
 *
 * S21.1 (D-189): `--repeat k` answers each task k times per configuration, and
 * every run is recorded in `personal/evals/` with the soul version that
 * answered (`--no-record` skips it); `mind eval runs` lists them.
 *
 * S21.2: `--split train|heldout|all` runs one side of the task set's split,
 * the report gives each side's pass rate, and `mind eval split` proposes a
 * stratified held-out set (written into evals.md only on `--write`).
 *
 * S21.3: `--compare <git-ref>` answers the same tasks with the working tree's
 * soul (base) and the soul at the ref (candidate, written out under the state
 * root), records both runs linked by a compare id, and prints per-task changes,
 * per-split deltas and the T6 verdict; `--compare-runs A B` does the same from
 * two recorded runs. Nothing is adopted (S21.5).
 */

import { readMind } from "../../src/env.ts";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { attachWithin, DEFAULT_RECALL_CHARS, RECALL_HITS } from "../../src/memory/attach.ts";
import { recall } from "../../src/memory/recall.ts";
import { vectorEndpoints } from "../../src/memory/endpoints.ts";
import { resolveSoulDir } from "../../src/soul/load.ts";
import { AUTONOMY_MAX_ENV } from "../../src/decide/effective.ts";
import { triggeredCeiling } from "../../src/decide/triggers.ts";
import { engineCommand } from "../../src/guard/hooks.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { lessonOfHit } from "../../src/soul/lessons.ts";
import { bySplit, EVALS_FILE, grade, MIN_TASKS, parseEvals, parseSplitFilter, type EvalTask } from "../../src/soul/evals.ts";
import { applySplit, DEFAULT_SEED, parseHeldout, proposalLines, proposeSplit } from "../../src/soul/eval-split.ts";
import { compareLines, compareSides, comparable, newCompareId, selectByRule } from "../../src/soul/eval-compare.ts";
import { withSoulAtRef } from "../../src/soul/eval-soul-at.ts";
import { stateRoot } from "../../src/state.ts";
import { attemptLine, EVAL_RUN_SCHEMA, readEvalRun, sha256, soulContentSha, soulFiles, type CompareLink, type SoulVersion, evalRunRecord, evalRunsDir, formatEvalRuns, listEvalRuns, parseRepeat, repeatedReport, reportLines, runAttempts, soulVersion, writeEvalRun } from "../../src/soul/eval-runs.ts";
import { runGuarded, spawnGuarded } from "../../src/spawn.ts";
import { codeLines, codeTable, parseCodeTask, REPO_DIR, runCodeEval, TASK_FILE, type CodeDeps, type CodeTask } from "../../src/eval/code.ts";
import { readTurnJson, tail } from "../../src/task/spawn-turn.ts";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { bold, dim, parseArgs, report, usageError } from "../shared.ts";

const USAGE =
  "usage: mind eval <dir> --subject <id> [--set <file>] [--only <id,…>] [--split train|heldout|all] [--repeat <k>] [--compare <git-ref> [--base-run <runId>]] [--no-record] [--keep-answers] [--recall-only] [--recall-chars <n>] [--backend <b>] [--model <m>] [--json]";

const EVAL_BOOLEANS: readonly string[] = ["json", "recall-only", "no-record", "keep-answers"];

/**
 * `--recall-only`: no model at all. For each task, does the text a turn's
 * recall would attach already hold the answer — every `expect` phrase? A fast,
 * repeatable number for the half of the job that is finding the right note
 * (D-075). The task's `source` is shown, not required: the same fact in
 * another note answers just as well.
 */
async function recallOnly(dir: string, id: SubjectId, tasks: readonly EvalTask[], json: boolean, ceiling: number): Promise<number> {
  const soulDir = await resolveSoulDir(dir);
  const agentDir = soulDir === dir ? dirname(dir) : dir;
  const checked = vectorEndpoints(process.env);
  const rows: { task: string; kind: string; hit: boolean; missing: readonly string[]; attached: readonly string[]; lessons: readonly { cue: string; run: string }[] }[] = [];
  for (const task of tasks) {
    const found = await recall(agentDir, id, task.ask, RECALL_HITS, checked.ok ? checked.endpoints : { reason: checked.reason }, undefined, "any");
    const attachment = attachWithin(found.hits, ceiling);
    const missing = grade({ ...task, reject: [] }, attachment.block).missing;
    // S21.6 (T7): a lesson pulled into the attachment is named as one, with its cue, so its effect on a task stays measurable.
    const taken = new Set(attachment.attached.map((a) => `${a.path}#${a.heading}`));
    const lessons = found.hits.filter((h) => taken.has(`${h.path}#${h.heading}`)).flatMap((h) => lessonOfHit(h) ?? []);
    rows.push({ task: task.id, kind: task.kind, hit: attachment.block !== "" && missing.length === 0, missing, attached: attachment.attached.map((a) => a.path), lessons });
  }
  const hits = rows.filter((r) => r.hit).length;
  const withSource = tasks.length;
  if (json) {
    console.log(JSON.stringify({ hits, tasks: withSource, rows }, null, 2));
    return 0;
  }
  for (const r of rows) {
    console.log(`${r.hit ? "hit " : "MISS"} ${r.task.padEnd(28)} ${r.hit ? "" : dim(`missing ${r.missing.map((m) => JSON.stringify(m)).join(", ")} · attached: ${r.attached.map((a) => a.replace(/^memory\//, "")).join(", ") || "nothing"}`)}`);
    for (const l of r.lessons) console.log(dim(`     lesson pulled: ${JSON.stringify(l.cue.length > 100 ? `${l.cue.slice(0, 99)}…` : l.cue)} (${l.run})`));
  }
  const pulled = rows.filter((r) => r.lessons.length > 0).length;
  if (pulled > 0) console.log(dim(`${pulled} task(s) had a lesson from lessons.md attached (T7)`));
  console.log(bold(`\nrecall attached the answer for ${hits}/${withSource} (${withSource === 0 ? 0 : Math.round((hits / withSource) * 1000) / 10}%) — no model asked`));
  return 0;
}

const RUNS_USAGE = "usage: mind eval runs [<dir>] --subject <id> [--json]";

/** `mind eval runs`: the recorded runs of a subject, newest first. The directory is optional: runs are found by subject. */
async function listRuns(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["json"]);
  const raw = options.get("subject");
  if (positional.length > 1 || raw === undefined || raw === "") return usageError(RUNS_USAGE);
  let id: SubjectId;
  try {
    id = subjectId(raw);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const json = options.has("json");
  const dir = await evalRunsDir({ home: homedir(), env: process.env }, id);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return 1;
  }
  const { runs, unreadable } = await listEvalRuns(dir.path);
  if (json) {
    console.log(JSON.stringify({ dir: dir.path, runs: runs.map(({ results: _, ...rest }) => rest), unreadable }, null, 2));
    return 0;
  }
  if (runs.length === 0) console.log(`No eval runs recorded for ${id} (${dir.path}).`);
  for (const line of formatEvalRuns(runs)) console.log(line);
  for (const name of unreadable) console.error(dim(`mind: ${name} is not an eval run record (${EVAL_RUN_SCHEMA}); left as it is`));
  return 0;
}

const SPLIT_USAGE = "usage: mind eval split <dir> --subject <id> --heldout <n> [--seed <s>] [--set <file>] [--write]";

/** `mind eval split`: propose n held-out tasks, stratified by kind; write them into the set only on --write. */
async function proposeSplitCmd(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["write"]);
  const dir = positional[0];
  const raw = options.get("subject");
  if (dir === undefined || positional.length > 1 || raw === undefined || raw === "") return usageError(SPLIT_USAGE);
  try {
    subjectId(raw);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const setPath = options.get("set") ?? join(dir, EVALS_FILE);
  const file = Bun.file(setPath);
  if (!(await file.exists())) {
    console.error(`mind: no task set at ${setPath}.`);
    return 1;
  }
  const text = await file.text();
  const parsed = parseEvals(EVALS_FILE, text);
  if (!parsed.ok) return report(parsed.issues);
  const n = parseHeldout(options.get("heldout"), parsed.value.length);
  if (!n.ok) return usageError(`${SPLIT_USAGE}\n${n.reason}`);
  const proposal = proposeSplit(parsed.value, n.value, options.get("seed") || DEFAULT_SEED);
  for (const line of proposalLines(proposal, parsed.value.length)) console.log(line);
  if (!options.has("write")) {
    console.log(dim(`Not written. --write puts split = "heldout" on these in ${setPath}; the file is yours to review and commit.`));
    return 0;
  }
  const edited = applySplit(text, new Set(proposal.heldout));
  if (!edited.ok) {
    console.error(`mind: ${edited.reason}`);
    return 1;
  }
  await Bun.write(setPath, edited.text);
  console.log(`Wrote the split into ${setPath}. Mind does not commit it: review the diff and commit it yourself.`);
  return 0;
}

const COMPARE_RUNS_USAGE = "usage: mind eval --compare-runs <runIdA> <runIdB> --subject <id> [<dir>] [--json]";

/** `mind eval --compare-runs A B`: two recorded runs, compared without asking anything. A is the base. */
async function compareRunsCmd(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf("--compare-runs");
  const [a, b] = [argv[at + 1], argv[at + 2]];
  if (a === undefined || b === undefined || a.startsWith("--") || b.startsWith("--")) return usageError(COMPARE_RUNS_USAGE);
  const { positional, options } = parseArgs([...argv.slice(0, at), ...argv.slice(at + 3)], ["json"]);
  const raw = options.get("subject");
  if (positional.length > 1 || raw === undefined || raw === "") return usageError(COMPARE_RUNS_USAGE);
  let id: SubjectId;
  try {
    id = subjectId(raw);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const dir = await evalRunsDir({ home: homedir(), env: process.env }, id);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return 1;
  }
  const [base, candidate] = [await readEvalRun(dir.path, a), await readEvalRun(dir.path, b)];
  for (const side of [base, candidate]) {
    if (!side.ok) {
      console.error(`mind: ${side.reason}`);
      return 1;
    }
  }
  if (!base.ok || !candidate.ok) return 1;
  const same = comparable(base.run, candidate.run);
  if (!same.ok) {
    console.error(`mind: will not compare ${a} with ${b}: ${same.reason}.`);
    return 1;
  }
  if (options.has("json")) {
    console.log(JSON.stringify({ compare: compareSides(base.run, candidate.run), selection: selectByRule(base.run, candidate.run) }, null, 2));
    return 0;
  }
  for (const line of compareLines(base.run, candidate.run, { bold, dim })) console.log(line);
  return 0;
}

export async function cmdEval(argv: readonly string[]): Promise<number> {
  if (argv.includes("--compare-runs")) return compareRunsCmd(argv);
  const [sub, ...rest] = argv;
  switch (sub) {
    case "runs":
      return listRuns(rest);
    case "split":
      return proposeSplitCmd(rest);
    case "code":
      return codeCmd(rest);
    default:
      return runEval(argv);
  }
}

async function runEval(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, EVAL_BOOLEANS);
  const dir = positional[0];
  const raw = options.get("subject");
  if (dir === undefined || positional.length > 1 || raw === undefined || raw === "") return usageError(USAGE);
  let id: SubjectId;
  try {
    id = subjectId(raw);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const repeat = parseRepeat(options.get("repeat"));
  if (!repeat.ok) return usageError(`${USAGE}\n${repeat.reason}`);
  const split = parseSplitFilter(options.get("split"));
  if (!split.ok) return usageError(`${USAGE}\n${split.reason}`);
  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);
  const setPath = options.get("set") ?? join(dir, EVALS_FILE);
  const file = Bun.file(setPath);
  if (!(await file.exists())) {
    console.error(`mind: no task set at ${setPath}. Write one — see \`mind help\` under eval — with at least ${MIN_TASKS} real tasks (S6.5 AC1).`);
    return 1;
  }
  const setText = await file.text();
  const parsed = parseEvals(EVALS_FILE, setText);
  if (!parsed.ok) return report(parsed.issues);
  const only = (options.get("only") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const tasks = bySplit(only.length === 0 ? parsed.value : parsed.value.filter((t) => only.includes(t.id)), split.value);
  if (tasks.length === 0) return usageError(`no task matches${only.length === 0 ? "" : ` --only ${only.join(",")}`}${split.value === "all" ? "" : ` --split ${split.value}`}`);
  const json = options.has("json");
  const recallChars = Number(options.get("recall-chars") ?? String(DEFAULT_RECALL_CHARS));
  if (!Number.isInteger(recallChars) || recallChars < 0) return usageError(`${USAGE} — --recall-chars is a whole number`);
  const baseRun = options.get("base-run");
  if (baseRun !== undefined && (!options.has("compare") || baseRun === "")) return usageError(`${USAGE}\n--base-run takes a recorded run id and goes with --compare`);
  if (options.has("compare") && (options.get("compare") === "" || options.has("recall-only") || options.has("no-record"))) {
    return usageError(`${USAGE}\n--compare takes a git ref, records both runs (no --no-record), and asks a model (no --recall-only)`);
  }
  if (options.has("recall-only")) return recallOnly(dir, id, tasks, json, recallChars);
  const say = (line: string) => (json ? console.error(line) : console.log(line));
  if (parsed.value.length < MIN_TASKS) say(dim(`note: ${parsed.value.length} task(s) — S6.5 AC1 asks for at least ${MIN_TASKS} before the number means much.`));
  const record = !options.has("no-record");
  const runsDir = record ? await evalRunsDir({ home: homedir(), env: process.env }, id) : undefined;
  if (runsDir !== undefined && !runsDir.ok) {
    console.error(`mind: ${runsDir.reason} Run with --no-record to evaluate without keeping the run.`);
    return 1;
  }
  const k = repeat.value;
  const keep = options.has("keep-answers");
  const flags = ["backend", "model", "recall-chars"].flatMap((name) => {
    const value = options.get(name);
    return value === undefined || value === "" ? [] : [`--${name}`, value];
  });
  const env = { ...process.env, [AUTONOMY_MAX_ENV]: triggeredCeiling(readMind(AUTONOMY_MAX_ENV, process.env)), MIND_NO_UPDATE_CHECK: "1" };
  /** One run of the tasks against the soul in `at`, graded and recorded. */
  const runOnce = async (at: string, label: string, compare?: CompareLink, version?: SoulVersion) => {
    const soul = version ?? (await soulVersion(await resolveSoulDir(at)));
    const startedAt = new Date();
    const rows = await runAttempts(
      tasks,
      k,
      async (task, mode) => {
        const run = await runGuarded(
          [...engineCommand().argv, "turn", resolve(at), "--subject", id, "--prompt", task.ask, "--json", "--no-proposals", ...(mode === "soul" ? ["--no-recall"] : []), ...flags],
          { env },
        );
        try {
          const out = JSON.parse(new TextDecoder().decode(run.stdout)) as { text?: string; route?: string };
          return { answer: out.text ?? "", route: out.route ?? `no answer (exit ${run.code})` };
        } catch {
          // No JSON: the turn did not run. Graded as a fail, with the reason.
          return { answer: "", route: `no answer (exit ${run.code})` };
        }
      },
      keep,
      (g, i) => say(dim(`${label}${attemptLine(g, i, tasks.length, k)}`)),
    );
    const r = repeatedReport(tasks, rows, k);
    const rec = evalRunRecord({ startedAt, subject: id, soul, setText, backend: options.get("backend"), model: options.get("model"), recallChars, tasks, split: split.value, keptAnswers: keep, results: rows, report: r, ...(compare === undefined ? {} : { compare }) });
    const recorded = runsDir?.ok === true ? await writeEvalRun(runsDir.path, rec) : null;
    return { soul, rows, report: r, rec, recorded };
  };

  const ref = options.get("compare");
  if (ref !== undefined) {
    const at = await withSoulAtRef(dir, ref, stateRoot(homedir(), process.env), async (candidate) => {
      const loadedAt = await loadSoul(candidate.dir, id);
      if (!loadedAt.ok) return { issues: loadedAt.issues };
      const compareId = newCompareId(new Date());
      const link = (role: CompareLink["role"]): CompareLink => ({ id: compareId, role, ref, commit: candidate.commit });
      // S21.5: `--base-run` is a base already answered (a tune round's own base run), so only the candidate is asked.
      let base: Awaited<ReturnType<typeof runOnce>>;
      if (baseRun === undefined) base = await runOnce(dir, "base      ", link("base"));
      else {
        const read = runsDir?.ok === true ? await readEvalRun(runsDir.path, baseRun) : { ok: false as const, reason: "no runs directory" };
        if (!read.ok) return { problem: read.reason };
        const run = read.run;
        if (run.evalsSha256 !== sha256(setText) || run.repeat !== k || run.split !== split.value || run.subject !== id) {
          return { problem: `${baseRun} is not a run of this task set, subject, --split and --repeat ${k}: a base is only reused for the same question` };
        }
        base = { soul: run.soul, rows: [...run.results], report: run.report, rec: run, recorded: join(runsDir!.path, `${run.runId}.json`) };
      }
      // The candidate is the ref's tree, unchanged; read from where it was written out, not from whatever git that directory sits in.
      const candSoulDir = await resolveSoulDir(candidate.dir);
      const files = await soulFiles(candSoulDir);
      const version: SoulVersion = { gitTree: candidate.soulTree, dirty: false, contentSha256: await soulContentSha(candSoulDir, files), files };
      const cand = await runOnce(candidate.dir, "candidate ", link("candidate"), version);
      const same = comparable(base.rec, cand.rec);
      if (!same.ok) return { problem: same.reason };
      return { base, cand };
    });
    if (!at.ok) {
      console.error(`mind: ${at.reason}`);
      return 1;
    }
    if ("problem" in at.value) {
      console.error(`mind: will not compare: ${at.value.problem}.`);
      return 1;
    }
    if ("issues" in at.value) {
      console.error(`mind: the soul at ${ref} does not load:`);
      return report(at.value.issues);
    }
    const { base, cand } = at.value;
    if (json) {
      console.log(JSON.stringify({ compare: compareSides(base.rec, cand.rec), selection: selectByRule(base.rec, cand.rec), base: { runId: base.rec.runId, record: base.recorded, report: base.report }, candidate: { runId: cand.rec.runId, record: cand.recorded, report: cand.report } }, null, 2));
      return 0;
    }
    for (const line of compareLines(base.rec, cand.rec, { bold, dim })) console.log(line);
    console.log(dim(`Recorded as ${base.recorded} and ${cand.recorded}.`));
    return 0;
  }

  const once = await runOnce(dir, "");
  if (json) {
    console.log(JSON.stringify({ report: once.report, results: once.rows, record: once.recorded }, null, 2));
    return 0;
  }
  for (const line of reportLines(loaded.soul.role.name, once.report, { recorded: once.recorded, soul: once.soul, keptAnswers: keep }, { bold, dim })) console.log(line);
  return 0;
}

const CODE_USAGE =
  "usage: mind eval code <agent-dir> --subject <id> --set <dir> --backend <a,b,…> [--only <id,…>] [--json]";

/** Every file under `dir`, path → sha256 of its bytes. Reads the tree, not what the bot said it did. */
async function fingerprint(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of await readdir(dir, { recursive: true })) {
    const file = Bun.file(join(dir, path));
    if ((await file.stat()).isDirectory()) continue;
    out.set(path, new Bun.CryptoHasher("sha256").update(await file.bytes()).digest("hex"));
  }
  return out;
}

/** The real side of {@link CodeDeps}: a copy in the temp dir, a gate as a child with a deadline, a turn as `mind turn`. */
function realCodeDeps(agentDir: string, subject: SubjectId, setDir: string): CodeDeps {
  const engine = engineCommand().argv;
  return {
    async materialise(task: CodeTask) {
      const dir = await mkdtemp(join(tmpdir(), `mind-code-eval-${task.id}-`));
      await cp(join(setDir, task.id, REPO_DIR), dir, { recursive: true });
      return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
    async gate(dir, argv, timeoutMs) {
      let child;
      try {
        child = spawnGuarded([...argv], { cwd: dir, env: { PATH: process.env["PATH"] ?? "", HOME: dir } });
      } catch {
        return { pass: false, unrunnable: true };
      }
      const timer = setTimeout(() => child.kill(), timeoutMs);
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      void stdout;
      void stderr;
      await child.exited;
      clearTimeout(timer);
      // A signal is a deadline or a missing binary (code 127 / 126), neither a red nor a green.
      const code = child.exitCode;
      return code === null || code === 127 || code === 126 ? { pass: false, unrunnable: true } : { pass: code === 0, unrunnable: false };
    },
    async turn(dir, prompt, backend) {
      const file = join(await mkdtemp(join(tmpdir(), "mind-code-eval-prompt-")), "prompt.txt");
      await writeFile(file, prompt, { mode: 0o600 });
      try {
        const child = spawnGuarded([...engine, "turn", agentDir, "--subject", subject, "--prompt-file", file, "--json", "--backend", backend], { cwd: dir, env: process.env });
        const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
        await child.exited;
        const { why, ...read } = readTurnJson(stdout);
        return { code: child.exitCode ?? -1, text: read.text, backend: read.backend, model: read.model ?? null, error: why === undefined || why === "" ? tail(stderr) : why };
      } finally {
        await rm(dirname(file), { recursive: true, force: true });
      }
    },
    snapshot: fingerprint,
  };
}

/** `mind eval code` — does each backend get a small repository's gate green? Reads nothing from the ledger; records nothing. */
async function codeCmd(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["json"]);
  const agentDir = positional[0];
  const rawSubject = options.get("subject");
  const set = options.get("set");
  const backends = (options.get("backend") ?? "").split(",").map((b) => b.trim()).filter((b) => b !== "");
  if (agentDir === undefined || positional.length > 1 || rawSubject === undefined || set === undefined || set === "" || backends.length === 0) return usageError(CODE_USAGE);
  let id: SubjectId;
  try {
    id = subjectId(rawSubject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const only = (options.get("only") ?? "").split(",").map((t) => t.trim()).filter((t) => t !== "");
  const setDir = resolve(set);
  let names: string[];
  try {
    names = (await readdir(setDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    console.error(`mind: no task set at ${setDir}`);
    return 1;
  }
  const tasks: CodeTask[] = [];
  const problems: string[] = [];
  for (const name of names.filter((n) => only.length === 0 || only.includes(n))) {
    let text: string;
    try {
      text = await readFile(join(setDir, name, TASK_FILE), "utf8");
    } catch {
      problems.push(`${name}: no ${TASK_FILE}`);
      continue;
    }
    const parsed = parseCodeTask(name, text);
    if (parsed.ok) tasks.push(parsed.task);
    else problems.push(...parsed.problems);
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`mind: ${problem}`);
    return 1;
  }
  if (tasks.length === 0) return usageError(`no task in ${setDir}${only.length === 0 ? "" : ` matches --only ${only.join(",")}`}`);

  const json = options.has("json");
  console.error(dim(`mind: ${tasks.length} task(s) × ${backends.length} backend(s); each is a real turn that leaves this machine for a cloud backend — the fixtures are synthetic.`));
  const rows = await runCodeEval(tasks, backends, realCodeDeps(resolve(agentDir), id, setDir), (row) => console.error(dim(`  ${row.backend} ${row.task}: ${row.outcome}${row.detail === "" ? "" : ` — ${row.detail}`}`)));
  const table = codeTable(rows);
  if (json) console.log(JSON.stringify({ schema: "mind/code-eval-run@1", rows, table }, null, 2));
  else for (const line of codeLines(table)) console.log(line);
  return 0;
}
