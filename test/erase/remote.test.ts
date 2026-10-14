/**
 * S13.5 AC2, step 1 — `erase --remote` says where the remote half would look, and takes the paths
 * from the data map's own resolver evaluated with the remote's roots. It sends nothing.
 */

import { describe, expect, test } from "bun:test";
import { remoteEnv, remoteLayout } from "../../src/deploy/plan.ts";
import { dataMap } from "../../src/erase/map.ts";
import { describeMachine, formatRemotePlan, parseRemoteTarget, remoteErasePlan, remoteTrees } from "../../src/erase/remote.ts";
import { subjectId } from "../../src/types.ts";
import { sshTarget } from "../support/synthetic-agent.ts";

const SUBJECT = subjectId("example");
const GCP = JSON.stringify({ name: "vm-1", provider: "gcp", gcp: { project: "proj-123456", zone: "europe-west4-a" } });
const AWS = JSON.stringify({ name: "vm-2", provider: "aws", aws: { region: "eu-central-1" } });

function planFor(text: string) {
  const parsed = parseRemoteTarget(text, "target.json", SUBJECT);
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return parsed.plan;
}

describe("the remote data map", () => {
  test("is dataMap evaluated with the remote's roots — no path written by hand", () => {
    const plan = planFor(sshTarget());
    const layout = remoteLayout(SUBJECT);
    expect(plan.layout).toEqual(layout);
    expect(plan.map).toEqual(dataMap(remoteEnv(layout), SUBJECT, layout.agentDir));
    expect(remoteTrees(plan).length).toBeGreaterThan(5);
  });

  test("every directory it lists is under the remote volume, and none under this machine's home", () => {
    const plan = planFor(sshTarget());
    const here = remoteTrees(plan);
    expect(here.length).toBeGreaterThan(5);
    for (const tree of here) {
      expect(tree.dir.startsWith(`${plan.layout.volume}/`), tree.dir).toBe(true);
    }
  });

  test("the printed lines name every one of them, and the machine", () => {
    const plan = planFor(sshTarget());
    const text = formatRemotePlan(plan).join("\n");
    for (const tree of remoteTrees(plan)) expect(text).toContain(tree.dir);
    expect(text).toContain("deploy@203.0.113.10:22");
    expect(text).toContain("Nothing on the remote has been looked at or changed");
  });

  test("the same layout gives the same plan for each provider, and each says where the machine is", () => {
    const ssh = planFor(sshTarget());
    const gcp = planFor(GCP);
    const aws = planFor(AWS);
    expect(remoteTrees(gcp)).toEqual(remoteTrees(ssh));
    expect(remoteTrees(aws)).toEqual(remoteTrees(ssh));
    expect(describeMachine(gcp.target)).toBe("vm-1 — gcp proj-123456/europe-west4-a");
    expect(describeMachine(aws.target)).toBe("vm-2 — aws eu-central-1");
    expect(remoteErasePlan(ssh.target, SUBJECT).machine).toBe(ssh.machine);
  });
});

describe("a target that is not one", () => {
  test("is refused with the file's name and no plan", () => {
    const parsed = parseRemoteTarget("{ not json", "bad.json", SUBJECT);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems.length).toBeGreaterThan(0);
      expect(parsed.problems[0]).toContain("bad.json");
    }
  });
});
