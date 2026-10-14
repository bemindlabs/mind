/**
 * Importing an existing bwoc agent directory into a soul (S1.1 AC5).
 *
 * The bar this has to clear is "without losing information" (D-009), and that
 * word is doing more work than it looks like. It rules out the three things an
 * importer naturally wants to do:
 *
 * - **No de-duplication.** When a README row and a mindset file say the same
 *   thing, both are kept. Collapsing them is a judgement about which phrasing
 *   mattered, and that judgement belongs to whoever wrote them.
 * - **No rewriting.** Imported Markdown is copied byte-for-byte: headings are
 *   not demoted, wiki-links are not rewritten, nothing is translated. Each
 *   source file becomes one fenced section under a `mind:source` comment,
 *   so a reader can always find what came from where.
 * - **No guessing.** Which file is role knowledge and which is a personal
 *   trait comes from the import map, never from a tag or a heading. `tags:
 *   principle/*` in particular says nothing about the split — it appears on
 *   files that fall on both sides.
 *
 * One source file lands in exactly one destination file. Splitting a mindset
 * across `role.md` and `person.md` would make both "nothing was lost" and
 * AC3's separation check unverifiable at the same time.
 *
 * This module only ever *reads* the agent directory (D-009: the live agent is
 * not disturbed). Writing is the caller's business, and the CLI refuses to
 * write anywhere that git would pick up (I-4).
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SubjectId } from "../types.ts";
import type { ImportMap, ReadmeRules } from "./import-map.ts";
import {
  PERSON_FILE,
  PERSON_SCHEMA,
  ROLE_FILE,
  ROLE_SCHEMA,
  soulOf,
  validatePerson,
  validateRole,
  type Soul,
  type SoulIssue,
} from "./schema.ts";

/** What opens the comment above each imported source, `<!-- <this> <path> -->`. Nothing reads it back. */
const SOURCE_COMMENT = "mind:source";

/** bwoc's per-agent config, the source of name/role/scope. */
const MANIFEST = "config.manifest.json";
const PERSONA_DIR = "persona";
const MINDSETS_DIR = "mindsets";
/** Read structurally rather than copied wholesale — see {@link splitReadme}. */
const README = `${PERSONA_DIR}/README.md`;

/** The four manifest fields a soul needs. Everything else is runtime config. */
const MANIFEST_FIELDS = ["name", "agentRole", "scopeDescription", "outOfScope"] as const;

/** What an import produced, and everything it could not account for. */
export interface BwocImport {
  /** Undefined only when the agent could not be read at all. */
  readonly soul: Soul | undefined;
  /** Source files with no entry in the map. Import is not safe while non-empty. */
  readonly unmapped: readonly string[];
  /** Source files the map deliberately excluded. */
  readonly skipped: readonly string[];
  /** Empty means the import is safe to write. */
  readonly issues: readonly SoulIssue[];
}

/**
 * Read a bwoc agent directory and build a soul for `subject`.
 *
 * Never throws for bad input and never writes. Check `issues` before using
 * `soul`: a soul built from a partially-mapped directory is missing content
 * and must not be written anywhere.
 */
export async function importBwocAgent(
  dir: string,
  subject: SubjectId,
  map: ImportMap,
): Promise<BwocImport> {
  const issues: SoulIssue[] = [];
  const unmapped: string[] = [];
  const skipped: string[] = [];

  const manifest = await readManifest(dir, issues);
  const readmeText = await readOrUndefined(join(dir, README));
  if (readmeText === undefined) {
    issues.push({ file: README, line: 0, path: "", message: "not found — a soul needs an identity to start from" });
  }

  const present = [
    ...(await listMarkdown(dir, PERSONA_DIR)),
    ...(await listMarkdown(dir, MINDSETS_DIR)),
  ];

  // A map entry that names nothing is a stale line, and a stale line is how a
  // file quietly stops being classified when it is renamed.
  for (const source of map.classify.keys()) {
    const line = map.lines.get(source) ?? 1;
    if (source === README) {
      issues.push({
        file: map.file,
        line,
        path: `classify.${source}`,
        message: `${README} is read structurally and must not be classified`,
      });
      continue;
    }
    if (!present.includes(source)) {
      issues.push({
        file: map.file,
        line,
        path: `classify.${source}`,
        message: "no such file under the agent directory",
      });
    }
  }

  const roleSections: string[] = [];
  const personSections: string[] = [];

  const readme =
    readmeText === undefined ? undefined : splitReadme(readmeText, map.readme);
  if (readme !== undefined) {
    const roleChunk = readmeBlock(readme.yaml, readme.roleLines);
    const personChunk = readmeBlock(undefined, readme.personLines);
    if (roleChunk !== undefined) roleSections.push(roleChunk);
    if (personChunk !== undefined) personSections.push(personChunk);
  }

  for (const source of present) {
    if (source === README) continue;
    const destination = map.classify.get(source);
    if (destination === undefined) {
      unmapped.push(source);
      issues.push({
        file: map.file,
        line: 0,
        path: "classify",
        message: `${source} has no entry — every source file needs role, person or skip`,
      });
      continue;
    }
    if (destination === "skip") {
      skipped.push(source);
      continue;
    }
    const text = await readOrUndefined(join(dir, source));
    if (text === undefined) continue; // listed a moment ago; treat a race as absent
    const block = sourceBlock(source, text);
    if (destination === "role") roleSections.push(block);
    else personSections.push(block);
  }

  if (manifest === undefined || readme === undefined) {
    return { soul: undefined, unmapped, skipped, issues };
  }

  const roleTable: Record<string, unknown> = {
    schema: ROLE_SCHEMA,
    subject,
    name: manifest["name"],
    role: manifest["agentRole"],
    prohibitions: readme.prohibitions,
    scope: { does: manifest["scopeDescription"], does_not: manifest["outOfScope"] },
  };
  const personTable: Record<string, unknown> = {
    schema: PERSON_SCHEMA,
    subject,
    tone: readme.tone,
    addresses_user_as: readme.addressesUserAs,
    refers_to_self_as: readme.refersToSelfAs,
    principles: readme.principles,
  };

  // The generated tables go through exactly the validator a hand-written soul
  // goes through. An importer with its own idea of "valid enough" is how a
  // schema stops meaning anything.
  const role = validateRole(ROLE_FILE, roleTable, blame(), 0, subject, joinSections(roleSections));
  const person = validatePerson(
    PERSON_FILE,
    personTable,
    blame(),
    0,
    subject,
    joinSections(personSections),
  );

  if (!role.ok) issues.push(...role.issues.map((issue) => explain(issue, map.readme)));
  if (!person.ok) issues.push(...person.issues.map((issue) => explain(issue, map.readme)));
  if (!role.ok || !person.ok) return { soul: undefined, unmapped, skipped, issues };

  return { soul: soulOf(subject, role.value, person.value), unmapped, skipped, issues };
}

/** Generated tables have no source lines; every issue points at the agent instead. */
function blame(): ReadonlyMap<string, number> {
  return new Map();
}

/** Re-address a schema complaint to the file a human would have to edit. */
function explain(issue: SoulIssue, rules: ReadmeRules): SoulIssue {
  const source: Record<string, string> = {
    name: `${MANIFEST}: name`,
    role: `${MANIFEST}: agentRole`,
    "scope.does": `${MANIFEST}: scopeDescription`,
    "scope.does_not": `${MANIFEST}: outOfScope`,
    prohibitions: `${README}: ## ${rules.constraints_section}`,
    tone: `${README}: ## ${rules.tone_section}`,
    principles: `${README}: ## ${rules.principles_section}`,
    addresses_user_as: `${README}: ${rules.addresses_user_as_row}`,
    refers_to_self_as: `${README}: ${rules.refers_to_self_as_row}`,
  };
  const origin = source[issue.path];
  return origin === undefined
    ? issue
    : { ...issue, message: `${issue.message} (comes from ${origin})` };
}

/** What `splitReadme` pulled out of the persona README. */
interface ReadmeSplit {
  /** YAML frontmatter, verbatim, without its `---` fences. */
  readonly yaml: string | undefined;
  readonly roleLines: readonly string[];
  readonly personLines: readonly string[];
  readonly tone: readonly string[];
  readonly principles: readonly string[];
  readonly prohibitions: readonly string[];
  readonly addressesUserAs: string | undefined;
  readonly refersToSelfAs: readonly string[];
}

/**
 * Read the persona README, splitting it along the same seam as the soul.
 *
 * The README is the one source file that is *not* copied wholesale, because it
 * is the one file that mixes both halves: an Identity table with a role in it
 * and a form of address next to it, a Personality section, a Constraints
 * section. Copying it into `role.md` would put the tone right back in the file
 * that survives `erase --personal`, which is the exact outcome D-006.4 exists
 * to prevent.
 *
 * So each line is routed individually — by section heading, and for the two
 * rows named in the map, by table row. Every non-blank line still lands in
 * exactly one of the two files; nothing is dropped and nothing is rewritten.
 */
export function splitReadme(text: string, rules: ReadmeRules): ReadmeSplit {
  const all = text.split("\n");
  const { yaml, rest } = splitYamlFrontmatter(all);

  const roleLines: string[] = [];
  const personLines: string[] = [];
  let personalSection = false;

  for (const line of rest) {
    if (isHeading(line)) {
      personalSection =
        line.includes(rules.tone_section) || line.includes(rules.principles_section);
    }
    const isPersonalRow =
      identityRow(line, rules.addresses_user_as_row) !== undefined ||
      identityRow(line, rules.refers_to_self_as_row) !== undefined;
    (personalSection || isPersonalRow ? personLines : roleLines).push(line);
  }

  const addressesUserAs = firstRowValue(rest, rules.addresses_user_as_row);
  const refersRaw = firstRowValue(rest, rules.refers_to_self_as_row);

  return {
    yaml,
    roleLines,
    personLines,
    tone: listItems(section(rest, rules.tone_section)),
    principles: listItems(section(rest, rules.principles_section)),
    prohibitions: listItems(section(rest, rules.constraints_section)),
    addressesUserAs,
    refersToSelfAs:
      refersRaw === undefined
        ? []
        : refersRaw
            .split("/")
            .map(unquote)
            .filter((part) => part.length > 0),
  };
}

/** `## ` or deeper. `#` alone is the document title, not a section. */
function isHeading(line: string): boolean {
  return /^#{2,}\s/.test(line);
}

/** Lines of the first `##` section whose heading mentions `label`, heading excluded. */
function section(lines: readonly string[], label: string): readonly string[] {
  const start = lines.findIndex((line) => isHeading(line) && line.includes(label));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isHeading);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Bullet and numbered-list entries, with the marker removed and nothing else. */
function listItems(lines: readonly string[]): readonly string[] {
  const items: string[] = [];
  for (const line of lines) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line);
    if (match !== null) items.push(match[1]!);
  }
  return items;
}

/** The second cell of a Markdown table row whose first cell mentions `label`. */
function identityRow(line: string, label: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return undefined;
  const cells = trimmed.split("|").slice(1, -1);
  if (cells.length < 2) return undefined;
  if (!stripEmphasis(cells[0]!).includes(label)) return undefined;
  return stripEmphasis(cells[1]!);
}

function firstRowValue(lines: readonly string[], label: string): string | undefined {
  for (const line of lines) {
    const value = identityRow(line, label);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** Drop Markdown bold/code decoration so a label can be matched as written. */
function stripEmphasis(cell: string): string {
  return cell.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

/** Drop one layer of straight or typographic quotes. */
function unquote(value: string): string {
  return value.trim().replace(/^["'“”]+|["'“”]+$/g, "").trim();
}

/** Split leading `---` YAML frontmatter from the rest, both verbatim. */
function splitYamlFrontmatter(lines: readonly string[]): {
  yaml: string | undefined;
  rest: readonly string[];
} {
  if (lines[0]?.trim() !== "---") return { yaml: undefined, rest: lines };
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close === -1) return { yaml: undefined, rest: lines };
  return { yaml: lines.slice(1, close).join("\n"), rest: lines.slice(close + 1) };
}

/**
 * One source file as one section of a soul body.
 *
 * The `mind:source` comment is the audit trail S6.1 AC2 will need: every
 * line in a soul has to be traceable back to the artefact it came from.
 */
export function sourceBlock(relativePath: string, text: string): string {
  const { yaml, rest } = splitYamlFrontmatter(text.split("\n"));
  const parts = [`<!-- ${SOURCE_COMMENT} ${relativePath} -->`];
  if (yaml !== undefined) parts.push("```yaml", yaml, "```");
  parts.push(rest.join("\n"));
  return parts.join("\n");
}

/** The README's share of one destination file, or nothing if it has none. */
function readmeBlock(yaml: string | undefined, lines: readonly string[]): string | undefined {
  const trimmed = trimBlankEdges(lines);
  if (yaml === undefined && trimmed.length === 0) return undefined;
  const parts = [`<!-- ${SOURCE_COMMENT} ${README} -->`];
  if (yaml !== undefined) parts.push("```yaml", yaml, "```");
  if (trimmed.length > 0) parts.push(trimmed.join("\n"));
  return parts.join("\n");
}

/** Drop blank lines at both ends. Only blank lines — content is never touched. */
function trimBlankEdges(lines: readonly string[]): readonly string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * Join sections with a blank line, ending the file with exactly one newline.
 *
 * Only ever appends. Trimming the tail would cut into the last imported file's
 * text, and "appears verbatim" is checked against the source byte-for-byte.
 */
function joinSections(sections: readonly string[]): string {
  if (sections.length === 0) return "";
  const joined = sections.join("\n\n");
  return joined.endsWith("\n") ? joined : `${joined}\n`;
}

/** Read the manifest, reporting each missing field rather than the first. */
async function readManifest(
  dir: string,
  issues: SoulIssue[],
): Promise<Record<string, string> | undefined> {
  const text = await readOrUndefined(join(dir, MANIFEST));
  if (text === undefined) {
    issues.push({ file: MANIFEST, line: 0, path: "", message: "not found" });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    issues.push({
      file: MANIFEST,
      line: 0,
      path: "",
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    issues.push({ file: MANIFEST, line: 0, path: "", message: "expected a JSON object" });
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const out: Record<string, string> = {};
  let complete = true;
  for (const field of MANIFEST_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      issues.push({ file: MANIFEST, line: 0, path: field, message: "required, and must be a non-empty string" });
      complete = false;
      continue;
    }
    out[field] = value;
  }
  return complete ? out : undefined;
}

/** Every `.md` directly under `dir/sub`, as posix paths relative to `dir`. */
async function listMarkdown(dir: string, sub: string): Promise<readonly string[]> {
  let entries: string[];
  try {
    entries = await readdir(join(dir, sub));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => `${sub}/${name}`);
}

async function readOrUndefined(path: string): Promise<string | undefined> {
  const handle = Bun.file(path);
  if (!(await handle.exists())) return undefined;
  return handle.text();
}
