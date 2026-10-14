/**
 * `mind eval <dir> --subject <id>` — run the job's task set and say how much
 * of it the agent does, per configuration and per kind of work (S6.5, D-073).
 *
 * Each task is a real `turn` (held at level 1: a measurement never acts), once
 * with `--no-recall` (the soul alone) and once with recall (soul + RAG). The
 * turns are in the ledger like any other; the grade is recomputed from the
 * answer, never asked of a model.
 */

import { readMind } from "../../src/env.ts";
import { dirname, resolve, join } from "node:path";
import { attachWithin, DEFAULT_RECALL_CHARS, RECALL_HITS } from "../../src/memory/attach.ts";
import { recall } from "../../src/memory/recall.ts";
import { vectorEndpoints } from "../../src/memory/endpoints.ts";
import { resolveSoulDir } from "../../src/soul/load.ts";
import { AUTONOMY_MAX_ENV } from "../../src/decide/effective.ts";
import { triggeredCeiling } from "../../src/decide/triggers.ts";
import { engineCommand } from "../../src/guard/hooks.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { EVALS_FILE, grade, MIN_TASKS, MODES, parseEvals, report as evalReport, type EvalResult, type EvalTask } from "../../src/soul/evals.ts";
import { runGuarded } from "../../src/spawn.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { bold, dim, parseArgs, report, usageError } from "../shared.ts";

const USAGE = "usage: mind eval <dir> --subject <id> [--set <file>] [--only <id,…>] [--recall-only] [--recall-chars <n>] [--backend <b>] [--model <m>] [--json]";

const EVAL_BOOLEANS: readonly string[] = ["json", "recall-only"];

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
  const rows: { task: string; kind: string; hit: boolean; missing: readonly string[]; attached: readonly string[] }[] = [];
  for (const task of tasks) {
    const found = await recall(agentDir, id, task.ask, RECALL_HITS, checked.ok ? checked.endpoints : { reason: checked.reason }, undefined, "any");
    const attachment = attachWithin(found.hits, ceiling);
    const missing = grade({ ...task, reject: [] }, attachment.block).missing;
    rows.push({ task: task.id, kind: task.kind, hit: attachment.block !== "" && missing.length === 0, missing, attached: attachment.attached.map((a) => a.path) });
  }
  const hits = rows.filter((r) => r.hit).length;
  const withSource = tasks.length;
  if (json) {
    console.log(JSON.stringify({ hits, tasks: withSource, rows }, null, 2));
    return 0;
  }
  for (const r of rows) console.log(`${r.hit ? "hit " : "MISS"} ${r.task.padEnd(28)} ${r.hit ? "" : dim(`missing ${r.missing.map((m) => JSON.stringify(m)).join(", ")} · attached: ${r.attached.map((a) => a.replace(/^memory\//, "")).join(", ") || "nothing"}`)}`);
  console.log(bold(`\nrecall attached the answer for ${hits}/${withSource} (${withSource === 0 ? 0 : Math.round((hits / withSource) * 1000) / 10}%) — no model asked`));
  return 0;
}

export async function cmdEval(argv: readonly string[]): Promise<number> {
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
  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);
  const setPath = options.get("set") ?? join(dir, EVALS_FILE);
  const file = Bun.file(setPath);
  if (!(await file.exists())) {
    console.error(`mind: no task set at ${setPath}. Write one — see \`mind help\` under eval — with at least ${MIN_TASKS} real tasks (S6.5 AC1).`);
    return 1;
  }
  const parsed = parseEvals(EVALS_FILE, await file.text());
  if (!parsed.ok) return report(parsed.issues);
  const only = (options.get("only") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const tasks = only.length === 0 ? parsed.value : parsed.value.filter((t) => only.includes(t.id));
  if (tasks.length === 0) return usageError(`no task matches --only ${only.join(",")}`);
  const json = options.has("json");
  const recallChars = Number(options.get("recall-chars") ?? String(DEFAULT_RECALL_CHARS));
  if (!Number.isInteger(recallChars) || recallChars < 0) return usageError(`${USAGE} — --recall-chars is a whole number`);
  if (options.has("recall-only")) return recallOnly(dir, id, tasks, json, recallChars);
  const say = (line: string) => (json ? console.error(line) : console.log(line));
  if (parsed.value.length < MIN_TASKS) say(dim(`note: ${parsed.value.length} task(s) — S6.5 AC1 asks for at least ${MIN_TASKS} before the number means much.`));

  const flags = ["backend", "model", "recall-chars"].flatMap((name) => {
    const value = options.get(name);
    return value === undefined || value === "" ? [] : [`--${name}`, value];
  });
  const env = { ...process.env, [AUTONOMY_MAX_ENV]: triggeredCeiling(readMind(AUTONOMY_MAX_ENV, process.env)), MIND_NO_UPDATE_CHECK: "1" };
  const results: EvalResult[] = [];
  for (const [i, task] of tasks.entries()) {
    for (const mode of MODES) {
      const run = await runGuarded(
        [...engineCommand().argv, "turn", resolve(dir), "--subject", id, "--prompt", task.ask, "--json", "--no-proposals", ...(mode === "soul" ? ["--no-recall"] : []), ...flags],
        { env },
      );
      let answer = "";
      let route = `no answer (exit ${run.code})`;
      try {
        const out = JSON.parse(new TextDecoder().decode(run.stdout)) as { text?: string; route?: string };
        answer = out.text ?? "";
        route = out.route ?? route;
      } catch {
        // No JSON: the turn did not run. Graded as a fail, with the reason.
      }
      const g = grade(task, answer);
      results.push({ task: task.id, kind: task.kind, mode, pass: g.pass, missing: g.missing, rejected: g.rejected, route });
      say(dim(`  ${i + 1}/${tasks.length} ${task.id} [${mode}] ${g.pass ? "pass" : `fail${g.missing.length ? ` — missing ${g.missing.map((m) => JSON.stringify(m)).join(", ")}` : ""}${g.rejected.length ? ` — said ${g.rejected.map((m) => JSON.stringify(m)).join(", ")}` : ""}`} · ${route.split(" · ")[0]}`));
    }
  }
  const r = evalReport(tasks, results);
  if (json) {
    console.log(JSON.stringify({ report: r, results }, null, 2));
    return 0;
  }
  console.log(bold(`\n${loaded.soul.role.name} — ${r.total} task(s)`));
  for (const m of r.byMode) console.log(`  ${m.mode.padEnd(14)} ${String(m.passed).padStart(3)}/${r.total}  ${m.percent}%`);
  for (const m of r.notMeasured) console.log(dim(`  ${m.mode.padEnd(14)} not measured — ${m.why}`));
  console.log(bold("\nby kind of work"));
  for (const k of r.byKind) console.log(`  ${k.kind.padEnd(18)} ${String(k.tasks).padStart(3)} task(s)   ${MODES.map((m) => `${m} ${k.percent[m]}%`).join("   ")}`);
  console.log(r.notYet.length === 0 ? "\nEvery kind of work passes at least half its tasks in some configuration." : bold(`\nNot yet replaceable (under half, in the best configuration): ${r.notYet.join(", ")}`));
  console.log(dim("Graded by the phrases in the task set, not by a model. Every answer is in the ledger."));
  return 0;
}
