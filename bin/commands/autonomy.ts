/**
 * `mind autonomy` — S5.1, and the command that has to say which way it points.
 *
 * Somebody who types `mind autonomy set write 2` is not adding a safeguard.
 * They are taking one off: every vendor's read-only flag has gone onto every
 * turn unconditionally since long before this command existed, and 2 is the
 * level at which Mind stops sending it. Every path through this file says so,
 * out loud, in the output — not in a comment, not in a document — because the
 * name of the command teaches the opposite.
 *
 * Three things are said **at the moment of setting** rather than later, and each
 * of them is a lie the dial could otherwise tell:
 *
 * 1. **The number that will be ignored.** A turn runs at `min(write, run,
 *    reach)`, so `write = 3` with `reach = 1` does nothing at all. That is
 *    printed as a clamp, with both numbers and the reason, by `sayDial`.
 * 2. **The vendor that cannot honour the level.** A vendor that declares no
 *    read-only mechanism is refused at level 1 rather than run hopefully, and the
 *    person setting the level is told while they are setting it. kimi was that
 *    vendor until S12.6 gave it a profile file (D-120); none is today, and the
 *    sentence comes back by itself the day one is declared.
 * 3. **The flag that a `documented` reading rests on.** gemini's read-only claim
 *    comes from its own `--help` and no turn here has watched it hold. That
 *    sentence comes from `readonlyLimits()` — the one `mind backends` already
 *    prints — rather than from a second copy written for this command.
 */

import { isatty } from "node:tty";
import {
  AUTONOMY_FILE,
  AUTONOMY_MAX_ENV,
  CATEGORIES,
  CATEGORY_ENFORCEMENT,
  confirmationsPath,
  disarm,
  isLevel,
  isReachLevel,
  levelMeaning,
  levelOf,
  operateMeaning,
  resumePhrase,
  setConfirmation,
  type Category,
  type Dial,
  type Level,
  type ReachLevel,
} from "../../src/decide/index.ts";
import { PHASE_A_BACKENDS, readonlyLimits, readOnlySummary, VENDORS, type VendorSpec } from "../../src/exec/index.ts";
import { chosenLanguage, type Language } from "../../src/lang.ts";
import { formatIssue } from "../../src/soul/index.ts";
import { subjectId, type SubjectId } from "../../src/types.ts";
import {
  decideDial,
  dialEnv,
  vendorsWithNoMechanism,
  whoIsSetting,
  writeDial,
  type DialVerdict,
} from "../dial.ts";
import { ERR, OUT, parseArgs, readPhrase, usageError, type Sink } from "../shared.ts";

const AUTONOMY_USAGE =
  "usage: mind autonomy show [<dir> --subject <id>]\n" +
  "       mind autonomy set <read|write|run|reach|operate> <0-3> <dir> --subject <id>\n" +
  "       mind autonomy resume";

/**
 * Print what is in force, why, and in which direction it points.
 *
 * Used by `autonomy show`, by `autonomy set` **at the moment of setting**, and
 * by `stop`. One function, so the three cannot drift into three accounts of the
 * same dial — and so the clamps are said where a person can still act on them,
 * which is the whole of the no-silent-clamp rule.
 *
 * The words are English. The Thai that used to follow them is printed only when Thai
 * is chosen (`language`, which is `MIND_LANG` or the locale — `src/lang.ts`, GL-01).
 */
export function sayDial(
  out: Sink,
  verdict: DialVerdict,
  vendors: readonly VendorSpec[] = VENDORS,
  language: Language = chosenLanguage(process.env),
): void {
  const { effective } = verdict;

  out.line(out.bold("What a turn may do, and what took it there:"));
  for (const category of CATEGORIES) {
    const set = levelOf(verdict.stored, category);
    const now = levelOf(effective.dial, category);
    const meaning = category === "operate" ? operateMeaning(now, language) : levelMeaning(now, language);
    out.line(
      `  ${category.padEnd(7)} set ${set}   in force ${now}` +
        `${set === now ? "  " : " ← lowered"}   ${meaning}`,
    );
    out.line(out.dim(`         enforced by: ${CATEGORY_ENFORCEMENT[category]}`));
  }

  out.line("");
  out.line(
    `  a turn runs at min(write, run, reach) = ${effective.act}` +
      (effective.act >= 2
        ? " — the vendor's read-only flag is NOT sent. This is the loosening."
        : effective.act === 0
          ? " — no turn will run at all."
          : " — the vendor's read-only flag is sent, which is what Mind has always done."),
  );
  // Level 3 is not a minimum — reach never passes 2 (I-6) — so it is said as what it is (D-153, as D-047).
  out.line(
    (effective.operate === 3
      ? `  the browser runs at 3 — operate 3, confirmed at a terminal, with reach at its top (2) — `
      : `  the browser runs at min(operate, reach) = ${effective.operate} — `) +
      operateMeaning(effective.operate, language),
  );
  out.line(
    out.dim(
      "  at every level it stops for a yes before paying, sending a message or e-mail, deleting, " +
        "entering a credential, or accepting terms (src/decide/sensitive.ts).",
    ),
  );

  if (effective.clamps.length > 0) {
    out.line("");
    out.line(out.bold("Numbers that do not mean what they say:"));
    for (const clamp of effective.clamps) {
      out.line(
        `  ${(clamp.category ?? "every category").padEnd(7)} set ${clamp.set}, in force ` +
          `${clamp.effective} — ${clamp.why}`,
      );
    }
  }

  for (const note of effective.notes) out.line(out.dim(`  note: ${note}`));

  if (verdict.issues.length > 0) {
    out.line("");
    out.line(out.bold(`${AUTONOMY_FILE} could not be read, so every category is 0:`));
    for (const issue of verdict.issues) out.line(`  ${formatIssue(issue)}`);
  }

  out.line("");
  out.line(out.bold("Per backend, because the dial is only as real as the vendor's flag:"));
  for (const spec of vendors) out.line(`  ${spec.id.padEnd(8)} writes? ${readOnlySummary(spec)}`);
  for (const line of readonlyLimits(vendors)) out.line(out.dim(`  - ${line}`));

  const open = vendorsWithNoMechanism(vendors);
  if (open.length > 0) {
    out.line("");
    out.line(
      out.bold(
        effective.act === 1
          ? `At level 1, a turn that lands on ${open.join(", ")} is REFUSED, not run hopefully.`
          : `${open.join(", ")} has no read-only mechanism at any level.`,
      ),
    );
    out.line(
      out.dim(
        `  There is no flag to send there, so running anyway at level 1 would be the dial ` +
          `saying 1 and meaning 3. You are told here, while you are setting the level, rather ` +
          `than in the middle of a turn that has already started.`,
      ),
    );
    out.line(
      out.dim(
        `  The default chain is ${PHASE_A_BACKENDS.join(" → ")}, which ` +
          `${PHASE_A_BACKENDS.some((id) => open.includes(id)) ? "DOES" : "does not"} include ` +
          `${open.join(", ")}. \`--backend ${open[0]}\` reaches it whatever the chain is.`,
      ),
    );
  }

  out.line("");
  out.line(
    out.dim(
      `  the brake: ${verdict.stopPath} — ${effective.stopped ? "IS SET" : "not set"}. ` +
        `\`touch\` it to stop the next turn from anywhere, with Mind working or not.`,
    ),
  );
  out.line(
    out.dim(
      `  ${AUTONOMY_MAX_ENV}: ${
        effective.ceiling === null ? "unset" : `${effective.ceiling} — a ceiling, never a floor`
      }`,
    ),
  );
  if (verdict.stored.setBy !== null || verdict.stored.setAt !== null) {
    out.line(
      out.dim(
        `  last set by ${verdict.stored.setBy ?? "somebody unrecorded"} at ` +
          `${verdict.stored.setAt ?? "a time unrecorded"} (AC4)`,
      ),
    );
  }
}

/** A `<dir> --subject <id>` pair, or the exit code for the complaint. */
function placeOf(
  positional: readonly string[],
  options: ReadonlyMap<string, string>,
  at: number,
): { readonly ok: true; readonly dir: string; readonly subject: SubjectId } | { readonly ok: false; readonly code: number } {
  const dir = positional[at];
  const subject = options.get("subject");
  if (dir === undefined || subject === undefined || subject === "") {
    return { ok: false, code: usageError(AUTONOMY_USAGE) };
  }
  // The subject is validated and then deliberately not used to find the file:
  // there is no subject→directory registry (I-3), so the directory is the
  // answer and the subject is the claim that has to parse.
  let id: SubjectId;
  try {
    id = subjectId(subject);
  } catch (error) {
    return { ok: false, code: usageError(error instanceof Error ? error.message : String(error)) };
  }
  // Used for one thing only: whose level-3 confirmations to read (D-042).
  return { ok: true, dir, subject: id };
}

async function cmdShow(argv: readonly string[]): Promise<number> {
  const { positional, options } = parseArgs(argv);
  // `show` with no directory is legal and useful: it is how somebody checks the
  // brake and the ceiling on a machine whose agent they have not found yet.
  const dir = positional[0];
  let subject: SubjectId | undefined;
  if (dir !== undefined) {
    const place = placeOf(positional, options, 0);
    if (!place.ok) return place.code;
    subject = place.subject;
  }
  const verdict = await decideDial(dir ?? null, dialEnv(), subject);
  if (dir === undefined) {
    OUT.line(
      OUT.dim(
        `no directory given, so this is the machine's half only: no ${AUTONOMY_FILE} was read ` +
          `and the levels below are the defaults.`,
      ),
    );
  }
  sayDial(OUT, verdict, VENDORS, chosenLanguage(process.env));
  return verdict.effective.act === 0 ? 1 : 0;
}

/** The phrase `set … 3` asks for. Names the category, so it cannot be pasted around. */
function raisePhrase(category: Category, dir: string): string {
  return `let ${category} act on its own in ${dir}`;
}

async function cmdSet(argv: readonly string[]): Promise<number> {
  const language = chosenLanguage(process.env);
  const { positional, options } = parseArgs(argv);
  const category = positional[0];
  const raw = positional[1];
  if (category === undefined || raw === undefined) return usageError(AUTONOMY_USAGE);
  if (!CATEGORIES.includes(category as Category)) {
    return usageError(`unknown category ${JSON.stringify(category)} — ${CATEGORIES.join(", ")}`);
  }
  // Compared as text, exactly as `MIND_AUTONOMY_MAX` is, and for the same
  // reason: `Number("3abc")` and `parseInt` both read things nobody meant as a
  // number as a number that loosens something.
  const level = ["0", "1", "2", "3"].indexOf(raw);
  if (level === -1) return usageError(`a level is 0, 1, 2 or 3 — not ${JSON.stringify(raw)}`);
  if (category === "reach" && !isReachLevel(level)) {
    return usageError(
      "reach may not be 3. Outward contact is capped in code (I-6, S8.3 AC2): level 3 there " +
        "would mean `contact whoever, report nothing`, which is the one setting this project " +
        "says may not exist.",
    );
  }
  if (!isLevel(level)) return usageError(`a level is 0, 1, 2 or 3 — not ${JSON.stringify(raw)}`);

  const place = placeOf(positional, options, 2);
  if (!place.ok) return place.code;
  const dir = place.dir;

  const before = await decideDial(dir, dialEnv(), place.subject);
  if (before.source === "file-unreadable") {
    ERR.line(`mind: ${before.path} could not be read, so Mind will not write over it:`);
    for (const issue of before.issues) ERR.line(`  ${formatIssue(issue)}`);
    ERR.line(
      "Fix it or delete it. Overwriting a file Mind could not understand would throw away " +
        "whatever was intended by whoever wrote it.",
    );
    return 1;
  }

  // Level 3 needs a human at a terminal, and there is deliberately no --yes:
  // a program running as the owner can pass any flag on the owner's behalf,
  // which is exactly the situation the top of the dial is about (AC4).
  if (level === 3) {
    const phrase = raisePhrase(category as Category, dir);
    if (!(process.stdin.isTTY === true && isatty(1))) {
      return usageError(
        `level 3 has to be typed at a terminal. There is deliberately no --yes: an agent ` +
          `running as you could pass one, and level 3 is where you stop being asked. Run it ` +
          `where you can type: ${phrase}`,
      );
    }
    ERR.line(`Setting ${category} to 3 — ${category === "operate" ? operateMeaning(3, language) : levelMeaning(3, language)}.`);
    ERR.line("");
    sayDial(ERR, before, VENDORS, language);
    ERR.line("");
    ERR.line(`To agree, type exactly:  ${phrase}`);
    if ((await readPhrase()) !== phrase) {
      ERR.line(`mind: that was not ${JSON.stringify(phrase)}, so nothing was written.`);
      return 1;
    }
  }

  const next: Dial = {
    ...before.stored,
    ...(category === "reach"
      ? { reach: level as ReachLevel }
      : { [category]: level as Level }),
    setBy: await whoIsSetting(dir),
    setAt: new Date().toISOString(),
  } as Dial;

  const path = await writeDial(dir, next, language);
  // D-042 — the phrase above is what makes a 3 count, and the record of it
  // lives outside git so an edit to the file cannot stand in for it. Any other
  // level withdraws it: a category lowered and raised again by hand is not
  // the one that was confirmed.
  if (category !== "reach") {
    await setConfirmation(
      confirmationsPath(dialEnv(), dir, place.subject),
      category as Category,
      level === 3 ? { by: next.setBy ?? "unknown", at: next.setAt ?? new Date().toISOString() } : null,
    );
  }
  const after = await decideDial(dir, dialEnv(), place.subject);

  const meaning = category === "operate" ? operateMeaning(level as Level, language) : levelMeaning(level as Level, language);
  OUT.line(`${path}: ${category} is now ${level} — ${meaning}`);
  OUT.line(
    `recorded as set by ${next.setBy} at ${next.setAt} (AC4). It is in git: \`git diff\` shows ` +
      `the change and \`git clone\` carries it.`,
  );
  OUT.line("");
  sayDial(OUT, after, VENDORS, language);

  // The no-silent-clamp rule, one more time and in the imperative: if what was
  // just set is not what takes effect, the last line a person reads says so.
  const clamp = after.effective.clamps.find((c) => c.category === category);
  if (clamp !== undefined) {
    OUT.line("");
    OUT.line(
      OUT.bold(
        `You set ${category} to ${clamp.set}. What is in force is ${clamp.effective}. ${clamp.why}`,
      ),
    );
  }
  return 0;
}

/**
 * `mind autonomy resume` — take the brake off, and only with a typed phrase.
 *
 * Setting the brake is `touch`; clearing it is this. The asymmetry is the whole
 * design: stopping must be available to somebody in a hurry on a machine where
 * Mind may not work, and starting again must cost a moment's attention. `rm`
 * still works and Mind says so rather than pretending to own the file.
 */
async function cmdResume(argv: readonly string[]): Promise<number> {
  void argv;
  const env = dialEnv();
  const verdict = await decideDial(null);
  if (!verdict.effective.stopped) {
    OUT.line(`the brake is not set (${verdict.stopPath}). Nothing to do.`);
    return 0;
  }

  const phrase = resumePhrase();
  if (!(process.stdin.isTTY === true && isatty(1))) {
    return usageError(
      `resuming has to be typed at a terminal. There is deliberately no --yes — an agent ` +
        `running as you could pass one, and the brake exists for the case where something ` +
        `running as you is the problem. Run it where you can type: ${phrase}\n` +
        `(\`rm ${verdict.stopPath}\` also works, and Mind will not pretend otherwise.)`,
    );
  }
  ERR.line(`The brake is at ${verdict.stopPath}.`);
  ERR.line(`To take it off, type exactly:  ${phrase}`);
  if ((await readPhrase()) !== phrase) {
    ERR.line(`mind: that was not ${JSON.stringify(phrase)}, so the brake is still on.`);
    return 1;
  }
  const removed = await disarm(env);
  OUT.line(removed ? `brake off — ${verdict.stopPath} removed.` : "the brake was already off.");
  return 0;
}

/** `mind autonomy …` — show, set, resume. */
export async function cmdAutonomy(argv: readonly string[]): Promise<number> {
  const [sub = "", ...rest] = argv;
  switch (sub) {
    case "show":
      return cmdShow(rest);
    case "set":
      return cmdSet(rest);
    case "resume":
      return cmdResume(rest);
    default:
      return usageError(
        sub === ""
          ? AUTONOMY_USAGE
          : `unknown autonomy subcommand ${JSON.stringify(sub)}\n${AUTONOMY_USAGE}`,
      );
  }
}
