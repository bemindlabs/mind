/**
 * Splitting `+++` TOML frontmatter from Markdown, and finding the guilty line.
 *
 * Two things here are not obvious and both are deliberate.
 *
 * **We do not write a TOML parser.** `Bun.TOML.parse` ships with the runtime
 * we already depend on, and a hand-rolled parser is a supply of bugs nobody
 * asked for. What Bun does *not* give us is position information: measured on
 * bun 1.4.2, the `line`/`column` on the thrown `SyntaxError` describe the
 * JavaScript call site, not the TOML text — the same numbers come back no
 * matter where the error is. So AC4 ("rejected, with a line") has to be earned
 * separately, in two different ways:
 *
 * - *Schema* errors point at an exact line, from a key→line index built by
 *   scanning the source. This is the common case and it is exact.
 * - *Syntax* errors get a derived line: we parse growing prefixes and report
 *   the line after the last one that still parsed. That is right for the
 *   ordinary case and stays honest for the rest by carrying
 *   `approximate: true` all the way to the printed message.
 *
 * **Bodies are preserved byte-for-byte.** Splitting on `"\n"` and re-joining
 * on `"\n"` is exactly reversible, CRLF included, which is what lets
 * load → serialize → load compare equal (I-2).
 */

import type { SoulIssue } from "./schema.ts";

/** The frontmatter fence. TOML, not YAML, so a soul is typed, not stringly. */
export const DELIMITER = "+++";

/**
 * Prefix-parsing to locate a syntax error is quadratic. Frontmatter is a few
 * dozen lines, so this ceiling is never reached in practice; it exists so a
 * pathological input degrades to "line 1, approximate" instead of hanging.
 */
const MAX_BISECT_LINES = 400;

/** A parsed TOML table, plus where each key was written. */
export interface TomlDocument {
  readonly table: Record<string, unknown>;
  readonly lines: ReadonlyMap<string, number>;
}

/** Frontmatter and body, with the fence lines that separated them. */
export interface Frontmatter {
  readonly doc: TomlDocument;
  /** Markdown after the closing fence, verbatim. */
  readonly body: string;
  /** 1-based line of the opening `+++`. */
  readonly openLine: number;
  /** 1-based line of the closing `+++`. */
  readonly closeLine: number;
}

/** Either the parse, or every reason it failed. */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly SoulIssue[] };

/**
 * Parse a standalone TOML file (an import map, say).
 *
 * @param lineOffset How many lines of `file` come before `text`, so reported
 *   lines are file lines rather than fragment lines.
 */
export function parseTomlDocument(
  file: string,
  text: string,
  lineOffset = 0,
): ParseResult<TomlDocument> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issues: [
        {
          file,
          line: lineOffset + approximateErrorLine(text),
          path: "",
          message,
          approximate: true,
        },
      ],
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      issues: [{ file, line: lineOffset + 1, path: "", message: "expected a TOML table" }],
    };
  }

  return {
    ok: true,
    value: { table: parsed as Record<string, unknown>, lines: indexKeyLines(text, lineOffset) },
  };
}

/**
 * Split `+++` frontmatter from the Markdown that follows it.
 *
 * Only the *first* pair of fences counts, and the opening one must be the very
 * first line. A `+++` further down is body text, which keeps the rule a reader
 * can apply by eye: frontmatter is the block at the top, nothing else.
 */
export function parseFrontmatter(file: string, text: string): ParseResult<Frontmatter> {
  const lines = text.split("\n");

  if (lines[0]?.trim() !== DELIMITER) {
    return {
      ok: false,
      issues: [
        {
          file,
          line: 1,
          path: "",
          message: `expected TOML frontmatter: the first line must be ${DELIMITER}`,
        },
      ],
    };
  }

  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (closeIndex === -1) {
    return {
      ok: false,
      issues: [
        {
          file,
          line: 1,
          path: "",
          message: `unterminated frontmatter: no closing ${DELIMITER} after line 1`,
        },
      ],
    };
  }

  const toml = `${lines.slice(1, closeIndex).join("\n")}\n`;
  const parsed = parseTomlDocument(file, toml, 1);
  if (!parsed.ok) return parsed;

  return {
    ok: true,
    value: {
      doc: parsed.value,
      body: lines.slice(closeIndex + 1).join("\n"),
      openLine: 1,
      closeLine: closeIndex + 1,
    },
  };
}

/**
 * The line a TOML syntax error is at or before.
 *
 * Parse every prefix; the last one that succeeded is the last line we know to
 * be fine, so the error is on the line after it. This gets multi-line values
 * right without tracking them: a prefix that cuts an array in half fails, but
 * a later prefix that closes it succeeds again, and only the *last* success
 * counts.
 */
function approximateErrorLine(text: string): number {
  const lines = text.split("\n");
  if (lines.length > MAX_BISECT_LINES) return 1;

  let lastGood = 0;
  for (let count = 1; count <= lines.length; count++) {
    try {
      Bun.TOML.parse(lines.slice(0, count).join("\n"));
      lastGood = count;
    } catch {
      // Not necessarily the error line: a prefix can fail for being a prefix.
    }
  }
  return Math.min(lastGood + 1, Math.max(lines.length, 1));
}

/**
 * Map every key to the line it was written on.
 *
 * Best-effort by design: it tracks table headers, bracket depth and multi-line
 * strings so that keys inside a multi-line array are not mistaken for
 * top-level ones, but it is a scanner, not a parser. Getting a line slightly
 * wrong costs a reader one glance; re-implementing TOML costs correctness
 * everywhere.
 */
function indexKeyLines(text: string, lineOffset: number): ReadonlyMap<string, number> {
  const found = new Map<string, number>();
  let section = "";
  let depth = 0;
  let openMultiline: string | undefined;

  text.split("\n").forEach((raw, index) => {
    const lineNumber = lineOffset + index + 1;

    if (openMultiline !== undefined) {
      if (raw.includes(openMultiline)) openMultiline = undefined;
      return;
    }

    if (depth === 0) {
      const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(raw);
      if (header !== null) {
        section = header[1] ?? "";
        if (!found.has(section)) found.set(section, lineNumber);
      } else {
        const pair = /^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*=/.exec(raw);
        const key = pair === null ? undefined : (pair[1] ?? pair[2] ?? pair[3]);
        if (key !== undefined) {
          const path = section === "" ? key : `${section}.${key}`;
          if (!found.has(path)) found.set(path, lineNumber);
        }
      }
    }

    const scanned = scanLine(raw, depth);
    depth = scanned.depth;
    openMultiline = scanned.openMultiline;
  });

  return found;
}

/** Bracket depth and multi-line-string state after consuming one line. */
function scanLine(line: string, startDepth: number): { depth: number; openMultiline?: string } {
  let depth = startDepth;
  let index = 0;

  while (index < line.length) {
    const char = line[index]!;

    if (char === "#") break; // comment runs to end of line

    if (char === '"' || char === "'") {
      const triple = line.slice(index, index + 3);
      if (triple === '"""' || triple === "'''") {
        const close = line.indexOf(triple, index + 3);
        if (close === -1) return { depth, openMultiline: triple };
        index = close + 3;
        continue;
      }
      let cursor = index + 1;
      while (cursor < line.length) {
        if (char === '"' && line[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (line[cursor] === char) break;
        cursor++;
      }
      index = cursor + 1;
      continue;
    }

    if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
    index++;
  }

  return { depth };
}
