/**
 * Where an identity would land, resolved against a home that is not real.
 *
 * Every test here injects `home`, `env`, `cwd` and `which`. That is the whole
 * reason those are parameters: the default resolution points at the operator's
 * live instruction files, and a test that used it would be a test that plans
 * a write into a file being read by the session running it.
 *
 * The case worth naming is `PATH` being empty. I-1 says the local path must
 * keep working when the commercial CLIs are gone, so "no vendor CLI installed"
 * has to be an ordinary outcome that still leaves `ollama` a first-class
 * target — not an error, and not an empty list.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { expandPath, isProjectScopedOnly, vendor } from "../../src/exec/registry.ts";
import { isKnownBackend, resolveTargets, type FileTarget } from "../../src/soul/targets.ts";

const HOME = "/nowhere/home";

function context(options: { readonly env?: Record<string, string>; readonly installed?: readonly string[] } = {}) {
  const installed = new Set(options.installed ?? ["claude", "codex"]);
  return {
    home: HOME,
    cwd: "/nowhere/project",
    env: options.env ?? {},
    which: (binary: string) => Promise.resolve(installed.has(binary)),
  };
}

function fileTargets(targets: readonly { kind: string }[]): readonly FileTarget[] {
  return targets.filter((t): t is FileTarget => t.kind === "file");
}

describe("expandPath", () => {
  test("resolves ~ against the home it is given, not the real one", () => {
    expect(expandPath("~/.claude/CLAUDE.md", { home: HOME })).toBe(join(HOME, ".claude/CLAUDE.md"));
    expect(expandPath("~", { home: HOME })).toBe(HOME);
  });

  test("resolves ./ against the cwd it is given", () => {
    expect(expandPath("./AGENTS.md", { cwd: "/nowhere/project" })).toBe("/nowhere/project/AGENTS.md");
  });

  test("leaves an absolute path alone", () => {
    expect(expandPath("/etc/example.md", { home: HOME })).toBe("/etc/example.md");
  });

  test("honours ${VAR:-default}, which is how CODEX_HOME moves the file", () => {
    const spec = vendor("codex").identity.instructionFiles[0]!;
    expect(spec).toContain("CODEX_HOME");

    expect(expandPath(spec, { home: HOME, env: {} })).toBe(join(HOME, ".codex/AGENTS.md"));
    expect(expandPath(spec, { home: HOME, env: { CODEX_HOME: "/opt/codex" } })).toBe("/opt/codex/AGENTS.md");
    // An empty variable means unset, the way a shell would read it.
    expect(expandPath(spec, { home: HOME, env: { CODEX_HOME: "" } })).toBe(join(HOME, ".codex/AGENTS.md"));
  });

  test("a vendor whose file lives under an env var is not 'per project only'", () => {
    expect(isProjectScopedOnly(vendor("codex"))).toBe(false);
    expect(isProjectScopedOnly(vendor("copilot"))).toBe(true);
    // kimi writes per project, but reads a home file too (S12.6, K4h) — so it has a home channel.
    expect(isProjectScopedOnly(vendor("kimi"))).toBe(false);
  });

  test("kimi shares ./AGENTS.md with copilot, and its home file survives the merge, credited to kimi", async () => {
    const targets = await resolveTargets(["copilot", "kimi"], { home: HOME, cwd: HOME, env: {}, which: async () => true });
    expect(targets).toHaveLength(1);
    const shared = targets[0]!;
    if (shared.kind !== "file") throw new Error("expected a file target");
    expect(shared.backend).toBe("copilot");
    expect(shared.alsoReadBy).toContain("kimi");
    expect(shared.alsoReads).toEqual([{ path: join(HOME, ".kimi-code/AGENTS.md"), by: "kimi" }]);
  });

  test("a linked home file is the file it points to, and one that is another vendor's target is not read twice", async () => {
    const { mkdtemp, mkdir, symlink, writeFile, rm, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const home = await realpath(await mkdtemp(join(tmpdir(), "om-targets-link-")));
    try {
      await mkdir(join(home, ".kimi-code"));
      await mkdir(join(home, "dotfiles"));
      await writeFile(join(home, "dotfiles", "AGENTS.md"), "x\n");
      await symlink(join(home, "dotfiles", "AGENTS.md"), join(home, ".kimi-code", "AGENTS.md"));
      const linked = (await resolveTargets(["kimi"], { home, cwd: home, env: {}, which: async () => true }))[0]!;
      if (linked.kind !== "file") throw new Error("expected a file target");
      expect(linked.alsoReads).toEqual([{ path: join(home, "dotfiles", "AGENTS.md"), by: "kimi" }]);

      await rm(join(home, ".kimi-code", "AGENTS.md"));
      await mkdir(join(home, ".claude"));
      await writeFile(join(home, ".claude", "CLAUDE.md"), "y\n");
      await symlink(join(home, ".claude", "CLAUDE.md"), join(home, ".kimi-code", "AGENTS.md"));
      const both = await resolveTargets(["claude", "kimi"], { home, cwd: home, env: {}, which: async () => true });
      const kimi = both.find((t) => t.kind === "file" && t.backend === "kimi");
      if (kimi === undefined || kimi.kind !== "file") throw new Error("expected kimi's target");
      expect(kimi.alsoReads).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("kimi: written in the project, and its home AGENTS.md read as well — never written", () => {
    const [written, also] = vendor("kimi").identity.instructionFiles;
    expect(written).toBe("./AGENTS.md");
    expect(expandPath(also!, { home: HOME, env: {} })).toBe(join(HOME, ".kimi-code/AGENTS.md"));
    expect(expandPath(also!, { home: HOME, env: { KIMI_CODE_HOME: "/opt/kimi" } })).toBe("/opt/kimi/AGENTS.md");
  });
});

describe("resolveTargets", () => {
  test("names a file for each vendor and a field for ollama", async () => {
    const targets = await resolveTargets(["claude", "codex", "ollama"], context());
    expect(targets.map((t) => t.backend)).toEqual(["claude", "codex", "ollama"]);

    const [claude, codex] = fileTargets(targets);
    expect(claude!.path).toBe(join(HOME, ".claude/CLAUDE.md"));
    expect(codex!.path).toBe(join(HOME, ".codex/AGENTS.md"));

    const ollama = targets.find((t) => t.backend === "ollama")!;
    expect(ollama.kind).toBe("system-field");
    // The local backend has the *stronger* channel, which is worth stating.
    expect(ollama.strength).toBe("system");
  });

  test("reports a vendor that is not installed as unreachable, not as an error", async () => {
    const targets = await resolveTargets(["claude", "codex", "ollama"], context({ installed: [] }));
    expect(targets.length).toBe(3);
    for (const target of fileTargets(targets)) expect(target.reachable).toBe(false);
    expect(targets.find((t) => t.backend === "ollama")).toBeDefined();
  });

  test("CODEX_HOME moves the codex target", async () => {
    const targets = await resolveTargets(["codex"], context({ env: { CODEX_HOME: "/opt/codex" } }));
    expect(fileTargets(targets)[0]!.path).toBe("/opt/codex/AGENTS.md");
  });

  test("two vendors reading one file give one target that names both", async () => {
    const targets = await resolveTargets(["claude", "grok"], context({ installed: ["claude", "grok"] }));
    expect(targets.length).toBe(1);
    const [only] = fileTargets(targets);
    expect(only!.backend).toBe("claude");
    expect(only!.alsoReadBy).toContain("grok");
  });

  test("a single vendor still reports who else reads its file", async () => {
    const targets = await resolveTargets(["claude"], context());
    expect(fileTargets(targets)[0]!.alsoReadBy).toContain("grok");
  });
});

describe("isKnownBackend", () => {
  test("accepts every vendor and the local backend, and nothing else", () => {
    expect(isKnownBackend("claude")).toBe(true);
    expect(isKnownBackend("codex")).toBe(true);
    expect(isKnownBackend("ollama")).toBe(true);
    expect(isKnownBackend("nonesuch")).toBe(false);
  });
});
