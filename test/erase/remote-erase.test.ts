/**
 * S13.5 AC2, step 3 — erase on the remote, replayed on a fake ssh runner. No real machine is touched.
 */

import { describe, expect, test } from "bun:test";
import { parseRemoteTarget, remoteTrees, type RemoteErasePlan } from "../../src/erase/remote.ts";
import { eraseArgv, erasePhrase, eraseRemote } from "../../src/erase/remote-erase.ts";
import type { RunResult, Runner } from "../../src/erase/remote-probe.ts";
import { subjectId } from "../../src/types.ts";
import { sshTarget } from "../support/synthetic-agent.ts";

const SUBJECT = subjectId("example");
const SSH = ["ssh", "-p", "22", "-o", "BatchMode=yes", "deploy@203.0.113.10", "--"];

function planFor(text: string): RemoteErasePlan {
  const parsed = parseRemoteTarget(text, "target.json", SUBJECT);
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return parsed.plan;
}

const typedFor = (plan: RemoteErasePlan): string => erasePhrase(SUBJECT, plan.target.name);

/** A fake far side that holds a set of directories and removes the one `rm -rf` names. */
function fakeRemote(dirs: Iterable<string>, reply: (argv: readonly string[]) => RunResult | undefined = () => undefined) {
  const there = new Set(dirs);
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    const special = reply(argv);
    if (special !== undefined) return special;
    there.delete(argv[argv.length - 1] ?? "");
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, there };
}

describe("the phrase", () => {
  test("names the subject and the machine", () => {
    expect(erasePhrase(SUBJECT, "vps-1")).toBe("erase example on vps-1");
  });

  test("anything else sends nothing", async () => {
    const plan = planFor(sshTarget());
    for (const typed of ["", "yes", "erase example", erasePhrase(subjectId("other"), plan.target.name), `${typedFor(plan)} `]) {
      const fake = fakeRemote([]);
      const result = await eraseRemote(plan, typed, fake.run);
      expect(result).toMatchObject({ ok: false, reason: "phrase", trees: [] });
      expect(fake.calls).toEqual([]);
    }
  });
});

describe("the replayed transcript", () => {
  test("every tree of the remote map is removed, in the map's order, ledger last", async () => {
    const plan = planFor(sshTarget());
    const trees = remoteTrees(plan);
    const fake = fakeRemote(trees.map((tree) => tree.dir));
    const result = await eraseRemote(plan, typedFor(plan), fake.run);
    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual(trees.map((tree) => [...SSH, "rm", "-rf", "--", tree.dir]));
    expect([...fake.there]).toEqual([]);
    expect(result.trees.map((tree) => tree.outcome)).toEqual(trees.map(() => "ran"));
    // The current roots first, the ledger last of them; then the same trees under the root's other names.
    expect(plan.map.ledger.dir).toBe(trees[plan.map.trees.length]?.dir ?? "");
  });

  test("no word in any argv is a key or a personal word — only the reach, rm, and the layout's paths", async () => {
    const plan = planFor(sshTarget());
    const paths = new Set(remoteTrees(plan).map((tree) => tree.dir));
    const fake = fakeRemote([]);
    await eraseRemote(plan, typedFor(plan), fake.run);
    const allowed = new Set([...SSH, "rm", "-rf", "--", ...paths]);
    for (const argv of fake.calls) for (const word of argv) expect(allowed.has(word), word).toBe(true);
  });
});

describe("what goes wrong", () => {
  test("an unreachable machine stops the run, and the rest are 'not attempted', not 'ran'", async () => {
    const plan = planFor(sshTarget());
    const fake = fakeRemote([], () => ({ code: 255, stdout: "", stderr: "ssh: connect to host: Connection refused\n" }));
    const result = await eraseRemote(plan, typedFor(plan), fake.run);
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(fake.calls.length).toBe(1);
    expect(result.trees[0]?.outcome).toBe("failed");
    expect(result.trees.slice(1).every((tree) => tree.outcome === "not-attempted")).toBe(true);
  });

  test("a runner that throws is unreachable", async () => {
    const plan = planFor(sshTarget());
    const result = await eraseRemote(plan, typedFor(plan), async () => {
      throw new Error("spawn ssh ENOENT");
    });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  test("one directory that will not go does not hide the others, and the run is not ok", async () => {
    const plan = planFor(sshTarget());
    const trees = remoteTrees(plan);
    const stuck = trees[1]?.dir ?? "";
    const fake = fakeRemote(trees.map((tree) => tree.dir), (argv) =>
      argv[argv.length - 1] === stuck ? { code: 1, stdout: "", stderr: "rm: cannot remove: Permission denied\n" } : undefined,
    );
    const result = await eraseRemote(plan, typedFor(plan), fake.run);
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(fake.calls.length).toBe(trees.length);
    expect(result.trees[1]).toMatchObject({ outcome: "failed" });
    expect(result.trees[1]?.detail).toContain("Permission denied");
    expect([...fake.there]).toEqual([stuck]);
  });

  test("a target that is not ssh sends nothing", async () => {
    const plan = planFor(JSON.stringify({ name: "vm-1", provider: "aws", aws: { region: "eu-central-1" } }));
    const fake = fakeRemote([]);
    const result = await eraseRemote(plan, erasePhrase(SUBJECT, "vm-1"), fake.run);
    expect(result).toMatchObject({ ok: false, reason: "unsupported-provider" });
    expect(fake.calls).toEqual([]);
  });
});

describe("only under the volume", () => {
  test("the volume itself, a sibling, a '..' and a shell word are refused", () => {
    const plan = planFor(sshTarget());
    const volume = plan.layout.volume;
    for (const dir of [volume, `${volume}/`, "/", "/srv", `${volume}-other/x`, `${volume}/a/../../etc`, `${volume}/a b`, `${volume}/a;b`]) {
      expect(() => eraseArgv(plan, dir), dir).toThrow();
    }
    expect(eraseArgv(plan, `${volume}/agents/x`)).toEqual([...SSH, "rm", "-rf", "--", `${volume}/agents/x`]);
  });

  test("a plan with one bad directory sends nothing at all", async () => {
    const plan = planFor(sshTarget());
    const bad: RemoteErasePlan = { ...plan, map: { ...plan.map, ledger: { ...plan.map.ledger, dir: "/etc" } } };
    const fake = fakeRemote([]);
    const result = await eraseRemote(bad, typedFor(bad), fake.run);
    expect(result).toMatchObject({ ok: false, reason: "outside-volume", trees: [] });
    expect(fake.calls).toEqual([]);
  });
});
