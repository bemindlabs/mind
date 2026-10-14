/**
 * Where a subject's push subscriptions live (S14.3, D-130) — apart from `push.ts` on purpose: `erase` removes
 * this directory, and nothing reachable from `src/erase/` may name a network global (`test/erase/no-network`),
 * which the sending half of push does.
 */

import { join } from "node:path";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";

export const PUSH_DIR = "push";

/** This subject's subscriptions. `erase` removes the directory whole. */
export function pushDirFor(
  env: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
  subject: SubjectId,
): string {
  return join(stateRoot(env.home, env.env), PUSH_DIR, subject);
}
