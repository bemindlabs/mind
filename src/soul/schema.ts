/**
 * What a soul is, and what makes one malformed.
 *
 * Two files, never one. D-006.4 asks for role knowledge and personal traits to
 * be separated *physically* — a different file, not a different field — so that
 * deleting one cannot take the other with it (`erase --personal`, S7.2 AC5).
 * A single file with a `[person]` table would satisfy the letter of I-5 and
 * none of its purpose, because the delete you actually want to perform is
 * `rm person.md`.
 *
 * Every function here takes the subject as an argument and checks it against
 * what the file declares. A soul that belongs to nobody in particular is how
 * identities start to bleed (I-3), so "which subject is this?" is answered by
 * the caller and confirmed by the file, never inferred from a directory name.
 *
 * Validation collects *all* issues rather than throwing on the first. Someone
 * hand-writing a soul wants the whole list, and a validator that stops early
 * teaches them to fix one line per run.
 */

import { isSubjectId, type SubjectId } from "../types.ts";

/** Schema tag a new `role.md` carries. Bumped when the shape changes. */
export const ROLE_SCHEMA = "mind/soul-role@1";
/** Schema tag a new `person.md` carries. */
export const PERSON_SCHEMA = "mind/soul-person@1";

/** Filename holding role knowledge, inside a soul directory. */
export const ROLE_FILE = "role.md";
/** Filename holding personal traits, inside a soul directory. */
export const PERSON_FILE = "person.md";

/**
 * One reason a soul was rejected, addressed to a human with an editor open.
 *
 * `line` is 1-based and relative to `file`. `0` means the problem is with the
 * file as a whole (missing, unreadable) and has no line to point at.
 */
export interface SoulIssue {
  /** Path as the caller would name it, e.g. `role.md`. */
  readonly file: string;
  /** 1-based line, or `0` when the issue is the whole file. */
  readonly line: number;
  /** Dotted key this is about, e.g. `scope.does`. Empty for file-level. */
  readonly path: string;
  /** One sentence, no jargon the file's author has not already seen. */
  readonly message: string;
  /**
   * Set when the line was *derived* rather than reported by a parser, so a
   * reader knows not to trust it to the character. Only TOML syntax errors are
   * approximate; every schema error points at the exact key (AC4).
   */
  readonly approximate?: boolean;
}

/** Dotted key path → 1-based line it was written on. */
export type KeyLines = ReadonlyMap<string, number>;

/** What the subject does, and what it declines to do. */
export interface SoulScope {
  readonly does: string;
  readonly does_not: string;
}

/** Role knowledge: the part that survives the person leaving. */
export interface SoulRole {
  readonly schema: typeof ROLE_SCHEMA;
  readonly subject: SubjectId;
  readonly name: string;
  readonly role: string;
  /**
   * Hard prohibitions. Required and non-empty on purpose: a soul that forbids
   * nothing is not a soul that was thought about, and AC1 lists ข้อห้าม as a
   * thing every identity must carry.
   */
  readonly prohibitions: readonly string[];
  readonly scope: SoulScope;
  /** Free-form escape hatch. Every other unknown key is an error. */
  readonly extra: Readonly<Record<string, string>>;
  /** Markdown after the frontmatter, byte-for-byte as written. */
  readonly body: string;
}

/** Personal traits: voice, address, principles. Deletable on its own. */
export interface SoulPerson {
  readonly schema: typeof PERSON_SCHEMA;
  readonly subject: SubjectId;
  readonly tone: readonly string[];
  readonly addresses_user_as: string;
  readonly refers_to_self_as: readonly string[];
  readonly principles: readonly string[];
  /**
   * The person or people whose knowledge this identity inherits (D-046). Empty
   * when it inherits from nobody. Here, not in `role.md`, because a name is
   * personal data and goes with `erase --personal`.
   */
  readonly inherits_from: readonly string[];
  /** Markdown after the frontmatter, byte-for-byte as written. */
  readonly body: string;
}

/** One identity: two files, one subject, and a disclosure it cannot refuse. */
export interface Soul {
  readonly subject: SubjectId;
  readonly role: SoulRole;
  readonly person: SoulPerson;
  /**
   * Always `true`, always set here rather than read from the file.
   *
   * I-5 is not a default a soul may override, so there is deliberately no way
   * to write this key: `disclosesAi` in a soul file is an unknown key and the
   * file is rejected. The type says `true` so a reader never has to check.
   */
  readonly disclosesAi: true;
}

/** Either a validated value, or every reason it was refused. */
export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly SoulIssue[] };

/**
 * A validation pass over one parsed file.
 *
 * Holds the key→line index so that every complaint can name a line, and
 * accumulates issues instead of throwing.
 */
class Check {
  readonly issues: SoulIssue[] = [];

  /**
   * @param anchor Line to blame when a key is *absent* — there is no line for
   *   something that was never written, so we point at the frontmatter opener.
   */
  constructor(
    private readonly file: string,
    private readonly table: Record<string, unknown>,
    private readonly lines: KeyLines,
    private readonly anchor: number,
  ) {}

  private lineOf(path: string): number {
    const own = this.lines.get(path);
    if (own !== undefined) return own;
    // A key inside a table that exists gets the table's line, which is closer
    // to the truth than the top of the file.
    const dot = path.lastIndexOf(".");
    if (dot > 0) {
      const parent = this.lines.get(path.slice(0, dot));
      if (parent !== undefined) return parent;
    }
    return this.anchor;
  }

  fail(path: string, message: string): void {
    this.issues.push({ file: this.file, line: this.lineOf(path), path, message });
  }

  get(path: string): unknown {
    let cursor: unknown = this.table;
    for (const part of path.split(".")) {
      if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
  }

  /** A required, non-empty, single string. */
  requireString(path: string): string {
    const raw = this.get(path);
    if (raw === undefined) {
      this.fail(path, "required, but missing");
      return "";
    }
    if (typeof raw !== "string") {
      this.fail(path, `expected a string, found ${describe(raw)}`);
      return "";
    }
    if (raw.trim().length === 0) {
      this.fail(path, "must not be empty");
      return "";
    }
    return raw;
  }

  /** A required array of non-empty strings, itself non-empty. */
  requireStrings(path: string): readonly string[] {
    const raw = this.get(path);
    if (raw === undefined) {
      this.fail(path, "required, but missing");
      return [];
    }
    if (!Array.isArray(raw)) {
      this.fail(path, `expected an array of strings, found ${describe(raw)}`);
      return [];
    }
    if (raw.length === 0) {
      this.fail(path, "must list at least one entry");
      return [];
    }
    const out: string[] = [];
    raw.forEach((item, index) => {
      if (typeof item !== "string" || item.trim().length === 0) {
        this.fail(path, `entry ${index + 1} must be a non-empty string, found ${describe(item)}`);
        return;
      }
      out.push(item);
    });
    return out;
  }

  /** The schema tag, which must match exactly. */
  requireSchema(expected: string): void {
    const raw = this.get("schema");
    if (raw !== expected) {
      this.fail("schema", `must be ${JSON.stringify(expected)}, found ${describe(raw)}`);
    }
  }

  /**
   * The subject the file claims, checked against the one the caller asked for.
   *
   * Both halves matter. A well-formed id that belongs to someone else is the
   * exact failure I-3 exists to prevent, and it is silent unless checked here.
   */
  requireSubject(expected: SubjectId): void {
    const raw = this.get("subject");
    if (typeof raw !== "string" || !isSubjectId(raw)) {
      this.fail("subject", `must be a subject id, found ${describe(raw)}`);
      return;
    }
    if (raw !== expected) {
      this.fail(
        "subject",
        `belongs to subject ${JSON.stringify(raw)}, but was loaded as ${JSON.stringify(expected)}`,
      );
    }
  }

  /** Reject any top-level key outside `allowed`, naming the line it is on. */
  rejectUnknownTopLevel(allowed: readonly string[]): void {
    for (const key of Object.keys(this.table)) {
      if (allowed.includes(key)) continue;
      this.fail(key, `unknown key — the soul schema defines ${allowed.join(", ")}`);
    }
  }

  /** A required sub-table with a closed set of keys. */
  requireTable(path: string, allowed: readonly string[]): void {
    const raw = this.get(path);
    if (raw === undefined) {
      this.fail(path, "required, but missing");
      return;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      this.fail(path, `expected a table, found ${describe(raw)}`);
      return;
    }
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (allowed.includes(key)) continue;
      this.fail(`${path}.${key}`, `unknown key — [${path}] defines ${allowed.join(", ")}`);
    }
  }

  /** The one open table: any key, but string values only. */
  optionalStringTable(path: string): Record<string, string> {
    const raw = this.get(path);
    if (raw === undefined) return {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      this.fail(path, `expected a table, found ${describe(raw)}`);
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== "string") {
        this.fail(`${path}.${key}`, `expected a string, found ${describe(value)} — [${path}] holds text only`);
        continue;
      }
      out[key] = value;
    }
    return out;
  }
}

/** Name a value the way its author would recognise it. */
function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "a table";
  return `${typeof value} ${JSON.stringify(value)}`;
}

/** Keys `role.md` may carry. Anything else is a typo worth catching. */
const ROLE_KEYS = ["schema", "subject", "name", "role", "prohibitions", "scope", "extra"] as const;
/** Keys `person.md` may carry. */
const PERSON_KEYS = [
  "schema",
  "subject",
  "tone",
  "addresses_user_as",
  "refers_to_self_as",
  "principles",
  "inherits_from",
] as const;

/** Validate a parsed `role.md` against the schema and the expected subject. */
export function validateRole(
  file: string,
  table: Record<string, unknown>,
  lines: KeyLines,
  anchor: number,
  subject: SubjectId,
  body: string,
): Validated<SoulRole> {
  const check = new Check(file, table, lines, anchor);
  check.requireSchema(ROLE_SCHEMA);
  check.requireSubject(subject);
  check.rejectUnknownTopLevel([...ROLE_KEYS]);

  const name = check.requireString("name");
  const role = check.requireString("role");
  const prohibitions = check.requireStrings("prohibitions");
  check.requireTable("scope", ["does", "does_not"]);
  const does = check.requireString("scope.does");
  const doesNot = check.requireString("scope.does_not");
  const extra = check.optionalStringTable("extra");

  if (check.issues.length > 0) return { ok: false, issues: check.issues };
  return {
    ok: true,
    value: {
      schema: ROLE_SCHEMA,
      subject,
      name,
      role,
      prohibitions,
      scope: { does, does_not: doesNot },
      extra,
      body,
    },
  };
}

/** Validate a parsed `person.md` against the schema and the expected subject. */
export function validatePerson(
  file: string,
  table: Record<string, unknown>,
  lines: KeyLines,
  anchor: number,
  subject: SubjectId,
  body: string,
): Validated<SoulPerson> {
  const check = new Check(file, table, lines, anchor);
  check.requireSchema(PERSON_SCHEMA);
  check.requireSubject(subject);
  check.rejectUnknownTopLevel([...PERSON_KEYS]);

  const tone = check.requireStrings("tone");
  const addressesUserAs = check.requireString("addresses_user_as");
  const refersToSelfAs = check.requireStrings("refers_to_self_as");
  const principles = check.requireStrings("principles");
  const inheritsFrom = check.get("inherits_from") === undefined ? [] : check.requireStrings("inherits_from");

  if (check.issues.length > 0) return { ok: false, issues: check.issues };
  return {
    ok: true,
    value: {
      schema: PERSON_SCHEMA,
      subject,
      tone,
      addresses_user_as: addressesUserAs,
      refers_to_self_as: refersToSelfAs,
      principles,
      inherits_from: inheritsFrom,
      body,
    },
  };
}

/**
 * Pair two validated halves into a soul.
 *
 * Exists so `disclosesAi` has exactly one origin in the codebase (I-5).
 */
/** Lower-case, NFC, punctuation to spaces — the form names are compared in. */
function nameForm(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * I-5 / D-006 / D-046 — an identity may not wear the name of the person it
 * inherits from. Every way it names itself is checked: `role.name` and each
 * `refers_to_self_as`. A source name matches whole, or by any part of it of
 * three characters or more, anywhere in the agent's name — a substring rather
 * than a word match, because Thai writes a name with no space to split on.
 */
export function borrowedNames(role: SoulRole, person: SoulPerson): readonly { readonly used: string; readonly source: string }[] {
  const hits: { used: string; source: string }[] = [];
  const selves = [role.name, ...person.refers_to_self_as];
  for (const source of person.inherits_from) {
    const whole = nameForm(source);
    const parts = [whole, ...whole.split(" ").filter((part) => [...part].length >= 3)];
    for (const used of selves) {
      if (parts.some((part) => part !== "" && nameForm(used).includes(part))) hits.push({ used, source });
    }
  }
  return hits;
}

export function soulOf(subject: SubjectId, role: SoulRole, person: SoulPerson): Soul {
  return { subject, role, person, disclosesAi: true };
}

/** Render an issue the way a compiler would, for a terminal or a test. */
export function formatIssue(issue: SoulIssue): string {
  const where = issue.line > 0 ? `${issue.file}:${issue.line}` : issue.file;
  const what = issue.path === "" ? issue.message : `${issue.path} — ${issue.message}`;
  const hedge = issue.approximate === true ? "  (line is approximate: at or before it)" : "";
  return `${where}: ${what}${hedge}`;
}
