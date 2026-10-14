/**
 * S5.3 — work that starts on a schedule rather than on a person (D-054).
 *
 * A trigger is a prompt and an interval, written in `triggers.md` beside
 * `autonomy.md`: in git, with the identity, so what an agent does by itself on
 * a timer is part of who it is and every addition is a line in `git diff`.
 *
 * Three things are deliberately not here:
 *
 * - **A daemon.** `mind triggers tick` runs what is due and exits; the OS
 *   decides when to call it (a systemd timer, cron). The non-goals say Mind
 *   does not re-implement a scheduler, and a tick that has exited cannot hang.
 * - **A level.** A triggered turn is held at 1 — it proposes, it does not act —
 *   whatever the dial says (S5.2 AC1: anything not directly asked for comes out
 *   as a proposal). The caller does that with the existing ceiling, which can
 *   only lower a level.
 * - **Catch-up.** One timestamp per trigger. A machine that was off for a week
 *   fires a daily trigger once when it comes back, not seven times.
 */

import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "../soul/frontmatter.ts";
import type { SoulIssue, Validated } from "../soul/schema.ts";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";

/** Beside `autonomy.md`. */
export const TRIGGERS_FILE = "triggers.md";

/** Schema tag `triggers.md` is written with. */
export const TRIGGERS_SCHEMA = "mind/triggers@1";

/** Where fire times live under the state root. */
export const TRIGGERS_DIR = "triggers";

/** A turn every few seconds is a loop, not a schedule. */
export const MIN_EVERY_MS = 5 * 60_000;

/** Beyond this, "every" is a reminder somebody should be writing down elsewhere. */
export const MAX_EVERY_MS = 90 * 24 * 60 * 60_000;

const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };

/** Ids are file-safe and read the same in a shell and in a systemd unit. */
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface Trigger {
  readonly id: string;
  /** As written, e.g. `6h`. */
  readonly every: string;
  readonly everyMs: number;
  readonly prompt: string;
}

/** `30m`, `6h`, `1d` → milliseconds, or `undefined` for anything else. */
export function parseEvery(text: string): number | undefined {
  const match = /^([1-9][0-9]{0,4})([mhd])$/.exec(text);
  if (match === null) return undefined;
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

/**
 * Read `triggers.md`. Every problem is reported with its line, and one bad
 * trigger refuses the file: a schedule that runs "the ones that parsed" is a
 * schedule nobody wrote.
 */
export function parseTriggers(file: string, text: string): Validated<readonly Trigger[]> {
  const parsed = parseFrontmatter(file, text);
  if (!parsed.ok) return parsed;
  const { table, lines } = parsed.value.doc;
  const lineOf = (key: string): number => lines.get(key) ?? parsed.value.openLine;
  const issues: SoulIssue[] = [];

  if (table["schema"] !== TRIGGERS_SCHEMA) {
    issues.push({
      file,
      line: lineOf("schema"),
      path: "schema",
      message: `schema must be ${JSON.stringify(TRIGGERS_SCHEMA)}, not ${JSON.stringify(table["schema"])}`,
    });
  }

  const triggers: Trigger[] = [];
  for (const [id, value] of Object.entries(table)) {
    if (id === "schema") continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ file, line: lineOf(id), path: id, message: `${id} is not a trigger: write it as a [${id}] table` });
      continue;
    }
    if (!ID.test(id)) {
      issues.push({
        file,
        line: lineOf(id),
        path: id,
        message: `trigger ids are lower-case letters, digits and "-", starting with a letter or digit — ${JSON.stringify(id)} is not`,
      });
      continue;
    }
    const entry = value as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== "every" && key !== "prompt") {
        issues.push({
          file,
          line: lineOf(`${id}.${key}`),
          path: `${id}.${key}`,
          message: `${key} is not a trigger field. A trigger has "every" and "prompt"; its level is always 1 (D-054).`,
        });
      }
    }
    const every = entry["every"];
    const everyMs = typeof every === "string" ? parseEvery(every) : undefined;
    if (everyMs === undefined) {
      issues.push({
        file,
        line: lineOf(`${id}.every`),
        path: `${id}.every`,
        message: `every is a number and a unit — "30m", "6h", "1d". Got ${JSON.stringify(every)}.`,
      });
    } else if (everyMs < MIN_EVERY_MS || everyMs > MAX_EVERY_MS) {
      issues.push({
        file,
        line: lineOf(`${id}.every`),
        path: `${id}.every`,
        message: `every must be between 5m and 90d. ${JSON.stringify(every)} is outside that.`,
      });
    }
    const prompt = entry["prompt"];
    if (typeof prompt !== "string" || prompt.trim() === "") {
      issues.push({ file, line: lineOf(`${id}.prompt`), path: `${id}.prompt`, message: "prompt is missing or empty" });
    }
    if (everyMs !== undefined && typeof every === "string" && typeof prompt === "string" && prompt.trim() !== "") {
      triggers.push({ id, every, everyMs, prompt });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: triggers };
}

/** What `triggers.md` would look like with one example in it. */
export function exampleTriggers(): string {
  return (
    `+++\nschema = "${TRIGGERS_SCHEMA}"\n\n` +
    `[morning-review]\nevery = "1d"\nprompt = "Look at what changed since yesterday and propose what to do next."\n+++\n\n` +
    `Every trigger runs as a turn held at level 1: it proposes, and nothing it proposes happens until ` +
    `somebody approves it (D-054).\n`
  );
}

/** When each trigger last fired, by id. ISO strings. */
export type FiredTimes = Readonly<Record<string, string>>;

/** This subject's fire times. `erase` removes the directory whole (S5.3 AC6). */
export function triggersDirFor(
  env: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
  subject: SubjectId,
): string {
  return join(stateRoot(env.home, env.env), TRIGGERS_DIR, subject);
}

/**
 * The record for one agent directory. Keyed by its absolute path, like the
 * level-3 confirmations: a clone elsewhere has not fired anything yet.
 */
export function firedPath(dir: string, triggersDir: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(resolve(dir));
  return join(triggersDir, `${hasher.digest("hex").slice(0, 32)}.json`);
}

/** Missing or unreadable is "never fired" — which fires each trigger once, not in a loop. */
export async function readFired(path: string): Promise<FiredTimes> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [id, at] of Object.entries(raw)) {
      if (typeof at === "string" && !Number.isNaN(Date.parse(at))) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Record that one trigger fired, or — with `null` — put back that it never
 * did (a turn the brake refused has not fired). Atomic; it keeps the others.
 */
export async function markFired(path: string, id: string, at: Date | string | null): Promise<void> {
  const current: Record<string, string> = { ...(await readFired(path)) };
  if (at === null) delete current[id];
  else current[id] = typeof at === "string" ? at : at.toISOString();
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}`;
  await writeFile(temp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** When a trigger is next due. Never fired is due now. */
export function nextDue(trigger: Trigger, fired: FiredTimes, now: Date): Date {
  const last = fired[trigger.id];
  if (last === undefined) return now;
  return new Date(Date.parse(last) + trigger.everyMs);
}

/** The triggers due at `now`, in file order. */
export function dueTriggers(triggers: readonly Trigger[], fired: FiredTimes, now: Date): readonly Trigger[] {
  return triggers.filter((trigger) => nextDue(trigger, fired, now).getTime() <= now.getTime());
}

/**
 * The ceiling a triggered turn runs under: 1, or lower if one is already set.
 *
 * Compared as text for the reason `effectiveDial` gives: an unrecognised value
 * already means 0 there, so it is passed through untouched rather than
 * "corrected" upward to 1.
 */
export function triggeredCeiling(current: string | undefined): string {
  if (current === "0" || current === "1") return current;
  if (current === undefined || current === "2" || current === "3") return "1";
  return current;
}

/** An exclusive lock on this record, or the reason there is none. */
export type Lock = { readonly ok: true; readonly release: () => Promise<void> } | { readonly ok: false; readonly reason: string };

/**
 * One tick at a time per agent directory (AC5). The lock names its pid; one
 * whose process is gone is taken over rather than waited on forever.
 */
export async function lockFired(path: string, pidAlive: (pid: number) => boolean = alive): Promise<Lock> {
  const lockPath = `${path}.lock`;
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return { ok: true, release: () => rm(lockPath, { force: true }) };
    } catch {
      const holder = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
        return { ok: false, reason: `another tick (pid ${holder}) is running for this agent` };
      }
      await rm(lockPath, { force: true });
    }
  }
  return { ok: false, reason: `the lock ${lockPath} could not be taken` };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
