/**
 * Proof that whoever registers a public key on a market holds its private half (S15.4 step one, D-141).
 *
 * A market that takes a public key on the owner's word can be handed somebody else's — copied off that agent's
 * card — and would then credit that agent's signed reports to the wrong listing (platform PR #6 review, M1). So
 * the market asks for a proof: it issues a one-time nonce for one account and one listing, and the agent signs
 * a payload naming the market, the listing and that nonce with the key being registered.
 *
 * ## The payload
 *
 * `{kind, v: 1, market, listing, nonce, at}`, where `kind` is {@link KEY_PROOF_KIND} — signed exactly as a usage report is, in
 * the S15.8 envelope (`sign.ts`: Ed25519 over the RFC 8785 canonical JSON, integers only):
 *
 * | field | value |
 * |---|---|
 * | `market` | the market's origin, `scheme://host[:port]` — `marketOriginProblem` in `shapes.ts` |
 * | `listing` | the listing's slug, the platform's own rule — `isListingSlug` |
 * | `nonce` | the challenge: 32 bytes, base64url without padding, 43 characters, one spelling |
 * | `at` | when it was signed, an ISO-8601 UTC instant; for a person, not a freshness check |
 *
 * Each field closes one way the proof could be used somewhere it was not meant for: `kind` keeps it from being
 * read as any other signed thing, `market` from being replayed at another market, `listing` at another listing
 * on this one, and `nonce` — issued once, expiring in ten minutes, spent in the same transaction that registers
 * the key — from being replayed at all. Freshness is the nonce's job, on the market's clock; `at` only says
 * when this machine signed it.
 *
 * ## Checking one
 *
 * {@link verifyKeyProof} is what the platform does (D-141 §1): strict JSON (no duplicate names, integers in one
 * spelling), the envelope signed by exactly the key expected, `kind` and `v` exactly, every field in its
 * shape, and `market`, `listing` and `nonce` each exactly the one expected. It never throws.
 *
 * The test vector the platform ports is `test/fixtures/key-proof-v1.json`, signed with RFC 8032's test-1 key.
 */

import { isIsoInstant, isListingSlug, marketOriginProblem } from "./shapes.ts";
import { checkEnvelope, publicKeyProblem, verifyEnvelope, type SignedEnvelope } from "./sign.ts";
import { parseJsonStrict } from "./strict-json.ts";

/** The `kind` of the signed payload. */
export const KEY_PROOF_KIND = "mind.key-proof";
export const KEY_PROOF_VERSION = 1;

/** A nonce is 32 random bytes, so 43 base64url characters without padding. */
export const NONCE_BYTES = 32;
const NONCE = /^[A-Za-z0-9_-]{43}$/;

const PAYLOAD_FIELDS = ["at", "kind", "listing", "market", "nonce", "v"];

export interface KeyProofPayload {
  readonly kind: string;
  readonly v: typeof KEY_PROOF_VERSION;
  readonly market: string;
  readonly listing: string;
  readonly nonce: string;
  readonly at: string;
  readonly [name: string]: unknown;
}

/** What a proof is for: the market, the listing on it, and the challenge that market issued. */
export interface ProofTarget {
  readonly market: string;
  readonly listing: string;
  readonly nonce: string;
}

/**
 * Why this is not a challenge nonce, or undefined: 43 base64url characters that decode to 32 bytes and encode
 * back to themselves — so the last character's two spare bits are zero, and one nonce has one spelling.
 */
export function nonceProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || !NONCE.test(value)) return `is not ${NONCE_BYTES} bytes of base64url without padding (43 characters of A–Z, a–z, 0–9, - and _)`;
  if (Buffer.from(value, "base64url").toString("base64url") !== value) return "is not the one spelling of its bytes (its last character has stray low bits)";
  return undefined;
}

/** Why these are not a market, a listing and a nonce a proof can name — the first problem, said by field. */
export function targetProblem(target: ProofTarget): string | undefined {
  const market = marketOriginProblem(target.market);
  if (market !== undefined) return `market ${market}`;
  if (!isListingSlug(target.listing)) return "listing is not a slug: 3–40 lower-case letters, digits and hyphens, starting and ending with a letter or digit";
  const nonce = nonceProblem(target.nonce);
  return nonce === undefined ? undefined : `nonce ${nonce}`;
}

/**
 * The payload to sign. Pure: the caller gives the clock.
 *
 * @throws {Error} when the target has a problem — the command checks it first, so this is a bug in the caller.
 */
export function keyProofPayload(target: ProofTarget, now: Date): KeyProofPayload {
  const problem = targetProblem(target);
  if (problem !== undefined) throw new Error(`a key proof cannot name this: ${problem}`);
  return { kind: KEY_PROOF_KIND, v: KEY_PROOF_VERSION, market: target.market, listing: target.listing, nonce: target.nonce, at: now.toISOString() };
}

/** Why this payload is not a key proof, or undefined. */
export function proofProblem(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "the payload is not an object";
  const p = payload as Record<string, unknown>;
  if (p["kind"] !== KEY_PROOF_KIND) return `the payload is of kind ${JSON.stringify(p["kind"])}, not ${KEY_PROOF_KIND}`;
  if (p["v"] !== KEY_PROOF_VERSION) return `the proof's version ${JSON.stringify(p["v"])} is not ${KEY_PROOF_VERSION}`;
  if (Object.keys(p).sort().join(",") !== PAYLOAD_FIELDS.join(",")) return `a key proof has exactly the fields ${PAYLOAD_FIELDS.join(", ")}`;
  if (typeof p["market"] !== "string" || typeof p["listing"] !== "string" || typeof p["nonce"] !== "string") return "market, listing and nonce are not all strings";
  const target = targetProblem({ market: p["market"], listing: p["listing"], nonce: p["nonce"] });
  if (target !== undefined) return target;
  if (!isIsoInstant(p["at"])) return "at is not an ISO-8601 UTC instant";
  return undefined;
}

export type ProofCheck =
  | { readonly ok: true; readonly envelope: SignedEnvelope; readonly payload: KeyProofPayload }
  | { readonly ok: false; readonly reason: string };

/**
 * Consistent: strict JSON, signed by the key it carries, and a key proof in every field. **Not** a verdict on
 * whose key, or for which market, listing and nonce — {@link verifyKeyProof} is the one that can say yes.
 */
export function checkKeyProof(text: string): ProofCheck {
  const parsed = parseJsonStrict(text);
  if (!parsed.ok) return { ok: false, reason: `not JSON a signature can be checked over: ${parsed.reason}` };
  const checked = checkEnvelope(parsed.value);
  if (!checked.ok) return checked;
  const problem = proofProblem(checked.envelope.payload);
  if (problem !== undefined) return { ok: false, reason: `not a key proof this version reads: ${problem}` };
  return { ok: true, envelope: checked.envelope, payload: checked.envelope.payload as KeyProofPayload };
}

/**
 * Valid: {@link checkKeyProof}, signed by exactly `key`, and naming exactly this market, listing and nonce —
 * every check D-141 §1 has the platform make but the nonce's freshness and single use, which only the market
 * that issued it can know. Never throws.
 */
export function verifyKeyProof(text: string, key: string, expected: ProofTarget): ProofCheck {
  const keyProblem = publicKeyProblem(key);
  if (keyProblem !== undefined) return { ok: false, reason: `the key to check against is not usable: ${keyProblem}` };
  const checked = checkKeyProof(text);
  if (!checked.ok) return checked;
  const verified = verifyEnvelope(checked.envelope, key);
  if (!verified.ok) return verified;
  for (const field of ["market", "listing", "nonce"] as const) {
    if (checked.payload[field] !== expected[field]) return { ok: false, reason: `it proves the key for another ${field}: ${checked.payload[field]}, not ${expected[field]}` };
  }
  return checked;
}
