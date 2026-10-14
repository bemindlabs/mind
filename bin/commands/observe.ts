/** `mind observe` — capture, and everything that can be asked of it. */

import { readEnv } from "../../src/env.ts";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isatty } from "node:tty";
import { LOCAL_LIMITS } from "../../src/exec/index.ts";
import { GIT_UNDELETABLE, engineCommand, shellQuote } from "../../src/guard/index.ts";
import {
  ACTIONS_DIR,
  ACTIONS_LIMITS,
  AUDIT_FLOOR,
  AUDIT_LIMITS,
  BACKFILL_NOTE,
  CAPTURE_LIMITS,
  CAPTURE_VENDORS,
  CLAUDE_HOOK_EVENTS,
  CLAUDE_HOOK_MEASURED,
  NO_SESSION,
  OBSERVER_LIMITS,
  OBSERVER_UNDELETABLE,
  READABLE_FLOOR,
  FLEET_LEAK_LIMITS,
  SUMMARY_FILE,
  SUMMARY_PATH,
  actionsSummary,
  announceCapture,
  appendRecord,
  auditClears,
  captureTarget,
  capturedKeys,
  census,
  claudeHook,
  claudeHookSnippet,
  commitPurge,
  consentAllows,
  consentGrantedAt,
  consentPath,
  countActions,
  ensureCaptureDir,
  ensureObserverDir,
  ensureSessionsDir,
  formatActions,
  formatAudit,
  formatFleetLeaks,
  formatReport,
  hookSession,
  isSeedVendor,
  SEED_VENDORS,
  judgeSample,
  loadConsent,
  loadSeeds,
  loadSessionState,
  monthsOfFiles,
  nextSessionState,
  observerDir,
  planPurge,
  readCaptured,
  readInto,
  requestConsent,
  sampleActions,
  saveConsent,
  saveSeeds,
  saveSessionState,
  seedVendor,
  fleetLeaks,
  sessionStatePath,
  textLines,
  type AuditIo,
  type CaptureVendor,
  type ConsentIo,
  type ConsentScope,
  type ObserverEnv,
} from "../../src/observer/index.ts";
import { candidateDirs, formatInterests, rankInterests } from "../../src/observer/interests.ts";
import { printPatterns, systemClock } from "../../src/observer/patterns.ts";
import { subjectId } from "../../src/types.ts";
import { GENERATOR } from "../../src/version.ts";
import { bold, dim, dimErr, parseArgs, readTerminalLine, usageError } from "../shared.ts";

/** The machine facts the observer is allowed to see, in one place. */
function observerEnv(): ObserverEnv {
  return { home: homedir(), env: process.env };
}

/** One line of counts, in the same words `observe purge` uses afterwards. */
function censusLine(counted: Awaited<ReturnType<typeof census>>): string {
  return (
    `${counted.files} file(s) · ${counted.lines} line(s) · ${counted.bytes} byte(s)` +
    (counted.symlinks.length === 0 ? "" : ` · ${counted.symlinks.length} symlink(s)`)
  );
}

/**
 * Everything the observer is required to print beside a number, in one place.
 *
 * Both subcommands print both lists, always — including a dry run and a run
 * that found nothing. The moment somebody is entitled to know what a purge
 * cannot reach is the moment before they believe it reached everything, and
 * that moment happens on the runs where nothing was deleted too.
 */
function printObserverNotes(write: (line: string) => void): void {
  write(bold("What this does not reach:"));
  for (const note of OBSERVER_UNDELETABLE) write(dim(`  - ${note}`));
  write(bold("The size of what is proven:"));
  for (const note of OBSERVER_LIMITS) write(dim(`  - ${note}`));
  for (const note of LOCAL_LIMITS) write(dim(`  - ${note}`));
}

/**
 * `mind observe status` — AC1, said out loud.
 *
 * The path is printed whether or not anything is in it. "Where would this go?"
 * is the question AC1 is about, and an address that only appears once data
 * exists is an address nobody can check beforehand.
 */
async function cmdObserveStatus(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  const subject = options.get("subject");
  if (subject === undefined || subject === "") {
    return usageError("usage: mind observe status --subject <id>");
  }

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const dir = await observerDir(observerEnv(), id);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return 1;
  }

  const counted = await census(dir.path);
  console.log(bold(`observer — subject ${id}`));
  console.log(`  ${dir.path}`);
  console.log(dim(`  ${censusLine(counted)}`));

  // Whether capture is on, said in the same breath as how much is there. "Is
  // this thing recording me?" is the question this command is most likely to
  // be typed to answer, and a byte count does not answer it.
  const consent = await loadConsent(dir.path);
  const scopes = (["capture", "seed"] as const).filter((scope) => consentAllows(consent, scope));
  if (consent === undefined || consent.grants.length === 0) {
    console.log(dim("  capture: off — no consent recorded, and nothing is being written"));
  } else if (scopes.length === 0) {
    const when = consent.grants.map((grant) => grant.at).sort()[0] ?? "an earlier release";
    console.log(
      dim(
        `  capture: off — a consent from ${when} is here, but it agreed to different words ` +
          `than this release captures. Nothing is written until you read the new list: ` +
          `mind observe enable --subject ${id}`,
      ),
    );
  } else {
    for (const scope of scopes) {
      console.log(dim(`  capture: on since ${consentGrantedAt(consent, scope)} · scope: ${scope}`));
    }
  }

  const seeds = await loadSeeds(dir.path);
  for (const vendor of CAPTURE_VENDORS) {
    const entry = seeds[vendor];
    if (entry === undefined) continue;
    console.log(dim(`  seeded ${vendor}: ${entry.records} record(s) at ${entry.at} from ${entry.root}`));
  }

  const back = await readCaptured(dir.path);
  console.log(
    dim(
      `  ${back.report.records} action(s) readable back · ${back.report.duplicates} duplicate(s) ` +
        `dropped by key · ${Object.entries(back.report.skipped)
          .map(([reason, count]) => `${reason}=${count}`)
          .join(" ") || "no unreadable lines"}`,
    ),
  );

  for (const link of counted.symlinks) {
    console.log(dim(`  symlink: ${link} — purge removes the link, not what it points at`));
  }
  console.log(
    dim(
      "  One address, and it is outside every git repository by construction: capture records " +
        "what the owner did, nothing can rebuild it, and git remembers what it is asked to " +
        "forget (D-025). Delete it with: mind observe purge --subject " + id,
    ),
  );
  console.log();
  printObserverNotes((line) => console.log(line));
  console.log(bold("The size of what capture is:"));
  for (const note of CAPTURE_LIMITS) console.log(dim(`  - ${note}`));
  return 0;
}

/**
 * `mind observe purge` — AC3, and the recount that makes it a claim.
 *
 * The number printed at the end is read back off the filesystem after the
 * deletions, never derived from how many unlinks returned successfully. A
 * command that subtracted its own successes from its own plan would print `0`
 * on a run where a file it never managed to delete is still sitting there.
 *
 * Deleting is the default here, unlike `ledger forget`, because AC3 names
 * `observe purge --subject <id>` as the command that deletes. `--dry-run` is
 * the half that only counts, and it prints the same two lists.
 */
async function cmdObservePurge(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv, ["dry-run"]);
  const subject = options.get("subject");
  if (subject === undefined || subject === "") {
    return usageError("usage: mind observe purge --subject <id> [--dry-run]");
  }

  let id;
  try {
    id = subjectId(subject);
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  const plan = await planPurge(observerEnv(), id);
  if ("ok" in plan) {
    console.error(`mind: ${plan.reason}`);
    return 1;
  }

  console.log(`subject ${id} · ${plan.dir}`);
  console.log(`${censusLine(plan.before)} to remove`);

  if (options.has("dry-run")) {
    console.log();
    printObserverNotes((line) => console.log(line));
    console.log();
    console.log(dim("Nothing was removed. Run without --dry-run to remove it."));
    return 0;
  }

  const result = await commitPurge(plan);
  console.log(`removed ${result.removed.length} file(s)`);
  for (const failure of result.failed) {
    console.error(`  could not remove ${failure.path}: ${failure.reason}`);
  }
  if (result.dirRemoved) console.log(dim(`  removed ${plan.dir}`));

  console.log();
  printObserverNotes((line) => console.log(line));
  console.log();

  // Counted again, from disk. This line is the acceptance criterion.
  console.log(`remaining: ${censusLine(result.remaining)}`);
  if (result.remaining.files > 0) {
    console.error(
      `mind: ${result.remaining.files} file(s) are still under ${plan.dir}. The purge did not ` +
        `do what it says on the tin, so this exits 1 rather than reporting a zero it cannot see.`,
    );
    return 1;
  }
  return 0;
}

/** Parse a `--subject`, or print the usage line this subcommand wants. */
function subjectOf(options: ReadonlyMap<string, string>, usage: string) {
  const subject = options.get("subject");
  if (subject === undefined || subject === "") return { ok: false as const, code: usageError(usage) };
  try {
    return { ok: true as const, id: subjectId(subject) };
  } catch (error) {
    return {
      ok: false as const,
      code: usageError(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * `mind observe enable` — the one command in Mind with no `--yes`.
 *
 * That absence is the design. Every other writing command here has a flag that
 * means "I mean it", and a program running as the owner can type any of them.
 * This one asks for a phrase at a terminal instead, because the thing being
 * agreed to is a record of the owner's own behaviour, and consent to that
 * cannot be delegated to an argument — see `src/observer/consent.ts`.
 *
 * Nothing is created before the answer. A refusal leaves no directory, no
 * consent file, and no record of having been asked.
 */
async function cmdObserveEnable(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  const parsed = subjectOf(
    options,
    "usage: mind observe enable --subject <id> [--scope capture|seed]",
  );
  if (!parsed.ok) return parsed.code;
  const id = parsed.id;

  const rawScope = options.get("scope");
  if (rawScope !== undefined && rawScope !== "" && rawScope !== "capture" && rawScope !== "seed") {
    return usageError(`--scope is "capture" or "seed", not ${JSON.stringify(rawScope)}`);
  }
  const scope: ConsentScope = rawScope === "seed" ? "seed" : "capture";

  const dir = await observerDir(observerEnv(), id);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return 1;
  }

  // Printed first, before anything exists at that address, which is the whole
  // of S7.2 AC4's timing — and it is what mints the `CaptureNotice` that
  // `ensureObserverDir` requires below. There is no other way to get one.
  console.log(`observer — subject ${id}`);
  console.log(`  ${dir.path}`);
  console.log();
  const notice = announceCapture((line) => console.log(line));
  console.log();

  const io: ConsentIo = {
    // `isatty(1)` rather than `process.stdout.isTTY`: reading that getter can
    // make a later long `console.log` into a pipe stop after 8192 bytes under
    // bun 1.4.2 — a race a busy machine loses, not a fixed limit. See the note
    // in `bin/shared.ts` and the measurement in `test/cli/streams.test.ts`.
    // `process.stdin` was never seen to do it, and is left alone.
    isTTY: process.stdin.isTTY === true && isatty(1),
    write: (line) => console.log(line),
    readLine: readTerminalLine,
  };
  const previous = await loadConsent(dir.path);
  const outcome = await requestConsent(io, {
    subject: id,
    scope,
    path: dir.path,
    now: new Date(),
    previous,
  });

  if (!outcome.ok) {
    // No spacer: nothing has been written to stderr yet on this path, so the
    // blank line was separating this from the consent prompt on *stdout* — and
    // under bun 1.4.2 `console.error()` with no arguments wrote it to stdout,
    // which is where the prompt already was. The reason is the first byte here.
    console.error(`mind: ${outcome.reason}`);
    return 1;
  }

  const created = await ensureObserverDir(observerEnv(), id, notice);
  if (!created.ok) {
    console.error(`mind: ${created.reason}`);
    return 1;
  }
  await ensureCaptureDir(created.path);
  await ensureSessionsDir(created.path);
  await saveConsent(created.path, outcome.record);

  console.log();
  console.log(
    `recorded ${consentPath(created.path)} — scope(s): ` +
      outcome.record.grants.map((grant) => `${grant.scope} (${grant.at})`).join(", "),
  );
  console.log(
    dim(
      "Nothing is captured yet. Mind does not edit another program's configuration, so the hook " +
        "is yours to connect: `mind observe hook --print --subject " + id + "`.",
    ),
  );
  console.log(
    dim(
      `Deleting the data removes this consent with it: mind observe purge --subject ${id}. ` +
        `There is no second switch to remember.`,
    ),
  );
  return 0;
}

/**
 * `mind observe disable` — withdraw consent without deleting anything.
 *
 * Separate from `purge` on purpose. "Stop recording me" and "delete what you
 * recorded" are two different wishes, and a command that did both would make
 * the first one cost the second. This removes `consent.json`, which is what
 * every capture checks first, and leaves the records where they are.
 */
async function cmdObserveDisable(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  const parsed = subjectOf(options, "usage: mind observe disable --subject <id>");
  if (!parsed.ok) return parsed.code;
  const id = parsed.id;

  const dir = await observerDir(observerEnv(), id);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return 1;
  }

  const path = consentPath(dir.path);
  const removed = await rm(path, { force: true }).then(
    () => true,
    () => false,
  );
  const existed = (await loadConsent(dir.path)) !== undefined;

  console.log(
    existed || removed
      ? `capture is off for subject ${id} — removed ${path}`
      : `capture was already off for subject ${id} (no ${path})`,
  );
  const counted = await census(dir.path);
  console.log(dim(`  ${censusLine(counted)} left in place — nothing was deleted.`));
  console.log(
    dim(
      `Remove the hook from your CLI's settings as well: this stops Mind writing, and the hook ` +
        `will keep running and doing nothing until you take it out. Delete the data with: ` +
        `mind observe purge --subject ${id}`,
    ),
  );
  return 0;
}

/**
 * `mind observe capture` — the receiving end, and the two rules it cannot break.
 *
 * **It prints nothing on stdout, ever.** Measured on claude 2.1.278: a
 * `UserPromptSubmit` hook that exits 0 has its stdout *shown to the model* —
 * injected into the context of the very turn that is starting. A capture
 * command that printed a confirmation there would be feeding the owner's
 * observer data back into a cloud CLI on every prompt, which is I-6 broken by a
 * `console.log`. Everything it has to say goes to stderr.
 *
 * **It exits 0, always.** Exit 2 on `UserPromptSubmit` blocks the prompt and
 * erases it; exit 2 on `PostToolUse` pushes stderr at the model. Neither is a
 * thing a recorder is entitled to do to the owner's session. A misconfigured
 * capture has to be harmless, so every failure path here — a bad argument, an
 * unreadable payload, a full disk — is a line on stderr and a zero.
 *
 * `test/cli/observe.test.ts` asserts both properties against the real binary.
 */
async function cmdObserveCapture(argv: readonly string[]): Promise<number> {
  try {
    await captureOnce(argv);
  } catch (error) {
    console.error(`mind observe capture: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Not `return 1` on any path above. See the doc comment: the exit code of
  // this command is a lever on somebody else's session, and Mind does not
  // pull it to report its own problems.
  return 0;
}

/** The body of `capture`, free to give up at any point by returning. */
async function captureOnce(argv: readonly string[]): Promise<void> {
  // The escape hatch a fleet launcher sets on itself, so unattended work can
  // stay out of this data entirely rather than relying on `origin` to sort it
  // out afterwards.
  if (readEnv("CAPTURE", process.env) === "off") return;

  const { options } = parseArgs(argv);
  // D-036: a fleet launcher's `MIND_FLEET` outranks the hook's `--subject`,
  // and an invalid one records nothing rather than falling back to it.
  const target = captureTarget(options.get("subject"), process.env);
  if (!target.ok) {
    console.error(`mind observe capture: ${target.reason}`);
    return;
  }
  const id = target.subject;

  const from = options.get("from") ?? "claude-hook";
  if (from !== "claude-hook") {
    console.error(
      `mind observe capture: --from ${JSON.stringify(from)} is not a format Mind reads. ` +
        `Today there is one: claude-hook. grok has no hook mechanism and can only be seeded.`,
    );
    return;
  }

  const dir = await observerDir(observerEnv(), id);
  if (!dir.ok) {
    console.error(`mind observe capture: ${dir.reason}`);
    return;
  }

  // Checked before the payload is even read, and silent when it fails: "capture
  // is not enabled" is the default state of this program, not an error, and a
  // hook that complained on every prompt would teach somebody to remove it.
  if (!consentAllows(await loadConsent(dir.path), "capture")) return;

  const payload = await Bun.stdin.text();
  if (payload.trim() === "") return;

  const at = new Date();
  const iso = at.toISOString();

  // Parsed once here to find the session, and once more inside the reader.
  // A double parse of one small payload is the price of `readInto` staying the
  // only thing that counts, skips and de-duplicates (S3.1 AC1).
  let head: unknown;
  try {
    head = JSON.parse(payload);
  } catch {
    // The message would quote the payload. There is nothing safe to say.
    console.error("mind observe capture: the hook payload was not JSON; nothing was recorded");
    return;
  }

  const session = hookSession(head);
  const statePath = session === undefined ? undefined : sessionStatePath(dir.path, session);
  const state = statePath === undefined ? NO_SESSION : await loadSessionState(statePath);

  await readInto(textLines(payload), claudeHook({ at: iso, session: state }), async (record) => {
    const outcome = await appendRecord(dir.path, record, at);
    if (!outcome.ok) console.error(`mind observe capture: ${outcome.reason}`);
  });

  const next = nextSessionState(head, state, iso);
  if (next !== undefined && statePath !== undefined) {
    // Never creates the directory — see `saveSessionState`. A purge between
    // the consent check and here leaves this failing, which is correct.
    await saveSessionState(statePath, next).catch((cause: unknown) => {
      console.error(`mind observe capture: could not record session state: ${String(cause)}`);
    });
  }
}

/**
 * `mind observe hook --print` — a snippet, and nothing else.
 *
 * Mind will not write into another program's configuration. Connecting a
 * recorder to your own tools is the owner's act; a program that wired itself in
 * would have made the consent `enable` asks for a formality.
 */
async function cmdObserveHook(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv, ["print"]);
  const parsed = subjectOf(options, "usage: mind observe hook --print --subject <id>");
  if (!parsed.ok) return parsed.code;
  const id = parsed.id;
  if (!options.has("print")) {
    return usageError(
      "usage: mind observe hook --print --subject <id> — printing is the only thing this does, " +
        "and naming it is how the command line says Mind is not editing your settings",
    );
  }

  const engine = engineCommand();
  const command = [...engine.argv, "observe", "capture", "--subject", id]
    .map(shellQuote)
    .join(" ");

  console.log(claudeHookSnippet(command));
  console.log();
  console.error(dimErr(`Field names read off ${CLAUDE_HOOK_MEASURED}; see docs/cli-matrix.md.`));
  console.error(
    dimErr(
      `Events asked for: ${CLAUDE_HOOK_EVENTS.join(", ")}. PostToolUseFailure is in that list ` +
        `because a tool that fails does not fire PostToolUse at all — without it every record ` +
        `would say the action succeeded. PreToolUse is deliberately absent: it runs before every ` +
        `tool call, cannot know the outcome, and would add latency to all of them.`,
    ),
  );
  console.error(
    dimErr(
      "Two ways to use it, and Mind does neither for you: paste it into your settings.json, or " +
        "pass it for one session with: claude --settings \"$(mind observe hook --print " +
        `--subject ${id})\" — which changes no file. Nothing is captured until you do.`,
    ),
  );
  return 0;
}

/**
 * `mind observe seed` — seven weeks of history, once.
 *
 * A separate consent from capture, because they are different things to agree
 * to: one is about the future, the other hands over a body of history that
 * exists whether or not Mind was ever installed. And a separate *record*,
 * because a second seed is a backfill — see `src/observer/seed.ts`.
 */
async function cmdObserveSeed(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv, ["again"]);
  const usage =
    "usage: mind observe seed --subject <id> --vendor claude|grok --root <dir> [--again]";
  const parsed = subjectOf(options, usage);
  if (!parsed.ok) return parsed.code;
  const id = parsed.id;

  const rawVendor = options.get("vendor") ?? "";
  // `isSeedVendor`, not `isCaptureVendor`: Mind's own turns are in the capture union
  // (D-032) but have no history on disk, so a seed from them is a usage error.
  if (!isSeedVendor(rawVendor)) {
    return usageError(
      `--vendor is one of ${SEED_VENDORS.join(", ")}, not ${JSON.stringify(rawVendor)}. ` +
        `SP-1 measured codex at 53% extraction against a 60% bar and kimi at no tool calls at ` +
        `all, so neither is read (S3.1 AC6). The cost of that is 5.4% of bytes and 10.4% of ` +
        `tool-use turns, recorded so the decision can be reversed knowingly.`,
    );
  }
  const vendor: CaptureVendor = rawVendor;

  const root = options.get("root");
  if (root === undefined || root === "") {
    return usageError(
      `${usage} — --root has no default. Mind will not go looking through your home directory ` +
        `for transcripts; name the directory you mean.`,
    );
  }

  const dir = await observerDir(observerEnv(), id);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return 1;
  }
  if (!consentAllows(await loadConsent(dir.path), "seed")) {
    console.error(
      `mind: subject ${id} has not agreed to a seed. Importing history is a separate decision ` +
        `from recording what happens next, so it asks separately: ` +
        `mind observe enable --subject ${id} --scope seed`,
    );
    return 1;
  }

  const seeds = await loadSeeds(dir.path);
  const already = seeds[vendor];
  const again = options.has("again");
  if (already !== undefined && !again) {
    console.error(
      `mind: ${vendor} was already seeded at ${already.at} from ${already.root} ` +
        `(${already.records} record(s)). A seed is meant to happen once.`,
    );
    console.error(BACKFILL_NOTE);
    console.error(`If you have read that and still mean it: --again`);
    return 1;
  }
  if (already !== undefined) {
    console.log(bold("This is a repeat seed."));
    console.log(BACKFILL_NOTE);
    console.log();
  }

  const now = new Date();
  const result = await seedVendor({
    observerPath: dir.path,
    vendor,
    root: resolve(root),
    now,
    // Keys already on disk, so a seed after a week of capture adds only what
    // the hook did not write (AC7) — the hook and the seed mint the same key.
    seen: await capturedKeys(dir.path),
    repeat: already !== undefined,
  });

  await saveSeeds(dir.path, {
    ...seeds,
    [vendor]: {
      at: now.toISOString(),
      root: result.root,
      records: (already?.records ?? 0) + result.written,
    },
  });

  console.log(`seeded ${vendor} from ${result.root}`);
  console.log(`  ${result.files} file(s) · ${(result.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  ${formatReport(result.report)}`);
  console.log(`  ${result.written} record(s) written`);
  for (const reason of result.refused) console.error(`  refused: ${reason}`);

  console.log();
  console.log(bold("The size of what a seed is:"));
  for (const note of CAPTURE_LIMITS) console.log(dim(`  - ${note}`));

  if (result.report.pct < READABLE_FLOOR) {
    console.error(
      `mind: ${result.report.pct.toFixed(1)}% of lines parsed, under the ${READABLE_FLOOR}% ` +
        `floor S3.1 AC3 fixes. What was read has been kept; this exits 1 so that a format that ` +
        `moved is not mistaken for a directory that was empty.`,
    );
    return 1;
  }
  return 0;
}

/**
 * `mind observe actions` — S3.2's counted summary, and the only thing here
 * that can put any of it in a git working tree.
 *
 * Reading is the default and writing needs `--write`, which is D-013 #4 (*ไม่เข้า
 * git โดยค่าเริ่มต้น*) kept rather than restated. What `--write` prints before
 * it writes is `GIT_UNDELETABLE` — the same array `guard status` and `erase`
 * print, by reference — because the moment to say that a commit is forever is
 * before the file exists, not when somebody asks to delete it.
 *
 * Nothing is staged and nothing is committed. Mind has no path to either.
 */
async function cmdObserveActions(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv, ["json"]);
  const usage = "usage: mind observe actions --subject <id> [--write <agent-dir>] [--json]";
  const parsed = subjectOf(options, usage);
  if (!parsed.ok) return parsed.code;
  const id = parsed.id;

  const dir = await observerDir(observerEnv(), id);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return 1;
  }

  const back = await readCaptured(dir.path);
  // The months come from the file names, which are outside the box — see
  // `monthsOfFiles`. Nothing in this function reads a record.
  const months = monthsOfFiles(back.report.files);
  const summary = actionsSummary({
    counts: countActions(back.records, months),
    months,
    records: back.report.records,
    at: new Date(),
    generator: GENERATOR,
  });

  // With `--json`, stdout is the file and nothing else, so a pipe gets something
  // `jq` can read; everything a human would want goes to stderr. The same split
  // `turn` makes between the answer and the route it took.
  const json = options.has("json");
  const say = (line = ""): void => {
    if (json) console.error(dimErr(line));
    else console.log(line);
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    say(bold(`actions — subject ${id}`));
    say(
      dim(
        `  ${back.report.records} record(s) readable back from ${back.report.files.length} ` +
          `month file(s) · ${back.report.duplicates} duplicate(s) dropped by key`,
      ),
    );
    for (const line of formatActions(summary)) say(line);
    say();
    say(bold("The size of what a summary is:"));
    for (const note of ACTIONS_LIMITS) say(dim(`  - ${note}`));
  }

  const target = options.get("write");
  if (target === undefined || target === "") {
    say();
    say(
      dim(
        `Nothing was written. \`--write <agent-dir>\` puts ${SUMMARY_PATH} in that repository, ` +
          `one run at a time, and says first what a commit cannot undo.`,
      ),
    );
    return 0;
  }

  if (back.report.records === 0) {
    console.error(
      `mind: 0 record(s) under ${dir.path}, so there is nothing to summarise and nothing was ` +
        `written. Capture is off until \`mind observe enable --subject ${id}\`, and history ` +
        `arrives through \`mind observe seed\`.`,
    );
    return 1;
  }

  const repo = resolve(target);
  say();
  say(bold("Before this file exists: what a commit puts beyond Mind's reach"));
  for (const note of GIT_UNDELETABLE) say(dim(`  - ${note}`));

  const path = join(repo, ACTIONS_DIR, SUMMARY_FILE);
  await mkdir(join(repo, ACTIONS_DIR), { recursive: true });
  await Bun.write(path, `${JSON.stringify(summary, null, 2)}\n`);

  say();
  say(`wrote ${path}`);
  say(
    dim(
      "Mind did not stage it and did not commit it — there is no path in this program that " +
        "could. `git add` and `git commit` are yours, and the list above is about that step.",
    ),
  );
  return 0;
}

/**
 * `mind observe audit` — the instrument S3.2 AC4 needs, and no `--yes`.
 *
 * A terminal is required for the same reason `observe enable` requires one: a
 * program running as the owner can answer `y` a hundred times, and a percentage
 * produced that way is a measurement of nothing. Nothing is written, no consent
 * is asked for and none is needed, because nothing is kept — which is what lets
 * this be run before capture has ever been enabled.
 */
async function cmdObserveAudit(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  const usage = "usage: mind observe audit --vendor claude|grok --root <dir>";

  const rawVendor = options.get("vendor") ?? "";
  if (!isSeedVendor(rawVendor)) {
    return usageError(
      `${usage} — --vendor is one of ${SEED_VENDORS.join(", ")}, not ` +
        `${JSON.stringify(rawVendor)}`,
    );
  }
  const vendor: CaptureVendor = rawVendor;

  const root = options.get("root");
  if (root === undefined || root === "") {
    return usageError(
      `${usage} — --root has no default. Mind will not go looking through your home directory ` +
        `for transcripts; name the directory you mean.`,
    );
  }

  const io: AuditIo = {
    // The same swap, and the same reason, as in `observe enable` above.
    isTTY: process.stdin.isTTY === true && isatty(1),
    write: (line) => console.log(line),
    readLine: readTerminalLine,
  };
  if (!io.isTTY) {
    console.error(
      "mind: observe audit needs a terminal, and there is deliberately no --yes. S3.2 AC4 is a " +
        "person reading twenty files; a program answering `y` would produce a percentage that " +
        "measures nothing. Nothing was read and nothing was written.",
    );
    return 1;
  }

  const sample = await sampleActions({ root: resolve(root), vendor, now: new Date() });
  console.log(bold(`audit — ${vendor} · ${sample.root}`));
  console.log(
    dim(
      `  ${sample.filesFound} file(s) found · ${sample.filesRead.length} sampled · ` +
        `${sample.linesRead} line(s) read · ${sample.pairs.length} action(s) to judge`,
    ),
  );

  if (sample.pairs.length === 0) {
    console.log();
    console.log(bold("The size of what this measures:"));
    for (const note of AUDIT_LIMITS) console.log(dim(`  - ${note}`));
    console.error(
      "mind: no action was found to judge, so no number was produced. That is not an answer to " +
        "AC4 — exit 1 rather than a 0 somebody could read as a pass.",
    );
    return 1;
  }

  const verdicts = await judgeSample(io, sample);
  console.log();
  for (const line of formatAudit(verdicts)) console.log(line);
  console.log();
  console.log(bold("The size of what this measures:"));
  for (const note of AUDIT_LIMITS) console.log(dim(`  - ${note}`));

  if (!auditClears(verdicts)) {
    console.error(
      `mind: a judged field is under the ${AUDIT_FLOOR}% floor S3.2 AC4 fixes, or nothing was ` +
        `judged at all. S3.3 does not start on this reading.`,
    );
    return 1;
  }
  console.log(
    dim(
      `Every judged field cleared ${AUDIT_FLOOR}% — for the seed path of ${vendor}, on these ` +
        `files, judged by whoever was at this terminal. The hook path is a separate reading, and ` +
        `Mind does not edit .scrum/ for you: recording this is yours.`,
    ),
  );
  return 0;
}

/**
 * `mind observe leaks --subject <id> --fleet-dir <dir>...` — the audit D-036
 * promised for launchers that forgot `MIND_FLEET`. Counts only; relabels
 * nothing, and the directories are the caller's words, never the records'.
 */
async function cmdObserveLeaks(argv: readonly string[]): Promise<number> {
  const usage = "usage: mind observe leaks --subject <id> --fleet-dir <dir> [--fleet-dir <dir>...]";
  const fleetDirs = argv.flatMap((arg, i) =>
    arg === "--fleet-dir" && argv[i + 1] !== undefined ? [resolve(argv[i + 1] as string)] : [],
  );
  const rest = argv.filter((arg, i) => arg !== "--fleet-dir" && argv[i - 1] !== "--fleet-dir");
  const { options } = parseArgs(rest);
  const parsed = subjectOf(options, usage);
  if (!parsed.ok) return parsed.code;
  if (fleetDirs.length === 0) {
    return usageError(`${usage} — name at least one directory a fleet launcher runs in`);
  }
  const dir = await observerDir(observerEnv(), parsed.id);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return 1;
  }
  const counts = fleetLeaks((await readCaptured(dir.path)).records, fleetDirs);
  console.log(bold(`leaks — subject ${parsed.id}`));
  for (const line of formatFleetLeaks(counts)) console.log(line);
  console.log();
  console.log(bold("The size of what this counts:"));
  for (const note of FLEET_LEAK_LIMITS) console.log(dim(`  - ${note}`));
  return Object.values(counts).some((n) => n > 0) ? 1 : 0;
}

/**
 * `mind observe patterns --subject <id> [--limit <n>]` — S3.3's routines
 * and sequences, printed and not kept (D-057). The box is opened in
 * `src/observer/patterns.ts`; this command hands it the terminal.
 */
async function cmdObservePatterns(argv: readonly string[]): Promise<number> {
  const { options } = parseArgs(argv);
  const usage = "usage: mind observe patterns --subject <id> [--limit <n>]";
  const parsed = subjectOf(options, usage);
  if (!parsed.ok) return parsed.code;
  const limit = Number(options.get("limit") ?? "10");
  if (!Number.isInteger(limit) || limit < 1) return usageError(`${usage} — --limit is a whole number, 1 or more`);
  const dir = await observerDir(observerEnv(), parsed.id);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return 1;
  }
  console.log(bold(`patterns — subject ${parsed.id}`));
  printPatterns((await readCaptured(dir.path)).records, (line) => console.log(line), {
    clock: systemClock(),
    home: observerEnv().home,
    limit,
  });
  console.log();
  console.log(dim("Recomputed from what capture holds on every run; nothing is saved, and nothing here leaves this terminal (D-057)."));
  return 0;
}

/**
 * `mind observe interests --subject <id> --root <dir>... [--half-life <days>] [--limit <n>]`
 * — S3.4 (D-064): projects ranked by frequency × recency, counted through
 * `countPersonal` over the directories under the roots named. Nothing kept.
 */
async function cmdObserveInterests(argv: readonly string[]): Promise<number> {
  const usage = "usage: mind observe interests --subject <id> --root <dir> [--root <dir>...] [--half-life <days>] [--limit <n>]";
  const roots = argv.flatMap((arg, i) => (arg === "--root" && argv[i + 1] !== undefined ? [resolve(argv[i + 1] as string)] : []));
  const rest = argv.filter((arg, i) => arg !== "--root" && argv[i - 1] !== "--root");
  const { options } = parseArgs(rest);
  const parsed = subjectOf(options, usage);
  if (!parsed.ok) return parsed.code;
  if (roots.length === 0) return usageError(`${usage} — name at least one root; Mind will not go looking through your home directory`);
  const halfLife = Number(options.get("half-life") ?? "7");
  const limit = Number(options.get("limit") ?? "5");
  if (!(halfLife > 0 && halfLife <= 365) || !Number.isInteger(limit) || limit < 1) return usageError(`${usage} — --half-life is 1 to 365 days, --limit a whole number`);
  const dir = await observerDir(observerEnv(), parsed.id);
  if (!dir.ok) {
    console.error(`mind: ${dir.reason}`);
    return 1;
  }
  const ranked = rankInterests((await readCaptured(dir.path)).records, { dirs: await candidateDirs(roots), roots, now: new Date(), halfLifeDays: halfLife });
  console.log(bold(`interests — subject ${parsed.id}`));
  for (const line of formatInterests(ranked, { limit, halfLifeDays: halfLife, home: observerEnv().home })) console.log(line);
  console.log();
  console.log(dim("Counts only, over directories on your disk; recomputed on every run and never kept (D-064)."));
  return 0;
}

export async function cmdObserve(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "status":
      return cmdObserveStatus(rest);
    case "actions":
      return cmdObserveActions(rest);
    case "audit":
      return cmdObserveAudit(rest);
    case "purge":
      return cmdObservePurge(rest);
    case "enable":
      return cmdObserveEnable(rest);
    case "disable":
      return cmdObserveDisable(rest);
    case "capture":
      return cmdObserveCapture(rest);
    case "hook":
      return cmdObserveHook(rest);
    case "seed":
      return cmdObserveSeed(rest);
    case "leaks":
      return cmdObserveLeaks(rest);
    case "patterns":
      return cmdObservePatterns(rest);
    case "interests":
      return cmdObserveInterests(rest);
    default:
      return usageError(
        `unknown observe subcommand ${JSON.stringify(sub ?? "")} — try "status", "enable", ` +
          `"disable", "hook", "capture", "seed", "actions", "audit", "leaks", "patterns", "interests" or "purge"`,
      );
  }
}
