/**
 * D-192 — the kernel fence around cloud turns, without a kernel or a vendor: policy construction, the vendor's
 * home of Mind's own and its credential copy, the notice an unfenced turn carries, F1's level/vendor matrix, F4's
 * fallback, and the cap that a fenced cloud turn no longer needs. The real vendors in the real fence are
 * `cloud-fence.real.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOUD_PORT,
  cloudEnvironment,
  cloudFenceLimits,
  cloudFenceNotice,
  cloudFencePolicy,
  cloudFenceSummary,
  cloudForcedEnvironment,
  cloudHomePaths,
  cloudVerdict,
  credentialSyncNote,
  prepareCloudHome,
  readResolvers,
  resolversFrom,
  startsWithoutTools,
  syncCredentialBack,
  writeCloudIdentity,
  type CloudHomeSpec,
} from "../../src/exec/cloud-fence.ts";
import { CliExec } from "../../src/exec/cli-exec.ts";
import { capRequest, CappedExec } from "../../src/exec/cap.ts";
import type { FencePolicy, FenceSupport } from "../../src/exec/fence.ts";
import { codexNativeProgram, grantArgs, readonlyLimits, vendor, VENDORS, CODEX_GRANT, type VendorSpec } from "../../src/exec/registry.ts";
import { CLOUD_HOMES, cloudHomeDir } from "../../src/erase/local-cli-homes.ts";
import { subjectId } from "../../src/types.ts";
import { atLevel, LOOSENED, operating, RESTRAINED } from "../support/restraint.ts";

const SUBJECT = subjectId("example");
const OK: FenceSupport = { ok: true, abi: 8 };
const NO: FenceSupport = { ok: false, reason: "synthetic kernel without Landlock" };

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-cloud-fence-"));
  scratch.push(dir);
  return dir;
}

const claude = vendor("claude");
const codex = vendor("codex");

describe("F1 — which cloud turns are fenced", () => {
  test("every vendor, every level: only a tool-free turn and an unmeasured vendor stay outside, and F4 says why", () => {
    for (const spec of VENDORS) {
      for (const level of [1, 2, 3] as const) {
        const request = { restraint: atLevel(level), subject: SUBJECT, prompt: "" };
        const verdict = cloudVerdict(spec, request, OK);
        const toolFree = spec.id === "claude" && level === 1;
        if (toolFree) expect(verdict.kind).toBe("tool-free");
        else if (spec.cloudHome === undefined) expect(verdict.kind).toBe("unmeasured");
        else expect(verdict.kind).toBe("fenced");
        // F4: no kernel, never a refusal — a run with a notice.
        const bare = cloudVerdict(spec, request, NO);
        if (toolFree) expect(bare.kind).toBe("tool-free");
        else if (spec.cloudHome === undefined) expect(bare.kind).toBe("unmeasured");
        else expect(bare).toEqual({ kind: "no-kernel", reason: NO.reason });
      }
    }
  });

  test("claude, codex and grok are the measured ones, and erase spells the same list", () => {
    expect(VENDORS.filter((spec) => spec.cloudHome !== undefined).map((spec) => spec.id)).toEqual([...CLOUD_HOMES]);
  });

  test("claude at level 1 with a browser has tools (its MCP server), so it is fenced", () => {
    const request = { restraint: operating(1), subject: SUBJECT, prompt: "", browser: { port: 30730, dir: "/tmp/x", token: "t", task: "t1" } as never };
    expect(startsWithoutTools(claude, request)).toBe(false);
    expect(cloudVerdict(claude, request, OK).kind).toBe("fenced");
  });

  test("a request that already carries a fence is a local turn's and not this file's", () => {
    expect(cloudVerdict(codex, { restraint: LOOSENED, fence: { writable: [], tcpPorts: [10400] } }, OK).kind).toBe("local");
  });

  test("the notice: said for no-kernel and unmeasured, nothing for fenced, local or tool-free", () => {
    expect(cloudFenceNotice(codex, { kind: "no-kernel", reason: "r" })).toContain("no kernel fence is in force for this codex turn: r");
    expect(cloudFenceNotice(codex, { kind: "no-kernel", reason: "r" })).toContain("F4");
    expect(cloudFenceNotice(vendor("kimi"), { kind: "unmeasured" })).toContain("has not measured a home and credential for kimi");
    for (const kind of ["local", "tool-free"] as const) expect(cloudFenceNotice(codex, { kind })).toBeUndefined();
    expect(cloudFenceNotice(codex, { kind: "fenced", cloud: codex.cloudHome! })).toBeUndefined();
  });
});

describe("F3 — the network policy", () => {
  test("443 anywhere but loopback, the resolvers on 53, the home always writable and the cwd only at level 2", async () => {
    const owner = await temp();
    const paths = cloudHomePaths(codex, codex.cloudHome!, SUBJECT, owner, { XDG_STATE_HOME: join(owner, "state") });
    const restrained = cloudFencePolicy({ paths, cwd: "/work", loosened: false, resolvers: ["127.0.0.53"], resolvConf: "/etc/resolv.conf" });
    expect(restrained).toEqual({
      writable: [paths.home],
      tcpPorts: [],
      remotePorts: [CLOUD_PORT],
      resolvers: ["127.0.0.53"],
      readable: ["/etc/resolv.conf"],
    });
    const loosened = cloudFencePolicy({ paths, cwd: "/work", loosened: true, resolvers: [], browser: { port: 30731, dir: "/b" } });
    expect(loosened).toEqual({ writable: [paths.home, "/work"], tcpPorts: [30731], remotePorts: [443], readable: ["/b"] });
  });

  test("scope machine (S22.8): the grants are what a loosened turn writes, in place of the working directory", async () => {
    const owner = await temp();
    const paths = cloudHomePaths(codex, codex.cloudHome!, SUBJECT, owner, { XDG_STATE_HOME: join(owner, "state") });
    const machine = { grants: ["/data", "/home/dev/work"] };
    // `/` as the working directory must not become a grant of `/`: a grant cannot be carved around the red lines.
    const loosened = cloudFencePolicy({ paths, cwd: "/", loosened: true, resolvers: [], machine });
    expect(loosened.writable).toEqual([paths.home, "/data", "/home/dev/work"]);
    expect(loosened.writable).not.toContain("/");
    // A restrained turn writes nothing but its home, machine or not.
    expect(cloudFencePolicy({ paths, cwd: "/", loosened: false, resolvers: [], machine }).writable).toEqual([paths.home]);
  });

  test("name servers are read from resolv.conf: IPv4 only, in order, once each; none when it cannot be read", async () => {
    expect(resolversFrom("# c\nnameserver 127.0.0.53\nnameserver ::1\nnameserver 1.1.1.1\n  nameserver 127.0.0.53\noptions x\nnameserver bad")).toEqual(["127.0.0.53", "1.1.1.1"]);
    const dir = await temp();
    await writeFile(join(dir, "resolv.conf"), "nameserver 10.0.0.1\n");
    expect(await readResolvers(join(dir, "resolv.conf"))).toEqual(["10.0.0.1"]);
    expect(await readResolvers(join(dir, "missing"))).toEqual([]);
  });
});

describe("F2 — a home of Mind's own, per vendor and subject", () => {
  test("the paths: under the state root, per subject — where erase looks — and the owner's credential", async () => {
    const owner = await temp();
    const env = { XDG_STATE_HOME: join(owner, "state") };
    const paths = cloudHomePaths(claude, claude.cloudHome!, SUBJECT, owner, env);
    expect(paths.home).toBe(join(owner, "state", "mind", "vendors", "claude", "subjects", "example"));
    expect(paths.home).toBe(cloudHomeDir({ home: owner, env }, "claude", SUBJECT));
    expect(paths.config).toBe(join(paths.home, ".claude"));
    expect(paths.credentialCopy).toBe(join(paths.home, ".claude", ".credentials.json"));
    expect(paths.ownerCredential).toBe(join(owner, ".claude", ".credentials.json"));
    // The owner's own CODEX_HOME is where the credential is found.
    const moved = cloudHomePaths(codex, codex.cloudHome!, SUBJECT, owner, { ...env, CODEX_HOME: "/elsewhere" });
    expect(moved.ownerCredential).toBe("/elsewhere/auth.json");
  });

  test("the environment inherits nothing but a CLI's basics and the vendor's login variables; the home is forced", () => {
    const cloud = codex.cloudHome!;
    const env = cloudEnvironment(cloud, { PATH: "/p", OPENAI_API_KEY: "k", AWS_SECRET_ACCESS_KEY: "nope", CODEX_API_KEY: "" });
    expect(env["PATH"]).toBe("/p");
    expect(env["OPENAI_API_KEY"]).toBe("k");
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(env["CODEX_API_KEY"]).toBeUndefined();
    expect(cloudEnvironment(cloud, {})["PATH"]).toBe("/usr/local/bin:/usr/bin:/bin");
    const paths = { home: "/h", config: "/h/.claude", tmp: "/h/tmp", credentialCopy: "", ownerCredential: "" };
    expect(cloudForcedEnvironment(claude.cloudHome!, paths)).toEqual({
      HOME: "/h",
      CLAUDE_CONFIG_DIR: "/h/.claude",
      TMPDIR: "/h/tmp",
      CLAUDE_CODE_TMPDIR: "/h/tmp",
      RES_OPTIONS: "use-vc",
    });
  });

  test("prepare: private directories and a fresh copy of the owner's credential; none when the owner has none", async () => {
    const owner = await temp();
    const paths = cloudHomePaths(codex, codex.cloudHome!, SUBJECT, owner, { XDG_STATE_HOME: join(owner, "state") });
    expect(await prepareCloudHome(paths)).toEqual({});
    await mkdir(join(owner, ".codex"), { recursive: true });
    await writeFile(paths.ownerCredential, '{"token":"one"}');
    const snapshot = await prepareCloudHome(paths);
    expect(snapshot.owner).toBe(snapshot.copy!);
    expect(await readFile(paths.credentialCopy, "utf8")).toBe('{"token":"one"}');
    expect((await stat(paths.credentialCopy)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.home)).mode & 0o777).toBe(0o700);
    // The owner's file wins over what an earlier turn left in the copy.
    await writeFile(paths.credentialCopy, '{"token":"stale"}');
    await prepareCloudHome(paths);
    expect(await readFile(paths.credentialCopy, "utf8")).toBe('{"token":"one"}');
    // A credential the owner removed is removed from the copy too.
    await rm(paths.ownerCredential);
    expect(await prepareCloudHome(paths)).toEqual({});
    expect(await stat(paths.credentialCopy).catch(() => "gone")).toBe("gone");
  });

  test("sync back: unchanged, synced, owner-changed, copy-unreadable — and the owner's newer login is never overwritten", async () => {
    const owner = await temp();
    const paths = cloudHomePaths(codex, codex.cloudHome!, SUBJECT, owner, { XDG_STATE_HOME: join(owner, "state") });
    expect(await syncCredentialBack(paths, {})).toBe("unchanged");
    await mkdir(join(owner, ".codex"), { recursive: true });
    await writeFile(paths.ownerCredential, '{"token":"one"}');
    let snapshot = await prepareCloudHome(paths);
    expect(await syncCredentialBack(paths, snapshot)).toBe("unchanged");

    await writeFile(paths.credentialCopy, '{"token":"refreshed"}');
    expect(await syncCredentialBack(paths, snapshot)).toBe("synced");
    expect(await readFile(paths.ownerCredential, "utf8")).toBe('{"token":"refreshed"}');
    expect((await stat(paths.ownerCredential)).mode & 0o777).toBe(0o600);

    snapshot = await prepareCloudHome(paths);
    await writeFile(paths.credentialCopy, '{"token":"turn"}');
    await writeFile(paths.ownerCredential, '{"token":"owner logged in again"}');
    expect(await syncCredentialBack(paths, snapshot)).toBe("owner-changed");
    expect(await readFile(paths.ownerCredential, "utf8")).toBe('{"token":"owner logged in again"}');

    snapshot = await prepareCloudHome(paths);
    await writeFile(paths.credentialCopy, '{"token":"cut sh');
    expect(await syncCredentialBack(paths, snapshot)).toBe("copy-unreadable");
    expect(await readFile(paths.ownerCredential, "utf8")).toBe('{"token":"owner logged in again"}');

    snapshot = await prepareCloudHome(paths);
    await rm(paths.credentialCopy);
    expect(await syncCredentialBack(paths, snapshot)).toBe("unchanged");

    expect(credentialSyncNote(codex, "owner-changed", paths)).toContain("yours was kept");
    expect(credentialSyncNote(codex, "copy-unreadable", paths)).toContain("was not touched");
    expect(credentialSyncNote(codex, "synced", paths)).toBeUndefined();
    expect(credentialSyncNote(codex, "unchanged", paths)).toBeUndefined();
  });

  test("identity: the turn's own text for a vendor with no flag, the owner's file when the turn carries none, else nothing", async () => {
    const owner = await temp();
    const env = { XDG_STATE_HOME: join(owner, "state") };
    const paths = cloudHomePaths(codex, codex.cloudHome!, SUBJECT, owner, env);
    await prepareCloudHome(paths);
    const file = join(paths.config, "AGENTS.md");
    await writeCloudIdentity(codex, codex.cloudHome!, paths, { system: "I am the soul" }, owner, env);
    expect(await readFile(file, "utf8")).toBe("I am the soul");
    await writeCloudIdentity(codex, codex.cloudHome!, paths, {}, owner, env);
    expect(await stat(file).catch(() => "gone")).toBe("gone");
    await mkdir(join(owner, ".codex"), { recursive: true });
    await writeFile(join(owner, ".codex", "AGENTS.md"), "applied by soul apply");
    await writeCloudIdentity(codex, codex.cloudHome!, paths, {}, owner, env);
    expect(await readFile(file, "utf8")).toBe("applied by soul apply");

    // claude carries the system text as a flag, so its file is left empty for such a turn.
    const claudePaths = cloudHomePaths(claude, claude.cloudHome!, SUBJECT, owner, env);
    await prepareCloudHome(claudePaths);
    await writeFile(join(claudePaths.config, "CLAUDE.md"), "left by an earlier turn");
    await writeCloudIdentity(claude, claude.cloudHome!, claudePaths, { system: "soul" }, owner, env);
    expect(await stat(join(claudePaths.config, "CLAUDE.md")).catch(() => "gone")).toBe("gone");
    // A vendor that declares no identity file is left alone.
    const { identityFile, ...without } = codex.cloudHome!;
    void identityFile;
    await writeCloudIdentity(codex, without, paths, { system: "x" }, owner, env);
    expect(await readFile(file, "utf8")).toBe("applied by soul apply");
  });
});

describe("what is said about it — derived, not written twice", () => {
  test("per vendor, and the limits, on a kernel with and without Landlock", () => {
    expect(cloudFenceSummary(claude, OK)).toBe("fenced at every level with a tool (level 1 has no tools and is not fenced)");
    expect(cloudFenceSummary(codex, OK)).toBe("fenced at every level with a tool");
    expect(cloudFenceSummary(codex, NO)).toContain("not fenced on this kernel (synthetic kernel without Landlock)");
    expect(cloudFenceSummary(vendor("kimi"), OK)).toBe("not fenced: no measured home and credential");
    const limits = cloudFenceLimits(VENDORS, OK);
    expect(limits[0]).toStartWith("claude, codex, grok run inside the kernel fence");
    expect(limits[1]).toStartWith("gemini, copilot, kimi are not fenced");
    expect(cloudFenceLimits(VENDORS, NO)[0]).toContain("Not on this kernel: synthetic kernel without Landlock");
    expect(cloudFenceLimits([claude], OK)).toHaveLength(1);
    expect(cloudFenceLimits([], OK)).toEqual([]);
  });

  test("readonlyLimits says 'can open any file you can open' only of the vendors that are not fenced", () => {
    const lines = readonlyLimits();
    const open = lines.find((line) => line.includes("can open any file you can open"))!;
    expect(open).toContain("gemini, copilot, kimi");
    expect(open).not.toContain("codex");
    expect(open).not.toContain("grok");
    const fenced = lines.find((line) => line.includes("D-192"))!;
    expect(fenced).toStartWith("codex, grok keep file-reading tools");
    expect(open).toContain("claude is started with no tools at all");
    // With only fenced vendors, the tool-free note moves to the fenced sentence; with none, there is none.
    const onlyFenced = readonlyLimits([claude, codex]);
    expect(onlyFenced.some((line) => line.includes("can open any file"))).toBe(false);
    expect(onlyFenced.find((line) => line.includes("D-192"))).toContain("claude is started with no tools at all");
    expect(readonlyLimits([vendor("kimi")]).some((line) => line.includes("D-192"))).toBe(false);
  });
});

describe("codex: the program behind the launcher, and the grant inside the fence", () => {
  test("the native binary npm's launcher would start, for this architecture, or nothing", () => {
    const root = "/n/lib/node_modules/@openai/codex";
    const native = `${root}/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`;
    expect(codexNativeProgram(`${root}/bin/codex.js`, "x64", (path) => path === native)).toEqual({
      path: native,
      env: { CODEX_MANAGED_PACKAGE_ROOT: root, CODEX_MANAGED_BY_NPM: "1" },
    });
    const vendored = `${root}/vendor/aarch64-unknown-linux-musl/bin/codex`;
    expect(codexNativeProgram(`${root}/bin/codex.js`, "arm64", (path) => path === vendored)?.path).toBe(vendored);
    expect(codexNativeProgram(`${root}/bin/codex.js`, "x64", () => false)).toBeUndefined();
    expect(codexNativeProgram(`${root}/bin/codex.js`, "ia32", () => true)).toBeUndefined();
    expect(codexNativeProgram("/usr/bin/codex", "x64", () => true)).toBeUndefined();
    expect(codex.cloudHome!.program!("/usr/bin/codex", "x64")).toBeUndefined();
  });

  test("level 2 in the fence is danger-full-access (the kernel is the box); unfenced it is what it was", () => {
    expect(grantArgs(CODEX_GRANT, LOOSENED, true)).toEqual(["--sandbox", "danger-full-access"]);
    expect(grantArgs(CODEX_GRANT, LOOSENED)).toEqual(["--sandbox", "workspace-write"]);
    expect(grantArgs(CODEX_GRANT, RESTRAINED, true)).toEqual([]);
    expect(codex.headlessArgv({ prompt: "p", restraint: LOOSENED, fenced: true })).toContain("danger-full-access");
    expect(codex.headlessArgv({ prompt: "p", restraint: LOOSENED })).toContain("workspace-write");
  });
});

/** A cloud vendor that is a shell script: it reports its environment and, when asked, refreshes its login. */
const FAKE = `#!/bin/sh
printf '%s\\n' "HOME=$HOME" "CODEX_HOME=$CODEX_HOME" "TMPDIR=$TMPDIR" "RES_OPTIONS=$RES_OPTIONS" "LEAK=$MIND_TEST_LEAK" "SUBJECT=$MIND_SUBJECT" "MANAGED=$FAKE_MANAGED" "PATH=$PATH"
[ -f "$CODEX_HOME/AGENTS.md" ] && printf 'IDENTITY=%s\\n' "$(cat "$CODEX_HOME/AGENTS.md")"
case "$1" in refresh) printf '{"token":"refreshed"}' > "$CODEX_HOME/auth.json" ;; esac
exit 0
`;

function withoutProgram(cloud: CloudHomeSpec): CloudHomeSpec {
  const { program, ...rest } = cloud;
  void program;
  return rest;
}

async function fakeVendor(extra: Partial<CloudHomeSpec> = {}): Promise<{ readonly spec: VendorSpec; readonly bin: string; readonly owner: string }> {
  const root = await temp();
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "fake-cloud"), FAKE);
  await chmod(join(bin, "fake-cloud"), 0o755);
  const owner = join(root, "owner");
  await mkdir(join(owner, ".codex"), { recursive: true });
  await writeFile(join(owner, ".codex", "auth.json"), '{"token":"one"}');
  const spec: VendorSpec = {
    ...codex,
    binary: "fake-cloud",
    hardening: { args: [], why: "none" },
    headlessArgv: ({ prompt }) => [prompt],
    usage: null,
    cloudHome: { ...withoutProgram(codex.cloudHome!), ...extra },
  };
  return { spec, bin, owner };
}

describe("CliExec — a cloud turn through the fence seam", () => {
  test("fenced: the policy the kernel gets, a forced home, no inherited secret, the identity, and a refreshed login sent back", async () => {
    const { spec, bin, owner } = await fakeVendor();
    const policies: FencePolicy[] = [];
    const resolv = join(owner, "resolv.conf");
    await writeFile(resolv, "nameserver 127.0.0.53\n");
    const exec = new CliExec(spec, { support: () => OK, argv: (argv, policy) => (policies.push(policy), [...argv]) }, {
      cloud: { home: owner, env: { PATH: `${bin}:/usr/bin:/bin`, XDG_STATE_HOME: join(owner, "state"), MIND_TEST_LEAK: "secret" }, resolvConf: resolv },
    });
    const work = join(owner, "work");
    await mkdir(work);
    const request = { restraint: LOOSENED, subject: SUBJECT, prompt: "refresh", cwd: work, system: "the soul", env: { HOME: "/caller/home", CODEX_HOME: "/caller/codex" } };
    expect(exec.appliesFence(request)).toBe(true);
    expect(exec.fenceNotice(request)).toBeUndefined();
    const result = await exec.run(request);
    expect(result.confidence).toBe("confirmed");
    const home = join(owner, "state", "mind", "vendors", "codex", "subjects", "example");
    expect(result.text).toContain(`HOME=${home}`);
    expect(result.text).toContain(`CODEX_HOME=${home}/.codex`);
    expect(result.text).toContain(`TMPDIR=${home}/tmp`);
    expect(result.text).toContain("RES_OPTIONS=use-vc");
    expect(result.text).toContain("LEAK=\n");
    expect(result.text).toContain("SUBJECT=example");
    expect(result.text).toContain("IDENTITY=the soul");
    expect(policies).toEqual([
      { writable: [home, work], tcpPorts: [], remotePorts: [443], resolvers: ["127.0.0.53"], readable: [resolv] },
    ]);
    expect(result.unfenced).toBeUndefined();
    expect(result.login).toBeUndefined();
    // The caller aimed the turn at /caller/codex, which has no credential: nothing was copied, nothing goes back.
    expect(await readFile(join(owner, ".codex", "auth.json"), "utf8")).toBe('{"token":"one"}');

    // Aimed at the owner's own home, the refreshed login goes back to the owner's file.
    const second = await exec.run({ ...request, env: {} });
    expect(second.confidence).toBe("confirmed");
    expect(await readFile(join(owner, ".codex", "auth.json"), "utf8")).toBe('{"token":"refreshed"}');
  });

  test("a launcher is replaced by the program behind it, with the launcher's variables", async () => {
    const { spec, bin, owner } = await fakeVendor({
      program: (launcher) => ({ path: launcher, env: { FAKE_MANAGED: "yes" } }),
    });
    const exec = new CliExec(spec, { support: () => OK, argv: (argv) => [...argv] }, {
      cloud: { home: owner, env: { PATH: `${bin}:/usr/bin:/bin`, XDG_STATE_HOME: join(owner, "state") }, resolvConf: join(owner, "none") },
    });
    const result = await exec.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "hi", cwd: owner });
    expect(result.text).toContain("MANAGED=yes");
  });

  test("scope machine (S22.8) is refused where the fence is not in force, and handed its grants where it is", async () => {
    const { spec, bin, owner } = await fakeVendor();
    const request = { restraint: LOOSENED, subject: SUBJECT, prompt: "hi", cwd: owner, machine: { grants: ["/data"], home: owner, redLines: [] } };
    const original = process.env["PATH"];
    process.env["PATH"] = `${bin}:${original ?? ""}`;
    try {
      // No Landlock: the turn would run as the owner with the red lines unheld, so it does not start.
      let built = false;
      const bare = new CliExec(spec, { support: () => NO, argv: (argv) => ((built = true), [...argv]) }, { cloud: { home: owner, env: { XDG_STATE_HOME: join(owner, "state") } } });
      const refused = await bare.run(request);
      // Not "failed": a refusal that sent nothing is a miss like any other (`nothingRan`), and the chain moves on.
      expect(refused.confidence).toBe("silent");
      expect(refused.text + String(refused.evidence.raw)).toContain("scope machine needs this turn inside the cloud fence");
      expect(built).toBe(false);
      // A vendor whose home was never measured is refused the same way.
      const { spec: unmeasured } = await fakeVendor();
      const { cloudHome: _measured, ...withoutHome } = unmeasured;
      const loose = new CliExec(withoutHome, { support: () => OK, argv: (argv) => [...argv] }, { cloud: { home: owner, env: { XDG_STATE_HOME: join(owner, "state") } } });
      const refusedUnmeasured = await loose.run(request);
      expect(refusedUnmeasured.text + String(refusedUnmeasured.evidence.raw)).toContain("(unmeasured)");
      // Fenced: the policy the fence is built from carries the grants and not the working directory.
      const policies: FencePolicy[] = [];
      const fenced = new CliExec(spec, { support: () => OK, argv: (argv, policy) => (policies.push(policy), [...argv]) }, { cloud: { home: owner, env: { PATH: `${bin}:/usr/bin:/bin`, XDG_STATE_HOME: join(owner, "state") } } });
      const result = await fenced.run(request);
      expect(policies).toHaveLength(1);
      expect(policies[0]!.writable).toContain("/data");
      expect(policies[0]!.writable).not.toContain(owner);
      const shim = policies[0]!.readable?.find((path) => path.includes("mind-delete-tripwire-"));
      expect(shim).toBeDefined();
      expect(result.text).toContain(`PATH=${shim}:`);
    } finally {
      process.env["PATH"] = original;
    }
  });

  test("F4: no Landlock — the turn runs unfenced, inherits as before, and carries the notice", async () => {
    const { spec, bin, owner } = await fakeVendor();
    let built = false;
    const exec = new CliExec(spec, { support: () => NO, argv: (argv) => ((built = true), [...argv]) }, {
      cloud: { home: owner, env: { XDG_STATE_HOME: join(owner, "state") } },
    });
    const original = process.env["PATH"];
    process.env["PATH"] = `${bin}:${original ?? ""}`;
    try {
      const request = { restraint: RESTRAINED, subject: SUBJECT, prompt: "hi", cwd: owner, env: { HOME: owner } };
      expect(exec.appliesFence(request)).toBe(false);
      expect(exec.fenceNotice(request)).toContain("synthetic kernel without Landlock");
      const result = await exec.run(request);
      expect(result.confidence).toBe("confirmed");
      expect(built).toBe(false);
      expect(result.text).toContain(`HOME=${owner}`);
      expect(result.unfenced).toContain("no kernel fence is in force for this codex turn");
    } finally {
      process.env["PATH"] = original;
    }
  });

  test("a home that cannot be made stops the turn rather than run it unfenced", async () => {
    const { spec, owner } = await fakeVendor();
    await writeFile(join(owner, "state"), "a file where the state directory should be");
    const exec = new CliExec(spec, { support: () => OK, argv: (argv) => [...argv] }, {
      cloud: { home: owner, env: { XDG_STATE_HOME: join(owner, "state") } },
    });
    const result = await exec.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "hi", cwd: owner });
    expect(result.confidence).toBe("silent");
    expect(result.evidence.raw).toContain("could not be prepared");
  });

  test("a login that cannot be written back is said, and the owner's file is unchanged", async () => {
    const { spec, bin, owner } = await fakeVendor();
    const exec = new CliExec(spec, { support: () => OK, argv: (argv) => [...argv] }, {
      cloud: { home: owner, env: { PATH: `${bin}:/usr/bin:/bin`, XDG_STATE_HOME: join(owner, "state") }, resolvConf: join(owner, "none") },
    });
    // The owner's directory is read-only: the temporary file beside the credential cannot be made.
    await chmod(join(owner, ".codex"), 0o500);
    try {
      const result = await exec.run({ restraint: RESTRAINED, subject: SUBJECT, prompt: "refresh", cwd: owner });
      expect(result.login).toContain("could not be written back");
    } finally {
      await chmod(join(owner, ".codex"), 0o700);
    }
    expect(await readFile(join(owner, ".codex", "auth.json"), "utf8")).toBe('{"token":"one"}');
  });
});

describe("the D-163 cap, now that a cloud turn can be fenced", () => {
  test("a fenced cloud vendor keeps the dial; an unmeasured one, or any on a kernel without Landlock, is capped", () => {
    const request = { restraint: LOOSENED, subject: SUBJECT, prompt: "" };
    for (const spec of VENDORS) {
      const onLandlock = new CliExec(spec, { support: () => OK, argv: (argv) => [...argv] });
      const fenced = spec.cloudHome !== undefined;
      expect(capRequest(onLandlock, request).note === undefined).toBe(fenced);
      expect(capRequest(new CliExec(spec, { support: () => NO, argv: (argv) => [...argv] }), request).note).toBeDefined();
    }
  });

  test("the wrapper says the F4 notice before the turn and the cap after it, about the request it really sends", async () => {
    const said: string[] = [];
    const inner = new CliExec(vendor("kimi"), { support: () => NO, argv: (argv) => [...argv] });
    const exec = new CappedExec(Object.assign(Object.create(inner) as CliExec, {
      run: async () => ({ backend: "kimi", text: "", confidence: "silent" as const, identityStrength: "none" as const, evidence: { source: "kimi", prompt: "", raw: "" } }),
    }), (line) => said.push(line));
    await exec.run({ restraint: LOOSENED, subject: SUBJECT, prompt: "" });
    expect(said[0]).toContain("no kernel fence is in force for this kimi turn");
    expect(said[1]).toContain("held at write 1");
  });
});
