/**
 * A unified diff, with no dependency and one strict rule about its inputs.
 *
 * AC3 asks for a diff before every write. The rule that makes that worth
 * anything: what is diffed here is *the bytes currently on disk* against *the
 * bytes about to be written* — never a model of what Mind thinks it changed.
 * A diff generated from intent shows what was meant; a diff generated from the
 * two files shows what will happen, including the parts that were a mistake.
 *
 * The algorithm is plain LCS over lines after trimming the common prefix and
 * suffix. For the shape of edit this command makes — a block appended or
 * replaced at the end of a file — the trimming leaves a handful of lines, so
 * the quadratic table never gets large. When a pathological pair *would* make
 * it large, the ceiling below turns the detailed hunk into an honest summary
 * rather than spending a minute building one nobody asked for.
 */

/** Ceiling on the LCS table. Past this, report a summary instead of hunks. */
const MAX_CELLS = 400_000;

/** How the diff should be labelled and how much unchanged context to show. */
export interface DiffOptions {
  readonly beforeLabel?: string;
  readonly afterLabel?: string;
  readonly context?: number;
}

/** Lines added and removed, without building the diff text. */
export interface DiffStat {
  readonly added: number;
  readonly removed: number;
}

function toLines(text: string): readonly string[] {
  return text === "" ? [] : text.split("\n");
}

type Op = { readonly kind: " " | "-" | "+"; readonly text: string };

/** Longest-common-subsequence edit script over two line arrays. */
function editScript(before: readonly string[], after: readonly string[]): Op[] {
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        before[i] === after[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: " ", text: before[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      ops.push({ kind: "-", text: before[i]! });
      i++;
    } else {
      ops.push({ kind: "+", text: after[j]! });
      j++;
    }
  }
  while (i < before.length) ops.push({ kind: "-", text: before[i++]! });
  while (j < after.length) ops.push({ kind: "+", text: after[j++]! });
  return ops;
}

/** Common leading and trailing lines, so LCS only sees the part that moved. */
function trim(before: readonly string[], after: readonly string[]): {
  readonly prefix: number;
  readonly suffix: number;
} {
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix++;
  }
  return { prefix, suffix };
}

/** Count added and removed lines. Cheap enough to call on every target. */
export function diffStat(before: string, after: string): DiffStat {
  if (before === after) return { added: 0, removed: 0 };
  const a = toLines(before);
  const b = toLines(after);
  const { prefix, suffix } = trim(a, b);
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length * midB.length > MAX_CELLS) {
    return { added: midB.length, removed: midA.length };
  }
  const ops = editScript(midA, midB);
  return {
    added: ops.filter((op) => op.kind === "+").length,
    removed: ops.filter((op) => op.kind === "-").length,
  };
}

/**
 * Render a unified diff of `before` → `after`.
 *
 * @returns The diff text, or an empty string when the two are identical.
 */
export function unifiedDiff(before: string, after: string, options: DiffOptions = {}): string {
  if (before === after) return "";

  const context = options.context ?? 3;
  const a = toLines(before);
  const b = toLines(after);
  const { prefix, suffix } = trim(a, b);
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const header = [
    `--- ${options.beforeLabel ?? "before"}`,
    `+++ ${options.afterLabel ?? "after"}`,
  ];

  if (midA.length * midB.length > MAX_CELLS) {
    return [
      ...header,
      `@@ -${prefix + 1},${midA.length} +${prefix + 1},${midB.length} @@`,
      `[too large to diff line by line: ${midA.length} line(s) replaced by ${midB.length}]`,
    ].join("\n");
  }

  // Re-attach just enough of the trimmed prefix and suffix to give context.
  const leadCount = Math.min(context, prefix);
  const trailCount = Math.min(context, suffix);
  const ops: Op[] = [
    ...a.slice(prefix - leadCount, prefix).map((text) => ({ kind: " " as const, text })),
    ...editScript(midA, midB),
    ...a.slice(a.length - suffix, a.length - suffix + trailCount).map((text) => ({ kind: " " as const, text })),
  ];

  const oldStart = prefix - leadCount + 1;
  const newStart = prefix - leadCount + 1;
  const oldCount = ops.filter((op) => op.kind !== "+").length;
  const newCount = ops.filter((op) => op.kind !== "-").length;

  return [
    ...header,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...ops.map((op) => `${op.kind}${op.text}`),
  ].join("\n");
}
