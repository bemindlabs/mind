/**
 * Run records — the thing that makes a kill switch possible at all, and the
 * thing that makes the manual command possible when it is not.
 *
 * Before this file, a turn that was killed mid-flight left **nothing**: the
 * ledger is written after the vendor answers (`src/ledger/recording.ts`), and
 * nothing anywhere recorded that a turn had started. A process that died between
 * those two moments was invisible afterwards, and there was no number anybody
 * could have typed to stop it.
 *
 * ## `pid_start` is the whole of the safety
 *
 * A pid is reused. A record saying "pid 4812 is a turn" is, some hours later, a
 * record saying "kill whatever is now 4812", and what is now 4812 might be
 * anything at all. So every record also stores field 22 of `/proc/<pid>/stat` —
 * the process's start time in clock ticks since boot — and a record whose pid
 * exists with a *different* start time is classified `stale` and **never
 * signalled**.
 *
 * This is not the guess `src/ledger/store.ts` refuses to make about a lock
 * (*"Mind does not guess that a lock is stale"*). A start time is a fact that
 * can be compared: either the process running under that number is the one the
 * record was written about, or it is not. A machine with no `/proc` cannot do
 * the comparison, and there the answer is to refuse to signal and print the
 * manual command instead — never to signal on a pid alone.
 *
 * ## Why the vendor child is spawned detached, and what it cost
 *
 * Measured 2026-09-22 on this runtime, over nine invocation shapes, and the
 * answer is **split** — which is worth saying plainly, because the one-line
 * version ("Mind's process group belongs to the shell") is true of some
 * shapes and false of the one a person is most likely to be in:
 *
 * - **With a controlling terminal, a foreground job gets a group of its own.**
 *   Measured: `pgid` equal to its own pid, one member, Mind. So for somebody
 *   typing `mind turn …` at a shell, the collision this file guards against
 *   **does not happen** and `detached` buys nothing at all.
 * - **Without one, every shape measured shared the caller's group.** A
 *   non-interactive `bash -c`, the same piped, `bash -ic` with no tty, a direct
 *   spawn with no shell between, and `npm exec` all came back with 5 to 7
 *   members of which exactly one was Mind — the rest being the invoking
 *   harness, `npm`, `sh` and the shell. Printing that number under the words
 *   `kill -TERM -<pgid>` would hand somebody a command that kills their own
 *   session. These are also the shapes an unattended agent runs under, which is
 *   the case a kill switch exists for.
 * - **A pipeline puts a stranger in the group even with a terminal.** Measured:
 *   `mind … | cat` at an interactive shell makes Mind the group *leader*
 *   with `cat` in the group beside it. Leading a group is therefore **not**
 *   proof that the group holds nothing but a process and its descendants — see
 *   {@link strangersInGroup}, which checks rather than assumes it.
 * - `Bun.spawn(..., { detached: true })` gives the child a group of its own with
 *   itself as leader, which makes `kill -TERM -<pgid>` exact.
 *
 * What it costs: a detached child no longer receives the terminal's Ctrl-C, so
 * Mind has to pass a signal on itself, which is machinery that can break at the
 * same moment everything else does. That cost is acceptable for one measured
 * reason — Ctrl-C **was never reliable here anyway**. A grandchild started as a
 * shell background job ignores SIGINT by POSIX default and survived a group
 * SIGINT in measurement; the same process died on a group SIGTERM. The thing
 * being protected by staying attached does not work.
 *
 * ## Nothing in this file signals anything it has not identified first
 *
 * {@link terminateRun} sends to a *group* only when the target process leads
 * that group **and every other member of it descends from the target** — both
 * halves, because the measurement above found a shape where the first holds and
 * the second does not. A process that fails either test gets a signal addressed
 * to it alone, and is told so in the report. There is no path here that sends
 * to a negative pid taken on trust.
 */

import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";

/** Schema tag every run record carries. */
export const RUN_SCHEMA = "mind/run@1";

/** The directory under the state root that holds them, one subdirectory per subject. */
export const RUNS_DIR = "runs";

/** Everything the run recorder is allowed to know about this machine. */
export interface RunEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** `<stateRoot>/runs`. */
export function runsRoot(env: RunEnv): string {
  return join(stateRoot(env.home, env.env), RUNS_DIR);
}

/**
 * `<stateRoot>/runs/<subject>`.
 *
 * One directory per subject, the same shape the backup tree and the personal
 * directory already use — which is what lets `mind erase` remove one subject's
 * records with the walker it already has, instead of needing a filter.
 */
export function runsDirFor(env: RunEnv, subject: SubjectId): string {
  return join(runsRoot(env), subject);
}

/** A turn that had started and had not finished when this was written. */
export interface RunRecord {
  readonly schema: string;
  /** The same id the ledger records for this turn. */
  readonly turnId: string;
  readonly subject: SubjectId;
  /** The chain that was going to be tried, in order. */
  readonly backends: readonly string[];
  /** Mind's own pid. The vendor children are found from it, not stored. */
  readonly pid: number;
  /**
   * Mind's own process group — **recorded and printed, never signalled.**
   *
   * See the header: this number frequently belongs to the shell, not to Mind.
   * It is here because a person looking at a stuck machine is entitled to it,
   * and because printing it beside the warning is more use than hiding it.
   */
  readonly pgid: number;
  /** Field 22 of `/proc/<pid>/stat`, or `null` where there is no `/proc`. */
  readonly pidStart: number | null;
  readonly startedAt: string;
  /**
   * The turn may run commands (write/run ≥ 2, its read-only flag off). Review of PR #24: while such a turn of a
   * subject runs, nothing answers that subject's held browser actions. Absent in records from before it.
   */
  readonly loosened?: boolean;
}

/** One process, as `/proc` describes it. */
export interface ProcStat {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Field 22: start time in clock ticks since boot. */
  readonly startTicks: number;
}

/**
 * Read one process's identity, or `null` when it is not there.
 *
 * The `comm` field is parenthesised and may itself contain a `)` — a process
 * can be named `(ಠ_ಠ)` — so the split is on the **last** `)` in the line. A
 * naive `split(" ")` reads the wrong fields for any process whose name has a
 * space in it, which is most kernel threads.
 */
export function procStat(pid: number): ProcStat | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(")");
  if (close === -1) return null;
  // After "<pid> (<comm>) " the fields are: state ppid pgrp session ...
  const fields = raw.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  // Field 22 of the whole line is index 19 here: the first three (pid, comm,
  // state) are consumed by the slice and by `fields[0]`.
  const startTicks = Number(fields[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(pgid) || !Number.isFinite(startTicks)) return null;
  return { pid, ppid, pgid, startTicks };
}

/** Is there a `/proc` this code can read at all? Asked once, answered honestly. */
export function procAvailable(): boolean {
  return procStat(process.pid) !== null;
}

/** A record written for the turn this process is about to run. */
export function describeRun(options: {
  readonly turnId: string;
  readonly subject: SubjectId;
  readonly backends: readonly string[];
  readonly at: Date;
  readonly loosened?: boolean;
}): RunRecord {
  const self = procStat(process.pid);
  return {
    schema: RUN_SCHEMA,
    turnId: options.turnId,
    subject: options.subject,
    backends: [...options.backends],
    pid: process.pid,
    pgid: self?.pgid ?? process.pid,
    pidStart: self?.startTicks ?? null,
    startedAt: options.at.toISOString(),
    ...(options.loosened === undefined ? {} : { loosened: options.loosened }),
  };
}

/** Where one record is written. */
export function runRecordPath(env: RunEnv, record: RunRecord): string {
  return join(runsDirFor(env, record.subject), `${record.turnId}.json`);
}

/**
 * Write the record, before the prompt goes anywhere.
 *
 * Before, and not after: the whole reason this exists is the turn that dies
 * mid-flight, and a record written at the end is a record that case never gets.
 */
export async function writeRunRecord(env: RunEnv, record: RunRecord): Promise<string> {
  const dir = runsDirFor(env, record.subject);
  await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
  const path = runRecordPath(env, record);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: STATE_FILE_MODE });
  return path;
}

/**
 * Take the record away, and the directories it needed, if they are now empty.
 *
 * Never throws: a turn must not fail over its own bookkeeping, and a kill
 * switch that can veto work is a worse failure than one that misses a turn.
 *
 * The two `rmdir`s are best-effort on purpose. A second turn for the same
 * subject running concurrently leaves its own record in there, `rmdir` fails
 * with ENOTEMPTY, and that is the correct outcome — the directory is still in
 * use. Removing them at all is only so that a machine that has run turns and
 * finished them looks like a machine that has not: an empty `runs/<subject>/`
 * left on disk is a trace of somebody having used Mind, which is exactly the
 * kind of thing I-4 says should not accumulate for free.
 */
export async function removeRunRecord(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
  const subjectDir = dirname(path);
  await rmdir(subjectDir).catch(() => undefined);
  await rmdir(dirname(subjectDir)).catch(() => undefined);
}

/** A record read back off disk, with the path it came from. */
export interface StoredRun {
  readonly path: string;
  readonly record: RunRecord;
}

/** A file under `runs/` that is not a record Mind wrote. */
export interface UnreadableRun {
  readonly path: string;
  readonly reason: string;
}

/** Everything under `runs/`, separated into what parsed and what did not. */
export interface RunInventory {
  readonly runs: readonly StoredRun[];
  readonly unreadable: readonly UnreadableRun[];
}

function asRecord(value: unknown): RunRecord | string {
  if (typeof value !== "object" || value === null) return "not a JSON object";
  const raw = value as Record<string, unknown>;
  if (raw["schema"] !== RUN_SCHEMA) return `schema is not ${RUN_SCHEMA}`;
  const pid = raw["pid"];
  const pgid = raw["pgid"];
  const turnId = raw["turnId"];
  const subject = raw["subject"];
  if (typeof pid !== "number" || typeof pgid !== "number") return "pid or pgid is not a number";
  if (typeof turnId !== "string" || typeof subject !== "string") return "turnId or subject is missing";
  const pidStart = raw["pidStart"];
  const backends = raw["backends"];
  return {
    schema: RUN_SCHEMA,
    turnId,
    subject: subject as SubjectId,
    backends: Array.isArray(backends) ? backends.filter((b): b is string => typeof b === "string") : [],
    pid,
    pgid,
    pidStart: typeof pidStart === "number" ? pidStart : null,
    startedAt: typeof raw["startedAt"] === "string" ? (raw["startedAt"] as string) : "",
    ...(typeof raw["loosened"] === "boolean" ? { loosened: raw["loosened"] } : {}),
  };
}

/**
 * Read every run record under the state root, for every subject.
 *
 * Every subject, because `mind stop` is the one command that must not need to
 * be told whose turn to stop: somebody reaching for it is not in a position to
 * look an identifier up.
 */
export async function readRuns(env: RunEnv): Promise<RunInventory> {
  return readRunsAt(runsRoot(env));
}

/** {@link readRuns} of a runs directory already resolved — `erase` holds the path in its plan, not an environment. */
export async function readRunsAt(root: string): Promise<RunInventory> {
  const runs: StoredRun[] = [];
  const unreadable: UnreadableRun[] = [];

  let subjects: string[];
  try {
    subjects = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { runs, unreadable };
  }

  for (const subject of subjects) {
    const dir = join(root, subject);
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch (cause) {
      unreadable.push({ path: dir, reason: String(cause) });
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const parsed = asRecord(JSON.parse(await readFile(path, "utf8")));
        if (typeof parsed === "string") unreadable.push({ path, reason: parsed });
        else runs.push({ path, record: parsed });
      } catch (cause) {
        unreadable.push({ path, reason: String(cause) });
      }
    }
  }

  runs.sort((a, b) => a.record.startedAt.localeCompare(b.record.startedAt));
  return { runs, unreadable };
}

/** What a record turned out to be about. Only `live` is ever signalled. */
export type Liveness =
  /** The pid is there and its start time matches. This really is that turn. */
  | "live"
  /** The pid is gone, or it is there and is somebody else now. Never signalled. */
  | "stale"
  /**
   * There is no `/proc`, or the record was written where there was none, so the
   * question cannot be asked. Never signalled — the manual command is printed.
   */
  | "unverifiable";

/**
 * Is this record about a process that is still the process it was about?
 *
 * The `unverifiable` arm is not a formality. Without a start time to compare,
 * "the pid exists" means only that *some* process has that number, and signalling
 * on that basis is how a kill switch kills the wrong thing — the exact failure
 * the switch exists to prevent, arriving by the tool meant to prevent it.
 */
export function livenessOf(record: RunRecord, stat: ProcStat | null = procStat(record.pid)): Liveness {
  if (record.pidStart === null) return "unverifiable";
  if (stat === null) return "stale";
  return stat.startTicks === record.pidStart ? "live" : "stale";
}

/** The seam every signal goes through, so a test can watch without a casualty. */
export interface SignalIo {
  readonly stat: (pid: number) => ProcStat | null;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly listPids: () => readonly number[];
}

/** The real one: `/proc` and `process.kill`. */
export const REAL_SIGNALS: SignalIo = {
  stat: procStat,
  kill: (pid, signal) => process.kill(pid, signal),
  listPids: () => {
    // Synchronous rather than the promise form: the answer is a snapshot, and
    // awaiting in the middle of one invites the table to change under it.
    try {
      return readdirSync("/proc")
        .filter((name) => /^\d+$/.test(name))
        .map((name) => Number(name));
    } catch {
      return [];
    }
  },
};

/** Every process whose parent is `pid`, right now. */
export function childrenOf(pid: number, io: SignalIo = REAL_SIGNALS): readonly ProcStat[] {
  const found: ProcStat[] = [];
  for (const candidate of io.listPids()) {
    if (candidate === pid) continue;
    const stat = io.stat(candidate);
    if (stat !== null && stat.ppid === pid) found.push(stat);
  }
  return found;
}

/** Every process `/proc` lists right now, by pid. One snapshot, so one consistent answer. */
function processTable(io: SignalIo): Map<number, ProcStat> {
  const table = new Map<number, ProcStat>();
  for (const pid of io.listPids()) {
    const stat = io.stat(pid);
    if (stat !== null) table.set(pid, stat);
  }
  return table;
}

/**
 * The parent `/proc` names for `stat`, if it can really be its parent.
 *
 * A pid is reused, and `ppid` is only a number: a parent that started **after**
 * its child is a different process wearing a dead parent's number, and walking
 * through it would claim a stranger's process as one of ours (or ours as a
 * stranger's). Such a hop ends the walk.
 */
function parentOf(table: ReadonlyMap<number, ProcStat>, stat: ProcStat): ProcStat | undefined {
  const parent = table.get(stat.ppid);
  return parent !== undefined && parent.startTicks <= stat.startTicks ? parent : undefined;
}

/**
 * Does `stat` descend from `ancestor`? Walks parents rather than children,
 * because that is the direction `/proc` answers in one field. The hop limit is
 * not defensive rounding: `ppid` chains are re-parented while a kill switch
 * runs, and a cycle read out of two inconsistent snapshots would otherwise spin
 * forever inside one.
 */
function descendsFrom(table: ReadonlyMap<number, ProcStat>, stat: ProcStat, ancestor: number): boolean {
  let cursor = parentOf(table, stat);
  for (let hops = 0; cursor !== undefined && hops < 128; hops += 1) {
    if (cursor.pid === ancestor) return true;
    cursor = parentOf(table, cursor);
  }
  return false;
}

/** `pid` and every process it runs under, as far as `/proc` can show it. */
function lineageOf(table: ReadonlyMap<number, ProcStat>, pid: number): Set<number> {
  const lineage = new Set<number>([pid]);
  let cursor = table.get(pid);
  for (let hops = 0; cursor !== undefined && hops < 128; hops += 1) {
    cursor = parentOf(table, cursor);
    if (cursor !== undefined) lineage.add(cursor.pid);
  }
  return lineage;
}

/** How many parents up `stat` is from `root`, for deepest-first ordering. */
function depthBelow(table: ReadonlyMap<number, ProcStat>, stat: ProcStat, root: number): number {
  let depth = 0;
  let cursor: ProcStat | undefined = stat;
  for (let hops = 0; cursor !== undefined && cursor.pid !== root && hops < 128; hops += 1) {
    depth += 1;
    cursor = parentOf(table, cursor);
  }
  return depth;
}

/**
 * Every process below `pid`'s children that leads a process group of its own.
 *
 * A group signal reaches a group and nothing else, and a vendor's tool may put
 * its shell in a new one: measured 2026-10-04 on grok 1.0.40 (D-149 e2e), every
 * shell command runs as `bash` with `setsid`, so `sleep … && printf … > file`
 * outlived `mind stop`'s signal to the vendor's group and wrote its file after
 * the stop said everything was gone. Those processes are still this turn's work —
 * found by walking parents from a turn whose start time was checked — so
 * {@link signalTree} signals them too.
 *
 * Asked before anything is signalled: once the vendor dies, its children are
 * re-parented and the line back to this turn is gone. The direct children are
 * left out; {@link childrenOf} already names them.
 */
export function detachedDescendants(pid: number, io: SignalIo = REAL_SIGNALS): readonly ProcStat[] {
  const table = processTable(io);
  return [...table.values()].filter(
    (stat) => stat.pid !== pid && stat.ppid !== pid && stat.pgid === stat.pid && descendsFrom(table, stat, pid),
  );
}

/** One process a signal was sent to, and how it was addressed. */
export interface Signalled {
  readonly pid: number;
  /** `group` only when the target leads a group of its own descendants. */
  readonly how: "group" | "process";
  readonly signal: NodeJS.Signals;
  /** Set when the signal could not be delivered. */
  readonly failed?: string;
  /**
   * Why a group signal was narrowed to this process alone, when it was.
   *
   * Reported rather than done quietly: a person who asked Mind to stop a turn
   * is entitled to know that part of it was left running because Mind could
   * not show the group was safe to signal, and what was in the group instead.
   */
  readonly narrowed?: string;
}

/** What stopping one recorded turn did, and what it could not do. */
export interface TerminationReport {
  readonly record: RunRecord;
  readonly liveness: Liveness;
  readonly signalled: readonly Signalled[];
  /** Pids still alive when the poll gave up, with the command for a human. */
  readonly survivors: readonly { readonly pid: number; readonly pgid: number }[];
  /**
   * The process doing the stopping, when it is part of the turn it stops —
   * `mind stop` run by the agent, or by a script the agent ran. Never signalled:
   * a kill switch that kills itself first stops nothing after it (D-149 review).
   */
  readonly spared?: number;
  /** Why nothing was signalled, when nothing was. */
  readonly refusal?: string;
}

/**
 * Everything in `leaderPid`'s process group that does not descend from it.
 *
 * The check the header's third measurement made necessary. Leading a group was
 * taken as proof that the group held nothing but the leader and its children,
 * and `mind … | cat` at an interactive shell is a counter-example: bash makes
 * the first process of a pipeline the group leader and puts the second in the
 * group beside it, a sibling rather than a descendant.
 *
 * A member whose `ppid` points at a process that started after it is not taken
 * as descended through that number ({@link parentOf}): it counts as a stranger,
 * which is the safe direction.
 */
export function strangersInGroup(io: SignalIo, leaderPid: number): readonly ProcStat[] {
  const table = processTable(io);
  return [...table.values()].filter(
    (stat) => stat.pgid === leaderPid && stat.pid !== leaderPid && !descendsFrom(table, stat, leaderPid),
  );
}

/**
 * Address one process as safely as it can be addressed.
 *
 * A process gets its **group** only when three things hold: it leads that group,
 * every other member of the group descends from it, and the group holds neither
 * the process doing the stopping nor anything that process runs under (`own`).
 * `detached: true` produces the first two, and an inherited group never does.
 * Anything else gets the signal addressed to itself alone, because its group may
 * hold a shell somebody is using — or, per the measurement in the header, the
 * `cat` on the other side of a pipe — or the `mind stop` that is sending it.
 *
 * Narrowing is the safe direction and it is also a *loss*: a vendor CLI's own
 * grandchildren are then out of reach of this one signal. So it is reported, and
 * {@link signalTree} addresses the rest of the tree one process at a time.
 */
function sendTo(io: SignalIo, stat: ProcStat, signal: NodeJS.Signals, own: ReadonlySet<number> = new Set()): Signalled {
  let how: "group" | "process" = "process";
  let narrowed: string | undefined;

  if (stat.pgid === stat.pid && own.has(stat.pid)) {
    narrowed =
      `pid ${stat.pid} leads process group ${stat.pgid}, and that group holds this stop ` +
      `command or a process it runs under. A group signal would end the stop before it ` +
      `finished, so the signal went to this process alone and the group's other members ` +
      `are signalled one by one.`;
  } else if (stat.pgid === stat.pid) {
    const strangers = strangersInGroup(io, stat.pid);
    if (strangers.length === 0) {
      how = "group";
    } else {
      narrowed =
        `pid ${stat.pid} leads process group ${stat.pgid}, but ${strangers.length} process(es) ` +
        `in that group do not descend from it (${strangers.map((s) => s.pid).join(", ")}) — a ` +
        `pipeline or a shell job puts a sibling there. The signal went to this process alone; ` +
        `what it started is signalled one by one, and what outlives that is named below.`;
    }
  }

  const target = how === "group" ? -stat.pid : stat.pid;
  try {
    io.kill(target, signal);
    return { pid: stat.pid, how, signal, ...(narrowed === undefined ? {} : { narrowed }) };
  } catch (cause) {
    return {
      pid: stat.pid,
      how,
      signal,
      failed: String(cause),
      ...(narrowed === undefined ? {} : { narrowed }),
    };
  }
}

/** What {@link signalTree} did, and what it set out to end. */
export interface TreeSignal {
  readonly signalled: readonly Signalled[];
  /**
   * Every process the signal was meant to end, as the snapshot found it, in the
   * order it was addressed — the start time is what lets a second signal prove it
   * is still talking to the same process ({@link signalSurvivors}).
   */
  readonly watched: readonly ProcStat[];
  /** The groups that got a group signal, by leader. */
  readonly groups: ReadonlySet<number>;
  /** The stopping process, when it was inside the tree and so left alone. */
  readonly spared?: number;
}

/**
 * Signal `root` and everything below it, so that nothing in the tree is missed
 * and nothing outside it is touched.
 *
 * One snapshot of `/proc` first: the tree is every process whose parents lead
 * back to `root`, and it has to be read before anything dies, because a dead
 * parent's children are re-parented and the line back is gone. Then, in order:
 *
 * 1. every process in the tree that leads a group of its own, deepest first —
 *    by its group when {@link sendTo} can show the group is safe;
 * 2. every other process in the tree that no group signal reached, deepest
 *    first, one by one;
 * 3. `root` itself — children before parent, which is measured rather than
 *    stylistic: killing the parent alone leaves the vendor CLI running with its
 *    parent reassigned to init (measured 2026-09-22);
 * 4. last, one by one, the processes in groups that hold `stopper` or a process
 *    it runs under — those groups are never signalled as groups. `stopper`
 *    itself is never signalled.
 *
 * `stopper` is the process doing the stopping: `mind stop` when the agent, or
 * a script the agent runs, calls it from inside the turn (D-149 review), or the
 * Mind turn itself when it ends its own vendor child on a timeout.
 */
export function signalTree(
  rootPid: number,
  signal: NodeJS.Signals,
  options: { readonly io?: SignalIo; readonly stopper?: number } = {},
): TreeSignal {
  const io = options.io ?? REAL_SIGNALS;
  const stopper = options.stopper ?? process.pid;
  const table = processTable(io);
  const root = table.get(rootPid);
  if (root === undefined) return { signalled: [], watched: [], groups: new Set() };

  // The groups holding the stopper or a process it runs under. Not signalled as groups, ever.
  const own = new Set<number>();
  for (const pid of lineageOf(table, stopper)) {
    const stat = table.get(pid);
    if (stat !== undefined) own.add(stat.pgid);
  }

  const below = [...table.values()]
    .filter((stat) => stat.pid !== rootPid && descendsFrom(table, stat, rootPid))
    .sort((a, b) => depthBelow(table, b, rootPid) - depthBelow(table, a, rootPid));

  const signalled: Signalled[] = [];
  const groups = new Set<number>();
  const watched: ProcStat[] = [];
  const done = new Set<number>();
  const send = (stat: ProcStat, alone: boolean): void => {
    if (stat.pid === stopper || done.has(stat.pid)) return;
    done.add(stat.pid);
    watched.push(stat);
    if (alone) {
      try {
        io.kill(stat.pid, signal);
        signalled.push({ pid: stat.pid, how: "process", signal });
      } catch (cause) {
        signalled.push({ pid: stat.pid, how: "process", signal, failed: String(cause) });
      }
      return;
    }
    const sent = sendTo(io, stat, signal, own);
    signalled.push(sent);
    if (sent.how === "group" && sent.failed === undefined) groups.add(stat.pid);
  };

  // 1. Group leaders below the root, deepest first.
  for (const stat of below) if (stat.pgid === stat.pid && !own.has(stat.pgid)) send(stat, false);
  // 2. Everything below that no group signal reached.
  for (const stat of below) {
    if (own.has(stat.pgid) || done.has(stat.pid)) continue;
    if (groups.has(stat.pgid)) {
      done.add(stat.pid);
      watched.push(stat);
      continue;
    }
    send(stat, true);
  }
  // 3. The root.
  if (!own.has(root.pgid)) send(root, false);
  // 4. Last, one by one: what shares a group with the stopper or its parents.
  for (const stat of [...below, root]) if (own.has(stat.pgid)) send(stat, true);

  const stopping = table.get(stopper);
  const inside = stopping !== undefined && (stopper === rootPid || descendsFrom(table, stopping, rootPid));
  return { signalled, watched, groups, ...(inside ? { spared: stopper } : {}) };
}

/**
 * D-044, for every process a tree signal meant to end: what is still the same
 * process (same start time) gets `signal` — a leader that was reached as a group
 * by its group again, under the same safety rule, and everything else one by
 * one. A pid that was reused in between has a different start time and is left
 * alone. Returns what was sent, and what was still alive to send it to.
 */
export function signalSurvivors(
  tree: TreeSignal,
  signal: NodeJS.Signals,
  options: { readonly io?: SignalIo; readonly stopper?: number } = {},
): { readonly signalled: readonly Signalled[]; readonly alive: readonly ProcStat[] } {
  const io = options.io ?? REAL_SIGNALS;
  const table = processTable(io);
  const own = new Set<number>();
  for (const pid of lineageOf(table, options.stopper ?? process.pid)) {
    const stat = table.get(pid);
    if (stat !== undefined) own.add(stat.pgid);
  }
  const alive = tree.watched.filter((stat) => isSameProcess(io, stat));
  const signalled: Signalled[] = [];
  const reached = new Set<number>();
  for (const stat of alive) {
    if (tree.groups.has(stat.pid)) {
      const sent = sendTo(io, stat, signal, own);
      signalled.push(sent);
      if (sent.how === "group" && sent.failed === undefined) reached.add(stat.pid);
    }
  }
  for (const stat of alive) {
    if (tree.groups.has(stat.pid) || reached.has(io.stat(stat.pid)?.pgid ?? stat.pgid)) continue;
    try {
      io.kill(stat.pid, signal);
      signalled.push({ pid: stat.pid, how: "process", signal });
    } catch (cause) {
      signalled.push({ pid: stat.pid, how: "process", signal, failed: String(cause) });
    }
  }
  return { signalled, alive };
}

/** Is the process `stat` describes still running under that number? */
function isSameProcess(io: SignalIo, stat: ProcStat): boolean {
  const now = io.stat(stat.pid);
  return now !== null && now.startTicks === stat.startTicks;
}

/**
 * Stop one recorded turn: everything below Mind first — what the vendor
 * started in groups of its own, then the vendor — then Mind itself
 * ({@link signalTree}), and SIGKILL for whatever outlives SIGTERM (D-044).
 *
 * @param settle Called between polls. Injected so a test can drive it without
 *   sleeping, and so nothing here asserts anything about how fast a machine is.
 * @param stopper The process doing the stopping, never signalled (default: this one).
 */
export async function terminateRun(
  stored: StoredRun,
  options: {
    readonly io?: SignalIo;
    readonly attempts?: number;
    readonly settle: () => Promise<void>;
    readonly stopper?: number;
  },
): Promise<TerminationReport> {
  const io = options.io ?? REAL_SIGNALS;
  const attempts = options.attempts ?? 40;
  const record = stored.record;
  const self = io.stat(record.pid);
  const liveness = livenessOf(record, self);

  if (liveness !== "live" || self === null) {
    return {
      record,
      liveness,
      signalled: [],
      survivors: [],
      refusal:
        liveness === "stale"
          ? "the process this record names is gone, or the number now belongs to something " +
            "else. Nothing was signalled: a pid is reused, and a kill switch that guesses is " +
            "the thing it was built to prevent."
          : "this record carries no process start time, so Mind cannot show that the pid " +
            "still means what it meant. Nothing was signalled. The command to run by hand is " +
            "printed above.",
    };
  }

  const scope = { io, ...(options.stopper === undefined ? {} : { stopper: options.stopper }) };
  const tree = signalTree(record.pid, "SIGTERM", scope);
  const signalled: Signalled[] = [...tree.signalled];

  // Every process the tree held, with the start time the snapshot read — not
  // only the ones a signal was addressed to. A member that ignores SIGTERM while
  // its group's leader dies on it is exactly what a watch over leaders missed.
  const wait = async (among: readonly ProcStat[]): Promise<readonly ProcStat[]> => {
    let alive = among;
    for (let attempt = 0; attempt < attempts && alive.length > 0; attempt += 1) {
      await options.settle();
      alive = alive.filter((stat) => isSameProcess(io, stat));
    }
    return alive;
  };

  let alive = await wait(tree.watched);

  // D-044 — SIGTERM was not enough. The owner decided a kill switch that a
  // hung or deliberately stubborn vendor can outlast is not a kill switch, so
  // what is still the same process gets SIGKILL, addressed by the same rules.
  if (alive.length > 0) {
    const killed = signalSurvivors({ ...tree, watched: alive }, "SIGKILL", scope);
    signalled.push(...killed.signalled);
    alive = await wait(killed.alive);
  }

  return {
    record,
    liveness,
    signalled,
    survivors: alive.map((stat) => ({ pid: stat.pid, pgid: io.stat(stat.pid)?.pgid ?? stat.pgid })),
    ...(tree.spared === undefined ? {} : { spared: tree.spared }),
  };
}

/**
 * The command a person runs for what Mind would not.
 *
 * A string rather than something Mind executes, and that is the point: the
 * cases that reach here are the ones where Mind could not show that the target
 * is what the record says it is. Handing the decision to somebody who can look
 * is better than a program acting on a number it does not trust.
 */
export function manualCommand(pgid: number, signal: "TERM" | "KILL" = "TERM"): string {
  return `kill -${signal} -${pgid}`;
}

/** Where the turns that could run commands leave a note when they end (review of PR #24, round 3). */
export const ENDED_DIR = "ended";
/** How long such a note is kept: long past any approval's wait (an hour at most). */
export const ENDED_KEEP_MS = 24 * 60 * 60 * 1000;

/** A loosened turn that has ended: when it ran. */
export interface EndedTurn {
  readonly turnId: string;
  readonly subject: string;
  readonly startedAt: string;
  readonly endedAt: string;
}

/**
 * Note that a loosened turn ended, and when it started — so an approval claim written while it ran can be
 * told from one written after (`taintedAt`, src/task/answer.ts), even when nobody looked while it ran. Older
 * notes are swept on the way. Best effort: a turn must not fail over its own bookkeeping.
 */
export async function noteEnded(env: RunEnv, record: RunRecord, at: Date): Promise<void> {
  const dir = join(runsDirFor(env, record.subject), ENDED_DIR);
  try {
    await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
    const ended: EndedTurn = { turnId: record.turnId, subject: record.subject, startedAt: record.startedAt, endedAt: at.toISOString() };
    await writeFile(join(dir, `${record.turnId}.json`), `${JSON.stringify(ended)}\n`, { mode: STATE_FILE_MODE });
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as Partial<EndedTurn>;
        if (at.getTime() - Date.parse(String(raw.endedAt)) > ENDED_KEEP_MS) await rm(path, { force: true });
      } catch {
        await rm(path, { force: true });
      }
    }
  } catch {
    // Not noted: an answer claimed during it is then judged by what still runs, as before.
  }
}

/** Every ended loosened turn noted under the runs root, any subject. */
export async function readEnded(env: RunEnv): Promise<readonly EndedTurn[]> {
  const out: EndedTurn[] = [];
  let subjects: string[];
  try {
    subjects = await readdir(runsRoot(env));
  } catch {
    return out;
  }
  for (const subject of subjects) {
    const dir = join(runsRoot(env), subject, ENDED_DIR);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const raw = JSON.parse(await readFile(join(dir, name), "utf8")) as Partial<EndedTurn>;
        if (typeof raw.startedAt === "string" && typeof raw.endedAt === "string") out.push({ turnId: String(raw.turnId), subject: String(raw.subject), startedAt: raw.startedAt, endedAt: raw.endedAt });
      } catch {
        // Not a note.
      }
    }
  }
  return out;
}
