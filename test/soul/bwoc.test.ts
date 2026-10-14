/**
 * Importing a bwoc agent directory into a soul — AC5, and the guards around it.
 *
 * "Converts without losing information" is the whole claim, so most of this
 * file is one assertion said five ways: every non-blank line of every source
 * file has to turn up, verbatim, in one of the two output files. Counting
 * lines would not be enough — an importer that drops a code fence or demotes a
 * heading still passes a line count — so the check is that each source file's
 * text appears as a *contiguous substring* of its destination.
 *
 * The second thing tested here is the refusal. An import that silently skips a
 * file it did not recognise is exactly the failure mode this project is about:
 * exit 0, nothing obviously wrong, and a mindset quietly gone. So a source file
 * with no entry in the map must fail the import *by name*.
 *
 * Everything below runs against `test/fixtures/bwoc-agent-synthetic`, which
 * describes nobody. The real agent directory and the real import map are not
 * in this repository and are not read here (D-021, D-009).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subjectId } from "../../src/types.ts";
import { importBwocAgent, splitReadme } from "../../src/soul/bwoc.ts";
import { parseImportMap, type ImportMap } from "../../src/soul/import-map.ts";
import { parseSoul } from "../../src/soul/load.ts";
import { serializeSoul } from "../../src/soul/serialize.ts";
import { PERSON_FILE, ROLE_FILE } from "../../src/soul/schema.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURES = join(ROOT, "test", "fixtures");
const AGENT = join(FIXTURES, "bwoc-agent-synthetic");
const MAP_FILE = join(FIXTURES, "bwoc-agent-synthetic.import-map.toml");
const CLI = join(ROOT, "bin", "mind.ts");
const EXAMPLE = subjectId("example");

/** How the synthetic map classifies each source file. Mirrors the fixture. */
const ROLE_SOURCES = [
  "persona/example-buddy.md",
  "mindsets/example-ops.md",
  "mindsets/example-terse.md",
] as const;
const PERSON_SOURCES = ["mindsets/example-no-headings.md", "mindsets/example-voice.md"] as const;
const SKIP_SOURCES = ["mindsets/SPEC.md"] as const;

const mapText = await Bun.file(MAP_FILE).text();

async function syntheticMap(text = mapText): Promise<ImportMap> {
  const parsed = parseImportMap(MAP_FILE, text);
  if (!parsed.ok) throw new Error(`fixture map is invalid: ${JSON.stringify(parsed.issues)}`);
  return parsed.map;
}

/**
 * A source file split the way the importer must preserve it: its YAML
 * frontmatter, and everything after it.
 *
 * Deliberately re-implemented here rather than imported from `bwoc.ts` — a
 * "nothing was lost" check that reuses the code under test proves only that
 * the code agrees with itself.
 */
async function sourceParts(relative: string): Promise<{ yaml?: string; rest: string }> {
  const lines = (await Bun.file(join(AGENT, relative)).text()).split("\n");
  if (lines[0]?.trim() !== "---") return { rest: lines.join("\n") };
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close === -1) return { rest: lines.join("\n") };
  return { yaml: lines.slice(1, close).join("\n"), rest: lines.slice(close + 1).join("\n") };
}

/** Temp directories this file made, removed once at the end. */
const scratch: string[] = [];
async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-test-"));
  scratch.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

describe("importBwocAgent", () => {
  test("converts the synthetic agent with nothing unmapped and nothing wrong", async () => {
    const imported = await importBwocAgent(AGENT, EXAMPLE, await syntheticMap());

    expect(imported.issues).toEqual([]);
    expect(imported.unmapped).toEqual([]);
    expect(imported.soul).toBeDefined();
    expect(imported.soul?.subject).toBe(EXAMPLE);
    // Set by the engine, never read from the agent (I-5).
    expect(imported.soul?.disclosesAi).toBe(true);
  });

  test("the four manifest fields land in role.md", async () => {
    const imported = await importBwocAgent(AGENT, EXAMPLE, await syntheticMap());
    expect(imported.soul).toBeDefined();
    if (imported.soul === undefined) return;

    const manifest = JSON.parse(await Bun.file(join(AGENT, "config.manifest.json")).text());
    const { role } = imported.soul;

    expect(role.name).toBe(manifest.name);
    expect(role.role).toBe(manifest.agentRole);
    expect(role.scope.does).toBe(manifest.scopeDescription);
    expect(role.scope.does_not).toBe(manifest.outOfScope);
  });

  test("every mapped source file appears verbatim, frontmatter and all", async () => {
    const imported = await importBwocAgent(AGENT, EXAMPLE, await syntheticMap());
    expect(imported.soul).toBeDefined();
    if (imported.soul === undefined) return;

    const bodies = {
      role: imported.soul.role.body,
      person: imported.soul.person.body,
    };

    for (const [destination, sources] of [
      ["role", ROLE_SOURCES],
      ["person", PERSON_SOURCES],
    ] as const) {
      for (const source of sources) {
        const parts = await sourceParts(source);
        const body = bodies[destination];

        // The audit trail S6.1 will need: which artefact this text came from.
        expect(body).toContain(`<!-- mind:source ${source} -->`);
        if (parts.yaml !== undefined) expect(body).toContain(parts.yaml);
        // Contiguous, not line-by-line: this is what catches a demoted heading
        // or a swallowed code fence.
        expect(body).toContain(parts.rest.trim());
      }
    }
  });

  test("no non-blank line of any source file goes missing", async () => {
    const imported = await importBwocAgent(AGENT, EXAMPLE, await syntheticMap());
    expect(imported.soul).toBeDefined();
    if (imported.soul === undefined) return;

    const everything = `${imported.soul.role.body}\n${imported.soul.person.body}\n` +
      // The manifest fields live in the frontmatter, not the body, so the
      // serialized files are what "arrived" has to be measured against.
      Object.values(serializeSoul(imported.soul)).join("\n");

    const missing: string[] = [];
    for (const source of [...ROLE_SOURCES, ...PERSON_SOURCES, "persona/README.md"]) {
      const text = await Bun.file(join(AGENT, source)).text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        // `---` is the YAML fence, which is re-fenced as ```yaml rather than
        // copied. It is notation, not content.
        if (trimmed === "" || trimmed === "---") continue;
        if (!everything.includes(trimmed)) missing.push(`${source}: ${line}`);
      }
    }

    // Printed rather than counted, so a failure says which line was dropped.
    expect(missing).toEqual([]);
  });

  test("role and person stay on their own sides of the wall (AC3, I-5)", async () => {
    const imported = await importBwocAgent(AGENT, EXAMPLE, await syntheticMap());
    expect(imported.soul).toBeDefined();
    if (imported.soul === undefined) return;

    const { role, person } = imported.soul;

    for (const source of ROLE_SOURCES) {
      expect(role.body).toContain(`<!-- mind:source ${source} -->`);
      expect(person.body).not.toContain(`<!-- mind:source ${source} -->`);
    }
    for (const source of PERSON_SOURCES) {
      expect(person.body).toContain(`<!-- mind:source ${source} -->`);
      expect(role.body).not.toContain(`<!-- mind:source ${source} -->`);
    }

    // The README is the one file split down the middle, so the check there is
    // about content: deleting person.md must not take the Constraints with it,
    // and must not leave the Personality behind.
    expect(role.body).toContain("## Constraints");
    expect(role.body).not.toContain("## Personality");
    expect(person.body).toContain("## Personality");
    expect(person.body).not.toContain("## Constraints");
  });

  test("skipped files are reported, and land in neither file", async () => {
    const imported = await importBwocAgent(AGENT, EXAMPLE, await syntheticMap());
    expect(imported.skipped).toEqual([...SKIP_SOURCES]);
    expect(imported.soul).toBeDefined();
    if (imported.soul === undefined) return;

    for (const source of SKIP_SOURCES) {
      expect(imported.soul.role.body).not.toContain(source);
      expect(imported.soul.person.body).not.toContain(source);
    }
  });

  test("an unmapped source file fails the import by name", async () => {
    const withoutVoice = mapText
      .split("\n")
      .filter((line) => !line.includes("mindsets/example-voice.md"))
      .join("\n");

    const imported = await importBwocAgent(AGENT, EXAMPLE, await syntheticMap(withoutVoice));

    expect(imported.unmapped).toEqual(["mindsets/example-voice.md"]);
    expect(imported.issues.some((issue) => issue.message.includes("mindsets/example-voice.md"))).toBe(
      true,
    );
    // The point of the refusal: not "an error occurred", but which file and
    // what to do about it.
    expect(imported.issues.some((issue) => issue.message.includes("role, person or skip"))).toBe(
      true,
    );

    // A partial soul is still returned — the documented contract is that
    // `issues` is what decides, not `soul` being undefined. The mindset's text
    // is simply gone from it, which is exactly why nothing may be written while
    // `issues` is non-empty; the CLI test below is what holds that end.
    expect(imported.soul?.person.body).not.toContain("mindsets/example-voice.md");
  });

  test("a map entry naming a file that no longer exists is reported, with its line", async () => {
    const stale = mapText.replace(
      '"mindsets/example-terse.md"       = "role"',
      '"mindsets/renamed-away.md"        = "role"',
    );
    const imported = await importBwocAgent(AGENT, EXAMPLE, await syntheticMap(stale));

    const issue = imported.issues.find((i) => i.path === "classify.mindsets/renamed-away.md");
    expect(issue).toBeDefined();
    expect(issue?.file).toBe(MAP_FILE);
    expect(issue?.line).toBe(15);
    expect(issue?.message).toContain("no such file");

    // And the file it used to name is now unmapped, so the import still fails.
    expect(imported.unmapped).toEqual(["mindsets/example-terse.md"]);
  });

  test("the README may not be classified — it is read structurally", async () => {
    // The section header, not the word where it appears in the file's comments.
    const withReadme = mapText.replace(
      "\n[classify]\n",
      '\n[classify]\n"persona/README.md" = "role"\n',
    );
    const imported = await importBwocAgent(AGENT, EXAMPLE, await syntheticMap(withReadme));

    const issue = imported.issues.find((i) => i.path === "classify.persona/README.md");
    expect(issue).toBeDefined();
    expect(issue?.file).toBe(MAP_FILE);
    expect(issue?.message).toContain("read structurally");
  });

  test("a directory that is not a bwoc agent is refused, not half-imported", async () => {
    const empty = await scratchDir();
    const imported = await importBwocAgent(empty, EXAMPLE, await syntheticMap());

    expect(imported.soul).toBeUndefined();
    const files = imported.issues.map((issue) => issue.file);
    expect(files).toContain("config.manifest.json");
    expect(files).toContain("persona/README.md");
  });

  test("a schema complaint points back at the bwoc file a human would edit", async () => {
    const agent = await scratchDir();
    await mkdir(join(agent, "persona"), { recursive: true });
    await mkdir(join(agent, "mindsets"), { recursive: true });
    await Bun.write(
      join(agent, "config.manifest.json"),
      JSON.stringify({
        name: "example-agent",
        agentRole: "Tends a synthetic directory",
        scopeDescription: "Reads the fixture",
        outOfScope: "Touches nothing else",
      }),
    );
    // A README with an Identity table but no Constraints section: valid
    // Markdown, and an invalid soul, because prohibitions cannot be empty.
    await Bun.write(
      join(agent, "persona", "README.md"),
      [
        "# Persona",
        "",
        "## Identity",
        "",
        "| Field | Value |",
        "|---|---|",
        "| **Calls the user** | friend |",
        "| **Refers to itself as** | the keeper |",
        "",
        "## Personality",
        "",
        "- plain",
        "",
        "## Core Principles",
        "",
        "1. verify",
        "",
      ].join("\n"),
    );

    const imported = await importBwocAgent(agent, EXAMPLE, await syntheticMap("[classify]\n" + mapText.slice(mapText.indexOf("[readme]"))));

    expect(imported.soul).toBeUndefined();
    const issue = imported.issues.find((i) => i.path === "prohibitions");
    expect(issue).toBeDefined();
    // Not "prohibitions is empty" — the file the reader has to open.
    expect(issue?.message).toContain("persona/README.md: ## Constraints");
  });

  test("what is imported is what loads back — import, write, read, compare", async () => {
    const imported = await importBwocAgent(AGENT, EXAMPLE, await syntheticMap());
    expect(imported.soul).toBeDefined();
    if (imported.soul === undefined) return;

    const written = serializeSoul(imported.soul);
    const reloaded = parseSoul(written.role, written.person, EXAMPLE);

    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.soul).toEqual(imported.soul);
  });

  test("the imported soul belongs to the subject that was asked for", async () => {
    const other = subjectId("someone-else");
    const imported = await importBwocAgent(AGENT, other, await syntheticMap());
    expect(imported.soul?.subject).toBe(other);
    if (imported.soul === undefined) return;

    // And it cannot then be read back as anybody else (I-3).
    const written = serializeSoul(imported.soul);
    const asExample = parseSoul(written.role, written.person, EXAMPLE);
    expect(asExample.ok).toBe(false);
  });
});

describe("splitReadme", () => {
  test("routes every line to exactly one side, keeping them verbatim", async () => {
    const text = await Bun.file(join(AGENT, "persona", "README.md")).text();
    const map = await syntheticMap();
    const split = splitReadme(text, map.readme);

    const afterYaml = text.split("\n").slice(text.split("\n").indexOf("---", 1) + 1);
    // Nothing duplicated, nothing dropped: the two halves reassemble into the
    // original line-for-line. This is what makes `rm person.md` a safe thing
    // to do rather than a lossy one.
    expect([...split.roleLines, ...split.personLines].sort()).toEqual([...afterYaml].sort());
    expect(split.roleLines.length + split.personLines.length).toBe(afterYaml.length);
  });

  test("pulls the identity rows and the three lists out of the README", async () => {
    const text = await Bun.file(join(AGENT, "persona", "README.md")).text();
    const split = splitReadme(text, (await syntheticMap()).readme);

    expect(split.refersToSelfAs).toEqual(["the keeper", "it"]);
    expect(split.tone).toHaveLength(2);
    expect(split.principles).toHaveLength(3);
    expect(split.prohibitions).toEqual([
      "never commits credentials",
      "never skips a verification gate",
      "never works outside the declared scope",
    ]);

    // Known asymmetry, recorded rather than endorsed: `refers_to_self_as` has
    // its quotes stripped and `addresses_user_as` does not, so this value
    // arrives as `"friend"` with the quotes still on it. Nothing is lost, so
    // AC5 holds; if the quoting is ever made consistent, this line is the one
    // that says so out loud.
    expect(split.addressesUserAs).toBe('"friend"');
  });

  test("a README with no frontmatter and no known sections still splits", () => {
    const split = splitReadme("# Plain\n\nprose only\n", {
      addresses_user_as_row: "Calls the user",
      refers_to_self_as_row: "Refers to itself as",
      tone_section: "Personality",
      principles_section: "Core Principles",
      constraints_section: "Constraints",
    });

    expect(split.yaml).toBeUndefined();
    expect(split.personLines).toEqual([]);
    expect(split.roleLines).toEqual(["# Plain", "", "prose only", ""]);
    expect(split.addressesUserAs).toBeUndefined();
    expect(split.refersToSelfAs).toEqual([]);
  });
});

/**
 * `--out` is the only place an import touches the disk, so it is the only
 * place I-4 can be enforced. An imported soul carries whatever the source
 * agent carried — host paths, account names — and git is where "delete my
 * data" stops being possible (D-013).
 */
describe("mind soul import (CLI)", () => {
  async function run(args: readonly string[]): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn([process.execPath, "run", CLI, ...args], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out =
      (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    await proc.exited;
    return { code: proc.exitCode ?? -1, out };
  }

  const ARGS = [
    "soul",
    "import",
    AGENT,
    "--subject",
    "example",
    "--map",
    MAP_FILE,
  ] as const;

  test("refuses an --out inside the engine repository", async () => {
    const { code, out } = await run([...ARGS, "--out", join(ROOT, ".mind", "imported")]);
    expect(code).toBe(2);
    expect(out).toContain("engine repository");
    expect(out).toContain("D-021");
  });

  test("refuses an --out inside any other git repository", async () => {
    const scratchRoot = await scratchDir();
    await mkdir(join(scratchRoot, "someones-repo", ".git"), { recursive: true });

    const { code, out } = await run([...ARGS, "--out", join(scratchRoot, "someones-repo", "soul")]);
    expect(code).toBe(2);
    expect(out).toContain("git repository");
    expect(out).toContain("I-4");
    // And nothing was written on the way to refusing.
    expect(await Bun.file(join(scratchRoot, "someones-repo", "soul", ROLE_FILE)).exists()).toBe(
      false,
    );
  });

  test("refuses an --out that already has something in it", async () => {
    const dir = await scratchDir();
    await Bun.write(join(dir, "keep-me.txt"), "not yours to overwrite\n");

    const { code, out } = await run([...ARGS, "--out", dir]);
    expect(code).toBe(2);
    expect(out).toContain("not empty");
    expect(await Bun.file(join(dir, "keep-me.txt")).text()).toBe("not yours to overwrite\n");
  });

  test("writes both halves to a directory outside version control", async () => {
    const out = join(await scratchDir(), "soul");
    const result = await run([...ARGS, "--out", out]);

    expect(result.code).toBe(0);
    expect(result.out).toContain("skipped mindsets/SPEC.md");

    const role = await Bun.file(join(out, ROLE_FILE)).text();
    const person = await Bun.file(join(out, PERSON_FILE)).text();
    expect(role).toContain('schema = "mind/soul-role@1"');
    expect(person).toContain('schema = "mind/soul-person@1"');

    // `soul check` on what `soul import` just wrote — the two commands have to
    // agree, or the import is producing files only it can read.
    const checked = await run(["soul", "check", out, "--subject", "example"]);
    expect(checked.code).toBe(0);
  });

  test("an unmapped file stops the CLI with exit 1, naming the file", async () => {
    const dir = await scratchDir();
    const partial = join(dir, "partial-map.toml");
    await Bun.write(
      partial,
      mapText.split("\n").filter((line) => !line.includes("example-ops.md")).join("\n"),
    );

    const { code, out } = await run([
      "soul",
      "import",
      AGENT,
      "--subject",
      "example",
      "--map",
      partial,
      "--out",
      join(dir, "soul"),
    ]);

    expect(code).toBe(1);
    expect(out).toContain("mindsets/example-ops.md");
    expect(await Bun.file(join(dir, "soul", ROLE_FILE)).exists()).toBe(false);
  });
});
