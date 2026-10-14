/**
 * `mind soul` — check, import, apply and verify, and the dispatcher for them.
 *
 * The four stay in one file because they share `printPlan`, `describe`,
 * `verifyRow` and `printVerify`, and splitting them further would put those
 * helpers somewhere both halves import — a shared file again, one level down.
 */

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_A2A_URL, agentCard } from "../../src/a2a/index.ts";
import { enclosingGitRepo } from "../../src/agent/index.ts";
import { identityDirFor } from "../../src/identity/dir.ts";
import { readAgentKey } from "../../src/identity/key.ts";
import { PHASE_A_BACKENDS, backend as buildBackend, expandPath, routeModels } from "../../src/exec/index.ts";
import {
  DEFAULT_RUNS,
  LEVEL_LEGEND,
  PERSON_FILE,
  PROBES_PER_RUN,
  ROLE_FILE,
  backupRoot,
  beforeApply,
  commitApply,
  commitRevoke,
  contextInjectionNote,
  egressNote,
  importBwocAgent,
  isKnownBackend,
  loadImportMap,
  loadSoul,
  planApply,
  planRevoke,
  resolveTargets,
  serializeSoul,
  tally,
  type ApplyEnv,
  type ApplyPlan,
  type BackendReport,
  type TargetPlan,
  type VerifyReport,
  verifyEgressNote,
  verifyPasses,
  verifySoul,
  whichOnPath,
} from "../../src/soul/index.ts";
import { mapNonEmpty, nonEmpty, subjectId } from "../../src/types.ts";
import { parseSoul, resolveSoulDir } from "../../src/soul/load.ts";
import { applyProfile, changedFields, profileOf, readProfile } from "../../src/soul/profile.ts";
import { readFile, writeFile } from "node:fs/promises";
import { ENGINE_CHECKOUT, bold, dim, indent, parseArgs, report, usageError } from "../shared.ts";

/**
 * Refuse an `--out` that would put an imported identity somewhere git can see.
 *
 * An imported soul carries whatever the source agent carried — hostnames,
 * `~/…` paths, account names. I-4 says an owner can withdraw their data, and
 * git is the one place where that stops being true the moment a commit lands
 * (D-013). The repository guard exists now (S0.4), and it does not change this
 * answer: a pre-commit scan cannot see personal data written as prose, which is
 * the largest category an imported soul carries. So the only honest destination
 * is still a directory outside version control, and the guard's own blind-spot
 * list says why in the same words.
 *
 * The first of the two checks needs a checkout to compare against, and the
 * compiled binary has none — its modules are inside the executable. What
 * refuses an `--out` inside the engine there is the *second* check, because the
 * engine checkout is itself a git repository; an engine unpacked somewhere that
 * is not under version control has neither.
 *
 * @returns The reason to refuse, or undefined when the path is safe.
 */
async function unsafeOut(out: string): Promise<string | undefined> {
  const target = resolve(out);

  if (
    ENGINE_CHECKOUT !== undefined &&
    (target === ENGINE_CHECKOUT || target.startsWith(ENGINE_CHECKOUT + sep))
  ) {
    return `--out is inside the engine repository (${ENGINE_CHECKOUT}) — the engine carries no identity data (D-021)`;
  }

  const repo = await enclosingGitRepo(target);
  if (repo !== undefined) {
    return (
      `--out is inside the git repository at ${repo} — an imported soul holds host paths and account ` +
      `names, and git remembers what it is asked to forget (I-4). Pick a directory outside version control.`
    );
  }

  try {
    const entries = await readdir(target);
    if (entries.length > 0) return `--out is not empty (${target}) — refusing to write over it`;
  } catch {
    // Does not exist yet, which is the expected case.
  }

  return undefined;
}

/**
 * The flags `soul check` takes no value for — none, said once.
 *
 * Exported for the same reason as the two below it: `--as` has to read this
 * command's arguments well enough to notice a conflict, and it reads them with
 * {@link parseArgs}, which needs the same list. A copy of the list over in
 * `bin/as.ts` was a second answer to "does `--backend ollama` begin a value or a
 * positional?", kept in step by hand across two files. The list still lives
 * beside the command that owns it — adding a flag here cannot change how any
 * other command is parsed — it is just no longer written down twice.
 */
export const SOUL_CHECK_BOOLEANS: readonly string[] = [];

async function cmdSoulCheck(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, SOUL_CHECK_BOOLEANS);
  const dir = positional[0];
  const subject = options.get("subject");
  if (dir === undefined || subject === undefined || subject === "") {
    return usageError("usage: mind soul check <dir> --subject <id>");
  }

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);

  const { soul } = loaded;
  console.log(`${soul.role.name} — ${soul.role.role}`);
  console.log(
    dim(
      `subject ${soul.subject} · ${soul.role.prohibitions.length} prohibition(s) · ` +
        `${soul.person.principles.length} principle(s) · discloses it is an AI`,
    ),
  );
  return 0;
}

async function cmdSoulImport(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const agentDir = positional[0];
  const subject = options.get("subject");
  const mapPath = options.get("map");
  const out = options.get("out");
  if (
    agentDir === undefined ||
    subject === undefined ||
    subject === "" ||
    mapPath === undefined ||
    mapPath === "" ||
    out === undefined ||
    out === ""
  ) {
    return usageError(
      "usage: mind soul import <agent-dir> --subject <id> --map <file> --out <dir>",
    );
  }

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const refusal = await unsafeOut(out);
  if (refusal !== undefined) return usageError(refusal);

  const map = await loadImportMap(mapPath);
  if (!map.ok) return report(map.issues);

  const imported = await importBwocAgent(agentDir, id, map.map);
  if (imported.issues.length > 0 || imported.soul === undefined) {
    return report(
      imported.soul === undefined && imported.issues.length === 0
        ? [{ file: agentDir, line: 0, path: "", message: "could not be read as a bwoc agent" }]
        : imported.issues,
    );
  }

  const files = serializeSoul(imported.soul);
  await mkdir(out, { recursive: true });
  await Bun.write(join(out, ROLE_FILE), files.role);
  await Bun.write(join(out, PERSON_FILE), files.person);

  console.log(`wrote ${join(out, ROLE_FILE)} and ${join(out, PERSON_FILE)}`);
  for (const source of imported.skipped) console.log(dim(`skipped ${source} (map says skip)`));
  console.log(
    dim(
      `${imported.skipped.length} source file(s) skipped · ` +
        `nothing was written inside ${
          ENGINE_CHECKOUT === undefined
            ? "the engine"
            : relative(process.cwd(), ENGINE_CHECKOUT) || "the engine"
        }`,
    ),
  );
  return 0;
}

/** One line per target: what happens, where, and how big the change is. */
function describe(plan: TargetPlan): string {
  const where =
    plan.target.kind === "file" ? plan.target.path : "system prompt field (no file to write)";
  const size =
    plan.stat.added === 0 && plan.stat.removed === 0
      ? ""
      : `  (+${plan.stat.added} -${plan.stat.removed})`;
  const action = plan.action === "system-field" ? "per-turn" : plan.action;
  return `${plan.target.backend.padEnd(8)} ${action.padEnd(10)} ${where}${size}`;
}

/** Print the plan and every diff. Returns true when something was refused. */
function printPlan(plan: ApplyPlan): boolean {
  let refusals = false;

  for (const item of plan.plans) {
    console.log(describe(item));
    if (item.reason !== undefined) console.log(dim(`         ${item.reason}`));
    if (item.action === "refused") refusals = true;

    if (item.target.kind === "file") {
      if (item.target.alsoReadBy.length > 0) {
        console.log(dim(`         also read by ${item.target.alsoReadBy.join(", ")}`));
      }
      if (item.target.symlinkedFrom !== undefined) {
        console.log(dim(`         reached through a symlink at ${item.target.symlinkedFrom}`));
      }
      for (const other of item.target.alsoReads) {
        console.log(dim(`         also read by ${other.by}, not written: ${other.path}`));
      }
    }
    if (item.replacedSubject !== undefined) {
      console.log(dim(`         replaces the block of subject ${item.replacedSubject} (D-011)`));
    }
    // The difference this project refuses to flatten: a file is user-level
    // text a model may weigh less, a field is a real system prompt.
    if (item.action !== "skipped" && item.action !== "refused") {
      console.log(dim(`         arrives as ${item.target.strength}-level instructions`));
    }
  }

  for (const item of plan.plans) {
    if (item.diff === "") continue;
    console.log();
    console.log(item.diff);
  }

  return refusals;
}

/** How many targets really hold this soul, and how many were not written at all. */
function currentCount(plan: ApplyPlan): string {
  const current = plan.plans.filter((item) => item.action === "unchanged").length;
  const others = plan.plans.length - current;
  return (
    `${current} of ${plan.plans.length} target(s) already hold this identity` +
    (others === 0 ? "" : `; the other ${others} was not written — see the rows above`)
  );
}

/**
 * The sentence for a run where nothing was written and nothing is current.
 *
 * The all-`system-field` case is called out first and is not a complaint: a
 * machine whose only backend is ollama has no instruction file to write, the
 * identity travels in the system field of every request, and reading that
 * sentence as a failure would be reading the local route as one (I-1).
 */
function whyNone(plan: ApplyPlan): string {
  if (plan.plans.length === 0) return "there was no target at all";
  if (plan.plans.every((item) => item.action === "system-field")) {
    return (
      "no backend here reads an instruction file, so there is nothing to write — the identity " +
      "travels in the system field of every request instead"
    );
  }
  const counts = new Map<string, number>();
  for (const item of plan.plans) counts.set(item.action, (counts.get(item.action) ?? 0) + 1);
  return [...counts].map(([action, n]) => `${n} ${action}`).join(" · ");
}

/** The flags `soul apply` takes no value for. See {@link SOUL_CHECK_BOOLEANS}. */
export const SOUL_APPLY_BOOLEANS: readonly string[] = ["apply", "dry-run"];

async function cmdSoulApply(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, SOUL_APPLY_BOOLEANS);
  const dir = positional[0];
  const subject = options.get("subject");
  if (dir === undefined || subject === undefined || subject === "") {
    return usageError("usage: mind soul apply <dir> --subject <id> [--backend a,b] [--apply]");
  }

  const write = options.has("apply");
  if (write && options.has("dry-run")) {
    return usageError("--apply and --dry-run contradict each other; a dry run is the default");
  }

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const named = (options.get("backend") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  for (const backend of named) {
    if (!isKnownBackend(backend)) return usageError(`unknown backend ${JSON.stringify(backend)}`);
  }
  // `--backend ",,,"` parses to nothing, and the documented answer to that is
  // the default chain rather than an empty run. `nonEmpty` is where that is
  // said in a way the rest of the call chain can rely on: every list below is
  // judged with an `every`, and `every` is true of nothing (odd2 H5).
  const backendIds = nonEmpty(named) ?? [...PHASE_A_BACKENDS];

  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);

  const home = homedir();
  const env: ApplyEnv = {
    home,
    env: process.env,
    now: () => new Date(),
    explicit: new Set(named),
  };
  const targets = await resolveTargets(backendIds, {
    home,
    cwd: process.cwd(),
    env: process.env,
    which: whichOnPath,
  });

  const plan = await planApply(loaded.soul, targets, env);
  if (plan.issues.length > 0) return report(plan.issues);

  const { soul } = loaded;
  console.log(
    `${soul.role.name} — subject ${soul.subject} · ${write ? bold("writing") : "dry run"}`,
  );
  console.log();
  const refusals = printPlan(plan);
  console.log();

  const note = egressNote(plan.plans);
  if (note !== undefined) console.log(dim(note));

  if (!write) {
    console.log(dim("Nothing was written. Re-run with --apply to write these files."));
    return refusals ? 1 : 0;
  }

  const result = await commitApply(plan, env);
  if (!result.ok) {
    for (const item of result.refused) console.error(`${item.path}: ${item.reason}`);
    return 1;
  }

  // One sentence per outcome, because "nothing was written" had three roads to
  // it and only one of them means the identity is in place. The reassuring one
  // used to be printed for all three — including a run where every target was
  // skipped for being off PATH (odd2 H10). `switch` on the union rather than a
  // chain of `if`s, so a fourth outcome cannot be added without this being made
  // to answer for it.
  switch (result.outcome) {
    case "already-current":
      console.log(dim(`Nothing to write — ${currentCount(plan)}.`));
      return refusals ? 1 : 0;
    case "nothing-applicable":
      console.log(dim(`Nothing was written: ${whyNone(plan)}.`));
      return refusals ? 1 : 0;
    case "wrote":
      break;
  }

  console.log(`wrote ${result.written.length} file(s) · originals in ${result.backupDir}`);
  for (const record of result.written) console.log(dim(`  ${record.restore}`));
  console.log(
    dim(
      "Files can be put back with the commands above. What a backend has already been told " +
        "in an earlier session cannot be taken back (I-4).",
    ),
  );
  return refusals ? 1 : 0;
}

/** One row of the verification table: the level, the count, and where it came from. */
function verifyRow(report: BackendReport): string {
  const counts = tally(report);
  const answers = (counts.total === 0 ? "-" : `${counts.passed}/${counts.total}`).padEnd(7);
  const identity = `${report.channel.strength} · ${report.channel.kind === "system-field" ? "field" : "file"}`;
  return (
    `${report.backend.padEnd(9)} ${report.level.padEnd(10)} ${answers}  ` +
    `${identity.padEnd(15)} ${report.file.detail}`
  );
}

/**
 * Print the table, then every raw answer behind it.
 *
 * The table is Mind's opinion and the transcript is the evidence, so the
 * transcript is not optional and not summarised (AC2). The question text is
 * printed once per probe because every run asks the same thing with a fresh
 * token — printing it nine times would bury the answers it exists to support.
 */
function printVerify(report: VerifyReport): void {
  console.log(bold("backend   level      answers  identity        on disk"));
  for (const row of report.backends) console.log(verifyRow(row));

  // One silent row makes the whole report's stability unknown, and a reader
  // has to be told which row did that rather than left with a missing verdict.
  // `--json` carries the same list in `unmeasured`.
  if (report.stable === null) {
    console.log(
      dim(
        `stability: not measured — ${report.unmeasured.join(", ")} never ran, so nothing was ` +
          `asked twice. The other rows were measured; this is not a claim that anything moved.`,
      ),
    );
  }

  console.log();
  for (const [level, meaning] of Object.entries(LEVEL_LEGEND)) {
    console.log(dim(`${level.padEnd(10)} ${meaning}`));
  }

  for (const row of report.backends) {
    console.log();
    console.log(bold(`${row.backend} — ${row.display}`));
    console.log(`  ${row.reason}`);
    console.log(dim(`  identity channel: ${row.channel.note}`));
    if (row.file.path !== undefined) console.log(dim(`  file checked: ${row.file.path}`));
    for (const caveat of row.caveats) console.log(dim(`  caveat: ${caveat}`));

    if (row.runs.length === 0) continue;

    console.log(
      dim(
        `  stability over ${report.runs} run(s): ${row.flipped} of ${row.stability.length} question(s) ` +
          `changed verdict${row.stable ? "" : " — more than AC5 allows"}`,
      ),
    );

    const seen = new Set<string>();
    for (const item of row.runs) {
      if (!seen.has(item.probe)) {
        seen.add(item.probe);
        console.log();
        console.log(`  question "${item.probe}" — ${item.asks}`);
        console.log(dim(indent(item.evidence.prompt ?? "", "    | ")));
        console.log(dim(`    expected any of: ${item.expected.map((e) => JSON.stringify(e)).join(", ")}`));
      }
      const exit = item.evidence.exitCode === undefined ? "" : ` · exit ${item.evidence.exitCode}`;
      console.log(
        `    run ${item.run} · ${item.verdict} · ${item.evidence.durationMs ?? "?"}ms${exit}`,
      );
      console.log(indent(item.answer === "" ? item.evidence.raw : item.answer, "      "));
    }
  }
}

/** The flags `soul verify` takes no value for. See {@link SOUL_CHECK_BOOLEANS}. */
export const SOUL_VERIFY_BOOLEANS: readonly string[] = ["json"];

async function cmdSoulVerify(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, SOUL_VERIFY_BOOLEANS);
  const dir = positional[0];
  const subject = options.get("subject");
  if (dir === undefined || subject === undefined || subject === "") {
    return usageError(
      "usage: mind soul verify <dir> --subject <id> [--backend a,b] [--home <dir>] " +
        "[--model <m> | --model <backend>=<m>,…] [--runs N] [--json]",
    );
  }

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const named = (options.get("backend") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  for (const name of named) {
    if (!isKnownBackend(name)) return usageError(`unknown backend ${JSON.stringify(name)}`);
  }
  // See `cmdSoulApply` above: the fallback is what keeps this list non-empty,
  // and the type is what makes that fact survive into `verifySoul`.
  const backendIds = nonEmpty(named) ?? [...PHASE_A_BACKENDS];

  const rawRuns = options.get("runs");
  const runs = rawRuns === undefined || rawRuns === "" ? DEFAULT_RUNS : Number(rawRuns);
  if (!Number.isInteger(runs) || runs < 1) {
    return usageError(`--runs must be a whole number of at least 1, not ${JSON.stringify(rawRuns)}`);
  }

  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);

  // D-142: each backend its own model, or none — the same routing `turn` uses. A bare name in a chain of
  // several is ollama's; a vendor gets one only as `--model <vendor>=<name>` or as the only backend named.
  const routed = routeModels(options.get("model"), backendIds);
  if (!routed.ok) return usageError(routed.reason);

  const asked = options.get("home");
  const home = asked === undefined || asked === "" ? homedir() : resolve(asked);
  const json = options.has("json");

  // The env a probe runs under, and the env target paths are resolved against,
  // are the same env on purpose: a report that checked one file while the CLI
  // read another would be worse than no report.
  const codexHome = expandPath("${CODEX_HOME:-~/.codex}", { home, env: process.env });
  const probeEnv = { HOME: home, CODEX_HOME: codexHome };

  // Probes run in an empty directory so that no project's `AGENTS.md` — this
  // repository's included — can answer for a home-scoped identity.
  const scratch = await mkdtemp(join(tmpdir(), "mind-verify-"));
  try {
    const targets = await resolveTargets(backendIds, {
      home,
      cwd: scratch,
      env: { ...process.env, ...probeEnv },
      which: whichOnPath,
    });
    const backends = mapNonEmpty(backendIds, (backendId) => {
      const own = routed.models.get(backendId);
      return buildBackend(backendId, own === undefined ? {} : { model: own });
    });

    const result = await verifySoul(loaded.soul, backends, {
      targets,
      runs,
      env: probeEnv,
      cwd: scratch,
      caveats: await contextInjectionNote(home),
    });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `${loaded.soul.role.name} — subject ${result.subject} · ${result.runs} run(s) × ` +
          `${PROBES_PER_RUN} question(s) per backend`,
      );
      console.log(dim(`identity measured in the home at ${home}`));
      console.log();
      printVerify(result);
      console.log();
      for (const caveat of result.caveats) console.log(dim(caveat));
      const note = verifyEgressNote(result);
      if (note !== undefined) console.log(dim(note));
    }

    // The rule is `verifyPasses` in src/soul/verify.ts, not two lines here.
    // It was two lines here, and the only test of it was a transcribed *copy*
    // of those two lines in `test/odd2/free-pass.test.ts` — a test that passes
    // whether or not the rule it is about was ever repaired (odd2 H5).
    return verifyPasses(result) ? 0 : 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * `mind soul revoke` — S1.5, the first half of I-4.
 *
 * Looks at every instruction file the registry names for the chosen backends
 * **and** every file any backup manifest says apply wrote — a file apply
 * touched under a backend no longer on PATH is still this subject's block.
 * Dry run by default, `--apply` to write, the same verb `soul apply` uses.
 */
/** The flags `soul revoke` takes no value for. See {@link SOUL_CHECK_BOOLEANS}. */
export const SOUL_REVOKE_BOOLEANS: readonly string[] = ["apply"];

async function cmdSoulRevoke(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv, SOUL_REVOKE_BOOLEANS);
  const usage = "usage: mind soul revoke --subject <id> [--backend a,b] [--apply]";
  const subject = options.get("subject");
  if (positional.length > 0 || subject === undefined || subject === "") return usageError(usage);
  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const named = (options.get("backend") ?? "").split(",").map((p) => p.trim()).filter((p) => p !== "");
  for (const backend of named) {
    if (!isKnownBackend(backend)) return usageError(`unknown backend ${JSON.stringify(backend)}`);
  }
  const home = homedir();
  const env: ApplyEnv = { home, env: process.env, now: () => new Date(), explicit: new Set(named) };
  const targets = await resolveTargets(nonEmpty(named) ?? [...PHASE_A_BACKENDS], {
    home,
    cwd: process.cwd(),
    env: process.env,
    which: whichOnPath,
  });
  // `backupRoot` names one run's stamped directory; the history is its parent.
  const history = await beforeApply(dirname(backupRoot(env, id)));
  const paths = [
    ...targets.flatMap((t) => (t.kind === "file" ? [t.path] : [])),
    ...history.paths.keys(),
  ];
  const plan = await planRevoke(paths, id, history.paths);

  console.log(`revoke — subject ${id} · ${options.has("apply") ? bold("writing") : "dry run"}`);
  for (const file of plan) {
    const same =
      file.identical === null ? "" : file.identical ? " — back to what it was before apply" : " — edited since apply; the edits stay";
    if (file.action === "absent") continue;
    console.log(`  ${file.action.padEnd(13)} ${file.path}${same}${file.reason === undefined ? "" : ` — ${file.reason}`}`);
  }
  for (const manifest of history.unreadable) console.log(dim(`  unreadable manifest: ${manifest}`));
  const touching = plan.filter((f) => f.action === "strip" || f.action === "delete");
  if (touching.length === 0) console.log("  no block of this subject in any file Mind knows about");
  if (plan.some((f) => f.action === "refused")) {
    console.error("mind: a file above was refused, so nothing was written — revoke is all or nothing.");
    return 1;
  }
  if (!options.has("apply")) {
    if (touching.length > 0) console.log(dim("Nothing was written. Re-run with --apply."));
    return 0;
  }
  const done = await commitRevoke(plan);
  console.log(`${done.changed} file(s) changed. The backups apply took are kept: they are what \`erase\` removes.`);
  return 0;
}

/**
 * `mind soul card` — S8.1: the A2A Agent Card this soul would publish.
 *
 * Prints it and nothing else. There is no server: A2A stays off until S8.3's
 * egress filter exists (E8's gate), so this is the card for a person to read,
 * or for a test to hand to a real A2A client.
 */
async function cmdSoulCard(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const dir = positional[0];
  const subject = options.get("subject");
  if (dir === undefined || positional.length > 1 || subject === undefined || subject === "") {
    return usageError("usage: mind soul card <dir> --subject <id> [--url <base-url>]");
  }
  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);
  // S15.8: the key as it is, read and never made — printing a card creates nothing.
  const key = await readAgentKey(identityDirFor({ home: homedir(), env: process.env }, id));
  if (key.state === "refused") console.error(`mind: the card says there is no usable key — ${key.reason}`);
  console.log(JSON.stringify(agentCard(loaded.soul, options.get("url") ?? DEFAULT_A2A_URL, key.state === "present" ? key.key : null), null, 2));
  return 0;
}

/**
 * `mind soul edit <dir> --subject <id> --profile <file.json> [--yes]` — the
 * soul from a flat profile (D-074): what the web page's Profile wizard runs.
 * Says which fields change; writes only with --yes, and only a soul that
 * still loads — the firewall and every other check included.
 */
const SOUL_EDIT_BOOLEANS: readonly string[] = ["yes", "print"];

async function cmdSoulEdit(argv: readonly string[]): Promise<number> {
  const usage = "usage: mind soul edit <dir> --subject <id> --profile <file.json> [--yes]";
  const { positional, options } = parseArgs(argv, SOUL_EDIT_BOOLEANS);
  const dir = positional[0];
  const subject = options.get("subject");
  if (dir === undefined || positional.length > 1 || subject === undefined || subject === "") return usageError(usage);
  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const loaded = await loadSoul(dir, id);
  if (!loaded.ok) return report(loaded.issues);
  if (options.has("print")) {
    console.log(JSON.stringify(profileOf(loaded.soul), null, 2));
    return 0;
  }
  const file = options.get("profile");
  if (file === undefined || file === "") return usageError(usage);
  let body: unknown;
  try {
    body = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    console.error(`mind: ${file} is not a JSON profile: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const read = readProfile(body);
  if (!read.ok) {
    for (const problem of read.problems) console.error(`mind: ${problem}`);
    return 1;
  }
  const changed = changedFields(profileOf(loaded.soul), read.profile);
  if (changed.length === 0) {
    console.log("Nothing differs from the soul as it is — nothing to write.");
    return 0;
  }
  const serialized = serializeSoul(applyProfile(loaded.soul, read.profile));
  const checked = parseSoul(serialized.role, serialized.person, id);
  if (!checked.ok) {
    console.error("mind: with these values the soul would not load, so nothing was written:");
    return report(checked.issues);
  }
  console.log(`would change: ${changed.join(", ")}`);
  if (!options.has("yes")) {
    console.log(dim("Nothing was changed. Run again with --yes to write it; the diff is yours to commit."));
    return 0;
  }
  const where = await resolveSoulDir(dir);
  await writeFile(join(where, ROLE_FILE), serialized.role);
  await writeFile(join(where, PERSON_FILE), serialized.person);
  console.log(bold(`Written: ${changed.join(", ")}. \`git diff\` in ${dir} shows it; nothing was committed.`));
  return 0;
}

export async function cmdSoul(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "check":
      return cmdSoulCheck(rest);
    case "import":
      return cmdSoulImport(rest);
    case "apply":
      return cmdSoulApply(rest);
    case "verify":
      return cmdSoulVerify(rest);
    case "revoke":
      return cmdSoulRevoke(rest);
    case "card":
      return cmdSoulCard(rest);
    case "edit":
      return cmdSoulEdit(rest);
    default:
      return usageError(
        `unknown soul subcommand ${JSON.stringify(sub ?? "")} — try "check", "import", "apply", "verify", "revoke", "card" or "edit"`,
      );
  }
}
