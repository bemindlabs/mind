/**
 * Level 3 counts only where a person confirmed it, on this machine (D-042).
 *
 * `autonomy.md` lives in git beside the soul, and an agent acting at level 2
 * may write files — including that one. Before this file, typing `write = 3`
 * into it skipped the phrase `autonomy set` asks for at a terminal (S5.1 AC4).
 * Now `autonomy set <category> 3` leaves a record here, outside the
 * repository, and a 3 the file claims without a record is held at 2.
 *
 * The record is keyed by the soul directory's absolute path, so a clone
 * elsewhere starts unconfirmed: letting an agent act without asking is a
 * decision of the person on that machine, and does not travel with the repo.
 *
 * What this does not do: a vendor CLI runs as the owner's uid and can write
 * here too. It turns "edit one line of the repo you are working in" into
 * "forge a second file, outside it, on purpose". The real boundary is a
 * separate uid or a sandbox, which is outside Mind.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";
import type { Category } from "./autonomy.ts";

/** Where confirmations live under the state root. */
export const CONFIRM_DIR = "dial";

/** One category confirmed at 3: who typed the phrase, and when. */
export interface Confirmation {
  readonly by: string;
  readonly at: string;
}

export type Confirmations = Readonly<Partial<Record<Category, Confirmation>>>;

/**
 * Every confirmation this subject has, under the state root. `erase` removes
 * this directory whole: a confirmation carries the name of whoever typed the
 * phrase, and keying it by path alone once left it where no erase looked.
 */
export function confirmationsDirFor(
  env: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
  subject: SubjectId,
): string {
  return join(stateRoot(env.home, env.env), CONFIRM_DIR, subject);
}

/** The record file for one soul directory of one subject. */
export function confirmationsPath(
  env: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
  dir: string,
  subject: SubjectId,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(resolve(dir));
  return join(confirmationsDirFor(env, subject), `${hasher.digest("hex").slice(0, 32)}.json`);
}

/** Read the record. Missing or unreadable is none — the safe direction. */
export async function readConfirmations(path: string): Promise<Confirmations> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const out: Partial<Record<Category, Confirmation>> = {};
    for (const [key, value] of Object.entries(raw)) {
      const v = value as Partial<Confirmation> | null;
      if (v !== null && typeof v === "object" && typeof v.by === "string" && typeof v.at === "string") {
        out[key as Category] = { by: v.by, at: v.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Record, or withdraw, one category's confirmation. Atomic. */
export async function setConfirmation(
  path: string,
  category: Category,
  confirmation: Confirmation | null,
): Promise<void> {
  const current: Partial<Record<Category, Confirmation>> = { ...(await readConfirmations(path)) };
  if (confirmation === null) delete current[category];
  else current[category] = confirmation;
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}`;
  await writeFile(temp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
