/** `mind memory` — build an agent's recall from its `memory/`, and ask it something. */

import { readMind } from "../../src/env.ts";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { GIT_UNDELETABLE, SCAN_BLIND_SPOTS } from "../../src/guard/index.ts";
import {
  collectionFor,
  commitForget,
  commitIngest,
  DEFAULT_RECALL_CHARS,
  formatForgetPlan,
  planForget,
  formatIngestPlan,
  importName,
  planIngest,
  FTS_FILE,
  indexAgent,
  RAG_UNDELETABLE,
  RECALL_HITS,
  ragDirFor,
  recall,
  splitForCloud,
  vectorEndpoints,
  type Attachment,
} from "../../src/memory/index.ts";
import { subjectId, type SubjectId, UNREPORTED_USAGE } from "../../src/types.ts";
import { basisDirFor, basisFor, readBasis, refusalLine, soulSubject } from "../../src/consent/basis.ts";
import { commitMove, commitWrite, planMove, planWrite, type WritePlan } from "../../src/memory/write.ts";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { OLLAMA_MODEL_ENV, OllamaExec } from "../../src/exec/ollama-exec.ts";
import { asLocal, LOCAL_CLI_SEES_PERSONAL } from "../../src/exec/local.ts";
import { probeRestraint } from "../../src/exec/restraint.ts";
import {
  AnnouncedExec,
  LOCAL_BACKENDS,
  LOCAL_MODEL,
  LocalCliExec,
  PHASE_A_BACKENDS,
  backend as buildBackend,
  fallbackTrail,
  routeModels,
  turnChain,
  type TurnResult,
} from "../../src/exec/index.ts";
import { fenceSupport } from "../../src/exec/fence.ts";
import { chooseRoute, parseRoutePreference } from "../../src/exec/route.ts";
import { isLocalCliId, localBaseVendor } from "../../src/exec/local-cli.ts";
import { vendor } from "../../src/exec/registry.ts";
import { describeRun, removeRunRecord, writeRunRecord } from "../../src/decide/runs.ts";
import { judgeInput, judgeLayer, loadLexicon, recordBlocked, resolveJudgeMode, screen } from "../../src/egress/index.ts";
import { chosenLanguage } from "../../src/lang.ts";
import { RecordingExec, canAppend, modelOfTurn } from "../../src/ledger/index.ts";
import { loadPrices } from "../../src/pricing/table.ts";
import { printable } from "../../src/identity/shapes.ts";
import {
  ASK_TIMEOUT_MS,
  appendAskRecall,
  askRecallRecord,
  askProblem,
  noToolsWhenRestrained,
  relevantForAsk,
  askSystem,
  nothingInMemory,
  piecesOf,
  readAnswer,
  sourcesOf,
  type AskPiece,
  type AskSource,
} from "../../src/memory/ask.ts";
import { isKnownBackend, loadSoul, renderSoul, resolveSoulDir, sha256 } from "../../src/soul/index.ts";
import { isLocalBackend } from "../../src/web/turninfo.ts";
import { ensurePersonalDir, personalDir } from "../../src/guard/personal.ts";
import { checkFacts, distillPrompt, factChunks, factNotes, FACTS_DIR, readFacts, type Fact, type FactDraft } from "../../src/memory/distill.ts";
import { KNOWLEDGE_DIR, memoryKind, movedPath, SCOPES, type Scope } from "../../src/memory/kinds.ts";
import { listMemories, memoryMeta, readMemoryFile, whoMentions } from "../../src/web/memories.ts";
import { convertFile, convertUrl, planImport, type Converted } from "../../src/memory/import.ts";
import { dialEnv } from "../dial.ts";
import { bold, dim, dimErr, ledgerEnv, parseArgs, report, usageError } from "../shared.ts";

const INDEX_USAGE = "usage: mind memory index <agent-dir> --subject <id>";
const INGEST_USAGE = "usage: mind memory ingest <agent-dir> --from <dir> [--name <name>] [--yes]";
const FORGET_USAGE =
  "usage: mind memory forget <agent-dir> --subject <id> (--file <memory/…> [--file …] | --match <text>) [--yes]";
const SEARCH_USAGE = "usage: mind memory search <agent-dir> --subject <id> [--limit <n>] [--scope all|memory|knowledge] <query...>";
const WHO_USAGE = "usage: mind memory who <agent-dir> <port|service|host|env name|path…>";
const MOVE_USAGE = "usage: mind memory move <agent-dir> --subject <id> --file <memory/…md> (--to <memory/…md> | --to knowledge | --to memory) [--yes]";
const WRITE_USAGE = "usage: mind memory write <agent-dir> --subject <id> --file <memory/…md> --from <file> [--yes]";
const WRITE_BOOLEANS: readonly string[] = ["yes"];
const IMPORT_USAGE =
  "usage: mind memory import <agent-dir> --subject <id> (--from <file> | --url <link>) [--name <file name>] [--as <memory/…md>] [--yes]";

function subjectFrom(raw: string | undefined, usage: string): { ok: true; id: SubjectId } | { ok: false; code: number } {
  if (raw === undefined || raw === "") return { ok: false, code: usageError(usage) };
  try {
    return { ok: true, id: subjectId(raw) };
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
}

/** The endpoints, or the reason the vector half will be skipped. Never a failure of the command. */
function endpointsOrReason() {
  const checked = vectorEndpoints(process.env);
  return checked.ok ? checked.endpoints : { reason: checked.reason };
}

/**
 * `mind memory index` — S4.1.
 *
 * Prints what dropping the collection will not reach *before* anything is
 * embedded, because after is too late to decide not to. The full-text half is
 * always built; the vector half is reported and skipped when a server is
 * missing (AC4). Exit 0 either way — a recall with one half is still a recall.
 */
async function cmdMemoryIndex(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const dir = positional[0];
  if (dir === undefined || dir === "" || positional.length > 1) return usageError(INDEX_USAGE);
  const subject = subjectFrom(options.get("subject"), INDEX_USAGE);
  if (!subject.ok) return subject.code;
  const agentDir = resolve(dir);

  console.log(bold("Before anything is embedded — what dropping the collection cannot reach:"));
  for (const note of RAG_UNDELETABLE) console.log(dim(`  - ${note}`));
  console.log();

  const report = await indexAgent(agentDir, subject.id, endpointsOrReason(), {
    markerDir: ragDirFor(homedir(), process.env, subject.id),
    now: () => new Date(),
  });

  console.log(bold(`memory — ${agentDir}`));
  console.log(`  ${report.files} file(s) · ${report.chunks} piece(s)`);
  for (const bad of report.unreadable) console.log(dim(`  unreadable: ${bad.path} — ${bad.reason}`));
  console.log(`  full-text  ${report.fts} piece(s) → ${FTS_FILE}`);
  console.log(
    report.vectors.ok
      ? `  vectors    ${report.vectors.points} point(s) → ${collectionFor(subject.id)}`
      : `  vectors    not built — ${report.vectors.reason}`,
  );
  if (!report.vectors.ok) {
    console.log(dim("  recall still works on the full-text half; run this again when the store is up."));
  }
  return 0;
}

/** `mind memory search` — hybrid recall, with where each hit came from (S4.3 AC3's "not a black box"). */
async function cmdMemorySearch(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const [dir, ...words] = positional;
  if (dir === undefined || dir === "" || words.length === 0) return usageError(SEARCH_USAGE);
  const subject = subjectFrom(options.get("subject"), SEARCH_USAGE);
  if (!subject.ok) return subject.code;
  const limit = Number(options.get("limit") ?? "5");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return usageError(`${SEARCH_USAGE} — --limit is a whole number from 1 to 50`);
  }

  const scope = (options.get("scope") ?? "all") as Scope;
  if (!SCOPES.includes(scope)) return usageError(`${SEARCH_USAGE} — --scope is ${SCOPES.join(", ")}`);
  const result = await recall(resolve(dir), subject.id, words.join(" "), limit, endpointsOrReason(), undefined, "all", scope);
  if (result.fts === "absent") {
    console.error(dim(`no ${FTS_FILE} — run \`mind memory index\` first`));
  }
  if (result.vector !== "ok") console.error(dim(`vector half skipped: ${result.vector.failed}`));
  if (result.hits.length === 0) {
    // Neither index could be asked: "no hit" would claim a search that never ran, so say so, and exit 3.
    if (result.fts === "absent" && result.vector !== "ok") {
      console.log("nothing searched");
      return 3;
    }
    console.log("no hit");
    return 1;
  }
  for (const hit of result.hits) {
    console.log(bold(`${hit.path}${hit.heading === "" ? "" : ` — ${hit.heading}`}`));
    console.log(dim(`  ${hit.via.join("+")} · ${hit.score.toFixed(4)}`));
    const excerpt = hit.text.replace(/\s+/g, " ").slice(0, 240);
    console.log(`  ${excerpt}${hit.text.length > 240 ? "…" : ""}`);
  }
  return 0;
}

/**
 * `mind memory ingest` — S4.2 (D-040).
 *
 * Shows the plan — every file, every removal, every file the guard stopped —
 * and writes only with `--yes`. Before writing it prints what git keeps and
 * what the scan cannot see, because the step after this one is `git add`, and
 * that step is the owner's.
 */
async function cmdMemoryIngest(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["yes"]);
  const dir = positional[0];
  const from = options.get("from");
  if (dir === undefined || dir === "" || positional.length > 1 || from === undefined || from === "") {
    return usageError(INGEST_USAGE);
  }
  const source = resolve(from);
  const name = options.get("name") ?? importName(basename(source));
  if (name === undefined || importName(name) !== name) {
    return usageError(`${INGEST_USAGE} — --name takes a-z, 0-9 and -, and the source's name gave nothing usable`);
  }

  // S7.3 (D-077): no basis on record for memory, and nothing is read.
  const subject = await soulSubject(dir);
  if (subject === undefined) {
    console.error(`mind: ${dir} has no soul that names its subject, so there is no basis to check — nothing was read.`);
    return 1;
  }
  const allowed = basisFor(await readBasis(basisDirFor(dialEnv(), subjectId(subject))), "memory", new Date());
  if (!allowed.ok) {
    console.error(`mind: ${refusalLine(subject, "memory", allowed.reason)}`);
    return 1;
  }
  console.error(dim(`mind: basis ${allowed.record.id} (${allowed.record.basis}, by ${allowed.record.approvedBy}) allows memory for ${subject}.`));

  let plan;
  try {
    plan = await planIngest(source, resolve(dir), name);
  } catch (error) {
    console.error(`mind: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  console.log(bold(`ingest — ${source} → ${plan.target}`));
  for (const line of formatIngestPlan(plan)) console.log(line);
  console.log();
  console.log(bold("What the scan cannot see — the files above passed it, and that is all it says:"));
  for (const note of SCAN_BLIND_SPOTS) console.log(dim(`  - ${note}`));

  if (!options.has("yes")) {
    console.log();
    console.log(dim("Nothing was written. --yes copies the files above into the working tree; it does not stage or commit."));
    return plan.blocked.length > 0 ? 1 : 0;
  }

  console.log();
  console.log(bold("Before these files exist: what a commit puts beyond Mind's reach"));
  for (const note of GIT_UNDELETABLE) console.log(dim(`  - ${note}`));
  const done = await commitIngest(plan);
  console.log();
  console.log(`wrote ${done.written} file(s), removed ${done.removed} under ${plan.target}`);
  console.log(
    dim(
      "Not staged and not committed. Run `mind memory index` to put them in recall, and " +
        "`git add` them when you have read them — recall sends what it finds to the backend that " +
        "answers a turn (D-039).",
    ),
  );
  return plan.blocked.length > 0 ? 1 : 0;
}

/**
 * `mind memory forget` — S4.4 (D-041).
 *
 * Whole files under memory/, then the collection dropped whole and both
 * indexes rebuilt, then the needle looked for again. Exit 1 if that last look
 * finds anything, if anything was refused, or if nothing matched.
 */
async function cmdMemoryForget(argv: readonly string[]): Promise<number> {
  const files = argv.flatMap((arg, i) => (arg === "--file" && argv[i + 1] !== undefined ? [argv[i + 1] as string] : []));
  const rest = argv.filter((arg, i) => arg !== "--file" && argv[i - 1] !== "--file");
  const { positional, options } = parseArgs(rest, ["yes"]);
  const dir = positional[0];
  const match = options.get("match");
  if (dir === undefined || dir === "" || positional.length > 1) return usageError(FORGET_USAGE);
  if ((files.length > 0) === (match !== undefined && match !== "")) {
    return usageError(`${FORGET_USAGE} — name files, or a text to match, and not both`);
  }
  const subject = subjectFrom(options.get("subject"), FORGET_USAGE);
  if (!subject.ok) return subject.code;
  const agentDir = resolve(dir);
  const endpoints = endpointsOrReason();

  const plan = await planForget({
    agentDir,
    subject: subject.id,
    target: files.length > 0 ? { kind: "files", files } : { kind: "match", text: match! },
    markerDir: ragDirFor(homedir(), process.env, subject.id),
    endpoints,
  });

  console.log(bold(`forget — ${agentDir}`));
  for (const line of formatForgetPlan(plan)) console.log(line);
  for (const refusal of plan.refusals) console.error(`mind: ${refusal}`);
  if (plan.refusals.length > 0) return 1;
  if (plan.files.length === 0) {
    console.error("mind: nothing under memory/ matched, so nothing was forgotten.");
    return 1;
  }

  console.log();
  console.log(bold("What forgetting here cannot reach:"));
  for (const note of GIT_UNDELETABLE) console.log(dim(`  - ${note}`));
  for (const note of RAG_UNDELETABLE) console.log(dim(`  - ${note}`));
  if (!options.has("yes")) {
    console.log();
    console.log(dim("Nothing was removed. --yes removes the files above and rebuilds both indexes."));
    return 0;
  }

  const result = await commitForget(plan, endpoints);
  console.log();
  console.log(`removed ${result.removed.length} file(s) · full-text rebuilt with ${result.fts} piece(s)`);
  console.log(
    result.dropped === null
      ? "vectors: nothing to drop"
      : result.dropped
        ? result.vectors !== null && result.vectors.ok
          ? `vectors: collection dropped whole and rebuilt with ${result.vectors.points} point(s)`
          : `vectors: collection dropped whole, not rebuilt (${result.vectors?.ok === false ? result.vectors.reason : "no endpoints"}) — \`memory index\` brings recall back`
        : "vectors: the collection was NOT dropped",
  );
  const c = result.check;
  console.log(
    `checked again: ${c.filesStillMatching.length} file(s) still matching · ${c.ftsStillMatching} full-text hit(s) · ` +
      `${c.pointsAfter === null ? "no store read" : `${c.pointsAfter} point(s) for ${c.piecesAfter} piece(s)`}`,
  );
  if (!c.passed) {
    for (const path of c.filesStillMatching) console.error(`mind: still there: ${path}`);
    console.error("mind: the second look found what was meant to be gone — see the line above.");
    return 1;
  }
  console.log(dim("Not staged and not committed: the removal is in the working tree, and every earlier commit still holds the file."));
  return 0;
}

/**
 * `mind memory write` — create or replace one memory file (D-081): what the
 * web page's editor saves through. Shows the plan; with --yes writes it and
 * rebuilds both indexes, the vector collection dropped whole (D-035). Needs
 * the S7.3 basis for memory, like ingest. Nothing is staged or committed.
 */
async function cmdMemoryWrite(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, WRITE_BOOLEANS);
  const dir = positional[0];
  const file = options.get("file");
  const from = options.get("from");
  if (dir === undefined || dir === "" || positional.length > 1 || file === undefined || from === undefined || from === "") return usageError(WRITE_USAGE);
  const subject = subjectFrom(options.get("subject"), WRITE_USAGE);
  if (!subject.ok) return subject.code;
  const allowed = basisFor(await readBasis(basisDirFor(dialEnv(), subject.id)), "memory", new Date());
  if (!allowed.ok) {
    console.error(`mind: ${refusalLine(subject.id, "memory", allowed.reason)}`);
    return 1;
  }
  let text: string;
  try {
    text = await Bun.file(from).text();
  } catch (error) {
    console.error(`mind: ${from}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const agentDir = resolve(dir);
  const plan = await planWrite(agentDir, file, text);
  if (plan.refusal !== undefined) {
    console.error(`mind: not written — ${plan.refusal}`);
    return 1;
  }
  if (plan.kind === "same") {
    console.log(`${plan.path} already says exactly that — nothing to write.`);
    return 0;
  }
  console.log(`${plan.kind === "new" ? "new" : "replace"} ${plan.path} · ${plan.bytesBefore} → ${plan.bytesAfter} bytes · +${plan.linesAdded} / -${plan.linesRemoved} line(s)`);
  if (!options.has("yes")) {
    console.log(dim("Nothing was written. --yes writes it and rebuilds both indexes."));
    return 0;
  }
  await commitWrite(agentDir, plan, text);
  const report = await indexAgent(agentDir, subject.id, endpointsOrReason(), {
    markerDir: ragDirFor(homedir(), process.env, subject.id),
    now: () => new Date(),
  });
  console.log(`written · full-text ${report.fts} piece(s) · ${report.vectors.ok ? `vectors rebuilt whole, ${report.vectors.points} point(s)` : `vectors not rebuilt — ${report.vectors.reason}`}`);
  console.log(dim("Not staged and not committed: git keeps whatever it is given — see what git remembers with `mind memory forget`'s notes."));
  return 0;
}

/**
 * `mind memory import` — a document or a web page into memory as markdown
 * (D-084). Shows where it would go and how it was read; with --yes writes
 * every part through the same gates as `memory write`, then rebuilds both
 * indexes once. `--name` is the file's own name when `--from` is a temporary
 * copy (the web page's upload), so the kind and the title come from it.
 */
async function cmdMemoryImport(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, WRITE_BOOLEANS);
  const dir = positional[0];
  const from = options.get("from");
  const url = options.get("url");
  if (dir === undefined || dir === "" || positional.length > 1 || (from === undefined) === (url === undefined) || from === "" || url === "") return usageError(IMPORT_USAGE);
  const subject = subjectFrom(options.get("subject"), IMPORT_USAGE);
  if (!subject.ok) return subject.code;
  const allowed = basisFor(await readBasis(basisDirFor(dialEnv(), subject.id)), "memory", new Date());
  if (!allowed.ok) {
    console.error(`mind: ${refusalLine(subject.id, "memory", allowed.reason)}`);
    return 1;
  }
  const agentDir = resolve(dir);
  const now = new Date();
  let converted: Converted;
  let source: string;
  try {
    if (url !== undefined) {
      const got = await convertUrl(url, fetch, tmpdir());
      converted = got;
      source = got.url;
    } else {
      const name = options.get("name") ?? from!;
      converted = await convertFile(from!, name.split(/[\\/]/).pop()!, tmpdir());
      source = name.split(/[\\/]/).pop()!;
    }
  } catch (error) {
    console.error(`mind: not imported — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  let parts;
  try {
    parts = await planImport(converted, source, now, (path) => Bun.file(join(agentDir, ...path.split("/"))).exists(), options.get("as"));
  } catch (error) {
    console.error(`mind: not imported — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const plans: { plan: WritePlan; text: string }[] = [];
  for (const part of parts) plans.push({ plan: await planWrite(agentDir, part.path, part.text), text: part.text });
  console.log(bold(`${converted.title} — ${source}`));
  console.log(`read ${converted.via} · ${parts.length} memory file(s)`);
  for (const { plan } of plans) console.log(`  ${plan.refusal === undefined ? "new" : "REFUSED"} ${plan.path} · ${plan.bytesAfter} bytes${plan.refusal === undefined ? "" : ` — ${plan.refusal}`}`);
  const refused = plans.filter((p) => p.plan.refusal !== undefined);
  if (refused.length > 0) {
    console.error(`mind: not imported — ${refused.length} part(s) refused above; nothing was written.`);
    return 1;
  }
  if (!options.has("yes")) {
    console.log(dim("Nothing was written. --yes writes it and rebuilds both indexes."));
    return 0;
  }
  for (const { plan, text } of plans) await commitWrite(agentDir, plan, text);
  const report = await indexAgent(agentDir, subject.id, endpointsOrReason(), {
    markerDir: ragDirFor(homedir(), process.env, subject.id),
    now: () => new Date(),
  });
  console.log(`imported · full-text ${report.fts} piece(s) · ${report.vectors.ok ? `vectors rebuilt whole, ${report.vectors.points} point(s)` : `vectors not rebuilt — ${report.vectors.reason}`}`);
  console.log(dim("Not staged and not committed. The original stays where it was; only the text came in."));
  return 0;
}

/**
 * `mind memory move` — a memory to another path, most often between the person's memory and knowledge
 * (D-090): `--to knowledge` keeps the name under memory/knowledge/, `--to memory` puts it in memory/notes/.
 * The same gates as write for the new path; the old file goes; both indexes are rebuilt once.
 */
async function cmdMemoryMove(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, WRITE_BOOLEANS);
  const dir = positional[0];
  const from = options.get("file");
  const rawTo = options.get("to");
  if (dir === undefined || dir === "" || positional.length > 1 || from === undefined || rawTo === undefined || rawTo === "") return usageError(MOVE_USAGE);
  const subject = subjectFrom(options.get("subject"), MOVE_USAGE);
  if (!subject.ok) return subject.code;
  const allowed = basisFor(await readBasis(basisDirFor(dialEnv(), subject.id)), "memory", new Date());
  if (!allowed.ok) {
    console.error(`mind: ${refusalLine(subject.id, "memory", allowed.reason)}`);
    return 1;
  }
  const to = rawTo === "knowledge" || rawTo === "memory" ? movedPath(from, rawTo) : rawTo;
  const agentDir = resolve(dir);
  const plan = await planMove(agentDir, from, to);
  if (plan.refusal !== undefined) {
    console.error(`mind: not moved — ${plan.refusal}`);
    return 1;
  }
  console.log(`move ${plan.from} → ${plan.to} (${memoryKind(plan.from)} → ${memoryKind(plan.to)}) · ${plan.write.bytesAfter} bytes`);
  if (!options.has("yes")) {
    console.log(dim("Nothing was moved. --yes moves it and rebuilds both indexes."));
    return 0;
  }
  await commitMove(agentDir, plan);
  const report = await indexAgent(agentDir, subject.id, endpointsOrReason(), {
    markerDir: ragDirFor(homedir(), process.env, subject.id),
    now: () => new Date(),
  });
  console.log(`moved · full-text ${report.fts} piece(s) · ${report.vectors.ok ? `vectors rebuilt whole, ${report.vectors.points} point(s)` : `vectors not rebuilt — ${report.vectors.reason}`}`);
  console.log(dim("Not staged and not committed: git still has it at the old path until you commit the move."));
  return 0;
}

/**
 * `mind memory who` — which memories mention a port, a service, a host, an env name or a path (D-092),
 * with the line each one mentions it on. Read-only; found by shape, no model and no index.
 */
async function cmdMemoryWho(argv: readonly string[]): Promise<number> {
  const { positional } = parseArgs(argv);
  const [dir, ...words] = positional;
  if (dir === undefined || dir === "" || words.length === 0) return usageError(WHO_USAGE);
  const hits = await whoMentions(resolve(dir), words.join(" "));
  if (hits.length === 0) {
    console.log(`nothing in memory mentions ${words.join(" ")}`);
    return 1;
  }
  for (const h of hits) {
    console.log(bold(`${h.type} ${h.value} — ${h.mentions.length} memor${h.mentions.length === 1 ? "y" : "ies"}`));
    for (const m of h.mentions) console.log(`  ${m.path}:${m.line}  ${dim(m.excerpt)}`);
  }
  return 0;
}

/**
 * `mind memory distill` — facts drawn out of memory by a local model, kept only when a person says yes
 * (D-093). The memory goes to a model on this machine and nowhere else; the draft, which quotes it, is kept
 * in the personal directory, outside git. What a yes becomes is written through the same gates as write.
 *
 *   distill <dir> --subject <id> [--from <memory/…>,…] [--model <m>] [--max-chunks <n>]
 *   distill show --subject <id> [--json] · distill decide <fact-id> --subject <id> (--yes | --no)
 *   distill adopt <dir> --subject <id> [--yes]
 */

const DISTILL_USAGE =
  "usage: mind memory distill <dir> --subject <id> [--from <memory/…>,…] [--model <m>] [--max-chunks <n>]\n" +
  "       mind memory distill show --subject <id> [--json]\n" +
  "       mind memory distill decide <fact-id> --subject <id> (--yes | --no)\n" +
  "       mind memory distill adopt <dir> --subject <id> [--yes]";

const DISTILL_DRAFTS = "knowledge";
const DISTILL_BOOLEANS: readonly string[] = ["yes", "no", "json"];

function distillSubject(options: ReadonlyMap<string, string>): { ok: true; id: SubjectId } | { ok: false; code: number } {
  const raw = options.get("subject");
  if (raw === undefined || raw === "") return { ok: false, code: usageError(DISTILL_USAGE) };
  try {
    return { ok: true, id: subjectId(raw) };
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
}

async function factDraftsDir(id: SubjectId, create: boolean): Promise<string | undefined> {
  const dir = create ? await ensurePersonalDir(dialEnv(), id) : await personalDir(dialEnv(), id);
  if (!dir.ok) return undefined;
  const path = join(dir.path, DISTILL_DRAFTS);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

async function saveFactDraft(dir: string, draft: FactDraft): Promise<string> {
  const path = join(dir, `${draft.id}.json`);
  await writeFile(`${path}.${process.pid}`, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.${process.pid}`, path);
  return path;
}

/** The newest draft. */
async function loadFactDraft(id: SubjectId): Promise<{ ok: true; draft: FactDraft; dir: string } | { ok: false; reason: string }> {
  const dir = await factDraftsDir(id, false);
  if (dir === undefined) return { ok: false, reason: "the personal directory cannot be resolved" };
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    // None yet.
  }
  const drafts: FactDraft[] = [];
  for (const name of names) {
    try {
      drafts.push(JSON.parse(await readFile(join(dir, name), "utf8")) as FactDraft);
    } catch {
      // An unreadable draft is not one to answer.
    }
  }
  drafts.sort((a, b) => b.at.localeCompare(a.at));
  const draft = drafts[0];
  if (draft === undefined) return { ok: false, reason: "no facts drafted yet — run `mind memory distill <dir> --subject <id>` first" };
  return { ok: true, draft, dir };
}

const describeFact = (f: Fact) => `[${f.id}] (${f.topic}) ${f.fact}\n    “${f.quote}” — ${f.source.path}:${f.source.line}${f.decision === null ? "" : ` · ${f.decision}`}`;

async function cmdDistillDraft(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, DISTILL_BOOLEANS);
  const s = distillSubject(options);
  if (!s.ok) return s.code;
  const dir = positional[0];
  if (dir === undefined || positional.length > 1) return usageError(DISTILL_USAGE);
  // Facts come out of the subject's memory and go back into it: the basis for memory (S7.3).
  const allowed = basisFor(await readBasis(basisDirFor(dialEnv(), s.id)), "memory", new Date());
  if (!allowed.ok) {
    console.error(`mind: ${refusalLine(s.id, "memory", allowed.reason)}`);
    return 1;
  }
  const model = options.get("model") || readMind(OLLAMA_MODEL_ENV, process.env)?.trim() || "";
  if (model === "") return usageError(`name the local model: --model <m>, or set ${OLLAMA_MODEL_ENV}`);
  // Memory is the owner's: only a model on this machine may read it.
  const backend = new OllamaExec({ defaultModel: model });
  const local = asLocal(backend);
  if (local === undefined) {
    console.error(`mind: the model must be on this machine — ${backend.host} is not a loopback address, so nothing was read to it.`);
    return 1;
  }
  const maxChunks = Number(options.get("max-chunks") ?? "20");
  if (!Number.isInteger(maxChunks) || maxChunks < 1) return usageError(`${DISTILL_USAGE}\n--max-chunks is a positive number`);
  // By default the knowledge brought in — documents are where facts are thickest — never facts already drawn.
  const from = (options.get("from") ?? KNOWLEDGE_DIR).split(",").map((p) => p.trim().replace(/\/$/, "")).filter((p) => p !== "");
  const agentDir = resolve(dir);
  const files = (await listMemories(agentDir)).filter((m) => from.some((f) => m.path === f || m.path.startsWith(`${f}/`)) && !m.path.startsWith(`${FACTS_DIR}/`));
  if (files.length === 0) {
    console.error(`mind: no memory under ${from.join(", ")} to read.`);
    return 1;
  }
  const chunks = [];
  for (const f of files) {
    const read = await readMemoryFile(agentDir, f.path);
    if (read.ok) chunks.push(...factChunks(f.path, read.text));
  }
  const reading = chunks.slice(0, maxChunks);
  console.error(dim(`mind: ${files.length} memory file(s), ${chunks.length} piece(s)${chunks.length > maxChunks ? ` — reading the first ${maxChunks} (--max-chunks)` : ""}, to ${model} at ${backend.host}`));
  const seen = new Set<string>();
  const facts: Fact[] = [];
  let cut = 0;
  for (const [i, chunk] of reading.entries()) {
    const { system, user } = distillPrompt(chunk);
    const result = await local.run({ subject: s.id, prompt: user, system, restraint: probeRestraint() });
    if (result.confidence === "silent" || result.confidence === "failed") {
      console.error(dim(`  ${i + 1}/${reading.length} ${chunk.label}:${chunk.line} — no answer (${result.confidence})`));
      continue;
    }
    const checked = checkFacts(readFacts(result.text), chunk, seen);
    facts.push(...checked.facts);
    cut += checked.cut;
    console.error(dim(`  ${i + 1}/${reading.length} ${chunk.label}:${chunk.line} — ${checked.facts.length} fact(s)${checked.cut > 0 ? `, ${checked.cut} cut (quote not in the note)` : ""}`));
  }
  const draft: FactDraft = { v: 1, id: crypto.randomUUID(), at: new Date().toISOString(), subject: s.id, model, sources: files.map((f) => f.path), chunks: reading.length, cut, facts };
  const store = await factDraftsDir(s.id, true);
  if (store === undefined) {
    console.error("mind: the personal directory cannot be resolved; nothing was kept.");
    return 1;
  }
  const path = await saveFactDraft(store, draft);
  console.log(bold(`${facts.length} fact(s) drafted, each quoting its note · ${cut} cut as not in the note`));
  console.log(dim(`Kept at ${path} (personal, outside git). Nothing is in memory yet: answer them on the web page, or \`mind memory distill decide <id> --subject ${s.id} --yes\`.`));
  return 0;
}

async function cmdDistillShow(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv, DISTILL_BOOLEANS);
  const s = distillSubject(options);
  if (!s.ok) return s.code;
  const found = await loadFactDraft(s.id);
  if (!found.ok) {
    if (options.has("json")) {
      console.log(JSON.stringify({ draft: null, reason: found.reason }));
      return 0;
    }
    console.error(`mind: ${found.reason}`);
    return 1;
  }
  if (options.has("json")) {
    console.log(JSON.stringify({ draft: found.draft }));
    return 0;
  }
  const d = found.draft;
  console.log(bold(`${d.facts.length} fact(s) from ${d.sources.length} note(s) · ${d.model} · ${d.at.slice(0, 16)} · ${d.cut} cut`));
  for (const f of d.facts) console.log(describeFact(f));
  return 0;
}

async function cmdDistillDecide(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, DISTILL_BOOLEANS);
  const s = distillSubject(options);
  if (!s.ok) return s.code;
  const id = positional[0];
  if (id === undefined || options.has("yes") === options.has("no")) return usageError(DISTILL_USAGE);
  const found = await loadFactDraft(s.id);
  if (!found.ok) {
    console.error(`mind: ${found.reason}`);
    return 1;
  }
  const fact = found.draft.facts.find((f) => f.id === id);
  if (fact === undefined) {
    console.error(`mind: no fact ${id} in the newest draft.`);
    return 1;
  }
  const decision = options.has("yes") ? "yes" : "no";
  await saveFactDraft(found.dir, { ...found.draft, facts: found.draft.facts.map((f) => (f.id === id ? { ...f, decision } : f)) });
  console.log(`${decision} — ${fact.fact}`);
  return 0;
}

async function cmdDistillAdopt(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, DISTILL_BOOLEANS);
  const s = distillSubject(options);
  if (!s.ok) return s.code;
  const dir = positional[0];
  if (dir === undefined) return usageError(DISTILL_USAGE);
  const allowed = basisFor(await readBasis(basisDirFor(dialEnv(), s.id)), "memory", new Date());
  if (!allowed.ok) {
    console.error(`mind: ${refusalLine(s.id, "memory", allowed.reason)}`);
    return 1;
  }
  const found = await loadFactDraft(s.id);
  if (!found.ok) {
    console.error(`mind: ${found.reason}`);
    return 1;
  }
  const agentDir = resolve(dir);
  const now = new Map<string, string>();
  for (const f of await listMemories(agentDir)) {
    if (!f.path.startsWith(`${FACTS_DIR}/`)) continue;
    const read = await readMemoryFile(agentDir, f.path);
    if (read.ok) now.set(f.path, read.text);
  }
  const notes = factNotes(found.draft, (p) => now.get(p), new Date());
  if (notes.length === 0) {
    console.log("No yes that is not already written — nothing to add.");
    return 0;
  }
  const plans = [];
  for (const n of notes) plans.push({ note: n, plan: await planWrite(agentDir, n.path, n.text) });
  for (const { note, plan } of plans) console.log(`${plan.refusal === undefined ? plan.kind : "REFUSED"} ${note.path} · +${note.added} fact(s)${plan.refusal === undefined ? "" : ` — ${plan.refusal}`}`);
  if (plans.some((p) => p.plan.refusal !== undefined)) {
    console.error("mind: nothing was written — a note above was refused.");
    return 1;
  }
  if (!options.has("yes")) {
    console.log(dim("Nothing was written. --yes writes these and rebuilds both indexes."));
    return 0;
  }
  for (const { note, plan } of plans) await commitWrite(agentDir, plan, note.text);
  const checked = vectorEndpoints(process.env);
  const report = await indexAgent(agentDir, s.id, checked.ok ? checked.endpoints : { reason: checked.reason }, { markerDir: ragDirFor(homedir(), process.env, s.id), now: () => new Date() });
  console.log(`written · full-text ${report.fts} piece(s) · ${report.vectors.ok ? `vectors rebuilt whole, ${report.vectors.points} point(s)` : `vectors not rebuilt — ${report.vectors.reason}`}`);
  console.log(dim("Not staged and not committed."));
  return 0;
}

async function cmdDistill(argv: readonly string[]): Promise<number> {
  const [first, ...rest] = argv;
  switch (first) {
    case "show":
      return cmdDistillShow(rest);
    case "decide":
      return cmdDistillDecide(rest);
    case "adopt":
      return cmdDistillAdopt(rest);
    case undefined:
      return usageError(DISTILL_USAGE);
    default:
      return cmdDistillDraft(argv);
  }
}

/**
 * `mind memory ask` — a question answered from the agent's memory, as a summary with its sources (D-152).
 *
 * The same machinery as a turn, as far as it goes, so an ask is accounted for exactly as a turn is: the same
 * recall (`recall` in "any" mode, `RECALL_HITS`, the 4,500-character ceiling), the same D-095 split (a backend
 * on this machine is handed every piece, a cloud backend only the pieces the egress filter passes), the same
 * route rule, the same egress door (`AnnouncedExec`: the filter, the optional local judge, the block log), the
 * same ledger line per backend handed the question (`RecordingExec`, priced as a turn is), and a run record
 * so `mind stop` reaches an ask in progress.
 *
 * What differs is what an ask is allowed to be:
 *
 * - **No tools at all, whatever the dial says.** Nothing is done, so the dial is not asked and no proposal is
 *   filed (D-152); the chain runs under {@link probeRestraint} — read-only flags, never a grant — and admits only
 *   backends whose read-only flags leave no tool (`noToolsWhenRestrained`: claude's `--tools ""`, so claude and
 *   claude-local) or that have none (ollama). Read-only is not enough: grok's read tools read `~/.secrets` as
 *   readily as `memory/`, and a memory note can ask them to (review of PR #14, proven with a canary).
 * - **Only pieces about the question** (`relevantForAsk`): recall's nearest are not all near. None left = no model.
 * - **A stop that is ignored is enforced:** the deadline or SIGTERM aborts the chain, and `CliExec` ends the vendor's
 *   tree — SIGKILL for what outlives its SIGTERM (D-044) — before the ask returns.
 * - **Only backends that can be handed the pieces.** A vendor whose only identity channel is a file it reads
 *   (`identityStrength` not `system`) would answer without the recalled pieces at all, which is an invented
 *   answer; it is left out of the chain and said so.
 * - **No model when recall finds nothing.** The engine says "nothing in memory about this" itself.
 * - **Sources from what was handed**, not from what the model wrote (`sourcesOf`).
 * - **The question is never a flag.** Everything after a bare `--` is the question, word for word, so a
 *   question that begins with `-` (or is `--json`) is asked, not parsed — the web route always passes it so.
 */

const ASK_USAGE =
  "usage: mind memory ask <agent-dir> --subject <id> [--scope all|memory|knowledge] " +
  "[--backend a,b,c] [--route auto|local|cloud] [--model <m> | --model <backend>=<m>,…] [--private] [--json] [--] <question...>";

const ASK_BOOLEANS: readonly string[] = ["json", "private"];

type AskRequest = Parameters<AnnouncedExec["run"]>[0];

/** What `--json` prints — the API's contract (D-152) plus what the page's toggle and badge read. */
interface AskJson {
  readonly ok: boolean;
  readonly answer: string;
  readonly sources: readonly AskSource[];
  readonly found: number;
  readonly backend: string | null;
  readonly model: string | null;
  readonly local: boolean;
  readonly held: number;
  readonly read: number;
  readonly pieces: readonly AskPiece[];
  readonly searched: boolean;
  readonly error?: string;
}

async function cmdMemoryAsk(argv: readonly string[]): Promise<number> {
  // A bare `--` ends the options: what follows is the question, even when it looks like a flag.
  const end = argv.indexOf("--");
  const { positional, options } = parseArgs(end === -1 ? argv : argv.slice(0, end), ASK_BOOLEANS);
  const [dir, ...words] = end === -1 ? positional : [...positional, ...argv.slice(end + 1)];
  const asJson = options.has("json");
  if (dir === undefined || dir === "" || words.length === 0) return usageError(ASK_USAGE);
  const question = words.join(" ");
  const problem = askProblem(question);
  if (problem !== undefined) return usageError(`${problem}. Nothing was read or sent.`);
  const rawSubject = options.get("subject");
  if (rawSubject === undefined || rawSubject === "") return usageError(ASK_USAGE);
  let id: SubjectId;
  try {
    id = subjectId(rawSubject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const scope = (options.get("scope") ?? "all") as Scope;
  if (!SCOPES.includes(scope)) return usageError(`${ASK_USAGE} — --scope is ${SCOPES.join(", ")}`);
  const routePreference = parseRoutePreference(options.get("route"));
  if (routePreference === undefined) return usageError("--route must be one of auto, local or cloud");
  const named = (options.get("backend") ?? "").split(",").map((p) => p.trim()).filter((p) => p !== "");
  for (const name of named) {
    if (!isKnownBackend(name) && !isLocalCliId(name)) return usageError(`unknown backend ${JSON.stringify(name)}`);
  }
  const modelRaw = options.get("model");
  const modelCheck = routeModels(modelRaw, named.length > 0 ? named : [...PHASE_A_BACKENDS]);
  if (!modelCheck.ok) return usageError(`${modelCheck.reason}. Nothing was sent.`);

  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);
  const soulDir = await resolveSoulDir(dir);
  const agentDir = resolve(soulDir === dir ? dirname(dir) : dir);

  const fail = (code: number, error: string, searched = true): number => {
    if (asJson) {
      const out: AskJson = { ok: false, answer: "", sources: [], found: 0, backend: null, model: null, local: false, held: 0, read: 0, pieces: [], searched, error };
      console.log(JSON.stringify(out));
    }
    console.error(`mind: ${error}`);
    return code;
  };

  // The recall a turn makes — "any" word, RECALL_HITS, the turn's ceiling — narrowed to the scope asked.
  const checked = vectorEndpoints(process.env);
  const found = await recall(agentDir, id, question, RECALL_HITS, checked.ok ? checked.endpoints : { reason: checked.reason }, undefined, "any", scope);
  if (found.vector !== "ok") console.error(dimErr(`mind: recall: vector half skipped — ${found.vector.failed}`));
  if (found.fts === "absent" && found.vector !== "ok") {
    // `memory search`'s exit 3: neither index could be asked, so "nothing in memory" would claim a search that never ran.
    return fail(3, `nothing searched — no ${FTS_FILE} (run \`mind memory index\`) and no vector store answered. Nothing was sent.`, false);
  }

  const { lexicon } = await loadLexicon(dialEnv(), id, loaded.soul.person.inherits_from);
  const clean = (text: string) => screen(text, lexicon).length === 0;
  // Only what is about the question (ASK_COSINE_FLOOR, ASK_FTS_MIN_TERMS): recall's nearest pieces are not all near.
  const relevant = relevantForAsk(found.hits, question);
  if (relevant.length < found.hits.length) console.error(dimErr(`mind: recall: ${found.hits.length - relevant.length} of ${found.hits.length} piece(s) left out as not about this question`));
  const split = splitForCloud(relevant, DEFAULT_RECALL_CHARS, clean);
  // Numbers only — so the cosine floor can be re-checked on this memory (`personal/…/ask/recall.jsonl`).
  const logged = await appendAskRecall(dialEnv(), id, askRecallRecord({ at: new Date(), scope, hits: found.hits, vector: found.vector === "ok", kept: relevant.length, handed: split.local.attached.length }));
  if (!logged.ok) console.error(dimErr(`mind: this ask's recall numbers were not kept: ${logged.reason}`));

  if (split.local.attached.length === 0) {
    // Nothing recalled: no model is asked, and nothing is written to the ledger — nothing was sent.
    console.error(dimErr("mind: recall found nothing for this question; no model was asked."));
    const answer = nothingInMemory(question);
    if (asJson) {
      const out: AskJson = { ok: true, answer, sources: [], found: 0, backend: null, model: null, local: false, held: 0, read: 0, pieces: [], searched: true };
      console.log(JSON.stringify(out));
    } else {
      console.log(answer);
    }
    return 0;
  }
  console.error(dimErr(`mind: recall: ${split.local.attached.length} piece(s)${split.held > 0 ? ` · ${split.held} stay on this machine — a cloud backend gets the rest` : ""}`));

  // Asked before anything is sent, as a turn asks it (S2.2, D-145).
  const ledger = ledgerEnv();
  const writable = await canAppend(ledger, id);
  if (!writable.ok) return fail(1, `${writable.reason} Nothing was sent. ${writable.remedy}`);

  // The route a turn would take, for a turn that does not act (D-095, S12.3).
  const localReady = await Promise.all(LOCAL_BACKENDS.map((b) => buildBackend(b).available()));
  const localAvailable = LOCAL_CLI_SEES_PERSONAL && fenceSupport().ok && localReady.some((a) => a.ok);
  const route = named.length > 0
    ? { prefer: named.some(isLocalCliId) ? "local" : "cloud", reason: "You named the backend chain, so automatic routing did not change it." }
    : chooseRoute({ held: split.held, acting: false, preference: routePreference, localAvailable });
  const wanted = named.length > 0 ? named : route.prefer === "local" ? [...LOCAL_BACKENDS, ...PHASE_A_BACKENDS] : [...PHASE_A_BACKENDS];
  const routed = routeModels(modelRaw, wanted);
  if (!routed.ok) return usageError(`${routed.reason}. Nothing was sent.`);
  console.error(dimErr(`mind: route: ${route.reason}`));

  // Only a backend that can be handed the pieces, and that has no tools at all, may answer from them.
  const built = wanted.map((backendId) => {
    const own = routed.models.get(backendId);
    return { backendId, raw: buildBackend(backendId, own === undefined ? {} : { model: own }) };
  });
  const whyNot = (backendId: string, raw: (typeof built)[number]["raw"]): string | undefined => {
    if (raw.identityStrength !== "system") return "it has no system-prompt channel, so it could not be handed the recalled pieces and would answer without them";
    if (raw instanceof OllamaExec) return undefined;
    const spec = vendor(isLocalCliId(backendId) ? localBaseVendor(backendId) : backendId);
    return noToolsWhenRestrained(spec.readOnly) ? undefined : "even read-only it keeps tools that read files, and a memory note could point them anywhere";
  };
  const usable = built.filter((b) => whyNot(b.backendId, b.raw) === undefined);
  for (const left of built) {
    const why = whyNot(left.backendId, left.raw);
    if (why !== undefined) console.error(dimErr(`mind: ${left.backendId} is left out of this ask — ${why}.`));
  }
  if (usable.length === 0) return fail(1, "no backend in this chain can answer an ask — it needs one that is handed the pieces and has no tools: claude, claude-local or ollama. Nothing was sent.");

  const soulText = renderSoul(loaded.soul);
  const turnId = crypto.randomUUID();
  const prices = await loadPrices(ledger.home, ledger.env);
  if (prices.owner.state === "unusable") {
    console.error(`mind: the price file ${printable(prices.ownerPath)} cannot be used — ${printable(prices.owner.reason)}. This ask is recorded as not charged (table-unusable).`);
  }
  const writeFailures: Error[] = [];
  // D-181: the same rule a turn follows — the judge is on when one is named or a local model is configured, and a
  // prompt that leaves without it is announced as screened by the filter alone, every time.
  const judge = resolveJudgeMode("cloud-turn", process.env);
  const blocked: Promise<void>[] = [];
  const modelRun = new Map<string, string | null>();
  /** The pieces each backend was handed, by id — what its answer's sources are. */
  const handed = new Map<string, Attachment>();
  // An empty working directory: a vendor's read-only tools see nothing of wherever this was started.
  const cwd = await mkdtemp(join(tmpdir(), "mind-ask-"));
  // Made before the chain, so a step reached after the deadline or a stop is not started at all.
  const controller = new AbortController();

  const chain = turnChain(
    usable.map(({ backendId, raw }) => {
      const localCli = raw instanceof LocalCliExec ? raw : undefined;
      const ran = localCli !== undefined ? LOCAL_MODEL : raw instanceof OllamaExec ? (raw.defaultModel ?? null) : null;
      modelRun.set(backendId, ran);
      const announced = new AnnouncedExec(
        new RecordingExec(raw, {
          ledger,
          turnId,
          newId: () => crypto.randomUUID(),
          content: options.has("private") ? "withheld" : "full",
          model: ran,
          prices,
          soulSha: sha256(soulText),
          onWriteFailure: (error) => writeFailures.push(error),
        }),
        {
          origin: raw,
          write: (line) => console.error(dimErr(line)),
          // D-048: the question and everything in the system prompt are screened before anything leaves.
          screen: (request) => screen(`${request.prompt}\n${request.system ?? ""}`, lexicon),
          ...judgeLayer<Parameters<AnnouncedExec["run"]>[0]>(
            judge,
            lexicon.needles,
            (request) => judgeInput(request.prompt, split.cloud.block),
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
        },
      );
      return withRun(announced, (request, run) => {
        // Locality is decided on the request as it will run — a local CLI's fence is part of it (D-123).
        const prepared = localCli === undefined ? request : localCli.prepare(request);
        const local = asLocal(raw, localCli === undefined ? undefined : prepared) !== undefined;
        const attachment = local ? split.local : split.cloud;
        if (controller.signal.aborted) return Promise.resolve(notAsked(backendId, request.prompt, "not asked: the ask was stopped, or ran out of time, before this step"));
        if (attachment.attached.length === 0) {
          // Every recalled piece is held from this backend (D-095): it is not asked a question it cannot see the answer to.
          return Promise.resolve(notAsked(backendId, request.prompt));
        }
        handed.set(backendId, attachment);
        return run({ ...prepared, system: askSystem(soulText, attachment, question) });
      });
    }),
  );

  // `mind stop` finds an ask in progress by this record, as it finds a turn.
  let runRecordPath: string | undefined;
  try {
    runRecordPath = await writeRunRecord(dialEnv(), describeRun({ turnId, subject: id, backends: usable.map((b) => b.backendId), at: new Date() }));
  } catch (error) {
    console.error(`mind: could not write the run record (${String(error)}); \`mind stop\` will not find this ask.`);
  }
  // A deadline sized for a model on this machine (ASK_TIMEOUT_MS), and SIGTERM — the web page's own deadline, or
  // `mind stop` — ends the backend's process group the way its own timeout does, rather than orphaning it.
  // The abort reaches each vendor CLI through `request.signal`: `CliExec` ends its whole tree with SIGTERM and,
  // for whatever is still there after D-044's grace, SIGKILL — and returns only once that is over (PR #12).
  const deadline = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
  const onTerm = () => controller.abort();
  process.once("SIGTERM", onTerm);
  let result: TurnResult;
  try {
    result = await chain.run({ subject: id, prompt: question, restraint: probeRestraint(), cwd, timeoutMs: ASK_TIMEOUT_MS, signal: controller.signal });
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGTERM", onTerm);
    if (runRecordPath !== undefined) await removeRunRecord(runRecordPath);
    await rm(cwd, { recursive: true, force: true });
  }
  await Promise.all(blocked);

  const answered = result.confidence === "confirmed" || result.confidence === "partial";
  const trail = fallbackTrail(result.evidence.raw);
  for (const failure of writeFailures) console.error(`mind: ledger write failed: ${failure.message}`);
  if (!answered) {
    const why = controller.signal.aborted ? `no answer within ${ASK_TIMEOUT_MS / 1000} s, or it was stopped` : `no backend answered${trail === undefined ? "" : ` — ${trail}`}`;
    return fail(1, `${why}.`);
  }
  console.error(dimErr(`mind: answered by ${result.backend}${trail === undefined ? "" : ` · missed: ${trail}`}`));

  const attachment = handed.get(result.backend) ?? split.cloud;
  const read = readAnswer(result.text, attachment.attached.map((a) => a.path), question);
  const titles = new Map<string, string>();
  for (const path of new Set(attachment.attached.map((a) => a.path))) {
    const file = await readMemoryFile(agentDir, path);
    if (file.ok) titles.set(path, memoryMeta(path, file.text).title);
  }
  const aboutModel = modelOfTurn(result.evidence.model, null, modelRun.get(result.backend) ?? null);
  const sources = read.covered ? sourcesOf(attachment, titles, read.answer) : [];
  const out: AskJson = {
    ok: writeFailures.length === 0,
    answer: read.covered ? read.answer : nothingInMemory(question),
    sources,
    // How many pieces the answer drew on; 0 when the model found nothing about this in what it read.
    found: read.covered ? attachment.attached.length : 0,
    backend: result.backend,
    model: aboutModel.model,
    local: isLocalBackend(result.backend),
    held: attachment === split.local ? 0 : split.held,
    read: attachment.attached.length,
    pieces: piecesOf(relevant, attachment),
    searched: true,
    ...(writeFailures.length > 0 ? { error: `answered, and the ledger did not record it (${writeFailures.length} line(s))` } : {}),
  };
  if (asJson) {
    console.log(JSON.stringify(out));
  } else {
    console.log(out.answer);
    if (sources.length > 0) {
      console.log("");
      console.log(bold("Sources:"));
      for (const s of sources) console.log(`  ${s.path}${s.section === undefined ? "" : ` — ${s.section}`}${s.title === undefined ? "" : dim(`  (${s.title})`)}`);
    }
  }
  return writeFailures.length > 0 ? 1 : 0;
}

/** A result that says this backend was not asked, so the chain moves on — no line, no announcement. */
function notAsked(backendId: string, prompt: string, raw = `not asked: every recalled piece is held from ${backendId} (personal words or contact details, D-095)`): TurnResult {
  return {
    backend: backendId,
    text: "",
    confidence: "failed",
    identityStrength: "none",
    evidence: { source: backendId, prompt, raw, usage: UNREPORTED_USAGE },
  };
}

/** The same backend, with its `run` decided by `decide` — which may call the real one or answer itself. */
function withRun<T extends { run: (request: AskRequest) => Promise<TurnResult> }>(
  exec: T,
  decide: (request: AskRequest, run: (request: AskRequest) => Promise<TurnResult>) => Promise<TurnResult>,
): T {
  return new Proxy(exec, {
    get(target, key, receiver) {
      if (key === "run") return (request: AskRequest) => decide(request, (r) => target.run(r));
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function cmdMemory(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "index":
      return cmdMemoryIndex(rest);
    case "search":
      return cmdMemorySearch(rest);
    case "ask":
      return cmdMemoryAsk(rest);
    case "ingest":
      return cmdMemoryIngest(rest);
    case "forget":
      return cmdMemoryForget(rest);
    case "write":
      return cmdMemoryWrite(rest);
    case "import":
      return cmdMemoryImport(rest);
    case "move":
      return cmdMemoryMove(rest);
    case "who":
      return cmdMemoryWho(rest);
    case "distill":
      return cmdDistill(rest);
    default:
      return usageError(`unknown memory subcommand ${JSON.stringify(sub ?? "")} — try "ingest", "index", "search", "ask", "write" or "forget"`);
  }
}
