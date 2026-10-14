/**
 * What `turn`, `autonomy` and `stop` all need to know about the dial.
 *
 * Here rather than in one of them for the reason `bin/shared.ts` states: three
 * callers in three files. It is a second module beside `shared.ts` rather than
 * more of it, because everything here is about one subject — the autonomy dial —
 * and `shared.ts` is already the file every task has to open.
 *
 * ## What is here and what is not
 *
 * Reading, deciding and writing are here, because every one of them can be
 * called from a test with a temporary directory. **Printing is not**, and the
 * split is the coverage gate's rather than an aesthetic one: this file is under
 * `bin/` and not in `SPAWN_ONLY`, so it is held to the 85% line coverage floor,
 * and a page of report-writing that only ever runs in a spawned process would
 * push it under and earn it an exemption it has not earned. `sayDial` lives in
 * `bin/commands/autonomy.ts`, which is spawn-only and honestly so.
 *
 * ## The sentence this module exists to keep in front of people
 *
 * The dial does not add safety; it is what takes safety off. Every vendor's
 * read-only flag already goes onto every turn, unconditionally, and has since
 * before E5 (`src/exec/registry.ts`). Level 1 — the default, AC3 — is that
 * behaviour exactly. Levels 2 and 3 are the new thing, and what they do is
 * *remove* the flag. A reader who meets something called an autonomy dial will
 * assume the opposite and will be wrong in the expensive direction, so every
 * report built on this module says which way it points.
 */

import { readMind } from "../src/env.ts";
import { chosenLanguage, type Language } from "../src/lang.ts";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  AUTONOMY_FILE,
  AUTONOMY_MAX_ENV,
  DEFAULT_DIAL,
  actLevel,
  confirmationsPath,
  heldBy,
  effectiveDial,
  isStopped,
  levelMeaning,
  operateMeaning,
  parseDial,
  readConfirmations,
  serializeDial,
  stopPath,
  type Category,
  type Dial,
  type DialSource,
  type EffectiveDial,
} from "../src/decide/index.ts";
import { VENDORS, type VendorSpec } from "../src/exec/index.ts";
import type { SoulIssue } from "../src/soul/index.ts";
import type { SubjectId } from "../src/types.ts";
import { runGuarded } from "../src/spawn.ts";

/**
 * Exit code for a turn the dial refused, or the brake stopped.
 *
 * Its own number rather than 1, and the reason is a caller nobody sees: a script
 * that runs turns in a loop reads 1 as "that one failed, try again" and will
 * keep trying against a brake forever. 4 means *this machine has been told not
 * to*, which is a thing a loop can stop for.
 */
export const DIAL_REFUSED = 4;

/** Everything the dial is allowed to know about this machine, in one place. */
export function dialEnv(): { readonly home: string; readonly env: NodeJS.ProcessEnv } {
  return { home: homedir(), env: process.env };
}

/**
 * `<dir>/autonomy.md` — beside `role.md` and `person.md`.
 *
 * With the soul, in git, on purpose. *What this identity may do by itself* is
 * part of who it is, it should travel with a `git clone` the way the rest of the
 * identity does, and `git diff` should show a level change as one line somebody
 * can review. The **brake** is the opposite case and lives outside git entirely
 * — see `src/decide/stop.ts` for why a committed STOP file would be a disaster.
 */
export function dialPath(dir: string): string {
  return join(dir, AUTONOMY_FILE);
}

/** What was on disk, and whether it could be read. */
export interface StoredDial {
  readonly stored: Dial;
  readonly source: DialSource;
  readonly issues: readonly SoulIssue[];
  readonly path: string | null;
}

/**
 * Read `autonomy.md`, if there is one.
 *
 * Three outcomes, and they are deliberately not two: no file is the default
 * (AC3), a file that parses is what it says, and a file that does **not** parse
 * is silence — never the default. See `effectiveDial` for why.
 */
export async function readDial(dir: string | null): Promise<StoredDial> {
  if (dir === null) {
    return { stored: DEFAULT_DIAL, source: "default", issues: [], path: null };
  }
  const path = dialPath(dir);
  const handle = Bun.file(path);
  if (!(await handle.exists())) {
    return { stored: DEFAULT_DIAL, source: "default", issues: [], path };
  }
  const parsed = parseDial(AUTONOMY_FILE, await handle.text());
  if (!parsed.ok) {
    return { stored: DEFAULT_DIAL, source: "file-unreadable", issues: parsed.issues, path };
  }
  return { stored: parsed.value, source: "file", issues: [], path };
}

/** The dial, the ceiling and the brake, resolved together. */
export interface DialVerdict extends StoredDial {
  readonly effective: EffectiveDial;
  readonly stopPath: string;
}

/**
 * Everything a command needs to decide and to explain, in one read.
 *
 * @param env Where the brake and the ceiling are read from. Injected, with the
 *   real machine as the default, for the reason `src/state.ts` gives about its
 *   own arguments: a test that had to reach the operator's real `$HOME` to
 *   exercise this would either be untestable or be testing their machine.
 */
export async function decideDial(
  dir: string | null,
  env: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> } = dialEnv(),
  /** Whose dial. Without it no level-3 confirmation is read, so every 3 is held at 2 (D-042). */
  subject?: SubjectId,
): Promise<DialVerdict> {
  const stored = await readDial(dir);
  const stopped = await isStopped(env);
  const confirmations =
    dir === null || subject === undefined ? {} : await readConfirmations(confirmationsPath(env, dir, subject));
  return {
    ...stored,
    stopPath: stopPath(env),
    effective: effectiveDial({
      stored: stored.stored,
      source: stored.source,
      envValue: readMind(AUTONOMY_MAX_ENV, env.env),
      stopped,
      confirmedThree: Object.keys(confirmations) as Category[],
    }),
  };
}

/**
 * The body `autonomy.md` carries under its frontmatter.
 *
 * English, and the Thai after each level only when Thai is chosen (GL-01, `src/lang.ts`). The file is in git and
 * travels with the agent, so what a person who never chose Thai finds in it is English alone.
 */
export function dialBody(language: Language = "en"): string {
  return (
    "Levels, and what they mean here:\n\n" +
    ([0, 1, 2, 3] as const).map((level) => `- \`${level}\` — ${levelMeaning(level, language)}`).join("\n") +
    "\n\nA turn runs at `min(write, run, reach)`. At 1 it carries the vendor's read-only\n" +
    "flag, which is what Mind has always done; at 2 and above that flag is **not sent**.\n\n" +
    "`operate` is the browser (D-153), and runs at `min(operate, reach)`:\n\n" +
    ([0, 1, 2, 3] as const).map((level) => `- \`${level}\` — ${operateMeaning(level, language)}`).join("\n") +
    "\n\nAt every level it stops for a yes before paying, sending a message or e-mail, deleting,\n" +
    "entering a password or credential, or accepting terms.\n\n" +
    "Write below why a level was changed — nothing reads it, and it is the part a reader\n" +
    "six months from now will need.\n"
  );
}

/**
 * Write the dial back. Returns the path, which every caller prints.
 *
 * @param language The language of the file's body; the one this machine's environment has chosen unless a caller says.
 */
export async function writeDial(dir: string, dial: Dial, language: Language = chosenLanguage(process.env)): Promise<string> {
  const path = dialPath(dir);
  await Bun.write(path, serializeDial(dial, dialBody(language)));
  return path;
}

/**
 * The name to record against a level change (AC4).
 *
 * `git config user.name` first, because that is the name this repository's own
 * commits already carry — so recording it adds no new *kind* of information
 * about anybody. The login name is the fallback, and `unknown` is the answer
 * when neither can be read, rather than a guess dressed as a fact.
 */
export async function whoIsSetting(dir: string): Promise<string> {
  const run = await runGuarded(["git", "config", "--get", "user.name"], { cwd: dir }).catch(
    () => undefined,
  );
  const name = run === undefined || run.code !== 0 ? "" : new TextDecoder().decode(run.stdout).trim();
  if (name !== "") return name;
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/**
 * The vendors that would be refused outright at an acting level of 1.
 *
 * Empty on the real registry since S12.6 (D-120 gave kimi a profile file). The
 * list is still derived rather than dropped: the next vendor that offers
 * nothing lands here by declaring `none`, with no second place to remember.
 */
export function vendorsWithNoMechanism(vendors: readonly VendorSpec[] = VENDORS): readonly string[] {
  return vendors.filter((spec) => spec.readOnly.kind === "none").map((spec) => spec.id);
}

/** The one-line version, for a command whose output is mostly something else. */
export function dialLine(effective: EffectiveDial): string {
  return (
    `autonomy: read ${effective.dial.read} · write ${effective.dial.write} · ` +
    `run ${effective.dial.run} · reach ${effective.dial.reach} → acts at ` +
    `${actLevel(effective.dial)}` +
    heldNote(effective.dial) +
    ` · operate ${effective.dial.operate} → the browser at ${effective.operate}`
  );
}

/**
 * `" (held by run)"`, or nothing when the categories agree. The lowest one
 * decides because one shell both writes and reaches out (D-047, D-052).
 */
export function heldNote(dial: Dial): string {
  const held = heldBy(dial);
  return held.length === 0 ? "" : ` (held by ${held.join(" and ")} — the lowest decides, one shell does all three)`;
}
