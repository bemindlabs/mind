/**
 * S13.5 AC3, step 7 — one line per remote erase, outside the subject's trees, holding nothing about the subject.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRemoteTarget, remoteTrees, type RemoteErasePlan } from "../../src/erase/remote.ts";
import { appendRemoteEraseLine, remoteEraseLine, remoteEraseLogPath } from "../../src/erase/remote-log.ts";
import type { RemoteErasure } from "../../src/erase/remote-verify.ts";
import { subjectId } from "../../src/types.ts";
import { sshTarget } from "../support/synthetic-agent.ts";

const SUBJECT = subjectId("zz-log-subject");
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

function planFor(): RemoteErasePlan {
  const parsed = parseRemoteTarget(sshTarget(), "t.json", SUBJECT);
  if (!parsed.ok) throw new Error("bad target");
  return parsed.plan;
}
const OK: RemoteErasure["erase"] = { ok: true, trees: [] };
const AT = "2026-10-12T10:00:00.000Z";

describe("the line", () => {
  test("erased: verdict, exit 0, nothing remaining, every directory counted", () => {
    const plan = planFor();
    const line = remoteEraseLine(plan, { erase: OK, verdict: { verdict: "erased-and-verified" } }, AT);
    expect(line).toEqual({
      v: 1, kind: "remote-erase", at: AT, machine: "vps-1", provider: "ssh",
      verdict: "erased-and-verified", exit: 0, directories: remoteTrees(plan).length, remaining: 0,
    });
  });

  test("remaining counts what is left; not-verified says it was not asked", () => {
    const plan = planFor();
    const left = { label: "x", dir: "/srv/x/y", state: "present", entries: 1, bytes: 1 } as const;
    expect(remoteEraseLine(plan, { erase: OK, verdict: { verdict: "remaining", left: [left, left] } }, AT)).toMatchObject({ verdict: "remaining", exit: 1, remaining: 2 });
    expect(remoteEraseLine(plan, { erase: OK, verdict: { verdict: "not-verified", reason: "down" } }, AT)).toMatchObject({ verdict: "not-verified", exit: 4, remaining: null });
  });

  test("holds nothing about the subject: not its id, not a path, not the reason text", () => {
    const plan = planFor();
    for (const verdict of [
      { verdict: "erased-and-verified" },
      { verdict: "not-verified", reason: `unreachable: ${SUBJECT} ${plan.layout.agentDir}` },
    ] as const) {
      const text = JSON.stringify(remoteEraseLine(plan, { erase: OK, verdict }, AT));
      expect(text).not.toContain(SUBJECT);
      expect(text).not.toContain("/srv");
      expect(text).not.toContain("unreachable");
    }
  });
});

describe("the file", () => {
  test("is under the state root, outside the ledger and every subject tree, and appends one line per call, privately", async () => {
    const root = await mkdtemp(join(tmpdir(), "mind-remote-log-"));
    scratch.push(root);
    const plan = planFor();
    const line = remoteEraseLine(plan, { erase: OK, verdict: { verdict: "erased-and-verified" } }, AT);
    await appendRemoteEraseLine(join(root, "state"), line);
    await appendRemoteEraseLine(join(root, "state"), line);
    const path = remoteEraseLogPath(join(root, "state"));
    expect(path).toBe(join(root, "state", "remote-erase.jsonl"));
    const rows = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(rows.map((row) => JSON.parse(row))).toEqual([line, line]);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });
});
