/**
 * S13.5 AC2, step 4 — ask the remote again after deleting. Fake ssh runner only.
 */

import { describe, expect, test } from "bun:test";
import { parseRemoteTarget, remoteTrees, type RemoteErasePlan } from "../../src/erase/remote.ts";
import { erasePhrase } from "../../src/erase/remote-erase.ts";
import type { RunResult, Runner } from "../../src/erase/remote-probe.ts";
import {
  eraseAndVerifyRemote,
  formatRemoteVerdict,
  judgeProbe,
  remoteExitCode,
  verifyRemote,
} from "../../src/erase/remote-verify.ts";
import { subjectId } from "../../src/types.ts";
import { sshTarget } from "../support/synthetic-agent.ts";

const SUBJECT = subjectId("example");

function planFor(): RemoteErasePlan {
  const parsed = parseRemoteTarget(sshTarget(), "target.json", SUBJECT);
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  return parsed.plan;
}

const GONE: RunResult = { code: 1, stdout: "", stderr: "find: 'x': No such file or directory\n" };

/** A far side with directories in it. `rm -rf` removes one unless `keep` holds it; `find` lists what is there. */
function fakeRemote(dirs: readonly string[], opts: { keep?: ReadonlySet<string>; down?: boolean; downAfterRm?: boolean } = {}) {
  const there = new Set(dirs);
  let removed = false;
  const run: Runner = async (argv) => {
    const last = argv[argv.length - 1] ?? "";
    const isFind = argv.includes("find");
    const down = opts.down === true || (opts.downAfterRm === true && removed && isFind);
    if (down) return { code: 255, stdout: "", stderr: "ssh: connect to host: Connection refused\n" };
    if (argv.includes("rm")) {
      removed = true;
      if (!opts.keep?.has(last)) there.delete(last);
      return { code: 0, stdout: "", stderr: "" };
    }
    const dir = argv[argv.indexOf("find") + 1] ?? "";
    return there.has(dir) ? { code: 0, stdout: "f10,", stderr: "" } : GONE;
  };
  return { run, there };
}

describe("the verdict", () => {
  test("everything gone, asked again → erased-and-verified, exit 0", async () => {
    const plan = planFor();
    const dirs = remoteTrees(plan).map((tree) => tree.dir);
    const fake = fakeRemote(dirs);
    const done = await eraseAndVerifyRemote(plan, erasePhrase(SUBJECT, plan.target.name), fake.run);
    expect(done.erase.ok).toBe(true);
    expect(done.verdict).toEqual({ verdict: "erased-and-verified" });
    expect(remoteExitCode(done.verdict)).toBe(0);
  });

  test("something still there → remaining, naming it, exit 1 — even though every rm exited 0", async () => {
    const plan = planFor();
    const dirs = remoteTrees(plan).map((tree) => tree.dir);
    const stays = dirs[2] ?? "";
    const done = await eraseAndVerifyRemote(plan, erasePhrase(SUBJECT, plan.target.name), fakeRemote(dirs, { keep: new Set([stays]) }).run);
    expect(done.erase.ok).toBe(true);
    expect(done.verdict.verdict).toBe("remaining");
    if (done.verdict.verdict === "remaining") expect(done.verdict.left.map((tree) => tree.dir)).toEqual([stays]);
    expect(remoteExitCode(done.verdict)).toBe(1);
    expect(formatRemoteVerdict(plan, SUBJECT, done.verdict).join("\n")).toContain(stays);
  });

  test("an empty directory left behind is remaining, not erased", () => {
    const plan = planFor();
    const dir = remoteTrees(plan)[0]?.dir ?? "";
    const verdict = judgeProbe({ ok: true, trees: [{ label: "x", dir, state: "present", entries: 0, bytes: 0 }] });
    expect(verdict.verdict).toBe("remaining");
  });
});

describe("a remote that cannot be asked", () => {
  test("down from the start → not-verified, non-zero, and never 'erased'", async () => {
    const plan = planFor();
    const dirs = remoteTrees(plan).map((tree) => tree.dir);
    const done = await eraseAndVerifyRemote(plan, erasePhrase(SUBJECT, plan.target.name), fakeRemote(dirs, { down: true }).run);
    expect(done.erase.ok).toBe(false);
    expect(done.verdict.verdict).toBe("not-verified");
    expect(remoteExitCode(done.verdict)).toBe(4);
    const text = formatRemoteVerdict(plan, SUBJECT, done.verdict).join("\n");
    expect(text).toContain("NOT VERIFIED");
    expect(text).not.toContain("erased-and-verified");
  });

  test("deleted fine, then the machine stops answering → not-verified, though every rm exited 0", async () => {
    const plan = planFor();
    const dirs = remoteTrees(plan).map((tree) => tree.dir);
    const done = await eraseAndVerifyRemote(plan, erasePhrase(SUBJECT, plan.target.name), fakeRemote(dirs, { downAfterRm: true }).run);
    expect(done.erase.ok).toBe(true);
    expect(done.verdict.verdict).toBe("not-verified");
    expect(remoteExitCode(done.verdict)).not.toBe(0);
  });

  test("a probe failure of any kind is not-verified", () => {
    for (const reason of ["unreachable", "unreadable", "unsupported-provider"] as const) {
      expect(judgeProbe({ ok: false, reason, detail: "d" }).verdict).toBe("not-verified");
    }
  });
});

describe("the wrong phrase", () => {
  test("sends nothing and asks nothing, and the verdict says so", async () => {
    const plan = planFor();
    const calls: string[][] = [];
    const done = await eraseAndVerifyRemote(plan, "yes", async (argv) => {
      calls.push([...argv]);
      return GONE;
    });
    expect(calls).toEqual([]);
    expect(done.verdict.verdict).toBe("not-verified");
    expect(remoteExitCode(done.verdict)).toBe(4);
  });
});

describe("verifyRemote and the lines", () => {
  test("verifyRemote alone on an empty machine is erased-and-verified, and says what it asked", async () => {
    const plan = planFor();
    const verdict = await verifyRemote(plan, fakeRemote([]).run);
    expect(verdict).toEqual({ verdict: "erased-and-verified" });
    const line = formatRemoteVerdict(plan, SUBJECT, verdict).join("\n");
    expect(line).toContain("Asked again after deleting");
    expect(line).toContain(plan.machine);
  });
});
