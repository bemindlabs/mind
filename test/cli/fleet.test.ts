import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDial, writeDial } from "../../bin/dial.ts";
import { DEFAULT_DIAL } from "../../src/decide/autonomy.ts";
import { confirmationsPath, setConfirmation } from "../../src/decide/confirm.ts";
import { subjectId } from "../../src/types.ts";

const ROOT = join(import.meta.dir, "..", "..");

async function mind(...args: string[]) {
  const child = Bun.spawn([process.execPath, "run", join(ROOT, "bin/mind.ts"), ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, stdout, stderr };
}

async function roster(text: string): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "fleet-")), "fleet.toml");
  await writeFile(file, text);
  return file;
}

describe("mind fleet check", () => {
  test("a good roster loads, is listed, and says nothing was started", async () => {
    const file = await roster('[[bot]]\nid = "ada"\nsubject = "fleet-ada"\nbackend = "claude"\nfallback = ["codex"]\n');
    const result = await mind("fleet", "check", file);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("1 bot(s), flat, cloud only");
    expect(result.stdout).toContain("ada  as fleet-ada  claude (then codex)  scope machine");
    expect(result.stdout).toContain("Nothing was started");
  });

  test("a roster with a local backend or a lead is refused with exit 2, every problem listed", async () => {
    const file = await roster('[[bot]]\nid = "ada"\nsubject = "fleet-ada"\nbackend = "ollama"\nlead = "bo"\n');
    const result = await mind("fleet", "check", file);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("2 problems");
    expect(result.stderr).toContain("the fleet is flat");
    expect(result.stderr).toContain("backend must be one of");
    expect(result.stdout).toBe("");
  });

  test("a missing file and a missing argument are usage errors", async () => {
    expect((await mind("fleet", "check", "/nonexistent/fleet.toml")).code).toBe(2);
    expect((await mind("fleet", "check")).code).toBe(2);
    expect((await mind("fleet")).code).toBe(2);
  });
});

describe("mind fleet dial", () => {
  test("applies profiles to real agent directories, previews and selects", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-dial-"));
    const a = join(root, "a"), b = join(root, "b");
    await mkdir(a); await mkdir(b);
    await writeDial(a, { ...DEFAULT_DIAL, operate: 3 });
    const file = await roster(`[[bot]]\nid = "ada"\nsubject = "fleet-ada"\nbackend = "claude"\nscope = "worktree"\ndir = ${JSON.stringify(a)}\n[[bot]]\nid = "bob"\nsubject = "fleet-bob"\nbackend = "codex"\nscope = "worktree"\ndir = ${JSON.stringify(b)}\n`);
    const before = await readFile(join(a, "autonomy.md"), "utf8");
    const preview = await mind("fleet", "dial", file, "--profile", "worktree", "--dry-run");
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("ada: read=1 write=1 run=1 reach=1 operate=3 -> read=3 write=3 run=3 reach=2 operate=0");
    expect(await readFile(join(a, "autonomy.md"), "utf8")).toBe(before);
    expect(await Bun.file(join(b, "autonomy.md")).exists()).toBe(false);
    expect((await mind("fleet", "dial", file, "--profile", "worktree")).code).toBe(0);
    expect((await readDial(b)).stored).toMatchObject({ read: 3, write: 3, run: 3, reach: 2, operate: 0 });
    expect((await mind("fleet", "dial", file, "--profile", "read-only", "--only", "ada")).code).toBe(0);
    expect((await readDial(a)).stored).toMatchObject({ read: 1, write: 1, run: 1, reach: 1, operate: 0 });
    expect((await readDial(b)).stored.write).toBe(3);
  });

  test("refuses invalid input and preflights every bot before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-dial-"));
    const a = join(root, "a"), b = join(root, "b");
    await mkdir(a); await mkdir(b);
    await writeFile(join(b, "autonomy.md"), "broken");
    const file = await roster(`[[bot]]\nid = "ada"\nsubject = "fleet-ada"\nbackend = "claude"\nscope = "worktree"\ndir = ${JSON.stringify(a)}\n[[bot]]\nid = "bob"\nsubject = "fleet-bob"\nbackend = "codex"\nscope = "worktree"\ndir = ${JSON.stringify(b)}\n`);
    expect((await mind("fleet", "dial", file, "--profile", "unknown")).code).toBe(2);
    expect((await mind("fleet", "dial", file, "--profile", "worktree", "--only", "missing")).code).toBe(2);
    expect((await mind("fleet", "dial", file, "--profile", "worktree")).code).toBe(2);
    expect(await Bun.file(join(a, "autonomy.md")).exists()).toBe(false);
    expect((await mind("fleet", "dial", "/nonexistent/fleet.toml", "--profile", "read-only")).code).toBe(2);
    const invalid = await roster("not toml = [");
    expect((await mind("fleet", "dial", invalid, "--profile", "read-only")).code).toBe(2);
  });

  test("does not invalidate or reuse a level-3 confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-confirm-"));
    const dir = join(root, "agent");
    await mkdir(dir);
    const file = await roster(`[[bot]]\nid = "ada"\nsubject = "fleet-ada"\nbackend = "claude"\nscope = "worktree"\ndir = ${JSON.stringify(dir)}\n`);
    const env = { ...process.env, XDG_STATE_HOME: root };
    const path = confirmationsPath({ home: root, env }, dir, subjectId("fleet-ada"));
    await setConfirmation(path, "write", { by: "test", at: "2026-01-01T00:00:00Z" });
    const original = await readFile(path, "utf8");
    const run = async (profile: string) => {
      const child = Bun.spawn([process.execPath, "run", join(ROOT, "bin/mind.ts"), "fleet", "dial", file, "--profile", profile], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
      await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return child.exited;
    };
    expect(await run("worktree")).toBe(2);
    await writeDial(dir, { ...DEFAULT_DIAL, write: 3 });
    expect(await run("read-only")).toBe(2);
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await readDial(dir)).stored.write).toBe(3);
  });
});
