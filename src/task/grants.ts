/**
 * S22.11 (D-197) — a standing grant: an answer given ahead of time to a question a task's browser will ask, so a
 * fleet bot is not stopped at the same one every time.
 *
 * ## What it is, and the only thing it does
 *
 * The owner says: *this bot may do this kind of sensitive thing on this origin until this time.* When a task's step
 * holds an action (D-156) that the grant fits, the runner answers the held action itself — **through the same
 * `decideApproval` an owner's yes goes through**, so the claim, the digest, the step check, the signature and the
 * taint rule that refuses a yes claimed while a loosened turn ran all apply unchanged. A grant adds no way to
 * release an action; it adds a second source of the same yes, written down as `by: grant:<id>`.
 *
 * ## What it can never cover
 *
 * - **A credential (D-160).** `credentials` is not a category a grant can name, and an approval that is not
 *   `approvable` or {@link isCredential} is never matched, whatever grants exist.
 * - **More than it names.** An action holds one or more categories; each must be covered by a grant of its own, on
 *   the action's own origin (exact), for this bot, and — when the grant names a task — for that task.
 * - **Personal data leaving the machine (I-6).** Nothing here is read by the egress screen, the judge or a proposal:
 *   a test holds a floor over those directories for any mention of a grant. A grant answers a held browser action; it
 *   is not consent to send anyone's data to a vendor.
 * - **The brake.** `mind stop` stops the runner, and no grant is used while it is on (the caller asks).
 *
 * ## Lifetime, and why it is short
 *
 * A grant expires, and the longest any may last depends on what it covers: a week for sending or accepting terms, a day
 * for deleting or paying — and paying needs a task named, so one grant is one job's worth, not a standing licence. The
 * owner's own words were that all four may be granted; the numbers are the engine's, and are constants here
 * ({@link MAX_LIFETIME_MS}) so a reader can argue with them.
 *
 * ## Trust in the file
 *
 * A grant is a file any process of the owner's uid could write, exactly as an approval claim is. So the same defence:
 * a grant whose file was created while a turn that can run commands was running is not used (`tainted`, the
 * runner's own). It lives under the subject's `personal/` tree, which `--scope machine` keeps shut to a vendor.
 *
 * Pure but for the file functions at the bottom; nothing here reads the environment or the clock on its own.
 */

import { mkdir, readdir, readFile, stat, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAllowlist } from "../browser/allowlist.ts";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state.ts";
import { isCredential, type ActionApproval } from "./approvals.ts";
import { replaceFile } from "./store.ts";

export const GRANT_SCHEMA = "mind/grant@1";
export const GRANTS_DIR = "grants";
/** The append-only record of every grant given, revoked or used: ids, categories, origins and times, never a value. */
export const GRANT_EVENTS_FILE = "events.jsonl";

/** The categories a grant can name. `credentials` is not one, and never will be without D-160 changing. */
export const GRANTABLE = ["send", "delete", "terms", "payment"] as const;
export type GrantCategory = (typeof GRANTABLE)[number];

const HOUR = 3_600_000;
/** The longest a grant of each kind may last. */
export const MAX_LIFETIME_MS: Readonly<Record<GrantCategory, number>> = { send: 168 * HOUR, terms: 168 * HOUR, delete: 24 * HOUR, payment: 24 * HOUR };

export interface Grant {
  readonly schema: typeof GRANT_SCHEMA;
  readonly id: string;
  readonly subject: string;
  readonly category: GrantCategory;
  /** The origin, normalised the way `--allow` is (`https://example.com`). */
  readonly origin: string;
  /** The one task it is for, or `null` for any task of this subject. Required for `payment`. */
  readonly task: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

const GRANT_ID = /^g-[0-9a-f]{8}$/;
export const isGrantId = (id: string): boolean => GRANT_ID.test(id);
export const newGrantId = (): string => `g-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

/** `90m`, `24h`, `7d`: a whole number and one unit. Anything else is undefined. */
export function parseLifetime(text: string): number | undefined {
  const match = /^([1-9][0-9]{0,4})([mhd])$/.exec(text.trim());
  if (match === null) return undefined;
  return Number(match[1]) * { m: 60_000, h: HOUR, d: 24 * HOUR }[match[2] as "m" | "h" | "d"];
}

export type NewGrant = { readonly ok: true; readonly grant: Grant } | { readonly ok: false; readonly reason: string };

/** Make a grant from what was asked, or say why not. Pure: the id and the clock are arguments. */
export function makeGrant(input: {
  readonly subject: string;
  readonly category: string;
  readonly origin: string;
  readonly lifetime: string;
  readonly task?: string | undefined;
  readonly now: Date;
  readonly id: string;
}): NewGrant {
  if (input.category === "credentials") {
    return { ok: false, reason: "credentials cannot be granted: a password or credential is never entered for you (D-160)" };
  }
  if (!(GRANTABLE as readonly string[]).includes(input.category)) {
    return { ok: false, reason: `--category is one of ${GRANTABLE.join(", ")}` };
  }
  const category = input.category as GrantCategory;
  const origins = parseAllowlist([input.origin]);
  if (!origins.ok) return { ok: false, reason: origins.errors.join("; ") };
  if (origins.origins.length !== 1) return { ok: false, reason: "--origin names exactly one origin" };
  const ms = parseLifetime(input.lifetime);
  if (ms === undefined) return { ok: false, reason: "--for is a whole number and a unit: 90m, 24h or 7d" };
  if (ms > MAX_LIFETIME_MS[category]) {
    return { ok: false, reason: `a ${category} grant lasts at most ${MAX_LIFETIME_MS[category] / HOUR} hours; --for is ${ms / HOUR}` };
  }
  if (category === "payment" && input.task === undefined) {
    return { ok: false, reason: "a payment grant names the one task it is for (--task): it is one job's worth, not a standing licence" };
  }
  if (input.task !== undefined && !/^t-[0-9a-f]{8}$/.test(input.task)) {
    return { ok: false, reason: `${JSON.stringify(input.task)} is not a task id (t- and eight hex)` };
  }
  return {
    ok: true,
    grant: {
      schema: GRANT_SCHEMA,
      id: input.id,
      subject: input.subject,
      category,
      origin: origins.origins[0]!.text,
      task: input.task ?? null,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + ms).toISOString(),
      revokedAt: null,
    },
  };
}

/** An origin as `--allow` writes it (`https://example.com:443`, the default port spelled out), or `undefined`. */
export function normalOrigin(origin: string): string | undefined {
  const parsed = parseAllowlist([origin]);
  return parsed.ok && parsed.origins.length === 1 ? parsed.origins[0]!.text : undefined;
}

/** A grant that has not expired and was not revoked. */
export function isActive(grant: Grant, now: number): boolean {
  return grant.revokedAt === null && Date.parse(grant.expiresAt) > now;
}

export type Covering =
  | { readonly covered: true; readonly grants: readonly Grant[] }
  | { readonly covered: false; readonly why: string };

/**
 * The grants that answer a held action, or why none does. Every category the action holds needs a grant of its own.
 *
 * @param grants Only the ones the caller trusts: not tainted, for this subject.
 */
export function covering(
  approval: Pick<ActionApproval, "approvable" | "rules" | "action" | "categories" | "task">,
  grants: readonly Grant[],
  subject: string,
  now: number,
): Covering {
  if (!approval.approvable || isCredential(approval)) return { covered: false, why: "a credential is never answered by a grant (D-160)" };
  if (approval.categories.length === 0) return { covered: false, why: "the action names no category, so no grant can fit it" };
  // The container writes an origin the way a browser does (no default port), a grant the way `--allow` does: compared
  // after the same normalisation, and exactly — a host that only starts the same is another origin.
  const origin = typeof approval.action.origin === "string" ? (normalOrigin(approval.action.origin) ?? "") : "";
  const used: Grant[] = [];
  for (const category of approval.categories) {
    if (!(GRANTABLE as readonly string[]).includes(category)) return { covered: false, why: `${category} is not a category a grant can cover` };
    const match = grants.find(
      (grant) =>
        grant.category === category &&
        grant.subject === subject &&
        grant.origin === origin &&
        (grant.task === null || grant.task === approval.task) &&
        isActive(grant, now),
    );
    if (origin === "") return { covered: false, why: "the action's origin is not one a grant can name" };
    if (match === undefined) return { covered: false, why: `no active ${category} grant for ${origin}` };
    if (!used.includes(match)) used.push(match);
  }
  return { covered: true, grants: used };
}

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

export interface StoredGrant {
  readonly grant: Grant;
  /** When the file was created, from the filesystem (`ctime`), which no process can set: what the taint rule compares. */
  readonly createdMs: number;
}

export type GrantEvent =
  | { readonly event: "give"; readonly grant: string; readonly category: string; readonly origin: string; readonly task: string | null; readonly expiresAt: string }
  | { readonly event: "revoke"; readonly grant: string }
  | { readonly event: "use"; readonly grant: string; readonly task: string; readonly approval: string; readonly category: string };

function asGrant(value: unknown): Grant | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const g = value as Record<string, unknown>;
  const ok =
    g["schema"] === GRANT_SCHEMA &&
    typeof g["id"] === "string" &&
    isGrantId(g["id"]) &&
    typeof g["subject"] === "string" &&
    (GRANTABLE as readonly unknown[]).includes(g["category"]) &&
    typeof g["origin"] === "string" &&
    (g["task"] === null || typeof g["task"] === "string") &&
    typeof g["createdAt"] === "string" &&
    typeof g["expiresAt"] === "string" &&
    (g["revokedAt"] === null || typeof g["revokedAt"] === "string");
  return ok ? (value as Grant) : undefined;
}

export async function appendGrantEvent(dir: string, event: GrantEvent, now: Date): Promise<void> {
  await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
  await appendFile(join(dir, GRANT_EVENTS_FILE), `${JSON.stringify({ at: now.toISOString(), ...event })}\n`, { mode: STATE_FILE_MODE });
}

/** Write a new grant (refuses an id that exists) and record that it was given. */
export async function giveGrant(dir: string, grant: Grant, now: Date): Promise<void> {
  await mkdir(dir, { recursive: true, mode: STATE_DIR_MODE });
  const path = join(dir, `${grant.id}.json`);
  if (await Bun.file(path).exists()) throw new Error(`grant ${grant.id} exists`);
  await replaceFile(path, `${JSON.stringify(grant, null, 2)}\n`);
  await appendGrantEvent(dir, { event: "give", grant: grant.id, category: grant.category, origin: grant.origin, task: grant.task, expiresAt: grant.expiresAt }, now);
}

/** Every readable grant in `dir`, with when its file was made. An unreadable or foreign file is left out, not an error. */
export async function readGrants(dir: string): Promise<readonly StoredGrant[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => /^g-[0-9a-f]{8}\.json$/.test(name));
  } catch {
    return [];
  }
  const out: StoredGrant[] = [];
  for (const name of names.sort()) {
    try {
      const grant = asGrant(JSON.parse(await readFile(join(dir, name), "utf8")));
      if (grant !== undefined && `${grant.id}.json` === name) out.push({ grant, createdMs: (await stat(join(dir, name))).ctimeMs });
    } catch {
      // Not a grant: left out.
    }
  }
  return out;
}

export type Revoked = { readonly ok: true; readonly grant: Grant } | { readonly ok: false; readonly reason: string };

/** Revoke at once: the file is rewritten with `revokedAt`, and the event recorded. A revoked grant is never used again. */
export async function revokeGrant(dir: string, id: string, now: Date): Promise<Revoked> {
  if (!isGrantId(id)) return { ok: false, reason: `${JSON.stringify(id)} is not a grant id (g- and eight hex)` };
  const found = (await readGrants(dir)).find((entry) => entry.grant.id === id);
  if (found === undefined) return { ok: false, reason: `no grant ${id}` };
  if (found.grant.revokedAt !== null) return { ok: false, reason: `grant ${id} was revoked already` };
  const grant = { ...found.grant, revokedAt: now.toISOString() };
  await replaceFile(join(dir, `${id}.json`), `${JSON.stringify(grant, null, 2)}\n`);
  await appendGrantEvent(dir, { event: "revoke", grant: id }, now);
  return { ok: true, grant };
}

export interface GrantReport {
  /** Held actions a grant answered: requests that did not need a person. Counted from the record, not estimated. */
  readonly answered: number;
  readonly byGrant: Readonly<Record<string, number>>;
  readonly given: number;
  readonly revoked: number;
}

/** What the record says the grants did. A line that is not ours is skipped. */
export async function grantReport(dir: string): Promise<GrantReport> {
  let text = "";
  try {
    text = await readFile(join(dir, GRANT_EVENTS_FILE), "utf8");
  } catch {
    // No record yet: nothing happened.
  }
  const byGrant: Record<string, number> = {};
  const approvals = new Set<string>();
  let given = 0;
  let revoked = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const event = JSON.parse(line) as { event?: string; grant?: string; approval?: string };
      if (event.event === "use" && typeof event.grant === "string" && typeof event.approval === "string") {
        // One held action can be covered by two grants (send and terms): it is one request that needed no person.
        approvals.add(event.approval);
        byGrant[event.grant] = (byGrant[event.grant] ?? 0) + 1;
      } else if (event.event === "give") given += 1;
      else if (event.event === "revoke") revoked += 1;
    } catch {
      // A torn line is skipped.
    }
  }
  return { answered: approvals.size, byGrant, given, revoked };
}
