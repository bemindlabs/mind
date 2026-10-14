/**
 * S13.5 AC2, step 5 — the remote certificate names what it could not reach, in every verdict.
 */

import { describe, expect, test } from "bun:test";
import { parseRemoteTarget, remoteTrees, type RemoteErasePlan } from "../../src/erase/remote.ts";
import {
  REMOTE_CERTIFICATE_SCHEMA,
  REMOTE_NOT_SEARCHED,
  formatRemoteCertificate,
  remoteCertificate,
} from "../../src/erase/remote-certificate.ts";
import type { RemoteErasure } from "../../src/erase/remote-verify.ts";
import { subjectId } from "../../src/types.ts";
import { sshTarget } from "../support/synthetic-agent.ts";

const SUBJECT = subjectId("example");

function planFor(): RemoteErasePlan {
  const parsed = parseRemoteTarget(sshTarget(), "target.json", SUBJECT);
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return parsed.plan;
}

function build(erasure: RemoteErasure) {
  return remoteCertificate({
    plan: planFor(),
    erasure,
    by: "the owner",
    observedAccount: "bmt",
    engine: "0.0.0-test",
    issuedAt: "2026-10-12T00:00:00Z",
  });
}

const OK: RemoteErasure["erase"] = { ok: true, trees: [] };
const VERDICTS: readonly RemoteErasure[] = [
  { erase: OK, verdict: { verdict: "erased-and-verified" } },
  {
    erase: OK,
    verdict: { verdict: "remaining", left: [{ label: "x", dir: remoteTrees(planFor())[1]?.dir ?? "", state: "present", entries: 2, bytes: 5 }] },
  },
  { erase: OK, verdict: { verdict: "not-verified", reason: "unreachable: down" } },
];

describe("what is not searched", () => {
  test("names provider snapshots, provider backups and the host's own copies", () => {
    const text = REMOTE_NOT_SEARCHED.join("\n");
    expect(text).toContain("provider snapshots");
    expect(text).toContain("provider backups");
    expect(text).toContain("Hostinger");
    expect(text).toContain("copies the host holds");
  });

  test("is in the certificate, the JSON and the printed lines, for every verdict", () => {
    for (const erasure of VERDICTS) {
      const cert = build(erasure);
      expect(cert.schema).toBe(REMOTE_CERTIFICATE_SCHEMA);
      expect(cert.notSearched).toEqual(REMOTE_NOT_SEARCHED);
      expect(JSON.parse(JSON.stringify(cert)).notSearched).toEqual([...REMOTE_NOT_SEARCHED]);
      const lines = formatRemoteCertificate(cert);
      for (const note of REMOTE_NOT_SEARCHED) expect(lines).toContain(`  - ${note}`);
      expect(lines.at(-1)).toBe(`  - ${REMOTE_NOT_SEARCHED.at(-1)}`);
    }
  });

  test("a verified erase still says it is the whole claim and points at the list", () => {
    const cert = build(VERDICTS[0]!);
    expect(cert.verdict).toBe("erased-and-verified");
    expect(cert.statement).toContain("notSearched");
    expect(cert.directories.every((entry) => entry.after === "not there")).toBe(true);
  });
});

describe("the other two verdicts", () => {
  test("remaining marks the directory that is still there, and says the subject is not erased", () => {
    const cert = build(VERDICTS[1]!);
    expect(cert.statement).toContain("not erased");
    expect(cert.directories.filter((entry) => entry.after === "there").length).toBe(1);
    expect(cert.directories.filter((entry) => entry.after === "not there").length).toBe(cert.directories.length - 1);
  });

  test("not-verified is not an erasure certificate and marks every directory unknown", () => {
    const cert = build(VERDICTS[2]!);
    expect(cert.statement).toContain("not an erasure certificate");
    expect(cert.directories.every((entry) => entry.after === "unknown")).toBe(true);
    expect(cert.statement).not.toContain("removed");
  });
});

describe("what the record holds", () => {
  test("who asked is claimed and observed, and no secret or key is in it", () => {
    const cert = build(VERDICTS[0]!);
    expect(cert.by).toMatchObject({ claimed: "the owner", observed: "bmt" });
    expect(JSON.stringify(cert)).not.toMatch(/BEGIN [A-Z ]*KEY|password|secret/i);
  });
});
