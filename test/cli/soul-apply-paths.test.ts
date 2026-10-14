/**
 * S1.2 AC1 — `soul apply` renders into every path the backends really read:
 * `~/.claude/CLAUDE.md` (claude and grok), `$CODEX_HOME/AGENTS.md`,
 * `~/.gemini/GEMINI.md`, and `./AGENTS.md` (copilot and kimi).
 *
 * In a sandbox HOME, with a stub of each vendor on PATH, so "the path the
 * backend reads" is the registry's own declaration resolved on a real
 * filesystem — and each file already holds a human's text that must survive.
 * Whether each vendor *honours* its file is S1.3's question, not this one's.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { barePath, BUN } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");
const VENDORS = ["claude", "codex", "gemini", "grok", "copilot", "kimi"];

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("S1.2 AC1 — every declared instruction file, on a real filesystem", () => {
  test("six vendors, four files: each gets the block, each human line survives", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-apply-paths-"));
    scratch.push(home);
    const project = join(home, "project");
    const codexHome = join(home, "codex-home");
    const files = {
      claude: join(home, ".claude", "CLAUDE.md"),
      codex: join(codexHome, "AGENTS.md"),
      gemini: join(home, ".gemini", "GEMINI.md"),
      project: join(project, "AGENTS.md"),
    };
    for (const [name, path] of Object.entries(files)) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `# ${name} — written by a person\n\nkeep this line: ${name}\n`);
    }
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    for (const vendor of VENDORS) {
      await writeFile(join(bin, vendor), "#!/bin/sh\nexit 0\n");
      await chmod(join(bin, vendor), 0o755);
    }

    const child = Bun.spawn(
      [BUN, "run", BIN, "soul", "apply", SOUL, "--subject", "example", "--backend", VENDORS.join(","), "--apply"],
      {
        cwd: project,
        env: {
          HOME: home,
          CODEX_HOME: codexHome,
          PATH: `${bin}:${await barePath(home)}`,
          XDG_STATE_HOME: join(home, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(child.stdout).text();
    const err = await new Response(child.stderr).text();
    await child.exited;
    expect(child.exitCode, `${out}\n${err}`).toBe(0);

    for (const [name, path] of Object.entries(files)) {
      const text = await Bun.file(path).text();
      expect(text, `${name}: ${path}`).toContain("mind:soul:begin subject=example");
      expect(text, `${name}: the person's line`).toContain(`keep this line: ${name}`);
      // One block per file, even where two vendors share it (claude + grok,
      // copilot + kimi): a second block would be a second identity.
      expect(text.split("mind:soul:begin").length - 1, name).toBe(1);
    }
  }, 60_000);
});
