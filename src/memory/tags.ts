/**
 * Collections (D-091): a memory's `tags:` in its front matter. Each tag is a collection — Infra, Agents,
 * Policies — and a memory may be in several. Kept in the file, so git has them and any editor can change
 * them; nothing else stores which memory is in which collection.
 */

export const MAX_TAGS = 12;

/** A tag as it is kept: lower case, letters (Thai too), digits, "-" and "_", at most 30 characters. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9฀-๿_-]/g, "")
    .slice(0, 30);
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** The tags a front matter block names: `tags: [a, b]`, `tags: a, b`, or a `- a` list under `tags:`. */
export function tagsOf(text: string): string[] {
  const fm = FRONT.exec(text)?.[1];
  if (fm === undefined) return [];
  const lines = fm.split(/\r?\n/);
  const at = lines.findIndex((l) => /^tags:/.test(l));
  if (at < 0) return [];
  const rest = lines[at]!.slice("tags:".length).trim();
  let raw: string[];
  if (rest !== "") raw = rest.replace(/^\[|\]$/g, "").split(",");
  else {
    // A block list: the "- item" lines right under "tags:".
    raw = [];
    for (const line of lines.slice(at + 1)) {
      if (!/^\s+-\s/.test(line)) break;
      raw.push(line.replace(/^\s+-\s/, ""));
    }
  }
  return [...new Set(raw.map((t) => normalizeTag(t.replace(/^["']|["']$/g, ""))).filter((t) => t !== ""))].slice(0, MAX_TAGS);
}

/** The text with its tags set to these — front matter added when there is none, the line dropped when empty. */
export function withTags(text: string, tags: readonly string[]): string {
  const clean = [...new Set(tags.map(normalizeTag).filter((t) => t !== ""))].slice(0, MAX_TAGS);
  const line = clean.length === 0 ? null : `tags: [${clean.join(", ")}]`;
  const m = FRONT.exec(text);
  if (m === null) return line === null ? text : `---\n${line}\n---\n\n${text}`;
  const lines = m[1]!.split(/\r?\n/);
  const at = lines.findIndex((l) => /^tags:/.test(l));
  if (at >= 0) {
    let end = at + 1;
    if (lines[at]!.slice(5).trim() === "") while (end < lines.length && /^\s+-\s/.test(lines[end]!)) end += 1;
    lines.splice(at, end - at, ...(line === null ? [] : [line]));
  } else if (line !== null) {
    // After the description when there is one, so the name and what it is stay first.
    const after = lines.findIndex((l) => /^description:/.test(l));
    lines.splice(after >= 0 ? after + 1 : lines.length, 0, line);
  }
  return `---\n${lines.join("\n")}\n---\n${text.slice(m[0].length)}`;
}
