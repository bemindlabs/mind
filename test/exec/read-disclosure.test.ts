/**
 * What a user is told about reads (EXEC-02, EEA-01, EXEC-04): the same few facts in every place that describes the
 * fence, and none of them stronger than the kernel and the vendors make them.
 *
 * The places: `readonlyLimits()` (printed by `mind backends` and `mind autonomy`), `LOCAL_LIMITS` (printed by
 * `observe status`), `DOCTOR_LIMITS` and the doctor section (`test/doctor-exposure.test.ts`), and
 * `docs/fence.md`. The text that names vendors is derived from the registry, so these tests change the registry
 * and watch the sentence follow.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SYSTEM_READ_DIRS } from "../../src/exec/fence.ts";
import { LOCAL_LIMITS } from "../../src/exec/local.ts";
import { readonlyLimits, vendor, VENDORS, type ReadOnlySpec, type VendorSpec } from "../../src/exec/registry.ts";
import { BUN } from "../support/bare-path.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const scratch: string[] = [];

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

function fake(id: string, readOnly: ReadOnlySpec): VendorSpec {
  return { ...vendor("kimi"), id, readOnly };
}

const TOOLLESS: ReadOnlySpec = { kind: "allow-tools", flag: "--tools", values: [""], evidence: "probed" };
const SOME_TOOLS: ReadOnlySpec = { kind: "allow-tools", flag: "--tools", values: ["read_file"], evidence: "probed" };

describe("readonlyLimits(): read-only is not cannot-read", () => {
  const SENTENCE = "A read-only turn is not a turn that cannot read.";

  test("the real registry names every vendor that keeps a tool, and claude as the one that has none", () => {
    const printed = readonlyLimits().join("\n");
    expect(printed).toContain(SENTENCE);
    const line = readonlyLimits().find((entry) => entry.startsWith(SENTENCE))!;
    for (const id of ["codex", "grok", "gemini", "copilot", "kimi"]) expect(line, id).toContain(id);
    expect(line).toContain("claude is started with no tools at all");
    // The sentence that names who can read does not name the one that cannot among them.
    expect(line.split("keep file-reading tools")[0]).not.toContain("claude");
    expect(line).toContain("The I-6 screen sees only the prompt and system text Mind sends");
    expect(printed).not.toMatch(/cannot write|impossible|guaranteed/i);
  });

  test("it is derived: a vendor given no tools leaves the list, one given a tool joins it", () => {
    const before = readonlyLimits([fake("alpha", TOOLLESS), fake("beta", SOME_TOOLS)]).join("\n");
    expect(before).toContain("beta keep file-reading tools");
    expect(before).toContain("alpha is started with no tools at all");

    const after = readonlyLimits([fake("alpha", SOME_TOOLS), fake("beta", TOOLLESS)]).join("\n");
    expect(after).toContain("alpha keep file-reading tools");
    expect(after).toContain("beta is started with no tools at all");
  });

  test("with nothing that can read, the sentence is not printed; with nothing toolless, it does not claim one", () => {
    expect(readonlyLimits([fake("alpha", TOOLLESS)]).join("\n")).not.toContain(SENTENCE);
    const none = readonlyLimits([fake("alpha", SOME_TOOLS)]).join("\n");
    expect(none).toContain(SENTENCE);
    expect(none).not.toContain("no tools at all");
  });

  test("a vendor with no read-only mechanism at all can read too", () => {
    const hole: ReadOnlySpec = { kind: "none", why: "synthetic", evidence: "writes" };
    expect(readonlyLimits([fake("open", hole)]).join("\n")).toContain("open keep file-reading tools");
  });

  test("the registry has exactly one toolless vendor today, and it is the one the sentence says", () => {
    const toolless = VENDORS.filter((spec) => spec.readOnly.kind === "allow-tools" && spec.readOnly.values.every((v) => v === ""));
    expect(toolless.map((spec) => spec.id)).toEqual(["claude"]);
  });

  test("`mind backends` prints it", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-disclosure-"));
    scratch.push(home);
    const child = Bun.spawn([BUN, "run", join(ROOT, "bin", "mind.ts"), "backends"], {
      cwd: home,
      env: { HOME: home, PATH: process.env["PATH"] ?? "", XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
    expect(await child.exited, err).toBe(0);
    expect(out).toContain(SENTENCE);
  }, 30_000);
});

describe("LOCAL_LIMITS: what the local fence reads, said as it is", () => {
  const limit = LOCAL_LIMITS.find((entry) => entry.startsWith("a process running as this user"))!;

  test("a fenced local turn is told apart from a cloud one, and neither is made out to be more than it is", () => {
    expect(LOCAL_LIMITS).toHaveLength(5);
    expect(limit).toContain("same uid");
    expect(limit).toContain("can open any file you can and send it to that vendor");
    expect(limit).toContain("the I-6 screen sees only the prompt Mind sends");
    expect(limit).toContain("fenced for reads as well as writes");
    // The residue, so a reader of the first half does not take it for the whole.
    for (const left of ["everything in its working directory", "the command line of every process", "/proc, /sys and /etc"]) {
      expect(limit, left).toContain(left);
    }
    expect(limit).toContain("Programs installed under your home (nvm, bun, cargo, pyenv) are not readable to it either");
  });

  test("it does not say a local turn can read everything its user can: that stopped being true", () => {
    expect(limit).not.toMatch(/can read everything your user can/i);
  });
});

describe("docs/fence.md", () => {
  test("names every directory the fence grants, the measured versions and the command that re-measures", async () => {
    const text = await readFile(join(ROOT, "docs", "fence.md"), "utf8");
    for (const directory of SYSTEM_READ_DIRS) expect(text, directory).toContain(`\`${directory}\``);
    expect(text).toContain("MIND_REAL_FENCE=1 bun test test/exec/fence-reads.real.test.ts");
    expect(text).toContain("`claude` 2.1.296");
    expect(text).toContain("`grok` 1.0.50");
    expect(text).toContain("read-only is not cannot-read");
  });

  test("the pages that describe the doctor and the read-only table point to it", async () => {
    for (const page of ["quickstart.md", "cli-matrix.md"]) {
      expect(await readFile(join(ROOT, "docs", page), "utf8"), page).toContain("(fence.md)");
    }
  });
});
