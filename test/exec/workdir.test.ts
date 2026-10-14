/**
 * D-163 / Q4-D2, second rule: a turn that may write is refused when its working directory is, contains, or
 * lies inside the agent's repo, Mind's state roots, ~/.secrets or ~/.ssh. Real paths, not string prefixes.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside, protectedPlaces, realish, unitWorkdirHints, workdirRefusal } from "../../src/exec/workdir.ts";

// realpath of the temp dir, so a tmp that is itself a link does not confuse the expectations.
const base = realpathSync(mkdtempSync(join(tmpdir(), "mind-workdir-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const home = join(base, "home");
const agent = join(base, "agent");
const other = join(base, "other");
const scratch = join(base, "scratch");
for (const dir of [home, agent, join(agent, "sub"), other, scratch, join(home, ".ssh"), join(home, ".local", "state", "mind"), join(base, "agent-two")]) mkdirSync(dir, { recursive: true });
// ~/.secrets and ~/.local/share/mind are deliberately absent: a place that does not exist yet is still protected.
symlinkSync(agent, join(other, "to-agent"));
symlinkSync(join(home, ".ssh"), join(scratch, "to-ssh"));
symlinkSync(scratch, join(agent, "to-scratch"));

const places = protectedPlaces(agent, home, {});
const refusal = (cwd: string) => workdirRefusal(cwd, places);

describe("isInside", () => {
  test("is a path relation, not a string prefix", () => {
    expect(isInside("/a/repo", "/a/repo")).toBe(true);
    expect(isInside("/a/repo/x/y", "/a/repo")).toBe(true);
    expect(isInside("/a/repo-two", "/a/repo")).toBe(false);
    expect(isInside("/a", "/a/repo")).toBe(false);
    expect(isInside("/a/..repo", "/a")).toBe(true);
  });
});

describe("the refusal", () => {
  test("the agent's repo itself, a folder inside it, and a trailing slash", () => {
    expect(refusal(agent)).toContain("inside the agent's repo");
    expect(refusal(join(agent, "sub"))).toBeDefined();
    expect(refusal(`${agent}/`)).toBeDefined();
    expect(refusal(`${join(agent, "sub")}//`)).toBeDefined();
  });

  test("a directory that contains the repo or the home (it holds ~/.ssh)", () => {
    expect(refusal(base)).toContain("contains");
    expect(refusal(home)).toContain("contains");
  });

  test("Mind's state root, its data root (not yet created), ~/.secrets (not yet created) and ~/.ssh", () => {
    expect(refusal(join(home, ".local", "state", "mind"))).toContain("state root");
    expect(refusal(join(home, ".ssh"))).toContain("~/.ssh");
    mkdirSync(join(home, ".secrets"));
    expect(refusal(join(home, ".secrets"))).toContain("~/.secrets");
    // The data root does not exist: its parent chain is resolved and the place still counts.
    expect(workdirRefusal(join(home, ".local", "share"), places)).toContain("data root");
  });

  test("XDG overrides move the roots with them", () => {
    const moved = protectedPlaces(agent, home, { XDG_STATE_HOME: join(base, "xdg-state"), XDG_DATA_HOME: join(base, "xdg-data") });
    mkdirSync(join(base, "xdg-state", "mind"), { recursive: true });
    expect(workdirRefusal(join(base, "xdg-state", "mind"), moved)).toContain("state root");
    expect(workdirRefusal(join(base, "xdg-data", "mind"), moved)).toContain("data root");
  });

  test("a symlink into the repo is refused, and so is a path through it", () => {
    expect(refusal(join(other, "to-agent"))).toContain("really");
    expect(refusal(join(other, "to-agent", "sub"))).toBeDefined();
  });

  test("a symlink to ~/.ssh is refused", () => {
    expect(refusal(join(scratch, "to-ssh"))).toContain("~/.ssh");
  });

  test("`..` is followed through a link by the filesystem, not collapsed by string", () => {
    // other/to-agent/.. is, in the real tree, the repo's parent (base) — which contains the repo. A string collapse would say `other`, which is harmless.
    expect(refusal(`${other}/to-agent/..`)).toContain("contains");
    // agent/to-scratch/.. is agent: inside itself.
    expect(refusal(`${agent}/to-scratch/..`)).toBeDefined();
    // a lexical `..` that leaves the repo for somewhere harmless is fine.
    expect(refusal(`${agent}/../other`)).toBeUndefined();
    // a lexical `..` that walks into it is not.
    expect(refusal(`${other}/../agent/sub`)).toBeDefined();
  });

  test("a sibling that merely shares the repo's name as a prefix, and ordinary places, are allowed", () => {
    expect(refusal(join(base, "agent-two"))).toBeUndefined();
    expect(refusal(scratch)).toBeUndefined();
    expect(refusal(other)).toBeUndefined();
  });

  test("the message says what to do", () => {
    const text = refusal(agent)!;
    expect(text).toContain("name another workdir");
    expect(text).toContain("Refused");
  });
});

describe("realish", () => {
  test("resolves links, and keeps the missing tail of a path that does not exist", () => {
    expect(realish(join(other, "to-agent"))).toBe(agent);
    expect(realish(join(other, "to-agent", "no", "such"))).toBe(join(agent, "no", "such"));
  });
});

describe("the tools' own logins are protected too", () => {
  const tools: readonly [string, string[]][] = [
    ["~/.claude", [".claude"]],
    ["~/.gnupg", [".gnupg"]],
    ["~/.config/gh", [".config", "gh"]],
    ["~/.docker", [".docker"]],
  ];
  for (const [label, parts] of tools) {
    test(`${label}: itself, inside it, a symlink to it, and a ..-through-a-link path`, () => {
      const target = join(home, ...parts);
      mkdirSync(join(target, "deep"), { recursive: true });
      expect(refusal(target)).toContain(label);
      expect(refusal(join(target, "deep"))).toContain(label);
      const link = join(scratch, `to-${parts.join("-")}`);
      symlinkSync(target, link);
      expect(refusal(link)).toContain(label);
      // link/deep/.. is the target itself, in the real tree.
      expect(refusal(`${link}/deep/..`)).toContain(label);
      // a sibling that only shares the name as a prefix is fine
      mkdirSync(`${target}-two`, { recursive: true });
      expect(refusal(`${target}-two`)).toBeUndefined();
    });
  }
});

describe("unitWorkdirHints (doctor, read-only)", () => {
  test("warns for a unit whose WorkingDirectory is the agent dir, and not for a scratch one", async () => {
    const h = realpathSync(mkdtempSync(join(tmpdir(), "mind-units-")));
    const units = join(h, ".config", "systemd", "user");
    mkdirSync(units, { recursive: true });
    const ag = join(h, "agent");
    mkdirSync(ag);
    mkdirSync(join(h, "scratch"));
    const { writeFileSync, readFileSync } = await import("node:fs");
    const handWeb = "mind-web-om.service";
    const triggers = "mind-triggers-om.service";
    writeFileSync(join(units, handWeb), `[Service]\nWorkingDirectory=${ag}\nExecStart=/usr/bin/mind web ${ag} --https\n`);
    writeFileSync(join(units, triggers), `[Service]\nWorkingDirectory=%h/scratch\nExecStart=/usr/bin/mind triggers run ${ag}\n`);
    writeFileSync(join(units, "unrelated.service"), `[Service]\nWorkingDirectory=${ag}\n`);
    const before = readFileSync(join(units, handWeb), "utf8");
    const hints = await unitWorkdirHints(h, {});
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain(handWeb);
    expect(hints[0]).toContain("scratch directory");
    // nothing was edited
    expect(readFileSync(join(units, handWeb), "utf8")).toBe(before);
    // WorkingDirectory=~ holds ~/.ssh, so it is flagged even with no agent named
    writeFileSync(join(units, triggers), `[Service]\nWorkingDirectory=%h\n`);
    mkdirSync(join(h, ".ssh"));
    expect((await unitWorkdirHints(h, {})).length).toBe(2);
    expect(await unitWorkdirHints(join(h, "nowhere"), {})).toEqual([]);
    rmSync(h, { recursive: true, force: true });
  });

  test("every unit name the engine writes is matched", async () => {
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const h = mkdtempSync(join(tmpdir(), "mind-units-"));
    const units = join(h, ".config", "systemd", "user");
    mkdirSync(units, { recursive: true });
    mkdirSync(join(h, ".ssh"));
    const names = [
      "mind-web-om",
      "mind-triggers-om",
    ];
    for (const name of names) writeFileSync(join(units, `${name}.service`), `[Service]\nWorkingDirectory=%h\n`);
    writeFileSync(join(units, "unrelated.service"), `[Service]\nWorkingDirectory=%h\n`);
    const hints = await unitWorkdirHints(h, {});
    expect(hints).toHaveLength(names.length);
    for (const name of names) expect(hints.some((hint) => hint.includes(`${name}.service`)), name).toBe(true);
    rmSync(h, { recursive: true, force: true });
  });
});
