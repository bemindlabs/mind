/**
 * S7.3 — on what basis a subject's data came in, and for what use (D-077).
 *
 * Before anything of a subject is read into an agent — notes into memory,
 * artifacts into a persona draft — there must be a record of the basis for it:
 * which basis, who approved it, when, for which uses, until when (AC1). No
 * record, or one that has expired, been revoked, or does not name the use, and
 * the command stops before it reads a file (AC2, AC3). The owner's own data
 * goes through the same record with the basis `owner` — no shortcut (AC4).
 *
 * The record says what someone decided; it cannot say the decision was
 * lawful. That is the approver's, and the record names them so it is clear
 * whose it was.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "../soul/frontmatter.ts";
import { resolveSoulDir } from "../soul/load.ts";
import { ROLE_FILE } from "../soul/schema.ts";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";

export const BASIS_DIR = "basis";
export const BASIS_FILE = "records.json";

/** The uses a basis can allow. `fine-tune` is named so a basis can refuse it (AC3), though nothing trains (D-076). */
export const USES = ["memory", "persona", "fine-tune"] as const;
export type Use = (typeof USES)[number];

/** The bases a record can name — the owner's own data, and the PDPA/GDPR lawful bases that fit this work. */
export const BASES = ["owner", "consent", "contract", "legitimate-interest", "legal-obligation"] as const;
export type Basis = (typeof BASES)[number];

export interface BasisRecord {
  readonly id: string;
  readonly subject: string;
  readonly basis: Basis;
  readonly approvedBy: string;
  readonly at: string;
  readonly uses: readonly Use[];
  /** `YYYY-MM-DD`, the last day it holds; `null` for no end date. */
  readonly expires: string | null;
  readonly note: string;
  readonly revokedAt: string | null;
}

export function basisDirFor(
  env: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
  subject: SubjectId,
): string {
  return join(stateRoot(env.home, env.env), BASIS_DIR, subject);
}

/** The phrase a person types to record a basis. */
export function recordPhrase(subject: string): string {
  return `record basis for ${subject}`;
}

/** Why these values cannot be a record, or `undefined`. */
export function basisProblem(basis: string, uses: readonly string[], expires: string | null, now: Date): string | undefined {
  if (!(BASES as readonly string[]).includes(basis)) return `the basis is one of ${BASES.join(", ")} — not ${JSON.stringify(basis)}`;
  if (uses.length === 0) return `name at least one use: ${USES.join(", ")}`;
  const bad = uses.filter((u) => !(USES as readonly string[]).includes(u));
  if (bad.length > 0) return `the uses are ${USES.join(", ")} — not ${bad.map((b) => JSON.stringify(b)).join(", ")}`;
  if (expires !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) return `--expires is YYYY-MM-DD or never — not ${JSON.stringify(expires)}`;
    if (endOf(expires) < now.getTime()) return `${expires} has already passed`;
  }
  return undefined;
}

const endOf = (day: string) => Date.parse(`${day}T23:59:59.999Z`);

export async function readBasis(dir: string): Promise<readonly BasisRecord[]> {
  try {
    const raw = JSON.parse(await readFile(join(dir, BASIS_FILE), "utf8")) as unknown;
    return Array.isArray(raw) ? (raw as BasisRecord[]).filter((r) => typeof r?.id === "string" && Array.isArray(r?.uses)) : [];
  } catch {
    return [];
  }
}

export async function writeBasis(dir: string, records: readonly BasisRecord[]): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, BASIS_FILE);
  await writeFile(`${path}.${process.pid}`, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.${process.pid}`, path);
}

/** What state a record is in at `now`. */
export function recordState(r: BasisRecord, now: Date): "active" | "revoked" | "expired" {
  if (r.revokedAt !== null) return "revoked";
  if (r.expires !== null && endOf(r.expires) < now.getTime()) return "expired";
  return "active";
}

/**
 * AC2 + AC3: the record that lets this use happen now, or why none does.
 * The newest active record naming the use wins.
 */
export function basisFor(records: readonly BasisRecord[], use: Use, now: Date): { readonly ok: true; readonly record: BasisRecord } | { readonly ok: false; readonly reason: string } {
  const active = records.filter((r) => recordState(r, now) === "active");
  const allowing = active.filter((r) => r.uses.includes(use)).sort((a, b) => b.at.localeCompare(a.at));
  if (allowing[0] !== undefined) return { ok: true, record: allowing[0] };
  if (records.length === 0) return { ok: false, reason: "there is no basis on record for this subject" };
  if (active.length === 0) return { ok: false, reason: "every basis on record for this subject has expired or been revoked" };
  return { ok: false, reason: `the basis on record allows ${[...new Set(active.flatMap((r) => r.uses))].join(", ")} — not ${use}` };
}

/** The subject a soul names, read from its role file — for commands handed only an agent directory. */
export async function soulSubject(dir: string): Promise<string | undefined> {
  try {
    const where = await resolveSoulDir(dir);
    const parsed = parseFrontmatter(ROLE_FILE, await readFile(join(where, ROLE_FILE), "utf8"));
    const subject = parsed.ok ? parsed.value.doc.table["subject"] : undefined;
    return typeof subject === "string" ? subject : undefined;
  } catch {
    return undefined;
  }
}

/** How a refusal is said, with the command that would fix it. */
export function refusalLine(subject: string, use: Use, reason: string): string {
  return (
    `no basis to take ${subject}'s data in for ${use}: ${reason}. Nothing was read (S7.3). ` +
    `Record one at a terminal: mind basis record <owner|consent|contract|legitimate-interest|legal-obligation> --subject ${subject} --uses ${use}`
  );
}
