/**
 * The delimited region Mind owns inside a file somebody else wrote.
 *
 * Every instruction file this command touches already belongs to a human, and
 * often to two or three other tools as well. So Mind claims one region,
 * marks both ends of it, and treats every byte outside those markers as none
 * of its business. The promise S1.2 AC4 makes — *a human's own writing is not
 * swallowed* — is only as good as this file.
 *
 * Three details carry that promise:
 *
 * - **`lead` and `tail` record what we inserted around the block.** Appending
 *   a block to a file that did not end in a newline means adding newlines that
 *   were not there before. Counting them in the marker is what lets `strip`
 *   hand back the original file byte-for-byte (S1.5 AC1), rather than a file
 *   that is the same except for whitespace nobody asked for.
 * - **`sha256` covers the body between the markers.** If it does not match, a
 *   human edited text inside our region, and the only safe move is to refuse
 *   and say where. Overwriting it would be exactly the failure this file
 *   exists to prevent.
 * - **Markers match whole lines only, exactly.** A file that *talks about* the
 *   marker — a doc, a quoted example indented in a code fence — is not a file
 *   that contains one. When a marker does appear in a shape we cannot read as
 *   "no block" or "one well-formed block", we refuse rather than guess.
 */

import { isSubjectId, type SubjectId } from "../types.ts";

/** Prefix every marker this engine writes starts with. Reserved: we refuse what we cannot parse. */
export const MARKER_NAMESPACE = "<!-- mind:soul:";

/** Closing marker. Fixed text, so it is greppable by a human with no tooling. */
export const END_MARKER = "<!-- mind:soul:end -->";

/**
 * Opening marker, with everything `strip` needs to undo the write.
 *
 * Deliberately a single fixed attribute order rather than a small parser: a
 * marker is machine-written, and accepting shapes Mind does not produce only
 * widens what has to be trusted.
 */
const BEGIN_PATTERN = new RegExp(
  `^<!-- mind:soul:begin subject=([a-z0-9][a-z0-9_-]{0,63}) ` +
    `sha256=([0-9a-f]{64}) lead=(\\d+) tail=(\\d+) -->$`,
);

/** sha256 of a string, hex. One definition, used by marker and by backup alike. */
export function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/** True when a line is inside Mind's reserved marker namespace. */
export function isMarkerLine(line: string): boolean {
  const text = stripCr(line);
  return text.startsWith(MARKER_NAMESPACE);
}

/** Where the block sits, and everything needed to remove it again. */
export interface BlockLocation {
  /** Subject the block was written for. */
  readonly subject: SubjectId;
  /** sha256 the marker claims the body has. */
  readonly declaredSha: string;
  /** sha256 the body actually has right now. */
  readonly actualSha: string;
  /** False when a human edited text between the markers. */
  readonly intact: boolean;
  /** Characters inserted before the opening marker when the block was written. */
  readonly leadText: string;
  /** Characters inserted after the closing marker. */
  readonly tailText: string;
  /** Start of the region to remove, including `leadText`. */
  readonly start: number;
  /** One past the end of the region, including `tailText`. */
  readonly end: number;
  /** Text between the markers, verbatim. */
  readonly body: string;
}

/** What a file turned out to contain. `refused` is never a guess. */
export type BlockLookup =
  | { readonly kind: "absent" }
  | { readonly kind: "found"; readonly block: BlockLocation }
  | { readonly kind: "refused"; readonly reason: string };

interface Span {
  readonly start: number;
  /** Index of the `\n`, or `text.length` on the last line. */
  readonly end: number;
  readonly text: string;
}

/** Split into lines, keeping each line's byte offsets. CRLF-safe: `\r` stays on. */
function lineSpans(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      spans.push({ start, end: text.length, text: text.slice(start) });
      return spans;
    }
    spans.push({ start, end: newline, text: text.slice(start, newline) });
    start = newline + 1;
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The line ending this file already uses, so we do not mix two in one file. */
export function detectEol(text: string): string {
  const crlf = text.indexOf("\r\n");
  if (crlf === -1) return "\n";
  const lf = text.indexOf("\n");
  // A file whose first newline is part of a CRLF is a CRLF file. Mixed files
  // exist; we follow whichever style got there first rather than voting.
  return lf === crlf + 1 ? "\r\n" : "\n";
}

/**
 * Find Mind's block, or establish that there is none.
 *
 * @returns `absent` for a file we have never written to, `found` for exactly
 *   one well-formed pair in the right order, and `refused` for everything
 *   else — including a marker in our namespace we cannot parse.
 */
export function locate(text: string): BlockLookup {
  const spans = lineSpans(text);

  let begin: { span: Span; match: RegExpMatchArray } | undefined;
  let end: Span | undefined;

  for (const [index, span] of spans.entries()) {
    const line = stripCr(span.text);
    if (!isMarkerLine(line)) continue;
    const at = index + 1;

    if (line === END_MARKER) {
      if (begin === undefined) {
        return { kind: "refused", reason: `line ${at}: a closing Mind marker with no opening one` };
      }
      if (end !== undefined) {
        return { kind: "refused", reason: `line ${at}: a second closing Mind marker` };
      }
      end = span;
      continue;
    }

    const match = line.match(BEGIN_PATTERN);
    if (match === null) {
      return {
        kind: "refused",
        reason:
          `line ${at}: a Mind marker Mind cannot read — ` +
          `${JSON.stringify(line.slice(0, 80))}. Move it out of the way or delete it; ` +
          `Mind will not guess what it delimits.`,
      };
    }
    if (begin !== undefined) {
      return { kind: "refused", reason: `line ${at}: a second opening Mind marker` };
    }
    if (end !== undefined) {
      return { kind: "refused", reason: `line ${at}: an opening Mind marker after a closing one` };
    }
    begin = { span, match };
  }

  if (begin === undefined && end === undefined) return { kind: "absent" };
  if (begin === undefined || end === undefined) {
    return {
      kind: "refused",
      reason: "a Mind block with only one marker — the other end is missing, so its extent is unknown",
    };
  }

  const subject = begin.match[1]!;
  if (!isSubjectId(subject)) {
    return { kind: "refused", reason: `the opening marker names ${JSON.stringify(subject)}, which is not a subject id` };
  }
  const declaredSha = begin.match[2]!;
  const lead = Number(begin.match[3]!);
  const tail = Number(begin.match[4]!);

  // `body` is what sits strictly between the two marker lines: everything after
  // the newline that ends the opening marker, minus the newline that precedes
  // the closing one. Dropping exactly one line ending — CRLF included — is
  // what makes this the inverse of how `splice` wrote it.
  const bodyStart = Math.min(begin.span.end + 1, text.length);
  if (end.start < bodyStart) {
    return { kind: "refused", reason: "the Mind markers overlap — the block has no body" };
  }
  const body = dropOneEol(text.slice(bodyStart, end.start));

  // `lead` and `tail` count characters either side of the *marker text*, not
  // either side of the marker's line. On a CRLF file the `\r` is part of what
  // `splice` wrote as the tail, so measuring from the line's terminator would
  // count it twice and put the end of the region past the end of the file.
  const start = begin.span.start - lead;
  const markerTextEnd = end.start + END_MARKER.length;
  const endIndex = markerTextEnd + tail;
  if (start < 0 || endIndex > text.length) {
    return {
      kind: "refused",
      reason: `the opening marker claims lead=${lead} tail=${tail}, which does not fit inside this file`,
    };
  }

  const leadText = text.slice(start, begin.span.start);
  const tailText = text.slice(markerTextEnd, endIndex);
  if (!isWhitespaceOnly(leadText) || !isWhitespaceOnly(tailText)) {
    return {
      kind: "refused",
      reason: "the text the marker claims Mind inserted around the block is not whitespace — refusing to delete it",
    };
  }

  const actualSha = sha256(body);
  return {
    kind: "found",
    block: {
      subject,
      declaredSha,
      actualSha,
      intact: actualSha === declaredSha,
      leadText,
      tailText,
      start,
      end: endIndex,
      body,
    },
  };
}

function isWhitespaceOnly(value: string): boolean {
  return /^[\r\n]*$/.test(value);
}

/** Remove one trailing line ending, whichever kind it is. */
function dropOneEol(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

/** What to write, before it is placed in any particular file. */
export interface BlockPlan {
  readonly subject: SubjectId;
  /** Rendered identity text. Must contain no line in the marker namespace. */
  readonly body: string;
}

/** The result of placing a block: the next whole file, and what it did. */
export type SpliceResult =
  | {
      readonly kind: "spliced";
      readonly next: string;
      readonly action: "insert" | "replace";
      /** Set on `replace` — whose block was overwritten (AC5). */
      readonly replacedSubject?: SubjectId;
    }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Put `plan` into `text`, inserting at the end or replacing what is there.
 *
 * The block goes at the end of the file on purpose. It makes the diff a pure
 * addition, and it leaves every line a human wrote at the byte offset they
 * left it at. Whether the top of the file would carry more weight with a model
 * is a question only S1.3's measurements can answer, and guessing at it here
 * would cost the property above.
 */
export function splice(text: string, plan: BlockPlan): SpliceResult {
  for (const line of plan.body.split("\n")) {
    if (isMarkerLine(line)) {
      return { kind: "refused", reason: "the rendered identity contains a Mind marker line" };
    }
  }

  const found = locate(text);
  if (found.kind === "refused") return found;

  const eol = detectEol(text);
  // Inside our own block we follow the file's line endings rather than our
  // own. Mixing the two in one file is the kind of change that shows up in
  // somebody else's diff for no reason they can see.
  const body = eol === "\n" ? plan.body.replaceAll("\r\n", "\n") : plan.body.replaceAll("\r\n", "\n").replaceAll("\n", eol);

  if (found.kind === "absent") {
    const lead = leadFor(text, eol);
    const tail = eol;
    const marker = beginMarker(plan.subject, sha256(body), lead.length, tail.length);
    return {
      kind: "spliced",
      next: `${text}${lead}${marker}${eol}${body}${eol}${END_MARKER}${tail}`,
      action: "insert",
    };
  }

  const block = found.block;
  if (!block.intact) {
    return {
      kind: "refused",
      reason:
        `the text between Mind's markers was edited by hand (sha256 ${block.actualSha.slice(0, 12)} ` +
        `where the marker says ${block.declaredSha.slice(0, 12)}). Move that text outside the markers ` +
        `and run again — Mind will not overwrite something a human wrote.`,
    };
  }

  const marker = beginMarker(plan.subject, sha256(body), block.leadText.length, block.tailText.length);
  const region = `${block.leadText}${marker}${eol}${body}${eol}${END_MARKER}${block.tailText}`;
  const next = text.slice(0, block.start) + region + text.slice(block.end);
  return {
    kind: "spliced",
    next,
    action: "replace",
    ...(block.subject === plan.subject ? {} : { replacedSubject: block.subject }),
  };
}

/** Remove Mind's block, restoring the file to what it was before the write. */
export type StripResult =
  | { readonly kind: "absent"; readonly text: string }
  | { readonly kind: "stripped"; readonly text: string; readonly subject: SubjectId }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Take Mind's block back out.
 *
 * Used twice: by `apply`, which checks that stripping the file it is about to
 * write gives the same bytes as stripping the file that is there now — if it
 * does not, the write changes something outside the block and is refused — and
 * later by `soul revoke` (S1.5), which is this function and a backup restore.
 */
export function strip(text: string): StripResult {
  const found = locate(text);
  if (found.kind === "refused") return found;
  if (found.kind === "absent") return { kind: "absent", text };
  const block = found.block;
  if (!block.intact) {
    return {
      kind: "refused",
      reason: "the text between Mind's markers was edited by hand — removing the block would delete it",
    };
  }
  return {
    kind: "stripped",
    text: text.slice(0, block.start) + text.slice(block.end),
    subject: block.subject,
  };
}

/** The bytes outside Mind's block: what must survive every write unchanged. */
export function humanText(text: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const result = strip(text);
  if (result.kind === "refused") return { ok: false, reason: result.reason };
  return { ok: true, text: result.text };
}

function beginMarker(subject: SubjectId, sha: string, lead: number, tail: number): string {
  return `${MARKER_NAMESPACE}begin subject=${subject} sha256=${sha} lead=${lead} tail=${tail} -->`;
}

/** Newlines to add so exactly one blank line separates the file from the block. */
function leadFor(text: string, eol: string): string {
  if (text.length === 0) return "";
  let trailing = 0;
  let cursor = text.length;
  while (trailing < 2 && cursor >= eol.length && text.slice(cursor - eol.length, cursor) === eol) {
    trailing++;
    cursor -= eol.length;
  }
  return eol.repeat(2 - trailing);
}
