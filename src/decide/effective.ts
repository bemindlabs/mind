/**
 * One rule, applied to every source: **a source may lower a level, never raise one.**
 *
 * ```
 * effective(category) = min( the file , the environment ceiling , the stop flag )
 * ```
 *
 * There is no source in this program that can raise a level, and the absence is
 * the design rather than a gap. The argument is the one `src/exec/egress.ts`
 * already makes about its own missing off-switch — *"Who may switch it off.
 * Nobody."* — and it applies here with one extra turn of the screw: Mind runs
 * agents, and an agent runs as the owner. A variable that could raise autonomy
 * is a variable the thing being restrained can export for itself, one
 * subprocess before it starts the next `mind`. Lowering has no such problem: an
 * agent that sets its own ceiling to 0 has only stopped itself.
 *
 * ## The environment variable is a **ceiling**, and is read as an exact string
 *
 * `MIND_AUTONOMY_MAX` accepts `"0"`, `"1"`, `"2"` and `"3"`, compared with
 * `===`. Everything else — an empty string, `"3 "`, `"03"`, `"three"`, `"4"`,
 * `"-1"` — clamps every category to **0** and says so on the way past.
 *
 * `Number()` and `parseInt` are both deliberately absent. `parseInt("3abc")` is
 * 3, `Number("")` is 0, `Number(" 3 ")` is 3, and `Number("0x3")` is 3: four
 * different ways for text nobody meant as a number to become a number that
 * loosens something. Comparing strings has none of those readings.
 *
 * ## Nothing is clamped in silence
 *
 * Every reduction this file performs comes back as a {@link Clamp} carrying the
 * number that was set, the number that takes effect, and why they differ — and
 * `mind autonomy set` prints them **at the moment of setting**, not on the day
 * a turn behaves unexpectedly. Two kinds of lie were available to a dial and
 * this closes the second: a setting that has no effect because nothing reads it,
 * and a setting that has no effect because arithmetic elsewhere reduced it. The
 * second is the one {@link import("./autonomy.ts").actLevel}'s minimum
 * introduces, so it is this file's job to say so out loud.
 */

import {
  ACTING,
  CATEGORIES,
  DEFAULT_DIAL,
  SILENT_DIAL,
  actLevel,
  levelOf,
  operateLevel,
  type Category,
  type Dial,
  type Level,
  type ReachLevel,
} from "./autonomy.ts";

/** The variable that may lower every category, and may raise none. */
export const AUTONOMY_MAX_ENV = "MIND_AUTONOMY_MAX";

/** The only four values {@link AUTONOMY_MAX_ENV} accepts, compared with `===`. */
export const AUTONOMY_MAX_VALUES: readonly string[] = ["0", "1", "2", "3"];

/** Where the stored dial came from. `file-unreadable` is not a kind of default. */
export type DialSource =
  /** No `autonomy.md`, so AC3's every-category-1 — which is today's behaviour. */
  | "default"
  /** A file that parsed. */
  | "file"
  /** A file that did not parse. Produces silence, never the default. */
  | "file-unreadable";

/** One reduction, with both numbers and the reason, so nothing is lost quietly. */
export interface Clamp {
  /** `null` when the reduction applies to every category at once. */
  readonly category: Category | null;
  readonly set: Level;
  readonly effective: Level;
  readonly why: string;
}

/** The dial as stored, the dial as it applies, and every step between. */
export interface EffectiveDial {
  /** What the file said, or the default when there was none. */
  readonly stored: Dial;
  readonly source: DialSource;
  /** After every ceiling. This is what a turn is judged against. */
  readonly dial: Dial;
  /** `min(write, run, reach)` of {@link dial} — the level a turn actually runs at. */
  readonly act: Level;
  /** {@link operateLevel} of {@link dial} — the level the browser runs at (D-153). */
  readonly operate: Level;
  /** The environment ceiling in force, or `null` when the variable is unset. */
  readonly ceiling: Level | null;
  readonly stopped: boolean;
  readonly clamps: readonly Clamp[];
  /** Lines a person should read, in the order they should read them. */
  readonly notes: readonly string[];
}

/** What {@link effectiveDial} is told, with nothing read from ambient state. */
export interface EffectiveInput {
  readonly stored: Dial;
  readonly source: DialSource;
  /** The raw value of {@link AUTONOMY_MAX_ENV}, or `undefined` when unset. */
  readonly envValue: string | undefined;
  /** Whether {@link import("./stop.ts").isStopped} said so. */
  readonly stopped: boolean;
  /**
   * Categories a person confirmed at 3 on this machine (D-042). A 3 the file
   * holds for a category not listed here is held at 2. Absent means none —
   * the safe direction for a caller that forgot to ask.
   */
  readonly confirmedThree?: readonly Category[];
}

/** The ceiling the environment imposes, and the sentence that goes with it. */
function ceilingFrom(raw: string | undefined): { ceiling: Level | null; note?: string } {
  if (raw === undefined) return { ceiling: null };

  const index = AUTONOMY_MAX_VALUES.indexOf(raw);
  if (index === -1) {
    return {
      ceiling: 0,
      note:
        `${AUTONOMY_MAX_ENV} is set to ${JSON.stringify(raw)}, which is not one of ` +
        `${AUTONOMY_MAX_VALUES.map((value) => JSON.stringify(value)).join(", ")}. Every ` +
        `category is held at 0. The value is compared as text rather than converted, because ` +
        `every conversion available reads something nobody meant as a number as a number that ` +
        `loosens: parseInt("3abc") is 3, Number("") is 0, Number("0x3") is 3. A ceiling that ` +
        `can be reached by accident is not a ceiling.`,
    };
  }
  return {
    ceiling: index as Level,
    note: `${AUTONOMY_MAX_ENV}=${raw} caps every category at ${index}. It can lower a level and never raise one.`,
  };
}

/** `min` over a level and an optional ceiling, keeping the literal type. */
function capped(level: Level, ceiling: Level | null): Level {
  return ceiling === null ? level : (Math.min(level, ceiling) as Level);
}

/**
 * Work out what is actually in force, and account for every reduction.
 *
 * Pure: every input arrives as an argument, so a test can pose any combination
 * of file, environment and brake without a filesystem or a `process.env` — the
 * same reason `src/state.ts` takes its home and environment rather than reading
 * them.
 */
export function effectiveDial(input: EffectiveInput): EffectiveDial {
  const notes: string[] = [];
  const clamps: Clamp[] = [];

  // A file that did not parse is not a file that meant the default. Mind does
  // not know what was intended, so it does the only thing that cannot be wrong.
  const stored = input.source === "file-unreadable" ? SILENT_DIAL : input.stored;
  if (input.source === "file-unreadable") {
    notes.push(
      "the dial file could not be read, so every category is 0 and no turn will run. This is " +
        "deliberately not a fall back to the default: a file that cannot be parsed means Mind " +
        "does not know what was intended, and `carry on as usual` is an answer to a question " +
        "nobody asked. Fix the file, or delete it to get the defaults back.",
    );
    for (const category of CATEGORIES) {
      const was = levelOf(input.stored, category);
      if (was !== 0) {
        clamps.push({
          category,
          set: was,
          effective: 0,
          why: "the dial file could not be parsed",
        });
      }
    }
  } else if (input.source === "default") {
    notes.push(
      "there is no autonomy.md, so every category is 1 (AC3). That is not a weaker setting " +
        "waiting to be raised — it is what Mind already did before this dial existed: every " +
        "vendor's read-only flag was on every turn, unconditionally.",
    );
  }

  const { ceiling, note } = ceilingFrom(input.envValue);
  if (note !== undefined) notes.push(note);

  const stopCeiling: Level | null = input.stopped ? 0 : null;
  if (input.stopped) {
    notes.push(
      "the stop flag is set, so every category is 0 and no turn will run. Clear it with " +
        "`mind autonomy resume`, which asks for a phrase at a terminal — or by deleting the " +
        "file, which Mind cannot and does not try to prevent.",
    );
  }

  const lowest = (level: Level): Level => capped(capped(level, ceiling), stopCeiling);

  // D-042 — a 3 nobody confirmed at a terminal on this machine is a 2.
  const confirmed = input.confirmedThree ?? [];
  const unconfirmed = new Set<Category>();
  const vouched = (category: Category, level: Level): Level => {
    if (level !== 3 || confirmed.includes(category)) return level;
    unconfirmed.add(category);
    return 2;
  };

  const dial: Dial = {
    read: lowest(vouched("read", stored.read)),
    write: lowest(vouched("write", stored.write)),
    run: lowest(vouched("run", stored.run)),
    reach: Math.min(lowest(stored.reach), 2) as ReachLevel,
    operate: lowest(vouched("operate", stored.operate)),
    setBy: stored.setBy,
    setAt: stored.setAt,
  };

  for (const category of CATEGORIES) {
    const set = levelOf(stored, category);
    const effective = levelOf(dial, category);
    if (set === effective) continue;
    if (clamps.some((clamp) => clamp.category === category)) continue;
    clamps.push({
      category,
      set,
      effective,
      why:
        input.stopped && effective === 0
          ? "the stop flag is set"
          : unconfirmed.has(category) && effective === 2
            ? "level 3 was never confirmed at a terminal on this machine — the file says 3, " +
              "and a file can be edited by hand or by an agent acting at 2. `mind autonomy " +
              "set` asks for the phrase and records it outside git (D-042)"
            : `${AUTONOMY_MAX_ENV} caps it at ${ceiling}`,
    });
  }

  // The clamp the *minimum* introduces: a category set above the acting level
  // is a number somebody chose that changes nothing. Said here, so `set` can
  // say it at the moment of setting rather than a person discovering it later.
  const act = actLevel(dial);
  const holding = ACTING.filter((category) => levelOf(dial, category) === act);
  for (const category of ACTING) {
    const level = levelOf(dial, category);
    if (level <= act) continue;
    clamps.push({
      category,
      set: level,
      effective: act,
      why:
        `a turn runs at min(write, run, reach) = ${act}, held there by ` +
        `${holding.join(" and ")}. Raising this category alone changes nothing until the ` +
        `others come up with it — the minimum is what keeps reach from being raised by ` +
        `arithmetic somewhere else (I-6, S8.3 AC2).`,
    });
  }

  // D-153 — the browser runs at min(operate, reach), so an operate above reach
  // is the same kind of number: chosen, and changing nothing. Level 3 stands
  // when reach is at its top (2) — see operateLevel.
  const operate = operateLevel(dial);
  if (dial.operate > operate) {
    clamps.push({
      category: "operate",
      set: dial.operate,
      effective: operate,
      why:
        `the browser runs at min(operate, reach) = ${operate}, held there by reach. ` +
        `Raise reach with it, or this number changes nothing (D-153).`,
    });
  }

  return {
    stored,
    source: input.source,
    dial,
    act,
    operate,
    ceiling,
    stopped: input.stopped,
    clamps,
    notes,
  };
}

/** The dial a machine with no file, no ceiling and no brake is running under. */
export function defaultEffective(): EffectiveDial {
  return effectiveDial({
    stored: DEFAULT_DIAL,
    source: "default",
    envValue: undefined,
    stopped: false,
  });
}

/**
 * A step of a task with a browser acts through the browser only (review of PR #24, finding 1): write and run
 * are held at 1 — the vendor's read-only flag goes on, claude gets no shell, no file tools and no web fetch —
 * while reach and operate keep their levels, so the browser keeps the level the dial gives it.
 *
 * Why: a step that can run a command could answer its own task's approval (`task approve`, the web API with
 * the page's key, or a release file signed with the task's key — all reachable by the owner's uid). With no
 * shell it has no way to any of them. Lower only: a dial already below 1 stays where it is.
 */
export function browserOnly(effective: EffectiveDial): EffectiveDial {
  const write = Math.min(effective.dial.write, 1) as Level;
  const run = Math.min(effective.dial.run, 1) as Level;
  if (write === effective.dial.write && run === effective.dial.run) return effective;
  const dial: Dial = { ...effective.dial, write, run };
  const why = "a step of a task with a browser acts through the browser only: no shell, no file writes (review of PR #24)";
  const clamps: Clamp[] = [...effective.clamps];
  if (write !== effective.dial.write) clamps.push({ category: "write", set: effective.dial.write, effective: write, why });
  if (run !== effective.dial.run) clamps.push({ category: "run", set: effective.dial.run, effective: run, why });
  return { ...effective, dial, act: actLevel(dial), clamps, notes: [...effective.notes, why] };
}
