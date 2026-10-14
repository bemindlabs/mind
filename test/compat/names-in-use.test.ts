/**
 * The names Mind uses where a file, a script or a container is concerned: the macOS build reads `MIND_*` signing
 * variables only and installs the one command, `postinstall` skips setup on `MIND_NO_SETUP` only, the browser
 * container releases on the `mind-release` prefix and the `mind/held-action@1` schema, and the parity harness
 * names its work directory and its recordings for Mind.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addedCase, normalise, stepStreams, workspaceFor } from "../../scripts/cli-parity.ts";
import { VERSION } from "../../src/version.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BUILD = join(ROOT, "packaging", "macos", "build-pkg.sh");
const POSTINSTALL = join(ROOT, "packaging", "macos", "scripts", "postinstall");

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function scratchDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `mind-names-in-use-${label}-`));
  scratch.push(dir);
  return dir;
}

/** The name of one packaging variable. */
const newVar = (suffix: string) => `MIND_${suffix}`;
const APP = "APP_IDENTITY";
const INSTALLER = "INSTALLER_IDENTITY";
const NOTARY = "NOTARY_PROFILE";

/** Tools that exist only on a Mac, as shell scripts that log what they were asked and do nothing. */
async function fakeMac(): Promise<{ bin: string; log: string; arm64: string; x64: string }> {
  const dir = await scratchDir("mac");
  const bin = join(dir, "bin");
  await mkdir(bin);
  const logging = [
    "#!/bin/sh",
    'printf \'%s\' "$(basename "$0")" >> "$LOG"',
    'for a in "$@"; do printf \' [%s]\' "$a" >> "$LOG"; done',
    "printf '\\n' >> \"$LOG\"",
    "",
  ].join("\n");
  const tools: Record<string, string> = {
    uname: "#!/bin/sh\necho Darwin\n",
    // `lipo -create a b -output OUT` makes a program that reports the version, as the real binary does.
    lipo: [
      "#!/bin/sh",
      'out=""',
      'while [ $# -gt 0 ]; do if [ "$1" = "-output" ]; then out="$2"; fi; shift; done',
      "printf '#!/bin/sh\\necho %s\\n' \"$VERSION\" > \"$out\"",
      "",
    ].join("\n"),
    codesign: logging,
    productbuild: logging,
    xcrun: logging,
    // `pkgbuild` also records what the package root holds, so a test can say which names would be installed.
    pkgbuild: `${logging}while [ $# -gt 0 ]; do if [ "$1" = "--root" ]; then ls -A "$2/usr/local/bin" > "$LOG.root"; fi; shift; done\n`,
  };
  for (const [name, body] of Object.entries(tools)) {
    await writeFile(join(bin, name), body);
    await chmod(join(bin, name), 0o755);
  }
  const arm64 = join(dir, "arm64");
  const x64 = join(dir, "x64");
  await writeFile(arm64, "");
  await writeFile(x64, "");
  return { bin, log: join(dir, "log"), arm64, x64 };
}

async function runBuild(vars: Record<string, string>) {
  const mac = await fakeMac();
  const child = Bun.spawn(["bash", BUILD, "--arm64", mac.arm64, "--x64", mac.x64], {
    env: { PATH: `${mac.bin}:${process.env["PATH"] ?? ""}`, LOG: mac.log, VERSION, ...vars },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  const stdout = await new Response(child.stdout).text();
  await child.exited;
  const log = existsSync(mac.log) ? await readFile(mac.log, "utf8") : "";
  const root = existsSync(`${mac.log}.root`) ? await readFile(`${mac.log}.root`, "utf8") : "";
  return { code: child.exitCode ?? -1, stderr, stdout, log, root };
}

describe("the macOS build reads its signing variables under the MIND_ prefix", () => {
  const VALUES = { [APP]: "Developer ID Application: A", [INSTALLER]: "Developer ID Installer: I", [NOTARY]: "profile-n" };

  /** The signing calls the fake tools saw. */
  function signedWith(log: string): string[] {
    return [
      log.includes("[--sign] [Developer ID Application: A]") ? "app" : "",
      log.includes("[--sign] [Developer ID Installer: I]") ? "installer" : "",
      log.includes("[--keychain-profile] [profile-n]") ? "notary" : "",
    ].filter(Boolean);
  }

  test("the MIND_ names sign, notarize, and say nothing on stderr", async () => {
    const r = await runBuild(Object.fromEntries(Object.entries(VALUES).map(([k, v]) => [newVar(k), v])));
    expect(r.code).toBe(0);
    expect(signedWith(r.log)).toEqual(["app", "installer", "notary"]);
    expect(r.stderr).toBe("");
  });

  test("a variable under another prefix is not read: with none of the MIND_ ones, the binary is signed ad hoc", async () => {
    const r = await runBuild({ APP_IDENTITY: VALUES[APP], INSTALLER_IDENTITY: VALUES[INSTALLER], NOTARY_PROFILE: VALUES[NOTARY] });
    expect(r.code).toBe(0);
    expect(signedWith(r.log)).toEqual([]);
    expect(r.log).toContain("codesign [--force] [--sign] [-]");
    expect(r.stdout).toContain("unsigned");
  });

  test("what it builds is named for Mind, and installs the one command and no other name", async () => {
    const r = await runBuild({});
    expect(r.code).toBe(0);
    expect(r.log).toContain("[--identifier] [com.bemindlabs.mind]");
    expect(r.log).toMatch(/pkgbuild .*\[[^\]]*\/mind-component\.pkg\]/);
    expect(r.log).toMatch(new RegExp(`productbuild .*\\[[^\\]]*/dist/mind-${VERSION.replaceAll(".", "\\.")}\\.pkg\\]`));
    expect(r.root).toBe("mind\n");
  });
});

describe("postinstall: the offer to skip is under MIND_NO_SETUP", () => {
  /** `postinstall` with a console user present, the way the installer runs it, and what `launchctl` was asked. */
  async function runPostinstall(vars: Record<string, string>): Promise<boolean> {
    const dir = await scratchDir("post");
    const bin = join(dir, "bin");
    await mkdir(bin);
    const log = join(dir, "log");
    const fakes: Record<string, string> = {
      stat: "#!/bin/sh\necho alice\n",
      id: "#!/bin/sh\necho 501\n",
      launchctl: '#!/bin/sh\necho "$@" >> "$LOG"\n',
    };
    for (const [name, body] of Object.entries(fakes)) {
      await writeFile(join(bin, name), body);
      await chmod(join(bin, name), 0o755);
    }
    const child = Bun.spawn(["bash", POSTINSTALL], {
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, LOG: log, ...vars },
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
    expect(child.exitCode).toBe(0);
    return existsSync(log);
  }

  test("without it, setup is offered; with MIND_NO_SETUP, it is not", async () => {
    expect(await runPostinstall({})).toBe(true);
    expect(await runPostinstall({ MIND_NO_SETUP: "1" })).toBe(false);
  });

  test("a variable under another prefix does not skip it", async () => {
    expect(await runPostinstall({ NO_SETUP: "1" })).toBe(true);
  });
});

describe("the browser container releases on the mind-release prefix and the mind schema", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const release = require("../../docker/browser/release.cjs") as {
    SCHEMA: string;
    releaseMessage: (id: string, digest: string, verdict: string) => Buffer;
    verifyRelease: (publicKey: string, id: string, digest: string, verdict: string, sig: string) => boolean;
    waitForRelease: (action: object, classification: object, settings: object, io: object) => Promise<{ verdict: string }>;
  };
  const pair = generateKeyPairSync("ed25519");
  const PUBLIC = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const signed = (prefix: string, id: string, digest: string, verdict: string) =>
    sign(null, Buffer.from(`${prefix}\n${id}\n${digest}\n${verdict}`), pair.privateKey).toString("base64");

  test("a release signed over the mind-release prefix verifies, and one signed over another does not", () => {
    expect(release.releaseMessage("a-1", "sha256:x", "approve").toString()).toStartWith("mind-release\n");
    expect(release.verifyRelease(PUBLIC, "a-1", "sha256:x", "approve", signed("mind-release", "a-1", "sha256:x", "approve"))).toBe(true);
    expect(release.verifyRelease(PUBLIC, "a-1", "sha256:x", "approve", signed("other-release", "a-1", "sha256:x", "approve"))).toBe(false);
  });

  test("the pending file it writes carries the new schema id", async () => {
    expect(release.SCHEMA).toBe("mind/held-action@1");
    let clock = 0;
    const written: string[] = [];
    const out = await release.waitForRelease(
      { kind: "click", origin: "http://x.example", role: "button", text: "Go" },
      { rules: ["r"], categories: [], reasons: ["r"] },
      { waitSeconds: 1, publicKey: PUBLIC },
      {
        now: () => clock,
        sleep: async (ms: number) => void (clock += ms),
        write: (_path: string, text: string) => void written.push(text),
        exists: () => false,
        read: () => "",
        rename: () => undefined,
        log: () => undefined,
        id: () => "11111111-2222-4333-8444-555555555555",
      },
    );
    expect(out.verdict).toBe("expired");
    expect(JSON.parse(written[0]!).schema).toBe(release.SCHEMA);
  });
});

describe("the parity harness", () => {
  test("its work directory is named for Mind", () => {
    expect(workspaceFor("/a/one")).toStartWith("/tmp/mind-parity-");
  });

  test("the mkdtemp tail is cut", () => {
    const { text, counts } = normalise("/tmp/mind-erase-Xk92mQ4a/cert.txt");
    expect(text).toBe("/tmp/mind-erase-<rand>/cert.txt");
    expect(counts.get("mkdtemp")).toBe(1);
  });

  test("a recording reads back: the steps' streams and an added case", () => {
    const recording = [
      "# 15-autonomy",
      "",
      "## step 0 — mind autonomy something",
      "exit: 2",
      "stdout:",
      "  | ",
      "stderr:",
      '  | mind: unknown command "autonomy"',
      "",
      "## sandbox",
      "  dir cwd",
    ];
    expect(stepStreams(recording).size).toBe(1);
    expect(addedCase("15-autonomy.txt", recording.join("\n"))).toMatchObject({ steps: 1, refusals: 1 });
  });
});

describe("the macOS pages", () => {
  test("name the one command and no alias, and the build script reads what package.json builds", async () => {
    for (const page of ["welcome.html", "conclusion.html"]) {
      const html = await readFile(join(ROOT, "packaging", "macos", "resources", page), "utf8");
      const names = [...html.matchAll(/\/usr\/local\/bin\/[a-z-]+/g)].map((m) => m[0]);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).toBe("/usr/local/bin/mind");
    }
    const conclusion = await readFile(join(ROOT, "packaging", "macos", "resources", "conclusion.html"), "utf8");
    expect(conclusion).toContain("pkgutil --forget com.bemindlabs.mind");
    const scripts = ((await Bun.file(join(ROOT, "package.json")).json()) as { scripts: Record<string, string> }).scripts;
    const built = [...scripts["build:macos"]!.matchAll(/--outfile dist\/(mind-darwin-[a-z0-9]+)/g)].map((m) => m[1]);
    expect(built).toEqual(["mind-darwin-arm64", "mind-darwin-x64"]);
    const build = await readFile(BUILD, "utf8");
    for (const name of built) expect(build).toContain(`dist/${name}`);
  });
});
