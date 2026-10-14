/** S6.1 (D-072) — claims tied to quotes, made-up ones cut, only yeses adopted. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptClaims, checkClaims, chunkArtifact, collectArtifacts, describeClaim, extractPrompt, locateQuote, readClaims, type Claim, type Draft } from "../../src/soul/extract.ts";
import { parseSoul } from "../../src/soul/load.ts";
import { serializePerson, serializeRole } from "../../src/soul/serialize.ts";
import { subjectId } from "../../src/types.ts";

const ROOT = join(import.meta.dir, "..", "..");
const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("artifacts", () => {
  test("text files under the folders given; links, binaries, credentials and junk dirs are left out, and said", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-extract-"));
    scratch.push(dir);
    const docs = join(dir, "docs");
    await mkdir(join(docs, "node_modules"), { recursive: true });
    await writeFile(join(docs, "runbook.md"), "# Runbook\n\nRestart the queue before noon.\n");
    await writeFile(join(docs, "node_modules", "x.md"), "ignored");
    await writeFile(join(docs, "logo.png"), "png");
    await writeFile(join(docs, "blob.txt"), new Uint8Array([104, 0, 105]));
    await writeFile(join(docs, "keys.md"), `token: ghp_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}\n`);
    await writeFile(join(docs, "empty.md"), "  \n");
    await symlink(join(docs, "runbook.md"), join(docs, "link.md"));
    await writeFile(join(dir, "single.txt"), "one file handed in by itself\n");
    const { artifacts, skipped } = await collectArtifacts([docs, join(dir, "single.txt"), join(dir, "missing")]);
    const labels = artifacts.map((a) => a.label);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toBe("docs/runbook.md");
    expect(labels[1]).toMatch(/\/single\.txt$/);
    const said = skipped.join("\n");
    expect(said).toContain("link.md — a link");
    expect(said).toContain("logo.png — not a text file");
    expect(said).toContain("blob.txt — binary");
    expect(said).toContain("keys.md — holds something that looks like a credential");
    expect(said).toContain("missing");
    expect(said).not.toContain("node_modules");
  });

  test("chunks cut at blank lines, each knowing the line it starts on", () => {
    const text = Array.from({ length: 40 }, (_, i) => (i % 5 === 4 ? "" : `line ${i + 1} ${"x".repeat(40)}`)).join("\n");
    const chunks = chunkArtifact({ label: "a.md", text }, 300);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0]!.line).toBe(1);
    for (const c of chunks) expect(c.text.split("\n")[0]!.startsWith(`line ${c.line}`) || c.text.split("\n")[0] === "").toBe(true);
    expect(chunkArtifact({ label: "e.md", text: "\n\n" })).toEqual([]);
  });
});

describe("claims", () => {
  const chunk = { label: "docs/runbook.md", line: 10, text: "Intro\n\nเรียกผู้ใช้ว่า \"ที่รัก\" เสมอ\nNever restart the database during business hours.\nWe deploy on Fridays." };

  test("the model's answer is read as claims; malformed items and fields are dropped", () => {
    const content = 'Sure:\n[{"field":"prohibition","text":"Never restart the DB in business hours","quote":"Never restart the database during business hours."},{"field":"secret","text":"x","quote":"12345678"},{"field":"does","text":"","quote":"We deploy on Fridays."},"junk",{"field":"does","text":"Deploys weekly","quote":"short"}]';
    expect(readClaims(content)).toEqual([{ field: "prohibition", text: "Never restart the DB in business hours", quote: "Never restart the database during business hours." }]);
    expect(readClaims("no json here")).toEqual([]);
    expect(readClaims("[not json]")).toEqual([]);
    expect(readClaims('{"a":1}')).toEqual([]);
  });

  test("AC2: a quote that is not in the artifact makes the claim made up, and it is cut", () => {
    const seen = new Set<string>();
    const { claims, cut } = checkClaims(
      [
        { field: "prohibition", text: "Never restart the DB", quote: "Never  restart the DATABASE during business hours." },
        { field: "does", text: "Deploys on Fridays", quote: "We deploy on Fridays." },
        { field: "knowledge", text: "Invented", quote: "We deploy on Mondays at dawn." },
        { field: "does", text: "Deploys on Fridays", quote: "We deploy on Fridays." },
      ],
      chunk,
      seen,
    );
    expect(cut).toBe(1);
    expect(claims.map((c) => [c.field, c.source.line])).toEqual([["prohibition", 13], ["does", 14]]);
    expect(claims.every((c) => c.decision === null)).toBe(true);
    expect(describeClaim(claims[0]!)).toContain("docs/runbook.md:13");
  });

  test("Thai: the vowel and tone mark in either order is the same quote; a dropped letter is not", () => {
    expect(locateQuote("เรียกผู้ใช้ว่า \"ท่ีรัก\" เสมอ", chunk)).toBe(12);
    expect(locateQuote("เรียกผู้ใช้ว่า \"ทรัก\" เสมอ", chunk)).toBeUndefined();
    expect(locateQuote("short", chunk)).toBeUndefined();
    // Emphasis is formatting, not words.
    const bold = { label: "p.md", line: 1, text: "- แทนตัวเองว่า **\"บุษบา\"** หรือ **\"หนู\"**" };
    expect(locateQuote("แทนตัวเองว่า \"บุษบา\" หรือ \"หนู\"", bold)).toBe(1);
  });

  test("the prompt asks for quotes, forbids naming a person, and carries the artifact and its line", () => {
    const p = extractPrompt(chunk);
    expect(p.system).toContain("copied EXACTLY");
    expect(p.system).toContain("8 to 80 characters");
    expect(p.system).toContain("never naming a person");
    expect(p.user).toContain("docs/runbook.md (from line 10)");
  });
});

describe("adopt (AC1, AC3)", () => {
  const claim = (field: Claim["field"], text: string, decision: Claim["decision"]): Claim => ({ id: text.slice(0, 8), field, text, quote: "q", source: { label: "docs/r.md", line: 3 }, decision });

  test("only yeses are written; role knowledge to role.md with its source, traits to person.md; the result still loads", async () => {
    const role = await Bun.file(join(ROOT, "test/fixtures/soul-valid/role.md")).text();
    const person = await Bun.file(join(ROOT, "test/fixtures/soul-valid/person.md")).text();
    const loaded = parseSoul(role, person, subjectId("example"));
    if (!loaded.ok) throw new Error("fixture");
    const draft: Draft = {
      v: 1, id: "d", at: "t", subject: "example", model: "m", sources: [], chunks: 1, cut: 0, skipped: [],
      claims: [
        claim("knowledge", "The queue restarts before noon", "yes"),
        claim("prohibition", "Never restart the DB in business hours", "yes"),
        claim("does", "Deploys on Fridays", "yes"),
        claim("does_not", "Handles payroll", "yes"),
        claim("principle", "Check before acting", "yes"),
        claim("tone", "brief", "yes"),
        claim("knowledge", "Declined fact", "no"),
        claim("knowledge", "Unanswered fact", null),
      ],
    };
    const next = adoptClaims(loaded.soul.role, loaded.soul.person, draft);
    expect(next.adopted).toBe(6);
    expect(next.role.body).toContain("## From artifacts (S6.1)");
    expect(next.role.body).toContain("- The queue restarts before noon — `docs/r.md:3`");
    expect(next.role.body).not.toContain("Declined fact");
    expect(next.role.body).not.toContain("Unanswered fact");
    expect(next.role.prohibitions).toContain("Never restart the DB in business hours");
    expect(next.role.scope.does).toContain("Deploys on Fridays");
    expect(next.role.scope.does_not).toContain("Handles payroll");
    expect(next.person.principles).toContain("Check before acting");
    expect(next.person.tone).toContain("brief");
    const again = parseSoul(serializeRole(next.role), serializePerson(next.person), subjectId("example"));
    expect(again.ok).toBe(true);
    // Adopting twice adds nothing twice.
    const twice = adoptClaims(next.role, next.person, draft);
    expect(twice.role.prohibitions.filter((p) => p === "Never restart the DB in business hours")).toHaveLength(1);
    expect(twice.role.body.split("The queue restarts before noon").length).toBe(2);
  });
});
