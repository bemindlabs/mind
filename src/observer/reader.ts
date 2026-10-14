/**
 * One pipe, two doors: the hook at the moment of the action, and the seed over
 * files that already exist.
 *
 * `S3.1 AC1` is a rule about *not writing two readers*, and it is worth stating
 * why it is an acceptance criterion at all rather than an implementation
 * preference. A second reader is a second answer to "what counts as an action",
 * and the two drift: one de-duplicates and the other does not, one skips
 * sub-agent work and the other keeps it, and the pile of records the owner ends
 * up with is a mixture of two opinions with nothing on the line to say which.
 *
 * So there is one function, {@link readInto}, and everything else is what it
 * takes as arguments:
 *
 * - **lines** — an `AsyncIterable<string>`. The hook hands it a single line
 *   read from standard input; the seed hands it {@link streamLines} over a
 *   663 MB directory, one line at a time (`S3.1 AC4`).
 * - **an adapter** — a pure function from a parsed line to records or to the
 *   reason there were none. One per format, in `adapters/`.
 * - **a sink** — where accepted records go. The hook appends; a test collects.
 *
 * ## Skipping and counting (AC2), and the report (AC3)
 *
 * A line that does not parse, a record the adapter does not recognise, a record
 * that is a duplicate of one already seen — none of these end the run. Each is
 * counted under a one-word reason and the run carries on, because the failure
 * this is guarding against is a single malformed line at 4 a.m. ending a seed
 * over seven weeks of history.
 *
 * The reasons are **words this program chose**, never text from the data. That
 * rule came out of SP-1 (guard 3): `JSON.parse` quotes the input it choked on,
 * so an exception message is a transcript excerpt wearing a diagnostic's
 * clothes. Here the data is the owner's own, so the rule matters more, not
 * less.
 */

import type { CaptureRecord } from "./record.ts";
import { fromValue } from "./record.ts";

/**
 * The bar `S3.1 AC3` fixes: at least this share of lines must parse.
 *
 * SP-1 measured 100.0% across 1,506 files and 356k lines, so this is a floor
 * that today's data clears by a distance. It is checked rather than assumed
 * because the thing it would catch — a vendor changing format, a file being
 * written while it is read — is silent otherwise.
 */
export const READABLE_FLOOR = 85;

/** What an adapter made of one parsed line. */
export type Adapted =
  | { readonly records: readonly CaptureRecord[] }
  | { readonly skip: string };

/**
 * One format, as a pure function.
 *
 * Pure so that every dialect decision is arguable in a unit test without a
 * filesystem, and so that `readInto` remains the only thing that counts.
 */
export type Adapter = (value: unknown) => Adapted;

/** Where accepted records go. May be asynchronous; may throw, and the caller will hear it. */
export type Sink = (record: CaptureRecord) => void | Promise<void>;

/** What a run saw. Every number here is counted, never estimated. */
export interface ReadReport {
  /** Lines offered, including blank ones, which are not counted as failures. */
  readonly lines: number;
  /** Lines that were valid JSON. */
  readonly parsed: number;
  /** Records handed to the sink. */
  readonly accepted: number;
  /** Records the adapter produced that had been seen before, by `key` (AC7). */
  readonly duplicates: number;
  /** One-word reason → how many. Reasons are Mind's words, never the data's. */
  readonly skipped: Readonly<Record<string, number>>;
  /** `parsed / lines`, to one decimal. 100 when there were no lines at all. */
  readonly pct: number;
}

/**
 * Run the pipe.
 *
 * @param seen Keys already accepted, carried in by the caller so that a run
 *   across a whole directory de-duplicates across files (`S3.1 AC7`: 5.3% of
 *   claude's records appear in more than one file) and so that a seed run after
 *   a capture does not re-add what the hook already wrote. The hook and the
 *   seed mint the same key for the same tool call, which is what makes that
 *   work.
 */
export async function readInto(
  lines: AsyncIterable<string>,
  adapter: Adapter,
  sink: Sink,
  seen: Set<string> = new Set(),
): Promise<ReadReport> {
  let total = 0;
  let parsed = 0;
  let accepted = 0;
  let duplicates = 0;
  const skipped = new Map<string, number>();

  const skip = (reason: string): void => {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  };

  for await (const line of lines) {
    if (line.trim() === "") continue;
    total += 1;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // Deliberately not the exception's message: it contains the line.
      skip("unparsable");
      continue;
    }
    parsed += 1;

    const adapted = adapter(value);
    if ("skip" in adapted) {
      skip(adapted.skip);
      continue;
    }
    if (adapted.records.length === 0) {
      skip("no-action");
      continue;
    }

    for (const record of adapted.records) {
      // Validated on the way out as well as built on the way in. An adapter is
      // where a vendor's oddity meets Mind's schema, and the cheapest place
      // to find out that the two disagree is here rather than on a line
      // somebody reads back in six weeks.
      const checked = fromValue(record);
      if (!checked.ok) {
        skip(`invalid:${checked.reason}`);
        continue;
      }
      if (seen.has(checked.record.key)) {
        duplicates += 1;
        continue;
      }
      seen.add(checked.record.key);
      await sink(checked.record);
      accepted += 1;
    }
  }

  return {
    lines: total,
    parsed,
    accepted,
    duplicates,
    skipped: Object.fromEntries(skipped),
    pct: total === 0 ? 100 : Math.round((parsed * 1000) / total) / 10,
  };
}

/**
 * Lines of a file, streamed.
 *
 * `S3.1 AC4`: 663 MB must never become 663 MB of heap. `Bun.file(path).stream()`
 * yields chunks; the carry holds the partial line across a chunk boundary, and
 * the decoder is told the stream is not finished so a multi-byte character
 * split across two chunks survives.
 */
export async function* streamLines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let carry = "";
  for await (const chunk of Bun.file(path).stream()) {
    carry += decoder.decode(chunk as Uint8Array, { stream: true });
    const parts = carry.split("\n");
    carry = parts.pop() ?? "";
    for (const part of parts) yield part;
  }
  carry += decoder.decode();
  if (carry !== "") yield carry;
}

/** One piece of text as lines, for the hook, which is handed a single payload. */
export async function* textLines(text: string): AsyncGenerator<string> {
  for (const line of text.split("\n")) yield line;
}

/** The report as one line a human reads. */
export function formatReport(report: ReadReport): string {
  const reasons = Object.entries(report.skipped)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
  return (
    `${report.lines} line(s) · ${report.parsed} parsed (${report.pct.toFixed(1)}%) · ` +
    `${report.accepted} kept · ${report.duplicates} duplicate(s)` +
    (reasons === "" ? "" : ` · skipped: ${reasons}`)
  );
}
