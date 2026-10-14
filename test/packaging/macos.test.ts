/**
 * D-056 — the macOS installer, checked from a machine that cannot build it.
 *
 * `pkgbuild` and `productbuild` exist only on macOS, so the package itself is
 * built and proved on a Mac (`packaging/macos/build-pkg.sh`). What is checked
 * here is everything that does not need one: both scripts parse, the build
 * refuses to pretend on another OS, the postinstall never fails an install,
 * and the files the distribution names are the files the build puts there.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MAC = join(ROOT, "packaging", "macos");
const BUILD = join(MAC, "build-pkg.sh");
const POSTINSTALL = join(MAC, "scripts", "postinstall");

async function run(argv: readonly string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([...argv], { env: { PATH: process.env["PATH"] ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  return { code: child.exitCode ?? -1, stderr };
}

describe("the macOS installer", () => {
  test("both scripts parse", async () => {
    expect((await run(["bash", "-n", BUILD])).code).toBe(0);
    expect((await run(["bash", "-n", POSTINSTALL])).code).toBe(0);
  });

  test.skipIf(process.platform === "darwin")("the build refuses off macOS instead of producing something half-made", async () => {
    const result = await run(["bash", BUILD]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("run this on a Mac");
  });

  test.skipIf(process.platform === "darwin")("postinstall exits 0 with no console user, and when told to skip", async () => {
    expect((await run(["bash", POSTINSTALL])).code).toBe(0);
    expect((await run(["bash", POSTINSTALL], { MIND_NO_SETUP: "1" })).code).toBe(0);
  });

  test("the distribution names only files the build provides", async () => {
    const xml = await Bun.file(join(MAC, "distribution.xml")).text();
    const build = await Bun.file(BUILD).text();
    expect(xml).toContain('<welcome file="welcome.html"');
    expect(xml).toContain('<conclusion file="conclusion.html"');
    expect(xml).toContain('<license file="LICENSE.txt"');
    for (const page of ["welcome.html", "conclusion.html"]) expect(await Bun.file(join(MAC, "resources", page)).exists()).toBe(true);
    expect(build).toContain('cp "$root/LICENSE" "$work/resources/LICENSE.txt"');
    expect(await Bun.file(join(ROOT, "LICENSE")).exists()).toBe(true);
    // The component the distribution refers to is the one pkgbuild writes, under one identifier.
    expect(xml).toContain(">mind-component.pkg</pkg-ref>");
    expect(build).toContain('"$work/mind-component.pkg"');
    expect(build).toContain("--identifier com.bemindlabs.mind");
    expect(xml.match(/com\.bemindlabs\.mind/g)?.length).toBe(4);
    expect(xml).toContain("@VERSION@");
  });

  test("it installs the program and nothing that runs in the background", async () => {
    const build = await Bun.file(BUILD).text();
    const post = await Bun.file(POSTINSTALL).text();
    for (const text of [build, post]) {
      expect(text).not.toMatch(/LaunchAgents|LaunchDaemons|launchctl load|launchctl bootstrap/);
    }
    // Setup is offered to the console user, never answered for them.
    expect(post).toContain('do script "/usr/local/bin/mind setup"');
    expect(post).not.toMatch(/mind (autonomy|observe)/);
  });

  test("build:macos cross-compiles both architectures the build expects", async () => {
    const scripts = ((await Bun.file(join(ROOT, "package.json")).json()) as { scripts: Record<string, string> }).scripts;
    expect(scripts["build:macos"]).toContain("--target=bun-darwin-arm64 --outfile dist/mind-darwin-arm64");
    expect(scripts["build:macos"]).toContain("--target=bun-darwin-x64 --outfile dist/mind-darwin-x64");
    const build = await Bun.file(BUILD).text();
    expect(build).toContain('arm64="$root/dist/mind-darwin-arm64"');
    expect(build).toContain('x64="$root/dist/mind-darwin-x64"');
  });
});
