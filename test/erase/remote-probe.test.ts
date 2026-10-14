/**
 * S13.5 AC2, step 2 — the read-only look at the remote, on a fake ssh runner. No real machine is touched.
 */

import { describe, expect, test } from "bun:test";
import { parseRemoteTarget, remoteTrees, type RemoteErasePlan } from "../../src/erase/remote.ts";
import { formatProbe, probeArgv, probeRemote, type RunResult, type Runner } from "../../src/erase/remote-probe.ts";
import { subjectId } from "../../src/types.ts";
import { sshTarget } from "../support/synthetic-agent.ts";

const SUBJECT = subjectId("example");

function planFor(text: string): RemoteErasePlan {
  const parsed = parseRemoteTarget(text, "target.json", SUBJECT);
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return parsed.plan;
}

const GONE: RunResult = { code: 1, stdout: "", stderr: "find: '/x': No such file or directory\n" };

/** A fake far side: `there` maps a directory to what `find` would print; everything else is not there. */
function fakeRemote(there: Readonly<Record<string, string>>): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    const dir = argv[argv.indexOf("find") + 1] ?? "";
    const listing = there[dir];
    return listing === undefined ? GONE : { code: 0, stdout: listing, stderr: "" };
  };
  return { run, calls };
}

describe("the argv", () => {
  test("is the ssh reach of deploy, then find on the directory the data map names", () => {
    const plan = planFor(sshTarget());
    const dir = remoteTrees(plan)[0]?.dir ?? "";
    expect(probeArgv(plan.target, dir)).toEqual([
      "ssh", "-p", "22", "-o", "BatchMode=yes", "deploy@203.0.113.10", "--", "find", dir, "-printf", "%y%s,",
    ]);
  });

  test("a target that is not ssh has none", () => {
    const gcp = planFor(JSON.stringify({ name: "vm-1", provider: "gcp", gcp: { project: "proj-123456", zone: "europe-west4-a" } }));
    expect(probeArgv(gcp.target, "/srv/x")).toBeUndefined();
  });

  test("a directory a remote shell would split is refused, not sent", () => {
    const plan = planFor(sshTarget());
    expect(() => probeArgv(plan.target, "/srv/a b; rm -rf /")).toThrow("not a plain word");
  });
});

describe("the look", () => {
  test("the same layout gives the same listing, and every directory of the map is asked once", async () => {
    const plan = planFor(sshTarget());
    const trees = remoteTrees(plan);
    const first = trees[0]?.dir ?? "";
    const fake = fakeRemote({ [first]: "d4096,f120,f30,l9," });
    const one = await probeRemote(plan, fake.run);
    const two = await probeRemote(plan, fakeRemote({ [first]: "d4096,f120,f30,l9," }).run);
    expect(one).toEqual(two);
    expect(fake.calls.length).toBe(trees.length);
    expect(fake.calls.map((argv) => argv[argv.indexOf("find") + 1])).toEqual(trees.map((tree) => tree.dir));
    if (!one.ok) throw new Error(one.detail);
    expect(one.trees[0]).toEqual({ label: trees[0]?.label ?? "", dir: first, state: "present", entries: 3, bytes: 150 });
    expect(one.trees.slice(1).every((tree) => tree.state === "absent")).toBe(true);
  });

  test("nothing in any argv is a key or a word from outside the layout", async () => {
    const plan = planFor(sshTarget());
    const fake = fakeRemote({});
    await probeRemote(plan, fake.run);
    for (const argv of fake.calls) {
      expect(argv.slice(0, 7)).toEqual(["ssh", "-p", "22", "-o", "BatchMode=yes", "deploy@203.0.113.10", "--"]);
      expect(argv.slice(7, 8)).toEqual(["find"]);
      expect(argv.slice(9)).toEqual(["-printf", "%y%s,"]);
    }
  });

  test("an unreachable machine is a failure, never an empty listing", async () => {
    const plan = planFor(sshTarget());
    const result = await probeRemote(plan, async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host: Connection refused\n" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unreachable");
      expect(result.detail).toContain("Connection refused");
    }
  });

  test("a runner that throws is unreachable too", async () => {
    const plan = planFor(sshTarget());
    const result = await probeRemote(plan, async () => {
      throw new Error("spawn ssh ENOENT");
    });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  test("a permission error is not 'not there'", async () => {
    const plan = planFor(sshTarget());
    const denied: RunResult = { code: 1, stdout: "", stderr: "find: '/x': Permission denied\n" };
    expect(await probeRemote(plan, async () => denied)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("'no such file' next to another complaint is not 'not there'", async () => {
    const plan = planFor(sshTarget());
    const mixed: RunResult = { code: 1, stdout: "", stderr: "find: '/x': No such file or directory\nfind: '/y': Permission denied\n" };
    expect(await probeRemote(plan, async () => mixed)).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("a listing it cannot parse fails, and so does exit 0 with output that is not one", async () => {
    const plan = planFor(sshTarget());
    expect(await probeRemote(plan, async () => ({ code: 0, stdout: "banner text", stderr: "" }))).toMatchObject({ ok: false, reason: "unreadable" });
  });

  test("an empty directory is there, with nothing in it", async () => {
    const plan = planFor(sshTarget());
    const result = await probeRemote(plan, async () => ({ code: 0, stdout: "d4096,", stderr: "" }));
    if (!result.ok) throw new Error(result.detail);
    expect(result.trees.every((tree) => tree.state === "present" && tree.entries === 0 && tree.bytes === 0)).toBe(true);
  });

  test("only ssh can be looked at so far, and it says so", async () => {
    const gcp = planFor(JSON.stringify({ name: "vm-1", provider: "gcp", gcp: { project: "proj-123456", zone: "europe-west4-a" } }));
    let ran = false;
    const result = await probeRemote(gcp, async () => {
      ran = true;
      return GONE;
    });
    expect(ran).toBe(false);
    expect(result).toMatchObject({ ok: false, reason: "unsupported-provider" });
  });
});

describe("the lines", () => {
  test("say what is there and what is not, and a failure says it could not look", async () => {
    const plan = planFor(sshTarget());
    const first = remoteTrees(plan)[0]?.dir ?? "";
    const ok = await probeRemote(plan, fakeRemote({ [first]: "f10," }).run);
    const text = formatProbe(ok).join("\n");
    expect(text).toContain(`${first} — 1 entries, 10 bytes`);
    expect(text).toContain("— not there");
    const failed = formatProbe({ ok: false, reason: "unreachable", detail: "x" });
    expect(failed).toEqual(["remote — could not look (unreachable): x"]);
  });
});
