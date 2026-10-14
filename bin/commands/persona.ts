/**
 * `mind persona` — draft a soul from real artifacts, and adopt only what the
 * owner says yes to (S6.1, D-072).
 *
 *   extract <dir> --from <path,…>   a local model proposes claims; each must quote its source
 *   review <dir>                    answer yes or no, one claim at a time, at a terminal
 *   show                            the drafts, and what was decided
 *   adopt <dir> [--yes]             write the yeses into role.md / person.md
 *
 * The artifacts go to a model on this machine and nowhere else; the draft,
 * which quotes them, is kept in the personal directory, outside git.
 */

import { readMind } from "../../src/env.ts";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isatty } from "node:tty";
import { join } from "node:path";
import { OLLAMA_MODEL_ENV, OllamaExec } from "../../src/exec/ollama-exec.ts";
import { asLocal } from "../../src/exec/local.ts";
import { probeRestraint } from "../../src/exec/restraint.ts";
import { ensurePersonalDir, personalDir } from "../../src/guard/personal.ts";
import { adoptClaims, checkClaims, chunkArtifact, collectArtifacts, describeClaim, extractPrompt, readClaims, type Claim, type Draft } from "../../src/soul/extract.ts";
import { loadSoul, parseSoul, resolveSoulDir } from "../../src/soul/load.ts";
import { PERSON_FILE, ROLE_FILE } from "../../src/soul/schema.ts";
import { serializePerson, serializeRole } from "../../src/soul/serialize.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { basisDirFor, basisFor, readBasis, refusalLine } from "../../src/consent/basis.ts";
import { dialEnv } from "../dial.ts";
import { bold, dim, parseArgs, readTerminalLine, report, usageError } from "../shared.ts";

const USAGE =
  "usage: mind persona extract <dir> --subject <id> --from <path,…> [--model <m>] [--max-chunks <n>]\n" +
  "       mind persona review <dir> --subject <id> [--draft <id>]\n" +
  "       mind persona show --subject <id> [--draft <id>] [--json]\n" +
  "       mind persona decide <claim-id> --subject <id> (--yes | --no) [--draft <id>]\n" +
  "       mind persona adopt <dir> --subject <id> [--draft <id>] [--yes]";

const DRAFTS = "persona";

function subjectOf(options: ReadonlyMap<string, string>): { ok: true; id: SubjectId } | { ok: false; code: number } {
  const raw = options.get("subject");
  if (raw === undefined || raw === "") return { ok: false, code: usageError(USAGE) };
  try {
    return { ok: true, id: subjectId(raw) };
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
}

async function draftsDir(id: SubjectId, create: boolean): Promise<string | undefined> {
  const dir = create ? await ensurePersonalDir(dialEnv(), id) : await personalDir(dialEnv(), id);
  if (!dir.ok) return undefined;
  const path = join(dir.path, DRAFTS);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

async function saveDraft(dir: string, draft: Draft): Promise<string> {
  const path = join(dir, `${draft.id}.json`);
  await writeFile(`${path}.${process.pid}`, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.${process.pid}`, path);
  return path;
}

/** The named draft, or the newest. */
async function loadDraft(id: SubjectId, wanted: string | undefined): Promise<{ ok: true; draft: Draft; dir: string } | { ok: false; reason: string }> {
  const dir = await draftsDir(id, false);
  if (dir === undefined) return { ok: false, reason: "the personal directory cannot be resolved" };
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    // None yet.
  }
  const drafts: Draft[] = [];
  for (const name of names) {
    try {
      drafts.push(JSON.parse(await readFile(join(dir, name), "utf8")) as Draft);
    } catch {
      // An unreadable draft is not one to answer.
    }
  }
  drafts.sort((a, b) => b.at.localeCompare(a.at));
  const draft = wanted === undefined ? drafts[0] : drafts.find((d) => d.id === wanted || d.id.startsWith(wanted));
  if (draft === undefined) return { ok: false, reason: wanted === undefined ? "no draft yet — run `mind persona extract` first" : `no draft ${wanted}` };
  return { ok: true, draft, dir };
}

async function cmdExtract(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const dir = positional[0];
  const from = (options.get("from") ?? "").split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (dir === undefined || from.length === 0) return usageError(USAGE);
  const loaded = await loadSoul(dir, s.id);
  if (!loaded.ok) return report(loaded.issues);
  // S7.3 (D-077): drafting a persona reads the subject's artifacts — it needs a basis for "persona".
  const allowed = basisFor(await readBasis(basisDirFor(dialEnv(), s.id)), "persona", new Date());
  if (!allowed.ok) {
    console.error(`mind: ${refusalLine(s.id, "persona", allowed.reason)}`);
    return 1;
  }
  const model = options.get("model") || readMind(OLLAMA_MODEL_ENV, process.env)?.trim() || "";
  if (model === "") return usageError(`name the local model: --model <m>, or set ${OLLAMA_MODEL_ENV}`);
  // The artifacts are the owner's: only a model on this machine may read them.
  const backend = new OllamaExec({ defaultModel: model });
  const local = asLocal(backend);
  if (local === undefined) {
    console.error(`mind: the model must be on this machine — ${backend.host} is not a loopback address, so nothing was read to it.`);
    return 1;
  }
  const maxChunks = Number(options.get("max-chunks") ?? "60");
  if (!Number.isInteger(maxChunks) || maxChunks < 1) return usageError(`${USAGE} — --max-chunks is a positive number`);

  const { artifacts, skipped } = await collectArtifacts(from);
  if (artifacts.length === 0) {
    console.error(`mind: nothing to read under ${from.join(", ")}${skipped.length > 0 ? ` (${skipped.length} skipped)` : ""}.`);
    for (const line of skipped.slice(0, 20)) console.error(dim(`  skipped ${line}`));
    return 1;
  }
  const chunks = artifacts.flatMap((a) => chunkArtifact(a));
  const reading = chunks.slice(0, maxChunks);
  console.error(dim(`mind: ${artifacts.length} artifact(s), ${chunks.length} piece(s)${chunks.length > maxChunks ? ` — reading the first ${maxChunks} (--max-chunks)` : ""}, to ${model} at ${backend.host}`));
  const seen = new Set<string>();
  const claims: Claim[] = [];
  let cut = 0;
  for (const [i, chunk] of reading.entries()) {
    const { system, user } = extractPrompt(chunk);
    const result = await local.run({ subject: s.id, prompt: user, system, restraint: probeRestraint() });
    if (result.confidence === "silent" || result.confidence === "failed") {
      console.error(dim(`  ${i + 1}/${reading.length} ${chunk.label}:${chunk.line} — no answer (${result.confidence})`));
      continue;
    }
    const checked = checkClaims(readClaims(result.text), chunk, seen);
    claims.push(...checked.claims);
    cut += checked.cut;
    console.error(dim(`  ${i + 1}/${reading.length} ${chunk.label}:${chunk.line} — ${checked.claims.length} claim(s)${checked.cut > 0 ? `, ${checked.cut} cut (quote not in the artifact)` : ""}`));
  }
  const draft: Draft = {
    v: 1,
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    subject: s.id,
    model,
    sources: artifacts.map((a) => a.label),
    chunks: reading.length,
    cut,
    skipped,
    claims,
  };
  const store = await draftsDir(s.id, true);
  if (store === undefined) {
    console.error("mind: the personal directory cannot be resolved; nothing was kept.");
    return 1;
  }
  const path = await saveDraft(store, draft);
  console.log(bold(`${claims.length} claim(s) drafted, each quoting its source · ${cut} cut as made up (AC2)`));
  const count = (f: string) => claims.filter((c) => c.field === f).length;
  console.log(`  role:   ${count("knowledge")} knowledge · ${count("does")} does · ${count("does_not")} does not · ${count("prohibition")} never`);
  console.log(`  person: ${count("principle")} principle · ${count("tone")} tone`);
  console.log(dim(`Kept at ${path} (personal, outside git). Nothing is in the soul yet: \`mind persona review ${dir} --subject ${s.id}\`.`));
  return 0;
}

async function cmdReview(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  if (positional[0] === undefined) return usageError(USAGE);
  const found = await loadDraft(s.id, options.get("draft"));
  if (!found.ok) {
    console.error(`mind: ${found.reason}`);
    return 1;
  }
  // AC4: the owner answers, line by line. A program cannot answer for them.
  if (!(process.stdin.isTTY === true && isatty(1))) {
    console.error("mind: review is answered at a terminal, one claim at a time.");
    return 1;
  }
  let draft = found.draft;
  const open = draft.claims.filter((c) => c.decision === null);
  console.log(bold(`${open.length} claim(s) to answer (y = true of the job · n = not · s = skip · q = stop)`));
  for (const [i, claim] of open.entries()) {
    console.log(`\n${i + 1}/${open.length} ${describeClaim(claim)}`);
    console.log("  true? y · n · s(kip) · q(uit)");
    const answer = (await readTerminalLine()).trim().toLowerCase();
    if (answer === "q") break;
    if (answer !== "y" && answer !== "n") continue;
    draft = { ...draft, claims: draft.claims.map((c) => (c.id === claim.id ? { ...c, decision: answer === "y" ? "yes" : "no" } : c)) };
    await saveDraft(found.dir, draft);
  }
  const yes = draft.claims.filter((c) => c.decision === "yes").length;
  const no = draft.claims.filter((c) => c.decision === "no").length;
  console.log(`\n${yes} yes · ${no} no · ${draft.claims.length - yes - no} unanswered. Write the yeses with \`mind persona adopt ${positional[0]} --subject ${s.id}\`.`);
  return 0;
}

async function cmdShow(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv, SHOW_BOOLEANS);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const found = await loadDraft(s.id, options.get("draft"));
  if (options.has("json")) {
    console.log(JSON.stringify(found.ok ? { draft: found.draft } : { draft: null, reason: found.reason }, null, 2));
    return 0;
  }
  if (!found.ok) {
    console.log(found.reason);
    return 0;
  }
  const d = found.draft;
  console.log(bold(`draft ${d.id.slice(0, 8)} · ${d.at} · ${d.model} · ${d.sources.length} artifact(s) · ${d.chunks} piece(s) read · ${d.cut} cut`));
  for (const c of d.claims) console.log(`${c.decision === "yes" ? "✓" : c.decision === "no" ? "✗" : "·"} ${describeClaim(c)}`);
  if (d.skipped.length > 0) console.log(dim(`${d.skipped.length} artifact(s) skipped: ${d.skipped.slice(0, 5).join(" · ")}${d.skipped.length > 5 ? " …" : ""}`));
  return 0;
}

const SHOW_BOOLEANS: readonly string[] = ["json"];
const DECIDE_BOOLEANS: readonly string[] = ["yes", "no"];

/**
 * `persona decide <claim-id> --yes|--no` — one answer, for the web page's
 * review (D-079). The same record `review` writes at a terminal; the owner's
 * key to the page is what stands between it and anyone else.
 */
async function cmdDecide(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, DECIDE_BOOLEANS);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const claimId = positional[0];
  const yes = options.has("yes");
  if (claimId === undefined || yes === options.has("no")) return usageError(USAGE);
  const found = await loadDraft(s.id, options.get("draft"));
  if (!found.ok) {
    console.error(`mind: ${found.reason}`);
    return 1;
  }
  if (!found.draft.claims.some((c) => c.id === claimId)) {
    console.error(`mind: no claim ${claimId} in draft ${found.draft.id.slice(0, 8)}`);
    return 1;
  }
  const draft: Draft = { ...found.draft, claims: found.draft.claims.map((c) => (c.id === claimId ? { ...c, decision: yes ? "yes" : "no" } : c)) };
  await saveDraft(found.dir, draft);
  console.log(`${claimId}: ${yes ? "yes" : "no"}`);
  return 0;
}

async function cmdAdopt(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, ["yes"]);
  const s = subjectOf(options);
  if (!s.ok) return s.code;
  const dir = positional[0];
  if (dir === undefined) return usageError(USAGE);
  const loaded = await loadSoul(dir, s.id);
  if (!loaded.ok) return report(loaded.issues);
  const found = await loadDraft(s.id, options.get("draft"));
  if (!found.ok) {
    console.error(`mind: ${found.reason}`);
    return 1;
  }
  const next = adoptClaims(loaded.soul.role, loaded.soul.person, found.draft);
  if (next.adopted === 0) {
    console.log("Nothing answered yes yet — nothing to write. `mind persona review` first.");
    return 0;
  }
  const roleText = serializeRole(next.role);
  const personText = serializePerson(next.person);
  // The result must still be a soul — the firewall (S6.4) and every other check run again.
  const checked = parseSoul(roleText, personText, s.id);
  if (!checked.ok) {
    console.error("mind: with these claims the soul would not load, so nothing was written:");
    return report(checked.issues);
  }
  const where = await resolveSoulDir(dir);
  const yes = found.draft.claims.filter((c) => c.decision === "yes");
  const roleCount = yes.filter((c) => ["knowledge", "does", "does_not", "prohibition"].includes(c.field)).length;
  console.log(`would write ${roleCount} claim(s) to ${join(where, ROLE_FILE)} and ${yes.length - roleCount} to ${join(where, PERSON_FILE)}`);
  for (const c of yes) console.log(dim(`  + [${c.field}] ${c.text} — ${c.source.label}:${c.source.line}`));
  if (!options.has("yes")) {
    console.log(dim("Nothing was changed. Run again with --yes to write it; then review the diff and commit it yourself."));
    return 0;
  }
  await writeFile(join(where, ROLE_FILE), roleText);
  await writeFile(join(where, PERSON_FILE), personText);
  console.log(bold(`Written. \`git diff\` in ${dir} shows it; nothing was committed.`));
  return 0;
}

export async function cmdPersona(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "extract":
      return cmdExtract(rest);
    case "review":
      return cmdReview(rest);
    case "show":
      return cmdShow(rest);
    case "adopt":
      return cmdAdopt(rest);
    case "decide":
      return cmdDecide(rest);
    default:
      return usageError(`unknown persona subcommand ${JSON.stringify(sub ?? "")}\n${USAGE}`);
  }
}
