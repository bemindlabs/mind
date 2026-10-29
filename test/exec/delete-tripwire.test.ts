import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deleteRefusal, installDeleteTripwire, treeTooLarge } from "../../src/exec/delete-tripwire.ts";
import { fenceSupport } from "../../src/exec/fence.ts";
import { BUN } from "../support/bare-path.ts";

const context = { home: "/home/owner", redLines: ["/home/owner/.ssh"], cwd: "/work", real: (path: string) => path, tooMany: (path: string) => path === "/work/large" };
describe("deletion tripwire decision", () => {
  test("protects the owner home, ancestors and red lines", () => {
    for (const path of ["/", "/home", "/home/owner", "/home/owner/.ssh/key"]) expect(deleteRefusal("rm", [path], context)).toBeString();
    expect(deleteRefusal("rm", ["file"], context)).toBeUndefined();
  });
  test("a flag that takes no value never hides the target after it (review finding: `rm -r -f /` was let through)", () => {
    for (const args of [["-r", "-f", "/"], ["-f", "/home/owner"], ["-r", "-f", "/home/owner"], ["-n", "/home/owner/.ssh/key"], ["--recursive", "--force", "/"]]) {
      expect(deleteRefusal("rm", args, context), args.join(" ")).toBeString();
    }
    // The options that DO take a value still do: rsync's --exclude pattern is not a target, shred's -n count is not.
    expect(deleteRefusal("rsync", ["-a", "--delete", "--exclude", "/home", "source", "dest"], context)).toBeUndefined();
    expect(deleteRefusal("shred", ["-n", "3", "file"], context)).toBeUndefined();
    expect(deleteRefusal("shred", ["-n", "3", "/home/owner"], context)).toBeString();
  });
  test("counts expanded arguments and recursive trees", () => {
    expect(deleteRefusal("rm", Array.from({ length: 20 }, (_, i) => `f${i}`), context)).toBeUndefined();
    expect(deleteRefusal("rm", Array.from({ length: 21 }, (_, i) => `f${i}`), context)).toBeString();
    expect(deleteRefusal("rm", ["-rf", "large"], context)).toBeString();
    expect(deleteRefusal("rm", ["large"], context)).toBeUndefined();
  });
  test("checks find and rsync only when they delete", () => {
    expect(deleteRefusal("find", ["/home", "-print"], context)).toBeUndefined();
    expect(deleteRefusal("find", ["/home", "-delete"], context)).toBeString();
    expect(deleteRefusal("find", ["large", "-delete"], context)).toBeString();
    expect(deleteRefusal("find", ["/home", "-execdir", "rm", "{}", ";"], context)).toBeString();
    expect(deleteRefusal("rsync", ["-a", "/home"], context)).toBeUndefined();
    expect(deleteRefusal("rsync", ["-a", "--delete-after", "source", "/home"], context)).toBeString();
    for (const command of ["unlink", "shred", "rmdir"]) expect(deleteRefusal(command, ["/home"], context)).toBeString();
  });
});

describe.skipIf(!fenceSupport().ok)("tripwire through the real fence", () => {
  const scratch: string[] = [];
  afterEach(async () => { for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }); });
  test("refuses a large recursive delete and permits a single file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mind-tripwire-test-")); scratch.push(root);
    const canary = join(root, "canary"); await mkdir(canary);
    for (let i = 0; i < 201; i++) await writeFile(join(canary, `file${i}`), "x");
    const single = join(root, "single"); await writeFile(single, "x");
    expect(treeTooLarge(canary)).toBe(true);
    const entry = resolve(import.meta.dir, "../../bin/mind.ts");
    const path = process.env["PATH"] ?? "/usr/bin:/bin";
    const shims = await installDeleteTripwire({ home: join(root, "owner"), redLines: [] }, path, [BUN, "run", entry], tmpdir()); scratch.push(shims);
    const shell = `rm -rf "$1"; result=$?; rm "$2"; exit "$result"`;
    const script = `const p = Bun.spawnSync(["/bin/sh", "-c", ${JSON.stringify(shell)}, "sh", ${JSON.stringify(canary)}, ${JSON.stringify(single)}], {stdout:"inherit", stderr:"inherit"}); process.exit(p.exitCode);`;
    const child = Bun.spawn([BUN, "run", entry, "__fence", "--confine-reads", "--rw", root, "--ro", shims, "--", BUN, "-e", script], {
      cwd: root, env: { ...process.env, PATH: `${shims}:${path}`, MIND_NO_UPDATE_CHECK: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(97);
    expect(stderr).toContain("stop and ask the person");
    expect(existsSync(join(canary, "file0"))).toBe(true);
    expect(existsSync(single)).toBe(false);
  }, 60_000);
});
