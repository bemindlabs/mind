/**
 * Sign a JSON payload with an agent's own ed25519 key, and check one (S15.8, D-106, D-108, D-138).
 *
 * Pure: no filesystem, no network, no clock. The key arrives as a `KeyObject` and the envelope leaves as a
 * value; where the key is kept is `key.ts`'s business.
 *
 * ## The bytes that are signed — the contract with whoever verifies
 *
 * The marketplace (S16.4) and anyone holding a report must be able to rebuild exactly the bytes that were
 * signed, in any language, from the envelope alone. So:
 *
 *   signature = Ed25519(privateKey, UTF-8(canonicalJson(envelope.payload)))
 *
 * - **Ed25519** is RFC 8032's pure Ed25519 — not Ed25519ph, no context string. Deterministic: one key and
 *   one payload always give one signature, which is what lets a test pin a vector.
 * - **`canonicalJson`** is RFC 8785 (the JSON Canonicalization Scheme) restricted to integers:
 *   - an object's members are written in the order of their names' UTF-16 code units (JavaScript's default
 *     string sort, which is JCS §3.2.3), each name once;
 *   - an array keeps its order;
 *   - no whitespace at all: `,` between members and elements, `:` between a name and its value;
 *   - a string is written as ECMAScript's `JSON.stringify` writes it (JCS §3.2.2.2): `"` and `\` escaped,
 *     U+0008/0009/000A/000C/000D as `\b` `\t` `\n` `\f` `\r`, the other controls below U+0020 as `\u00xx`
 *     in lower-case hex, and every other character as itself — non-ASCII, `/`, U+007F, U+2028 and U+2029
 *     are not escaped. A string with a lone surrogate is refused: it has no UTF-8 form;
 *   - a number must be an integer of magnitude at most 2^53 − 1, written in plain decimal (`-0` as `0`).
 *     Fractions and exponents are refused rather than formatted: every language agrees on how to print an
 *     integer, and not all of them agree with JCS about 1e21;
 *   - `true`, `false` and `null` as themselves. Nothing else is JSON, and nothing else is accepted.
 *
 *   Any JCS implementation therefore produces the same bytes for anything this module accepts. For payloads
 *   whose member names are ASCII — every payload Mind signs — so does Python's
 *   `json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")`.
 * - **The payload must carry a string `kind`** (`mind.usage-report` for a usage report, `mind.key-proof`
 *   for a proof of holding the key — `proof.ts`, D-141). One key may come to sign
 *   more than one kind of thing, and a verifier that checks `kind` cannot be shown a signature over one kind
 *   as if it were another.
 *
 * ## The envelope
 *
 *   { "v": 1, "algorithm": "ed25519", "publicKey": <b64url>, "fingerprint": <16 hex>,
 *     "payload": { "kind": …, … }, "signature": <b64url> }
 *
 * - `publicKey` — the 32-byte RFC 8032 public key, base64url without padding (the `x` of its JWK).
 * - `signature` — the 64-byte signature, base64url without padding.
 * - `fingerprint` — the first 16 lower-case hex digits of SHA-256 over the 32 public-key bytes. For a person
 *   to compare with the agent card; it is 64 bits and nothing should be *pinned* to it. Pin the whole key.
 * - Only `payload` is signed. The rest says how to check it: a swapped `publicKey` does not verify unless it
 *   signed the payload itself, and then it is a different agent — which is what comparing with the card, or
 *   `--key`, is for.
 *
 * ## What is refused before the curve is asked (S15.8 security review, M1)
 *
 * OpenSSL's Ed25519 — which `node:crypto` is under Bun — verifies whatever it is handed. With the identity
 * point as the public key and `R = identity, S = 0`, *every* payload verifies: anyone can "sign" for that key,
 * so a report under it proves nothing, even with `--key` pinned to it. So this module does what libsodium's
 * `crypto_sign_verify_detached` does, before any curve arithmetic:
 *
 * - **the public key** must encode `y < p` (canonical) and must not be one of the eight points of small order
 *   or their non-canonical encodings — libsodium's blocklist, compared with the sign bit masked as it does;
 * - **`R`**, the first half of the signature, must not be a small-order point either;
 * - **`S`**, the second half, must be below the group order `L` (RFC 8032 §5.1.7), checked here rather than
 *   left to whichever library is underneath.
 *
 * The same test applies to a key given to check against (`--key`), so a weak key cannot be pinned. The
 * rejected encodings are test vectors in `test/identity/sign.test.ts`, beside the fixed signing vector, for
 * the marketplace's verifier to hold itself to (D-138).
 *
 * ## Duplicate member names
 *
 * RFC 8785 forbids them and `JSON.parse` keeps the last, so an envelope with two `rows` could show one
 * reader the signed rows and another the unsigned ones. Text is read with `parseJsonStrict`
 * (`strict-json.ts`), which refuses a duplicate anywhere; this module is handed values.
 *
 * ## Numbers in one spelling (D-141 §4)
 *
 * The signature is over the canonical bytes, so `151250`, `151250.0` and `1.5125e5` in the text all verify: the
 * value is the same. `parseJsonStrict` refuses every spelling but the plain integer digits, so a signed NUMBER
 * has one spelling. Strings still have several (`\u0041` is `A`, `\/` is `/`) and whitespace is free, so a signed
 * payload does not have one text: every reader decodes those the same, but anything that dedupes must key on the
 * decoded values (e.g. a row's id), never on a hash of the text (PR #4 review).
 */

import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const SIGNATURE_ALGORITHM = "ed25519";
export const ENVELOPE_VERSION = 1;

/** Deeper than any payload Mind makes, and shallow enough that hostile input cannot exhaust the stack. */
const MAX_DEPTH = 32;

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32 raw key bytes follow it. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * A payload: a JSON object that says what kind of thing it is. Typed loosely on purpose — whether it really is
 * canonical JSON is {@link canonicalJson}'s question, asked at run time, where a verifier has to ask it anyway.
 */
export interface Payload {
  readonly kind: string;
  readonly [name: string]: unknown;
}

export interface SignedEnvelope {
  readonly v: typeof ENVELOPE_VERSION;
  readonly algorithm: typeof SIGNATURE_ALGORITHM;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly payload: Payload;
  readonly signature: string;
}

/** Why a value has no canonical form. */
export class CanonicalError extends Error {
  override readonly name = "CanonicalError";
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, depth: number, at: string): string {
  if (depth > MAX_DEPTH) throw new CanonicalError(`${at} is nested deeper than ${MAX_DEPTH}`);
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) throw new CanonicalError(`${at} holds a lone surrogate, which has no UTF-8 form`);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new CanonicalError(`${at} is ${value}, and only integers up to 2^53 − 1 are signed`);
    // JSON.stringify writes -0 as `0`, which is JCS's rule too.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => write(item, depth + 1, `${at}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object" && isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((name) => {
        const member = record[name];
        if (member === undefined) throw new CanonicalError(`${at}.${name} is undefined, which is not JSON`);
        if (LONE_SURROGATE.test(name)) throw new CanonicalError(`a member name under ${at} holds a lone surrogate`);
        return `${JSON.stringify(name)}:${write(member, depth + 1, `${at}.${name}`)}`;
      });
    return `{${members.join(",")}}`;
  }
  throw new CanonicalError(`${at} is ${typeof value === "object" ? "an object that is not plain JSON" : `a ${typeof value}`}`);
}

/**
 * The canonical text of a JSON value — the rules are in this file's header.
 *
 * @throws {CanonicalError} for anything that is not JSON with integer numbers.
 */
export function canonicalJson(value: unknown): string {
  return write(value, 0, "payload");
}

/** The bytes that are signed: UTF-8 of {@link canonicalJson}. */
export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalJson(value));
}

/** p = 2^255 − 19: a coordinate is canonical only below it. */
const FIELD_P = (1n << 255n) - 19n;
/** L, the order of the base point: a signature's `S` is canonical only below it. */
const GROUP_L = (1n << 252n) + 27742317777372353535851937790883648493n;

/**
 * libsodium's blocklist (`ge25519_has_small_order`): the encodings of all eight points of small order —
 * orders 1, 2, 4 and 8 — and the two non-canonical ones among them (`y = p`, `y = p + 1`). Compared on the
 * first 31 bytes and the last byte with its sign bit masked off, so both signs of each are covered.
 */
const SMALL_ORDER: readonly Buffer[] = [
  "0000000000000000000000000000000000000000000000000000000000000000", // y = 0: order 4
  "0100000000000000000000000000000000000000000000000000000000000000", // y = 1: the identity, order 1
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", // order 8
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a", // order 8
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // y = p − 1: order 2
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // y = p, non-canonical 0: order 4
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // y = p + 1, non-canonical 1: order 1
].map((hex) => Buffer.from(hex, "hex"));

function littleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
  return value;
}

/** Whether 32 bytes encode one of the points of small order. */
export function isSmallOrder(point: Uint8Array): boolean {
  return SMALL_ORDER.some(
    (bad) => point.length === 32 && point.subarray(0, 31).every((byte, i) => byte === bad[i]) && (point[31]! & 0x7f) === bad[31],
  );
}

/** Why 32 bytes are not a public key a signature may be checked against, or undefined. */
export function pointProblem(point: Uint8Array): string | undefined {
  if (point.length !== 32) return "not 32 bytes";
  const y = littleEndian(point) & ((1n << 255n) - 1n);
  if (y >= FIELD_P) return "a non-canonical encoding (y ≥ p)";
  if (isSmallOrder(point)) return "a point of small order, for which anyone can make a signature that verifies";
  return undefined;
}

/** base64url without padding, and only that: decoded, or undefined for anything else. */
function fromBase64url(text: unknown, length: number): Buffer | undefined {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64url");
  // Re-encoding catches the non-canonical spellings (stray low bits in the last character), so one key or
  // signature has exactly one text.
  if (bytes.length !== length || bytes.toString("base64url") !== text) return undefined;
  return bytes;
}

/**
 * Why this text is not an ed25519 public key a signature may be checked against, or undefined.
 *
 * Asked of the key an envelope carries and of a key given to check against: 32 bytes, base64url, a canonical
 * encoding, and not a point of small order.
 */
export function publicKeyProblem(text: unknown): string | undefined {
  const bytes = fromBase64url(text, 32);
  if (bytes === undefined) return "not 32 bytes of base64url";
  return pointProblem(bytes);
}

/** The 32 raw bytes of a usable public key given as base64url, or undefined when it is not one. */
export function publicKeyBytes(text: unknown): Buffer | undefined {
  return publicKeyProblem(text) === undefined ? fromBase64url(text, 32) : undefined;
}

/** A key's public half as the envelope writes it: 32 raw bytes, base64url. Works on either half. */
export function publicKeyText(key: KeyObject): string {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(SPKI_ED25519_PREFIX.length).toString("base64url");
}

/** The first 16 hex of SHA-256 over the raw public key — for eyes, not for pinning. */
export function fingerprintOf(publicKey: string): string {
  const bytes = publicKeyBytes(publicKey);
  if (bytes === undefined) throw new CanonicalError("not an ed25519 public key (32 bytes, base64url)");
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function isPayload(value: unknown): value is Payload {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    (value as { kind: string }).kind !== ""
  );
}

/**
 * Sign `payload` with an Ed25519 private key.
 *
 * @throws {CanonicalError} when the payload has no canonical form or no `kind` — a bug in the caller, not
 *   input from outside, which is why this throws and {@link verifyEnvelope} does not.
 */
export function signEnvelope(payload: Payload, privateKey: KeyObject): SignedEnvelope {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== SIGNATURE_ALGORITHM) {
    throw new CanonicalError("signing needs an ed25519 private key");
  }
  if (!isPayload(payload)) throw new CanonicalError("a signed payload carries a non-empty string `kind`");
  const bytes = canonicalBytes(payload);
  const publicKey = publicKeyText(privateKey);
  return {
    v: ENVELOPE_VERSION,
    algorithm: SIGNATURE_ALGORITHM,
    publicKey,
    fingerprint: fingerprintOf(publicKey),
    payload,
    signature: sign(null, bytes, privateKey).toString("base64url"),
  };
}

export type Verified =
  | { readonly ok: true; readonly envelope: SignedEnvelope }
  | { readonly ok: false; readonly reason: string };

const ENVELOPE_FIELDS = ["algorithm", "fingerprint", "payload", "publicKey", "signature", "v"];

/**
 * Valid: the envelope is well formed, its signature checks, **and it was signed by exactly
 * `expectedPublicKey`** — the one answer that means "this agent signed this". Never throws: whatever arrives,
 * a string, a cycle or a hostile nesting, comes back as `{ ok: false, reason }`.
 *
 * The key to check against is required on purpose (review L4): a signature on its own says only that the key
 * inside the envelope signed it, and anyone can make a key. Whose key it should be comes from somewhere else
 * — the agent card, a registration — and {@link checkEnvelope} is the name for the weaker question.
 */
export function verifyEnvelope(input: unknown, expectedPublicKey: string): Verified {
  const problem = publicKeyProblem(expectedPublicKey);
  if (problem !== undefined) return { ok: false, reason: `the key to check against is not usable: ${problem}` };
  const checked = checkEnvelope(input);
  if (!checked.ok) return checked;
  if (checked.envelope.publicKey !== expectedPublicKey) {
    return {
      ok: false,
      reason: `signed by a different key (fingerprint ${checked.envelope.fingerprint}, not ${fingerprintOf(expectedPublicKey)})`,
    };
  }
  return checked;
}

/**
 * Internally consistent: well formed, and signed by the key it carries. **Not** a verdict on whose key that
 * is — anybody can make a key and sign with it. Never throws.
 */
export function checkEnvelope(input: unknown): Verified {
  try {
    return check(input);
  } catch (error) {
    return { ok: false, reason: `malformed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function check(input: unknown): Verified {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "malformed: not a JSON object" };
  }
  const envelope = input as Record<string, unknown>;
  const fields = Object.keys(envelope).sort();
  if (fields.join(",") !== ENVELOPE_FIELDS.join(",")) {
    return { ok: false, reason: `malformed: an envelope has exactly the fields ${ENVELOPE_FIELDS.join(", ")} — this one has ${fields.join(", ") || "none"}` };
  }
  if (envelope["v"] !== ENVELOPE_VERSION) return { ok: false, reason: `unknown envelope version ${JSON.stringify(envelope["v"])}` };
  if (envelope["algorithm"] !== SIGNATURE_ALGORITHM) {
    return { ok: false, reason: `unknown algorithm ${JSON.stringify(envelope["algorithm"])} — only ${SIGNATURE_ALGORITHM} is accepted` };
  }
  const keyProblem = publicKeyProblem(envelope["publicKey"]);
  if (keyProblem !== undefined) return { ok: false, reason: `the envelope's publicKey is refused: ${keyProblem}` };
  const publicKey = envelope["publicKey"] as string;
  const key = fromBase64url(publicKey, 32)!;
  if (envelope["fingerprint"] !== fingerprintOf(publicKey)) {
    return { ok: false, reason: "malformed: the fingerprint is not the fingerprint of publicKey" };
  }
  const payload = envelope["payload"];
  if (!isPayload(payload)) return { ok: false, reason: "malformed: payload is not an object with a string kind" };
  const signature = fromBase64url(envelope["signature"], 64);
  if (signature === undefined) return { ok: false, reason: "malformed: signature is not 64 bytes of base64url" };
  if (littleEndian(signature.subarray(32)) >= GROUP_L) return { ok: false, reason: "the signature's S is not below the group order (non-canonical)" };
  if (isSmallOrder(signature.subarray(0, 32))) return { ok: false, reason: "the signature's R is a point of small order" };
  let bytes: Uint8Array;
  try {
    bytes = canonicalBytes(payload);
  } catch (error) {
    return { ok: false, reason: `malformed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const spki = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, key]), format: "der", type: "spki" });
  if (!verify(null, bytes, spki, signature)) {
    return { ok: false, reason: "the signature does not match — the payload was changed, or another key signed it" };
  }
  return { ok: true, envelope: envelope as unknown as SignedEnvelope };
}
