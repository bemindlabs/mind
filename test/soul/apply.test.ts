/**
 * `soul apply`, against a home built for the occasion.
 *
 * The assertion that carries S1.2 AC4 appears in almost every test below, and
 * it is deliberately the strictest form available: after a write, take
 * Mind's block back out and compare the result with the original file
 * *byte for byte*. Not line counts, not "contains", not a normalised
 * comparison — `toBe` on the whole string. A tool that reflows somebody's
 * file while adding its block has swallowed their writing just as surely as
 * one that truncates it, and only the byte comparison notices.
 *
 * Nothing here touches the real `$HOME`. Every test makes a temporary one and
 * hands it to `apply` as an argument.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subjectId, type SubjectId } from "../../src/types.ts";
import { END_MARKER, strip } from "../../src/soul/block.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { resolveTargets } from "../../src/soul/targets.ts";
import {
  backupRoot,
  commitApply,
  egressNote,
  planApply,
  shellQuote,
  writesFile,
  type ApplyEnv,
  type TargetPlan,
} from "../../src/soul/apply.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const HUMAN = join(FIXTURES, "instructions", "human-200.md");
const EXAMPLE = subjectId("example");
const OTHER = subjectId("other-example");

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A temporary home with the two instruction directories a vendor would read. */
async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "mind-apply-"));
  homes.push(home);
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  return home;
}

/**
 * A clock that never repeats itself, shared by every `env` in this file.
 *
 * Two runs inside one test must land in two backup directories — that is the
 * property that keeps a second apply from writing over the originals the first
 * one saved — so the counter is per-file, not per-env.
 */
let tick = 0;

function env(home: string, options: { readonly explicit?: readonly string[] } = {}): ApplyEnv {
  return {
    home,
    env: { XDG_STATE_HOME: join(home, "state") },
    now: () => new Date(Date.UTC(2026, 8, 20, 12, 0, 0, tick++)),
    explicit: new Set(options.explicit ?? []),
  };
}

function targetContext(home: string, installed: readonly string[] = ["claude", "codex"]) {
  return {
    home,
    cwd: join(home, "project"),
    env: {},
    which: (binary: string) => Promise.resolve(installed.includes(binary)),
  };
}

async function soulOf(dir: string, subject: SubjectId) {
  const loaded = await loadSoul(join(FIXTURES, dir), subject);
  if (!loaded.ok) throw new Error(loaded.issues.map((i) => i.message).join("; "));
  return loaded.soul;
}

async function planFor(
  home: string,
  options: {
    readonly dir?: string;
    readonly subject?: SubjectId;
    readonly backends?: readonly string[];
    readonly installed?: readonly string[];
    readonly explicit?: readonly string[];
  } = {},
) {
  const subject = options.subject ?? EXAMPLE;
  const soul = await soulOf(options.dir ?? "soul-valid", subject);
  const targets = await resolveTargets(
    options.backends ?? ["claude", "codex", "ollama"],
    targetContext(home, options.installed),
  );
  const applyEnv = env(home, options.explicit === undefined ? {} : { explicit: options.explicit });
  return { plan: await planApply(soul, targets, applyEnv), env: applyEnv };
}

function byBackend(plans: readonly TargetPlan[], id: string): TargetPlan {
  const found = plans.find((p) => p.target.backend === id);
  if (found === undefined) throw new Error(`no plan for ${id}`);
  return found;
}

const claudeMd = (home: string) => join(home, ".claude", "CLAUDE.md");
const codexMd = (home: string) => join(home, ".codex", "AGENTS.md");

/** `Bun.file().exists()` answers false for a directory, so ask the filesystem. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("planApply — AC2: a dry run is a read", () => {
  test("planning a write changes nothing on disk", async () => {
    const home = await makeHome();
    const original = await readFile(HUMAN, "utf8");
    await writeFile(claudeMd(home), original);

    const { plan } = await planFor(home);

    expect(await readFile(claudeMd(home), "utf8")).toBe(original);
    expect(await exists(codexMd(home))).toBe(false);
    expect(await exists(join(home, "state"))).toBe(false);

    expect(byBackend(plan.plans, "claude").action).toBe("insert");
    expect(byBackend(plan.plans, "codex").action).toBe("create");
  });

  test("the diff is of the file on disk against the file that would be written", async () => {
    const home = await makeHome();
    await writeFile(claudeMd(home), await readFile(HUMAN, "utf8"));

    const { plan } = await planFor(home);
    const item = byBackend(plan.plans, "claude");

    expect(item.diff).toContain("mind:soul:begin");
    expect(item.stat.removed).toBe(0);
    expect(item.stat.added).toBeGreaterThan(10);

    // Every `+` line in the diff really is in the text that would be written.
    for (const line of item.diff.split("\n")) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      expect(item.next!).toContain(line.slice(1));
    }
  });
});

describe("commitApply — AC4: a human's own writing survives", () => {
  test("a 200-line hand-written file comes back byte-identical after stripping the block", async () => {
    const home = await makeHome();
    const original = await readFile(HUMAN, "utf8");
    expect(original.split("\n").length).toBeGreaterThan(200);
    await writeFile(claudeMd(home), original);

    const { plan, env: applyEnv } = await planFor(home);
    const result = await commitApply(plan, applyEnv);
    expect(result.ok).toBe(true);

    const after = await readFile(claudeMd(home), "utf8");
    expect(after).not.toBe(original);
    expect(after.startsWith(original)).toBe(true);

    const stripped = strip(after);
    expect(stripped.kind).toBe("stripped");
    if (stripped.kind !== "stripped") return;
    expect(stripped.text).toBe(original);
  });

  test("the fenced marker example and the other tool's block are still there", async () => {
    const home = await makeHome();
    await writeFile(claudeMd(home), await readFile(HUMAN, "utf8"));

    const { plan, env: applyEnv } = await planFor(home);
    await commitApply(plan, applyEnv);

    const after = await readFile(claudeMd(home), "utf8");
    expect(after).toContain("<assistant-memory-context>");
    expect(after).toContain("</assistant-memory-context>");
    expect(after).toContain("@./conventions.md");
    expect(after).toContain("ตรวจสถานะจริงก่อนลงมือ");
    expect(after).toContain("    <!-- mind:soul:begin subject=someone");
  });

  test("the original is backed up byte-for-byte, with a manifest and a restore command", async () => {
    const home = await makeHome();
    const original = await readFile(HUMAN, "utf8");
    await writeFile(claudeMd(home), original);

    const { plan, env: applyEnv } = await planFor(home);
    const result = await commitApply(plan, applyEnv);
    expect(result.ok).toBe(true);
    expect(result.backupDir).toBe(plan.backupDir);

    const claude = result.written.find((w) => w.backend === "claude")!;
    expect(claude.backupPath).toBeDefined();
    expect(await readFile(claude.backupPath!, "utf8")).toBe(original);
    expect(claude.restore.startsWith("cp ")).toBe(true);

    const manifest = JSON.parse(await readFile(join(plan.backupDir, "manifest.json"), "utf8"));
    expect(manifest.subject).toBe("example");
    expect(manifest.files.map((f: { backend: string }) => f.backend).sort()).toEqual(["claude", "codex"]);

    // Restoring by hand really does give the file back.
    await writeFile(claudeMd(home), await readFile(claude.backupPath!, "utf8"));
    expect(await readFile(claudeMd(home), "utf8")).toBe(original);
  });

  test("a file created from nothing says so, and restoring it means removing it", async () => {
    const home = await makeHome();
    const { plan, env: applyEnv } = await planFor(home, { backends: ["codex"] });
    const result = await commitApply(plan, applyEnv);

    const codex = result.written.find((w) => w.backend === "codex")!;
    expect(codex.action).toBe("create");
    expect(codex.backupPath).toBeUndefined();
    expect(codex.restore.startsWith("rm ")).toBe(true);

    expect((await stat(codexMd(home))).mode & 0o777).toBe(0o600);
    expect(strip(await readFile(codexMd(home), "utf8"))).toMatchObject({ kind: "stripped", text: "" });
  });

  test("existing permission bits are preserved, not reset", async () => {
    const home = await makeHome();
    await writeFile(claudeMd(home), "# Notes\n");
    await chmod(claudeMd(home), 0o640);

    const { plan, env: applyEnv } = await planFor(home, { backends: ["claude"] });
    await commitApply(plan, applyEnv);

    expect((await stat(claudeMd(home))).mode & 0o777).toBe(0o640);
  });
});

describe("commitApply — AC5: switching identity leaves no residue", () => {
  test("applying a second soul replaces the first block and keeps the file intact", async () => {
    const home = await makeHome();
    const original = await readFile(HUMAN, "utf8");
    await writeFile(claudeMd(home), original);

    const first = await planFor(home, { backends: ["claude"] });
    await commitApply(first.plan, first.env);
    const afterFirst = await readFile(claudeMd(home), "utf8");
    expect(afterFirst).toContain("Example Keeper");

    const second = await planFor(home, {
      dir: "soul-valid-b",
      subject: OTHER,
      backends: ["claude"],
    });
    const item = byBackend(second.plan.plans, "claude");
    expect(item.action).toBe("replace");
    expect(item.replacedSubject).toBe(EXAMPLE);

    const result = await commitApply(second.plan, second.env);
    expect(result.ok).toBe(true);

    const afterSecond = await readFile(claudeMd(home), "utf8");
    expect(afterSecond).not.toContain("Example Keeper");
    expect(afterSecond).not.toContain("tends the example fixture");
    expect(afterSecond).toContain("Second Keeper");

    // And the human's file is still exactly the human's file.
    expect(strip(afterSecond)).toMatchObject({ kind: "stripped", text: original });
  });

  test("applying the same soul twice is a no-op the second time", async () => {
    const home = await makeHome();
    await writeFile(claudeMd(home), await readFile(HUMAN, "utf8"));

    const first = await planFor(home, { backends: ["claude"] });
    await commitApply(first.plan, first.env);
    const once = await readFile(claudeMd(home), "utf8");

    const second = await planFor(home, { backends: ["claude"] });
    expect(byBackend(second.plan.plans, "claude").action).toBe("unchanged");

    const result = await commitApply(second.plan, second.env);
    expect(result.written).toEqual([]);
    expect(await readFile(claudeMd(home), "utf8")).toBe(once);
    // No backup directory for a run that wrote nothing.
    expect(await exists(second.plan.backupDir)).toBe(false);
  });
});

describe("refusals", () => {
  test("a file that changed between the plan and the write stops the whole batch", async () => {
    const home = await makeHome();
    await writeFile(claudeMd(home), "# Notes\n");

    const { plan, env: applyEnv } = await planFor(home, { backends: ["claude", "codex"] });
    await writeFile(claudeMd(home), "# Notes, edited by someone else\n");

    const result = await commitApply(plan, applyEnv);
    expect(result.ok).toBe(false);
    expect(result.refused[0]!.reason).toContain("changed on disk");

    // Nothing at all was written — not even the target that did not move.
    expect(await readFile(claudeMd(home), "utf8")).toBe("# Notes, edited by someone else\n");
    expect(await exists(codexMd(home))).toBe(false);
  });

  test("text a human typed inside the block is refused, not overwritten", async () => {
    const home = await makeHome();
    await writeFile(claudeMd(home), "# Notes\n");

    const first = await planFor(home, { backends: ["claude"] });
    await commitApply(first.plan, first.env);

    const written = await readFile(claudeMd(home), "utf8");
    await writeFile(claudeMd(home), written.replace("## Principles", "## Principles (edited by hand)"));

    const second = await planFor(home, { backends: ["claude"] });
    const item = byBackend(second.plan.plans, "claude");
    expect(item.action).toBe("refused");
    expect(item.reason).toContain("edited by hand");
    expect(writesFile(item)).toBe(false);
  });

  test("a file that is not valid UTF-8 is refused rather than rewritten", async () => {
    const home = await makeHome();
    await writeFile(claudeMd(home), new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a]));

    const { plan } = await planFor(home, { backends: ["claude"] });
    const item = byBackend(plan.plans, "claude");
    expect(item.action).toBe("refused");
    expect(item.reason).toContain("UTF-8");
  });

  test("a directory where a file should be is refused, not crashed on", async () => {
    const home = await makeHome();
    await mkdir(claudeMd(home));

    const { plan } = await planFor(home, { backends: ["claude"] });
    expect(byBackend(plan.plans, "claude").action).toBe("refused");
  });

  test("a soul whose prose holds a Mind marker stops the run before any target", async () => {
    const home = await makeHome();
    const soul = await soulOf("soul-valid", EXAMPLE);
    const poisoned = {
      ...soul,
      role: { ...soul.role, body: `${soul.role.body}\n${END_MARKER}\n` },
    };
    const targets = await resolveTargets(["claude"], targetContext(home));

    const plan = await planApply(poisoned, targets, env(home));
    expect(plan.issues.length).toBe(1);
    expect(plan.plans).toEqual([]);
  });
});

describe("I-1 — the local path survives an empty PATH", () => {
  test("no vendor CLI installed: files are skipped, ollama is still a target", async () => {
    const home = await makeHome();
    const { plan } = await planFor(home, { installed: [] });

    expect(byBackend(plan.plans, "claude").action).toBe("skipped");
    expect(byBackend(plan.plans, "codex").action).toBe("skipped");
    expect(byBackend(plan.plans, "ollama").action).toBe("system-field");
    expect(plan.plans.some((p) => p.action === "refused")).toBe(false);
    expect(plan.plans.filter(writesFile)).toEqual([]);
  });

  test("naming a backend explicitly writes its file even with the CLI absent", async () => {
    const home = await makeHome();
    const { plan, env: applyEnv } = await planFor(home, {
      backends: ["codex"],
      installed: [],
      explicit: ["codex"],
    });

    expect(byBackend(plan.plans, "codex").action).toBe("create");
    const result = await commitApply(plan, applyEnv);
    expect(result.ok).toBe(true);
    expect(await exists(codexMd(home))).toBe(true);
  });

  test("ollama needs no file and says why", async () => {
    const home = await makeHome();
    const { plan } = await planFor(home, { backends: ["ollama"], installed: [] });
    const item = byBackend(plan.plans, "ollama");

    expect(item.next).toBeUndefined();
    expect(item.reason).toContain("system field");
    expect(item.target.strength).toBe("system");
  });
});

describe("reporting", () => {
  test("the backup directory is under XDG_STATE_HOME, keyed by subject", () => {
    const withXdg = backupRoot(env("/nowhere"), EXAMPLE);
    expect(withXdg.startsWith("/nowhere/state/mind/backups/example/")).toBe(true);

    const withoutXdg = backupRoot(
      { home: "/nowhere", env: {}, now: () => new Date(0), explicit: new Set() },
      EXAMPLE,
    );
    expect(withoutXdg).toBe("/nowhere/.local/state/mind/backups/example/19700101T000000000Z");
  });

  test("the egress note names the cloud CLIs that will receive this text", async () => {
    const home = await makeHome();
    const { plan } = await planFor(home);
    const note = egressNote(plan.plans)!;

    expect(note).toContain("claude");
    expect(note).toContain("codex");
    expect(note).not.toContain("ollama");
  });

  test("no note when nothing would be written", async () => {
    const home = await makeHome();
    const { plan } = await planFor(home, { backends: ["ollama"] });
    expect(egressNote(plan.plans)).toBeUndefined();
  });

  test("restore commands survive a path with a space in it", () => {
    expect(shellQuote("/tmp/plain/path.md")).toBe("/tmp/plain/path.md");
    expect(shellQuote("/tmp/a folder/CLAUDE.md")).toBe("'/tmp/a folder/CLAUDE.md'");
  });
});
