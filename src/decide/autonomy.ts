/**
 * The autonomy dial — and the sentence a reader of its name will get backwards.
 *
 * ## Read this before anything else in this directory
 *
 * **The dial does not add safety. It is the key that takes safety off.**
 *
 * Every `headlessArgv` in `src/exec/registry.ts` splices {@link
 * import("../exec/registry.ts").readOnlyArgs} into the command line
 * *unconditionally* — six vendors, six call sites, no branch between the
 * declaration and the argv. Measured on 2026-09-22 against the tree at `97fb8d2`:
 * every turn Mind has ever started already carries whatever read-only flag
 * its vendor offers. So the starting state of this program is the *restrained*
 * one, and `DEFAULT_DIAL` — every category at 1 — is not an intention waiting to
 * be implemented. It is a description of what already happens.
 *
 * What is new is the ability to **turn that off**, at level 2 and above. A
 * reader who arrives at a file called `autonomy.ts` expecting a safety feature
 * will read every default here as timid and every raise as progress, and will be
 * wrong in the one direction that costs something. The backlog calls S5.1
 * *"คุมได้ว่าเรื่องไหนทำเองได้"* — control over what it may do by itself — and
 * control is bidirectional. This file is the loosening half.
 *
 * ## Four categories, one lever
 *
 * AC2 asks for four: read, write, run, reach. D-002 (Mind borrows vendor CLIs
 * rather than owning a sandbox) means the lever that really exists is **one bit
 * per turn**: the vendor's read-only flag is on, or it is not. Four numbers
 * therefore have to collapse into one decision, and the collapse is
 * {@link actLevel} — a **minimum**, never a maximum.
 *
 * Minimum, because `reach` is capped at 2 by its own type ({@link ReachLevel},
 * S8.3 AC2 / I-6). Under a maximum, setting `write = 3` would drag the acting
 * level to 3 and `reach` would be at 3 by arithmetic while its type still said
 * `0 | 1 | 2` — the guard would lose without anything printing a word. Under a
 * minimum, the flag comes off only when **all three** of write, run and reach
 * are at 2 or more, so raising `reach` is the single door, which is exactly
 * where I-6 wants the door to be.
 *
 * The cost of a minimum is its own kind of lie: a `write = 3` that does nothing
 * because `reach` is 1. That is why {@link import("./effective.ts").effectiveDial}
 * reports every clamp it applies and `mind autonomy set` prints them **at the
 * moment of setting**. A dial that quietly divides your number by something is
 * still a dial that lies; it just lies with arithmetic instead of with silence.
 *
 * ## `read` cannot be separated, and says so
 *
 * There is no vendor flag that means "may read, may not write". claude's
 * mechanism is `--tools ""`, an empty allow list that removes the read tools
 * too; codex's is `--sandbox read-only`, which reads freely. So `read` is kept
 * as a number because AC2 asks for four categories — the ACs are the owner's —
 * and every place it is printed carries `not separable` beside it rather than a
 * bare integer that implies a control nobody has.
 */

import { withThai, type Language } from "../lang.ts";
import { parseFrontmatter } from "../soul/frontmatter.ts";
import type { SoulIssue, Validated } from "../soul/schema.ts";

/**
 * Schema tag `autonomy.md` is written with. Bumped when the shape changes.
 *
 * `@2` added `operate` (D-153). A file still at {@link AUTONOMY_SCHEMA_V1} is
 * read, and its missing `operate` is **0** — no browser. That is the one
 * default this file allows, because it is the lowest level there is: a file
 * written before the category existed cannot have meant to hand the agent a
 * browser, and reading it as 0 loosens nothing. The next `autonomy set` writes
 * the file back at `@2`, with every category named.
 */
export const AUTONOMY_SCHEMA = "mind/autonomy@2";

/** The schema before `operate` existed. Read, never written. */
export const AUTONOMY_SCHEMA_V1 = "mind/autonomy@1";

/** Filename holding the dial, at the root of an agent repository. */
export const AUTONOMY_FILE = "autonomy.md";

/**
 * The four levels AC1 names.
 *
 * `0` is not "off with a warning" — it is *do not run the turn*. The other
 * three differ in what Mind does around a turn it runs; `0` is the only one
 * that is about not running.
 */
export type Level = 0 | 1 | 2 | 3;

/**
 * The reach category, capped at 2 by the type rather than by a check.
 *
 * I-6 and S8.3 AC2: *หมวด "ติดต่อภายนอก" ล็อกที่ระดับ 1 บังคับที่โค้ด* — the
 * outward-contact category is held low, in code. A `3` here would mean "contact
 * whoever, report nothing", which is the one setting I-6 says may not exist. It
 * is absent from the type, so writing it is a `tsc` error rather than a review
 * comment, and {@link parseDial} rejects it in a file for the same reason.
 */
export type ReachLevel = 0 | 1 | 2;

/**
 * The four AC2 asks for, in the order every report prints them, and `operate`
 * (D-153): whether the agent may use a browser, and how far.
 *
 * `operate` is **not** one of the categories a turn's acting level is the
 * minimum of ({@link actLevel}). It governs a different hand — the browser the
 * engine gives a task (D-150, D-151, D-155) — and its own effective level is
 * {@link operateLevel}, `min(operate, reach)`. Folding it into `actLevel` would
 * have made its default of 0 silence every turn an existing agent runs.
 */
export type Category = "read" | "write" | "run" | "reach" | "operate";

/** Every category, in print order. Closed, so a sixth is a `tsc` error. */
export const CATEGORIES: readonly Category[] = ["read", "write", "run", "reach", "operate"];

/** The categories a turn's acting level is the minimum of. `read` is not one (see {@link actLevel}). */
export const ACTING: readonly ["write", "run", "reach"] = ["write", "run", "reach"];

/** What each level does, in English, with the English name of the level in front. What an English reader sees. */
export const LEVEL_MEANING_EN: Readonly<Record<Level, string>> = Object.freeze({
  0: "silent — the turn does not run at all",
  1: "propose — the turn runs carrying the vendor's read-only flag",
  2: "act, then report — the turn runs with the read-only flag taken off",
  3: "act on its own — the turn runs with the read-only flag taken off",
});

/**
 * What each level means, in the backlog's own words plus what Mind does: the Thai name, then the English.
 *
 * This is the Thai-led form, kept word for word. Nothing prints it unless Thai is chosen — {@link levelMeaning}
 * is what a command calls, and it gives English alone by default (GL-01).
 */
export const LEVEL_MEANING: Readonly<Record<Level, string>> = Object.freeze({
  0: "เงียบ — the turn does not run at all",
  1: "เสนอ — the turn runs carrying the vendor's read-only flag",
  2: "ทำแล้วรายงาน — the turn runs with the read-only flag taken off",
  3: "ทำเลย — the turn runs with the read-only flag taken off",
});

/**
 * One level, in the chosen language: English alone, or the Thai-led form ({@link LEVEL_MEANING}) when Thai is
 * chosen. English is the default, so a caller that forgets the argument prints English.
 */
export function levelMeaning(level: Level, language: Language = "en"): string {
  return language === "th" ? LEVEL_MEANING[level] : LEVEL_MEANING_EN[level];
}

/**
 * What each `operate` level means (D-153), in English and in Thai. Both are
 * kept; {@link operateMeaning} prints the English, and the Thai after it only
 * when Thai is chosen (GL-01).
 *
 * Level 3 is "any origin", and it needs the phrase at a terminal on this
 * machine, the same as every 3 (D-042). Every level, 3 included, still stops
 * for a yes before anything on the sensitive-actions list
 * (`src/decide/sensitive.ts`): payment, sending, deleting, credentials, terms.
 */
export const OPERATE_MEANING: Readonly<Record<Level, { readonly en: string; readonly th: string }>> = Object.freeze({
  0: { en: "no browser", th: "ไม่ใช้เบราว์เซอร์" },
  1: { en: "looks, then proposes — it does not click or type (D-045)", th: "ดูแล้วเสนอ — ไม่คลิก ไม่พิมพ์" },
  2: {
    en: "acts only on the task's allowed sites, recorded and reported (D-043)",
    th: "ทำได้เฉพาะเว็บที่งานอนุญาต บันทึกและรายงาน",
  },
  3: {
    en: "acts on any site — confirmed by a typed phrase at a terminal on this machine (D-042)",
    th: "ทำได้ทุกเว็บ — ต้องพิมพ์ยืนยันที่ terminal บนเครื่องนี้",
  },
});

/** One `operate` level in the chosen language: the English, with the Thai after ` · ` when Thai is chosen. */
export function operateMeaning(level: Level, language: Language = "en"): string {
  return withThai(OPERATE_MEANING[level].en, OPERATE_MEANING[level].th, language);
}

/**
 * How a category is enforced on this machine, or the admission that it is not.
 *
 * Printed beside every number by `mind autonomy show`. Three of the four are
 * the same one bit, which is a fact about D-002 and not a gap in this file.
 */
export const CATEGORY_ENFORCEMENT: Readonly<Record<Category, string>> = Object.freeze({
  read:
    "not separable — no vendor here offers a flag that permits reading and forbids writing. " +
    "claude's mechanism is an empty tool allow list, which removes the read tools too; codex's " +
    "is a read-only sandbox, which reads freely. This number is recorded and reported and " +
    "nothing in Mind acts on it.",
  write:
    "the vendor's own read-only flag, per vendor, listed by `mind backends`. One bit, on or " +
    "off, decided for the whole turn.",
  run:
    "the same one bit — a vendor CLI that may write may also run commands, and no flag here " +
    "separates them.",
  reach:
    "the same one bit for a turn, plus the egress notice, which has no off switch at any level " +
    "(src/exec/egress.ts). Capped at 2 by its type: see ReachLevel.",
  operate:
    "nothing yet — no browser is wired to a turn (E17 S17.7–S17.8). The level is recorded, " +
    "shown, and read by operateLevel(), which is what the browser layer will ask. It is " +
    "min(operate, reach), so reach is the door here too.",
});

/** Who set a level, and when. Both null until somebody sets one. */
export interface DialProvenance {
  /**
   * The name as this machine's git configuration already records it, or the
   * login name when git has none.
   *
   * Not new information and deliberately not a new channel: every commit in an
   * agent's repository already carries it. Recorded because AC4 asks who set a
   * level 3 and when, and an answer nobody can attribute is not an answer.
   */
  readonly setBy: string | null;
  /** ISO 8601, UTC. */
  readonly setAt: string | null;
}

/** The dial itself: four numbers and the provenance of the last change. */
export interface Dial extends DialProvenance {
  readonly read: Level;
  readonly write: Level;
  readonly run: Level;
  readonly reach: ReachLevel;
  /** D-153 — the browser. 0 for every agent until somebody raises it. */
  readonly operate: Level;
}

/**
 * AC3 — every category at 1, and nothing starts at 3.
 *
 * Also, per the measurement at the top of this file, *exactly what Mind does
 * today*: every vendor already gets its read-only flag on every turn. A tree
 * with no `autonomy.md` in it behaves the same before and after this story, and
 * that is a property worth having rather than a coincidence — it is what makes
 * "no file" a safe answer instead of a missing one.
 */
export const DEFAULT_DIAL: Dial = Object.freeze({
  read: 1,
  write: 1,
  run: 1,
  reach: 1,
  // D-153: no browser until somebody says so. The other four reproduce what
  // Mind did before the dial; this one has no "before" to reproduce.
  operate: 0,
  setBy: null,
  setAt: null,
} as const);

/**
 * Every category at 0 — what a broken file, a ceiling of 0, or a stop flag
 * produces.
 *
 * Not `DEFAULT_DIAL`. A file Mind cannot parse means Mind does not know what
 * the owner intended, and falling back to "the usual" answers a question nobody
 * asked. The safest reading of an unreadable instruction is to do nothing.
 */
export const SILENT_DIAL: Dial = Object.freeze({
  read: 0,
  write: 0,
  run: 0,
  reach: 0,
  operate: 0,
  setBy: null,
  setAt: null,
} as const);

/** True for `0`, `1`, `2`, `3` and nothing else. Narrows, so callers need no cast. */
export function isLevel(value: unknown): value is Level {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

/** True for `0`, `1`, `2`. `3` is deliberately not a reach level — see {@link ReachLevel}. */
export function isReachLevel(value: unknown): value is ReachLevel {
  return value === 0 || value === 1 || value === 2;
}

/**
 * One level per category, read without widening.
 *
 * A `Record<Category, Level>` would type `reach` as `Level` and lose the cap the
 * moment anything iterated the categories, which is what every printer does.
 */
export function levelOf(dial: Dial, category: Category): Level {
  switch (category) {
    case "read":
      return dial.read;
    case "write":
      return dial.write;
    case "run":
      return dial.run;
    case "reach":
      return dial.reach;
    case "operate":
      return dial.operate;
  }
}

/**
 * The one level a turn is actually run at: `min(write, run, reach)`.
 *
 * `read` is **not** in the minimum, and leaving it out is the honest choice
 * rather than an oversight: there is no mechanism behind it (see
 * {@link CATEGORY_ENFORCEMENT}), so including it would let a number that
 * controls nothing veto turns — a control surface that works in one direction
 * only is worse than one that is labelled as absent.
 *
 * Why a minimum rather than a maximum is the long argument at the top of this
 * file. The short version: a maximum lets `write` raise `reach` past the cap its
 * own type declares.
 */
export function actLevel(dial: Dial): Level {
  return Math.min(dial.write, dial.run, dial.reach) as Level;
}

/**
 * The categories holding a turn at {@link actLevel}, or none when write, run
 * and reach agree (S5.1 AC2 as rewritten by D-052).
 *
 * The categories are set apart and take effect together: one shell both
 * writes files and reaches out (measured, D-047), so no vendor flag can grant
 * one without the other. What a person can still be told is which of their
 * settings is the one in force — otherwise a `write = 3` that does nothing
 * reads as a setting Mind ignored.
 */
export function heldBy(dial: Dial): readonly Category[] {
  const act = actLevel(dial);
  if (ACTING.every((category) => dial[category] === act)) return [];
  return ACTING.filter((category) => dial[category] === act);
}

/**
 * The level the browser runs at (D-153): `min(operate, reach)`, with level 3
 * read the way D-047 reads it for files.
 *
 * `reach` can never be 3 ({@link ReachLevel}, I-6), so a bare minimum could
 * never reach 3 either, and "any origin" would be a level nobody could set.
 * The answer is the one `restrain()` already gives for `unfenced`: level 3 is
 * in force when `operate` itself is 3 — which {@link import("./effective.ts")
 * .effectiveDial} only lets stand once it was confirmed at a terminal on this
 * machine (D-042) — and `reach` is at its top. Below that, it is the minimum.
 *
 * Give it the **effective** dial, never the stored one: the confirmation, the
 * ceiling and the brake are applied there.
 */
export function operateLevel(dial: Dial): Level {
  const floor = Math.min(dial.operate, dial.reach) as Level;
  return floor === 2 && dial.operate === 3 ? 3 : floor;
}

/**
 * Render a dial as the file that produced it.
 *
 * `+++` TOML frontmatter over Markdown, the same shape a soul uses, for three
 * reasons that are all about the reader rather than the parser: `git diff` shows
 * a level change as one line; the body is a place to write down *why* a level
 * was raised, which is the part a reader six months later needs and no schema
 * can hold; and Mind already has one frontmatter parser, so this is not a
 * second format to keep honest.
 */
export function serializeDial(dial: Dial, body = ""): string {
  const lines = [
    "+++",
    `schema = "${AUTONOMY_SCHEMA}"`,
    "",
    `read = ${dial.read}`,
    `write = ${dial.write}`,
    `run = ${dial.run}`,
    `reach = ${dial.reach}`,
    `operate = ${dial.operate}`,
  ];
  if (dial.setBy !== null) lines.push("", `set_by = ${JSON.stringify(dial.setBy)}`);
  if (dial.setAt !== null) {
    if (dial.setBy === null) lines.push("");
    lines.push(`set_at = ${JSON.stringify(dial.setAt)}`);
  }
  lines.push("+++", "");
  const text = lines.join("\n");
  return body === "" ? `${text}\n` : `${text}\n${body.replace(/\n*$/, "\n")}`;
}

/** An optional string field, or an issue explaining why it was refused. */
function readOptionalString(
  table: Record<string, unknown>,
  key: string,
  file: string,
  line: number,
  issues: SoulIssue[],
): string | null {
  const raw = table[key];
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw === "") {
    issues.push({ file, line, path: key, message: `${key} must be a non-empty string` });
    return null;
  }
  return raw;
}

/**
 * Read a dial out of `autonomy.md`, or every reason it was refused.
 *
 * Refuses rather than repairs, in every case. A file with `write = 4` in it is
 * not a file that meant 3: somebody wrote a number this program does not have,
 * and the two readings — "they meant the maximum" and "they meant something
 * this version does not support" — differ by exactly the amount of autonomy
 * being handed over. The caller turns a refusal into {@link SILENT_DIAL}; this
 * function never guesses.
 *
 * Every missing category is an issue too. A file that names `write` and forgets
 * `reach` would otherwise inherit a default for the one category I-6 protects,
 * from a file whose whole purpose is to say what the defaults should be.
 */
export function parseDial(file: string, text: string): Validated<Dial> {
  const parsed = parseFrontmatter(file, text);
  if (!parsed.ok) return parsed;

  const { table } = parsed.value.doc;
  const lineOf = (key: string): number => parsed.value.doc.lines.get(key) ?? parsed.value.openLine;
  const issues: SoulIssue[] = [];

  const schema = table["schema"];
  // A file from before `operate` (D-153) is read, with no browser. See AUTONOMY_SCHEMA.
  const v1 = schema === AUTONOMY_SCHEMA_V1;
  if (!v1 && schema !== AUTONOMY_SCHEMA) {
    issues.push({
      file,
      line: lineOf("schema"),
      path: "schema",
      message: `schema must be ${JSON.stringify(AUTONOMY_SCHEMA)}, not ${JSON.stringify(schema)}`,
    });
  }

  const levels: Partial<Record<Category, number>> = {};
  for (const category of CATEGORIES) {
    const raw = table[category];
    if (v1 && category === "operate") {
      if (raw !== undefined) {
        issues.push({
          file,
          line: lineOf(category),
          path: category,
          message:
            `operate is not a key of ${AUTONOMY_SCHEMA_V1}. A file that names it says ` +
            `schema = ${JSON.stringify(AUTONOMY_SCHEMA)}, so it is plain which reading was meant.`,
        });
        continue;
      }
      levels.operate = 0;
      continue;
    }
    if (raw === undefined) {
      issues.push({
        file,
        line: parsed.value.openLine,
        path: category,
        message:
          `${category} is missing. Every category is written down, because a file that names ` +
          `some of them and lets the rest default is a file that decides the categories it ` +
          `does not mention.`,
      });
      continue;
    }
    if (category === "reach") {
      if (!isReachLevel(raw)) {
        issues.push({
          file,
          line: lineOf(category),
          path: category,
          message:
            `reach must be 0, 1 or 2 — never 3. Outward contact is capped in code (I-6, S8.3 ` +
            `AC2): level 3 would mean "contact whoever, report nothing", which is the one ` +
            `setting this project says may not exist. Got ${JSON.stringify(raw)}.`,
        });
        continue;
      }
    } else if (!isLevel(raw)) {
      issues.push({
        file,
        line: lineOf(category),
        path: category,
        message: `${category} must be 0, 1, 2 or 3. Got ${JSON.stringify(raw)}.`,
      });
      continue;
    }
    levels[category] = raw as number;
  }

  const setBy = readOptionalString(table, "set_by", file, lineOf("set_by"), issues);
  const setAt = readOptionalString(table, "set_at", file, lineOf("set_at"), issues);

  const known = new Set<string>([...CATEGORIES, "schema", "set_by", "set_at"]);
  for (const key of Object.keys(table)) {
    if (known.has(key)) continue;
    issues.push({
      file,
      line: lineOf(key),
      path: key,
      message:
        `${key} is not a key of ${AUTONOMY_SCHEMA}. An unknown key in this file is a setting ` +
        `somebody believes is in force and that nothing reads.`,
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      read: levels.read as Level,
      write: levels.write as Level,
      run: levels.run as Level,
      reach: levels.reach as ReachLevel,
      operate: levels.operate as Level,
      setBy,
      setAt,
    },
  };
}
