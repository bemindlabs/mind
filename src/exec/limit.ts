/**
 * S22.2 (D-197) — reading "the quota is gone" out of what a backend printed.
 *
 * A fallback chain that only knows `failed` tries a vendor whose quota ran out on every turn, spending time
 * on a CLI that cannot answer until a clock says it can. What each vendor prints was measured from the logs
 * on this machine in S22.1 (`notes/2026-10-27_s22-1-quota-signals.md`); the phrases below are those, and
 * nothing else. That note also says what was **not** measured: how a headless `claude -p` or `codex exec`
 * exits when limited. These patterns come from transcripts and session files, so this is believed, not
 * proven, until one real run per CLI reaches the wall.
 *
 * Three classes, because they need three different waits:
 *
 * - `exhausted` — the quota is gone. Wait until the vendor's reset time when it gave one, else back off.
 * - `auth` — the login is gone. Waiting heals nothing; the owner has to log in again, so the hold is only a
 *   re-probe interval and never an expectation.
 * - `transient` — a 429 or a busy moment. **Not held at all**: a busy second must not become an hour.
 *
 * Pure: no clock, no file, no environment. `now` is an argument so a test can say what time it is.
 */

/** What a miss turned out to be. */
export type LimitKind = "exhausted" | "auth" | "transient";

/** Which allowance ran out, when the vendor said. */
export type LimitWindow = "session" | "weekly";

export interface LimitSignal {
  readonly kind: LimitKind;
  /** The vendor's own reset time, epoch milliseconds. Absent when it gave none. */
  readonly until?: number;
  readonly window?: LimitWindow;
  /** One fixed phrase from this file, never a slice of what the backend printed (it may hold the prompt). */
  readonly reason: string;
}

/** A reset further away than this is a parse accident, not a hold anyone meant. */
export const MAX_HOLD_MS = 14 * 24 * 60 * 60 * 1000;

const AUTH: readonly RegExp[] = [
  /authentication_failed/i,
  /please run \/login/i,
  /invalid api key/i,
  /\bnot logged in\b/i,
];

interface ExhaustedPattern {
  readonly re: RegExp;
  readonly window?: LimitWindow;
  readonly reason: string;
}

// Each line is a phrase S22.1 saw a vendor write: claude, codex, gemini, copilot.
const EXHAUSTED: readonly ExhaustedPattern[] = [
  { re: /hit your session limit/i, window: "session", reason: "session limit reached" },
  { re: /hit your weekly limit/i, window: "weekly", reason: "weekly limit reached" },
  { re: /hit your usage limit/i, reason: "usage limit reached" },
  { re: /quota (?:reached|exceeded|exhausted)/i, reason: "quota reached" },
  { re: /quota_exceeded|you have no quota/i, reason: "no quota" },
];

const TRANSIENT: readonly RegExp[] = [
  /"apiErrorIsTransient"\s*:\s*true/i,
  /\boverloaded\b/i,
  /\b429\b/,
  /rate.?limit/i,
  /temporar(?:y|ily)/i,
];

/** `resetsAt` (claude) and `resets_at` (codex), as a number in a JSON-ish string. */
const RESET_AT = /"?(?:resetsAt|resets_at)"?\s*[:=]\s*(\d{9,13})/g;

/**
 * The earliest reset time the text carries, in epoch milliseconds, or undefined.
 *
 * *Earliest*, because a codex failure can carry two windows (five hours and a week) and the text does not
 * say which one was hit. A wrong guess that is too early costs one more failed turn; one that is too late
 * holds a backend that has long been back.
 */
function earliestReset(text: string, now: number): number | undefined {
  let best: number | undefined;
  for (const match of text.matchAll(RESET_AT)) {
    const raw = Number(match[1]);
    const ms = raw < 1e11 ? raw * 1000 : raw;
    if (ms <= now || ms > now + MAX_HOLD_MS) continue;
    if (best === undefined || ms < best) best = ms;
  }
  return best;
}

/**
 * What a missed turn says about the backend's allowance, or undefined when it says nothing about it.
 *
 * Called only on a result that did not answer. A real answer that mentions "quota" is never read.
 *
 * @param text The backend's `text` and `evidence.raw`, joined by the caller.
 * @param now Epoch milliseconds.
 */
export function classifyLimit(text: string, now: number): LimitSignal | undefined {
  if (AUTH.some((re) => re.test(text))) return { kind: "auth", reason: "login needed" };
  for (const pattern of EXHAUSTED) {
    if (!pattern.re.test(text)) continue;
    const until = earliestReset(text, now);
    return {
      kind: "exhausted",
      reason: pattern.reason,
      ...(until === undefined ? {} : { until }),
      ...(pattern.window === undefined ? {} : { window: pattern.window }),
    };
  }
  if (TRANSIENT.some((re) => re.test(text))) return { kind: "transient", reason: "busy or rate limited" };
  return undefined;
}
