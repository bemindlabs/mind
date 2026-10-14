/**
 * REL-UPD-SIG (D-173 item 2) — `mind update` checks the cosign signature on SHA256SUMS the way `install.sh` does:
 * the signature FIRST, then the checksum; refused (never skipped) from the first signed release on; the
 * checksum-only path for the releases before it.
 *
 * No network: every fetch is a function that answers from a map. cosign is a fake executable in a temp directory
 * that is the whole PATH, so a real cosign on this machine cannot leak in; it is a small Bun script that checks
 * the arguments `install.sh` passes, and "verifies" only a signature that is the sha256 of the exact list it is
 * asked about, which is what makes a swapped list fail.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installRelease } from "../../src/update/install.ts";
import {
  COSIGN_IDENTITY_ENV,
  COSIGN_ISSUER,
  COSIGN_MISSING,
  DEFAULT_COSIGN_IDENTITY,
  FIRST_SIGNED_TAG,
  REQUIRE_SIGNATURE_ENV,
  SUMS_CERTIFICATE_ASSET,
  SUMS_SIGNATURE_ASSET,
  cosignIdentity,
  findCosign,
  missingForSignature,
  refusalReason,
  requirementLine,
  signatureLine,
  signatureRequired,
  type SignatureEvent,
} from "../../src/update/signature.ts";
import { parseVersion, type Release } from "../../src/update/version.ts";

const INSTALL_SH = resolve(import.meta.dir, "..", "..", "install.sh");

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
const temp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "mind-update-sig-test-"));
  scratch.push(d);
  return d;
};

const sha = (bytes: Uint8Array | string): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const NAME = "mind-linux-x64";
const BIN = new TextEncoder().encode("#!/bin/sh\necho new\n");
const GOOD_LIST = `${sha(BIN)}  ${NAME}\n`;
const CERT = "CERT-OF-THE-RELEASE-WORKFLOW";

/**
 * A fake cosign. It insists on the arguments `install.sh` passes (verify-blob, a regexp, the issuer, three files),
 * logs what it was given, and verifies only when the signature file is the sha256 of the blob file and the
 * certificate file is CERT. `mode` picks the other behaviours a real one has.
 */
async function fakeCosign(mode: "verifies" | "hangs" = "verifies"): Promise<{ readonly path: string; readonly log: string }> {
  const dir = await temp();
  const log = join(dir, "cosign.log");
  const body =
    mode === "hangs"
      ? `setTimeout(() => process.exit(0), 20000);\n`
      : `
const { createHash } = require("node:crypto");
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const blob = args[args.length - 1];
const record = { args, signature: readFileSync(flag("--signature"), "utf8"), certificate: readFileSync(flag("--certificate"), "utf8"), blob: readFileSync(blob, "utf8") };
appendFileSync(${JSON.stringify(log)}, JSON.stringify(record) + "\\n");
const want = createHash("sha256").update(readFileSync(blob)).digest("hex");
if (args[0] !== "verify-blob" || record.certificate !== ${JSON.stringify(CERT)} || record.signature !== want) {
  console.error("Error: none of the expected identities matched: no matching signatures");
  console.error("a second line that is not shown");
  process.exit(1);
}
console.error("Verified OK");
`;
  const file = join(dir, "cosign");
  await writeFile(file, `#!${process.execPath}\n${body}`);
  await chmod(file, 0o755);
  return { path: dir, log };
}

async function cosignCalls(log: string): Promise<{ args: string[]; signature: string; certificate: string; blob: string }[]> {
  try {
    return (await readFile(log, "utf8")).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** A PATH that holds nothing: no cosign. */
const emptyPath = async (): Promise<string> => temp();

interface Shape {
  readonly tag?: string;
  /** The files the release lists beyond the binary and SHA256SUMS. */
  readonly sig?: boolean;
  readonly pem?: boolean;
}
const release = (shape: Shape = {}): Release => {
  const tag = shape.tag ?? "v0.11.0";
  const assets = new Map<string, string>([
    [NAME, `https://x/${tag}/${NAME}`],
    ["SHA256SUMS", `https://x/${tag}/SHA256SUMS`],
  ]);
  if (shape.sig !== false) assets.set(SUMS_SIGNATURE_ASSET, `https://x/${tag}/${SUMS_SIGNATURE_ASSET}`);
  if (shape.pem !== false) assets.set(SUMS_CERTIFICATE_ASSET, `https://x/${tag}/${SUMS_CERTIFICATE_ASSET}`);
  return { tag, version: parseVersion(tag)!, prerelease: false, url: "", assets };
};

/** Answers from the map by file name (404 for the rest) and remembers every file asked for. */
function serve(files: Record<string, Uint8Array | string>) {
  const asked: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    const name = url.split("/").pop()!;
    asked.push(name);
    const body = files[name];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  };
  return { fetchImpl, asked };
}

/** The files of a release whose list is signed: the signature is the sha256 of the list. */
const signedFiles = (list = GOOD_LIST): Record<string, Uint8Array | string> => ({
  [NAME]: BIN,
  SHA256SUMS: list,
  [SUMS_SIGNATURE_ASSET]: sha(list),
  [SUMS_CERTIFICATE_ASSET]: CERT,
});

async function attempt(rel: Release, files: Record<string, Uint8Array | string>, env: Record<string, string>, extra: { cosignTimeoutMs?: number } = {}) {
  const dir = await temp();
  const target = join(dir, "mind");
  await writeFile(target, "old");
  const work = join(dir, "work");
  await mkdir(work);
  const events: SignatureEvent[] = [];
  const served = serve(files);
  const out = await installRelease(rel, NAME, target, "0.10.2", served.fetchImpl, { env, scratch: work, onSignature: (e) => events.push(e), ...extra });
  return { out, events, asked: served.asked, target, work, content: () => readFile(target, "utf8") };
}

describe("when a signature is required", () => {
  const none = {};
  test("from the first signed release on, whatever the suffix, and for a tag that does not parse", () => {
    expect(FIRST_SIGNED_TAG).toBe("v0.11.0");
    for (const tag of ["v0.11.0", "v0.11.0-alpha", "v0.11.0-rc.1", "v0.11.1", "v0.12.0", "v1.0.0", "v10.0.0", "0.11.0", "nightly", ""]) {
      expect(signatureRequired(tag, none), tag).toBe(true);
    }
  });
  test("not before it", () => {
    for (const tag of ["v0.10.2", "v0.10.9-alpha", "v0.10.2-alpha", "v0.9.0", "v0.0.1", "0.4.0"]) expect(signatureRequired(tag, none), tag).toBe(false);
  });
  test("MIND_REQUIRE_SIGNATURE=1 makes every release need one; any other value does not", () => {
    expect(signatureRequired("v0.4.0", { [REQUIRE_SIGNATURE_ENV]: "1" })).toBe(true);
    for (const value of ["0", "", "true", "yes", "2"]) expect(signatureRequired("v0.4.0", { [REQUIRE_SIGNATURE_ENV]: value }), value).toBe(false);
  });
});

describe("the identity and the issuer are install.sh's, not a second guess (REL-COSIGN is the owner's)", () => {
  const text = readFile(INSTALL_SH, "utf8");

  test("the default identity is what install.sh evaluates to, character for character", async () => {
    const line = (await text).split("\n").find((l) => l.trimStart().startsWith("IDENTITY="))!;
    expect(line).toBeDefined();
    const script = `unset MIND_COSIGN_IDENTITY; ${line.trim()}; printf '%s' "$IDENTITY"`;
    const shell = Bun.spawn(["/bin/sh", "-c", script], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
    const evaluated = await new Response(shell.stdout).text();
    await shell.exited;
    expect(evaluated).toBe(DEFAULT_COSIGN_IDENTITY);
  });

  test("the issuer, the first signed tag, the two file names and the cosign arguments match install.sh", async () => {
    const sh = await text;
    expect(sh).toContain(`ISSUER="${COSIGN_ISSUER}"`);
    expect(sh).toContain(`FIRST_SIGNED_TAG="${FIRST_SIGNED_TAG}"`);
    expect(sh).toContain(`"$BASE/$VERSION/${SUMS_SIGNATURE_ASSET}"`);
    expect(sh).toContain(`"$BASE/$VERSION/${SUMS_CERTIFICATE_ASSET}"`);
    expect(sh).toContain("cosign verify-blob --certificate-identity-regexp");
    expect(sh).toContain("--certificate-oidc-issuer");
    expect(sh).toContain(`MIND_REQUIRE_SIGNATURE`);
    expect(sh).toContain(`why="${COSIGN_MISSING}"`);
    expect(sh).toContain(refusalReason("$VERSION", "$why"));
    expect(sh).toContain("WARNING: the signature on SHA256SUMS was NOT checked");
    expect(sh).toContain(signatureLine({ verified: true }));
    expect(signatureLine({ verified: false, why: "w" })).toContain("WARNING: the signature on SHA256SUMS was NOT checked (w).");
  });

  test("the regexp accepts the release workflow of the public repo and its source on a v tag, and nothing else", () => {
    const re = new RegExp(DEFAULT_COSIGN_IDENTITY);
    expect(re.test("https://github.com/bemindlabs/mind/.github/workflows/release.yml@refs/tags/v0.11.0")).toBe(true);
    expect(re.test("https://github.com/bemindlabs/mind-dev/.github/workflows/release.yml@refs/tags/v0.11.0-alpha")).toBe(true);
    for (const other of [
      "https://github.com/someone/mind/.github/workflows/release.yml@refs/tags/v0.11.0",
      "https://github.com/bemindlabs/mind/.github/workflows/other.yml@refs/tags/v0.11.0",
      "https://github.com/bemindlabs/mind/.github/workflows/release.yml@refs/heads/main",
      "https://github.com/bemindlabs/mind-evil/.github/workflows/release.yml@refs/tags/v0.11.0",
      "xhttps://github.com/bemindlabs/mind/.github/workflows/release.yml@refs/tags/v0.11.0",
    ]) expect(re.test(other), other).toBe(false);
  });

  test("MIND_COSIGN_IDENTITY replaces it; empty or unset is the default", () => {
    expect(cosignIdentity({})).toBe(DEFAULT_COSIGN_IDENTITY);
    expect(cosignIdentity({ [COSIGN_IDENTITY_ENV]: "" })).toBe(DEFAULT_COSIGN_IDENTITY);
    expect(cosignIdentity({ [COSIGN_IDENTITY_ENV]: "^mine$" })).toBe("^mine$");
  });
});

describe("finding cosign and what is missing before anything is fetched", () => {
  test("only on the PATH it is given", async () => {
    const fake = await fakeCosign();
    expect(findCosign({ PATH: fake.path })).toBe(join(fake.path, "cosign"));
    expect(findCosign({ PATH: await emptyPath() })).toBeUndefined();
    expect(findCosign({})).toBeUndefined();
  });

  test("cosign first, then the .sig, then the .pem, with install.sh's words", () => {
    expect(missingForSignature(release(), undefined)).toBe("cosign is not installed");
    expect(missingForSignature(release({ sig: false, pem: false }), "/x/cosign")).toBe("this release has no SHA256SUMS.sig");
    expect(missingForSignature(release({ pem: false }), "/x/cosign")).toBe("this release has no SHA256SUMS.pem");
    expect(missingForSignature(release(), "/x/cosign")).toBeUndefined();
  });
});

describe("a signed release is verified, then installed", () => {
  test("cosign gets install.sh's arguments on the exact list, the signature is read before the checksum, and the update goes on", async () => {
    const fake = await fakeCosign();
    const r = await attempt(release(), signedFiles(), { PATH: fake.path });
    expect(r.out).toEqual({ ok: true, sha256: sha(BIN) });
    expect(r.events).toEqual([{ verified: true }]);
    expect(await r.content()).toContain("echo new");

    const [call, ...rest] = await cosignCalls(fake.log);
    expect(rest).toEqual([]);
    expect(call!.args.slice(0, 7)).toEqual(["verify-blob", "--certificate-identity-regexp", DEFAULT_COSIGN_IDENTITY, "--certificate-oidc-issuer", COSIGN_ISSUER, "--signature", expect.stringMatching(/SHA256SUMS\.sig$/)]);
    expect(call!.args[7]).toBe("--certificate");
    expect(call!.args[8]).toMatch(/SHA256SUMS\.pem$/);
    expect(call!.args[9]).toMatch(/SHA256SUMS$/);
    expect(call!.args).toHaveLength(10);
    expect(call!.blob).toBe(GOOD_LIST);
    expect(call!.certificate).toBe(CERT);

    // The list and its signature were asked for, and the binary only after them.
    expect(r.asked.indexOf(NAME)).toBeGreaterThan(r.asked.indexOf("SHA256SUMS"));
    expect(r.asked.indexOf(NAME)).toBeGreaterThan(r.asked.indexOf(SUMS_SIGNATURE_ASSET));
    expect(r.asked.indexOf(NAME)).toBeGreaterThan(r.asked.indexOf(SUMS_CERTIFICATE_ASSET));
    // cosign's files are gone afterwards.
    expect(await readdir(r.work)).toEqual([]);
  });

  test("a later release is verified the same way", async () => {
    const fake = await fakeCosign();
    const r = await attempt(release({ tag: "v1.2.3" }), signedFiles(), { PATH: fake.path });
    expect(r.out.ok).toBe(true);
    expect(await cosignCalls(fake.log)).toHaveLength(1);
  });

  test("MIND_COSIGN_IDENTITY reaches cosign", async () => {
    const fake = await fakeCosign();
    const r = await attempt(release(), signedFiles(), { PATH: fake.path, [COSIGN_IDENTITY_ENV]: "^the-owner-chose-this$" });
    expect(r.out.ok).toBe(true);
    expect((await cosignCalls(fake.log))[0]!.args[2]).toBe("^the-owner-chose-this$");
  });

  test("a valid signature does not excuse a binary that is not on the list: the checksum still decides", async () => {
    const fake = await fakeCosign();
    const list = `${"0".repeat(64)}  ${NAME}\n`;
    const r = await attempt(release(), signedFiles(list), { PATH: fake.path });
    expect(r.out.ok).toBe(false);
    expect((r.out as { reason: string }).reason).toContain("checksum mismatch");
    expect(r.events).toEqual([{ verified: true }]);
    expect(await r.content()).toBe("old");
    const unlisted = await attempt(release(), signedFiles(`${sha(BIN)}  other\n`), { PATH: fake.path });
    expect((unlisted.out as { reason: string }).reason).toContain(`SHA256SUMS does not list ${NAME}`);
    expect(await unlisted.content()).toBe("old");
  });
});

describe("a signed release that cannot be verified is refused, never skipped", () => {
  const refused = (r: Awaited<ReturnType<typeof attempt>>): string => {
    expect(r.out.ok).toBe(false);
    return (r.out as { reason: string }).reason;
  };

  test("a tampered checksum list: the list names the attacker's binary, the signature is of the real list", async () => {
    const fake = await fakeCosign();
    const evil = new TextEncoder().encode("#!/bin/sh\necho hostile\n");
    const tampered = `${sha(evil)}  ${NAME}\n`;
    // The binary and its line are consistent with each other, so the checksum alone would pass.
    const files = { ...signedFiles(), [NAME]: evil, SHA256SUMS: tampered };
    const r = await attempt(release(), files, { PATH: fake.path });
    const reason = refused(r);
    expect(reason).toContain("a verified signature is required for v0.11.0 and there is none");
    expect(reason).toContain("the signature does not verify for the release workflow");
    // cosign's own first line, and only the first.
    expect(reason).toContain("no matching signatures");
    expect(reason).not.toContain("a second line");
    expect(r.events).toEqual([]);
    expect(await r.content()).toBe("old");
    // The hostile binary was never even downloaded, and nothing is left behind.
    expect(r.asked).not.toContain(NAME);
    expect(await readdir(r.work)).toEqual([]);
    expect((await readdir(resolve(r.target, ".."))).sort()).toEqual(["mind", "work"]);
  });

  test("the signature is checked before the checksum: a bad signature and a bad checksum report the signature", async () => {
    const fake = await fakeCosign();
    const list = `${"0".repeat(64)}  ${NAME}\n`;
    const r = await attempt(release(), { ...signedFiles(list), [SUMS_SIGNATURE_ASSET]: "not the signature of this list" }, { PATH: fake.path });
    const reason = refused(r);
    expect(reason).toContain("the signature does not verify");
    expect(reason).not.toContain("checksum");
  });

  test("a wrong certificate is as bad as a wrong signature", async () => {
    const fake = await fakeCosign();
    const r = await attempt(release(), { ...signedFiles(), [SUMS_CERTIFICATE_ASSET]: "someone else's certificate" }, { PATH: fake.path });
    expect(refused(r)).toContain("does not verify");
    expect(await r.content()).toBe("old");
  });

  test("no .sig among the release's files: refused, and nothing was downloaded", async () => {
    const fake = await fakeCosign();
    const r = await attempt(release({ sig: false }), signedFiles(), { PATH: fake.path });
    expect(refused(r)).toBe("a verified signature is required for v0.11.0 and there is none: this release has no SHA256SUMS.sig");
    expect(r.asked).toEqual([]);
    expect(await cosignCalls(fake.log)).toEqual([]);
    expect(await r.content()).toBe("old");
  });

  test("no .pem: refused", async () => {
    const fake = await fakeCosign();
    const r = await attempt(release({ pem: false }), signedFiles(), { PATH: fake.path });
    expect(refused(r)).toBe("a verified signature is required for v0.11.0 and there is none: this release has no SHA256SUMS.pem");
    expect(r.asked).toEqual([]);
    expect(await r.content()).toBe("old");
  });

  test("neither file, on a later release too (v1.0.0)", async () => {
    const fake = await fakeCosign();
    const r = await attempt(release({ tag: "v1.0.0", sig: false, pem: false }), signedFiles(), { PATH: fake.path });
    expect(refused(r)).toContain("a verified signature is required for v1.0.0");
    expect(await r.content()).toBe("old");
  });

  test("cosign missing on PATH: refused with install.sh's words, before anything is fetched", async () => {
    const r = await attempt(release(), signedFiles(), { PATH: await emptyPath() });
    expect(refused(r)).toBe("a verified signature is required for v0.11.0 and there is none: cosign is not installed");
    expect(r.asked).toEqual([]);
    expect(r.events).toEqual([]);
    expect(await r.content()).toBe("old");
  });

  test("no PATH at all is the same refusal, not a pass", async () => {
    const r = await attempt(release(), signedFiles(), {});
    expect(refused(r)).toContain("cosign is not installed");
    expect(await r.content()).toBe("old");
  });

  test("a .sig the release lists but GitHub does not serve: refused", async () => {
    const fake = await fakeCosign();
    const { [SUMS_SIGNATURE_ASSET]: _gone, ...without } = signedFiles();
    const r = await attempt(release(), without, { PATH: fake.path });
    expect(refused(r)).toContain("SHA256SUMS.sig could not be fetched (HTTP 404)");
    const { [SUMS_CERTIFICATE_ASSET]: _gone2, ...withoutPem } = signedFiles();
    const q = await attempt(release(), withoutPem, { PATH: fake.path });
    expect(refused(q)).toContain("SHA256SUMS.pem could not be fetched (HTTP 404)");
    expect(await r.content()).toBe("old");
    expect(await q.content()).toBe("old");
  });

  test("a list that cannot be fetched is refused whatever the release", async () => {
    const fake = await fakeCosign();
    const { SHA256SUMS: _gone, ...without } = signedFiles();
    const r = await attempt(release(), without, { PATH: fake.path });
    expect(refused(r)).toBe("download failed (SHA256SUMS: HTTP 404)");
  });

  test("cosign that hangs is stopped and refuses; the list is not trusted", async () => {
    const fake = await fakeCosign("hangs");
    const started = Date.now();
    const r = await attempt(release(), signedFiles(), { PATH: fake.path }, { cosignTimeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(refused(r)).toContain("cosign did not finish within 1 s");
    expect(await r.content()).toBe("old");
    expect(await readdir(r.work)).toEqual([]);
  });

  test("MIND_REQUIRE_SIGNATURE=1 refuses an old release that has none, and verifies one that has", async () => {
    const fake = await fakeCosign();
    const old = release({ tag: "v0.10.2", sig: false, pem: false });
    const r = await attempt(old, signedFiles(), { PATH: fake.path, [REQUIRE_SIGNATURE_ENV]: "1" });
    expect(refused(r)).toContain("a verified signature is required for v0.10.2");
    expect(await r.content()).toBe("old");
    const signed = await attempt(release({ tag: "v0.10.2" }), signedFiles(), { PATH: fake.path, [REQUIRE_SIGNATURE_ENV]: "1" });
    expect(signed.out.ok).toBe(true);
  });
});

describe("a release before the first signed one keeps the checksum-only path", () => {
  test("no signature, no cosign: installs on the checksum, and says in one WARNING that the signature was NOT checked", async () => {
    const r = await attempt(release({ tag: "v0.10.2", sig: false, pem: false }), signedFiles(), { PATH: await emptyPath() });
    expect(r.out).toEqual({ ok: true, sha256: sha(BIN) });
    expect(r.events).toEqual([{ verified: false, why: "cosign is not installed" }]);
    expect(signatureLine(r.events[0]!)).toContain("WARNING: the signature on SHA256SUMS was NOT checked (cosign is not installed)");
    expect(await r.content()).toContain("echo new");
    // Only the list and the binary: no signature was asked for.
    expect(r.asked).toEqual(["SHA256SUMS", NAME]);
  });

  test("no signature, cosign present: cosign is not run, the reason is the missing file", async () => {
    const fake = await fakeCosign();
    const r = await attempt(release({ tag: "v0.10.2", sig: false, pem: false }), signedFiles(), { PATH: fake.path });
    expect(r.out.ok).toBe(true);
    expect(r.events).toEqual([{ verified: false, why: "this release has no SHA256SUMS.sig" }]);
    expect(await cosignCalls(fake.log)).toEqual([]);
  });

  test("a signature it does carry is checked when cosign is there, and says so", async () => {
    const fake = await fakeCosign();
    const r = await attempt(release({ tag: "v0.10.2" }), signedFiles(), { PATH: fake.path });
    expect(r.out.ok).toBe(true);
    expect(r.events).toEqual([{ verified: true }]);
    expect(await cosignCalls(fake.log)).toHaveLength(1);
  });

  test("as in install.sh, a signature that does not verify there is a WARNING, and the checksum still has to pass", async () => {
    const fake = await fakeCosign();
    const bad = { ...signedFiles(), [SUMS_SIGNATURE_ASSET]: "garbage" };
    const r = await attempt(release({ tag: "v0.10.2" }), bad, { PATH: fake.path });
    expect(r.out.ok).toBe(true);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ verified: false });
    expect((r.events[0] as { why: string }).why).toContain("does not verify");
    const wrong = await attempt(release({ tag: "v0.10.2" }), { ...bad, SHA256SUMS: `${"0".repeat(64)}  ${NAME}\n` }, { PATH: fake.path });
    expect((wrong.out as { reason: string }).reason).toContain("checksum mismatch");
    expect(await wrong.content()).toBe("old");
  });

  test("the checksum is still enforced there (a tampered binary is refused as before)", async () => {
    const r = await attempt(release({ tag: "v0.10.2", sig: false, pem: false }), { ...signedFiles(), [NAME]: new TextEncoder().encode("hostile") }, { PATH: await emptyPath() });
    expect((r.out as { reason: string }).reason).toContain("checksum mismatch");
    expect(await r.content()).toBe("old");
  });
});

describe("what the preview and the lines say", () => {
  test("the preview tells a person a refusal is coming", () => {
    expect(requirementLine("v0.11.0", {}, undefined)).toBe("the signature on SHA256SUMS is required, and cosign is not installed: this update would be refused");
    expect(requirementLine("v0.11.0", {}, "/x/cosign")).toBe("the signature on SHA256SUMS is required, and is checked (cosign) before the checksum");
    expect(requirementLine("v0.10.2", {}, undefined)).toContain("v0.10.2 is before the first signed release (v0.11.0): the checksum decides unless");
    expect(requirementLine("v0.10.2", { [REQUIRE_SIGNATURE_ENV]: "1" }, undefined)).toContain("is required, and cosign is not installed");
  });

  test("the success line, and the refusal sentence install.sh also uses", () => {
    expect(signatureLine({ verified: true })).toBe("signature ok (cosign, the release workflow)");
    expect(refusalReason("v0.11.0", "cosign is not installed")).toBe("a verified signature is required for v0.11.0 and there is none: cosign is not installed");
  });
});
