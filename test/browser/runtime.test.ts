/**
 * D-151 — a task's container: the exact `docker run`, the record written before
 * it, and the sweep that leaves no orphan. Against a scripted docker here; the
 * real one is `test/e2e/browser.e2e.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_PORT_FIRST, BROWSER_PORT_LAST } from "../../src/browser/ports.ts";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import {
  BROWSER_BUILD_DIR,
  BROWSER_CONTEXT_SHA256,
  BROWSER_IMAGE,
  BROWSER_LABEL,
  BROWSER_SCHEMA,
  browserDown,
  browserOutDir,
  browserStatus,
  browserUp,
  containerName,
  createRecord,
  dockerIo,
  endSubjectBrowsers,
  newToken,
  pastDeadline,
  shown,
  dockerRefusal,
  dockerRunArgs,
  mcpAnswers,
  newTaskId,
  ownerAlive,
  portFree,
  readBrowserRecords,
  recordPath,
  rootLabel,
  sweepBrowsers,
  taskProblem,
  wiringDir,
  withBrowser,
  type BrowserEnv,
  type BrowserRecord,
  type DockerIo,
} from "../../src/browser/runtime.ts";
import { arm } from "../../src/decide/stop.ts";
import { subjectId } from "../../src/types.ts";

const SUBJECT = subjectId("browser-test");
const IDS = { uid: 1000, gid: 1000 };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function box(): Promise<BrowserEnv & { readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), "mind-browser-"));
  dirs.push(root);
  return { root, home: root, env: { XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") } };
}

/** A docker that does what it is told and remembers being told. */
function fakeDocker(
  options: { image?: boolean; running?: string[]; failRun?: string; failKill?: string; failPs?: string; failBuild?: string; takenPorts?: number[] } = {},
) {
  const calls: string[][] = [];
  const envs: (Readonly<Record<string, string>> | undefined)[] = [];
  const running = new Set(options.running ?? []);
  let image = options.image ?? true;
  const io: DockerIo = {
    async run(args, env) {
      calls.push([...args]);
      envs.push(env);
      const [verb] = args;
      if (verb === "ps") {
        if (options.failPs !== undefined) return { code: 1, stdout: "", stderr: options.failPs };
        return { code: 0, stdout: [...running].map((name) => `${name}\n`).join(""), stderr: "" };
      }
      if (verb === "image") return { code: image ? 0 : 1, stdout: "", stderr: image ? "" : "No such image" };
      if (verb === "build") {
        if (options.failBuild !== undefined) return { code: 1, stdout: "", stderr: options.failBuild };
        image = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "run") {
        if (options.failRun !== undefined) return { code: 125, stdout: "", stderr: options.failRun };
        const published = args[args.indexOf("--publish") + 1]!;
        if ((options.takenPorts ?? []).some((port) => published.includes(`:${port}:`))) {
          return { code: 125, stdout: "", stderr: `Bind for 127.0.0.1:${published.split(":")[1]} failed: port is already allocated` };
        }
        running.add(args[args.indexOf("--name") + 1]!);
        return { code: 0, stdout: "abc\n", stderr: "" };
      }
      if (verb === "kill") {
        const name = args[1]!;
        if (options.failKill !== undefined) return { code: 1, stdout: "", stderr: options.failKill };
        if (!running.delete(name)) return { code: 1, stdout: "", stderr: `Error response from daemon: No such container: ${name}` };
        return { code: 0, stdout: `${name}\n`, stderr: "" };
      }
      return { code: 2, stdout: "", stderr: "unexpected" };
    },
  };
  return { io, calls, envs, running };
}

const ALWAYS = { portFree: () => true, ready: async () => true, ids: IDS };
const name = (env: BrowserEnv, task: string) => containerName(env, task);
const path = (env: BrowserEnv, task: string) => recordPath(env, SUBJECT, task);

describe("dockerRunArgs", () => {
  test("loopback port, the five capabilities the entrypoint drops, one mount, labels, the allowlist, the token by name only", () => {
    const record: BrowserRecord = {
      schema: BROWSER_SCHEMA,
      task: "t-1",
      subject: SUBJECT,
      container: "mind-browser-t-1",
      image: BROWSER_IMAGE,
      port: 30_731,
      token: newToken(),
      operate: 1,
      allowed: ["https://example.com:443", "http://host.docker.internal:30790"],
      outDir: "/data/mind/browser-test/personal/browser/t-1",
      owner: null,
      startedAt: "2026-10-05T00:00:00.000Z",
      ttlSeconds: 600,
    };
    const argv = dockerRunArgs(record, IDS, "abcd");
    const after = (flag: string) => argv.flatMap((part, index) => (part === flag ? [argv[index + 1]!] : []));
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--rm");
    expect(argv).toContain("--init");
    expect(argv).toContain("--read-only");
    expect(after("--publish")).toEqual(["127.0.0.1:30731:8931"]);
    expect(after("--cap-drop")).toEqual(["ALL"]);
    expect(after("--cap-add").sort()).toEqual(["KILL", "NET_ADMIN", "SETGID", "SETPCAP", "SETUID"]);
    expect(after("--security-opt")).toEqual(["no-new-privileges"]);
    expect(after("--mount")).toEqual([`type=bind,source=${record.outDir},target=/out`]);
    expect(argv.some((part) => part === "-v" || part === "--volume" || part === "--privileged")).toBe(false);
    expect(after("--label")).toEqual([`${BROWSER_LABEL}=1`, `${BROWSER_LABEL}.task=t-1`, `${BROWSER_LABEL}.root=abcd`]);
    expect(after("--env")).toEqual([
      "MIND_ALLOW=https://example.com:443,http://host.docker.internal:30790",
      "MIND_UID=1000",
      "MIND_GID=1000",
      "MIND_HOST_PORT=30731",
      "MIND_TTL=600",
      "MIND_OPERATE=1",
      "MIND_TOKEN",
    ]);
    expect(argv.join(" ")).not.toContain(record.token);
    expect(argv.at(-1)).toBe(BROWSER_IMAGE);
  });
});

describe("dockerRefusal and dockerIo", () => {
  test("only the verbs Mind uses — never push or login", () => {
    for (const ok of [["run"], ["kill", "x"], ["ps"], ["build", "."], ["image", "inspect", "x"]]) {
      expect(dockerRefusal(ok)).toBeUndefined();
    }
    expect(dockerRefusal(["push", BROWSER_IMAGE])).toContain("not one of the verbs");
    expect(dockerRefusal(["login"])).toContain("not one of the verbs");
    expect(dockerRefusal([])).toContain("not one of the verbs");
    expect(dockerRefusal(["image", "rm", "x"])).toContain("may only inspect");
  });

  test("the real io runs the docker on PATH through the spawn chokepoint, and refuses before spawning", async () => {
    const env = await box();
    const bin = join(env.root, "bin");
    await mkdir(bin);
    const script = join(bin, "docker");
    await writeFile(script, '#!/bin/sh\necho "argv:$*"\necho "to stderr" >&2\nexit 3\n');
    await chmod(script, 0o755);
    const io = dockerIo({ PATH: `${bin}:/usr/bin:/bin` });
    const ran = await io.run(["ps", "--format", "{{.Names}}"]);
    expect(ran).toEqual({ code: 3, stdout: "argv:ps --format {{.Names}}\n", stderr: "to stderr" });
    // A secret for `--env NAME` arrives in docker's environment, not its argv.
    await writeFile(script, '#!/bin/sh\necho "secret:$MIND_TOKEN"\n');
    expect((await io.run(["ps"], { MIND_TOKEN: "t0k" })).stdout).toBe("secret:t0k\n");
    expect((await io.run(["push", "x"])).code).toBe(126);
    const missing = dockerIo({ PATH: join(env.root, "nothing-here") });
    expect((await missing.run(["ps"])).code).not.toBe(0);
  });
});

describe("browserUp", () => {
  test("writes the record before docker run, starts the container, and returns a ready task", async () => {
    const env = await box();
    const docker = fakeDocker();
    const seenRecordAtRun: boolean[] = [];
    const io: DockerIo = {
      async run(args, extra) {
        if (args[0] === "run") seenRecordAtRun.push(existsSync(path(env, "t-up")));
        return docker.io.run(args, extra);
      },
    };
    const up = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], task: "t-up", io, ...ALWAYS });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(seenRecordAtRun).toEqual([true]);
    expect(up.built).toBe(false);
    expect(up.record).toMatchObject({
      task: "t-up",
      container: name(env, "t-up"),
      port: BROWSER_PORT_FIRST,
      allowed: ["https://example.com:443"],
      outDir: browserOutDir(env, SUBJECT, "t-up"),
      owner: null,
      ttlSeconds: 1800,
      operate: 1,
    });
    expect((await stat(up.record.outDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path(env, "t-up"))).mode & 0o777).toBe(0o600);
    expect(docker.running.has(name(env, "t-up"))).toBe(true);
    // The token: minted per task, in the record, handed to docker in its environment only.
    expect(up.record.token).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(await readFile(path(env, "t-up"), "utf8")).token).toBe(up.record.token);
    const runAt = docker.calls.findIndex((call) => call[0] === "run");
    expect(docker.envs[runAt]).toEqual({ MIND_TOKEN: up.record.token });
    expect(shown(up.record)).not.toHaveProperty("token");
    // The sweep runs first, and only ever over this state root's label.
    expect(docker.calls[0]).toEqual(["ps", "--filter", `label=${BROWSER_LABEL}.root=${rootLabel(env)}`, "--format", "{{.Names}}"]);
  });

  test("D-156, round 3: a task that can ask gets a wait and an Ed25519 pair — only the public half enters the container", async () => {
    const { createPublicKey, sign, verify } = await import("node:crypto");
    const env = await box();
    const docker = fakeDocker();
    const up = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], task: "t-ask", operate: 2, approvalWaitSeconds: 120, io: docker.io, ...ALWAYS });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(up.record.approvalWaitSeconds).toBe(120);
    const key = up.releaseKey!;
    expect(key.type).toBe("private");
    expect(key.asymmetricKeyType).toBe("ed25519");
    const publicKey = up.record.releasePublicKey!;
    // The public half is what the container verifies with: it checks the private half's signatures.
    const message = Buffer.from("mind-release\na-1\nsha256:x\napprove");
    expect(verify(null, message, createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }), sign(null, message, key))).toBe(true);
    const runAt = docker.calls.findIndex((call) => call[0] === "run");
    expect(docker.calls[runAt]).toContain("MIND_APPROVAL_WAIT=120");
    expect(docker.calls[runAt]).toContain(`MIND_RELEASE_PUBKEY=${publicKey}`);
    expect(docker.envs[runAt]).toEqual({ MIND_TOKEN: up.record.token });
    // Nothing secret of the signer anywhere the container or another user could read: argv, env, the record.
    const secret = [
      key.export({ type: "pkcs8", format: "der" }).toString("base64"),
      key.export({ type: "pkcs8", format: "pem" }).toString(),
      Buffer.from(key.export({ format: "jwk" }).d!, "base64url").toString("base64"),
    ];
    const seen = [docker.calls.flat().join(" "), JSON.stringify(docker.envs), await readFile(path(env, "t-ask"), "utf8")].join("\n");
    for (const part of secret) expect(seen).not.toContain(part);
    expect(seen).not.toContain(key.export({ format: "jwk" }).d!);
    // No docker exec at all: nothing is handed in after start.
    expect(docker.calls.some((call) => call[0] === "exec")).toBe(false);
    expect(dockerRefusal(["exec", "-i", "c", "sh"])).toContain("is not one of the verbs");
    // A browser started by hand has nobody to ask: no pair.
    const hand = fakeDocker();
    const plain = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], task: "t-plain", io: hand.io, ...ALWAYS });
    expect(plain.ok && plain.releaseKey).toBeUndefined();
    expect(plain.ok && plain.record.releasePublicKey).toBeUndefined();
    expect(hand.calls.flat().join(" ")).not.toContain("MIND_RELEASE_PUBKEY");
    for (const bad of [-1, 1.5, 3601]) {
      expect(await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], approvalWaitSeconds: bad, io: fakeDocker().io, ...ALWAYS })).toMatchObject({ ok: false, reason: "an approval's wait is 0–3600 seconds" });
    }
  });

  test("an owner is recorded with its start time, so a reused pid cannot keep a container alive", async () => {
    const env = await box();
    const up = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], owner: process.pid, io: fakeDocker().io, ...ALWAYS });
    expect(up.ok && up.record.owner?.pid).toBe(process.pid);
    expect(up.ok && typeof up.record.owner?.start).toBe("number");
    expect(up.ok && taskProblem(up.record.task)).toBeUndefined();
  });

  test("takes the lowest port no record holds and nothing else is bound to", async () => {
    const env = await box();
    const docker = fakeDocker();
    const first = await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-a", io: docker.io, ...ALWAYS });
    const second = await browserUp({
      env,
      subject: SUBJECT,
      allow: ["https://b.example"],
      task: "t-b",
      io: docker.io,
      ...ALWAYS,
      portFree: (port) => port !== BROWSER_PORT_FIRST + 1,
    });
    expect(first.ok && first.record.port).toBe(BROWSER_PORT_FIRST);
    expect(second.ok && second.record.port).toBe(BROWSER_PORT_FIRST + 2);
    const full = await browserUp({ env, subject: SUBJECT, allow: ["https://c.example"], io: docker.io, ...ALWAYS, portFree: () => false });
    expect(full.ok).toBe(false);
    expect(!full.ok && full.reason).toContain(`${BROWSER_PORT_FIRST}–${BROWSER_PORT_LAST}`);
  });

  test("the brake refuses it before anything else", async () => {
    const env = await box();
    const docker = fakeDocker();
    await arm(env, new Date(), "test");
    const up = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], io: docker.io, ...ALWAYS });
    expect(!up.ok && up.reason).toContain("the brake is on");
    expect(docker.calls).toEqual([]);
  });

  test("a port another `up` took between the probe and the run: the next one, the record following", async () => {
    const env = await box();
    const docker = fakeDocker({ takenPorts: [BROWSER_PORT_FIRST, BROWSER_PORT_FIRST + 1] });
    const up = await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-race", io: docker.io, ...ALWAYS });
    expect(up.ok && up.record.port).toBe(BROWSER_PORT_FIRST + 2);
    expect(JSON.parse(await readFile(path(env, "t-race"), "utf8")).port).toBe(BROWSER_PORT_FIRST + 2);
    const every = Array.from({ length: BROWSER_PORT_LAST - BROWSER_PORT_FIRST + 1 }, (_, index) => BROWSER_PORT_FIRST + index);
    const none = await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-none", io: fakeDocker({ takenPorts: every }).io, ...ALWAYS });
    expect(!none.ok && none.reason).toContain("every browser port");
    expect(existsSync(path(env, "t-none"))).toBe(false);
  });

  test("a record is created exclusively: the second of two for one task loses", async () => {
    const env = await box();
    const up = await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-x", io: fakeDocker().io, ...ALWAYS });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect((await createRecord(env, up.record)).ok).toBe(false);
  });

  test("refuses before docker is asked anything: a bad allowlist, task id, ttl, or root", async () => {
    const env = await box();
    const docker = fakeDocker();
    const base = { env, subject: SUBJECT, io: docker.io, ...ALWAYS };
    const cases = [
      [await browserUp({ ...base, allow: ["https://*.example.com"] }), "wildcards"],
      [await browserUp({ ...base, allow: ["https://example.com"], task: "Bad Task" }), "invalid task id"],
      [await browserUp({ ...base, allow: ["https://example.com"], ttlSeconds: 5 }), "ttl must be"],
      [await browserUp({ ...base, allow: ["https://example.com"], ttlSeconds: 99_999 }), "ttl must be"],
      [await browserUp({ ...base, allow: ["https://example.com"], ids: { uid: 0, gid: 0 } }), "never as root"],
      [await browserUp({ ...base, allow: ["https://example.com"], operate: 3 as unknown as 2 }), "operate is 1"],
    ] as const;
    for (const [up, words] of cases) {
      expect(up.ok).toBe(false);
      expect(!up.ok && up.reason).toContain(words);
    }
    expect(docker.calls).toEqual([]);
  });

  test("a task that is already up is refused; docker that cannot list is refused", async () => {
    const env = await box();
    const docker = fakeDocker();
    await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], task: "t-dup", io: docker.io, ...ALWAYS });
    const again = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], task: "t-dup", io: docker.io, ...ALWAYS });
    expect(!again.ok && again.reason).toContain("already has a browser");
    const broken = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], io: fakeDocker({ failPs: "Cannot connect to the Docker daemon" }).io, ...ALWAYS });
    expect(!broken.ok && broken.reason).toContain("docker is not usable here");
  });

  test("a missing image is built here, or refused with the command when building is off or fails", async () => {
    const env = await box();
    const docker = fakeDocker({ image: false });
    const built = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], io: docker.io, ...ALWAYS });
    expect(built.ok && built.built).toBe(true);
    const build = docker.calls.find((call) => call[0] === "build")!;
    expect(build.slice(0, 3)).toEqual(["build", "--tag", BROWSER_IMAGE]);
    expect(existsSync(join(build[3]!, "Dockerfile"))).toBe(true);

    const off = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], io: fakeDocker({ image: false }).io, build: false, ...ALWAYS });
    expect(!off.ok && off.reason).toContain(`docker build -t ${BROWSER_IMAGE} docker/browser`);
    const failing = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], io: fakeDocker({ image: false, failBuild: "a\nb\nno space left" }).io, ...ALWAYS });
    expect(!failing.ok && failing.reason).toContain("no space left");
  });

  test("a docker run that fails, or a server that never answers, leaves no record and no container", async () => {
    const env = await box();
    const failed = await browserUp({ env, subject: SUBJECT, allow: ["https://example.com"], task: "t-f", io: fakeDocker({ failRun: "no such image" }).io, ...ALWAYS });
    expect(!failed.ok && failed.reason).toContain("docker run failed: no such image");
    expect(existsSync(path(env, "t-f"))).toBe(false);

    const docker = fakeDocker();
    const silent = await browserUp({
      env,
      subject: SUBJECT,
      allow: ["https://example.com"],
      task: "t-s",
      io: docker.io,
      ...ALWAYS,
      ready: async () => false,
      readyWithinMs: 0,
    });
    expect(!silent.ok && silent.reason).toContain("did not answer");
    expect(docker.running.size).toBe(0);
    expect(existsSync(path(env, "t-s"))).toBe(false);
  });
});

describe("the sweep, down, status and withBrowser", () => {
  test("owner gone, no record, container gone — each ended; a live owner's is kept", async () => {
    const env = await box();
    const docker = fakeDocker({ running: ["mind-browser-stray"] });
    const dead = await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-dead", owner: process.pid, io: docker.io, ...ALWAYS });
    const kept = await browserUp({ env, subject: SUBJECT, allow: ["https://b.example"], task: "t-kept", owner: process.pid, io: docker.io, ...ALWAYS });
    const vanished = await browserUp({ env, subject: SUBJECT, allow: ["https://c.example"], task: "t-vanished", io: docker.io, ...ALWAYS });
    expect(dead.ok && kept.ok && vanished.ok).toBe(true);
    // The stray was swept by the first up already; put one back to see it here.
    docker.running.add("mind-browser-stray");
    docker.running.delete(name(env, "t-vanished"));
    // A record younger than the start grace may be another process's `up` between its record and its
    // `docker run`: not swept yet. Aged past it, it is.
    expect((await sweepBrowsers(env, { io: docker.io })).actions.some((action) => action.task === "t-vanished")).toBe(false);
    const vanishedPath = path(env, "t-vanished");
    const vanishedRecord = JSON.parse(await readFile(vanishedPath, "utf8"));
    await writeFile(vanishedPath, JSON.stringify({ ...vanishedRecord, startedAt: new Date(Date.now() - 120_000).toISOString() }));
    docker.running.add("mind-browser-stray");
    await mkdir(wiringDir(env, SUBJECT, "t-vanished"), { recursive: true });

    const stat = (pid: number) => (pid === process.pid ? { startTicks: -1 } : null);
    // `t-kept`'s owner is checked against the same lie; make its record ownerless first.
    const keptPath = path(env, "t-kept");
    const keptRecord = JSON.parse(await readFile(keptPath, "utf8"));
    await writeFile(keptPath, JSON.stringify({ ...keptRecord, owner: null }));

    const swept = await sweepBrowsers(env, { io: docker.io, stat });
    const byWhy = Object.fromEntries(swept.actions.map((action) => [action.container, action.why]));
    expect(byWhy).toEqual({
      [name(env, "t-dead")]: "owner gone",
      [name(env, "t-vanished")]: "container gone",
      "mind-browser-stray": "no record",
    });
    expect(existsSync(wiringDir(env, SUBJECT, "t-vanished"))).toBe(false);
    expect([...docker.running]).toEqual([name(env, "t-kept")]);
    expect((await readBrowserRecords(env)).records.map((record) => record.task)).toEqual(["t-kept"]);
  });

  test("a record past its deadline is ended whoever owns it — an owner-less one included", async () => {
    const env = await box();
    const docker = fakeDocker();
    await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-old", ttlSeconds: 60, io: docker.io, ...ALWAYS });
    await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-new", ttlSeconds: 600, owner: process.pid, io: docker.io, ...ALWAYS });
    const later = Date.now() + 60_000 + 61_000;
    const swept = await sweepBrowsers(env, { io: docker.io, now: () => later });
    expect(swept.actions.map((action) => [action.task, action.why])).toEqual([["t-old", "past its deadline"]]);
    expect([...docker.running]).toEqual([name(env, "t-new")]);
    expect(pastDeadline({ startedAt: "garbage", ttlSeconds: 60 })).toBe(true);
    expect(pastDeadline({ startedAt: new Date().toISOString(), ttlSeconds: 60 })).toBe(false);
  });

  test("erase's step: every container of the subject's records is killed, and only the subject's", async () => {
    const env = await box();
    const docker = fakeDocker();
    const other = subjectId("someone-else");
    await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-1", io: docker.io, ...ALWAYS });
    await browserUp({ env, subject: other, allow: ["https://a.example"], task: "t-2", io: docker.io, ...ALWAYS });
    const ended = await endSubjectBrowsers(env, SUBJECT, docker.io);
    expect(ended).toEqual([{ task: "t-1", container: name(env, "t-1"), ok: true, detail: "killed" }]);
    expect([...docker.running]).toEqual([name(env, "t-2")]);
  });

  test("stop's sweep ends everything; a kill docker refuses is reported and the record kept", async () => {
    const env = await box();
    const docker = fakeDocker();
    await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-1", io: docker.io, ...ALWAYS });
    const stubborn: DockerIo = {
      run: (args) => (args[0] === "kill" ? Promise.resolve({ code: 1, stdout: "", stderr: "permission denied" }) : docker.io.run(args)),
    };
    const refused = await sweepBrowsers(env, { io: stubborn, all: true });
    expect(refused.actions).toEqual([{ container: name(env, "t-1"), task: "t-1", why: "stopped", ok: false, detail: "permission denied" }]);
    expect(existsSync(path(env, "t-1"))).toBe(true);
    docker.running.add("mind-browser-unnamed");
    const all = await sweepBrowsers(env, { io: docker.io, all: true });
    expect(all.actions.map((action) => [action.container, action.why, action.ok])).toEqual([
      [name(env, "t-1"), "stopped", true],
      ["mind-browser-unnamed", "stopped", true],
    ]);
    expect(docker.running.size).toBe(0);
  });

  test("a sweep that cannot list containers touches no record", async () => {
    const env = await box();
    await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-1", io: fakeDocker().io, ...ALWAYS });
    const blind = await sweepBrowsers(env, { io: fakeDocker({ failPs: "" }).io });
    expect(blind.error).toBe("docker ps exited 1");
    expect(existsSync(path(env, "t-1"))).toBe(true);
  });

  test("down kills and forgets; an unknown task is already gone; a refused kill keeps the record", async () => {
    const env = await box();
    const docker = fakeDocker();
    await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-1", io: docker.io, ...ALWAYS });
    expect(await browserDown(env, "t-1", fakeDocker({ running: [name(env, "t-1")], failKill: "denied" }).io)).toEqual({
      ok: false,
      detail: "denied",
      recorded: true,
    });
    expect(await browserDown(env, "t-1", docker.io)).toEqual({ ok: true, detail: "killed", recorded: true });
    expect(existsSync(path(env, "t-1"))).toBe(false);
    expect(await browserDown(env, "t-1", docker.io)).toEqual({ ok: true, detail: "already gone", recorded: false });
  });

  test("status lists what runs after the sweep, and reports a record it cannot read", async () => {
    const env = await box();
    const docker = fakeDocker();
    await browserUp({ env, subject: SUBJECT, allow: ["https://a.example"], task: "t-1", io: docker.io, ...ALWAYS });
    await writeFile(join(env.env["XDG_STATE_HOME"]!, "mind", "browser", SUBJECT, "junk.json"), "{not json");
    await writeFile(join(env.env["XDG_STATE_HOME"]!, "mind", "browser", SUBJECT, "other.json"), '{"schema":"else"}');
    const status = await browserStatus(env, docker.io);
    expect(status.running.map((record) => record.task)).toEqual(["t-1"]);
    expect(status.unreadable.length).toBe(2);
    expect(status.error).toBeUndefined();
    const blind = await browserStatus(env, fakeDocker({ failPs: "no daemon" }).io);
    expect(blind.error).toBe("no daemon");
    expect((await readBrowserRecords(await box())).records).toEqual([]);
  });

  test("withBrowser ends the container whether the work returns or throws", async () => {
    const env = await box();
    const docker = fakeDocker();
    const done = await withBrowser({ env, subject: SUBJECT, allow: ["https://a.example"], io: docker.io, ...ALWAYS }, async (record) => {
      expect(docker.running.has(record.container)).toBe(true);
      expect(record.owner?.pid).toBe(process.pid);
      return record.port;
    });
    expect(done).toEqual({ ok: true, value: BROWSER_PORT_FIRST });
    expect(docker.running.size).toBe(0);
    await expect(
      withBrowser({ env, subject: SUBJECT, allow: ["https://a.example"], io: docker.io, ...ALWAYS }, async () => {
        throw new Error("the turn died");
      }),
    ).rejects.toThrow("the turn died");
    expect(docker.running.size).toBe(0);
    expect(await withBrowser({ env, subject: SUBJECT, allow: [], io: docker.io, ...ALWAYS }, async () => 1)).toMatchObject({ ok: false });
  });
});

describe("the image tag follows the build context", () => {
  test("BROWSER_CONTEXT_SHA256 is the digest of docker/browser/ as it is now", () => {
    const hash = createHash("sha256");
    for (const name of readdirSync(BROWSER_BUILD_DIR).sort()) {
      hash.update(name);
      hash.update("\0");
      hash.update(readFileSync(join(BROWSER_BUILD_DIR, name)));
      hash.update("\0");
    }
    const now = hash.digest("hex");
    expect(now, `docker/browser/ changed: set BROWSER_CONTEXT_SHA256 to ${now} so the image is rebuilt`).toBe(BROWSER_CONTEXT_SHA256);
    expect(BROWSER_IMAGE).toBe(`mind-browser:0.0.83-${now.slice(0, 12)}`);
  });
});

describe("small facts", () => {
  test("ownerAlive: no owner lives; a missing or restarted pid does not", () => {
    expect(ownerAlive(null)).toBe(true);
    expect(ownerAlive({ pid: process.pid, start: null })).toBe(true);
    expect(ownerAlive({ pid: 7, start: 5 }, () => ({ startTicks: 5 }))).toBe(true);
    expect(ownerAlive({ pid: 7, start: 5 }, () => ({ startTicks: 6 }))).toBe(false);
    expect(ownerAlive({ pid: 7, start: 5 }, () => null)).toBe(false);
  });

  test("task ids, the root label, the output dir under personal/", async () => {
    expect(taskProblem(newTaskId())).toBeUndefined();
    expect(taskProblem("-x")).toContain("invalid task id");
    const env = await box();
    expect(rootLabel(env)).toMatch(/^[0-9a-f]{16}$/);
    expect(rootLabel(env)).not.toBe(rootLabel(await box()));
    expect(containerName(env, "t-1")).toBe(`mind-browser-${rootLabel(env).slice(0, 8)}-t-1`);
    expect(browserOutDir(env, SUBJECT, "t-1")).toBe(join(env.env["XDG_DATA_HOME"]!, "mind", "browser-test", "personal", "browser", "t-1"));
  });

  test("portFree and mcpAnswers against real sockets: only an authorised answer that is not the guard's 502 is ready", async () => {
    let behind = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        request.headers.get("authorization") !== "Bearer t0k"
          ? new Response("token", { status: 401 })
          : new Response("", { status: behind ? 405 : 502 }),
    });
    const port = server.port!;
    try {
      expect(await portFree(port)).toBe(false);
      expect(await mcpAnswers(port, "t0k")).toBe(false);
      behind = true;
      expect(await mcpAnswers(port, "t0k")).toBe(true);
      expect(await mcpAnswers(port, "wrong")).toBe(false);
    } finally {
      await server.stop(true);
    }
    expect(await portFree(port)).toBe(true);
    expect(await mcpAnswers(port, "t0k")).toBe(false);
  });
});
