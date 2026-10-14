/**
 * `mind browser` and `mind stop`'s browser step, end to end against a
 * scripted `docker` on PATH. The happy `up` — a real container answering — is
 * `test/e2e/browser.e2e.ts`; what is here is every refusal, `down`, `status`,
 * `mcp-config`, and that `stop` kills what it finds.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_SCHEMA, containerName, recordPath, wiringDir, type BrowserRecord } from "../../src/browser/runtime.ts";
import { subjectId } from "../../src/types.ts";
import { BUN } from "../support/bare-path.ts";

const SUBJECT = subjectId("cli-browser");
const BIN = join(import.meta.dir, "..", "..", "bin", "mind.ts");
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A docker that keeps its running containers in a file and logs every call. */
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_DIR/calls"
touch "$FAKE_DOCKER_DIR/running"
case "$1" in
  ps) [ -f "$FAKE_DOCKER_DIR/broken" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
      cat "$FAKE_DOCKER_DIR/running" ;;
  kill) if grep -qx "$2" "$FAKE_DOCKER_DIR/running"; then
          grep -vx "$2" "$FAKE_DOCKER_DIR/running" > "$FAKE_DOCKER_DIR/running.new"
          mv "$FAKE_DOCKER_DIR/running.new" "$FAKE_DOCKER_DIR/running"; echo "$2"
        else echo "Error response from daemon: No such container: $2" >&2; exit 1; fi ;;
  image) exit 0 ;;
  *) echo "unexpected" >&2; exit 2 ;;
esac
`;

async function harness() {
  const home = await mkdtemp(join(tmpdir(), "mind-browser-cli-"));
  scratch.push(home);
  const bin = join(home, "bin");
  const dockerDir = join(home, "docker");
  await mkdir(bin);
  await mkdir(dockerDir);
  await writeFile(join(bin, "docker"), FAKE_DOCKER);
  await chmod(join(bin, "docker"), 0o755);
  await symlink(BUN, join(bin, "bun"));
  const env = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    XDG_STATE_HOME: join(home, "state"),
    XDG_DATA_HOME: join(home, "data"),
    FAKE_DOCKER_DIR: dockerDir,
  };
  return { home, env, dockerDir, browserEnv: { home, env } };
}

async function run(env: Record<string, string>, args: readonly string[]) {
  const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: env["HOME"]!, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  await child.exited;
  return { code: child.exitCode, stdout, stderr };
}

async function plant(h: Awaited<ReturnType<typeof harness>>, task: string, running = true): Promise<BrowserRecord> {
  const record: BrowserRecord = {
    schema: BROWSER_SCHEMA,
    task,
    subject: SUBJECT,
    container: containerName(h.browserEnv, task),
    image: "mind-browser:0.0.83",
    port: 30_744,
    token: "9a".repeat(32),
    operate: 1,
    allowed: ["https://example.com:443"],
    outDir: join(h.home, "out", task),
    owner: null,
    // A gone one is old enough to be past the start grace; a live one is inside its deadline.
    startedAt: running ? new Date().toISOString() : "2026-10-05T00:00:00.000Z",
    ttlSeconds: 600,
  };
  await mkdir(join(h.env.XDG_STATE_HOME, "mind", "browser", SUBJECT), { recursive: true });
  await writeFile(recordPath(h.browserEnv, SUBJECT, task), JSON.stringify(record));
  if (running) await writeFile(join(h.dockerDir, "running"), `${record.container}\n`, { flag: "a" });
  return record;
}

describe("mind browser", () => {
  test("up refuses a bad allowlist, a missing subject and a bad task before docker is asked", async () => {
    const h = await harness();
    const wildcard = await run(h.env, ["browser", "up", "--subject", "cli-browser", "--allow", "https://*.example.com"]);
    expect(wildcard.code).toBe(2);
    expect(wildcard.stderr).toContain("wildcards");
    const none = await run(h.env, ["browser", "up", "--subject", "cli-browser"]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("at least one");
    expect((await run(h.env, ["browser", "up", "--allow", "https://example.com"])).code).toBe(2);
    expect((await run(h.env, ["browser", "up", "--subject", "cli-browser", "--allow", "https://example.com", "--task", "No"])).code).toBe(2);
    expect((await run(h.env, ["browser", "up", "--subject", "cli-browser", "--allow", "https://example.com", "--ttl", "soon"])).code).toBe(2);
    expect((await run(h.env, ["browser", "up", "--subject", "cli-browser", "--allow", "https://example.com", "--operate", "3"])).code).toBe(2);
    expect((await run(h.env, ["browser", "up", "stray", "--subject", "cli-browser", "--allow", "https://example.com"])).code).toBe(2);
    expect(existsSync(join(h.dockerDir, "calls"))).toBe(false);
  }, 30_000);

  test("up says so when docker is not usable, in words and in --json", async () => {
    const h = await harness();
    await writeFile(join(h.dockerDir, "broken"), "");
    const args = ["browser", "up", "--subject", "cli-browser", "--allow=https://example.com", "--allow", "http://host.docker.internal:30790"];
    const said = await run(h.env, args);
    expect(said.code).toBe(1);
    expect(said.stderr).toContain("docker is not usable here: Cannot connect to the Docker daemon");
    const json = await run(h.env, [...args, "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false });
  }, 30_000);

  test("up refuses while the brake is on, before docker is asked", async () => {
    const h = await harness();
    expect((await run(h.env, ["stop"])).stdout).toContain("1. the brake");
    await rm(join(h.dockerDir, "calls"), { force: true });
    const up = await run(h.env, ["browser", "up", "--subject", "cli-browser", "--allow", "https://example.com"]);
    expect(up.code).toBe(1);
    expect(up.stderr).toContain("the brake is on");
    expect(existsSync(join(h.dockerDir, "calls"))).toBe(false);
  }, 30_000);

  test("status sweeps what nothing names, lists what runs, and reports an unusable docker", async () => {
    const h = await harness();
    await plant(h, "t-live");
    await plant(h, "t-gone", false);
    await writeFile(join(h.dockerDir, "running"), "mind-browser-stray\n", { flag: "a" });
    const status = await run(h.env, ["browser", "status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain(`swept ${containerName(h.browserEnv, "t-gone")} (task t-gone): container gone`);
    expect(status.stdout).toContain("swept mind-browser-stray: no record");
    expect(status.stdout).toContain(`t-live  ${containerName(h.browserEnv, "t-live")}  127.0.0.1:30744`);
    expect(status.stdout).toContain("allowed: https://example.com:443 · operate 1 (look)");
    const raw = (await run(h.env, ["browser", "status", "--json"])).stdout;
    expect(raw).not.toContain("9a".repeat(32));
    const json = JSON.parse(raw);
    expect(json.running.map((record: BrowserRecord) => record.task)).toEqual(["t-live"]);
    expect((await run(h.env, ["browser", "status", "extra"])).code).toBe(2);
    await rm(recordPath(h.browserEnv, SUBJECT, "t-live"));
    await writeFile(join(h.dockerDir, "running"), "");
    expect((await run(h.env, ["browser", "status"])).stdout).toContain("no browser task is running");
    await writeFile(join(h.dockerDir, "broken"), "");
    const broken = await run(h.env, ["browser", "status"]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("docker is not usable here");
    expect((await run(h.env, ["browser", "status", "--json"])).code).toBe(1);
  }, 30_000);

  test("down kills and forgets; a task with no record is already gone; a bad id is refused", async () => {
    const h = await harness();
    await plant(h, "t-1");
    const down = await run(h.env, ["browser", "down", "t-1"]);
    expect(down.code, down.stderr).toBe(0);
    expect(down.stdout).toContain("down: t-1 — killed");
    expect(await readFile(join(h.dockerDir, "calls"), "utf8")).toContain(`kill ${containerName(h.browserEnv, "t-1")}`);
    expect(existsSync(recordPath(h.browserEnv, SUBJECT, "t-1"))).toBe(false);
    const again = JSON.parse((await run(h.env, ["browser", "down", "t-1", "--json"])).stdout);
    expect(again).toEqual({ task: "t-1", ok: true, detail: "already gone", recorded: false });
    expect((await run(h.env, ["browser", "down"])).code).toBe(2);
    expect((await run(h.env, ["browser", "down", "../x"])).code).toBe(2);
    expect((await run(h.env, ["browser", "nonsense"])).code).toBe(2);
  }, 30_000);

  test("down reports a container docker would not kill", async () => {
    const h = await harness();
    await plant(h, "t-1");
    await writeFile(join(h.home, "bin", "docker"), '#!/bin/sh\necho "permission denied" >&2\nexit 1\n');
    const down = await run(h.env, ["browser", "down", "t-1"]);
    expect(down.code).toBe(1);
    expect(down.stderr).toContain("could not be ended: permission denied");
  }, 30_000);

  test("mcp-config writes claude's one-server file for the task's port; other vendors say why not", async () => {
    const h = await harness();
    await plant(h, "t-1");
    const claude = await run(h.env, ["browser", "mcp-config", "t-1", "--vendor", "claude-local"]);
    expect(claude.code, claude.stderr).toBe(0);
    const path = join(wiringDir(h.browserEnv, SUBJECT, "t-1"), "claude-local-mcp.json");
    expect(claude.stdout).toContain(`wrote ${path}`);
    expect(claude.stdout).toContain("--strict-mcp-config --allowedTools mcp__mind-browser__browser_navigate,");
    expect(claude.stdout).not.toContain("browser_click");
    expect(claude.stdout).toContain("operate 1: look only");
    expect(claude.stdout).not.toContain("9a".repeat(32));
    // The planted container is at operate 1: a turn asking for 2 still gets look tools only.
    const acting = await run(h.env, ["browser", "mcp-config", "t-1", "--vendor", "claude-local", "--level", "2"]);
    expect(acting.stdout).not.toContain("mcp__mind-browser__browser_click");
    expect((await run(h.env, ["browser", "mcp-config", "t-1", "--vendor", "claude", "--level", "3"])).code).toBe(2);
    const written = JSON.parse(await readFile(path, "utf8")).mcpServers["mind-browser"];
    expect(written.url).toBe("http://127.0.0.1:30744/mcp");
    expect(written.headers.Authorization).toBe(`Bearer ${"9a".repeat(32)}`);
    const rawJson = (await run(h.env, ["browser", "mcp-config", "t-1", "--vendor", "claude", "--json"])).stdout;
    expect(rawJson).not.toContain("9a".repeat(32));
    const json = JSON.parse(rawJson);
    expect(json.status).toBe("wired");
    const grok = await run(h.env, ["browser", "mcp-config", "t-1", "--vendor", "grok-local"]);
    expect(grok.code).toBe(1);
    expect(grok.stdout).toContain("search_tool and use_tool");
    expect((await run(h.env, ["browser", "mcp-config", "t-9", "--vendor", "claude"])).code).toBe(1);
    expect((await run(h.env, ["browser", "mcp-config", "t-1"])).code).toBe(2);
  }, 30_000);
});

describe("mind stop, step 4", () => {
  test("docker kills every browser task of this state root, recorded or not", async () => {
    const h = await harness();
    await plant(h, "t-1");
    await writeFile(join(h.dockerDir, "running"), "mind-browser-unrecorded\n", { flag: "a" });
    const stop = await run(h.env, ["stop"]);
    expect(stop.stdout).toContain("4. browser tasks");
    expect(stop.stdout).toContain(`${containerName(h.browserEnv, "t-1")} (task t-1): killed`);
    expect(stop.stdout).toContain("mind-browser-unrecorded: killed");
    expect((await readFile(join(h.dockerDir, "running"), "utf8")).trim()).toBe("");
    expect(existsSync(recordPath(h.browserEnv, SUBJECT, "t-1"))).toBe(false);
  }, 30_000);

  test("with nothing running it says so, and without docker it prints the command to run", async () => {
    const h = await harness();
    expect((await run(h.env, ["stop"])).stdout).toContain("none running.");
    await writeFile(join(h.dockerDir, "broken"), "");
    const blind = await run(h.env, ["stop"]);
    expect(blind.stdout).toContain(`docker kill $(docker ps -q --filter label=dev.mind.browser=1)`);
  }, 30_000);

  test("a container docker will not kill is a failed stop, with the command", async () => {
    const h = await harness();
    await plant(h, "t-1");
    await writeFile(
      join(h.home, "bin", "docker"),
      `#!/bin/sh\ncase "$1" in ps) echo ${containerName(h.browserEnv, "t-1")} ;; *) echo "permission denied" >&2; exit 1 ;; esac\n`,
    );
    const stop = await run(h.env, ["stop"]);
    expect(stop.code).toBe(1);
    expect(stop.stdout).toContain(`NOT ended: permission denied — docker kill ${containerName(h.browserEnv, "t-1")}`);
  }, 30_000);
});
