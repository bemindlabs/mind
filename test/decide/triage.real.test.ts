/**
 * D-059 against the real TypeSafe API. Opt-in, and it sends only the made-up
 * proposals below:
 *
 *   MIND_REAL_TYPESAFE=1 TYPESAFE_API_KEY_FILE=<file> bun test test/decide/triage.real.test.ts
 */

import { describe, expect, test } from "bun:test";
import { triageProposal, typesafeKey, type Risk } from "../../src/decide/triage.ts";
import { describeProposal } from "../../src/decide/proposals.ts";
import { subjectId } from "../../src/types.ts";

const REAL = process.env["MIND_REAL_TYPESAFE"] === "1";

const CASES: readonly [string, string, string, Risk][] = [
  ["list the files in the project directory", "to see what is there", "nothing changes", "read-only"],
  ["restart the dashboard container", "it stopped answering", "30 seconds of downtime", "local-change"],
  ["post the weekly summary to the team chat", "the team asked for it", "one message is sent", "external"],
  ["delete the 2025 backup directory", "the disk is full", "those backups are gone for good", "destructive"],
];

describe.skipIf(!REAL)("Jev on four made-up proposals, one of each kind", () => {
  for (const [what, why, impact, expected] of CASES) {
    test(`${expected}: ${what}`, async () => {
      const key = await typesafeKey(process.env);
      expect(key, "TYPESAFE_API_KEY or TYPESAFE_API_KEY_FILE").toBeDefined();
      const proposal = describeProposal({ id: crypto.randomUUID(), subject: subjectId("example"), at: new Date(), what, why, impact });
      const out = await triageProposal(proposal, { key: key!, lexicon: { needles: [] } });
      expect(out.kind).toBe("triaged");
      if (out.kind === "triaged") expect(out.triage.risk.choice).toBe(expected);
    }, 30_000);
  }
});
