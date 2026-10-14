/**
 * `mind deploy`, as a person types it.
 *
 * Spawned, because what is checked here belongs to the command line: the exit
 * codes, the two output shapes, the subcommands that are named and not built —
 * and the two claims the plan prints about itself, measured rather than
 * trusted: **it writes nothing**, and **it starts nothing**. For the second,
 * PATH holds a trap for every program the plan names (`ssh`, `scp`, `gcloud`,
 * `aws`, `git`, `tar`) that leaves a mark if it is ever run; a control runs one
 * of them by hand to show the mark appears.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BUN } from "../support/bare-path.ts";
import { sshTarget, writeSyntheticAgent, type SyntheticAgent } from "../support/synthetic-agent.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");


/** Every program a plan's commands name. None of them may run while one is made. */
const TRAPPED = ["ssh", "scp", "gcloud", "aws", "git", "tar"];

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Box {
  readonly root: string;
  readonly made: SyntheticAgent;
  readonly traps: string;
  readonly marks: string;
  readonly target: string;
}

async function box(commits: "committed" | "no-commits" = "committed"): Promise<Box> {
  const root = await mkdtemp(join(tmpdir(), "mind-deploy-cli-"));
  scratch.push(root);
  const made = await writeSyntheticAgent(root, commits);
  const traps = join(root, "traps");
  const marks = join(root, "marks");
  await Bun.write(join(marks, ".keep"), "");
  for (const name of TRAPPED) {
    const path = join(traps, name);
    await Bun.write(path, `#!/bin/sh\necho "$0 $*" > "${marks}/${name}"\nexit 97\n`);
    await chmod(path, 0o755);
  }
  await symlink(BUN, join(traps, "bun"));
  const target = join(root, "target.json");
  await writeFile(target, sshTarget({ home: "desk" }));
  return { root, made, traps, marks, target };
}

async function run(b: Box, args: readonly string[]) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], {
    cwd: b.root,
    env: { HOME: b.made.home, PATH: b.traps, ...b.made.env, CODEX_HOME: join(b.made.home, ".codex") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

/** What the runtime launching the binary writes into a home before Mind runs a line. */
const RUNNER_CACHE = ".bun";

async function tree(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const rel = relative(root, path);
      if (rel.split("/").includes(RUNNER_CACHE)) continue;
      if (entry.isDirectory()) {
        found.push(`${rel}/`);
        await walk(path);
      } else if (entry.isSymbolicLink()) {
        found.push(`${rel} ->`);
      } else {
        const info = await stat(path);
        found.push(`${rel} ${info.size} ${info.mtimeMs}`);
      }
    }
  };
  await walk(root);
  return found.sort();
}

const planArgs = (b: Box, ...extra: string[]) => ["deploy", "plan", b.made.agentDir, "--subject", b.made.subject, "--target", b.target, ...extra];

describe("mind deploy plan", () => {
  test("prints the plan, exits 0, writes nothing and starts nothing", async () => {
    const b = await box();
    const before = await tree(b.root);

    const human = await run(b, planArgs(b));
    expect(human.code, human.stderr).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("deploy plan — subject alpha-keeper");
    expect(human.stdout).toContain("  to vps-1: ssh deploy@203.0.113.10:22, x64");
    expect(human.stdout).toContain("What goes");
    expect(human.stdout).toContain("/srv/mind/data/mind/alpha-keeper/personal  (encrypted volume)");
    expect(human.stdout).toContain(`plan ready — \`deploy apply\` (not built yet) would ask for "deploy alpha-keeper to vps-1"`);
    expect(human.stdout.trimEnd().split("\n").at(-1)).toContain("skips the daily update check (D-065)");

    const json = await run(b, planArgs(b, "--json"));
    expect(json.code, json.stderr).toBe(0);
    expect(json.stderr).toBe("");
    const doc = JSON.parse(json.stdout) as { schema: string; subject: string; steps: unknown[]; refusals: unknown[] };
    expect(doc.schema).toBe("mind/deploy-plan@1");
    expect(doc.subject).toBe("alpha-keeper");
    expect(doc.steps.length).toBeGreaterThan(20);
    expect(doc.refusals).toEqual([]);

    expect(await readdir(b.marks)).toEqual([".keep"]);
    expect(await tree(b.root)).toEqual(before);
  }, 60_000);

  test("the control: a trap that is run leaves its mark, and a write shows in the tree", async () => {
    const b = await box();
    const before = await tree(b.root);
    const child = Bun.spawn([join(b.traps, "ssh"), "host", "--", "true"], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    expect(child.exitCode).toBe(97);
    expect(await readdir(b.marks)).toContain("ssh");
    expect(await tree(b.root)).not.toEqual(before);
  });

  test("a repository with no commit: the plan is printed, leads with the refusal, and exits 1", async () => {
    const b = await box("no-commits");
    const result = await run(b, planArgs(b));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("apply would refuse — 1 reason(s):");
    expect(result.stdout).toContain("has no commit yet");
  }, 60_000);

  test("a target with a secret in it is refused without the secret, and nothing is planned", async () => {
    const b = await box();
    const token = `ghp_${"B".repeat(36)}`;
    await writeFile(b.target, JSON.stringify({ name: "vps-1", provider: "ssh", ssh: { host: "h", user: "u" }, token }));
    const result = await run(b, planArgs(b));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("rule github-token");
    expect(result.stderr).toContain("token: looks like a secret");
    expect(result.stderr).toContain("nothing was planned");
    expect(result.stderr).not.toContain(token);
  }, 60_000);

  test("the subject is checked against the soul, not taken from the directory", async () => {
    const b = await box();
    const result = await run(b, ["deploy", "plan", b.made.agentDir, "--subject", "beta-keeper", "--target", b.target]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("beta-keeper");
  }, 60_000);

  test("usage errors are exit 2 with nothing on stdout; a missing directory or target file is exit 1", async () => {
    const b = await box();
    for (const args of [
      ["deploy", "plan"],
      ["deploy", "plan", b.made.agentDir, "--subject", b.made.subject],
      ["deploy", "plan", b.made.agentDir, "--target", b.target],
      ["deploy", "plan", b.made.agentDir, "extra", "--subject", b.made.subject, "--target", b.target],
      ["deploy", "plan", b.made.agentDir, "--subject", "Not A Subject", "--target", b.target, "--json"],
    ]) {
      const result = await run(b, args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stdout, args.join(" ")).toBe("");
    }
    const noDir = await run(b, ["deploy", "plan", join(b.root, "nowhere"), "--subject", b.made.subject, "--target", b.target]);
    expect(noDir.code).toBe(1);
    expect(noDir.stderr).toContain("is not a directory");
    const noFile = await run(b, ["deploy", "plan", b.made.agentDir, "--subject", b.made.subject, "--target", join(b.root, "none.json")]);
    expect(noFile.code).toBe(1);
    expect(noFile.stderr).toContain("cannot read the target file");
  }, 60_000);
});

describe("the subcommands that are named and not built", () => {
  test("apply, status, update and destroy say which story owes them, and exit 2 having done nothing", async () => {
    const b = await box();
    const before = await tree(b.root);
    for (const [sub, story] of [["apply", "S13.2–S13.4"], ["status", "S13.5"], ["update", "S13.5"], ["destroy", "S13.5"]] as const) {
      const result = await run(b, ["deploy", sub, b.made.agentDir, "--subject", b.made.subject, "--target", b.target]);
      expect(result.code, sub).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`mind deploy ${sub}: not built yet (${story})`);
    }
    const unknown = await run(b, ["deploy", "frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain(`unknown deploy subcommand "frobnicate"`);
    const bare = await run(b, ["deploy"]);
    expect(bare.code).toBe(2);
    expect(await readdir(b.marks)).toEqual([".keep"]);
    expect(await tree(b.root)).toEqual(before);
  }, 60_000);
});
