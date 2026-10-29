/**
 * S22.2 (D-197) — which backends are resting, and until when.
 *
 * A cooldown has to outlive the process: `mind turn` is a new process every time, and a fleet is many of
 * them. So it lives in a file under the state root (`src/state.ts`), next to the ledger and for the same
 * reason — nothing in git can rebuild it, and it is the machine's, not any subject's (I-3: it holds backend
 * ids, times and one of a few fixed phrases, never a prompt, an answer or a key).
 *
 * Two processes can write at once. The write is read-modify-write with an atomic rename, so a file is never
 * half-written, but the later writer wins and may drop the other's entry. The price is one more failed turn
 * on a backend that was already resting; it does not justify a lock here.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR_MODE, STATE_FILE_MODE, stateRoot } from "../state.ts";
import type { LimitKind, LimitSignal } from "./limit.ts";

/** Back-off when the vendor gave no reset time: shortest first, then it stays at the last step. */
export const BACKOFF_MS: readonly number[] = [15 * 60_000, 60 * 60_000, 5 * 60 * 60_000];
/** A login problem does not heal by waiting; this is how often one turn may find out it still has not. */
export const AUTH_REPROBE_MS = 30 * 60_000;
/** A strike older than this, counted from when its hold ended, is forgotten. */
const FORGET_MS = 24 * 60 * 60_000;

export interface Hold {
  readonly kind: Exclude<LimitKind, "transient">;
  /** Epoch milliseconds. */
  readonly until: number;
  readonly reason: string;
}

interface Entry extends Hold {
  readonly strikes: number;
}

export interface Health {
  /** The hold on this backend, or undefined when it is free to try. */
  coolingUntil(id: string, now: number): Hold | undefined;
  /** Note what a miss said. `transient` signals are ignored: a busy moment is not a rest. */
  record(id: string, signal: LimitSignal, now: number): void;
}

/** The hold a signal earns, given what was already recorded. Pure. */
export function holdFor(previous: Entry | undefined, signal: LimitSignal, now: number): Entry | undefined {
  if (signal.kind === "transient") return undefined;
  const strikes =
    previous !== undefined && now - previous.until < FORGET_MS ? previous.strikes + 1 : 1;
  if (signal.kind === "auth") {
    return { kind: "auth", until: now + AUTH_REPROBE_MS, reason: signal.reason, strikes };
  }
  const step = BACKOFF_MS[Math.min(strikes - 1, BACKOFF_MS.length - 1)] as number;
  return { kind: "exhausted", until: signal.until ?? now + step, reason: signal.reason, strikes };
}

function active(entry: Entry | undefined, now: number): Hold | undefined {
  if (entry === undefined || entry.until <= now) return undefined;
  return { kind: entry.kind, until: entry.until, reason: entry.reason };
}

/**
 * S22.9 (D-197) — what the owner may do by hand, from the fleet page: rest a backend for a while, or call it back.
 *
 * Separate from {@link Health} so a caller that only reads and records (the fallback chain) cannot rest or wake
 * anything. A manual rest is an `exhausted` hold with the fixed phrase {@link MANUAL_REASON}, so the trail and the page
 * say it was by hand; waking removes the entry whole, strikes included, so the next real signal starts at the first step.
 */
export interface HealthControl extends Health {
  /** Rest `id` until `until` (epoch ms). A longer rest already in force is not shortened. */
  rest(id: string, until: number, now: number): void;
  /** Call `id` back at once and forget its strikes. Returns whether there was anything to clear. */
  wake(id: string): boolean;
  /** Every backend that is resting at `now`: the page's table. */
  resting(now: number): ReadonlyMap<string, Hold>;
}

/** The one phrase a rest by hand carries. */
export const MANUAL_REASON = "rested by hand";
/** The longest a rest by hand may last: a person who wants longer asks again, and sees it. */
export const MAX_MANUAL_REST_MS = 24 * 60 * 60_000;

function manualEntry(previous: Entry | undefined, until: number, now: number): Entry | undefined {
  if (until <= now || until > now + MAX_MANUAL_REST_MS) return undefined;
  if (previous !== undefined && previous.until >= until) return previous;
  return { kind: "exhausted", until, reason: MANUAL_REASON, strikes: previous?.strikes ?? 0 };
}

/** In memory only — for a caller that wants no file, and for tests. */
export function memoryHealth(): HealthControl {
  const entries = new Map<string, Entry>();
  return {
    rest(id, until, now) {
      const next = manualEntry(entries.get(id), until, now);
      if (next !== undefined) entries.set(id, next);
    },
    wake: (id) => entries.delete(id),
    resting(now) {
      const held = new Map<string, Hold>();
      for (const [id, entry] of entries) {
        const hold = active(entry, now);
        if (hold !== undefined) held.set(id, hold);
      }
      return held;
    },
    coolingUntil: (id, now) => active(entries.get(id), now),
    record(id, signal, now) {
      const next = holdFor(entries.get(id), signal, now);
      if (next !== undefined) entries.set(id, next);
    },
  };
}

/** `<state root>/health.json`. */
export function healthPath(home: string, env: Readonly<Record<string, string | undefined>>): string {
  return join(stateRoot(home, env), "health.json");
}

type Book = Record<string, Entry>;

function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    (e["kind"] === "exhausted" || e["kind"] === "auth") &&
    typeof e["until"] === "number" &&
    typeof e["reason"] === "string" &&
    typeof e["strikes"] === "number"
  );
}

/** Missing, unreadable or not what this file writes: an empty book, never an error. A rest is a hint. */
function readBook(path: string): Book {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const backends = (parsed as { backends?: unknown }).backends;
    if (typeof backends !== "object" || backends === null) return {};
    const book: Book = {};
    for (const [id, entry] of Object.entries(backends)) if (isEntry(entry)) book[id] = entry;
    return book;
  } catch {
    return {};
  }
}

/** A file under the state root, 0600 in a 0700 directory. A write that fails is silent: the turn goes on. */
export function fileHealth(path: string): HealthControl {
  const write = (book: Book, now: number): void => {
    for (const [other, entry] of Object.entries(book)) {
      if (now - entry.until >= FORGET_MS) delete book[other];
    }
    try {
      mkdirSync(dirname(path), { recursive: true, mode: STATE_DIR_MODE });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ v: 1, backends: book }, null, 2)}\n`, { mode: STATE_FILE_MODE });
      renameSync(temporary, path);
    } catch {
      // The hold is a hint. Failing to keep it costs a retry, not a turn.
    }
  };
  return {
    coolingUntil: (id, now) => active(readBook(path)[id], now),
    record(id, signal, now) {
      const book = readBook(path);
      const next = holdFor(book[id], signal, now);
      if (next === undefined) return;
      book[id] = next;
      write(book, now);
    },
    rest(id, until, now) {
      const book = readBook(path);
      const next = manualEntry(book[id], until, now);
      if (next === undefined) return;
      book[id] = next;
      write(book, now);
    },
    wake(id) {
      const book = readBook(path);
      if (book[id] === undefined) return false;
      delete book[id];
      write(book, Date.now());
      return true;
    },
    resting(now) {
      const held = new Map<string, Hold>();
      for (const [id, entry] of Object.entries(readBook(path))) {
        const hold = active(entry, now);
        if (hold !== undefined) held.set(id, hold);
      }
      return held;
    },
  };
}
