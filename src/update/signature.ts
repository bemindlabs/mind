/**
 * `mind update` and the signature on SHA256SUMS (D-173 item 2, plan I3 second half, checklist REL-UPD-SIG).
 *
 * The checksum of a release comes from the same place as its binary, so it catches a damaged download and not a
 * hostile release: whoever can replace the binary can replace the list. What does not come from the same place is
 * the cosign signature the release workflow makes of SHA256SUMS (keyless, the workflow's own identity). This
 * file decides when that signature is required and checks it the way `install.sh` does, with the same arguments.
 *
 * ## The rules (the same as `install.sh`, and the tests read `install.sh` to keep them the same)
 *
 * - From the first signed release on ({@link FIRST_SIGNED_TAG}), or whenever `MIND_REQUIRE_SIGNATURE=1`, a
 *   signature that is not there or does not verify REFUSES the update. It is never skipped: cosign missing on
 *   PATH, no `.sig` or no `.pem` among the release's files, a file that could not be fetched, a verification
 *   that fails or times out, each one refuses.
 * - A release before that keeps the checksum-only path. The signature is still checked when cosign is
 *   installed and the release carries one; when it cannot be, one WARNING line says so.
 * - The signature is checked FIRST, on the very bytes of SHA256SUMS that the checksum is then read from, so a
 *   list that was swapped fails here and its checksums are never trusted.
 *
 * ## What is not decided here (REL-COSIGN, owner)
 *
 * The identity the workflow signs under is an open owner decision: a keyless signature from a private repo
 * writes the repo, the workflow path and the tag to the public Rekor log. {@link DEFAULT_COSIGN_IDENTITY} is
 * the value `install.sh` already holds (a guess recorded in D-173), reused and not invented again, and
 * `MIND_COSIGN_IDENTITY` overrides it for both. When the owner settles it, both change together; a test
 * reads `install.sh` and fails if they drift apart.
 *
 * Nothing here reads the environment or the machine by itself (D-021): the caller passes `env`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readMind, type Env } from "../env.ts";
import { spawnGuarded } from "../spawn.ts";
import { parseVersion } from "./version.ts";

/**
 * The first release that is signed. Equal to `FIRST_SIGNED_TAG` in `install.sh` (a test compares them); from
 * this tag on an unsigned or unverifiable release is refused.
 */
export const FIRST_SIGNED_TAG = "v0.11.0";

/** `1` makes every release need a verified signature, old ones too (as for `install.sh`). */
export const REQUIRE_SIGNATURE_ENV = "MIND_REQUIRE_SIGNATURE";

/** The regexp of the signing identity, when it is not the default (as for `install.sh`). */
export const COSIGN_IDENTITY_ENV = "MIND_COSIGN_IDENTITY";

/**
 * The workflow identity that signs SHA256SUMS: the release workflow of the public repo or its private source, on a
 * `v*` tag. OWNER-TBD (REL-COSIGN, D-173 item 6): this is `install.sh`'s default, taken as it stands.
 */
export const DEFAULT_COSIGN_IDENTITY = String.raw`^https://github.com/bemindlabs/mind(-dev)?/\.github/workflows/release\.yml@refs/tags/v.*$`;

/** Who issued the certificate: GitHub's OIDC provider for Actions. The same in `install.sh`. */
export const COSIGN_ISSUER = "https://token.actions.githubusercontent.com";

/** The two files the release workflow uploads beside SHA256SUMS. */
export const SUMS_SIGNATURE_ASSET = "SHA256SUMS.sig";
export const SUMS_CERTIFICATE_ASSET = "SHA256SUMS.pem";

/** Verification talks to the transparency log; a hang must end in a refusal, not in a stuck update. */
export const COSIGN_TIMEOUT_MS = 120_000;

/** The reason when cosign cannot be found. The words are `install.sh`'s. */
export const COSIGN_MISSING = "cosign is not installed";

/**
 * Whether a release must have a signature that verifies: it is the first signed one or later (compared on
 * major.minor.patch only, as `install.sh` does, so `v0.11.0-alpha` counts), or the person asked for it.
 * A tag that does not parse is required too: what cannot be placed in the order is not trusted to be old.
 */
export function signatureRequired(tag: string, env: Env): boolean {
  if (readMind(REQUIRE_SIGNATURE_ENV, env) === "1") return true;
  const release = parseVersion(tag);
  const first = parseVersion(FIRST_SIGNED_TAG)!;
  if (release === undefined) return true;
  for (let i = 0; i < 3; i++) {
    if (release.core[i]! !== first.core[i]!) return release.core[i]! > first.core[i]!;
  }
  return true;
}

/** The identity regexp cosign is asked to match: the person's, or the default (an empty value is the default). */
export function cosignIdentity(env: Env): string {
  const set = readMind(COSIGN_IDENTITY_ENV, env);
  return set === undefined || set === "" ? DEFAULT_COSIGN_IDENTITY : set;
}

/** The cosign this PATH finds, or `undefined`. Looks only at the PATH it is given. */
export function findCosign(env: Env): string | undefined {
  return Bun.which("cosign", { PATH: env["PATH"] ?? "" }) ?? undefined;
}

/** Why the signature of `release` cannot be checked before anything is downloaded, or `undefined`. */
export function missingForSignature(
  release: { readonly assets: ReadonlyMap<string, string> },
  cosign: string | undefined,
): string | undefined {
  if (cosign === undefined) return COSIGN_MISSING;
  if (!release.assets.has(SUMS_SIGNATURE_ASSET)) return `this release has no ${SUMS_SIGNATURE_ASSET}`;
  if (!release.assets.has(SUMS_CERTIFICATE_ASSET)) return `this release has no ${SUMS_CERTIFICATE_ASSET}`;
  return undefined;
}

export type SignatureCheck = { readonly verified: true } | { readonly verified: false; readonly why: string };

export interface VerifyOptions {
  /** The cosign executable (from {@link findCosign}). */
  readonly cosign: string;
  /** The environment cosign runs in (it needs HOME for its trust-root cache and network to the transparency log). */
  readonly env: Env;
  /** A directory to make the working directory in; a private one is created inside it and removed afterwards. */
  readonly scratch: string;
  readonly timeoutMs?: number;
}

/**
 * `cosign verify-blob` of SHA256SUMS, with the arguments `install.sh` uses. The three files are written from
 * the bytes in memory, so what cosign checks is exactly what the checksum is read from afterwards.
 * Never throws: every way it can fail is a `why`.
 */
export async function verifySums(
  files: { readonly sums: Uint8Array; readonly signature: Uint8Array; readonly certificate: Uint8Array },
  options: VerifyOptions,
): Promise<SignatureCheck> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(options.scratch, "mind-update-sig-"));
    const sums = join(dir, "SHA256SUMS");
    const signature = join(dir, SUMS_SIGNATURE_ASSET);
    const certificate = join(dir, SUMS_CERTIFICATE_ASSET);
    await Promise.all([
      writeFile(sums, files.sums, { mode: 0o600 }),
      writeFile(signature, files.signature, { mode: 0o600 }),
      writeFile(certificate, files.certificate, { mode: 0o600 }),
    ]);
    const argv = [
      options.cosign,
      "verify-blob",
      "--certificate-identity-regexp",
      cosignIdentity(options.env),
      "--certificate-oidc-issuer",
      COSIGN_ISSUER,
      "--signature",
      signature,
      "--certificate",
      certificate,
      sums,
    ];
    const timeoutMs = options.timeoutMs ?? COSIGN_TIMEOUT_MS;
    let timedOut = false;
    const child = spawnGuarded(argv, { env: options.env });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    let stderr: string;
    try {
      [, stderr] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) return { verified: false, why: `cosign did not finish within ${Math.ceil(timeoutMs / 1000)} s, so the signature could not be checked` };
    if (child.exitCode === 0) return { verified: true };
    const first = stderr.split("\n").find((line) => line.trim() !== "")?.trim();
    return { verified: false, why: `the signature does not verify for the release workflow (${first ?? `cosign exited ${child.exitCode ?? "without a code"}`})` };
  } catch (error) {
    return { verified: false, why: `cosign could not be run (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What a person is told about the signature of an update that went on. A refusal is not an event: it is the reason. */
export type SignatureEvent =
  | { readonly verified: true }
  | { readonly verified: false; readonly why: string };

/** The refusal sentence. `install.sh` says the same: "a verified signature is required for <tag> and there is none: <why>". */
export function refusalReason(tag: string, why: string): string {
  return `a verified signature is required for ${tag} and there is none: ${why}`;
}

/** The one line for an event: the success, or the plain WARNING for a release before the first signed one. */
export function signatureLine(event: SignatureEvent): string {
  return event.verified
    ? "signature ok (cosign, the release workflow)"
    : `WARNING: the signature on SHA256SUMS was NOT checked (${event.why}). The checksum comes from the same place as the file: it catches corruption, not a hostile release.`;
}

/** The line the preview (no `--yes`) says about the signature, so a refusal is no surprise. */
export function requirementLine(tag: string, env: Env, cosign: string | undefined): string {
  if (signatureRequired(tag, env)) {
    return cosign === undefined
      ? `the signature on SHA256SUMS is required, and ${COSIGN_MISSING}: this update would be refused`
      : "the signature on SHA256SUMS is required, and is checked (cosign) before the checksum";
  }
  return `${tag} is before the first signed release (${FIRST_SIGNED_TAG}): the checksum decides unless the release carries a signature and cosign is installed`;
}
