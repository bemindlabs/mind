/**
 * S13.1 — `deploy plan` on a synthetic agent: what goes, where, and what does not.
 *
 * The agent (`test/support/synthetic-agent.ts`) has data in most places the
 * data map names and nothing in a few, so each assertion here is about a real
 * byte count, and each empty place is a check that it gets no command.
 *
 * The last block is the claim the command makes about itself — it writes
 * nothing and starts nothing — run with both taken away.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { WEB_PORT } from "../../bin/commands/web.ts";
import { GCP_DATA_DEVICE, remote, VPS_CONTAINER } from "../../src/deploy/commands.ts";
import {
  DEPLOY_LIMITS,
  DEPLOY_PLAN_SCHEMA,
  measure,
  planDeploy,
  REMOTE_VOLUME,
  REMOTE_WEB_PORT,
  remoteEnv,
  remoteLayout,
  repoState,
  type DeployPlan,
} from "../../src/deploy/plan.ts";
import { describeTarget, humanBytes, renderPlan, shellLine } from "../../src/deploy/render.ts";
import { parseTarget } from "../../src/deploy/target.ts";
import { dataMap } from "../../src/erase/map.ts";
import { subjectId } from "../../src/types.ts";
import { FAKE_COMMIT, sshTarget, writeSyntheticAgent, type Commits, type SyntheticAgent } from "../support/synthetic-agent.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-deploy-plan-"));
  scratch.push(dir);
  return dir;
}

async function agent(commits: Commits = "committed"): Promise<SyntheticAgent> {
  return writeSyntheticAgent(await sandbox(), commits);
}

async function plan(made: SyntheticAgent, targetText = sshTarget({ home: "desk" })): Promise<DeployPlan> {
  const parsed = parseTarget(targetText);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return planDeploy({
    target: parsed.target,
    defaulted: parsed.defaulted,
    agentDir: made.agentDir,
    subject: subjectId(made.subject),
    engine: "9.9.9",
    local: { home: made.home, env: made.env },
    now: () => new Date("2026-09-27T00:00:00Z"),
  });
}

const GCP = JSON.stringify({ name: "gvm", provider: "gcp", arch: "arm64", gcp: { project: "my-project-1", zone: "asia-southeast1-b" } });
const AWS = JSON.stringify({ name: "avm", provider: "aws", aws: { region: "ap-southeast-1", diskGb: 30 } });

const keysOf = (entries: readonly { readonly key: string }[]) => entries.map((entry) => entry.key);

describe("what goes, what is made there, what stays", () => {
  test("every place of the data map is in exactly one list, and nothing else is", async () => {
    const made = await agent();
    const result = await plan(made);

    expect(keysOf(result.goes)).toEqual(["binary", "repo", "repo-history", "soul", "a2a", "chat", "bots", "push", "basis", "personal", "identity", "ledger"]);
    expect(keysOf(result.rebuilt)).toEqual(["derived", "rag-marker", "collection"]);
    expect(keysOf(result.stays)).toEqual(["backups", "confirmations", "runs", "browser", "triggers", "blocks"]);

    // Against the map itself, so a place added there shows up here or goes red.
    const map = dataMap({ home: made.home, env: made.env }, subjectId(made.subject), made.agentDir);
    const planned = [...result.goes, ...result.rebuilt, ...result.stays]
      .map((entry) => entry.key)
      .filter((key) => !["binary", "repo", "repo-history"].includes(key))
      .sort();
    expect(planned).toEqual([...map.trees.map((tree) => tree.key), "ledger", "collection", "blocks"].sort());
  });

  test("each place there is the same resolver, evaluated with the remote's roots", async () => {
    const made = await agent();
    const result = await plan(made);
    const layout = remoteLayout(subjectId(made.subject));
    const there = dataMap(remoteEnv(layout), subjectId(made.subject), layout.agentDir);
    const byKey = new Map<string, string>([...there.trees, there.ledger].map((tree) => [tree.key, tree.dir]));

    for (const entry of [...result.goes, ...result.rebuilt]) {
      if (!byKey.has(entry.key)) continue;
      expect(entry.there, entry.key).toBe(byKey.get(entry.key)!);
      expect(entry.there!.startsWith(`${REMOTE_VOLUME}/`), entry.key).toBe(true);
      expect(entry.encrypted, entry.key).toBe(true);
    }
    // What stays has no address there.
    for (const entry of result.stays) expect(entry.there, entry.key).toBeNull();
    // The binary is the one thing on the boot disk.
    const binary = result.goes.find((entry) => entry.key === "binary")!;
    expect(binary).toMatchObject({ there: "/usr/local/bin/mind", encrypted: false, size: null, here: null });
    expect(binary.label).toBe("mind-linux-x64 9.9.9");
    expect(result.remote).toEqual(layout);
    expect(result.remote.agentDir).toBe(`${REMOTE_VOLUME}/agents/alpha-keeper`);
  });

  test("sizes are read off the disk, and the totals are the clone plus the copies", async () => {
    const made = await agent();
    const result = await plan(made);
    const entry = (key: string) => [...result.goes, ...result.rebuilt, ...result.stays].find((e) => e.key === key)!;

    for (const key of ["ledger", "runs", "backups", "confirmations", "a2a", "rag-marker"]) {
      expect(entry(key).size, key).toEqual({ ...made.written[key]!, symlinks: 0 });
    }
    // The personal directory has two files and one link, and the link is counted apart.
    expect(entry("personal").size).toEqual({ ...made.written["personal"]!, symlinks: 1 });
    // Places with nothing in them say so rather than claiming zero files.
    for (const key of ["chat", "bots", "push", "basis", "triggers"]) expect(entry(key).size, key).toBeNull();
    // The repository's working tree leaves out .git/ and .mind/: the soul's two
    // files, one note and the .gitignore.
    expect(entry("repo").size?.files).toBe(4);
    expect(entry("repo-history").size?.files).toBe(2);
    expect(entry("derived").size?.files).toBe(1);

    const sum = ["repo", "repo-history", "a2a", "personal", "ledger"].map((key) => entry(key).size!);
    expect(result.totals).toEqual({
      files: sum.reduce((total, size) => total + size.files, 0),
      bytes: sum.reduce((total, size) => total + size.bytes, 0),
    });
  });

  test("the notes say what is missing and what S13.6 has to bring", async () => {
    const withHome = await plan(await agent());
    expect(withHome.notes.join("\n")).toContain("home is desk: S13.6 would reach the model there over the tailnet");
    expect(withHome.notes.join("\n")).toContain("(D-118, D-124)");
    expect(withHome.notes.join("\n")).toContain("1 symlink(s) in what goes would go as links");
    expect(withHome.notes.join("\n")).toContain("not in the target file, so defaulted: arch, ssh.port.");
    expect(withHome.notes.join("\n")).toContain("20 GB container file");
    expect(withHome.notGoing.join("\n")).toContain("over the tailnet (desk).");

    const noHome = await plan(await agent(), GCP);
    expect(noHome.notes.join("\n")).toContain("no `home` in the target file");
    expect(noHome.notes.join("\n")).not.toContain("container file");
    expect(noHome.notGoing.join("\n")).toContain("over the tailnet.");
  });
});

describe("what would stop apply", () => {
  test("a repository with no commit, or no repository, is refused; a clean one is not", async () => {
    expect((await plan(await agent())).refusals).toEqual([]);
    const empty = await plan(await agent("no-commits"));
    expect(empty.refusals).toHaveLength(1);
    expect(empty.refusals[0]).toContain("has no commit yet, so a clone would carry nothing");
    const none = await plan(await agent("no-git"));
    expect(none.refusals[0]).toContain("is not a git repository");
  });

  test("a personal directory inside a git repository is refused, the way erase refuses it", async () => {
    const made = await agent();
    await mkdir(join(made.env.XDG_DATA_HOME, ".git"), { recursive: true });
    const result = await plan(made);
    expect(result.refusals.join("\n")).toContain("the personal directory cannot be resolved");
  });

  test("a HEAD this cannot read is reported, not refused", async () => {
    const made = await agent();
    await writeFile(join(made.agentDir, ".git", "HEAD"), "something else\n");
    const result = await plan(made);
    expect(result.refusals).toEqual([]);
    expect(result.notes[0]).toContain("could not be read from .git/ without running git");
  });
});

describe("repoState and measure, on their own", () => {
  test("a commit is found through a ref file, packed-refs, or a detached HEAD", async () => {
    const root = await sandbox();
    const git = join(root, ".git");
    expect(await repoState(root)).toBe("not-a-repo");
    await mkdir(join(git, "refs", "heads"), { recursive: true });
    await writeFile(join(git, "HEAD"), "ref: refs/heads/main\n");
    expect(await repoState(root)).toBe("no-commits");
    await writeFile(join(git, "packed-refs"), `# pack-refs\n${FAKE_COMMIT} refs/heads/main\n`);
    expect(await repoState(root)).toBe("committed");
    await writeFile(join(git, "HEAD"), `${FAKE_COMMIT}\n`);
    expect(await repoState(root)).toBe("committed");

    const worktree = await sandbox();
    await writeFile(join(worktree, ".git"), "gitdir: /elsewhere\n");
    expect(await repoState(worktree)).toBe("unknown");

    // reftable: HEAD names a ref no file holds, and that is not "no commits".
    const reftable = await sandbox();
    await mkdir(join(reftable, ".git", "reftable"), { recursive: true });
    await writeFile(join(reftable, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
    expect(await repoState(reftable)).toBe("unknown");
  });

  test("measure: nothing there is null, a file is one file, skip leaves names out, links are apart", async () => {
    const root = await sandbox();
    expect(await measure(join(root, "absent"))).toBeNull();
    await writeFile(join(root, "a.txt"), "12345");
    expect(await measure(join(root, "a.txt"))).toEqual({ files: 1, bytes: 5, symlinks: 0 });
    await mkdir(join(root, "skip", "deep"), { recursive: true });
    await writeFile(join(root, "skip", "deep", "b.txt"), "123");
    await symlink(join(root, "a.txt"), join(root, "link"));
    expect(await measure(root)).toEqual({ files: 2, bytes: 8, symlinks: 1 });
    expect(await measure(root, ["skip"])).toEqual({ files: 1, bytes: 5, symlinks: 1 });
  });
});

describe("the services", () => {
  test("the page binds loopback on web's own port, and every unit waits for the volume", async () => {
    const result = await plan(await agent());
    expect(REMOTE_WEB_PORT).toBe(WEB_PORT);
    const [web, triggers] = result.services;
    expect(web!.exec).toEqual([
      "/usr/local/bin/mind", "web", `${REMOTE_VOLUME}/agents/alpha-keeper`, "--subject", "alpha-keeper",
      "--host", "127.0.0.1", "--port", "30701", "--https", "--key-file", `${REMOTE_VOLUME}/home/web.key`,
    ]);
    expect(web!.listens).toContain("127.0.0.1:30701 only");
    expect(triggers!.listens).toBeNull();
    expect(triggers!.exec).toContain(`${REMOTE_VOLUME}/agents/alpha-keeper/soul`);

    const units = result.services.flatMap((service) => service.units);
    expect(units.map((unit) => [unit.name, unit.enable])).toEqual([
      // The names this plan prints from stage 2 of the names sweep. `deploy apply` is not built, so no machine holds a
      // unit the engine wrote; `doctor` still reads the earlier unit names, and `erase --remote` still counts the
      // earlier volume (test/deploy/old-names.test.ts and test/erase/old-names.test.ts).
      ["mind-web-alpha-keeper.service", true],
      ["mind-triggers-alpha-keeper.service", false],
      ["mind-triggers-alpha-keeper.timer", true],
    ]);
    for (const unit of units.filter((u) => u.name.endsWith(".service"))) {
      expect(unit.text).toContain(`ConditionPathIsMountPoint=${REMOTE_VOLUME}`);
      expect(unit.text).toContain("User=mind");
      expect(unit.text).toContain(`Environment=XDG_DATA_HOME=${REMOTE_VOLUME}/data`);
    }
    expect(units[2]!.text).toContain("OnUnitActiveSec=5min");
  });
});

describe("D-100's four conditions, per provider", () => {
  test("all four, in order, each able to be met and naming the stories it waits on", async () => {
    const made = await agent();
    const story = { ssh: "S13.2", gcp: "S13.3", aws: "S13.4" } as const;
    for (const [provider, text] of [["ssh", sshTarget()], ["gcp", GCP], ["aws", AWS]] as const) {
      const result = await plan(made, text);
      expect(result.gates.map((gate) => gate.id)).toEqual(["encrypted-disk", "erase-reaches-remote", "no-public-port", "typed-phrase"]);
      expect(result.gates.every((gate) => gate.canBeMet)).toBe(true);
      expect(result.gates.map((gate) => gate.waitsOn)).toEqual([[story[provider], "S13.8"], [`${story[provider]}: a real ssh runner (spawn guard, owner decision)`, "the owner's dry run on a real machine"], [story[provider]], [story[provider]]]);
      expect(result.gates[0]!.how).toContain("LUKS2");
      expect(result.gates[3]!.how).toContain(`"deploy alpha-keeper to ${result.target.name}"`);
    }
    const [gcp, aws, ssh] = [await plan(made, GCP), await plan(made, AWS), await plan(made)];
    expect(gcp.gates[0]!.how).toContain("CSEK");
    expect(gcp.gates[0]!.how).toContain("CMEK alone would not meet the condition");
    expect(aws.gates[0]!.how).toContain("AWS KMS, which is AWS's place");
    expect(ssh.gates[1]!.how).toContain("Hostinger");
    expect(aws.gates[2]!.how).toContain("tcp/22 from your own address and nothing else");
    // D-100 #3: ssh is opened to one address, never the world, and taken back once the tailnet is up.
    const awsArgv = aws.steps.map((step) => step.argv.join(" "));
    expect(awsArgv.some((a) => a.includes("0.0.0.0/0"))).toBe(false);
    const open = awsArgv.findIndex((a) => a.includes("authorize-security-group-ingress") && a.includes("{your-public-ip}/32"));
    const join = awsArgv.findIndex((a) => a.includes("tailscale up"));
    const close = awsArgv.findIndex((a) => a.includes("revoke-security-group-ingress") && a.includes("{your-public-ip}/32"));
    expect(open).toBeGreaterThanOrEqual(0);
    expect(join).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(join);
    expect(ssh.phrase).toBe("deploy alpha-keeper to vps-1");
  });
});

describe("the commands — shown, never run", () => {
  const SHELL_PLAIN = /^[A-Za-z0-9_@%+=:,./{}-]+$/;

  test("ssh: the bootstrap starts by asking the CPU, and every remote word is plain", async () => {
    const made = await agent();
    const result = await plan(made);
    const base = ["ssh", "-p", "22", "-o", "BatchMode=yes", "deploy@203.0.113.10", "--"];
    expect(result.steps[0]!.argv).toEqual([...base, "uname", "-m"]);
    expect(result.steps[0]!.what).toContain("x86_64");
    for (const step of result.steps) {
      const at = step.argv.indexOf("--");
      if (step.argv[0] === "ssh") for (const word of step.argv.slice(at + 1)) expect(SHELL_PLAIN.test(word), word).toBe(true);
    }
    const argv = result.steps.map((step) => step.argv.join(" ")).join("\n");
    expect(argv).toContain(`sudo fallocate -l 20G ${VPS_CONTAINER}`);
    expect(argv).toContain("scp -P 22 -o BatchMode=yes {binary} deploy@203.0.113.10:/tmp/mind");
  });

  test("keys arrive on stdin and are named, never in an argv", async () => {
    const made = await agent();
    const result = await plan(made, GCP);
    const keyed = result.steps.filter((step) => step.stdin !== undefined && step.stdin.includes("key"));
    // Two gcloud calls with the disk key, luksFormat and open with the volume key.
    expect(keyed.length).toBe(4);
    for (const step of keyed) expect(step.argv).toContain("-");
    const everyArgv = result.steps.flatMap((step) => [...step.argv, ...(step.pipeFrom ?? [])]).join(" ");
    expect(everyArgv).not.toContain(result.keys.volume);
    expect(everyArgv).not.toContain(result.keys.disk);
    // Kept here, under this machine's state root, by target name.
    const keys = join(made.env.XDG_STATE_HOME, "mind", "deploy", "gvm");
    expect(result.keys).toEqual({ volume: join(keys, "volume.key"), disk: join(keys, "csek.json") });
  });

  test("personal bytes are piped straight onto the volume, and an empty place gets no command", async () => {
    const made = await agent();
    const result = await plan(made);
    const bundle = result.steps.find((step) => step.pipeFrom?.includes("bundle"))!;
    expect(bundle.pipeFrom).toEqual(["git", "-C", made.agentDir, "bundle", "create", "-", "--all"]);
    expect(bundle.argv.slice(-3)).toEqual(["dd", `of=${REMOTE_VOLUME}/agents/alpha-keeper.bundle`, "status=none"]);

    const tars = result.steps.filter((step) => step.pipeFrom?.[0] === "tar");
    const copied = ["a2a", "personal", "ledger"].map((key) => result.goes.find((entry) => entry.key === key)!);
    expect(tars.map((step) => step.pipeFrom![2] ?? null)).toEqual(copied.map((entry) => entry.here));
    expect(tars.map((step) => step.argv[step.argv.indexOf("-C") + 1] ?? null)).toEqual(copied.map((entry) => entry.there));
    // chat, bots, push and basis are empty here: no copy of them is planned.
    const all = result.steps.map((step) => step.argv.join(" ")).join("\n");
    for (const empty of ["chat", "bots", "push", "basis"]) expect(all).not.toContain(`/mind/${empty}/`);

    const enable = result.steps.find((step) => step.argv.includes("enable"))!;
    expect(enable.argv.slice(-3)).toEqual(["--now", "mind-web-alpha-keeper.service", "mind-triggers-alpha-keeper.timer"]);
    expect(result.steps.at(-1)!.argv.slice(-3)).toEqual(["sudo", "ss", "-ltnp"]);
  });

  test("gcp: a disk under your key, then the VM; arm64 takes the arm64 image", async () => {
    const result = await plan(await agent(), GCP);
    expect(result.steps[0]!.argv.slice(0, 5)).toEqual(["gcloud", "compute", "disks", "create", "gvm-data"]);
    expect(result.steps[1]!.argv).toContain("ubuntu-2404-lts-arm64");
    expect(result.steps[1]!.argv).toContain("t2a-standard-1");
    expect(result.steps[2]!.argv.slice(0, 9)).toEqual([
      "gcloud", "compute", "ssh", "gvm", "--project", "my-project-1", "--zone", "asia-southeast1-b", "--",
    ]);
    expect(result.steps[2]!.what).toContain("aarch64");
    const all = result.steps.map((step) => step.argv.join(" ")).join("\n");
    expect(all).toContain(GCP_DATA_DEVICE);
    // The device name is the one the disk is given in the same plan: one constant, two uses.
    expect(GCP_DATA_DEVICE).toBe("/dev/disk/by-id/google-mind-data");
    expect(all).toContain("device-name=mind-data,auto-delete=no");
    expect(all).toContain("gcloud compute scp {binary} gvm:/tmp/mind --project my-project-1 --zone asia-southeast1-b");
    expect(result.placeholders.map((p) => p.name)).toEqual(["{binary}"]);
  });

  test("aws: every word in braces is explained, and arm64 takes the arm64 image", async () => {
    const result = await plan(await agent(), AWS);
    const braces = new Set(result.steps.flatMap((step) => step.argv.join(" ").match(/\{[a-z-]+\}/g) ?? []));
    expect([...braces].sort()).toEqual(result.placeholders.map((p) => p.name).sort());
    expect(result.steps.find((step) => step.argv.includes("run-instances"))!.argv.join(" ")).toContain("/amd64/hvm/");
    expect(result.steps.map((step) => step.argv.join(" ")).join("\n")).toContain("lsblk -o NAME,SERIAL,SIZE");

    const arm = await plan(await agent(), JSON.stringify({ name: "avm", provider: "aws", arch: "arm64", aws: { region: "us-east-1" } }));
    const run = arm.steps.find((step) => step.argv.includes("run-instances"))!.argv;
    expect(run.join(" ")).toContain("/arm64/hvm/");
    expect(run).toContain("t4g.small");
  });

  test("an IPv6 host is bracketed for scp and not for ssh", async () => {
    const result = await plan(await agent(), JSON.stringify({ name: "v6", provider: "ssh", ssh: { host: "2001:db8::10", user: "root" } }));
    const argv = result.steps.map((step) => step.argv.join(" ")).join("\n");
    expect(argv).toContain("root@[2001:db8::10]:/tmp/mind");
    expect(result.steps[0]!.argv).toContain("root@2001:db8::10");
  });

  test("a word a remote shell would split is a bug, and throws", () => {
    expect(remote(["ssh", "h", "--"], ["ls", "/srv"])).toEqual(["ssh", "h", "--", "ls", "/srv"]);
    expect(() => remote(["ssh", "h", "--"], ["rm", "-rf", "/ ; echo"])).toThrow("not a plain word for a remote shell");
  });
});

describe("the erase-reaches-remote gate (S13.5)", () => {
  test("says it is implemented with a fake runner and that no real runner is wired — never 'met'", async () => {
    const made = await agent();
    for (const text of [sshTarget(), GCP, AWS]) {
      const result = await plan(made, text);
      const gate = result.gates.find((entry) => entry.id === "erase-reaches-remote")!;
      expect(gate.how).toContain("Implemented with a fake runner; real runner not wired (spawn guard, owner decision)");
      expect(gate.waitsOn.join(" ")).toContain("a real ssh runner");
      const printed = renderPlan(result).join("\n");
      expect(printed).toContain("real runner not wired");
      expect(printed).not.toContain("nothing left to build");
      expect(gate.how).not.toMatch(/\bis met\b|\bhas been met\b/);
    }
  });
});

describe("the plan for a person", () => {
  test("every section, in order, ending with the limits", async () => {
    const result = await plan(await agent());
    const lines = renderPlan(result);
    const text = lines.join("\n");
    const order = [
      "deploy plan — subject alpha-keeper",
      "What goes",
      "Made there, not copied",
      "Stays on this machine",
      "Does not go, and is not in the data map",
      "Services it would install",
      "What `apply` will require first",
      "Commands it would run, in order — shown, not run",
      "In braces, filled in at apply time:",
      "Notes",
      `plan ready — \`deploy apply\` (not built yet) would ask for "deploy alpha-keeper to vps-1"`,
      "What this plan does not check:",
    ];
    let at = -1;
    for (const heading of order) {
      const next = text.indexOf(heading, at + 1);
      expect(next, heading).toBeGreaterThan(at);
      at = next;
    }
    for (const limit of DEPLOY_LIMITS) expect(text).toContain(`  - ${limit}`);
    expect(lines.at(-1)).toBe(`  - ${DEPLOY_LIMITS.at(-1)}`);
    expect(text).toContain("  to vps-1: ssh deploy@203.0.113.10:22, x64");
    expect(text).toContain("(encrypted volume)");
    expect(text).toContain("(boot disk)");
    expect(text).toContain("the chat allowlist and who has been told — not there");
    expect(text).toContain("1 link(s)");
    expect(text).toContain("      $ git -C ");
    expect(text).toContain("        stdin: the volume key");
  });

  test("a refused plan leads with the refusal and ends not ready", async () => {
    const text = renderPlan(await plan(await agent("no-commits"))).join("\n");
    expect(text.indexOf("apply would refuse — 1 reason(s):")).toBeLessThan(text.indexOf("What goes"));
    expect(text).toContain("not ready — 1 thing(s) above would stop `deploy apply` before its first command");
    const gcp = renderPlan(await plan(await agent(), GCP)).join("\n");
    expect(gcp).toContain("csek.json");
  });

  test("the small formatters", async () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1023)).toBe("1023 B");
    expect(humanBytes(3482)).toBe("3.4 KB");
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(humanBytes(2 ** 50)).toBe("1024.0 TB");
    expect(shellLine(["echo", "a b", "it's", "{x}"])).toBe(`echo 'a b' 'it'\\''s' {x}`);
    const made = await agent();
    expect(describeTarget((await plan(made, GCP)).target)).toBe("gcp my-project-1/asia-southeast1-b, t2a-standard-1, 20 GB data disk, arm64");
    expect(describeTarget((await plan(made, AWS)).target)).toBe("aws ap-southeast-1, t3.small, 30 GB volume, x64");
  });

  test("the JSON document is the same plan, whole", async () => {
    const result = await plan(await agent());
    const round = JSON.parse(JSON.stringify(result)) as DeployPlan;
    expect(round.schema).toBe(DEPLOY_PLAN_SCHEMA);
    expect(round.at).toBe("2026-09-27T00:00:00.000Z");
    expect(round).toEqual(JSON.parse(JSON.stringify(result)));
    expect(round.steps.length).toBe(result.steps.length);
  });
});

/** Every file and directory under `root`, with size and mtime — the shape "changed nothing" needs. */
async function tree(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        found.push(`${relative(root, path)}/`);
        await walk(path);
      } else if (!entry.isSymbolicLink()) {
        const info = await stat(path);
        found.push(`${relative(root, path)} ${info.size} ${info.mtimeMs}`);
      } else {
        found.push(`${relative(root, path)} ->`);
      }
    }
  };
  await walk(root);
  return found.sort();
}

describe("it writes nothing and starts nothing", () => {
  test("three providers planned with spawn and fetch taken away, and the tree counted before and after", async () => {
    const made = await agent();
    const root = join(made.home, "..");
    const before = await tree(root);

    const calls: string[] = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: unknown) => {
      calls.push(`spawn ${JSON.stringify(argv)}`);
      throw new Error("deploy plan must not start a process");
    }) as never);
    const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(((argv: unknown) => {
      calls.push(`spawnSync ${JSON.stringify(argv)}`);
      throw new Error("deploy plan must not start a process");
    }) as never);
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => {
      calls.push(`fetch ${String(url)}`);
      throw new Error("deploy plan must not open a socket");
    }) as never);
    try {
      for (const text of [sshTarget({ home: "desk" }), GCP, AWS]) {
        const result = await plan(made, text);
        renderPlan(result);
        JSON.stringify(result);
      }
    } finally {
      spawn.mockRestore();
      spawnSync.mockRestore();
      fetcher.mockRestore();
    }

    expect(calls).toEqual([]);
    expect(await tree(root)).toEqual(before);
    // The control: the counting sees a write, so the equality above is evidence.
    await writeFile(join(made.home, "written-afterwards"), "x");
    expect(await tree(root)).not.toEqual(before);
    // And the spies really were in the way: with one in place, a spawn is caught.
    const control = spyOn(Bun, "spawn").mockImplementation((() => {
      throw new Error("caught");
    }) as never);
    try {
      expect(() => Bun.spawn(["true"])).toThrow("caught");
    } finally {
      control.mockRestore();
    }
  });
});
