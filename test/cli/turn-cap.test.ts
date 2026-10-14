/**
 * D-163 / Q4-D2 through the real `mind turn`, with a stub vendor on PATH: a cloud turn at a loosened dial
 * is held at write 1 / run 1 (the vendor is handed exactly the level-1 tool set), says so, still answers, and
 * a turn that may write is refused in the agent's repo — by symlink too. Nothing here spends quota.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN, barePath } from "../support/bare-path.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

const STUB = `#!/usr/bin/env bun
require("node:fs").appendFileSync(process.env["HOME"] + "/argv-claude.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");
const answer = "stub answer";
console.log(JSON.stringify({ result: answer, text: answer }));
`;

interface Rig {
  readonly home: string;
  readonly env: Record<string, string>;
  readonly agent: string;
  readonly work: string;
}

async function rig(): Promise<Rig> {
  const home = await mkdtemp(join(tmpdir(), "mind-turn-cap-"));
  scratch.push(home);
  const stubs = join(home, "bin");
  await mkdir(stubs, { recursive: true });
  await writeFile(join(stubs, "claude"), STUB);
  await chmod(join(stubs, "claude"), 0o755);
  const agent = join(home, "agent");
  await cp(SOUL, agent, { recursive: true });
  const work = join(home, "work");
  await mkdir(work);
  return {
    home,
    agent,
    work,
    env: {
      HOME: home,
      PATH: `${stubs}:${await barePath(home)}`,
      XDG_STATE_HOME: join(home, "state"),
      XDG_DATA_HOME: join(home, "data"),
      MIND_QDRANT_URL: "http://127.0.0.1:9",
      OLLAMA_HOST: "http://127.0.0.1:1",
    },
  };
}

async function cli(r: Rig, args: readonly string[], cwd: string) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd, env: r.env, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

async function setDial(r: Rig, level: string): Promise<void> {
  for (const category of ["write", "run", "reach"]) {
    const set = await cli(r, ["autonomy", "set", category, level, r.agent, "--subject", "example"], r.work);
    expect(set.code, set.stderr).toBe(0);
  }
}

async function argvs(r: Rig): Promise<string[][]> {
  const text = await readFile(join(r.home, "argv-claude.jsonl"), "utf8").catch(() => "");
  return text.trim() === "" ? [] : text.trim().split("\n").map((line) => JSON.parse(line) as string[]);
}

const TURN = (r: Rig) => ["turn", r.agent, "--subject", "example", "--prompt", "Say hi.", "--backend", "claude", "--json", "--no-recall"];

describe("a cloud turn at a loosened dial", () => {
  test("is handed only the level-1 tool set, says what was capped and why, and still answers", async () => {
    const r = await rig();
    const base = await cli(r, TURN(r), r.work);
    expect(base.code, base.stderr).toBe(0);

    await setDial(r, "2");
    const loosened = await cli(r, TURN(r), r.work);
    expect(loosened.code, loosened.stderr).toBe(0);

    const [atOne, atTwo] = await argvs(r);
    expect(atTwo).toEqual(atOne!);
    expect(atTwo!.join(" ")).not.toContain("acceptEdits");
    expect(atTwo!.join(" ")).not.toContain("allowedTools");

    expect(loosened.stderr).toContain("claude is not kernel-fenced");
    expect(loosened.stderr).toContain("held at write 1 and run 1");
    const out = JSON.parse(loosened.stdout) as { text: string; capped?: string; notes: string[] };
    expect(out.text).toBe("stub answer");
    expect(out.capped).toContain("temporary cap");
    expect(out.notes).toContain(out.capped!);
    expect(JSON.parse(base.stdout).capped).toBeUndefined();
  }, 30_000);
});

describe("the workdir refusal", () => {
  test("a turn that may write is refused in the agent's repo, before anything is sent", async () => {
    const r = await rig();
    await setDial(r, "2");
    const refused = await cli(r, TURN(r), r.agent);
    expect(refused.code).toBe(4);
    expect(refused.stderr).toContain("name another workdir");
    expect(await argvs(r)).toEqual([]);
  }, 30_000);

  test("a symlink to the repo is the repo", async () => {
    const r = await rig();
    await setDial(r, "2");
    await symlink(r.agent, join(r.work, "innocent"));
    const refused = await cli(r, TURN(r), join(r.work, "innocent"));
    expect(refused.code).toBe(4);
    // The kernel hands the child its real directory, so the message names the repo itself.
    expect(refused.stderr).toContain("inside the agent's repo");
    expect(await argvs(r)).toEqual([]);
  }, 30_000);

  test("the same directory is fine at level 1: nothing may write, so nothing is refused", async () => {
    const r = await rig();
    const ok = await cli(r, TURN(r), r.agent);
    expect(ok.code, ok.stderr).toBe(0);
  }, 30_000);
});

describe("mind doctor", () => {
  const DOCTOR = (r: Rig) => ["doctor", "--agent", r.agent, "--subject", "example", "--backend", "claude,codex", "--no-version"];

  test("names which backends are capped when the dial is above 1, in one line", async () => {
    const r = await rig();
    await setDial(r, "2");
    const said = await cli(r, DOCTOR(r), r.work);
    const lines = said.stdout.split("\n").filter((line) => line.startsWith("capped at write/run 1"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("claude, codex");
    expect(lines[0]).toContain("keep the dial (fenced): claude-local, grok-local");
  }, 30_000);

  // The unit names the engine writes.
  const UNIT_PREFIXES: readonly (readonly [string, string])[] = [
    ["a web unit", "mind-web-"],
    ["a triggers unit", "mind-triggers-"],
  ];

  test.each(UNIT_PREFIXES)("warns about %s whose WorkingDirectory would be refused, and edits nothing", async (_what, prefix) => {
    const r = await rig();
    const units = join(r.home, ".config", "systemd", "user");
    await mkdir(units, { recursive: true });
    const unit = `[Service]\nWorkingDirectory=${r.agent}\nExecStart=/bin/true web ${r.agent}\n`;
    await writeFile(join(units, `${prefix}test.service`), unit);
    const said = await cli(r, DOCTOR(r), r.work);
    expect(said.stdout).toContain(`${prefix}test.service: WorkingDirectory=`);
    expect(said.stdout).toContain("Point WorkingDirectory at a scratch directory");
    expect(await readFile(join(units, `${prefix}test.service`), "utf8")).toBe(unit);
  }, 30_000);

  test("says nothing about it at the default dial", async () => {
    const r = await rig();
    const said = await cli(r, DOCTOR(r), r.work);
    expect(said.stdout).not.toContain("capped at write/run 1");
  }, 30_000);
});

test("a task step's held-at-1 line is wired into the turn path", async () => {
  const source = await readFile(join(ROOT, "bin", "commands", "turn.ts"), "utf8");
  expect(source).toContain("task === undefined ? PROPOSE_INSTRUCTION : HELD_AT_ONE_TASK");
});
