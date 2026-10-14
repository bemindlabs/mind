/**
 * Knowledge distilled from what is already in memory (D-093): a local model reads memory files and offers
 * short, standalone facts — each with the words it came from — and a person says yes or no to each one.
 * Only the yeses are written, as notes in `memory/knowledge/facts/<topic>.md`.
 *
 * The same discipline as persona drafts (S6.1, D-072): every fact carries a quote copied from its source,
 * and a fact whose quote is not in the text it was read from is cut, never offered — a model that
 * invents is caught by arithmetic, not by trust. Nothing is written without a person's yes.
 */

import { chunkArtifact, locateQuote, type Chunk } from "../soul/extract.ts";
import { KNOWLEDGE_DIR } from "./kinds.ts";
import { normalizeTag } from "./tags.ts";

export const FACTS_DIR = `${KNOWLEDGE_DIR}/facts`;

export interface Fact {
  readonly id: string;
  /** One standalone sentence, true without the rest of the note. */
  readonly fact: string;
  readonly quote: string;
  /** A collection name for it — the file it would go to. */
  readonly topic: string;
  readonly source: { readonly path: string; readonly line: number };
  readonly decision: "yes" | "no" | null;
}

export interface FactDraft {
  readonly v: 1;
  readonly id: string;
  readonly at: string;
  readonly subject: string;
  readonly model: string;
  readonly sources: readonly string[];
  readonly chunks: number;
  /** Facts offered whose quote was not in the text they came from — cut. */
  readonly cut: number;
  readonly facts: readonly Fact[];
}

/** The pieces a memory file is read in. */
export function factChunks(path: string, text: string): readonly Chunk[] {
  return chunkArtifact({ label: path, text }, 5000);
}

export function distillPrompt(chunk: Chunk): { readonly system: string; readonly user: string } {
  return {
    system:
      "You read a note from an agent's memory and pull out the FACTS in it worth keeping as reference knowledge: " +
      "how something is set up, where something lives, which port or path or command does what, a rule that holds. " +
      'Answer with a JSON array only. Each item is {"fact": F, "quote": Q, "topic": T}. ' +
      "F is one short sentence that is true on its own, in the note's language. " +
      "Q is copied EXACTLY from the note, character for character — the shortest phrase that supports F, 8 to 120 " +
      "characters; never retype, translate or tidy it. T is one or two lower-case words naming the subject area " +
      "(for example: ports, vllm, backups, telegram). Only what the note itself says; nothing you assume. " +
      "No credentials, tokens or passwords, even if the note has them. No opinions, plans or feelings. " +
      "At most 12 items. If the note holds no such fact, answer [].",
    user: `NOTE: ${chunk.label} (from line ${chunk.line})\n\n${chunk.text}`,
  };
}

/** The facts a model's reply offers, shape-checked; anything else in the reply is ignored. */
export function readFacts(content: string): readonly { readonly fact: string; readonly quote: string; readonly topic: string }[] {
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
    const i = (item ?? {}) as Record<string, unknown>;
    const fact = typeof i["fact"] === "string" ? i["fact"].trim() : "";
    const quote = typeof i["quote"] === "string" ? i["quote"].trim() : "";
    const topic = normalizeTag(typeof i["topic"] === "string" ? i["topic"] : "") || "general";
    if (fact === "" || fact.length > 300 || quote.length < 8 || quote.length > 200) return [];
    return [{ fact, quote, topic }];
  });
}

const squashFact = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.。]+$/, "").trim();

/** Keep the facts whose quote is in the chunk, once each; count the ones that are not. */
export function checkFacts(
  offered: readonly { readonly fact: string; readonly quote: string; readonly topic: string }[],
  chunk: Chunk,
  seen: Set<string>,
): { readonly facts: readonly Fact[]; readonly cut: number } {
  const facts: Fact[] = [];
  let cut = 0;
  for (const f of offered) {
    const line = locateQuote(f.quote, chunk);
    if (line === undefined) {
      cut += 1;
      continue;
    }
    const key = squashFact(f.fact);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ id: crypto.randomUUID().slice(0, 8), fact: f.fact, quote: f.quote, topic: f.topic, source: { path: chunk.label, line }, decision: null });
  }
  return { facts, cut };
}

/**
 * The notes the yeses become: one per topic, `memory/knowledge/facts/<topic>.md`, each fact a line citing
 * where it came from. A note already there keeps what it has and gains the lines it lacks.
 */
export function factNotes(draft: FactDraft, existing: (path: string) => string | undefined, now: Date): readonly { readonly path: string; readonly text: string; readonly added: number }[] {
  const byTopic = new Map<string, Fact[]>();
  for (const f of draft.facts) if (f.decision === "yes") byTopic.set(f.topic, [...(byTopic.get(f.topic) ?? []), f]);
  const out: { path: string; text: string; added: number }[] = [];
  for (const [topic, facts] of [...byTopic].sort((a, b) => a[0].localeCompare(b[0]))) {
    const path = `${FACTS_DIR}/${topic}.md`;
    const before = existing(path);
    const lines = facts.map((f) => `- ${f.fact} — \`${f.source.path}:${f.source.line}\``);
    const fresh = before === undefined ? lines : lines.filter((l) => !before.includes(l.slice(0, l.lastIndexOf(" — `"))));
    if (fresh.length === 0) continue;
    const title = topic.replace(/-/g, " ");
    const head =
      before ??
      [
        "---",
        `name: ${JSON.stringify(`Facts — ${title}`)}`,
        `description: ${JSON.stringify(`Standalone facts about ${title}, each confirmed by a person and citing the memory it came from.`)}`,
        `tags: [facts, ${topic}]`,
        "metadata:",
        "  type: reference",
        "---",
        "",
        `# Facts — ${title}`,
        "",
        `Distilled from memory and confirmed one by one (\`mind memory distill\`, D-093). First written ${now.toISOString().slice(0, 10)}.`,
        "",
      ].join("\n");
    out.push({ path, text: `${head.replace(/\n*$/, "\n")}${fresh.join("\n")}\n`, added: fresh.length });
  }
  return out;
}
