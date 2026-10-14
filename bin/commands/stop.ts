/**
 * `mind stop` — S5.4, in a fixed order, where the step most likely to work
 * comes first.
 *
 * 1. **Set the brake.** A file under the state root. No parsing, no network, no
 *    repository, no process to find. Somebody typing this command wants the
 *    next turn not to start, and this is the step that cannot really fail.
 * 2. **Take every category to 0 in `autonomy.md`,** when a directory was named.
 *    A convenience: a repository that cannot be written does not stop steps 1
 *    or 3. Step 1 is the answer; this one makes the intent visible in `git
 *    diff`.
 * 3. **End the turns that are running.** Read the run records, check that each
 *    pid is still the process the record was written about, signal what can be
 *    identified, and **print the command for what cannot**.
 * 4. **`docker kill` every browser task** of this state root (D-151), recorded
 *    or not — a container is identified by its labels, never by a guess.
 * 5. **Ask every task to stop** (D-154): its runner starts no next step, also
 *    after the brake is released — and, S18.1, stop its unit when it runs in
 *    one of its own (`mind-task-<id>`), so the runner closes the task now.
 *
 * Each step reports separately and a failure in one does not skip the next,
 * because the person running this does not get to choose which failure they are
 * having.
 *
 * ## What it refuses to do
 *
 * It never signals a process it cannot identify. A pid is reused, so a record
 * whose pid now has a different start time is `stale` and is reported rather
 * than acted on; a machine with no `/proc` gets the manual command instead of a
 * guess. And it addresses a *group* only where the target is its own group
 * leader — which is the shape `detached: true` gives the vendor children, and
 * the shape an inherited group never has. See `src/decide/runs.ts` for the
 * measurements behind both rules.
 */

import {
  STOP_CANNOT,
  arm,
  manualCommand,
  procAvailable,
  readRuns,
  removeRunRecord,
  terminateRun,
  type StoredRun,
  type TerminationReport,
} from "../../src/decide/index.ts";
import { BROWSER_LABEL, sweepBrowsers } from "../../src/browser/runtime.ts";
import { askEveryTaskToStop } from "../../src/task/control.ts";
import { endTaskUnit, runShort, taskUnitName } from "../../src/task/unit.ts";
import { subjectId } from "../../src/types.ts";
import { decideDial, dialEnv, whoIsSetting, writeDial } from "../dial.ts";
import { ERR, OUT, parseArgs, usageError } from "../shared.ts";

const STOP_USAGE = "usage: mind stop [<dir> --subject <id>]";

/** How long a settle between polls is. Never asserted on — see the tests. */
const POLL_MS = 25;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, POLL_MS));

/** One turn's outcome, in the words the person reading this needs. */
function sayTermination(report: TerminationReport, stored: StoredRun): void {
  const { record } = report;
  OUT.line(
    `  ${record.turnId}  subject ${record.subject}  backends ${record.backends.join(" → ")}  ` +
      `started ${record.startedAt}`,
  );
  OUT.line(`    Mind pid ${record.pid}, its process group ${record.pgid} — ${report.liveness}`);

  if (report.refusal !== undefined) {
    OUT.line(`    nothing was signalled: ${report.refusal}`);
    OUT.line(`    to do it by hand, after checking that ${record.pgid} is what you think it is:`);
    OUT.line(`      ${manualCommand(record.pgid)}`);
    return;
  }

  for (const sent of report.signalled) {
    OUT.line(
      `    ${sent.signal} → ${sent.how === "group" ? `process group ${sent.pid}` : `pid ${sent.pid}`}` +
        `${sent.failed === undefined ? "" : ` — not delivered: ${sent.failed}`}`,
    );
    // A narrowed signal reached less than it looks like it reached. Said here
    // rather than inferred from the survivors, because the survivors list only
    // holds what Mind knew to watch.
    if (sent.narrowed !== undefined) OUT.line(OUT.dim(`      narrowed: ${sent.narrowed}`));
  }
  if (report.signalled.length === 1) {
    OUT.line(
      `    no vendor process was found under it — the turn had not spawned one yet, or it had ` +
        `already finished.`,
    );
  }

  // D-149 review: run from inside the turn (the agent, or a script it ran), this
  // command is part of the tree it stops, and it is the one process left alone.
  if (report.spared !== undefined) {
    OUT.line(
      `    pid ${report.spared} is this stop command, running inside the turn it stopped. It was not ` +
        `signalled, so that it could finish; it ends when it exits.`,
    );
  }

  if (report.survivors.length === 0) {
    OUT.line(`    everything this record named is gone${report.spared === undefined ? "" : ", but this command"}.`);
    void removeRunRecord(stored.path);
    return;
  }
  OUT.line(`    still alive after SIGTERM and SIGKILL:`);
  for (const survivor of report.survivors) {
    OUT.line(`      pid ${survivor.pid}, group ${survivor.pgid} — ${manualCommand(survivor.pgid, "KILL")}`);
  }
  OUT.line(
    `    these outlived SIGTERM and then SIGKILL (D-044). A process that survives SIGKILL is ` +
      `stuck in the kernel — usually waiting on a disk or a network mount — and no signal ` +
      `reaches it until that returns.`,
  );
}

/**
 * `mind stop` — the brake, the dial, and the processes, in that order.
 *
 * Exit 0 when everything it could identify is gone, 1 when something survived or
 * a step failed. There is no `--yes`: stopping is the safe direction, and a
 * confirmation prompt in front of a kill switch is a way of not having one.
 */
export async function cmdStop(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  const dir = positional[0];
  const subject = options.get("subject");
  if (dir !== undefined && (subject === undefined || subject === "")) {
    return usageError(STOP_USAGE);
  }
  if (subject !== undefined && subject !== "") {
    try {
      subjectId(subject);
    } catch (error) {
      return usageError(error instanceof Error ? error.message : String(error));
    }
  }

  const env = dialEnv();
  let failures = 0;

  // --- 1. the brake ---------------------------------------------------------
  OUT.line(OUT.bold("1. the brake"));
  let brake: string | undefined;
  try {
    brake = await arm(env, new Date(), dir === undefined ? "mind stop" : `mind stop ${dir}`);
    OUT.line(`  set: ${brake}`);
    OUT.line(
      OUT.dim(
        `  no turn will start while that file exists. It is not in git and must never be: a ` +
          `committed brake travels to every clone, and a machine nobody stopped would find ` +
          `itself stopped with nothing there to say why.`,
      ),
    );
  } catch (error) {
    failures += 1;
    OUT.line(`  COULD NOT SET: ${String(error)}`);
    OUT.line(
      `  This is the step that matters most, so do it by hand: touch the file above. Steps 2 ` +
        `and 3 are going ahead regardless.`,
    );
  }

  // --- 2. the dial ----------------------------------------------------------
  OUT.line("");
  OUT.line(OUT.bold("2. the dial"));
  if (dir === undefined) {
    OUT.line(
      OUT.dim(
        `  no directory given, so no autonomy.md was written. The brake above already holds ` +
          `every category at 0 whatever any file says; this step only makes the intent visible ` +
          `in \`git diff\`.`,
      ),
    );
  } else {
    const before = await decideDial(dir);
    if (before.source === "file-unreadable") {
      OUT.line(`  ${before.path} could not be read, so it was left alone.`);
      OUT.line(
        OUT.dim(
          `  An unreadable dial already means every category is 0, so nothing is lost by not ` +
            `writing it — and overwriting a file Mind could not understand would throw away ` +
            `whatever whoever wrote it meant.`,
        ),
      );
    } else {
      try {
        const path = await writeDial(dir, {
          read: 0,
          write: 0,
          run: 0,
          reach: 0,
          operate: 0,
          setBy: await whoIsSetting(dir),
          setAt: new Date().toISOString(),
        });
        OUT.line(`  every category set to 0 in ${path}`);
        OUT.line(
          OUT.dim(
            `  that file is tracked by git, so your working tree is now dirty. That is the ` +
              `intended cost: a stop that leaves a visible change is better than one that ` +
              `leaves none, and \`git diff\` is where somebody will look.`,
          ),
        );
      } catch (error) {
        failures += 1;
        OUT.line(`  COULD NOT WRITE: ${String(error)}`);
        OUT.line(`  The brake in step 1 does not depend on this, and step 3 is going ahead.`);
      }
    }
  }

  // --- 3. the turns that are running ---------------------------------------
  OUT.line("");
  OUT.line(OUT.bold("3. turns that are running"));
  if (!procAvailable()) {
    OUT.line(
      `  there is no readable /proc on this machine, so Mind cannot show that a recorded pid ` +
        `is still the process it was recorded for. Nothing will be signalled — a kill switch ` +
        `that guesses is the thing a kill switch is for preventing.`,
    );
  }

  const inventory = await readRuns(env);
  for (const bad of inventory.unreadable) {
    OUT.line(`  unreadable record ${bad.path}: ${bad.reason}`);
  }
  if (inventory.runs.length === 0) {
    OUT.line(`  none recorded under ${env.env["XDG_STATE_HOME"] ?? "the state root"}.`);
    OUT.line(
      OUT.dim(
        `  That is not the same as "nothing is running": a turn started by a build of Mind ` +
          `from before run records existed leaves nothing on disk to find, and neither does one ` +
          `using a different state root.`,
      ),
    );
  }

  for (const stored of inventory.runs) {
    const report = procAvailable()
      ? await terminateRun(stored, { settle, attempts: 160 })
      : ({
          record: stored.record,
          liveness: "unverifiable" as const,
          signalled: [],
          survivors: [],
          refusal: "there is no readable /proc on this machine",
        } satisfies TerminationReport);
    sayTermination(report, stored);
    if (report.survivors.length > 0 || report.refusal !== undefined) failures += 1;
  }

  // --- 4. browser tasks (D-151) ---------------------------------------------
  // After the turns, so no turn starts a container this step has already passed.
  OUT.line("");
  OUT.line(OUT.bold("4. browser tasks"));
  const browsers = await sweepBrowsers(env, { all: true });
  if (browsers.error !== undefined) {
    OUT.line(`  docker could not be asked (${browsers.error}); if a browser task is running, end it with:`);
    OUT.line(`    docker kill $(docker ps -q --filter label=${BROWSER_LABEL}=1)`);
  } else if (browsers.actions.length === 0) {
    OUT.line("  none running.");
  }
  for (const action of browsers.actions) {
    OUT.line(
      `  ${action.container}${action.task === null ? "" : ` (task ${action.task})`}: ` +
        (action.ok ? action.detail : `NOT ended: ${action.detail} — docker kill ${action.container}`),
    );
    if (!action.ok) failures += 1;
  }

  // --- 5. tasks (D-154) -----------------------------------------------------
  // Their step's turn was ended in step 3 and their browser in step 4; this asks each not to start another, so a
  // task does not carry on once the brake is released.
  OUT.line("");
  OUT.line(OUT.bold("5. tasks"));
  try {
    const asked = await askEveryTaskToStop(env, new Date(), "mind stop");
    if (asked.length === 0) OUT.line("  none running.");
    for (const task of asked) {
      // Queued, not waited on (`--no-block`): this command may be running inside that very task's step.
      const unit = await endTaskUnit(task.id, runShort, env.env);
      OUT.line(`  ${task.id} (subject ${task.subject}, ${task.status}): asked to stop${unit === "asked" ? `; its unit ${taskUnitName(task.id)} is being stopped` : ""}`);
    }
  } catch (error) {
    failures += 1;
    OUT.line(`  COULD NOT ASK: ${String(error)} — \`mind task stop <task>\` each one`);
  }

  // --- what it did not do ---------------------------------------------------
  OUT.line("");
  OUT.line(OUT.bold("What this command cannot do:"));
  for (const line of STOP_CANNOT) OUT.line(`  - ${line}`);
  OUT.line("");
  OUT.line(
    `Start again with \`mind autonomy resume\`, which asks for a typed phrase — or delete ` +
      `${brake ?? "the brake file"} yourself, which Mind will not pretend it can prevent.`,
  );

  if (failures > 0) {
    ERR.line(
      `mind: ${failures} part(s) of the stop did not complete. Everything above that named a ` +
        `command is yours to run.`,
    );
  }
  return failures > 0 ? 1 : 0;
}
