/**
 * `mind update` — ask GitHub, and swap the binary only after the release's
 * SHA256SUMS is checked and the binary matches it (D-065, D-173 item 2).
 *
 * The order is the point: the cosign signature on SHA256SUMS first (see
 * `signature.ts`: refused, never skipped, from the first signed release on),
 * then the checksum of the binary read from that same list. The file is
 * written beside the running binary and renamed over it, so a failure
 * part-way leaves the old one working; a download whose sha256 is not the one
 * the release lists is thrown away before it is ever executable.
 */

import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Env } from "../env.ts";
import {
  findCosign,
  missingForSignature,
  refusalReason,
  signatureRequired,
  SUMS_CERTIFICATE_ASSET,
  SUMS_SIGNATURE_ASSET,
  verifySums,
  type SignatureEvent,
} from "./signature.ts";
import { latestRelease, RELEASES_URL, sumFor, type Release } from "./version.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The product word in the `user-agent` of a request to GitHub. */
export const USER_AGENT_PRODUCT = "mind";

const headers = (version: string) => ({ "user-agent": `${USER_AGENT_PRODUCT}/${version}`, accept: "application/vnd.github+json" });

/** The newest release, or why it could not be asked. Never throws. */
export async function fetchLatest(version: string, fetchImpl: Fetch = fetch, timeoutMs = 5000): Promise<{ readonly ok: true; readonly release: Release | undefined } | { readonly ok: false; readonly reason: string }> {
  try {
    const res = await fetchImpl(RELEASES_URL, { headers: headers(version), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, reason: `GitHub answered ${res.status}` };
    return { ok: true, release: latestRelease(await res.json()) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** What `installRelease` is handed besides the release: all of it ambient, so `src/` reads none of it (D-021). */
export interface InstallOptions {
  /** The environment: PATH to find cosign, `MIND_REQUIRE_SIGNATURE`, `MIND_COSIGN_IDENTITY`. Left out = empty, so no cosign. */
  readonly env?: Env;
  /** Where the signature files are written for cosign (a private directory inside it, removed after). Default: the target's directory. */
  readonly scratch?: string;
  /** How long cosign may take before the signature counts as unverified. */
  readonly cosignTimeoutMs?: number;
  /** Told once when the update goes on: the signature verified, or (releases before the first signed one only) was not checked. */
  readonly onSignature?: (event: SignatureEvent) => void;
}

type Got = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly why: string };

async function getBytes(fetchImpl: Fetch, url: string, version: string): Promise<Got> {
  try {
    const res = await fetchImpl(url, { headers: headers(version) });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Download `asset` from `release`, check SHA256SUMS' signature and then the asset against it, and put it in
 * place of `target`. Returns what happened in words.
 *
 * A release that must be signed (`signatureRequired`) and whose signature cannot be verified refuses before
 * the binary is downloaded; one that need not be goes on with a WARNING through `options.onSignature`.
 */
export async function installRelease(
  release: Release,
  asset: string,
  target: string,
  version: string,
  fetchImpl: Fetch = fetch,
  options: InstallOptions = {},
): Promise<{ readonly ok: true; readonly sha256: string } | { readonly ok: false; readonly reason: string }> {
  const binUrl = release.assets.get(asset);
  const sumsUrl = release.assets.get("SHA256SUMS");
  if (binUrl === undefined) return { ok: false, reason: `${release.tag} has no ${asset}` };
  if (sumsUrl === undefined) return { ok: false, reason: `${release.tag} has no SHA256SUMS, so nothing could be checked — not installed` };

  const env = options.env ?? {};
  const required = signatureRequired(release.tag, env);
  const cosign = findCosign(env);
  // What is known before a byte is fetched: no cosign, or no .sig / .pem among the release's files.
  let why = missingForSignature(release, cosign);
  if (why !== undefined && required) return { ok: false, reason: refusalReason(release.tag, why) };

  const sums = await getBytes(fetchImpl, sumsUrl, version);
  if (!sums.ok) return { ok: false, reason: `download failed (SHA256SUMS: ${sums.why})` };

  // 1. The signature on the list, before anything in the list is believed.
  if (why === undefined) {
    const [signature, certificate] = await Promise.all([
      getBytes(fetchImpl, release.assets.get(SUMS_SIGNATURE_ASSET)!, version),
      getBytes(fetchImpl, release.assets.get(SUMS_CERTIFICATE_ASSET)!, version),
    ]);
    if (!signature.ok) why = `${SUMS_SIGNATURE_ASSET} could not be fetched (${signature.why})`;
    else if (!certificate.ok) why = `${SUMS_CERTIFICATE_ASSET} could not be fetched (${certificate.why})`;
    else {
      const checked = await verifySums(
        { sums: sums.bytes, signature: signature.bytes, certificate: certificate.bytes },
        {
          cosign: cosign!,
          env,
          scratch: options.scratch ?? dirname(target),
          ...(options.cosignTimeoutMs === undefined ? {} : { timeoutMs: options.cosignTimeoutMs }),
        },
      );
      if (!checked.verified) why = checked.why;
    }
  }
  if (why !== undefined && required) return { ok: false, reason: refusalReason(release.tag, why) };
  options.onSignature?.(why === undefined ? { verified: true } : { verified: false, why });

  // 2. The checksum of the binary, from the list that was just checked.
  const bin = await getBytes(fetchImpl, binUrl, version);
  if (!bin.ok) return { ok: false, reason: `download failed (${asset}: ${bin.why})` };
  const bytes = bin.bytes;
  const expected = sumFor(new TextDecoder().decode(sums.bytes), asset);
  if (expected === undefined) return { ok: false, reason: `SHA256SUMS does not list ${asset} — not installed` };
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const actual = hasher.digest("hex");
  if (actual !== expected) return { ok: false, reason: `checksum mismatch (${actual.slice(0, 12)}… ≠ ${expected.slice(0, 12)}…) — not installed` };
  const temp = `${target}.update-${process.pid}`;
  try {
    await writeFile(temp, bytes, { mode: 0o755 });
    await chmod(temp, 0o755);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    return { ok: false, reason: `could not replace ${target}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, sha256: actual };
}
