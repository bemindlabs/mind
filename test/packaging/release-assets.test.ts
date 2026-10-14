/**
 * The release (n5): what `scripts/release-assets.sh` makes of a dist directory (run here, on fake binaries — nothing
 * is built, signed or published), and the shape of `.github/workflows/release.yml` (what it runs on, what it may
 * touch, that it uses no secret).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "release-assets.sh");
const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

async function dist(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "mind-dist-"));
  scratch.push(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

async function run(dir: string) {
  const child = Bun.spawn(["sh", SCRIPT, dir], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  return { code: child.exitCode ?? -1, stdout, stderr };
}

describe("scripts/release-assets.sh", () => {
  test("one SHA256SUMS lists every binary and install.sh, and nothing else is added", async () => {
    const dir = await dist({ "mind-linux-x64": "X64 BYTES", "mind-linux-arm64": "ARM BYTES", "install.sh": "#!/bin/sh\n" });
    const r = await run(dir);
    expect(r.code, r.stderr).toBe(0);
    expect((await readdir(dir)).sort()).toEqual(
      ["SHA256SUMS", "install.sh", "mind-linux-arm64", "mind-linux-x64"].sort(),
    );
    const sums = (await readFile(join(dir, "SHA256SUMS"), "utf8")).trim().split("\n");
    expect(sums).toEqual([
      `${sha("ARM BYTES")}  mind-linux-arm64`,
      `${sha("X64 BYTES")}  mind-linux-x64`,
      `${sha("#!/bin/sh\n")}  install.sh`,
    ]);
  });

  test("the lines are what `mind update` and install.sh read", async () => {
    const dir = await dist({ "mind-linux-x64": "B" });
    expect((await run(dir)).code).toBe(0);
    const { sumFor } = await import("../../src/update/version.ts");
    const sums = await readFile(join(dir, "SHA256SUMS"), "utf8");
    expect(sumFor(sums, "mind-linux-x64")).toBe(sha("B"));
  });

  test("running it again changes nothing (one release per tag, rerunnable)", async () => {
    const dir = await dist({ "mind-linux-x64": "B" });
    await run(dir);
    const first = await readFile(join(dir, "SHA256SUMS"), "utf8");
    expect((await run(dir)).code).toBe(0);
    expect(await readFile(join(dir, "SHA256SUMS"), "utf8")).toBe(first);
  });

  test("no directory, no binary, an empty binary, or a file with another name is refused", async () => {
    expect((await run("/nonexistent-dir")).code).toBe(2);
    expect((await run(await dist({ "install.sh": "x" }))).stderr).toContain("no mind-<os>-<arch> binary");
    expect((await run(await dist({ "mind-linux-x64": "" }))).stderr).toContain("is empty");
    const odd = await run(await dist({ "mind-linux-x64": "B", "mind-windows-x64": "B" }));
    expect(odd.code).toBe(1);
    expect(odd.stderr).toContain("mind-windows-x64 is not");
  });
});

type Step = { uses?: string; run?: string; name?: string; with?: Record<string, unknown> };
type Job = { needs?: string | string[]; permissions?: Record<string, string>; steps: Step[]; strategy?: unknown };
const workflow = async (name: string) => Bun.YAML.parse(await readFile(join(ROOT, ".github", "workflows", name), "utf8")) as { on: { push: { tags?: string[]; branches?: string[] } }; permissions: Record<string, string>; jobs: Record<string, Job> };
const needs = (job: Job) => (job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]);

/** What each action's tag resolved to on 2026-10-12 (`gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, annotated tags dereferenced). */
const PINS: Record<string, string> = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "oven-sh/setup-bun": "0c5077e51419868618aeaa5fe8019c62421857d6",
  "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "anchore/sbom-action": "e22c389904149dbc22b58101806040fa8d37a610",
  "sigstore/cosign-installer": "398d4b0eeef1380460a10c8013a76f728fb906ac",
};

describe(".github/workflows/release.yml", () => {
  test("it runs only on a pushed v* tag, never on a branch or a pull request", async () => {
    const wf = await workflow("release.yml");
    expect(wf.on).toEqual({ push: { tags: ["v*"] } });
  });

  test("it fails unless the tagged commit is on main, before anything else is built", async () => {
    const wf = await workflow("release.yml");
    const gate = wf.jobs["gates"]!.steps.find((step) => step.run?.includes("merge-base --is-ancestor"));
    expect(gate?.run).toContain('git fetch origin main');
    expect(gate?.run).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    for (const job of ["build", "sbom"]) expect(needs(wf.jobs[job]!)).toContain("gates");
  });

  test("the job graph: gates, then build and sbom, then assets (checksums include the SBOM), then sign, then publish", async () => {
    const wf = await workflow("release.yml");
    expect(Object.keys(wf.jobs).sort()).toEqual(["assets", "build", "gates", "publish", "sbom", "sign"]);
    expect(needs(wf.jobs["assets"]!).sort()).toEqual(["build", "sbom"]);
    expect(needs(wf.jobs["sign"]!)).toEqual(["assets"]);
    expect(needs(wf.jobs["publish"]!)).toEqual(["sign"]);
    for (const gate of ["bun run typecheck", "bun test", "bun run coverage"]) expect(wf.jobs["gates"]!.steps.some((step) => step.run === gate), gate).toBe(true);
  });

  test("the powerful permissions are on small jobs: id-token only on sign, contents: write only on publish, the rest read", async () => {
    const wf = await workflow("release.yml");
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const [name, job] of Object.entries(wf.jobs)) {
      const perms = job.permissions ?? wf.permissions;
      if (name === "sign") expect(perms).toEqual({ "id-token": "write", contents: "read" });
      else if (name === "publish") expect(perms).toEqual({ contents: "write" });
      else expect(perms, name).toEqual({ contents: "read" });
    }
  });

  test("sign holds nothing but the download, the cosign installer, sha256sum and cosign, and uploads the signature", async () => {
    const steps = (await workflow("release.yml")).jobs["sign"]!.steps;
    const uses = steps.filter((step) => step.uses !== undefined).map((step) => step.uses!.split("@")[0]);
    expect(uses).toEqual(["actions/download-artifact", "sigstore/cosign-installer", "actions/upload-artifact"]);
    const runs = steps.filter((step) => step.run !== undefined).map((step) => step.run!);
    expect(runs).toEqual(["sha256sum -c SHA256SUMS", "cosign sign-blob --yes --output-signature SHA256SUMS.sig --output-certificate SHA256SUMS.pem SHA256SUMS"]);
  });

  test("publish never overwrites: no --clobber, and a release that already has assets fails the job", async () => {
    const wf = await workflow("release.yml");
    const run = wf.jobs["publish"]!.steps.map((step) => step.run ?? "").join("\n");
    expect(run).not.toContain("--clobber");
    expect(run).toContain("--json assets --jq '.assets | length'");
    expect(run).toContain('[ "$n" = 0 ] || {');
    expect(run).toContain("exit 1");
    expect(run).toContain('gh release create "$tag"');
    expect(run).toContain('case "$tag" in *-*) flag="--prerelease" ;; esac');
  });

  test("no secret of the repository: no secrets context, no key file, signing is keyless", async () => {
    const yml = await readFile(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    const code = yml.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/\$\{\{\s*secrets\./);
    expect(code).not.toMatch(/--key\b|COSIGN_PRIVATE_KEY|COSIGN_PASSWORD|\.secrets/);
  });

  test("it builds linux x64 and arm64 and no macOS (that needs the owner's signing identity), and names assets with the script", async () => {
    const yml = await readFile(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    const code = yml.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    expect(code).toContain("platform: linux-x64");
    expect(code).toContain("platform: linux-arm64");
    expect(code).not.toMatch(/darwin|macos-/);
    expect(code).toContain("sh scripts/release-assets.sh dist");
  });

  test("the SBOM is made on the source tree before the checksums, and the sums list it", async () => {
    const wf = await workflow("release.yml");
    const sbom = wf.jobs["sbom"]!.steps.find((step) => step.uses?.startsWith("anchore/sbom-action"));
    expect(sbom?.with?.["path"]).toBe(".");
    expect(sbom?.with?.["output-file"]).toBe("mind-sbom.spdx.json");
    const dir = await dist({ "mind-linux-x64": "B", "mind-sbom.spdx.json": "{}" });
    expect((await run(dir)).code).toBe(0);
    expect(await readFile(join(dir, "SHA256SUMS"), "utf8")).toContain(`${sha("{}")}  mind-sbom.spdx.json`);
  });
});

describe("the tag rule is the one install.sh holds, and publish checks the sums before it uploads", () => {
  const RULE = String.raw`^v[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$`;

  test("install.sh and the workflow carry the same regexp, and it refuses what it should", async () => {
    const script = await readFile(join(ROOT, "install.sh"), "utf8");
    const wf = await workflow("release.yml");
    const gate = wf.jobs["gates"]!.steps.find((step) => step.run?.includes("is not vX.Y.Z[-suffix]"));
    expect(script).toContain(`grep -Eq '${RULE}'`);
    expect(gate?.run).toContain(`grep -Eq '${RULE}'`);
    expect(wf.jobs["gates"]!.steps[0]).toBe(gate);
    const re = new RegExp(RULE);
    for (const good of ["v0.11.0", "v1.2.3-alpha", "v0.10.2-alpha.1", "v1.0.0+build.5"]) expect(re.test(good), good).toBe(true);
    for (const bad of ["vfoo", "v1.2", "1.2.3", "v1.2.3;x", "v1/../x", "latest", "v1.2.3 "]) {
      const charsetOk = !/[^0-9A-Za-z.+-]/.test(bad);
      expect(charsetOk && re.test(bad), bad).toBe(false);
    }
  });

  test("the gates step actually refuses vfoo when run", async () => {
    const wf = await workflow("release.yml");
    const gate = wf.jobs["gates"]!.steps[0]!;
    for (const [tag, code] of [["vfoo", 1], ["v1.2.3", 0], ["v1.2.3/x", 1]] as const) {
      const child = Bun.spawn(["sh", "-c", gate.run!], { env: { PATH: process.env["PATH"] ?? "", GITHUB_REF_NAME: tag }, stdout: "pipe", stderr: "pipe" });
      await child.exited;
      expect(child.exitCode, tag).toBe(code);
    }
  });

  test("publish runs sha256sum -c SHA256SUMS after the artifacts are merged and before any upload or create", async () => {
    const steps = (await workflow("release.yml")).jobs["publish"]!.steps;
    const check = steps.findIndex((step) => step.run === "sha256sum -c SHA256SUMS");
    const upload = steps.findIndex((step) => step.run?.includes("gh release"));
    const download = steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact"));
    expect(download).toBeLessThan(check);
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(upload);
    expect(steps[check]!["working-directory" as keyof Step]).toBe("dist");
  });

  test("a changed file fails that check: the same command on a fake dist", async () => {
    const dir = await dist({ "mind-linux-x64": "B" });
    expect((await run(dir)).code).toBe(0);
    const ok = Bun.spawn(["sh", "-c", "sha256sum -c SHA256SUMS"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await ok.exited;
    expect(ok.exitCode).toBe(0);
    await writeFile(join(dir, "mind-linux-x64"), "TAMPERED");
    const bad = Bun.spawn(["sh", "-c", "sha256sum -c SHA256SUMS"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    await bad.exited;
    expect(bad.exitCode).not.toBe(0);
  });
});

describe("every action is pinned by commit SHA, in both workflows", () => {
  test.each(["release.yml", "ci.yml"])("%s", async (name) => {
    const yml = await readFile(join(ROOT, ".github", "workflows", name), "utf8");
    const uses = [...yml.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const m of uses) {
      const [repo, ref] = m[1]!.split("@");
      expect(ref, m[1]).toMatch(/^[0-9a-f]{40}$/);
      expect(m[2], m[1]).toMatch(/^\s+# v[0-9]+/);
      expect(ref, repo).toBe(PINS[repo!]!);
    }
  });
});

describe("the README install table is true", () => {
  test("it lists exactly the platforms the workflow builds, and has no macOS row", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## Install"), readme.indexOf("**From source**"));
    const rows = [...section.matchAll(/^\| (Linux|macOS)[^|]*\| `mind-([a-z]+-[a-z0-9]+)`/gm)].map((m) => `${m[1]}:${m[2]}`);
    expect(rows).toEqual(["Linux:linux-x64", "Linux:linux-arm64"]);
    const workflow = await readFile(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    for (const row of rows) expect(workflow).toContain(`platform: ${row.split(":")[1]}`);
    expect(section).not.toMatch(/^\| macOS/m);
    expect(section).toContain("no macOS download yet");
  });

  test("the install section names the verify steps and install.sh", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("install.sh");
    expect(readme).toContain("cosign verify-blob");
    expect(readme).toContain("chmod go-w");
  });
});
