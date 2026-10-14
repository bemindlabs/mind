/**
 * The import map — where the judgement calls live, so the engine holds none.
 *
 * Deciding that "call the user X" is a personal trait while "which port range
 * to use" is role knowledge is a judgement about *one particular agent*. Put
 * that table in `src/` and the engine now contains its owner's filenames and
 * the owner's reading of them, which D-021.1 forbids outright; put it in a
 * committed fixture and D-021.2 forbids it too. So the table is input: a TOML
 * file passed on the command line, living wherever the person who made those
 * calls keeps it.
 *
 * What stays in the engine is only the vocabulary — `role`, `person`, `skip`,
 * and the shape of a README — which is the same for every agent.
 *
 * **There is no default destination.** A source file absent from the map fails
 * the import by name. A default of `person` would quietly pour a whole
 * directory into the file that `erase --personal` deletes; a default of `role`
 * would quietly leak traits the other way. Both are silent, and a silent
 * mistake in this particular table is the one I-5 exists to prevent.
 */

import type { SoulIssue } from "./schema.ts";
import { parseTomlDocument } from "./frontmatter.ts";

/** Where one source file lands. Three values, no fourth, no default. */
export type Destination = "role" | "person" | "skip";

const DESTINATIONS: readonly Destination[] = ["role", "person", "skip"];

/**
 * How to read the agent's persona README.
 *
 * Labels rather than logic, for the same reason the classification is: a
 * README's section headings and table rows are written in the agent's own
 * language, and an engine that hard-codes them is an engine that only works
 * for the agent it was written against.
 */
export interface ReadmeRules {
  /** Identity-table row label whose value is how the agent addresses the user. */
  readonly addresses_user_as_row: string;
  /** Identity-table row label whose value is what the agent calls itself. */
  readonly refers_to_self_as_row: string;
  /** `##` section whose bullets are the agent's tone. Personal. */
  readonly tone_section: string;
  /** `##` section whose list is the agent's principles. Personal. */
  readonly principles_section: string;
  /** `##` section whose bullets are hard prohibitions. Role knowledge. */
  readonly constraints_section: string;
}

/** A parsed, validated import map. */
export interface ImportMap {
  /** Path as given on the command line, for error messages. */
  readonly file: string;
  /** Source path (posix, relative to the agent dir) → destination. */
  readonly classify: ReadonlyMap<string, Destination>;
  readonly readme: ReadmeRules;
  /** Source path → the line of the map it was declared on. */
  readonly lines: ReadonlyMap<string, number>;
}

/** Either the map, or every reason it was refused. */
export type ImportMapResult =
  | { readonly ok: true; readonly map: ImportMap }
  | { readonly ok: false; readonly issues: readonly SoulIssue[] };

const README_KEYS: readonly (keyof ReadmeRules)[] = [
  "addresses_user_as_row",
  "refers_to_self_as_row",
  "tone_section",
  "principles_section",
  "constraints_section",
];

/** Parse an import map from text. */
export function parseImportMap(file: string, text: string): ImportMapResult {
  const parsed = parseTomlDocument(file, text);
  if (!parsed.ok) return parsed;

  const { table, lines } = parsed.value;
  const issues: SoulIssue[] = [];
  const at = (path: string): number => lines.get(path) ?? 1;
  const fail = (path: string, message: string): void => {
    issues.push({ file, line: at(path), path, message });
  };

  for (const key of Object.keys(table)) {
    if (key === "classify" || key === "readme") continue;
    fail(key, "unknown section — an import map holds [classify] and [readme]");
  }

  const classify = new Map<string, Destination>();
  const rawClassify = table["classify"];
  if (rawClassify === undefined) {
    fail("classify", "required, but missing — every source file needs a destination");
  } else if (typeof rawClassify !== "object" || rawClassify === null || Array.isArray(rawClassify)) {
    fail("classify", "expected a table of \"path\" = \"role|person|skip\"");
  } else {
    for (const [source, value] of Object.entries(rawClassify as Record<string, unknown>)) {
      const path = `classify.${source}`;
      if (typeof value !== "string" || !DESTINATIONS.includes(value as Destination)) {
        fail(path, `must be one of ${DESTINATIONS.join(", ")}, found ${JSON.stringify(value)}`);
        continue;
      }
      classify.set(source, value as Destination);
    }
  }

  const readme: Record<string, string> = {};
  const rawReadme = table["readme"];
  if (rawReadme === undefined) {
    fail("readme", "required, but missing — the engine does not know this agent's headings");
  } else if (typeof rawReadme !== "object" || rawReadme === null || Array.isArray(rawReadme)) {
    fail("readme", "expected a table");
  } else {
    const entries = rawReadme as Record<string, unknown>;
    for (const key of Object.keys(entries)) {
      if ((README_KEYS as readonly string[]).includes(key)) continue;
      fail(`readme.${key}`, `unknown key — [readme] defines ${README_KEYS.join(", ")}`);
    }
    for (const key of README_KEYS) {
      const value = entries[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        fail(`readme.${key}`, "required, and must be a non-empty label");
        continue;
      }
      readme[key] = value;
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    map: {
      file,
      classify,
      readme: readme as unknown as ReadmeRules,
      lines: new Map(
        [...classify.keys()].map((source) => [source, at(`classify.${source}`)] as const),
      ),
    },
  };
}

/** Read and parse an import map from disk. */
export async function loadImportMap(path: string): Promise<ImportMapResult> {
  const handle = Bun.file(path);
  if (!(await handle.exists())) {
    return {
      ok: false,
      issues: [{ file: path, line: 0, path: "", message: "import map not found" }],
    };
  }
  return parseImportMap(path, await handle.text());
}
