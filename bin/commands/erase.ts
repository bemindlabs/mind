/** `mind erase` — one subject out of every place Mind has a deleter for. */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { SOUL_DIR } from "../../src/agent/index.ts";
import {
  NOT_SEARCHED,
  SEARCHED,
  SEARCH_LIMITS,
  certificate,
  commitErase,
  formatCertificate,
  planErase,
  type EraseEnv,
  type ErasePlan,
  type EraseScope,
  verifyErase,
  whatWasFound,
} from "../../src/erase/index.ts";
import { eraseBoth, formatBoth } from "../../src/erase/both.ts";
import { formatRemotePlan, parseRemoteTarget, type RemoteErasePlan } from "../../src/erase/remote.ts";
import { formatRemoteCertificate, remoteCertificate } from "../../src/erase/remote-certificate.ts";
import { erasePhrase } from "../../src/erase/remote-erase.ts";
import type { Runner } from "../../src/erase/remote-probe.ts";
import { appendRemoteEraseLine, remoteEraseLine } from "../../src/erase/remote-log.ts";
import { eraseAndVerifyRemote } from "../../src/erase/remote-verify.ts";
import { VENDORS } from "../../src/exec/index.ts";
import {
  PERSON_FILE,
  ROLE_FILE,
  parsePerson,
  parseRole,
  resolveTargets,
  whichOnPath,
} from "../../src/soul/index.ts";
import { dataRoot, stateRoot } from "../../src/state.ts";
import { subjectId } from "../../src/types.ts";
import { VERSION } from "../../src/version.ts";
import { ERR, OUT, parseArgs, printPlaceNotices, report, thisMachine, type Sink, usageError } from "../shared.ts";

/**
 * Every value of a repeatable flag, in the order they were typed.
 *
 * {@link parseArgs} keeps one value per key, which is right for every other
 * flag and wrong for `--needle`: somebody withdrawing two things should not
 * have the first silently dropped. Read off the argv directly rather than
 * making the shared parser aware of multiplicity.
 */
function repeatedOption(argv: readonly string[], key: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === `--${key}`) {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        found.push(value);
        index++;
      }
      continue;
    }
    if (token.startsWith(`--${key}=`)) found.push(token.slice(key.length + 3));
  }
  return found;
}

const ERASE_USAGE =
  "usage: mind erase <subject> (--agent <dir> | --no-agent) --by <text> [--personal] " +
  "[--needle <text>]... [--remote <target.json>] [--vectors-not-reached <collection>] [--out <file>] [--json] [--yes]";

/**
 * The plan, in the order somebody reading it would want the bad news.
 *
 * Takes the stream rather than assuming one. Under `--json` every line here is
 * a line a *person* reads while stdout carries the document, and the two cannot
 * share a stream without making the document unparseable — which is what they
 * did until odd3.
 */
function printErasePlan(plan: ErasePlan, out: Sink): void {
  out.line(
    `${out.bold(plan.scope === "personal" ? "erase --personal" : "erase")} — subject ${plan.subject} · ` +
      `${plan.agentDir ?? "no agent directory given"}`,
  );
  out.line();

  for (const tree of plan.trees) {
    out.line(
      `  ${tree.place.padEnd(9)} ${String(tree.plan.before.files).padStart(5)} file(s) ` +
        `${String(tree.plan.before.bytes).padStart(9)} byte(s)  ${tree.label}`,
    );
    out.line(out.dim(`             ${tree.plan.dir}`));
  }
  for (const file of plan.files) out.line(`  soul      ${out.dim("one file")}  ${file}`);
  for (const block of plan.blocks) {
    if (block.outcome === "absent") continue;
    out.line(`  soul      ${block.outcome.padEnd(14)} ${block.path}`);
    if (block.reason !== undefined) out.line(out.dim(`             ${block.reason}`));
  }
  out.line(
    `  ledger    ${String(plan.ledger.matched.length).padStart(5)} line(s)             ${plan.ledger.dir}`,
  );
  if (plan.yours.length > 0) {
    out.line(
      `  yours     ${String(plan.yours.length).padStart(5)} file(s)             memory/imported/ — your own notes: ` +
        `NOT removed by erase, yours to delete (D-187)`,
    );
  }
  for (const probe of plan.reserved) {
    out.line(
      `  ${probe.place.padEnd(9)} ${"not built".padEnd(14)} ` +
        `${probe.path ?? "(not looked at — no agent directory)"}` +
        (probe.census === null ? "" : ` · ${probe.census.files} file(s) there now`),
    );
    out.line(out.dim(`             ${probe.owedBy} owes this place its deleter`));
  }

  out.line();
  printPlaceNotices(out);

  out.line();
  out.line(out.bold("What this searches afterwards:"));
  for (const note of SEARCHED) out.line(out.dim(`  - ${note}`));
  out.line(out.bold("What it does not search, and therefore does not certify:"));
  for (const note of NOT_SEARCHED) out.line(out.dim(`  - ${note}`));
  out.line(out.bold("How coarse that search is:"));
  for (const note of SEARCH_LIMITS) out.line(out.dim(`  - ${note}`));

  for (const note of plan.notes) {
    out.line();
    out.line(out.dim(`note: ${note}`));
  }
}

/**
 * `mind erase <subject>` — S7.2, and the two halves of I-4 in one command.
 *
 * The first half is ordinary: run every deleter Mind has for this subject.
 * The second is the one that is usually skipped, and it shapes the whole
 * command — *do not claim to have deleted what you did not delete*. So the
 * counts are re-read from disk, the identifier is searched for afterwards, the
 * scope of that search is printed beside its result, and the two of AC1's five
 * places that do not exist are named in every run rather than quietly folded
 * into a five.
 *
 * A dry run is the default, as in `ledger forget`: `--yes` is the whole
 * difference between the two code paths, and the plan printed by one is
 * computed by the same function that feeds the other.
 */
/** What `cmdErase` needs from outside, so a test can hand it a fake ssh. Omitted: no remote is reachable. */
export interface EraseDeps {
  /** Sends one command line to the remote machine. Not connected yet: the spawn guard refuses `ssh` (S13.2 apply). */
  readonly remoteRunner?: Runner;
  /** Shows the phrase to type and reads what the owner typed, at a terminal (D-100 #4). */
  readonly readPhrase?: (expected: string) => Promise<string>;
}

/** The phrase is read from a terminal and only from one: a pipe or a script cannot supply it. */
async function readPhraseAtTerminal(expected: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  return prompt(`To erase the remote half, type exactly: ${expected}\n> `) ?? "";
}

function refuseRemoteYes(): number {
  console.error(
    "mind: --remote with --yes cannot run yet: no ssh runner is connected (the spawn guard refuses ssh until " +
      "S13.2 apply decides how), and erase will not delete only the local half and call the subject erased. " +
      "Nothing was deleted. Without --yes it prints where it would look.",
  );
  return 1;
}

export async function cmdErase(argv: readonly string[], deps: EraseDeps = {}): Promise<number> {
  const { positional, options } = parseArgs(argv, ["yes", "json", "personal", "no-agent"]);
  const subject = positional[0];
  if (subject === undefined || subject === "") return usageError(ERASE_USAGE);

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const by = options.get("by");
  if (by === undefined || by === "") {
    return usageError(
      "--by <text> is required. The certificate records who asked, and Mind will not issue " +
        "one with that field blank — it is recorded as *claimed*, because nothing here " +
        "authenticates anybody.",
    );
  }

  const named = options.get("agent");
  const hasAgent = named !== undefined && named !== "";
  if (hasAgent === options.has("no-agent")) {
    return usageError(
      "pass exactly one of --agent <dir> and --no-agent. There is no registry mapping a subject " +
        "to a repository, and Mind will not infer one from a directory name (I-3). " +
        "--no-agent is recorded on the certificate as `not examined, at the requester's word`.",
    );
  }
  const agentDir = hasAgent ? resolve(named) : null;
  const scope: EraseScope = options.has("personal") ? "personal" : "all";

  // The remote half (S13.5 AC2). The target is read before anything else so a bad file or a
  // `--yes` it cannot honour yet stops here, with nothing local deleted either.
  let remote: RemoteErasePlan | null = null;
  const remoteFile = options.get("remote");
  if (remoteFile !== undefined) {
    if (remoteFile === "") return usageError("--remote takes the target file `deploy plan` reads");
    const targetText = await Bun.file(resolve(remoteFile)).text().catch(() => undefined);
    if (targetText === undefined) {
      console.error(`mind: cannot read the target file ${resolve(remoteFile)}`);
      return 1;
    }
    const parsedTarget = parseRemoteTarget(targetText, remoteFile, id);
    if (!parsedTarget.ok) {
      for (const problem of parsedTarget.problems) console.error(problem);
      console.error("Nothing was looked at or deleted.");
      return 1;
    }
    remote = parsedTarget.plan;
    if (options.has("yes") && deps.remoteRunner === undefined) return refuseRemoteYes();
  }

  const home = homedir();
  const out = options.get("out");
  if (out !== undefined && out !== "") {
    const target = resolve(out);
    const roots = [
      ["state root", stateRoot(home, process.env)],
      ["data root", dataRoot(home, process.env)],
    ] as const;
    for (const [label, root] of roots) {
      if (target === root || target.startsWith(root + sep)) {
        return usageError(
          `--out is inside the ${label} (${root}). A certificate kept there is a record that ` +
            `this subject existed, sitting in the tree the next run searches — it would fail ` +
            `the check it certifies. Write it somewhere else.`,
        );
      }
    }
  }

  // The subject is an argument and the repository has to agree with it. A
  // directory name is a hint; `role.md` is the claim (I-3).
  let soulName: string | null = null;
  let personalValues: readonly string[] = [];
  if (agentDir !== null) {
    const rolePath = join(agentDir, SOUL_DIR, ROLE_FILE);
    if (!(await Bun.file(rolePath).exists())) {
      console.error(
        `mind: ${rolePath} is not there, so Mind cannot confirm that ${agentDir} is ` +
          `subject ${id}'s repository. Pass --no-agent if you mean to erase without one.`,
      );
      return 1;
    }
    const role = parseRole(ROLE_FILE, await Bun.file(rolePath).text(), id);
    if (!role.ok) return report(role.issues);
    soulName = role.value.name;

    const personPath = join(agentDir, SOUL_DIR, PERSON_FILE);
    if (await Bun.file(personPath).exists()) {
      const person = parsePerson(PERSON_FILE, await Bun.file(personPath).text(), id);
      if (person.ok) {
        // AC5's content check: separate files are not separate contents. The
        // soul's `name` is deliberately not on this list — `role.md` declares
        // it by design and `--personal` keeps that file, so looking for it
        // there would report the one place it is supposed to be.
        personalValues = [person.value.addresses_user_as, ...person.value.refers_to_self_as];
      } else if (scope === "personal") {
        console.error(
          `mind: ${personPath} could not be parsed, so the values it holds cannot be looked ` +
            `for in the files --personal keeps. The file is still deleted; the content check ` +
            `below has nothing to search for.`,
        );
      }
    }
  }

  // Resolved here rather than inside `src/erase/`: `resolveTargets` imports the
  // vendor registry, which is under `src/exec/`, and nothing in the erase layer
  // may reach that (see src/erase/index.ts).
  const instructionTargets = await resolveTargets(
    VENDORS.map((spec) => spec.id),
    { home, cwd: process.cwd(), env: process.env, which: whichOnPath },
  );
  // The files a vendor also reads (kimi's home AGENTS.md) too: Mind never writes them, but a block that
  // got there is still this subject's identity reaching a model.
  const instructionFiles = [
    ...new Set(instructionTargets.flatMap((target) => (target.kind === "file" ? [target.path, ...target.alsoReads.map((extra) => extra.path)] : []))),
  ];

  const env: EraseEnv = { home, env: process.env, now: () => new Date(), machine: thisMachine() };
  const plan = await planErase(env, {
    subject: id,
    agentDir,
    scope,
    by,
    needles: repeatedOption(argv, "needle"),
    instructionFiles,
    soulName,
    personalValues,
    ...(options.get("vectors-not-reached") ? { acknowledgeUnreached: options.get("vectors-not-reached")! } : {}),
  });

  // Under `--json`, stdout is the document and nothing else, so `| jq` reads
  // what a person would have read on the page; everything written for a human
  // moves to stderr, the split `observe actions` has made since it was written.
  // It is a move, not a silence: S7.2 AC3 says `NOT_SEARCHED` is printed on
  // every run, and a promise kept only in the mode nobody automates is not one.
  // The cost is stated in `bin/usage.ts`: `erase --json 2>&1 | jq` still fails,
  // because merging the streams is the thing being undone here.
  const human: Sink = options.has("json") ? ERR : OUT;

  printErasePlan(plan, human);
  if (remote !== null) {
    human.line();
    for (const line of formatRemotePlan(remote)) human.line(line);
  }

  if (plan.refusals.length > 0) {
    // No spacer. The blank line that used to be here separated this from the
    // plan above it, which without `--json` is on *stdout* — so it was never a
    // fact about this stream, and under bun 1.4.2 `console.error()` put its
    // newline on stdout anyway, at the end of the plan somebody may be keeping.
    // Whether a terminal shows a gap between two streams is the terminal's
    // business. Under `--json` the plan is on stderr and a spacer here would be
    // a legitimate one — it stays gone so that the refusal reads the same in
    // both modes, and so that this stream still opens with a reason.
    for (const refusal of plan.refusals) console.error(`mind: ${refusal}`);
    console.error(
      "Nothing was deleted and no certificate was issued. A certificate that listed a place " +
        "Mind did not handle would be the one claim I-4 forbids.",
    );
    return 1;
  }

  const observed = process.env["USER"] ?? process.env["LOGNAME"] ?? "(unknown)";
  const write = options.has("yes");

  if (!write) {
    const dry = certificate({
      plan,
      result: null,
      verification: null,
      observedAccount: observed,
      engine: VERSION,
      issuedAt: new Date().toISOString(),
    });
    human.line();
    if (options.has("json")) console.log(JSON.stringify(dry, null, 2));
    else for (const line of formatCertificate(dry)) console.log(line);
    human.line();
    if (whatWasFound(plan).total === 0) {
      // Still exit 0: a dry run claims nothing, so there is nothing here for it
      // to be wrong about. The sentence is the part that matters — `--yes` from
      // this state produces a `nothing-found` document and exit 3, and somebody
      // reading "Nothing was removed. Re-run with --yes" alone would expect a
      // certificate of erasure at the end of it.
      human.line(
        human.dim(
          "Nothing was found to remove. --yes would remove nothing and would issue no erasure " +
            "verdict — it would print a nothing-found document and exit 3.",
        ),
      );
    } else {
      human.line(human.dim("Nothing was removed. Re-run with --yes to remove it."));
    }
    return 0;
  }

  const runLocal = async (): Promise<number> => {
    let result;
    try {
      result = await commitErase(plan);
    } catch (error) {
      console.error(`mind: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    const verification = await verifyErase(plan, result);
    const issued = certificate({
      plan,
      result,
      verification,
      observedAccount: observed,
      engine: VERSION,
      issuedAt: new Date().toISOString(),
    });

    human.line();
    if (options.has("json")) console.log(JSON.stringify(issued, null, 2));
    else for (const line of formatCertificate(issued)) console.log(line);

    if (out !== undefined && out !== "") {
      await Bun.write(resolve(out), `${JSON.stringify(issued, null, 2)}\n`);
      human.line();
      human.line(
        human.dim(`certificate written to ${resolve(out)} — Mind keeps no copy of its own.`),
      );
    }

    if (verification.verdict === "erased-and-verified") return 0;

    // Three, not one. Exit 1 from this command means *something of this subject
    // survived*, and a script is entitled to treat that as an alarm; "there was
    // nothing here" is not that, and re-running an erase is a legitimate thing to
    // do. Nor is it 0: a withdrawal that removed nothing must not be read by `&&`
    // as a completed one. 2 is already usage error.
    if (verification.verdict === "nothing-found") {
      // No spacer before it — and the same is now true of the branch below, which
      // this comment used to name as the exception. Measured under bun 1.4.2,
      // twice and by accident: `console.error()` with no arguments writes its
      // newline to **stdout**. A spacer here would append a blank line to the
      // certificate a reader is keeping, and put nothing at all in front of the
      // message it was meant to separate. `test/cli/streams.test.ts` holds the
      // measurement and refuses the bare call everywhere.
      console.error(
        `mind: verdict nothing-found — nothing was erased, because nothing was found under ` +
          `"${id}". Exit 3, not 0: a script must not read this as a completed withdrawal. ` +
          `${verification.filesRead} file(s) were read looking for it; Mind cannot tell a ` +
          `subject that was never here from one an earlier run removed.`,
      );
      return 3;
    }

    console.error(
      `mind: verdict ${verification.verdict}. Something the identifier still appears in is ` +
        `listed above with its file and line. Mind does not delete a file git tracks on your ` +
        `behalf — that is your decision, not this program's.`,
    );
    return 1;
  };

  if (remote === null) return runLocal();

  // The remote half first (S13.5 AC2): a failure there leaves this machine untouched.
  const runner = deps.remoteRunner;
  if (runner === undefined) return refuseRemoteYes();
  const typed = await (deps.readPhrase ?? readPhraseAtTerminal)(erasePhrase(id, remote.target.name));
  // What could not be written down after the remote delete. The delete has happened by then, so a failed
  // record must not take the verdict with it: the certificate is printed first, and the run exits non-zero.
  const recordFailures: string[] = [];
  const both = await eraseBoth(async () => {
    const erasure = await eraseAndVerifyRemote(remote, typed, runner);
    const cert = remoteCertificate({ plan: remote, erasure, by, observedAccount: observed, engine: VERSION, issuedAt: new Date().toISOString() });
    human.line();
    for (const line of formatRemoteCertificate(cert)) human.line(line);
    const note = (what: string, error: unknown): void => {
      recordFailures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    };
    // One line per remote erase that sent anything (S13.5 AC3). A refused phrase sent nothing, so it is not one.
    if (erasure.erase.ok || erasure.erase.reason !== "phrase") {
      try {
        await appendRemoteEraseLine(stateRoot(home, process.env), remoteEraseLine(remote, erasure, new Date().toISOString()));
      } catch (error) {
        note("the remote-erase log line", error);
      }
    }
    if (out !== undefined && out !== "") {
      try {
        await Bun.write(`${resolve(out)}.remote.json`, `${JSON.stringify(cert, null, 2)}\n`);
      } catch (error) {
        note(`the remote certificate (${resolve(out)}.remote.json)`, error);
      }
    }
    return erasure;
  }, runLocal);
  human.line();
  for (const line of formatBoth(both)) human.line(line);
  if (recordFailures.length === 0) return both.exit;
  for (const failure of recordFailures) console.error(`mind: could not write ${failure}`);
  console.error(
    `mind: the remote half is ${both.remote.verdict.verdict} — that is printed above and stands; only the record of it ` +
      "was not written. Exiting non-zero so a script does not read the run as clean.",
  );
  return both.exit === 0 ? 1 : both.exit;
}

// ---------------------------------------------------------------------------
// Which identity is on, and switching to another one
// ---------------------------------------------------------------------------
