/** D-065 — versions, the release for this machine, the checked swap, and when a check may run. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchLatest, installRelease, USER_AGENT_PRODUCT } from "../../src/update/install.ts";
import {
  assetFor,
  autoCheckDue,
  compareVersions,
  latestRelease,
  newerLine,
  parseVersion,
  readCheck,
  sumFor,
  writeCheck,
  type Release,
} from "../../src/update/version.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "mind-update-"));
  scratch.push(d);
  return d;
};
const v = (t: string) => parseVersion(t)!;

/** The assets of a release. */
const NEW_LINUX = "mind-linux-x64";
const DARWIN_X64 = "mind-darwin-x64";
const sha = (bytes: Uint8Array) => {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  return h.digest("hex");
};

describe("versions", () => {
  test("parse with or without v, prerelease below its release", () => {
    expect(v("v0.3.0-alpha")).toEqual({ core: [0, 3, 0], pre: "alpha", text: "0.3.0-alpha" });
    expect(parseVersion("latest")).toBeUndefined();
    expect(compareVersions(v("0.3.0-alpha"), v("0.3.0"))).toBeLessThan(0);
    expect(compareVersions(v("0.3.1"), v("0.3.0"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.0.0"), v("0.9.9"))).toBeGreaterThan(0);
    expect(compareVersions(v("0.3.0-alpha"), v("0.3.0-beta"))).toBeLessThan(0);
    expect(compareVersions(v("0.3.0"), v("v0.3.0"))).toBe(0);
  });

  test("the newest non-draft release, with its assets", () => {
    const r = latestRelease([
      { tag_name: "v0.2.0", draft: false, assets: [] },
      { tag_name: "v0.4.0", draft: true, assets: [] },
      { tag_name: "v0.3.0-alpha", draft: false, prerelease: true, html_url: "u", assets: [{ name: NEW_LINUX, browser_download_url: "b" }, { name: DARWIN_X64, browser_download_url: "c" }, { name: 3 }] },
      { tag_name: "nightly" },
    ])!;
    expect(r.tag).toBe("v0.3.0-alpha");
    expect(r.assets.get(NEW_LINUX)).toBe("b");
    expect(r.assets.get(DARWIN_X64)).toBe("c");
    expect(latestRelease({})).toBeUndefined();
  });

  test("this machine's asset, and the checksum a SHA256SUMS lists", () => {
    // The asset a machine asks for is the current name; the deploy plan names "this version" by it too.
    expect(assetFor("linux", "x64")).toBe(NEW_LINUX);
    expect(assetFor("darwin", "arm64")).toBe("mind-darwin-arm64");
    expect(assetFor("win32", "x64")).toBeUndefined();
    expect(assetFor("linux", "ia32")).toBeUndefined();
    const sums = `${"c".repeat(64)}  ${NEW_LINUX}\n${"b".repeat(64)} *SHA256SUMS\n`;
    expect(sumFor(sums, NEW_LINUX)).toBe("c".repeat(64));
    expect(sumFor(sums, DARWIN_X64)).toBeUndefined();
  });

  test("the line: only for a newer release", () => {
    expect(newerLine("0.3.0", "0.4.0")).toContain("mind 0.4.0 is available (you have 0.3.0)");
    expect(newerLine("0.3.0", "0.3.0-alpha")).toBeUndefined();
    expect(newerLine("0.3.0", null)).toBeUndefined();
    expect(newerLine("0.3.0", "garbage")).toBeUndefined();
  });
});

describe("when a check may run by itself", () => {
  const base = { env: {}, interactive: true, verb: "turn", argv: ["turn"], last: undefined, now: new Date("2026-09-24T12:00:00Z") };
  test("at a terminal, once a day, not when told not to, not in CI, not for machine output", () => {
    expect(autoCheckDue(base)).toBe(true);
    expect(autoCheckDue({ ...base, env: { MIND_NO_UPDATE_CHECK: "1" } })).toBe(false);
    expect(autoCheckDue({ ...base, env: { MIND_NO_UPDATE_CHECK: "0" } })).toBe(true);
    expect(autoCheckDue({ ...base, env: { CI: "true" } })).toBe(false);
    expect(autoCheckDue({ ...base, interactive: false })).toBe(false);
    expect(autoCheckDue({ ...base, argv: ["turn", "--json"] })).toBe(false);
    // `deploy`: its plan says no request leaves the machine while it runs (S13.1).
    for (const verb of ["observe", "update", "a2a", "web", "deploy", undefined]) expect(autoCheckDue({ ...base, verb })).toBe(false);
    expect(autoCheckDue({ ...base, last: { at: "2026-09-24T01:00:00Z", latest: null } })).toBe(false);
    expect(autoCheckDue({ ...base, last: { at: "2026-09-23T11:00:00Z", latest: null } })).toBe(true);
    expect(autoCheckDue({ ...base, last: { at: "nonsense", latest: null } })).toBe(true);
  });

  test("the record round-trips, and a missing one is none", async () => {
    const dir = await temp();
    expect(await readCheck(dir)).toBeUndefined();
    await writeCheck(dir, { at: "2026-09-24T00:00:00Z", latest: "0.4.0" });
    expect(await readCheck(dir)).toEqual({ at: "2026-09-24T00:00:00Z", latest: "0.4.0" });
  });
});

describe("installing", () => {
  const BIN = new TextEncoder().encode("#!/bin/sh\necho new\n");
  const release = (sums: string | null): Release => ({
    tag: "v0.4.0",
    version: v("0.4.0"),
    prerelease: false,
    url: "",
    assets: new Map([[NEW_LINUX, "https://x/bin"], ...(sums === null ? [] : [["SHA256SUMS", "https://x/sums"] as [string, string]])]),
  });
  const serve = (sums: string) => async (url: string) => (url.endsWith("/bin") ? new Response(BIN) : new Response(sums));

  test("a matching checksum replaces the file, executable", async () => {
    const target = join(await temp(), "mind");
    await writeFile(target, "old");
    const out = await installRelease(release("s"), NEW_LINUX, target, "0.3.0", serve(`${sha(BIN)}  ${NEW_LINUX}\n`));
    expect(out).toEqual({ ok: true, sha256: sha(BIN) });
    expect(await readFile(target, "utf8")).toContain("echo new");
    expect((await stat(target)).mode & 0o111).not.toBe(0);
  });

  test("a release with no such asset says which one it looked for", async () => {
    const sums = `${sha(BIN)}  ${NEW_LINUX}\n`;
    const c = await installRelease({ ...release("s"), assets: new Map([["SHA256SUMS", "https://x/sums"]]) }, NEW_LINUX, join(await temp(), "m"), "0.3.0", serve(sums));
    expect(c).toEqual({ ok: false, reason: `v0.4.0 has no ${NEW_LINUX}` });
  });

  test("a wrong checksum, no SHA256SUMS, an unlisted asset or a failed download leave the old file", async () => {
    const target = join(await temp(), "mind");
    await writeFile(target, "old");
    const cases = [
      await installRelease(release("s"), NEW_LINUX, target, "0.3.0", serve(`${"0".repeat(64)}  ${NEW_LINUX}\n`)),
      await installRelease(release(null), NEW_LINUX, target, "0.3.0", serve("")),
      await installRelease(release("s"), NEW_LINUX, target, "0.3.0", serve(`${sha(BIN)}  other\n`)),
      await installRelease(release("s"), DARWIN_X64, target, "0.3.0", serve("")),
      await installRelease(release("s"), NEW_LINUX, target, "0.3.0", async () => new Response("", { status: 404 })),
      await installRelease(release("s"), NEW_LINUX, target, "0.3.0", async () => { throw new Error("offline"); }),
    ];
    for (const c of cases) expect(c.ok).toBe(false);
    expect((cases[0] as { reason: string }).reason).toContain("checksum mismatch");
    expect(await readFile(target, "utf8")).toBe("old");
  });

  test("asking GitHub: a list, a refusal, or no network", async () => {
    const ok = await fetchLatest("0.3.0", async () => Response.json([{ tag_name: "v0.4.0", assets: [] }]));
    expect(ok.ok && ok.release?.tag).toBe("v0.4.0");
    expect(await fetchLatest("0.3.0", async () => new Response("", { status: 403 }))).toEqual({ ok: false, reason: "GitHub answered 403" });
    expect((await fetchLatest("0.3.0", async () => { throw new Error("offline"); })).ok).toBe(false);
  });

  test("every request to GitHub names the product, then the version", async () => {
    expect(USER_AGENT_PRODUCT).toBe("mind");
    const seen: string[] = [];
    const spy = async (url: string, init?: RequestInit): Promise<Response> => {
      seen.push((init?.headers as Record<string, string>)["user-agent"]!);
      if (url.endsWith("/bin")) return new Response(BIN);
      if (url.endsWith("/sums")) return new Response(`${sha(BIN)}  ${NEW_LINUX}\n`);
      return Response.json([{ tag_name: "v0.4.0", assets: [] }]);
    };
    await fetchLatest("0.3.0", spy);
    expect((await installRelease(release("s"), NEW_LINUX, join(await temp(), "mind"), "0.3.0", spy)).ok).toBe(true);
    // One for the list, one for the binary, one for SHA256SUMS.
    expect(seen).toEqual([0, 1, 2].map(() => `${USER_AGENT_PRODUCT}/0.3.0`));
  });
});
