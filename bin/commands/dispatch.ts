/**
 * `mind dispatch` — what the measurement says, which backend a kind of work goes to first, and whether a backend's model
 * has changed (S22.14, S22.15, D-201). See `src/dispatch/`.
 *
 * Everything here reads. It writes one thing, and only on `watch --update`: the book of models last seen. Nothing it
 * prints changes how any task runs: `mind task new --backend auto` is where a ranking is used, and a person types that.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DISPATCH_CANDIDATES, EXPLORE, MIN_N } from "../../src/dispatch/choose.ts";
import { KIND } from "../../src/dispatch/measure.ts";
import { currentModelsOf, plan, type PlanIo } from "../../src/dispatch/plan.ts";
import { rateWords, tableOf, type Row } from "../../src/dispatch/table.ts";
import { changeWords, evalCommand, watch, type SeenBook } from "../../src/dispatch/watch.ts";
import { isKnownBackend } from "../../src/soul/index.ts";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateRoot } from "../../src/state.ts";
import { subjectId } from "../../src/types.ts";
import { dialEnv } from "../dial.ts";
import { parseArgs, usageError } from "../shared.ts";
import { planIo } from "../plan-io.ts";

const USAGE =
  "usage: mind dispatch table <dir> --subject <id> [--from <id,id>] [--kind <k>] [--json]\n" +
  "       mind dispatch suggest <dir> --subject <id> --kind <k> [--from <id,id>] [--candidates a,b] [--min-n <n>] [--explore <0..1>] [--json]\n" +
  "       mind dispatch review <dir> --subject <id> [--from <id,id>] [--candidates a,b] [--min-n <n>] [--json]\n" +
  "       mind dispatch watch <dir> --subject <id> [--from <id,id>] [--update] [--json]";

const TABLE_BOOLEANS: readonly string[] = ["json"];
const SUGGEST_BOOLEANS: readonly string[] = ["json"];
const REVIEW_BOOLEANS: readonly string[] = ["json"];
const WATCH_BOOLEANS: readonly string[] = ["json", "update"];

const csv = (value: string | undefined): string[] => (value ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");

function subjectsOf(options: ReadonlyMap<string, string>): { ok: true; subjects: string[] } | { ok: false; code: number } {
  const raw = options.get("subject");
  if (raw === undefined || raw === "") return { ok: false, code: usageError(USAGE) };
  const subjects = [raw, ...csv(options.get("from"))];
  for (const id of subjects) {
    try {
      subjectId(id);
    } catch (error) {
      return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
    }
  }
  return { ok: true, subjects: [...new Set(subjects)] };
}

function numberOption(options: ReadonlyMap<string, string>, name: string, min: number, max: number, integer: boolean): { ok: true; value: number | undefined } | { ok: false; code: number } {
  const raw = options.get(name);
  if (raw === undefined) return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return { ok: false, code: usageError(`--${name} is ${integer ? "a whole number" : "a number"} from ${min} to ${max}`) };
  return { ok: true, value: n };
}

function candidatesOf(options: ReadonlyMap<string, string>): { ok: true; ids: string[] } | { ok: false; code: number } {
  const ids = options.has("candidates") ? csv(options.get("candidates")) : [...DISPATCH_CANDIDATES];
  for (const id of ids) if (!isKnownBackend(id)) return { ok: false, code: usageError(`unknown backend ${JSON.stringify(id)}`) };
  return { ok: true, ids };
}

const pad = (text: string, width: number): string => (text.length >= width ? text : text + " ".repeat(width - text.length));

function rowLine(row: Row, prior: boolean): string {
  return [
    pad(row.backend, 9),
    pad(row.model ?? "(no model named)", 22),
    pad(row.kind ?? "(no kind)", 12),
    pad(`n=${row.n}`, 6),
    pad(rateWords(row), 14),
    pad(row.turnsMean === null ? "-" : `${row.turnsMean.toFixed(1)} turns`, 11),
    row.changeRate === null ? "not reviewed" : `${Math.round(row.changeRate * 100)}% sent back of ${row.reviewed}`,
    ...(row.stopped > 0 ? [`(${row.stopped} stopped, not counted)`] : []),
    ...(prior ? ["PRIOR: an older model, not measured for this model and not counted for the current one"] : []),
  ].join("  ");
}

export async function cmdDispatch(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "table":
      return table(rest);
    case "suggest":
      return suggest(rest);
    case "review":
      return review(rest);
    case "watch":
      return watchModels(rest);
    default:
      return usageError(USAGE);
  }
}

async function rowsOf(subjects: readonly string[], io: PlanIo): Promise<{ rows: readonly Row[]; models: ReadonlyMap<string, string> }> {
  const measures = (await Promise.all(subjects.map((subject) => io.measures(subject)))).flat();
  return { rows: tableOf(measures), models: currentModelsOf(measures) };
}

async function table(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, TABLE_BOOLEANS);
  if (positional.length !== 1) return usageError(USAGE);
  const from = subjectsOf(options);
  if (!from.ok) return from.code;
  const kind = options.get("kind");
  if (kind !== undefined && !KIND.test(kind)) return usageError("--kind is a short slug like bugfix or docs");
  const { rows, models } = await rowsOf(from.subjects, planIo());
  const shown = rows.filter((row) => kind === undefined || row.kind === kind);
  const priorOf = (row: Row): boolean => {
    const now = models.get(row.backend);
    return now !== undefined && row.model !== null && row.model !== now;
  };
  if (options.has("json")) {
    console.log(JSON.stringify({ subjects: from.subjects, rows: shown.map((row) => ({ ...row, prior: priorOf(row) })) }));
    return 0;
  }
  if (shown.length === 0) console.log("no measured tasks yet — each finished task writes one line (give tasks a --kind)");
  for (const row of shown) console.log(rowLine(row, priorOf(row)));
  console.error(`From ${from.subjects.join(", ")}. n counts tasks that were done, failed or ran out of budget; a stopped task is counted apart. A rate rests on its n, and is a direction, not a score of skill.`);
  return 0;
}

async function suggest(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, SUGGEST_BOOLEANS);
  if (positional.length !== 1) return usageError(USAGE);
  const from = subjectsOf(options);
  if (!from.ok) return from.code;
  const kind = options.get("kind");
  if (kind === undefined || !KIND.test(kind)) return usageError("--kind is a short slug like bugfix or docs");
  const candidates = candidatesOf(options);
  if (!candidates.ok) return candidates.code;
  const minN = numberOption(options, "min-n", 1, 1000, true);
  if (!minN.ok) return minN.code;
  const explore = numberOption(options, "explore", 0, 1, false);
  if (!explore.ok) return explore.code;
  const ranking = await plan({ kind, candidates: candidates.ids, subjects: from.subjects, ...(minN.value === undefined ? {} : { minN: minN.value }), ...(explore.value === undefined ? {} : { explore: explore.value }), rand: Math.random }, planIo());
  if (options.has("json")) {
    console.log(JSON.stringify({ kind, chain: ranking.chain, mode: ranking.mode, reason: ranking.reason, considered: ranking.considered }));
    return 0;
  }
  console.log(`${kind}: ${ranking.chain.join(", ")}`);
  console.log(`  ${ranking.reason}`);
  for (const c of ranking.considered) console.log(`  ${pad(c.id, 9)} n=${c.n}  ${c.note}`);
  console.error(`Minimum n ${minN.value ?? MIN_N}; ${Math.round((explore.value ?? EXPLORE) * 100)}% of tasks sample the least-sampled candidate. Nothing is changed: \`mind task new --kind ${kind} --backend auto\` is what uses this.`);
  return 0;
}

async function review(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, REVIEW_BOOLEANS);
  if (positional.length !== 1) return usageError(USAGE);
  const from = subjectsOf(options);
  if (!from.ok) return from.code;
  const candidates = candidatesOf(options);
  if (!candidates.ok) return candidates.code;
  const minN = numberOption(options, "min-n", 1, 1000, true);
  if (!minN.ok) return minN.code;
  const io = planIo();
  const { rows } = await rowsOf(from.subjects, io);
  const kinds = [...new Set(rows.map((row) => row.kind).filter((k): k is string => k !== null))].sort();
  const proposals: { kind: string; best: string; rate: number | null; n: number; thenOrder: readonly string[]; differs: boolean }[] = [];
  for (const kind of kinds) {
    // No exploration here: a review proposes where the numbers point, not where today's dice would send one task.
    const ranking = await plan({ kind, candidates: candidates.ids, subjects: from.subjects, ...(minN.value === undefined ? {} : { minN: minN.value }), rand: () => 1 }, io);
    const lead = ranking.considered.find((c) => c.id === ranking.chain[0]);
    if (lead === undefined || !lead.trusted) continue;
    proposals.push({ kind, best: lead.id, rate: lead.rate, n: lead.n, thenOrder: ranking.chain, differs: ranking.chain[0] !== candidates.ids[0] });
  }
  if (options.has("json")) {
    console.log(JSON.stringify({ subjects: from.subjects, proposals }));
    return 0;
  }
  if (proposals.length === 0) console.log("nothing to propose: no kind of work has a backend with enough outcomes yet");
  for (const p of proposals) console.log(`${p.kind}: go to ${p.best} first (${p.rate === null ? "-" : Math.round(p.rate * 100)}% of ${p.n} done)${p.differs ? `, not ${candidates.ids[0]}` : ""}; order ${p.thenOrder.join(", ")}`);
  console.error("These are proposals for you. Nothing was changed and nothing will be: a task goes where `--backend auto` or a chain you type sends it.");
  return 0;
}

function seenPath(): string {
  const env = dialEnv();
  return join(stateRoot(env.home, env.env), "models-seen.json");
}

function readSeen(path: string): SeenBook {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { models?: Record<string, { model?: unknown; since?: unknown }> };
    const book: Record<string, { model: string; since: string }> = {};
    for (const [backend, seen] of Object.entries(parsed.models ?? {})) if (typeof seen.model === "string" && typeof seen.since === "string") book[backend] = { model: seen.model, since: seen.since };
    return book;
  } catch {
    return {};
  }
}

async function watchModels(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, WATCH_BOOLEANS);
  if (positional.length !== 1) return usageError(USAGE);
  const from = subjectsOf(options);
  if (!from.ok) return from.code;
  const io = planIo();
  const measures = (await Promise.all(from.subjects.map((subject) => io.measures(subject)))).flat();
  const path = seenPath();
  const watched = watch(measures, readSeen(path));
  const { rows } = await rowsOf(from.subjects, io);
  const prior = (backend: string, model: string): number => rows.filter((row) => row.backend === backend && row.model !== model).reduce((sum, row) => sum + row.n, 0);
  if (options.has("json")) {
    console.log(JSON.stringify({ changes: watched.changes.map((change) => ({ ...change, evalCommand: evalCommand(change.backend, positional[0], from.subjects[0]) })), first: watched.first.map((first) => ({ ...first, evalCommand: evalCommand(first.backend, positional[0], from.subjects[0]) })), updated: options.has("update") }));
  } else {
    if (watched.changes.length === 0) console.log("no backend has changed its model since the book was last updated");
    for (const change of watched.changes) for (const text of changeWords(change, prior(change.backend, change.to), positional[0], from.subjects[0])) console.log(text);
    for (const f of watched.first) console.log(`${f.backend}: first seen on ${f.model} (${f.since.slice(0, 10)}); there is nothing to compare with yet\n  Before it is trusted: run \`${evalCommand(f.backend, positional[0], from.subjects[0])}\``);
  }
  if (options.has("update")) {
    mkdirSync(dirname(path), { recursive: true, mode: STATE_DIR_MODE });
    writeFileSync(path, `${JSON.stringify({ v: 1, models: watched.next }, null, 2)}\n`, { mode: STATE_FILE_MODE });
    console.error(`mind dispatch: the book of models seen was updated (${path}).`);
  } else if (watched.changes.length + watched.first.length > 0) {
    console.error("mind dispatch: a change is reported until you run this with --update, so it is not forgotten unread.");
  }
  return 0;
}
