/**
 * S22.9 (D-197) — what the fleet page shows, and the three things it may do.
 *
 * One view for every bot of a roster, assembled from what already exists and nothing new: the roster (S22.5), each
 * bot's tasks (`personal/tasks/`), the resting book (S22.2, `health.json`) and the ledger. **Metadata only**
 * (AC6): ids, statuses, counts, times and prices. No prompt, no answer, no goal and no task note is ever in a
 * view; a person who wants the words opens the task or the turn, where they already are.
 *
 * The three actions a person may take, each narrow on purpose:
 *
 * - rest a backend for a while, up to a day, by hand — a backend of this roster, no other id;
 * - wake a backend, clearing what it had earned;
 * - stop a bot — ask each of its running tasks to stop, as `mind task stop` does.
 *
 * None of them sends anything to a vendor, so none needs the confirmation I-6 asks of a send (AC3); the page offers no
 * button that starts a turn. Pure but for the IO the caller passes in (`FleetIo`): this file reads no file and no clock.
 */

import type { HealthControl, Hold } from "../exec/health.ts";
import { MANUAL_REASON, MAX_MANUAL_REST_MS } from "../exec/health.ts";
import type { LedgerEntry } from "../ledger/entry.ts";
import type { Measure } from "../dispatch/measure.ts";
import { tableOf, type Row } from "../dispatch/table.ts";
import { FINAL_STATUSES, shownStatus, type TaskRecord } from "../task/store.ts";
import { isLocalBackend } from "../web/turninfo.ts";
import type { Bot } from "./roster.ts";

export type BotStatus = "idle" | "working" | "resting" | "parked";
export type Reach = "ok" | "no" | "unknown";

export interface FleetIo {
  /** Every task of this subject, newest or oldest — the view sorts. */
  readonly tasks: (subject: string) => Promise<readonly TaskRecord[]>;
  /** Every ledger line of this subject. Only metadata of it is read. */
  readonly ledger: (subject: string) => Promise<readonly LedgerEntry[]>;
  /** Whether a backend can answer now. Must not spend quota (`available()`). */
  readonly reach: (backend: string) => Promise<{ readonly ok: boolean; readonly reason?: string } | undefined>;
  /** Ask one task to stop, as `mind task stop` does. */
  readonly stopTask: (bot: Bot, task: string) => Promise<{ readonly ok: boolean; readonly status?: string; readonly reason?: string }>;
  readonly liveness?: Parameters<typeof shownStatus>[1];
  /** S22.14: the measure lines of this subject. Absent: the page shows no table. */
  readonly measures?: (subject: string) => Promise<readonly Measure[]>;
}

export interface BotView {
  readonly id: string;
  readonly subject: string;
  readonly home: string;
  readonly spares: readonly string[];
  readonly scope: string;
  readonly status: BotStatus;
  /** The task it is on, or last was: id, status and counts — never its goal. */
  readonly task: { readonly id: string; readonly status: string; readonly steps: number } | null;
  readonly handoffs: readonly { readonly id: string; readonly branch: string; readonly base: string; readonly changedFiles: number; readonly diffStat: string; readonly mergeCommand: string }[];
  /** The backend that answered its last step, when a task has one. */
  readonly using: string | null;
  /** Its home backend's rest, when the home is resting. */
  readonly homeRest: BackendRest | null;
  readonly spent: { readonly turns: number; readonly cloudTurns: number; readonly costUsdMicros: number; readonly unpriced: number; readonly lastAt: string | null };
  /** Whether the page can stop it: the roster names its directory. */
  readonly canStop: boolean;
}

export interface BackendRest {
  readonly until: string;
  readonly kind: "exhausted" | "auth";
  readonly reason: string;
  readonly byHand: boolean;
}

export interface BackendView {
  readonly id: string;
  readonly reach: Reach;
  readonly reachReason: string | null;
  readonly rest: BackendRest | null;
  /** Bot ids that call it home or may borrow it. */
  readonly bots: readonly string[];
}

export interface FleetView {
  readonly bots: readonly BotView[];
  readonly backends: readonly BackendView[];
  /** S22.14 AC4: what the measure lines say per (backend, model, kind of work), each with its n, so a rate from three tasks is not read as certain. */
  readonly dispatch: readonly Row[];
  readonly at: string;
}

/** A task that has not ended, by what it is shown as (an interrupted task is shown as such, and is not over). */
function unfinished(record: TaskRecord, io: FleetIo, now: number): boolean {
  return !(FINAL_STATUSES as readonly string[]).includes(shownStatus(record, io.liveness, now));
}

function restOf(hold: Hold | undefined): BackendRest | null {
  return hold === undefined ? null : { until: new Date(hold.until).toISOString(), kind: hold.kind, reason: hold.reason, byHand: hold.reason === MANUAL_REASON };
}

/** What the ledger lines say about spending: counts and prices, never a line's words. */
export function spentOf(entries: readonly LedgerEntry[]): BotView["spent"] {
  let cloudTurns = 0;
  let costUsdMicros = 0;
  let unpriced = 0;
  let last: string | null = null;
  for (const entry of entries) {
    if (last === null || entry.at > last) last = entry.at;
    if (isLocalBackend(entry.backend)) continue;
    cloudTurns += 1;
    if (entry.cost === null) unpriced += 1;
    else costUsdMicros += entry.cost.usd_micros;
  }
  return { turns: entries.length, cloudTurns, costUsdMicros, unpriced, lastAt: last };
}

export async function fleetView(bots: readonly Bot[], io: FleetIo, health: HealthControl, now: number): Promise<FleetView> {
  const resting = health.resting(now);
  const views: BotView[] = [];
  for (const bot of bots) {
    const tasks = [...(await io.tasks(bot.subject))].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const live = tasks.find((record) => unfinished(record, io, now));
    const shown = live === undefined ? undefined : shownStatus(live, io.liveness, now);
    const subject = live ?? tasks[0];
    const chain = [bot.home, ...bot.spares];
    const allResting = chain.every((id) => resting.has(id));
    let status: BotStatus = "idle";
    if (shown === "waiting-backend" || allResting) status = "resting";
    else if (shown === "parked" || shown === "interrupted") status = "parked";
    else if (shown !== undefined) status = "working";
    const answered = (subject?.steps ?? []).filter((step) => step.backend !== null).at(-1);
    views.push({
      id: bot.id,
      subject: bot.subject,
      home: bot.home,
      spares: bot.spares,
      scope: bot.scope,
      status,
      task: subject === undefined ? null : { id: subject.id, status: shownStatus(subject, io.liveness, now), steps: subject.steps.length },
      handoffs: tasks.flatMap((record) => {
        const h = record.handoff;
        if (h === undefined) return [];
        const count = h.diffStat.match(/(?:^|\n)\s*(\d+) files? changed(?:,|\s*$)/);
        return [{ id: record.id, branch: h.branch, base: h.base, changedFiles: count === null ? 0 : Number(count[1]), diffStat: h.diffStat, mergeCommand: h.mergeCommand }];
      }),
      using: answered?.backend ?? null,
      homeRest: restOf(resting.get(bot.home)),
      spent: spentOf(await io.ledger(bot.subject)),
      canStop: bot.dir !== undefined,
    });
  }
  const ids = [...new Set(bots.flatMap((bot) => [bot.home, ...bot.spares]))].sort();
  const backends: BackendView[] = [];
  for (const id of ids) {
    const reached = await io.reach(id);
    backends.push({
      id,
      reach: reached === undefined ? "unknown" : reached.ok ? "ok" : "no",
      reachReason: reached?.reason ?? null,
      rest: restOf(resting.get(id)),
      bots: bots.filter((bot) => bot.home === id || bot.spares.includes(id)).map((bot) => bot.id),
    });
  }
  const measures = io.measures === undefined ? [] : (await Promise.all(bots.map((bot) => io.measures!(bot.subject)))).flat();
  return { bots: views, backends, dispatch: tableOf(measures), at: new Date(now).toISOString() };
}

export type ActionResult = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly reason: string };

/** Rest a backend of this roster by hand, for `minutes` (1 to 1440). */
export function restBackend(bots: readonly Bot[], health: HealthControl, id: string, minutes: unknown, now: number): ActionResult {
  if (!bots.some((bot) => bot.home === id || bot.spares.includes(id))) return { ok: false, reason: `${JSON.stringify(id)} is not a backend of this fleet` };
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes * 60_000 > MAX_MANUAL_REST_MS) {
    return { ok: false, reason: "minutes is a whole number from 1 to 1440" };
  }
  health.rest(id, now + minutes * 60_000, now);
  return { ok: true, message: `${id} rests for ${minutes} minute(s), by hand` };
}

/** Call a backend of this roster back at once. */
export function wakeBackend(bots: readonly Bot[], health: HealthControl, id: string): ActionResult {
  if (!bots.some((bot) => bot.home === id || bot.spares.includes(id))) return { ok: false, reason: `${JSON.stringify(id)} is not a backend of this fleet` };
  return { ok: true, message: health.wake(id) ? `${id} is called back` : `${id} was not resting` };
}

/** Ask every unfinished task of a bot to stop. A bot the roster gives no directory for cannot be stopped from here. */
export async function stopBot(bots: readonly Bot[], io: FleetIo, botId: string, now: number): Promise<ActionResult & { readonly tasks?: readonly string[] }> {
  const bot = bots.find((entry) => entry.id === botId);
  if (bot === undefined) return { ok: false, reason: `${JSON.stringify(botId)} is not a bot of this fleet` };
  if (bot.dir === undefined) return { ok: false, reason: `the roster gives ${bot.id} no dir, so its tasks cannot be stopped from here (\`mind task stop\` can)` };
  const open = (await io.tasks(bot.subject)).filter((record) => unfinished(record, io, now));
  const stopped: string[] = [];
  const failed: string[] = [];
  for (const record of open) {
    const result = await io.stopTask(bot, record.id);
    (result.ok ? stopped : failed).push(record.id);
  }
  if (failed.length > 0) return { ok: false, reason: `could not stop ${failed.join(", ")}`, tasks: stopped };
  return { ok: true, message: stopped.length === 0 ? `${bot.id} has no task to stop` : `${bot.id}: asked ${stopped.length} task(s) to stop`, tasks: stopped };
}
