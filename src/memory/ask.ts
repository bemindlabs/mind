/**
 * Ask your memory (D-152) — the parts of `mind memory ask` that are words and arithmetic, not processes.
 *
 * The owner, 2026-10-04: *"rag ใน app ควรตอบแบบสรุปไม่ใช้ยกไฟล์มาตอบ"* — RAG in the app answers with a
 * summary, not by quoting files back. So a question gets an answer the agent writes from what recall found,
 * in the asker's language, and a list of where it came from. This file holds what that needs and can be
 * tested without a model: the question's limits, the instruction the model is given, the sources (taken from
 * what the model was handed — never parsed out of what it wrote), and the sentence for "memory has nothing
 * on this".
 *
 * Pure, and kept out of `src/memory/index.ts` on purpose: `erase` reaches the barrel, and nothing here needs
 * to be where `erase` can see it.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReadOnlySpec } from "../exec/registry.ts";
import { ensurePersonalDir, type PersonalEnv } from "../guard/personal.ts";
import type { SubjectId } from "../types.ts";
import type { Attachment } from "./attach.ts";
import { queryTerms } from "./fts.ts";
import type { RecallHit } from "./recall.ts";

/** The longest question taken, in characters. A question, not a document: a pasted file is refused. */
export const ASK_MAX_CHARS = 2000;

/**
 * The longest answer passed on, in characters. The instruction asks for a few sentences; a model that writes
 * pages anyway has stopped summarizing, and the page and the app are not where to find out how long it went on.
 */
export const ASK_ANSWER_MAX_CHARS = 8000;

/**
 * How long the model step of one ask may take, in milliseconds, across every backend the chain tries.
 *
 * Sized for a model on this machine, which is where personal pieces must go (D-095): measured on this
 * machine's qwen3.8 27B (vLLM behind LiteLLM) a summary over a full 4,500-character recall took 2–12 s
 * (`notes/2026-10-04_memory-ask-e2e.md`), a vLLM woken from sleep adds ~2 s, and an ollama loading a model from
 * disk ~30–60 s. Three minutes is room for that and one fallback step; longer, and a hung step holds the page for
 * nothing.
 */
export const ASK_TIMEOUT_MS = 180_000;

/**
 * The cosine (bge-m3, D-007) a piece the vector half alone found must reach to be handed to an ask.
 *
 * The vector half always returns its nearest pieces, however far they are, so without a floor every question
 * reaches a model and every handed piece is a "source". Calibrated 2026-10-05 on the e2e memory
 * (`notes/2026-10-04_memory-ask-e2e.md`): over 7 on-topic questions (English and Thai, three files) the right
 * file's best piece scored 0.562–0.713; over 6 off-topic ones (a dentist, a passport, Mongolia, in both
 * languages) the best piece of any file scored 0.255–0.467. 0.50 sits between, nearer the off-topic side,
 * because a question wrongly answered "nothing in memory" can be asked again more plainly, while a wrong piece
 * handed over is how an answer is invented. Asks only: a turn's recall is unchanged.
 */
export const ASK_COSINE_FLOOR = 0.5;

/**
 * How many distinct query terms (`queryTerms`, stop words already out) a piece the full-text half found must
 * contain to be handed to an ask, when the question has that many. One shared word is how every note matched
 * "what is the *name* of my dentist" — `name:` is in every file's front matter.
 */
export const ASK_FTS_MIN_TERMS = 2;

/**
 * The recalled pieces an ask may hand a model: the full-text half's when they share enough of the question's
 * terms, the vector half's when they are close enough — either is enough. When none survive, the ask takes the
 * no-model path and says memory has nothing on this.
 */
export function relevantForAsk(hits: readonly RecallHit[], question: string): readonly RecallHit[] {
  const terms = askTerms(question);
  const need = Math.min(ASK_FTS_MIN_TERMS, terms.length);
  return hits.filter((hit) => {
    if (hit.cosine !== undefined && hit.cosine >= ASK_COSINE_FLOOR) return true;
    if (!hit.via.includes("fts") || need === 0) return false;
    const text = `${hit.heading}\n${hit.text}`.toLowerCase();
    return terms.filter((term) => text.includes(term)).length >= need;
  });
}

/** Thai words that say how a question is asked, not what it is about — the Thai half of `STOPWORDS`. */
const THAI_STOPWORDS: ReadonlySet<string> = new Set(
  "และ หรือ ที่ ของ ไว้ กี่ ไหร่ เท่าไหร่ เท่า อะไร ไหม มั้ย ได้ ให้ ใน มี เป็น คือ จะ ว่า กับ แล้ว นี้ นั้น ตอน ทำไม อย่างไร ยังไง ไหน ใคร เมื่อไร เมื่อไหร่ บ้าง ครับ ค่ะ คะ".split(" "),
);
const THAI_WORDS = new Intl.Segmenter("th", { granularity: "word" });

/**
 * The terms the full-text check counts (D-152): `queryTerms` for spaced scripts, and for Thai the words ICU cuts
 * the run into — "สำรองข้อมูลทุกคืนตอนกี่โมง" is สำรอง · ข้อมูล · ทุก · คืน · โมง, not the overlapping 4-character
 * windows the index searches by, which made one Thai word count as several terms.
 */
export function askTerms(question: string): readonly string[] {
  const out: string[] = [];
  for (const term of queryTerms(question.replace(/[\u0E00-\u0E7F]+/g, " "))) out.push(term);
  for (const run of question.match(/[\u0E00-\u0E7F]+/g) ?? []) {
    for (const piece of THAI_WORDS.segment(run)) {
      if (piece.isWordLike && [...piece.segment].length >= 2 && !THAI_STOPWORDS.has(piece.segment)) out.push(piece.segment);
    }
  }
  return [...new Set(out)];
}

/**
 * True when a backend's read-only flags leave it **no tools at all** — the only restraint an ask runs under
 * (D-152 review). Read-only is not enough: a read tool reads `~/.secrets` as readily as `memory/`, and a memory
 * note can ask it to. Today that is claude's empty `--tools ""` allow list (and so claude-local's), measured to
 * remove every built-in tool (registry, 2026-09-21). grok's allow list keeps read_file, grep and list_dir, and an
 * empty grok list has not been measured — the registry records that grok accepts unknown names silently — so grok
 * and grok-local are not used for an ask until it is. ollama is given no tools by construction and is admitted
 * separately.
 */
export function noToolsWhenRestrained(spec: ReadOnlySpec): boolean {
  return spec.kind === "allow-tools" && spec.values.length === 1 && spec.values[0] === "";
}

/**
 * How long the web route's `memory ask` child gets after SIGTERM before its group gets SIGKILL, in milliseconds
 * (`src/web/deadline.ts`). Longer than `CliExec`'s own SIGTERM-to-SIGKILL grace for the vendor it runs (D-044,
 * 4 s), so the CLI can end its backend and print why before its own group is killed. A vendor that ignores SIGTERM would otherwise
 * hold the one-ask-per-agent slot (409) for good, and the deadline's 504 would never come.
 */
export const ASK_KILL_GRACE_MS = 10_000;

/** What an excerpt of a piece may be, in characters — the same cut `memory search` prints. */
export const PIECE_EXCERPT_CHARS = 240;

/**
 * The word the model is told to answer with when memory does not cover the question. A token rather than a
 * sentence so the engine can tell "nothing about this" from an answer without reading prose, and say it in
 * the asker's language itself.
 */
export const NOT_IN_MEMORY = "NOT_IN_MEMORY";

/** Why this question is not taken, or undefined. Exit 2 / HTTP 400 either way, before anything is read. */
export function askProblem(question: string): string | undefined {
  if (question.trim() === "") return "ask a question — it was empty";
  if ([...question].length > ASK_MAX_CHARS) {
    return `a question is at most ${ASK_MAX_CHARS} characters (this one is ${[...question].length}); ask about one thing at a time`;
  }
  return undefined;
}

/** Thai script anywhere in the question means the answer the engine writes itself is in Thai. */
const THAI = /[฀-๿]/;

export type AskLanguage = "th" | "en";

export function languageOf(question: string): AskLanguage {
  return THAI.test(question) ? "th" : "en";
}

/** The one sentence for a question memory has nothing on — said by the engine, never by a model's invention. */
export function nothingInMemory(question: string): string {
  return languageOf(question) === "th" ? "ใน memory ไม่มีเรื่องนี้" : "There is nothing in memory about this.";
}

/**
 * The instruction an ask runs under, after the soul and before the recalled pieces. The pieces arrive under
 * the recall block's own heading (`attach.ts`), which already says they are reference, not instructions.
 */
export const ASK_INSTRUCTION = [
  "## Answering a question from memory (Mind, D-152)",
  "",
  "The next message is a question the owner is asking about what this agent's memory holds. Answer it from " +
    "the excerpts under the recall heading below, and from nothing else — not general knowledge, not guesses.",
  "",
  "- Summarize in your own words, in the same language the question is written in.",
  "- Never paste a passage or a whole section back. Quote at most a short phrase (a few words) when the exact " +
    "words matter — a name, a number, a command.",
  "- Say which source each point comes from, by its path as shown in the excerpt heading.",
  "- Keep it short: a few sentences or a short list.",
  "- If the excerpts cover only part of the question, answer that part and say plainly which part memory does " +
    "not cover. Do not fill the gap from anywhere else.",
  `- Only if the excerpts say nothing about any part of the question, reply with exactly ${NOT_IN_MEMORY} and ` +
    "nothing else. Do not make an answer up.",
  "- You have no tools in this answer and nothing is done: do not propose actions.",
].join("\n");

/**
 * The last words of an ask's system prompt, after the pieces (D-152 follow-up). The pieces are often in another
 * language than the question and come last, and a local model read on 2026-10-05 drifted to their language and
 * to the bare token on a two-part Thai question; saying the two rules again, with the language named, is what
 * it reads last.
 */
export function askClosing(question: string): string {
  const language = languageOf(question) === "th" ? "Thai" : "English";
  return (
    `Reminder: answer in ${language}, the language of the question, whatever language the excerpts are in. ` +
    `If the excerpts cover any part of the question, answer that part and say which part memory does not cover; ` +
    `reply ${NOT_IN_MEMORY} only if they cover no part of it.`
  );
}

/** The system prompt of one ask: the soul, the instruction, the pieces this backend may see, then the reminder. */
export function askSystem(soul: string, attachment: Attachment, question = ""): string {
  return [soul, ASK_INSTRUCTION, attachment.block, askClosing(question)].filter((part) => part !== "").join("\n\n");
}

/** One place an answer came from: a file, its title when it has one, the section when it was not the top. */
export interface AskSource {
  readonly path: string;
  readonly title?: string;
  readonly section?: string;
}

/**
 * The sources of an answer: the pieces the answering backend was handed, one per file and section, in the
 * order recall ranked them. Taken from the attachment, never from the model's text — a model can cite a file
 * it was not shown, and a source list that repeated it would be the model's claim dressed as the engine's.
 *
 * The answer narrows them, never widens them: when it names the path of one or more handed pieces, only those
 * files' pieces are listed (a file it was not handed is not added, whatever it says); when it names none, every
 * handed piece is.
 */
export function sourcesOf(attachment: Attachment, titles: ReadonlyMap<string, string> = new Map(), answer = ""): readonly AskSource[] {
  const seen = new Set<string>();
  const out: AskSource[] = [];
  const cited = new Set(attachment.attached.map((a) => a.path).filter((path) => answer.includes(path)));
  for (const piece of attachment.attached) {
    if (cited.size > 0 && !cited.has(piece.path)) continue;
    const key = `${piece.path}\0${piece.heading}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = titles.get(piece.path);
    out.push({
      path: piece.path,
      ...(title === undefined || title === "" ? {} : { title }),
      ...(piece.heading === "" ? {} : { section: piece.heading }),
    });
  }
  return out;
}

/** One piece as the "show the pieces it read" toggle shows it: where, and its first words — never the whole. */
export interface AskPiece {
  readonly path: string;
  readonly section?: string;
  readonly excerpt: string;
}

export function piecesOf(hits: readonly { readonly path: string; readonly heading: string; readonly text: string }[], attachment: Attachment): readonly AskPiece[] {
  const handed = new Set(attachment.attached.map((a) => `${a.path}\0${a.heading}`));
  const out: AskPiece[] = [];
  const used = new Set<string>();
  for (const hit of hits) {
    const key = `${hit.path}\0${hit.heading}`;
    // Only what this backend was handed, and each piece once even when two pieces share a heading.
    if (!handed.has(key)) continue;
    const flat = hit.text.replace(/\s+/g, " ").trim();
    const excerpt = flat.length > PIECE_EXCERPT_CHARS ? `${flat.slice(0, PIECE_EXCERPT_CHARS)}…` : flat;
    const id = `${key}\0${excerpt}`;
    if (used.has(id)) continue;
    used.add(id);
    out.push({ path: hit.path, ...(hit.heading === "" ? {} : { section: hit.heading }), excerpt });
  }
  return out;
}

/**
 * What the model wrote, as the answer (D-152 follow-up).
 *
 * - Reasoning blocks some local models print are dropped.
 * - **The token alone** — or opening a reply whose rest is a few words and names no handed file — is
 *   `covered: false`: memory has nothing on this.
 * - **The token first, then a real answer** — substantial prose, or a path the model was handed — is covered:
 *   the model hedged, then answered. The token is dropped.
 * - **The token inside an answer** (a part memory does not cover): on a line of its own, or closing the answer,
 *   it is dropped; inline ("Retention: NOT_IN_MEMORY.") it becomes the words for it in the question's language,
 *   so no "Retention: ." is left behind.
 *
 * An answer past {@link ASK_ANSWER_MAX_CHARS} is cut there and says so.
 */
export function readAnswer(text: string, handed: readonly string[] = [], question = ""): { readonly covered: boolean; readonly answer: string } {
  const answer = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!answer.includes(NOT_IN_MEMORY)) return { covered: answer !== "", answer: capAnswer(answer) };
  const opens = answer.replace(/^[\s`*_>"'(\[-]+/, "").startsWith(NOT_IN_MEMORY);
  const without = answer.split(NOT_IN_MEMORY).join(" ");
  const substance = [...without.replace(/[\s\p{P}\p{S}]/gu, "")].length;
  const cites = handed.some((path) => answer.includes(path));
  // Opening with the token, the rest has to be an answer in its own right; inside an answer, any content beside
  // the token is the covered part of a question memory covers only in part.
  if (!cites && substance < (opens ? ASK_HEDGE_MIN_CHARS : ASK_PART_MIN_CHARS)) return { covered: false, answer: "" };
  const said = languageOf(question) === "th" ? "ไม่มีใน memory" : "not in memory";
  const cleaned = answer
    // The token on a line of its own, or as the first thing said.
    .replace(/(^|\n)[\s>*_`-]*NOT_IN_MEMORY[\s*_`.:—-]*(?=\n|$)/g, "$1")
    .replace(/^[\s>*_`"'(\[-]*NOT_IN_MEMORY[\s*_`.:—-]*/, "")
    // Closing the answer, after a sentence that ended.
    .replace(/([.!?。)])[\s*_`]*NOT_IN_MEMORY[\s*_`.]*$/, "$1")
    // Inline: the words for it.
    .replace(/[`*_]*NOT_IN_MEMORY[`*_]*/g, said)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { covered: cleaned !== "", answer: capAnswer(cleaned) };
}

/**
 * How much must follow an opening {@link NOT_IN_MEMORY}, in letters and digits, for the reply to be read as an
 * answer that hedged first rather than a "not in memory" with a remark after it. About one full sentence.
 */
export const ASK_HEDGE_MIN_CHARS = 80;

/** What must stand beside a {@link NOT_IN_MEMORY} inside a reply for it to be a partial answer: a few letters. */
export const ASK_PART_MIN_CHARS = 8;

/** At most {@link ASK_ANSWER_MAX_CHARS} characters, with an ellipsis where it was cut. */
export function capAnswer(answer: string): string {
  const chars = [...answer];
  return chars.length <= ASK_ANSWER_MAX_CHARS ? answer : `${chars.slice(0, ASK_ANSWER_MAX_CHARS - 1).join("")}…`;
}

/**
 * The longest run of words the answer shares, in order, with any one piece — what "pasted back" means,
 * measured. Words are compared lower-cased with punctuation dropped; Thai, which has no spaces, is compared
 * as runs of characters cut into 4-character words so a copied Thai sentence is caught too.
 */
export function longestCopiedRun(answer: string, pieces: readonly string[]): number {
  const words = (text: string): string[] =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .flatMap((word) => (THAI.test(word) && word.length > 4 ? (word.match(/.{1,4}/gu) ?? []) : [word]))
      .filter((word) => word !== "");
  const said = words(answer);
  let best = 0;
  for (const piece of pieces) {
    const source = words(piece);
    // Longest common substring over words, one row at a time.
    let previous = new Array<number>(source.length + 1).fill(0);
    for (let i = 1; i <= said.length; i += 1) {
      const row = new Array<number>(source.length + 1).fill(0);
      for (let j = 1; j <= source.length; j += 1) {
        if (said[i - 1] === source[j - 1]) {
          row[j] = previous[j - 1]! + 1;
          if (row[j]! > best) best = row[j]!;
        }
      }
      previous = row;
    }
  }
  return best;
}

/**
 * One ask's recall, in numbers (D-152 follow-up) — so {@link ASK_COSINE_FLOOR}, calibrated on a three-file test
 * memory, can be re-checked on the owner's real one. **No text**: no question, no path, no heading — a count, a
 * cosine and a yes/no carry nothing of what was asked or found.
 */
export interface AskRecallRecord {
  readonly v: 1;
  readonly at: string;
  readonly scope: "all" | "memory" | "knowledge";
  /** Pieces recall returned, before the ask's floors. */
  readonly recalled: number;
  /** Whether the vector half answered; when it did not, `best_cosine` is null and says nothing about the floor. */
  readonly vector: boolean;
  /** The highest cosine among the pieces the vector half returned, rounded to 3 places, or null. */
  readonly best_cosine: number | null;
  readonly floor: number;
  /** Pieces left after the floors, and how many of them fit the ceiling a local backend is handed. */
  readonly kept: number;
  readonly handed: number;
  /** False on the no-model path: nothing about the question was left. */
  readonly model_asked: boolean;
}

export function askRecallRecord(parts: {
  readonly at: Date;
  readonly scope: AskRecallRecord["scope"];
  readonly hits: readonly RecallHit[];
  readonly vector: boolean;
  readonly kept: number;
  readonly handed: number;
}): AskRecallRecord {
  const cosines = parts.hits.map((hit) => hit.cosine).filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  return {
    v: 1,
    at: parts.at.toISOString(),
    scope: parts.scope,
    recalled: parts.hits.length,
    vector: parts.vector,
    best_cosine: cosines.length === 0 ? null : Math.round(Math.max(...cosines) * 1000) / 1000,
    floor: ASK_COSINE_FLOOR,
    kept: parts.kept,
    handed: parts.handed,
    model_asked: parts.handed > 0,
  };
}

/** Where the records go: the subject's personal directory (outside git, 0700; `erase` removes it whole). */
export const ASK_DIR = "ask";
export const ASK_RECALL_FILE = "recall.jsonl";

/** Append one record; the path written, or the reason it was not. Never throws: a counter must not stop an ask. */
export async function appendAskRecall(env: PersonalEnv, subject: SubjectId, record: AskRecallRecord): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }> {
  try {
    const dir = await ensurePersonalDir(env, subject);
    if (!dir.ok) return { ok: false, reason: dir.reason };
    const ask = join(dir.path, ASK_DIR);
    await mkdir(ask, { recursive: true, mode: 0o700 });
    const path = join(ask, ASK_RECALL_FILE);
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return { ok: true, path };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
