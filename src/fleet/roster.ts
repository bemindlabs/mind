/**
 * S22.5 (D-197) — the roster of a flat fleet: who the bots are and which backend each one calls home.
 *
 * `fleet.toml` says, per bot, a name, the subject it works as, its home backend and the backends it may borrow, in
 * order, when its own is resting (S22.2). It says nothing about who is in charge, because nobody is: a field that
 * names a lead, a role or a manager is refused rather than ignored, so a roster cannot quietly grow a hierarchy.
 *
 * Four rules are checked at load, all of them reported together so one edit fixes one pass:
 *
 * - **One model, one bot.** A backend is the home of at most one bot. Two bots on one home would be two names for one
 *   queue of quota.
 * - **One subject, one bot (I-3).** Two bots on one subject would share a ledger and a memory; identities never bleed.
 * - **Cloud only (S22.4).** Every backend named, home or spare, is on the allowlist. A local model is not refused by a
 *   chain order but by the file failing to load.
 * - **Nothing unknown.** A key this file does not read is a typo or a request it cannot honour; either way the owner
 *   should hear it before a fleet starts, not after.
 *
 * `scope` (S22.8) is read and kept here and **not enforced here**: this file only says what a bot asked for.
 *
 * Pure: it takes the text and returns a verdict. Reading the file and printing are the caller's.
 */

import { isSubjectId } from "../types.ts";
import { CLOUD_BACKENDS, isCloudBackend } from "../exec/cloud-only.ts";

export type Scope = "machine" | "worktree";

export interface Bot {
  readonly id: string;
  readonly subject: string;
  /** The backend this bot calls home. */
  readonly home: string;
  /** Backends it may borrow, in the order to try them. */
  readonly spares: readonly string[];
  readonly scope: Scope;
  /** The bot's agent directory (an absolute path), when the roster names it: what the fleet page needs to stop its tasks. */
  readonly dir?: string;
}

export type Roster =
  | { readonly ok: true; readonly bots: readonly Bot[] }
  | { readonly ok: false; readonly problems: readonly string[] };

export const MAX_BOTS = 64;
const BOT_ID = /^[a-z][a-z0-9-]{0,31}$/;
const TOP_KEYS = new Set(["bot"]);
const BOT_KEYS = new Set(["id", "subject", "backend", "fallback", "scope", "dir"]);
/** Keys that would make the fleet not flat. Named so the refusal says why, rather than "unknown". */
const HIERARCHY_KEYS = new Set(["lead", "role", "manager", "reports_to", "parent", "boss", "supervisor"]);

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a roster from the text of a `fleet.toml`. */
export function parseRoster(text: string): Roster {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (error) {
    // The parser's message carries a line number and a position, never the value of a key.
    return { ok: false, problems: [`fleet.toml is not valid TOML: ${error instanceof Error ? error.message.split("\n")[0] : "unreadable"}`] };
  }
  const problems: string[] = [];
  if (!isTable(doc)) return { ok: false, problems: ["fleet.toml is not a table"] };
  for (const key of Object.keys(doc)) if (!TOP_KEYS.has(key)) problems.push(`unknown top-level key "${key}" (only [[bot]] is read)`);

  const rawBots = doc["bot"];
  if (!Array.isArray(rawBots) || rawBots.length === 0) {
    problems.push("no [[bot]] entries: a fleet needs at least one bot");
    return { ok: false, problems };
  }
  if (rawBots.length > MAX_BOTS) problems.push(`${rawBots.length} bots; at most ${MAX_BOTS}`);

  const bots: Bot[] = [];
  const ids = new Map<string, number>();
  const subjects = new Map<string, string>();
  const homes = new Map<string, string>();

  rawBots.forEach((raw, index) => {
    const label = isTable(raw) && typeof raw["id"] === "string" ? `bot "${raw["id"]}"` : `bot #${index + 1}`;
    if (!isTable(raw)) {
      problems.push(`${label} is not a table`);
      return;
    }
    for (const key of Object.keys(raw)) {
      if (HIERARCHY_KEYS.has(key)) problems.push(`${label}: "${key}" — the fleet is flat; no bot leads another`);
      else if (!BOT_KEYS.has(key)) problems.push(`${label}: unknown key "${key}"`);
    }

    const id = raw["id"];
    if (typeof id !== "string" || !BOT_ID.test(id)) problems.push(`${label}: id must match ${BOT_ID}`);
    else if (ids.has(id)) problems.push(`${label}: id repeats bot #${ids.get(id)}`);
    else ids.set(id, index + 1);

    const subject = raw["subject"];
    if (!isSubjectId(subject)) problems.push(`${label}: subject must be a subject id (lowercase, dash or underscore)`);
    else if (subjects.has(subject)) problems.push(`${label}: subject "${subject}" is already ${subjects.get(subject)}'s (I-3: one subject, one bot)`);
    else subjects.set(subject, label);

    const home = raw["backend"];
    if (typeof home !== "string" || !isCloudBackend(home)) {
      problems.push(`${label}: backend must be one of ${CLOUD_BACKENDS.join(", ")}`);
    } else if (homes.has(home)) {
      problems.push(`${label}: backend "${home}" is already ${homes.get(home)}'s home (one model, one bot)`);
    } else homes.set(home, label);

    const fallbackRaw = raw["fallback"] ?? [];
    let spares: string[] = [];
    if (!Array.isArray(fallbackRaw) || fallbackRaw.some((entry) => typeof entry !== "string")) {
      problems.push(`${label}: fallback must be a list of backend names`);
    } else {
      spares = fallbackRaw as string[];
      const outside = spares.filter((entry) => !isCloudBackend(entry));
      if (outside.length > 0) problems.push(`${label}: fallback ${outside.join(", ")} not cloud (allowed: ${CLOUD_BACKENDS.join(", ")})`);
      if (new Set(spares).size !== spares.length) problems.push(`${label}: fallback names a backend twice`);
      if (typeof home === "string" && spares.includes(home)) problems.push(`${label}: fallback repeats its own backend "${home}"`);
    }

    const dirRaw = raw["dir"];
    if (dirRaw !== undefined && (typeof dirRaw !== "string" || !dirRaw.startsWith("/") || dirRaw.includes("\0"))) {
      problems.push(`${label}: dir must be an absolute path`);
    }

    const scope = raw["scope"] ?? "machine";
    if (scope !== "machine" && scope !== "worktree") problems.push(`${label}: scope must be "machine" or "worktree"`);

    // Only read when `problems` is empty, so the fallbacks here are never shown.
    bots.push({
      id: typeof id === "string" ? id : "",
      subject: typeof subject === "string" ? subject : "",
      home: typeof home === "string" ? home : "",
      spares,
      scope: scope === "worktree" ? "worktree" : "machine",
      ...(typeof dirRaw === "string" && dirRaw.startsWith("/") ? { dir: dirRaw } : {}),
    });
  });

  return problems.length > 0 ? { ok: false, problems } : { ok: true, bots };
}
