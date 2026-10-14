/**
 * The runner's own memory of every loosened turn it has seen (review of PR #24, round 4).
 *
 * `taintedAt` (answer.ts) reads what is on disk now, and a turn that can run commands can change that: write
 * an approval claim, then delete its run record — or flip its `loosened` — and SIGKILL itself before
 * `noteEnded` runs. So the runner polls the run records itself (at most every {@link TAINT_POLL_MS}) and keeps,
 * for as long as it lives, every loosened turn it saw:
 *
 * - still recorded as loosened: tainted from its start;
 * - gone, or no longer loosened, **without** an end note for that very turn: tainted from its start, for the
 *   rest of this runner's life — nothing it says about when it ended can be believed;
 * - gone with its end note: tainted from its start until this runner saw its process dead, plus the grace —
 *   the note cannot shorten that, since a turn could write one and keep running.
 *
 * What it cannot see is a turn that starts and is gone between two polls; that is the same-uid limit (Q4).
 */

import { procStat, readEnded, readRuns, type EndedTurn, type RunEnv, type StoredRun } from "../decide/runs.ts";
import { TAINT_GRACE_MS, taintedAt } from "./answer.ts";
import { alive } from "./store.ts";

/** How often the runner reads the run records. */
export const TAINT_POLL_MS = 400;

type Stat = (pid: number) => { readonly startTicks: number } | null;

interface Seen {
  readonly turnId: string;
  readonly subject: string;
  readonly startedAt: number;
  readonly pid: number;
  readonly pidStart: number | null;
  /** When this runner first saw its record gone or no longer loosened. */
  goneAt?: number;
  /** Gone with an end note written for this turn. */
  noted?: boolean;
  /** When this runner first saw its process dead, after it was gone. */
  deadAt?: number;
}

export interface TaintWatchIo {
  readonly runs: () => Promise<readonly StoredRun[]>;
  readonly ended: () => Promise<readonly EndedTurn[]>;
  readonly stat: Stat;
}

export class TaintWatch {
  private readonly seen = new Map<string, Seen>();
  private readonly io: TaintWatchIo;

  constructor(env: RunEnv, io: Partial<TaintWatchIo> = {}) {
    this.io = {
      runs: io.runs ?? (async () => (await readRuns(env)).runs),
      ended: io.ended ?? (() => readEnded(env)),
      stat: io.stat ?? procStat,
    };
  }

  /** Read the run records once and update what is remembered. */
  async poll(now: number): Promise<void> {
    const loosened = new Set<string>();
    for (const { record } of await this.io.runs()) {
      if (record.loosened !== true) continue;
      const key = `${record.subject}/${record.turnId}`;
      loosened.add(key);
      if (!this.seen.has(key)) {
        this.seen.set(key, { turnId: record.turnId, subject: record.subject, startedAt: Date.parse(record.startedAt), pid: record.pid, pidStart: record.pidStart ?? null });
      }
    }
    let notes: readonly EndedTurn[] | undefined;
    for (const [key, turn] of this.seen) {
      if (turn.goneAt === undefined && !loosened.has(key)) {
        turn.goneAt = now;
        notes ??= await this.io.ended();
        turn.noted = notes.some((note) => note.turnId === turn.turnId && note.subject === turn.subject && Date.parse(note.startedAt) === turn.startedAt);
      }
      if (turn.goneAt !== undefined && turn.deadAt === undefined && !alive({ pid: turn.pid, start: turn.pidStart }, this.io.stat)) turn.deadAt = now;
    }
  }

  /** Was a claim made at `at` (ms) made while a turn this runner saw could have made it? */
  tainted(at: number): string | undefined {
    for (const turn of this.seen.values()) {
      if (Number.isNaN(turn.startedAt) || at < turn.startedAt) continue;
      const name = `${turn.turnId} (agent ${turn.subject}`;
      if (turn.goneAt === undefined) return `${name}, running)`;
      if (turn.noted !== true) return `${name}, its run record went away or changed without an end note)`;
      if (turn.deadAt === undefined || at <= turn.deadAt + TAINT_GRACE_MS) return `${name}, ended)`;
    }
    return undefined;
  }

  /** Poll every {@link TAINT_POLL_MS} until `stop` is called; the first poll is done before this returns. */
  async start(clock: () => number = Date.now): Promise<() => void> {
    await this.poll(clock());
    const timer = setInterval(() => {
      this.poll(clock()).catch(() => undefined);
    }, TAINT_POLL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

/**
 * What a task's runner asks of a claim before it signs it (`writeReleases`' `tainted`): its own memory of every
 * loosened turn it saw — polled now as well as every {@link TAINT_POLL_MS} — and, after it, what is on disk
 * ({@link taintedAt}). `stop` ends the polling.
 */
export async function runnerTaint(
  env: RunEnv,
  watching: boolean,
  watch: TaintWatch = new TaintWatch(env),
): Promise<{ readonly tainted: (at: number) => Promise<string | undefined>; readonly stop: () => void }> {
  const stop = watching ? await watch.start() : () => undefined;
  return {
    tainted: async (at: number) => {
      await watch.poll(Date.now());
      return watch.tainted(at) ?? (await taintedAt(env, at));
    },
    stop,
  };
}
