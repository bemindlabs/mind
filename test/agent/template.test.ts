/**
 * What a new agent repository starts as.
 *
 * Three of these are acceptance criteria rather than housekeeping: the
 * `.gitignore` is one line (AC2), every file is text a person can read (AC3),
 * and nothing in any of them names the machine the template was written on
 * (AC5). The fourth — that the template soul loads through the ordinary
 * validator — is what stops the template drifting away from the schema, which
 * would otherwise only be discovered by somebody running `soul check` on a
 * freshly created agent and being told it is malformed.
 */

import { describe, expect, test } from "bun:test";
import { DERIVATIONS } from "../../src/agent/derive.ts";
import {
  CONSENT_DIR,
  DERIVED_DIR,
  GITIGNORE_CONTENT,
  GITIGNORE_FILE,
  MEMORY_DIR,
  SOUL_DIR,
  templateFiles,
  templateSoul,
} from "../../src/agent/template.ts";
import { parseSoul } from "../../src/soul/load.ts";
import { renderSoul } from "../../src/soul/render.ts";
import { PERSON_FILE, ROLE_FILE } from "../../src/soul/schema.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("example");

function fileMap(subject = SUBJECT, name = "example"): Map<string, string> {
  return new Map(templateFiles(subject, name).map((file) => [file.path, file.content]));
}

describe("agent template", () => {
  test("AC1 — soul, memory, consent and a .gitignore, and nothing else", () => {
    expect([...fileMap().keys()].sort()).toEqual(
      [
        GITIGNORE_FILE,
        `${CONSENT_DIR}/README.md`,
        `${MEMORY_DIR}/README.md`,
        `${SOUL_DIR}/${PERSON_FILE}`,
        `${SOUL_DIR}/${ROLE_FILE}`,
      ].sort(),
    );
  });

  test("AC2 — .gitignore is exactly one line: /.mind/", () => {
    const content = fileMap().get(GITIGNORE_FILE)!;
    expect(content).toBe(GITIGNORE_CONTENT);
    expect(content).toBe(`/${DERIVED_DIR}/\n`);
    expect(content.trimEnd().split("\n")).toEqual(["/.mind/"]);
  });

  test("AC3 — every file is text, and no file needs Mind to read it", () => {
    for (const [path, content] of fileMap()) {
      // A round trip through UTF-8 proves it is text and not bytes that happen
      // to decode; a leading NUL or a BOM would fail here.
      expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(content))).toBe(content);
      expect(content.includes("\u0000"), `${path} holds a NUL byte`).toBe(false);
      expect(content.length, `${path} is empty`).toBeGreaterThan(0);
    }
  });

  test("AC5 — nothing names a host, a home directory or an account", () => {
    for (const [path, content] of fileMap()) {
      expect(content, `${path} names an absolute path`).not.toMatch(/(^|[\s"'`(])\/(home|Users|root|var|opt)\//);
      expect(content, `${path} names a home directory`).not.toMatch(/~\/[A-Za-z.]/);
      expect(content, `${path} names a host`).not.toMatch(/\b[a-z0-9-]+\.(ts\.net|local|internal)\b/);
      expect(content, `${path} names an account`).not.toMatch(/@[a-z0-9-]+\.(com|tech|net|org)\b/);
    }
  });

  test("the template soul loads through the ordinary validator", () => {
    const files = fileMap();
    const loaded = parseSoul(
      files.get(`${SOUL_DIR}/${ROLE_FILE}`)!,
      files.get(`${SOUL_DIR}/${PERSON_FILE}`)!,
      SUBJECT,
    );
    expect(loaded.ok).toBe(true);
  });

  test("the template soul does not belong to a subject nobody asked for (I-3)", () => {
    const files = fileMap();
    const loaded = parseSoul(
      files.get(`${SOUL_DIR}/${ROLE_FILE}`)!,
      files.get(`${SOUL_DIR}/${PERSON_FILE}`)!,
      subjectId("somebody-else"),
    );
    expect(loaded.ok).toBe(false);
  });

  test("I-5 — the disclosure is in the render, and a prohibition says so too", () => {
    const rendered = renderSoul(templateSoul(SUBJECT, "example"));
    expect(rendered).toContain("is an AI agent, not a person");
    expect(rendered).toContain("says plainly that it is an AI whenever asked");
  });

  test("I-4/I-6 — the template offers no home for personal data, and says where it lives", () => {
    const files = fileMap();
    expect([...files.keys()].some((path) => path.includes("personal"))).toBe(false);
    // Collapsed, because where a sentence happens to wrap is not the claim.
    const readme = files.get(`${MEMORY_DIR}/README.md`)!.replaceAll(/\s+/g, " ");
    expect(readme).toContain("Nothing flagged personal goes in this directory");
    expect(readme).toContain("lives outside the repository");
    // Printed text names the product as Mind, and no old name is in what a new agent is given.
    expect(readme).toContain("a path Mind resolves in code and refuses to place inside any git checkout");
  });

  test("the same arguments give the same bytes, twice", () => {
    expect(templateFiles(SUBJECT, "example")).toEqual(templateFiles(SUBJECT, "example"));
  });
});

describe("derivation register", () => {
  test("every derivation renders the same bytes from the same soul", () => {
    const soul = templateSoul(SUBJECT, "example");
    for (const derivation of DERIVATIONS) {
      expect(derivation.render(soul)).toBe(derivation.render(soul));
    }
  });

  test("every output lands under .mind/ and every source is repo-relative", () => {
    for (const derivation of DERIVATIONS) {
      expect(derivation.output.startsWith("/")).toBe(false);
      expect(derivation.output.startsWith("..")).toBe(false);
      expect(derivation.sources.length).toBeGreaterThan(0);
      for (const source of derivation.sources) {
        expect(source.startsWith("/")).toBe(false);
        expect(source.startsWith(DERIVED_DIR)).toBe(false);
      }
    }
  });

  test("ids are unique, and carry a version", () => {
    const ids = DERIVATIONS.map((derivation) => derivation.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/@\d+$/);
  });
});
