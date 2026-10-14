/**
 * `mind doctor` on what a turn can read, and on a LiteLLM master key lying where a program of the owner's can
 * read it (EXEC-02, EEA-01).
 *
 * The search opens files that could hold a secret, so every case here runs in a temporary home and a temporary
 * working directory, and the master key in each fixture is a synthetic string that the assertions then look for
 * in everything `doctor` prints: the findings, the rendered report and the JSON. It must be in none of them, and
 * no run of eight characters of it either.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockers,
  checkReadExposure,
  doctorExit,
  DOCTOR_LIMITS,
  holdsMasterKey,
  renderDoctor,
  runDoctor,
  type DoctorEnv,
  type DoctorReport,
} from "../src/doctor.ts";
import { SYSTEM_READ_DIRS, type FenceSupport } from "../src/exec/fence.ts";
import { USAGE } from "../bin/usage.ts";

const MASTER = "sk-synthetic-master-0123456789abcdef";
const scratch: string[] = [];

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

/** The pieces of a secret a printed report must not contain, not only the whole of it. */
function pieces(secret: string): string[] {
  return Array.from({ length: secret.length - 7 }, (_, at) => secret.slice(at, at + 8));
}

const SUPPORTED: () => FenceSupport = () => ({ ok: true, abi: 8 });

async function machine(overrides: Partial<DoctorEnv> = {}): Promise<DoctorEnv & { home: string; cwd: string }> {
  const home = await temp("mind-exposure-home-");
  const cwd = await temp("mind-exposure-cwd-");
  return {
    home,
    cwd,
    env: {},
    engineRoot: undefined,
    which: () => null,
    run: async () => ({ code: 127, stdout: "", stderr: "not found", timedOut: false }),
    getJson: async () => ({ ok: false, reason: "connection refused" }),
    ollamaHost: "http://127.0.0.1:11434",
    qdrantHost: "http://127.0.0.1:10300",
    models: [],
    backends: [],
    probeVersions: false,
    fence: SUPPORTED,
    ...overrides,
  };
}

function everything(report: DoctorReport): string {
  return `${JSON.stringify(report)}\n${renderDoctor(report).join("\n")}`;
}

describe("holdsMasterKey", () => {
  test("a value counts; an empty one, a reference and a comment do not", () => {
    for (const text of [
      `LITELLM_MASTER_KEY=${MASTER}`,
      `export LITELLM_MASTER_KEY="${MASTER}"`,
      `  LITELLM_MASTER_KEY = '${MASTER}'  # the proxy`,
      `    environment:\n      LITELLM_MASTER_KEY: ${MASTER}`,
      `      - LITELLM_MASTER_KEY=${MASTER}`,
      `Environment="LITELLM_MASTER_KEY=${MASTER}"`,
      `{"LITELLM_MASTER_KEY": "${MASTER}"}`,
    ]) {
      expect(holdsMasterKey(text), text).toBe(true);
    }
    for (const text of [
      "LITELLM_MASTER_KEY=",
      'LITELLM_MASTER_KEY=""',
      "LITELLM_MASTER_KEY: ${LITELLM_MASTER_KEY}",
      "LITELLM_MASTER_KEY=$(cat /run/secrets/litellm)",
      `# LITELLM_MASTER_KEY=${MASTER}`,
      `  // LITELLM_MASTER_KEY=${MASTER}`,
      "LITELLM_API_KEY=a-virtual-key",
      "nothing here",
      "",
    ]) {
      expect(holdsMasterKey(text), text).toBe(false);
    }
  });
});

describe("what a turn can read", () => {
  test("on a clean machine: the local fence's reach is said, the cloud tools are a warning, no master key is found", async () => {
    const env = await machine();
    const section = await checkReadExposure(env);
    expect(section.title).toContain("what a turn can read");
    const byId = new Map(section.findings.map((finding) => [finding.id, finding]));

    const local = byId.get("exposure:local-reads")!;
    expect(local.severity).toBe("ok");
    for (const directory of SYSTEM_READ_DIRS) expect(local.detail).toContain(directory);
    expect(local.detail).toContain("~/.secrets");
    expect(local.detail).toContain("Landlock ABI 8");

    const cloud = byId.get("exposure:cloud-reads")!;
    expect(cloud.severity).toBe("warn");
    expect(cloud.detail).toContain("can open any file you can");
    expect(cloud.detail).toContain("never what the tool reads");

    expect(byId.get("exposure:master-key")!.severity).toBe("ok");
    expect(section.findings.filter((finding) => finding.severity === "missing")).toEqual([]);
  });

  test("with nothing to open it says so in words, with no zero count an `ok` could hide behind", async () => {
    const empty = (await checkReadExposure(await machine())).findings.find((finding) => finding.id === "exposure:master-key")!;
    expect(empty.severity).toBe("ok");
    expect(empty.detail).toContain("none of the places listed under DOCTOR_LIMITS holds a file");
    expect(empty.detail).not.toMatch(/(^|\s)0\s+\S/);

    const env = await machine();
    await mkdir(join(env.home, ".secrets"), { recursive: true });
    await writeFile(join(env.home, ".secrets", "a.env"), "OTHER=1\n");
    const some = (await checkReadExposure(env)).findings.find((finding) => finding.id === "exposure:master-key")!;
    expect(some.detail).toContain("no LITELLM_MASTER_KEY in the 1 file(s) searched");
  });

  test("a kernel that cannot hold the fence is said: no local turn runs, so none reads anything", async () => {
    const env = await machine({ fence: () => ({ ok: false, reason: "Landlock is unavailable: Function not implemented (errno 38)" }) });
    const local = (await checkReadExposure(env)).findings.find((finding) => finding.id === "exposure:local-reads")!;
    expect(local.severity).toBe("warn");
    expect(local.detail).toContain("cannot hold the fence");
    expect(local.detail).toContain("no local turn runs here");
  });

  test("it is part of the report, after the sections the older tests index, and in DOCTOR_LIMITS", async () => {
    const report = await runDoctor(await machine());
    expect(report.sections.map((section) => section.title).filter((title) => title.startsWith("what a turn can read"))).toHaveLength(1);
    expect(DOCTOR_LIMITS.join(" ")).toContain("what a turn can read");
    expect(DOCTOR_LIMITS.join(" ")).toContain("At most 200 files");
  });
});

describe("a LiteLLM master key where a program of the owner's can read it", () => {
  async function plant(env: { home: string }, relative: string, text: string): Promise<string> {
    const path = join(env.home, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
    return path;
  }

  async function failing(env: DoctorEnv): Promise<{ report: DoctorReport; hits: string[] }> {
    const report = await runDoctor(env);
    const hits = blockers(report).filter((finding) => finding.id.startsWith("exposure:master-key")).map((finding) => finding.detail);
    return { report, hits };
  }

  test("a file in ~/.secrets fails the report, names its path, and prints nothing of its contents", async () => {
    const env = await machine();
    await plant(env, ".secrets/.env.proxy", `OTHER=1\nLITELLM_MASTER_KEY=${MASTER}\n`);
    const { report, hits } = await failing(env);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("~/.secrets/.env.proxy");
    expect(hits[0]).toContain("directly in ~/.secrets");
    expect(doctorExit(report)).toBe(1);
    const text = everything(report);
    for (const piece of pieces(MASTER)) expect(text).not.toContain(piece);
    expect(renderDoctor(report).join("\n")).toContain("not safe — 1 thing(s) a program running as you can read");
    // The home is shown as ~, not spelled out.
    expect(text).not.toContain(env.home);
  });

  test("the key file Mind itself reads fails too when it also holds the master key (D-124 allows the two together)", async () => {
    const env = await machine();
    const keyFile = await plant(env, "keys/litellm.env", `LITELLM_API_KEY=virtual\nLITELLM_MASTER_KEY=${MASTER}\n`);
    const { hits } = await failing({ ...env, env: { MIND_LITELLM_KEY_FILE: keyFile } });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("the LiteLLM key file in use");
  });

  test("a compose file and an env file in the working directory, and in the agent directory", async () => {
    const env = await machine();
    const agent = await temp("mind-exposure-agent-");
    await writeFile(join(env.cwd, "docker-compose.yml"), `services:\n  litellm:\n    environment:\n      LITELLM_MASTER_KEY: ${MASTER}\n`);
    await writeFile(join(agent, ".env.local"), `LITELLM_MASTER_KEY=${MASTER}\n`);
    const { report, hits } = await failing({ ...env, agent });
    expect(hits).toHaveLength(2);
    expect(hits.join("\n")).toContain("a settings file in the working directory");
    expect(hits.join("\n")).toContain("a settings file in the agent directory");
    for (const piece of pieces(MASTER)) expect(everything(report)).not.toContain(piece);
  });

  test("a litellm user unit, and the env file it names inside the home — not one it names outside", async () => {
    const env = await machine();
    const outside = await temp("mind-exposure-outside-");
    await writeFile(join(outside, "outside.env"), `LITELLM_MASTER_KEY=${MASTER}\n`);
    await plant(env, "lite/.env", `LITELLM_MASTER_KEY=${MASTER}\n`);
    await plant(
      env,
      ".config/systemd/user/litellm-proxy.service",
      `[Service]\nEnvironmentFile=%h/lite/.env\nEnvironmentFile=-${join(outside, "outside.env")}\nExecStart=/bin/true\n`,
    );
    const { hits } = await failing(env);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("~/lite/.env");
    expect(hits[0]).toContain("the env file a litellm user unit names");
  });

  test("a unit that holds the key itself, and a settings file in ~/litellm", async () => {
    const env = await machine();
    await plant(env, ".config/systemd/user/litellm.service", `[Service]\nEnvironment="LITELLM_MASTER_KEY=${MASTER}"\n`);
    await plant(env, "litellm/.env", `LITELLM_MASTER_KEY=${MASTER}\n`);
    await plant(env, "litellm/notes.txt", `LITELLM_MASTER_KEY=${MASTER}\n`);
    const { hits } = await failing(env);
    expect(hits.map((hit) => hit.split(" ")[0]).sort()).toEqual(["~/.config/systemd/user/litellm.service", "~/litellm/.env"]);
  });

  test("an empty value, a reference and a comment are not a key", async () => {
    const env = await machine();
    await plant(env, ".secrets/a.env", "LITELLM_MASTER_KEY=\n");
    await plant(env, ".secrets/b.env", "LITELLM_MASTER_KEY=${LITELLM_MASTER_KEY}\n");
    await plant(env, ".secrets/c.env", `# LITELLM_MASTER_KEY=${MASTER}\n`);
    const { hits } = await failing(env);
    expect(hits).toEqual([]);
  });

  test("the search stays inside its list: nothing recursive, nothing elsewhere, nothing large", async () => {
    const env = await machine();
    await plant(env, "projects/app/.env", `LITELLM_MASTER_KEY=${MASTER}\n`);
    await plant(env, ".secrets/deeper/nested.env", `LITELLM_MASTER_KEY=${MASTER}\n`);
    await plant(env, ".secrets/huge.env", `LITELLM_MASTER_KEY=${MASTER}\n${"x".repeat(300 * 1024)}`);
    await plant(env, "litellm/sub/.env", `LITELLM_MASTER_KEY=${MASTER}\n`);
    const section = await checkReadExposure(env);
    expect(section.findings.filter((finding) => finding.severity === "missing")).toEqual([]);
    const clean = section.findings.find((finding) => finding.id === "exposure:master-key")!;
    expect(clean.detail).toContain("a bounded list");
    expect(clean.detail).toContain("a key kept elsewhere is not found");
  });

  test("it opens at most 200 files and says it stopped", async () => {
    const env = await machine();
    for (let index = 0; index < 205; index += 1) {
      // The one that holds the key sorts last, past the limit.
      const name = index === 204 ? "zzz.env" : `f${String(index).padStart(3, "0")}.env`;
      await plant(env, `.secrets/${name}`, index === 204 ? `LITELLM_MASTER_KEY=${MASTER}\n` : "OTHER=1\n");
    }
    const section = await checkReadExposure(env);
    expect(section.notes.join(" ")).toContain("stopped at 200 files");
    expect(section.findings.filter((finding) => finding.severity === "missing")).toEqual([]);
  });

  test("a symlink in ~/.secrets is followed to the one file it names, and a directory or a device is not read", async () => {
    const env = await machine();
    const real = await plant(env, "elsewhere/real.env", `LITELLM_MASTER_KEY=${MASTER}\n`);
    await mkdir(join(env.home, ".secrets"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(real, join(env.home, ".secrets", "link.env"));
    await symlink("/dev/zero", join(env.home, ".secrets", "device.env"));
    const { hits } = await failing(env);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("~/.secrets/link.env");
  });

  test("a machine with only local-route trouble still reads `not ready`, and only that", async () => {
    const report = await runDoctor(await machine());
    const text = renderDoctor(report).join("\n");
    expect(text).toContain("thing(s) the local route needs are missing");
    expect(text).not.toContain("not safe");
  });
});

describe("what `mind help` says about doctor's exit code", () => {
  // `doctor` exits 1 for a readable master key as well as for a broken local route (D-124 tightened). The text
  // in `mind help`, which an owner reads first, said "only when the local route is broken" until the review of
  // 2026-10-13, while DOCTOR_LIMITS and the quickstart already named the second case.
  const entry = (): string => {
    const start = USAGE.indexOf("  mind doctor");
    const end = USAGE.indexOf("  mind setup", start);
    expect(start, "bin/usage.ts lost its `mind doctor` entry").toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return USAGE.slice(start, end).replace(/\s+/g, " ");
  };

  test("it names both reasons for exit 1: the local route and a readable master key", () => {
    expect(entry()).toContain("Exit 1 only when the local route is broken, or when a file a program running as you can read holds the LiteLLM master key");
    expect(entry()).toContain('"not safe"');
  });
});
