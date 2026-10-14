/**
 * The scan rules, and the two things about them that matter more than the list.
 *
 * **Nothing here is a real secret.** Every fixture is assembled from fragments
 * at run time (D-021): a string that looks like a live key, sitting in a
 * repository designed to be opened one day, is the exact mistake this scanner
 * exists to catch. The two numeric fixtures are constructed to satisfy their
 * checksums arithmetically and belong to nobody.
 *
 * **A finding must never carry what it found.** A blocked commit that echoed
 * the token would have put it in terminal scrollback and in whatever the output
 * was piped to, and no `forget` in this project reaches either (D-022). So the
 * last test in this file takes every finding the suite produces and asserts the
 * secret is not in the text a person would see.
 */

import { describe, expect, test } from "bun:test";
import { PROPOSALS_DIR } from "../../src/decide/proposals.ts";
import {
  formatFinding,
  SCAN_BLIND_SPOTS,
  SCAN_RULE_COUNT,
  scanStaged,
  type StagedFile,
} from "../../src/guard/scan.ts";
import { ROLE_SCHEMA } from "../../src/soul/schema.ts";

/** A staged file from text, so a test reads as the file it describes. */
function staged(path: string, content: string): StagedFile {
  return { path, bytes: new TextEncoder().encode(content) };
}

/** The rule ids a scan of one file produced. */
function rules(path: string, content: string): string[] {
  return scanStaged([staged(path, content)]).map((finding) => finding.rule);
}

// Assembled, never written down whole. Each is the shape of a key, not a key.
const AWS = "AK" + "IA" + "ABCDEFGHIJKLMNOP";
const GITHUB = "ghp" + "_" + "0123456789abcdefghijklmnopqrstuvwxyz";
const ANTHROPIC = "sk-" + "ant-" + "api03-" + "0123456789abcdefghij";
// Exactly the 35 characters a Google key carries after its prefix.
const GOOGLE = "AIza" + "0123456789" + "abcdefghijklmnopqrstuvwxy";
const SLACK = "xox" + "b-" + "1234567890-abcdefghij";
const JWT = "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NSJ9" + "." + "c2lnbmF0dXJlLWhlcmU";
// Twelve digits plus a check digit that satisfies the mod-11 rule, worked out
// on paper. Not anybody's id.
const THAI_ID = "110170123456" + "1";
const THAI_ID_BAD = "110170123456" + "2";
// The card number every payment processor publishes as a test value.
const CARD = "4111" + "1111" + "1111" + "1111";
const CARD_BAD = "4111" + "1111" + "1111" + "1112";

describe("what the scan refuses by where a file is (AC4)", () => {
  test("anything under a personal/ directory, at any depth", () => {
    expect(rules("personal/notes.md", "hello\n")).toContain("personal-path");
    expect(rules("memory/personal/2026/notes.md", "hello\n")).toContain("personal-path");
    // A file *called* personal is not a directory called personal.
    expect(rules("memory/personal.md", "hello\n")).not.toContain("personal-path");
  });

  test("the proposal store is covered by that rule, and the limit of it is said", () => {
    // S5.2's store holds free text about what the owner does (D-029), so the
    // question is whether the guard that already exists reaches it rather than
    // whether a new rule is needed. It does: the rule is about the segment
    // `personal`, at any depth, and the store is a subtree of that directory.
    expect(rules(`personal/${PROPOSALS_DIR}/abc.json`, "{}\n")).toContain("personal-path");
    expect(rules(`x/y/personal/${PROPOSALS_DIR}/abc.json`, "{}\n")).toContain("personal-path");

    // And the limit, stated rather than left to be discovered: a proposal file
    // copied somewhere with no `personal/` above it is not caught by the path
    // rule. Nothing Mind does writes one there — `proposalsDir` is built on
    // `personalDir`, and `test/decide/proposals.test.ts` pins that — but a
    // person with a `cp` is outside every rule in this file.
    expect(rules(`${PROPOSALS_DIR}/abc.json`, "{}\n")).not.toContain("personal-path");
  });

  test("environment files, key files and .netrc, whatever is in them", () => {
    expect(rules(".env", "")).toContain("env-file");
    expect(rules("config/.env.production", "")).toContain("env-file");
    expect(rules("keys/server.pem", "")).toContain("key-file");
    expect(rules("id_ed25519", "")).toContain("ssh-key-file");
    expect(rules(".netrc", "")).toContain("netrc-file");
    expect(rules("soul/role.md", "")).toEqual([]);
  });
});

describe("what the scan refuses by what is in a file (AC3)", () => {
  test("a binary blob is refused, and its content is not read", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const findings = scanStaged([{ path: "memory/photo.png", bytes }]);
    expect(findings.map((finding) => finding.rule)).toEqual(["binary-file"]);
  });

  test("each vendor prefix", () => {
    expect(rules("a.md", `-----BEGIN RSA PRIVATE KEY-----\n`)).toContain("pem-private-key");
    expect(rules("a.md", `aws = ${AWS}\n`)).toContain("aws-access-key-id");
    expect(rules("a.md", `${GITHUB}\n`)).toContain("github-token");
    expect(rules("a.md", `${ANTHROPIC}\n`)).toContain("anthropic-key");
    expect(rules("a.md", `${GOOGLE}\n`)).toContain("google-api-key");
    expect(rules("a.md", `${SLACK}\n`)).toContain("slack-token");
    expect(rules("a.md", `${JWT}\n`)).toContain("jwt");
    expect(rules("a.md", `https://user:hunter22@example.invalid/x\n`)).toContain("url-credentials");
    expect(rules("a.md", `api_key = "abcdefghijkl"\n`)).toContain("assigned-secret");
  });

  test("a stand-in for a secret is not a secret", () => {
    // The four lines that kept the owner's notes out of mind-bmt, reshaped.
    expect(rules("a.md", "DATABASE_URL = `postgresql://app:<pw>@10.0.0.1:5432/db`\n")).toEqual([]);
    expect(rules("a.md", "reads `mqtt://bwoc:***@mosquitto:1883`\n")).toEqual([]);
    expect(rules("a.md", "template holds `{{token:NAME}}` lines\n")).toEqual([]);
    expect(rules("a.md", "- token: `~/.secrets/.env.telegram` (600)\n")).toEqual([]);
    expect(rules("a.md", "password = ${DB_PASSWORD}\nsecret: $CLIENT_SECRET\ntoken=/etc/app/token\n")).toEqual([]);
  });

  test("the control: real values next to a stand-in are still caught", () => {
    expect(rules("a.md", "https://user:hunter22@example.invalid/x\n")).toContain("url-credentials");
    expect(rules("a.md", "a://u:<pw>@h and b://u:hunter22@h\n")).toContain("url-credentials");
    expect(rules("a.md", "token: {{NAME}} then token=abcdefghijkl\n")).toContain("assigned-secret");
    // A value that merely starts like a placeholder is not one.
    expect(rules("a.md", "https://user:<pw>x9Qz@example.invalid\n")).toContain("url-credentials");
    expect(rules("a.md", "token=/abcdefghijkl\n")).toContain("assigned-secret");
    expect(rules("a.md", "password: ***hunter22\n")).toContain("assigned-secret");
  });

  test("EEA-15: a long run of dotted or hyphenated letters is scanned in time that grows with its length, and a URL password after one is still found", () => {
    // `a.a.a.` and `a-a-a-` have a word boundary at every letter, and the scheme part of the url rule was rescanned to
    // the end of the run from each: 20k characters took 60 ms, 40k 250 ms, 400k about 22 s. Now about 10 ms for 400k;
    // the budget is a hundred times that so that a loaded machine does not fail it, and a quadratic one still does.
    for (const unit of ["a.", "a-", "a+", "a.b-", "A."]) {
      const started = performance.now();
      expect(rules("a.md", unit.repeat(400_000 / unit.length)), unit).toEqual([]);
      expect(performance.now() - started, unit).toBeLessThan(1500);
    }
    // What the bound on the scheme does not cost: a scheme with dots or hyphens, a scheme that follows dots or a
    // hyphen, and one at the longest the rule reads (32 characters).
    for (const link of ["com.example.my-app://u:hunter22@h/", "...http://u:hunter22@h/", "-http://u:hunter22@h/", `${"a".repeat(32)}://u:hunter22@h/`, `${"a.".repeat(40)}x://u:hunter22@h/`]) {
      expect(rules("a.md", `${link}\n`), link).toContain("url-credentials");
    }
    // The one thing it does not read: thirty-three letters with no boundary in them, which is not a scheme anything uses.
    expect(rules("a.md", `${"a".repeat(33)}://u:hunter22@h/\n`)).not.toContain("url-credentials");
  });

  test("the numeric rules need their checksum, not just their shape", () => {
    expect(rules("a.md", `id ${THAI_ID}\n`)).toContain("thai-national-id");
    expect(rules("a.md", `id ${THAI_ID_BAD}\n`)).not.toContain("thai-national-id");
    expect(rules("a.md", `card ${CARD}\n`)).toContain("payment-card");
    expect(rules("a.md", `card ${CARD_BAD}\n`)).not.toContain("payment-card");
  });

  test("a line number comes back, and every finding in a file, not the first", () => {
    const findings = scanStaged([
      staged("a.md", `harmless\n${AWS}\nalso harmless\n${GITHUB}\n`),
    ]);
    expect(findings.map((finding) => finding.line)).toEqual([2, 4]);
  });

  test("the files a new agent starts with pass", () => {
    // The scan runs on every commit in an agent repository, so a template that
    // tripped it would make the first commit impossible.
    const clean = [
      staged("soul/role.md", `schema = "${ROLE_SCHEMA}"\nname = "example"\n`),
      staged("memory/README.md", "Nothing flagged personal goes in this directory.\n"),
      staged(".gitignore", "/.mind/\n"),
    ];
    expect(scanStaged(clean)).toEqual([]);
  });
});

describe("a finding says enough to act on and never enough to leak", () => {
  test("the text that matched is not in the finding, or in the line it prints", () => {
    const secrets = [AWS, GITHUB, ANTHROPIC, GOOGLE, SLACK, JWT, THAI_ID, CARD];
    for (const secret of secrets) {
      const findings = scanStaged([staged("a.md", `value = ${secret}\n`)]);
      expect(findings.length, secret.slice(0, 4)).toBeGreaterThan(0);
      for (const finding of findings) {
        const printed = formatFinding(finding);
        expect(printed).not.toContain(secret);
        expect(JSON.stringify(finding)).not.toContain(secret);
        expect(printed).toContain("a.md:1");
        expect(printed).toContain(finding.rule);
      }
    }
  });

  test("a number about a person echoes nothing at all, not even four digits", () => {
    for (const number of [THAI_ID, CARD]) {
      for (const finding of scanStaged([staged("a.md", `${number}\n`)])) {
        expect(finding.fragment).toBeUndefined();
        expect(formatFinding(finding)).not.toContain(number.slice(0, 4));
      }
    }
    // Where four characters name a vendor and identify nothing else, they are
    // shown — that is what makes a finding actionable.
    const vendor = scanStaged([staged("a.md", `${AWS}\n`)]);
    expect(vendor[0]?.fragment).toBe("AKIA");
  });
});

describe("what the scan says it cannot see", () => {
  test("prose about a person is the first blind spot, and is named as the largest", () => {
    const prose =
      "My sister was diagnosed in March and earns 48,000 a month; her flat is above the bakery.\n";
    expect(scanStaged([staged("memory/notes.md", prose)])).toEqual([]);

    const first = SCAN_BLIND_SPOTS[0] ?? "";
    expect(first).toContain("prose");
    expect(first).toContain("largest category");
    expect(first.toLowerCase()).toContain("not evidence");
  });

  test("--no-verify and an unguarded clone are stated, not left for somebody to find", () => {
    const all = SCAN_BLIND_SPOTS.join("\n");
    expect(all).toContain("--no-verify");
    expect(all).toContain("clone");
    expect(all).toContain("before the guard was installed");
  });

  test("the rule count a passing run reports is the number of rules there are", () => {
    // Guards the sentence "passed N rules" from becoming a number nobody
    // maintains: every rule id the suite has seen has to be inside that count.
    const seen = new Set<string>();
    for (const [path, content] of [
      ["personal/x.md", "x"],
      [".env", "x"],
      ["a.pem", "x"],
      ["id_rsa", "x"],
      [".netrc", "x"],
      ["a.md", `-----BEGIN PRIVATE KEY-----`],
      ["a.md", AWS],
      ["a.md", GITHUB],
      ["a.md", ANTHROPIC],
      ["a.md", "sk-" + "0123456789abcdefghijklmno"],
      ["a.md", GOOGLE],
      ["a.md", SLACK],
      ["a.md", JWT],
      ["a.md", "https://user:hunter22@example.invalid"],
      ["a.md", `password = "abcdefghij"`],
      ["a.md", THAI_ID],
      ["a.md", CARD],
    ] as const) {
      for (const finding of rules(path, content)) seen.add(finding);
    }
    seen.add("binary-file");
    expect(seen.size).toBe(SCAN_RULE_COUNT);
  });
});
