/**
 * The schema, and the decision that shrank `target`.
 *
 * Two things are worth testing here and the second is the one that matters.
 * The first is ordinary: a line round-trips, a line from another version is
 * refused, a malformed line comes back as a reason rather than an exception.
 *
 * The second is the owner's ruling on what a `target` may hold. The plan for w4
 * proposed a whole command line capped at 512 characters, relying on the
 * pre-commit secret scan to blank out anything dangerous; the owner refused
 * that, on the grounds that a command line is where secrets and personal data
 * most often sit and that the scan's own blind-spot list says it cannot see
 * prose. So the rule is per kind, and these tests are what stop it quietly
 * widening again: each one carries something a full command line would have
 * kept.
 *
 * Every value below is invented (ADR 0001 §4). `/synthetic/...` is not a path
 * on any machine.
 */

import { describe, expect, test } from "bun:test";
import {
  CAPTURE_FIELDS,
  CAPTURE_VENDORS,
  CAPTURE_VERSION,
  commandTarget,
  fileTarget,
  formatRecord,
  fromValue,
  isCaptureVendor,
  NO_EVIDENCE,
  parseRecord,
  TARGET_MAX,
  type CaptureRecord,
  SEED_VENDORS,
  isSeedVendor,
} from "../../src/observer/record.ts";

const RECORD: CaptureRecord = {
  v: CAPTURE_VERSION,
  key: "claude:tool:t-1",
  at: "2026-09-21T10:00:00.000Z",
  vendor: "claude",
  session: "s-1",
  project: "/synthetic/project",
  kind: "command",
  tool: "Bash",
  target: "git commit",
  outcome: "ok",
  source: "hook",
  origin: "owner-prompted",
  evidence: {
    promptSource: "user",
    permissionMode: "default",
    subagent: false,
    humanTurnsInSession: 2,
  },
};

describe("target — a command keeps two words and loses the rest", () => {
  test("the program and its first subcommand, and nothing after", () => {
    expect(commandTarget("git commit -m 'fix the thing'")).toBe("git commit");
    expect(commandTarget("docker restart accounting-app")).toBe("docker restart");
    expect(commandTarget("ls")).toBe("ls");
  });

  test("the things a whole command line would have kept, and does not", () => {
    // Each of these is a real category from the owner's ruling: a token in a
    // header, somebody's name in a path, a prompt passed as an argument.
    expect(commandTarget('curl -H "Authorization: Bearer sk-ant-not-a-real-key" https://x/y')).toBe(
      "curl",
    );
    expect(commandTarget("scp /home/someone/tax-return.pdf server:/backup")).toBe("scp");
    expect(commandTarget('claude -p "remind me what my doctor said about the results"')).toBe(
      "claude",
    );

    // And the negative form of the same assertions, so a future change that
    // started keeping arguments fails here rather than in six weeks.
    for (const line of [
      'curl -H "Authorization: Bearer sk-ant-not-a-real-key" https://x/y',
      "scp /home/someone/tax-return.pdf server:/backup",
      'claude -p "remind me what my doctor said about the results"',
    ]) {
      const kept = commandTarget(line);
      expect(kept.length).toBeLessThan(12);
      expect(line.startsWith(kept.split(" ")[0] ?? "")).toBe(true);
    }
  });

  test("the program name is a basename, because a path to it names a person", () => {
    expect(commandTarget("/home/someone/bin/deploy --prod")).toBe("deploy");
  });

  test("a second word that is not vocabulary is dropped rather than trimmed", () => {
    expect(commandTarget("cat /synthetic/secrets.env")).toBe("cat");
    expect(commandTarget("node --experimental-x server.js")).toBe("node");
    expect(commandTarget("git --no-pager log")).toBe("git");
  });

  test("the understatement this rule admits to, asserted rather than hoped for", () => {
    // Stated in CAPTURE_LIMITS: no shell parsing, so this really does lose the
    // push. A test that pretended otherwise would be the place the rule starts
    // to drift.
    expect(commandTarget("cd /synthetic/project && git push")).toBe("cd");
  });

  test("an empty command is an empty target, not an invented one", () => {
    expect(commandTarget("")).toBe("");
    expect(commandTarget("   ")).toBe("");
  });
});

describe("target — a file keeps its path, relative to the project", () => {
  test("inside the project, the path is the behaviour", () => {
    expect(fileTarget("/synthetic/project/src/observer/reader.ts", "/synthetic/project")).toBe(
      "src/observer/reader.ts",
    );
  });

  test("outside the project, the `..` is kept rather than hidden", () => {
    expect(fileTarget("/synthetic/elsewhere/notes.md", "/synthetic/project")).toBe(
      "../elsewhere/notes.md",
    );
  });

  test("a relative path, and no project, are left alone", () => {
    expect(fileTarget("src/a.ts", "/synthetic/project")).toBe("src/a.ts");
    expect(fileTarget("/synthetic/a.ts", "")).toBe("/synthetic/a.ts");
    expect(fileTarget("", "/synthetic")).toBe("");
  });

  test("a very long path is cut, and says it was", () => {
    const long = `/synthetic/${"deep/".repeat(200)}file.ts`;
    const kept = fileTarget(long, "/synthetic");
    expect(kept.length).toBe(TARGET_MAX);
    expect(kept.endsWith("…")).toBe(true);
  });
});

describe("reading a line back", () => {
  test("a record round-trips through format and parse", () => {
    const parsed = parseRecord(formatRecord(RECORD));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toEqual(RECORD);
  });

  test("a bad line is a reason, and the reason never quotes the line", () => {
    const secret = '{"target": "sk-ant-not-a-real-key"';
    const parsed = parseRecord(secret);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("unparsable");
    // The whole point: `JSON.parse`'s own message contains the input.
    expect(parsed.reason).not.toContain("sk-ant");
  });

  test("a line from another schema version is skipped, not guessed at", () => {
    const other = JSON.stringify({ ...RECORD, v: CAPTURE_VERSION + 1 });
    const parsed = parseRecord(other);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("wrong-version");
  });

  test("each required field, missing, gives its own reason", () => {
    const cases: readonly [string, string][] = [
      ["key", "no-key"],
      ["at", "no-time"],
      ["vendor", "vendor"],
      ["session", "shape"],
      ["kind", "shape"],
      ["outcome", "shape"],
      ["origin", "shape"],
    ];
    for (const [field, reason] of cases) {
      const broken: Record<string, unknown> = { ...RECORD };
      delete broken[field];
      const parsed = fromValue(broken);
      expect(parsed.ok, `${field} should have been refused`).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe(reason);
    }
  });

  test("a value outside a closed union is refused rather than widened", () => {
    expect(fromValue({ ...RECORD, kind: "thought" }).ok).toBe(false);
    expect(fromValue({ ...RECORD, outcome: "probably" }).ok).toBe(false);
    expect(fromValue({ ...RECORD, vendor: "codex" }).ok).toBe(false);
    expect(fromValue({ ...RECORD, origin: "the owner, definitely" }).ok).toBe(false);
  });

  test("a missing evidence block is still a valid line", () => {
    const without: Record<string, unknown> = { ...RECORD };
    delete without["evidence"];
    const parsed = fromValue(without);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.evidence).toEqual(NO_EVIDENCE);
  });

  test("something that is not an object at all", () => {
    expect(parseRecord("[]").ok).toBe(false);
    expect(parseRecord('"a string"').ok).toBe(false);
    expect(parseRecord("null").ok).toBe(false);
  });
});

describe("the vendor union is closed (S3.1 AC6)", () => {
  test("claude, grok and Mind itself, and nothing else", () => {
    // D-032 added the engine's own name — the recorder naming its own turns — and nothing
    // was opened: codex and kimi are as absent as before, and a closed union
    // with three members is still closed.
    expect([...CAPTURE_VENDORS]).toEqual(["claude", "grok", "mind"]);
    expect(isCaptureVendor("claude")).toBe(true);
    expect(isCaptureVendor("grok")).toBe(true);
    expect(isCaptureVendor("mind")).toBe(true);
    expect(isCaptureVendor("codex")).toBe(false);
    expect(isCaptureVendor("kimi")).toBe(false);
  });

  test("a seed reads the two vendors with files on disk; Mind has none", () => {
    expect([...SEED_VENDORS]).toEqual(["claude", "grok"]);
    expect(isSeedVendor("claude")).toBe(true);
    expect(isSeedVendor("mind")).toBe(false);
    expect(isSeedVendor("codex")).toBe(false);
  });
});

describe("the field list is the consent", () => {
  test("it says what is kept and what is not, in both directions", () => {
    const kept = CAPTURE_FIELDS.filter((line) => line.startsWith("kept:"));
    const refused = CAPTURE_FIELDS.filter((line) => line.startsWith("not kept:"));
    expect(kept.length).toBeGreaterThan(5);
    expect(refused.length).toBeGreaterThan(2);

    const all = CAPTURE_FIELDS.join("\n");
    // The three refusals the schema is built around. Deleting one of these
    // lines would change what somebody agreed to without changing the hash if
    // it were not asserted here too.
    expect(all).toContain("not kept: the text of anything you typed");
    expect(all).toContain("not kept: the rest of a command line");
    expect(all).toContain("codex, gemini, copilot or kimi");
  });
});
