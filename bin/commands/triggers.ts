/**
 * `mind triggers` — turns that start on a schedule (S5.3, D-054).
 *
 * `tick` is the whole mechanism: it reads `triggers.md`, runs what is due as
 * ordinary `mind turn` children held at level 1, records when each fired,
 * and exits. Something else — a systemd timer, cron — calls it; `schedule`
 * prints both and installs neither.
 */

import { readMind } from "../../src/env.ts";
import { AUTONOMY_MAX_ENV } from "../../src/decide/effective.ts";
import {
  dueTriggers,
  exampleTriggers,
  firedPath,
  lockFired,
  markFired,
  nextDue,
  parseTriggers,
  readFired,
  triggeredCeiling,
  triggersDirFor,
  TRIGGERS_FILE,
  type Trigger,
} from "../../src/decide/triggers.ts";
import { engineCommand, shellQuote } from "../../src/guard/hooks.ts";
import { runGuarded } from "../../src/spawn.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { DIAL_REFUSED, decideDial, dialEnv } from "../dial.ts";
import { dim, parseArgs, report, usageError } from "../shared.ts";
import { join, resolve } from "node:path";

const USAGE =
  "usage: mind triggers show <dir> --subject <id>\n" +
  "       mind triggers tick <dir> --subject <id> [--backend a,b] [--model <m>]\n" +
  "       mind triggers schedule <dir> --subject <id> [--every <5m>]";

type Target =
  | { ok: true; dir: string; id: SubjectId; options: ReadonlyMap<string, string> }
  | { ok: false; code: number };

function target(argv: readonly string[]): Target {
  const { positional, options } = parseArgs(argv);
  const dir = positional[0];
  const raw = options.get("subject");
  if (dir === undefined || positional.length > 1 || raw === undefined || raw === "") {
    return { ok: false, code: usageError(USAGE) };
  }
  try {
    return { ok: true, dir, id: subjectId(raw), options };
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
}

/** The triggers, or the exit code that says why there are none to run. */
async function load(dir: string): Promise<{ ok: true; triggers: readonly Trigger[] } | { ok: false; code: number }> {
  const handle = Bun.file(join(dir, TRIGGERS_FILE));
  if (!(await handle.exists())) {
    console.log(`no ${TRIGGERS_FILE} in ${dir} — nothing runs by itself. One looks like this:\n`);
    console.log(dim(exampleTriggers()));
    return { ok: true, triggers: [] };
  }
  const parsed = parseTriggers(TRIGGERS_FILE, await handle.text());
  if (!parsed.ok) return { ok: false, code: report(parsed.issues) };
  return { ok: true, triggers: parsed.value };
}

async function cmdShow(argv: readonly string[]): Promise<number> {
  const t = target(argv);
  if (!t.ok) return t.code;
  const loaded = await load(t.dir);
  if (!loaded.ok) return loaded.code;
  if (loaded.triggers.length === 0) return 0;
  const fired = await readFired(firedPath(t.dir, triggersDirFor(dialEnv(), t.id)));
  const now = new Date();
  for (const trigger of loaded.triggers) {
    const due = nextDue(trigger, fired, now);
    console.log(
      `${trigger.id.padEnd(20)} every ${trigger.every.padEnd(5)} ` +
        `last ${fired[trigger.id] ?? "never"} · next ${due <= now ? "due now" : due.toISOString()}`,
    );
  }
  console.log(dim("\nEach runs as a turn held at level 1: it proposes, and nothing it proposes happens until somebody approves it (D-054)."));
  return 0;
}

async function cmdTick(argv: readonly string[]): Promise<number> {
  const t = target(argv);
  if (!t.ok) return t.code;
  const loaded = await load(t.dir);
  if (!loaded.ok) return loaded.code;
  if (loaded.triggers.length === 0) return 0;

  // AC3 — the brake and a dial at 0 are asked before anything is marked: a
  // trigger that was refused has not fired, and fires once the brake is off.
  const verdict = await decideDial(t.dir, dialEnv(), t.id);
  if (verdict.effective.act === 0) {
    console.error(`mind: no trigger ran — the autonomy dial is at 0 (${verdict.effective.stopped ? "the brake is set" : "set to 0"}).`);
    return DIAL_REFUSED;
  }

  const record = firedPath(t.dir, triggersDirFor(dialEnv(), t.id));
  const lock = await lockFired(record);
  if (!lock.ok) {
    console.error(`mind: ${lock.reason}; this tick does nothing.`);
    return 0;
  }
  try {
    const now = new Date();
    const before = await readFired(record);
    const due = dueTriggers(loaded.triggers, before, now);
    if (due.length === 0) {
      console.log("nothing is due");
      return 0;
    }
    const passOn = ["backend", "model"].flatMap((name) => {
      const value = t.options.get(name);
      return value === undefined || value === "" ? [] : [`--${name}`, value];
    });
    const env = { ...process.env, [AUTONOMY_MAX_ENV]: triggeredCeiling(readMind(AUTONOMY_MAX_ENV, process.env)) };
    let failed = 0;
    for (const trigger of due) {
      // Marked before the turn: a turn that crashes, hangs until killed, or
      // is stopped mid-way waits for its next window instead of firing again
      // on every tick in between (AC5).
      await markFired(record, trigger.id, now);
      console.error(dim(`mind: trigger ${trigger.id} (every ${trigger.every}) — a turn held at level 1`));
      const run = await runGuarded(
        [...engineCommand().argv, "turn", resolve(t.dir), "--subject", t.id, "--prompt", trigger.prompt, ...passOn],
        { env },
      );
      const out = new TextDecoder().decode(run.stdout).trimEnd();
      if (out !== "") console.log(out);
      if (run.stderr !== "") console.error(run.stderr);
      if (run.code === DIAL_REFUSED) {
        // The brake landed mid-tick. A refused turn has not fired (AC3).
        await markFired(record, trigger.id, before[trigger.id] ?? null);
        console.error(`mind: trigger ${trigger.id} was refused by the dial or the brake; the rest do not run.`);
        return DIAL_REFUSED;
      }
      if (run.code !== 0) failed += 1;
    }
    return failed === 0 ? 0 : 1;
  } finally {
    await lock.release();
  }
}

/** AC4 — print how the OS would call `tick`; install nothing. */
async function cmdSchedule(argv: readonly string[]): Promise<number> {
  const t = target(argv);
  if (!t.ok) return t.code;
  const every = t.options.get("every") ?? "5m";
  const match = /^([1-9]|[1-5][0-9])m$/.exec(every);
  if (match === null) {
    return usageError(`--every is how often to tick, 1m to 59m — "5m", "15m". Got ${JSON.stringify(every)}.`);
  }
  const command = [...engineCommand().argv, "triggers", "tick", resolve(t.dir), "--subject", t.id].map(shellQuote).join(" ");
  const unit = `mind-triggers-${t.id}`;
  console.log(`# systemd (user) — ~/.config/systemd/user/${unit}.service`);
  console.log(`[Unit]\nDescription=mind triggers for ${t.id}\n\n[Service]\nType=oneshot\nExecStart=${command}\n`);
  console.log(`# ~/.config/systemd/user/${unit}.timer`);
  console.log(`[Unit]\nDescription=mind triggers for ${t.id}\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=${match[1]}min\n\n[Install]\nWantedBy=timers.target\n`);
  console.log(`# then: systemctl --user daemon-reload && systemctl --user enable --now ${unit}.timer`);
  console.log(`\n# or cron (crontab -e):\n*/${match[1]} * * * * ${command}`);
  console.log(dim("\nNothing was installed. Mind runs no daemon; the tick exits after running what is due (D-054)."));
  return 0;
}

export async function cmdTriggers(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "show":
      return cmdShow(rest);
    case "tick":
      return cmdTick(rest);
    case "schedule":
      return cmdSchedule(rest);
    default:
      return usageError(`unknown triggers subcommand ${JSON.stringify(sub ?? "")} — try "show", "tick" or "schedule"`);
  }
}
