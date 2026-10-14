/**
 * EXEC-01 (security review of 2026-10-13): the shipped `mind` binary must not load `bunfig.toml` or `.env` from the
 * directory it is started in.
 *
 * Bun's compiled executables read both from the working directory by default. `bunfig.toml` can name a `preload`
 * file that runs before the program, so a project directory that carries one would run code as the owner the moment
 * `mind` starts there. The engine starts itself again (the fence helper, the supervisor, child engines, the task
 * runner) in directories a fenced model can write, so the hole is not only a hostile checkout. The cure is two
 * flags on every `bun build --compile` that makes a shipped binary. These tests pin the flags where the shipped
 * binaries are made, and prove with a real compiled executable (a one-line program, not the engine) that the flags
 * do what is claimed and that, without them, the planted files DO run — so the test would notice if it stopped
 * meaning anything.
 *
 * Everything happens in temporary directories; nothing reads the owner's data.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const FLAGS = ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"];
const made: string[] = [];

afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

describe("the compile flags are on every shipped build", () => {
  test("package.json: build and build:macos (both targets) carry both flags", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    for (const name of ["build", "build:macos"]) {
      const cmds = String(pkg.scripts[name]).split("&&").map((c) => c.trim());
      expect(cmds.length).toBeGreaterThan(0);
      for (const cmd of cmds) {
        expect(cmd).toContain("--compile");
        for (const flag of FLAGS) expect(cmd).toContain(flag);
      }
    }
  });

  test("the release workflow builds with both flags", async () => {
    const wf = await readFile(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    const lines = wf.split("\n").filter((l) => l.includes("--compile"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) for (const flag of FLAGS) expect(line).toContain(flag);
  });

  test("the binary test compiles the same way the release does", async () => {
    for (const rel of ["test/cli/binary.test.ts"]) {
      const src = await readFile(join(ROOT, rel), "utf8");
      const at = src.indexOf('"--compile"');
      expect(at).toBeGreaterThan(-1);
      const window = src.slice(at, at + 200);
      for (const flag of FLAGS) expect(window).toContain(flag);
    }
  });
});

describe("a compiled executable ignores bunfig.toml and .env in its working directory", () => {
  async function plant(): Promise<{ dir: string; marker: string }> {
    const dir = await mkdtemp(join(tmpdir(), "mind-compile-flags-"));
    made.push(dir);
    const marker = join(dir, "preload-ran");
    await writeFile(join(dir, "program.ts"), 'console.log(JSON.stringify({ dotenv: process.env.MIND_PLANTED_DOTENV ?? null }));\n');
    return { dir, marker };
  }

  async function build(dir: string, withFlags: boolean): Promise<string> {
    const out = join(dir, withFlags ? "program-flagged" : "program-plain");
    const proc = Bun.spawn([process.execPath, "build", join(dir, "program.ts"), "--compile", ...(withFlags ? FLAGS : []), "--outfile", out], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`bun build failed (${code}): ${await new Response(proc.stderr).text()}`);
    return out;
  }

  async function runPlanted(binary: string, dir: string, marker: string): Promise<{ preloadRan: boolean; dotenv: string | null }> {
    // The files a hostile working directory would carry, written AFTER the build so they cannot be bundled in.
    await writeFile(join(dir, "evil-preload.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`);
    await writeFile(join(dir, "bunfig.toml"), 'preload = ["./evil-preload.ts"]\n');
    await writeFile(join(dir, ".env"), "MIND_PLANTED_DOTENV=from-dotenv\n");
    const proc = Bun.spawn([binary], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: dir } });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return { preloadRan: await exists(marker), dotenv: JSON.parse(out.trim()).dotenv };
  }

  test("with the flags, neither the preload runs nor the .env is read", async () => {
    const { dir, marker } = await plant();
    const binary = await build(dir, true);
    const r = await runPlanted(binary, dir, marker);
    expect(r.preloadRan).toBe(false);
    expect(r.dotenv).toBeNull();
  }, 60_000);

  test("without the flags both DO happen (the control: this is what the flags cure)", async () => {
    const { dir, marker } = await plant();
    const binary = await build(dir, false);
    const r = await runPlanted(binary, dir, marker);
    expect(r.preloadRan).toBe(true);
    expect(r.dotenv).toBe("from-dotenv");
  }, 60_000);
});
