/**
 * S3.3 — what the owner does as a routine, mined from what they did (D-057).
 *
 * The third file allowed to open a `Personal` box, and the only one in the
 * observer layer. Everything else here reads capture through `countPersonal`,
 * which counts over words chosen in advance; a pattern needs the project, the
 * order of events and the time of day, which no closed vocabulary holds.
 *
 * So the box is opened in {@link printPatterns} and nowhere else, and what
 * comes out goes to the writer the caller hands in — the terminal. Nothing is
 * stored (a pattern is recomputed on every run, so there is nothing new for
 * `erase` to find), and nothing reaches a turn, recall or git: only
 * `bin/commands/observe.ts` imports this file, and a test says so.
 *
 * The mining itself ({@link minePatterns}) is a pure function over plain
 * records, so it can be tested with records nobody lived.
 */

import type { CaptureRecord } from "./record.ts";
import { unwrapPersonal, type Personal } from "../types.ts";

/** AC2 and AC3's thresholds, in one place so the output can print them. */
export const PATTERN_RULES = Object.freeze({
  routineMinDays: 3,
  timeWindowHours: 2,
  timeWindowShare: 0.6,
  sequenceWithinMinutes: 10,
  sequenceMinCount: 5,
  sequenceMinDays: 2,
  sequenceMinConfidence: 0.6,
});

/** A time zone and an offset, so a test can pose any clock. */
export interface Clock {
  readonly zone: string;
  /** Local calendar day and hour of an instant. */
  readonly local: (at: Date) => { readonly day: string; readonly hour: number; readonly weekday: number };
}

/** The machine's own clock, through `Intl` rather than `TZ` parsing. */
export function systemClock(zone = Intl.DateTimeFormat().resolvedOptions().timeZone): Clock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    zone,
    local: (at) => {
      const got = Object.fromEntries(parts.formatToParts(at).map((p) => [p.type, p.value]));
      return {
        day: `${got["year"]}-${got["month"]}-${got["day"]}`,
        hour: Number(got["hour"]),
        weekday: WEEKDAYS.indexOf(got["weekday"] ?? ""),
      };
    },
  };
}

/**
 * Commands that move around or look, rather than do. A routine of `cd` or
 * `cat` says how a shell is driven, not what the owner works on — and on the
 * first real run these were every sequence found (`rtk read → cd`, 28 times).
 */
export const PLUMBING: readonly string[] = [
  "cd", "ls", "pwd", "cat", "head", "tail", "less", "more", "echo", "printf", "grep", "rg", "find", "fd",
  "sed", "awk", "wc", "sort", "uniq", "cut", "tr", "which", "type", "file", "stat", "du", "df", "sleep",
  "true", "false", "test", "[", "date", "env", "export", "source", ".", "set", "clear", "read", "xargs", "tee",
];

/** Proxies that run the command after them; the pattern is about that command. */
const WRAPPERS: readonly string[] = ["rtk", "sudo", "time", "nohup", "timeout"];

/** What an action is called in a pattern: the command as kept, or where the edit was. */
export function labelOf(record: CaptureRecord): string | undefined {
  if (record.kind === "command") {
    // The target keeps at most two words (`commandTarget`), so after a wrapper
    // only the program is left — `rtk git status` was kept as `rtk git`.
    const words = record.target.split(" ").filter((word) => word !== "");
    const rest = words[0] !== undefined && WRAPPERS.includes(words[0]) ? words.slice(1) : words;
    if (rest.length === 0 || rest[0] === "read" || PLUMBING.includes(rest[0]!)) return undefined;
    return rest.join(" ");
  }
  if (record.kind === "file-edit") {
    const first = record.target.split("/").find((part) => part !== "" && part !== ".");
    return first === undefined ? undefined : `edit ${first}`;
  }
  return undefined;
}

/**
 * AC1 — what the owner set going: everything in their subject except what
 * carries evidence of being somebody else's. `unknown` is counted because
 * claude 2.1.280 sends no author field at all (notes/2026-09-23_no-source-field.md),
 * so a rule that waited for `owner-prompted` would mine nothing — measured on
 * 2026-09-24: 0 such records among 2,026. The fleet is kept out one level up,
 * by subject (D-036); `unattended` and `subagent` are the two labels that say
 * "not the owner", and they stay out here.
 */
export function isOwnersAction(record: CaptureRecord): boolean {
  if (record.origin === "unattended" || record.origin === "subagent") return false;
  return record.kind === "command" || record.kind === "file-edit";
}

export interface Routine {
  readonly kind: "routine";
  readonly project: string;
  readonly label: string;
  readonly count: number;
  readonly days: number;
  /** Days anything the owner did happened in this project — the denominator for `days`. */
  readonly activeDays: number;
  readonly first: string;
  readonly last: string;
  /** Start hour of the 2-hour window, when AC2's share is met; otherwise `null`. */
  readonly windowStart: number | null;
  readonly windowShare: number;
  readonly weekdaysOnly: boolean;
}

export interface Sequence {
  readonly kind: "sequence";
  readonly project: string;
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly days: number;
  readonly confidence: number;
  readonly first: string;
  readonly last: string;
}

export interface Patterns {
  readonly zone: string;
  readonly considered: number;
  readonly routines: readonly Routine[];
  readonly sequences: readonly Sequence[];
}

/** Mine routines and sequences. Pure: plain records in, plain patterns out. */
export function minePatterns(records: readonly CaptureRecord[], clock: Clock): Patterns {
  const mine = records
    .filter(isOwnersAction)
    .map((record) => ({ record, label: labelOf(record), at: new Date(record.at) }))
    .filter((e): e is { record: CaptureRecord; label: string; at: Date } => e.label !== undefined && !Number.isNaN(e.at.getTime()))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  // --- routines (AC2) ------------------------------------------------------
  const activeDays = new Map<string, Set<string>>();
  const groups = new Map<string, { project: string; label: string; count: number; firstHourByDay: Map<string, number>; weekdays: Set<number>; first: string; last: string }>();
  for (const e of mine) {
    const local = clock.local(e.at);
    const project = e.record.project;
    (activeDays.get(project) ?? activeDays.set(project, new Set()).get(project)!).add(local.day);
    const key = `${project}\u0000${e.label}`;
    const group = groups.get(key) ?? { project, label: e.label, count: 0, firstHourByDay: new Map(), weekdays: new Set(), first: local.day, last: local.day };
    group.count += 1;
    if (!group.firstHourByDay.has(local.day)) group.firstHourByDay.set(local.day, local.hour);
    group.weekdays.add(local.weekday);
    group.last = local.day;
    groups.set(key, group);
  }
  const routines: Routine[] = [];
  for (const g of groups.values()) {
    const days = g.firstHourByDay.size;
    if (days < PATTERN_RULES.routineMinDays) continue;
    let best = { start: 0, share: 0 };
    for (let start = 0; start < 24; start++) {
      let inside = 0;
      for (const hour of g.firstHourByDay.values()) {
        if ((hour - start + 24) % 24 < PATTERN_RULES.timeWindowHours) inside += 1;
      }
      const share = inside / days;
      if (share > best.share) best = { start, share };
    }
    routines.push({
      kind: "routine",
      project: g.project,
      label: g.label,
      count: g.count,
      days,
      activeDays: activeDays.get(g.project)?.size ?? days,
      first: g.first,
      last: g.last,
      windowStart: best.share >= PATTERN_RULES.timeWindowShare ? best.start : null,
      windowShare: best.share,
      weekdaysOnly: [...g.weekdays].every((d) => d >= 1 && d <= 5),
    });
  }
  routines.sort((a, b) => b.days - a.days || b.count - a.count || a.label.localeCompare(b.label));

  // --- sequences (AC3) -----------------------------------------------------
  const bySession = new Map<string, typeof mine>();
  for (const e of mine) {
    const key = `${e.record.vendor}\u0000${e.record.session}`;
    (bySession.get(key) ?? bySession.set(key, []).get(key)!).push(e);
  }
  const fromCount = new Map<string, number>();
  const pairs = new Map<string, { project: string; from: string; to: string; count: number; days: Set<string>; first: string; last: string }>();
  const within = PATTERN_RULES.sequenceWithinMinutes * 60_000;
  for (const events of bySession.values()) {
    for (let i = 0; i < events.length; i++) {
      const a = events[i]!;
      const fromKey = `${a.record.project}\u0000${a.label}`;
      fromCount.set(fromKey, (fromCount.get(fromKey) ?? 0) + 1);
      const b = events[i + 1];
      if (b === undefined || b.label === a.label || b.record.project !== a.record.project) continue;
      if (b.at.getTime() - a.at.getTime() > within) continue;
      const key = `${fromKey}\u0000${b.label}`;
      const day = clock.local(a.at).day;
      const pair = pairs.get(key) ?? { project: a.record.project, from: a.label, to: b.label, count: 0, days: new Set(), first: day, last: day };
      pair.count += 1;
      pair.days.add(day);
      pair.last = day;
      pairs.set(key, pair);
    }
  }
  const sequences: Sequence[] = [];
  for (const [key, p] of pairs) {
    const total = fromCount.get(key.slice(0, key.lastIndexOf("\u0000"))) ?? p.count;
    const confidence = p.count / total;
    if (p.count < PATTERN_RULES.sequenceMinCount || p.days.size < PATTERN_RULES.sequenceMinDays) continue;
    if (confidence < PATTERN_RULES.sequenceMinConfidence) continue;
    sequences.push({ kind: "sequence", project: p.project, from: p.from, to: p.to, count: p.count, days: p.days.size, confidence, first: p.first, last: p.last });
  }
  sequences.sort((a, b) => b.count - a.count || b.confidence - a.confidence || a.from.localeCompare(b.from));

  return { zone: clock.zone, considered: mine.length, routines, sequences };
}

const pad = (hour: number) => String(hour).padStart(2, "0");

/** `/home/x/y` → `~/y`, so a line is readable. */
function short(project: string, home: string): string {
  return home !== "" && (project === home || project.startsWith(`${home}/`)) ? `~${project.slice(home.length)}` : project;
}

/** A trigger id from a label and a project, for AC5's snippet. */
export function triggerIdFor(routine: Routine): string {
  const tail = routine.project.split("/").filter((part) => part !== "").pop() ?? "project";
  return `${routine.label}-${tail}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "routine";
}

/** The patterns as lines a person reads. Pure. */
export function formatPatterns(patterns: Patterns, options: { readonly home: string; readonly limit: number }): readonly string[] {
  const lines: string[] = [];
  const r = PATTERN_RULES;
  lines.push(`from ${patterns.considered} command(s) and file edit(s) in this subject, leaving out those marked unattended or subagent (times in ${patterns.zone})`);
  lines.push("");
  lines.push(`routines — the same action in the same project on ${r.routineMinDays}+ different days`);
  const routines = patterns.routines.slice(0, options.limit);
  if (routines.length === 0) lines.push("  none yet");
  for (const [i, x] of routines.entries()) {
    const when =
      x.windowStart === null
        ? "no regular time"
        : `usually ${pad(x.windowStart)}:00–${pad((x.windowStart + r.timeWindowHours) % 24)}:00 (${Math.round(x.windowShare * 100)}% of those days)`;
    lines.push(
      `  ${i + 1}. ${x.label}  in ${short(x.project, options.home)} — ${x.days} of ${x.activeDays} active day(s), ` +
        `${x.count} time(s), ${x.first} → ${x.last} · ${when}${x.weekdaysOnly ? " · weekdays only" : ""}`,
    );
  }
  lines.push("");
  lines.push(
    `sequences — B within ${r.sequenceWithinMinutes} min of A in one session, ${r.sequenceMinCount}+ times on ` +
      `${r.sequenceMinDays}+ days, and B follows A at least ${Math.round(r.sequenceMinConfidence * 100)}% of the time`,
  );
  const sequences = patterns.sequences.slice(0, options.limit);
  if (sequences.length === 0) lines.push("  none yet");
  for (const [i, x] of sequences.entries()) {
    lines.push(
      `  ${i + 1}. ${x.from} → ${x.to}  in ${short(x.project, options.home)} — ${x.count} time(s) on ${x.days} day(s), ` +
        `${Math.round(x.confidence * 100)}% of the time, ${x.first} → ${x.last}`,
    );
  }

  const timed = routines.filter((x) => x.windowStart !== null);
  if (timed.length > 0) {
    lines.push("");
    lines.push("As triggers (AC5) — copy what you want into triggers.md yourself; each runs as a turn that only proposes:");
    lines.push("");
    for (const x of timed) {
      lines.push(`[${triggerIdFor(x)}]`);
      lines.push(`every = "1d"`);
      lines.push(
        `prompt = ${JSON.stringify(`Around ${pad(x.windowStart!)}:00 the owner usually runs \`${x.label}\` in ${short(x.project, options.home)}. Check whether it is needed today and propose it if so.`)}`,
      );
      lines.push("");
    }
    lines.push("A trigger fires once a day from the first tick; to line it up with the hour, point the timer at it");
    lines.push("(systemd `OnCalendar=*-*-* HH:00`, or the hour field in cron).");
  }
  return lines;
}

/**
 * The one place the box is opened (D-057). The lines go to `write` — the
 * terminal — and nowhere else; nothing is returned but a count.
 */
export function printPatterns(
  records: Personal<readonly CaptureRecord[]>,
  write: (line: string) => void,
  options: { readonly clock: Clock; readonly home: string; readonly limit: number },
): { readonly routines: number; readonly sequences: number } {
  const patterns = minePatterns(unwrapPersonal(records), options.clock);
  for (const line of formatPatterns(patterns, options)) write(line);
  return { routines: patterns.routines.length, sequences: patterns.sequences.length };
}
