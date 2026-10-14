/**
 * Reading a soul off disk, for exactly one subject.
 *
 * No cache, no module-level state, no "current" soul. Mind wears identities
 * rather than having one (D-011), and a cache keyed by directory is how the
 * identity you loaded last starts answering for the identity you asked for
 * (I-3). Loading twice is cheap; loading the wrong subject is not.
 *
 * The subject is an argument *and* is checked against both files, which is the
 * point: a directory name is a hint, the `subject` key is the claim, and the
 * argument is the question. All three have to agree.
 */

import { join } from "node:path";
import type { SubjectId } from "../types.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import {
  PERSON_FILE,
  ROLE_FILE,
  borrowedNames,
  soulOf,
  validatePerson,
  validateRole,
  type Soul,
  type SoulIssue,
  type SoulPerson,
  type SoulRole,
} from "./schema.ts";

/** Either the soul, or every reason it was refused. */
export type SoulLoad =
  | { readonly ok: true; readonly soul: Soul }
  | { readonly ok: false; readonly issues: readonly SoulIssue[] };

/** Parse `role.md` from text. Exposed so tests need no filesystem. */
export function parseRole(
  file: string,
  text: string,
  subject: SubjectId,
): { readonly ok: true; readonly value: SoulRole } | { readonly ok: false; readonly issues: readonly SoulIssue[] } {
  const front = parseFrontmatter(file, text);
  if (!front.ok) return front;
  const { doc, body, openLine } = front.value;
  return validateRole(file, doc.table, doc.lines, openLine, subject, body);
}

/** Parse `person.md` from text. */
export function parsePerson(
  file: string,
  text: string,
  subject: SubjectId,
): { readonly ok: true; readonly value: SoulPerson } | { readonly ok: false; readonly issues: readonly SoulIssue[] } {
  const front = parseFrontmatter(file, text);
  if (!front.ok) return front;
  const { doc, body, openLine } = front.value;
  return validatePerson(file, doc.table, doc.lines, openLine, subject, body);
}

/**
 * Parse both halves at once, reporting every issue from both.
 *
 * Deliberately not short-circuiting after `role.md`: someone fixing a soul
 * wants the whole list, and the two files are edited together.
 */
export function parseSoul(
  roleText: string,
  personText: string,
  subject: SubjectId,
): SoulLoad {
  const role = parseRole(ROLE_FILE, roleText, subject);
  const person = parsePerson(PERSON_FILE, personText, subject);
  if (!role.ok || !person.ok) {
    return {
      ok: false,
      issues: [...(role.ok ? [] : role.issues), ...(person.ok ? [] : person.issues)],
    };
  }
  const borrowed = borrowedNames(role.value, person.value);
  if (borrowed.length > 0) {
    return {
      ok: false,
      issues: borrowed.map(({ used }) => ({
        file: ROLE_FILE,
        line: 0,
        path: used === role.value.name ? "name" : "refers_to_self_as",
        message:
          `${JSON.stringify(used)} carries the name of the person this identity inherits from ` +
          `(inherits_from in ${PERSON_FILE}). An agent has a name of its own and says it is an AI; ` +
          `it does not go by the person's name (I-5, D-006). Rename it.`,
      })),
    };
  }
  return { ok: true, soul: soulOf(subject, role.value, person.value) };
}

/**
 * The directory an agent repository keeps its soul in. The same word as
 * `SOUL_DIR` in `src/agent/template.ts`, spelled here rather than imported:
 * `src/agent` imports this module, and a soul must not need an agent to be
 * read. `test/soul/load.test.ts` holds the two equal.
 */
const SOUL_SUBDIR = "soul";

/**
 * Where the two files are, given either a soul directory or an agent repository.
 *
 * `new` and `rebuild` take the repository; `soul check`, `turn` and `--as` took
 * the `soul/` inside it, and the help text said `<dir>` for both. The owner
 * pointed `turn` at the repository, was told `role.md: not found` with the file
 * a directory away, and there was no word in the message about where else it
 * had looked (D-033). So the rule lives here, once, under every caller: the
 * directory itself if either file is in it, else its `soul/` if either file is
 * there, else the directory itself — so that a message about a missing soul
 * names the place the caller named.
 */
export async function resolveSoulDir(dir: string): Promise<string> {
  if (await anyPresent(dir)) return dir;
  const nested = join(dir, SOUL_SUBDIR);
  if (await anyPresent(nested)) return nested;
  return dir;
}

async function anyPresent(dir: string): Promise<boolean> {
  const [role, person] = await Promise.all([
    Bun.file(join(dir, ROLE_FILE)).exists(),
    Bun.file(join(dir, PERSON_FILE)).exists(),
  ]);
  return role || person;
}

/**
 * Load the soul in `dir` — a soul directory or an agent repository — for
 * `subject`.
 *
 * A missing file is an issue, not an exception: the caller is usually printing
 * a list of problems, and one of the problems being "there is nothing here" is
 * not a different kind of event. When neither file is found in either place,
 * the issue says both places, because "not found" with no address was how the
 * owner spent a quarter of an hour on a file that existed.
 */
export async function loadSoul(dir: string, subject: SubjectId): Promise<SoulLoad> {
  const where = await resolveSoulDir(dir);
  const [roleText, personText] = await Promise.all([
    readOrUndefined(join(where, ROLE_FILE)),
    readOrUndefined(join(where, PERSON_FILE)),
  ]);

  const missing: SoulIssue[] = [];
  const looked = where === dir ? `${dir} and ${join(dir, SOUL_SUBDIR)}` : where;
  if (roleText === undefined) missing.push(absent(ROLE_FILE, "role knowledge", looked));
  if (personText === undefined) missing.push(absent(PERSON_FILE, "personal traits", looked));
  if (roleText === undefined || personText === undefined) return { ok: false, issues: missing };

  return parseSoul(roleText, personText, subject);
}

function absent(file: string, holds: string, looked: string): SoulIssue {
  return {
    file,
    line: 0,
    path: "",
    message: `not found in ${looked} — a soul is two files, and this one holds its ${holds}`,
  };
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  const handle = Bun.file(path);
  if (!(await handle.exists())) return undefined;
  return handle.text();
}
