/**
 * S6.1 — a soul drafted from real artifacts, every line tied to its source (D-072).
 *
 * The owner hands over artifacts — documents, work chats, code, tickets — and
 * a model **on this machine** proposes claims about the job: what it does,
 * what it never does, what it knows, and (kept to the minimum, in its own
 * file) how the person works. Each claim must come with a verbatim quote, and
 * a claim whose quote is not in the artifact is cut as made up (AC2). What
 * survives is a draft the owner answers yes or no to, line by line (AC4);
 * only the yeses reach the soul, and each carries where it came from.
 *
 * Artifacts are the owner's and leave nothing behind outside the personal
 * directory: the model is checked to be a loopback one before anything is
 * read to it, and the draft — which quotes the artifacts — is written under
 * `personal/`, which `erase` removes whole.
 *
 * This file is pure except for {@link collectArtifacts}; the model call and
 * the files are the command's.
 */

import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { scanStaged } from "../guard/scan.ts";
import type { SoulPerson, SoulRole } from "./schema.ts";

/** What a claim is about, and which file of the soul it belongs in (AC3). */
export const ROLE_FIELDS = ["knowledge", "does", "does_not", "prohibition"] as const;
export const PERSON_FIELDS = ["principle", "tone"] as const;
export type ClaimField = (typeof ROLE_FIELDS)[number] | (typeof PERSON_FIELDS)[number];
const FIELDS: readonly string[] = [...ROLE_FIELDS, ...PERSON_FIELDS];

export interface Artifact {
  /** Relative to the root it was found under, `/`-separated. What a claim cites. */
  readonly label: string;
  readonly text: string;
}

export interface Chunk {
  readonly label: string;
  /** 1-based line of the artifact where this chunk starts. */
  readonly line: number;
  readonly text: string;
}

export interface Claim {
  readonly id: string;
  readonly field: ClaimField;
  readonly text: string;
  readonly quote: string;
  readonly source: { readonly label: string; readonly line: number };
  readonly decision: "yes" | "no" | null;
}

export interface Draft {
  readonly v: 1;
  readonly id: string;
  readonly at: string;
  readonly subject: string;
  readonly model: string;
  readonly sources: readonly string[];
  readonly chunks: number;
  /** Claims the model offered whose quote is not in the artifact — cut (AC2). */
  readonly cut: number;
  /** Artifacts not read, and why. */
  readonly skipped: readonly string[];
  readonly claims: readonly Claim[];
}

const TEXT_EXT = /\.(md|markdown|txt|text|rst|org|adoc|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|log|html?|xml|ts|tsx|js|jsx|mjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|eml|mbox|vtt|srt)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".mind", ".mind", "dist", "build", ".venv", "venv", "__pycache__", ".next", "target"]);
export const MAX_ARTIFACT_BYTES = 256 * 1024;
export const MAX_ARTIFACTS = 400;

/**
 * The text artifacts under each path, with what was left out and why. Links are
 * not followed; binaries, huge files and anything the credential scanner flags
 * are skipped — a token in a document is not something to learn a job from.
 */
export async function collectArtifacts(paths: readonly string[]): Promise<{ readonly artifacts: readonly Artifact[]; readonly skipped: readonly string[] }> {
  const artifacts: Artifact[] = [];
  const skipped: string[] = [];
  const take = async (path: string, root: string) => {
    // Named from the folder handed in, so two README.md files stay two sources.
    const label = [basename(root), relative(root, path)].filter((p) => p !== "").join("/").split(sep).join("/");
    if (artifacts.length >= MAX_ARTIFACTS) return void skipped.push(`${label} — past ${MAX_ARTIFACTS} artifacts`);
    const info = await lstat(path);
    if (info.isSymbolicLink()) return void skipped.push(`${label} — a link; not followed`);
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(basename(path))) return;
      for (const entry of (await readdir(path)).sort()) await take(join(path, entry), root);
      return;
    }
    if (!info.isFile()) return;
    if (!TEXT_EXT.test(path)) return void skipped.push(`${label} — not a text file this reads`);
    if (info.size > MAX_ARTIFACT_BYTES) return void skipped.push(`${label} — over ${MAX_ARTIFACT_BYTES / 1024} KB`);
    const bytes = new Uint8Array(await readFile(path));
    if (bytes.includes(0)) return void skipped.push(`${label} — binary`);
    if (scanStaged([{ path: label, bytes }]).length > 0) return void skipped.push(`${label} — holds something that looks like a credential; not read`);
    const text = new TextDecoder().decode(bytes);
    if (text.trim() === "") return;
    artifacts.push({ label, text });
  };
  for (const path of paths) {
    try {
      const info = await lstat(path);
      await take(path, info.isDirectory() ? path : join(path, ".."));
    } catch (error) {
      skipped.push(`${path} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { artifacts, skipped };
}

/** An artifact in pieces a local model can read whole, cut at blank lines. */
export function chunkArtifact(artifact: Artifact, max = 6000): readonly Chunk[] {
  const lines = artifact.text.replace(/\r\n?/g, "\n").split("\n");
  const out: Chunk[] = [];
  let start = 0;
  let buf: string[] = [];
  let size = 0;
  const flush = (next: number) => {
    const text = buf.join("\n");
    if (text.trim() !== "") out.push({ label: artifact.label, line: start + 1, text });
    buf = [];
    size = 0;
    start = next;
  };
  lines.forEach((line, i) => {
    if (size + line.length + 1 > max && buf.length > 0 && (line.trim() === "" || size > max * 1.5)) flush(i);
    buf.push(line.length > max ? line.slice(0, max) : line);
    size += Math.min(line.length, max) + 1;
  });
  flush(lines.length);
  return out;
}

/** What the model is told. It is asked for quotes because quotes can be checked. */
export function extractPrompt(chunk: Chunk): { readonly system: string; readonly user: string } {
  return {
    system:
      "You read a work artifact and list what it shows about the JOB it belongs to, so an AI agent can " +
      "take over that job's knowledge. Answer with a JSON array only. Each item is " +
      '{"field": F, "text": T, "quote": Q} where F is one of: "knowledge" (a fact the job relies on), ' +
      '"does" (something the job does), "does_not" (something outside the job), "prohibition" (something ' +
      'the job must never do), "principle" (how the work is done), "tone" (how the person writes, one or two words). ' +
      "T is one short sentence in the artifact's language, about the role, never naming a person. " +
      "Q is copied EXACTLY from the artifact, character for character — the shortest phrase that supports T, " +
      "8 to 80 characters; never retype, translate or tidy it. " +
      "Only what the artifact itself shows; nothing you assume. No credentials, no personal details " +
      "about anyone. At most 12 items. If it shows nothing about the job, answer [].",
    user: `ARTIFACT: ${chunk.label} (from line ${chunk.line})\n\n${chunk.text}`,
  };
}

/** The model's answer as candidate claims; anything malformed is dropped. */
export function readClaims(content: string): readonly { readonly field: ClaimField; readonly text: string; readonly quote: string }[] {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    const i = item as Record<string, unknown>;
    const field = i["field"];
    const text = typeof i["text"] === "string" ? i["text"].trim() : "";
    const quote = typeof i["quote"] === "string" ? i["quote"].trim() : "";
    if (typeof field !== "string" || !FIELDS.includes(field) || text === "" || text.length > 300 || quote.length < 8) return [];
    return [{ field: field as ClaimField, text, quote }];
  });
}

/**
 * Thai writes a vowel above and a tone mark on the same consonant, and the two
 * orders look identical: NFC does not reorder them (the vowel's combining
 * class is 0). Models emit either, so a quote is compared with the vowel first.
 * A missing or changed letter is still a different quote.
 */
const thaiOrder = (s: string) => s.replace(/([\u0E48-\u0E4B])([\u0E31\u0E34-\u0E37\u0E47])/g, "$2$1");
/** Markdown emphasis is how a word was shown, not which word: `**"x"**` and `"x"` quote the same thing. */
const plain = (s: string) => s.replace(/[*_\x60]+/g, "");
const squash = (s: string) => plain(thaiOrder(s.normalize("NFC"))).replace(/[\s\u200b]+/g, " ").trim().toLowerCase();

/**
 * Where in the chunk the quote is, as an artifact line, or `undefined` when it
 * is not there — which makes the claim made up (AC2). Spacing and case are
 * forgiven; words are not.
 */
export function locateQuote(quote: string, chunk: Chunk): number | undefined {
  const q = squash(quote);
  if (q.length < 8) return undefined;
  const lines = chunk.text.split("\n");
  if (!squash(chunk.text).includes(q)) return undefined;
  // The first line from which the rest of the chunk still contains it.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (squash(lines.slice(i).join("\n")).includes(q)) return chunk.line + i;
  }
  return chunk.line;
}

/** Candidate claims → checked claims: quotes located, duplicates folded. */
export function checkClaims(
  candidates: readonly { readonly field: ClaimField; readonly text: string; readonly quote: string }[],
  chunk: Chunk,
  seen: Set<string>,
): { readonly claims: readonly Claim[]; readonly cut: number } {
  const claims: Claim[] = [];
  let cut = 0;
  for (const c of candidates) {
    const line = locateQuote(c.quote, chunk);
    if (line === undefined) {
      cut += 1;
      continue;
    }
    const key = `${c.field}:${squash(c.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({ id: crypto.randomUUID().slice(0, 8), field: c.field, text: c.text, quote: c.quote, source: { label: chunk.label, line }, decision: null });
  }
  return { claims, cut };
}

/** A claim as the line a person reads, source and all. */
export function describeClaim(claim: Claim): string {
  return `[${claim.field}] ${claim.text}\n    from ${claim.source.label}:${claim.source.line} — "${claim.quote}"`;
}

const cite = (c: Claim) => `${c.source.label}:${c.source.line}`;
const addUnique = (list: readonly string[], more: readonly string[]) => {
  const have = new Set(list.map(squash));
  return [...list, ...more.filter((m) => !have.has(squash(m)) && have.add(squash(m)))];
};

/**
 * The soul with the accepted claims in it (AC1, AC3). Role knowledge goes to
 * `role.md` — prohibitions to the list, scope to its two sentences, knowledge
 * to a section of the body with each line's source — and personal traits to
 * `person.md`, and only those. Nothing declined or unanswered is written.
 */
export function adoptClaims(role: SoulRole, person: SoulPerson, draft: Draft): { readonly role: SoulRole; readonly person: SoulPerson; readonly adopted: number } {
  const yes = draft.claims.filter((c) => c.decision === "yes");
  const of = (field: ClaimField) => yes.filter((c) => c.field === field);
  const joinScope = (base: string, more: readonly Claim[]) => [base, ...more.map((c) => c.text)].filter((s) => s.trim() !== "").join("; ");
  const knowledge = of("knowledge");
  const heading = "## From artifacts (S6.1)";
  const lines = knowledge.map((c) => `- ${c.text} — \`${cite(c)}\``);
  let body = role.body;
  if (lines.length > 0) {
    const existing = body.includes(heading) ? body : `${body.replace(/\s*$/, "")}\n\n${heading}\n\nEach line was accepted by the owner and names the artifact it came from.\n`;
    const have = new Set(existing.split("\n").map((l) => squash(l)));
    body = `${existing.replace(/\s*$/, "")}\n${lines.filter((l) => !have.has(squash(l))).join("\n")}\n`;
  }
  return {
    role: {
      ...role,
      prohibitions: addUnique(role.prohibitions, of("prohibition").map((c) => c.text)),
      scope: { does: joinScope(role.scope.does, of("does")), does_not: joinScope(role.scope.does_not, of("does_not")) },
      body,
    },
    person: {
      ...person,
      principles: addUnique(person.principles, of("principle").map((c) => c.text)),
      tone: addUnique(person.tone, of("tone").map((c) => c.text)),
    },
    adopted: yes.length,
  };
}
