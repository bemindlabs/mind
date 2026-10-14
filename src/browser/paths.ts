/**
 * Where a browser task's files are — pure `join`s, nothing read or started.
 *
 * Separate from `store.ts` on purpose: the data map (`src/erase/map.ts`) names
 * these places, and `src/deploy/` reads the map with the promise that its
 * closure starts no process and opens no socket. The parts that ask docker live
 * in `store.ts` and `runtime.ts`.
 *
 * Everything of a task that names its subject is under that subject: the
 * record and the vendors' config files at `<state root>/browser/<subject>/`,
 * the recording at `<data root>/<subject>/personal/browser/<task>/`. So `erase`
 * reaches all of it by removing two subject trees (I-4).
 */

import { join } from "node:path";
import { personalPath } from "../guard/personal.ts";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";

export interface BrowserEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function browserRoot(env: BrowserEnv): string {
  return join(stateRoot(env.home, env.env), "browser");
}

/** One subject's records and wiring — a tree `erase` removes whole. */
export function browserDirFor(env: BrowserEnv, subject: SubjectId): string {
  return join(browserRoot(env), subject);
}

export function recordPath(env: BrowserEnv, subject: SubjectId, task: string): string {
  return join(browserDirFor(env, subject), `${task}.json`);
}

/** Where the vendors' MCP config files for a task are written (`src/browser/mcp-config.ts`). */
export function wiringDir(env: BrowserEnv, subject: SubjectId, task: string): string {
  return join(browserDirFor(env, subject), "wiring", task);
}

/** Where a task's recording goes: under the subject's personal directory, so `erase` reaches it. */
export function browserOutDir(env: BrowserEnv, subject: SubjectId, task: string): string {
  return join(personalPath(env, subject), "browser", task);
}
