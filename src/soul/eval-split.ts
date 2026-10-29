/**
 * S21.2 — propose a train / held-out split of a task set (owner ruling T3).
 *
 * `mind eval split` picks `n` held-out tasks stratified by `kind`: each kind
 * gets its share of `n` by largest remainder, so a kind with a quarter of the
 * tasks has about a quarter of the held-out ones and no kind is judged only on
 * what a tuner saw. Within a kind the order is sha256(seed, id): the same seed
 * gives the same split whatever order the file lists its tasks in, and a new
 * seed gives a new draw.
 *
 * The split is printed, and written into `evals.md` only on `--write`. The task
 * set is the owner's file in git; Mind changes the text, the owner commits it.
 */

import { EVALS_SCHEMA, parseEvals, type EvalTask } from "./evals.ts";
import { DELIMITER } from "./frontmatter.ts";

export const DEFAULT_SEED = "mind";

export interface SplitProposal {
  readonly seed: string;
  readonly heldout: readonly string[];
  /** One row per kind, in kind order: its held-out and train task ids. */
  readonly byKind: readonly { readonly kind: string; readonly heldout: readonly string[]; readonly train: readonly string[] }[];
}

const draw = (seed: string, id: string) => new Bun.CryptoHasher("sha256").update(`${seed}\0${id}`).digest("hex");

/** `--heldout`: a whole number from 1 to tasks − 1 (a split with no train side, or no held-out side, is not one). */
export function parseHeldout(raw: string | undefined, tasks: number): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string } {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isInteger(n) || n < 1 || n >= tasks) {
    return { ok: false, reason: `--heldout is a whole number from 1 to ${Math.max(1, tasks - 1)} (the set has ${tasks} task(s)), not ${JSON.stringify(raw ?? "")}` };
  }
  return { ok: true, value: n };
}

/** `n` held-out tasks, stratified by kind, the draw fixed by `seed`. */
export function proposeSplit(tasks: readonly EvalTask[], n: number, seed = DEFAULT_SEED): SplitProposal {
  const kinds = [...new Set(tasks.map((t) => t.kind))].sort();
  const sizes = kinds.map((kind) => tasks.filter((t) => t.kind === kind).length);
  const exact = sizes.map((size) => (n * size) / tasks.length);
  const share = exact.map(Math.floor);
  // Largest remainder; ties to the larger kind, then the earlier name.
  const order = kinds.map((_, i) => i).sort((a, b) => exact[b]! - share[b]! - (exact[a]! - share[a]!) || sizes[b]! - sizes[a]! || a - b);
  for (let left = n - share.reduce((a, b) => a + b, 0), i = 0; left > 0; left--, i++) share[order[i]!]! += 1;
  const byKind = kinds.map((kind, i) => {
    const ids = tasks.filter((t) => t.kind === kind).map((t) => t.id).sort((a, b) => (draw(seed, a) < draw(seed, b) ? -1 : 1));
    return { kind, heldout: ids.slice(0, share[i]).sort(), train: ids.slice(share[i]).sort() };
  });
  return { seed, heldout: tasks.map((t) => t.id).filter((id) => byKind.some((k) => k.heldout.includes(id))), byKind };
}

/** The proposal as printed. */
export function proposalLines(p: SplitProposal, total: number): string[] {
  const out = [`${p.heldout.length} of ${total} task(s) held out, stratified by kind, seed ${JSON.stringify(p.seed)}:`];
  for (const k of p.byKind) out.push(`  ${k.kind.padEnd(18)} heldout ${k.heldout.join(", ") || "—"}   train ${k.train.join(", ") || "—"}`);
  return out;
}

const HEADER = /^\s*\[\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/;
const SPLIT_LINE = /^\s*split\s*=/;
const SCHEMA_LINE = /^(\s*schema\s*=\s*)(["'])mind\/evals@1\2(.*)$/;

/**
 * The task set's text with exactly the given tasks held out: a `split =
 * "heldout"` line under each of their headers, any other `split` line gone
 * (train is the default), and the schema raised to `mind/evals@2`. Checked by
 * parsing the result back; a set written in a shape this cannot edit (an
 * inline table, a dotted key) is refused with the reason, never half-written.
 */
export function applySplit(text: string, heldout: ReadonlySet<string>): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const lines = text.split("\n");
  const open = lines.findIndex((l) => l.trim() === DELIMITER);
  const close = open === -1 ? -1 : lines.findIndex((l, i) => i > open && l.trim() === DELIMITER);
  if (close === -1) return { ok: false, reason: `no ${DELIMITER} frontmatter to edit` };
  const out: string[] = lines.slice(0, open + 1);
  let inTask = false;
  for (const line of lines.slice(open + 1, close)) {
    const header = HEADER.exec(line);
    if (header !== null) {
      const id = header[1] ?? header[2] ?? header[3] ?? "";
      inTask = true;
      out.push(line);
      if (heldout.has(id)) out.push('split = "heldout"');
      continue;
    }
    if (inTask && SPLIT_LINE.test(line)) continue;
    const schema = SCHEMA_LINE.exec(line);
    out.push(schema === null ? line : `${schema[1]}${schema[2]}${EVALS_SCHEMA}${schema[2]}${schema[3]}`);
  }
  out.push(...lines.slice(close));
  const result = out.join("\n");
  const back = parseEvals("evals.md", result);
  if (!back.ok) return { ok: false, reason: `the edited set would not parse: ${back.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}` };
  const wrong = back.value.filter((t) => (t.split === "heldout") !== heldout.has(t.id)).map((t) => t.id);
  const unknown = [...heldout].filter((id) => !back.value.some((t) => t.id === id));
  if (wrong.length > 0 || unknown.length > 0) return { ok: false, reason: `could not place split on ${[...wrong, ...unknown].join(", ")} — write split = "heldout" under those tasks by hand` };
  return { ok: true, text: result };
}
