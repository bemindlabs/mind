/**
 * S15.8 — signing a payload with the agent's own ed25519 key, and checking one (D-106, D-108, D-138).
 *
 * Three kinds of evidence, because a signature scheme can be wrong in three ways that each look fine alone:
 *
 * - **The bytes.** The canonical form is a contract with a verifier in another language, so it is pinned as
 *   literal strings — key order by UTF-16 code units, the escapes JCS uses, integers only — and one whole
 *   envelope is pinned as a vector: RFC 8032's test-1 seed, a fixed payload, a fixed signature. Ed25519 is
 *   deterministic, so the marketplace (S16.4) can check its verifier against exactly these values.
 * - **Another implementation.** WebCrypto's Ed25519 verifies what this module signs, and this module verifies
 *   what WebCrypto signs — both directions, so neither side is only agreeing with itself.
 * - **Hostile input.** `verifyEnvelope` is handed tampered payloads, wrong keys, unknown algorithms,
 *   non-canonical base64, cycles, throwing getters and proxies, and must answer `ok: false` every time
 *   without throwing.
 * - **Keys anyone can sign for** (security review, M1). The identity point, the other points of small order
 *   and non-canonical encodings are refused as keys — in an envelope and as the key to check against — and
 *   a signature whose `S` is not below `L` or whose `R` has small order is refused too. They are pinned below
 *   the fixed vector as vectors of their own, with the forgery that works against the library underneath
 *   shown working, so the reason for the check is in the test and not only in a comment.
 */

import { describe, expect, test } from "bun:test";
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify as nodeVerify } from "node:crypto";
import {
  CanonicalError,
  canonicalBytes,
  canonicalJson,
  checkEnvelope,
  fingerprintOf,
  isSmallOrder,
  publicKeyBytes,
  publicKeyProblem,
  publicKeyText,
  signEnvelope,
  verifyEnvelope,
  type SignedEnvelope,
} from "../../src/identity/sign.ts";

/** RFC 8032 §7.1, TEST 1: the secret key, and the public key it must give. */
const RFC_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_PUBLIC_HEX = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

function rfcKey() {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(RFC_SEED, "hex")]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

const freshKey = () => generateKeyPairSync("ed25519").privateKey;

const VECTOR_PAYLOAD = { kind: "mind.test-vector", v: 1, s: 'café ✓ "q" \\ \n', list: [3, 1, 2], nested: { b: null, a: true, z: -7 } };

describe("the canonical form — the bytes a verifier must rebuild", () => {
  test("members by UTF-16 code units, arrays in order, no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [3, 1, 2], A: { d: null, c: false } })).toBe('{"A":{"c":false,"d":null},"a":[3,1,2],"b":1}');
    // Code units, not code points: U+1F600 is the pair D83D DE00, which sorts before U+FFFF. That is JCS's
    // rule, and the one place Python's sort_keys (by code point) would differ — never in Mind's names.
    expect(canonicalJson({ "\uFFFF": 1, "😀": 2, é: 3, z: 4 })).toBe('{"z":4,"é":3,"😀":2,"\uFFFF":1}');
  });

  test("strings are written as JSON.stringify writes them: short escapes, lower-case \\u00xx, the rest literal", () => {
    expect(canonicalJson('"\\\b\f\n\r\t\u0001\u001f')).toBe('"\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f"');
    expect(canonicalJson("a/b \u007f \u2028 \u2029 é ✓ 😀")).toBe('"a/b \u007f \u2028 \u2029 é ✓ 😀"');
    expect(new TextDecoder().decode(canonicalBytes({ kind: "é" }))).toBe('{"kind":"é"}');
    expect([...canonicalBytes("é")]).toEqual([0x22, 0xc3, 0xa9, 0x22]);
  });

  test("integers only, up to 2^53 − 1; -0 is 0", () => {
    expect(canonicalJson([0, -0, -7, 2 ** 53 - 1, -(2 ** 53 - 1)])).toBe(`[0,0,-7,${2 ** 53 - 1},${-(2 ** 53 - 1)}]`);
    for (const bad of [1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, 1e21]) {
      expect(() => canonicalJson({ n: bad }), String(bad)).toThrow(CanonicalError);
    }
  });

  test("nothing that is not JSON: undefined, functions, bigint, dates, maps, class instances, lone surrogates, depth", () => {
    class Thing {
      readonly x = 1;
    }
    const cases: unknown[] = [
      { a: undefined },
      [undefined],
      { f: () => 1 },
      { n: 1n },
      { d: new Date(0) },
      { m: new Map() },
      new Thing(),
      Symbol("s"),
      "\uD800",
      "x\uDC00",
      { "\uD83D": 1 },
    ];
    for (const value of cases) expect(() => canonicalJson(value)).toThrow(CanonicalError);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/nested deeper/);
    // A well-formed pair is fine, and so is an object without a prototype.
    expect(canonicalJson("😀")).toBe('"😀"');
    const bare = Object.create(null) as Record<string, number>;
    bare["k"] = 1;
    expect(canonicalJson(bare)).toBe('{"k":1}');
  });

  test("the pinned vector: this seed and this payload give exactly these bytes and this signature", () => {
    expect(canonicalJson(VECTOR_PAYLOAD)).toBe('{"kind":"mind.test-vector","list":[3,1,2],"nested":{"a":true,"b":null,"z":-7},"s":"café ✓ \\"q\\" \\\\ \\n","v":1}');
    const envelope = signEnvelope(VECTOR_PAYLOAD, rfcKey());
    expect(envelope).toEqual({
      v: 1,
      algorithm: "ed25519",
      publicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
      fingerprint: "21fe31dfa154a261",
      payload: VECTOR_PAYLOAD,
      signature: "A60sRMlS_2VV707bNa8yaPqE8zquP_ssGcd8g3K59yml6Do8QUslzCJSlx2z6gU_40746ynls8QrtTQv5HynCw",
    });
    expect(verifyEnvelope(envelope, "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo").ok).toBe(true);
  });
});

describe("keys and fingerprints", () => {
  test("the public key is RFC 8032's, from either half of the key", () => {
    const key = rfcKey();
    const text = publicKeyText(key);
    expect(publicKeyBytes(text)!.toString("hex")).toBe(RFC_PUBLIC_HEX);
    expect(publicKeyText(generateKeyPairSync("ed25519").publicKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("the fingerprint is 16 hex of SHA-256 over the raw key; a non-key is refused", () => {
    const text = publicKeyText(rfcKey());
    const expected = new Bun.CryptoHasher("sha256").update(Buffer.from(RFC_PUBLIC_HEX, "hex")).digest("hex").slice(0, 16);
    expect(fingerprintOf(text)).toBe(expected);
    expect(() => fingerprintOf("short")).toThrow(CanonicalError);
  });

  test("base64url is read strictly: padding, other alphabets, wrong lengths and non-canonical spellings are not keys", () => {
    const text = publicKeyText(rfcKey());
    expect(publicKeyBytes(text)).toBeDefined();
    expect(publicKeyBytes(`${text}=`)).toBeUndefined();
    expect(publicKeyBytes(text.replace(/-/g, "+").replace(/_/g, "/") + "+")).toBeUndefined();
    expect(publicKeyBytes(text.slice(1))).toBeUndefined();
    expect(publicKeyBytes(42)).toBeUndefined();
    // The last character carries 4 unused bits: flipping one gives the same bytes and a different text.
    const last = text.at(-1)!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const sibling = alphabet[alphabet.indexOf(last) ^ 1]!;
    expect(publicKeyBytes(text.slice(0, -1) + sibling)).toBeUndefined();
  });
});

describe("sign and verify, both directions and against another implementation", () => {
  test("what this module signs, it verifies — and only with the key that signed it", () => {
    const key = freshKey();
    const envelope = signEnvelope({ kind: "mind.test", n: 1 }, key);
    expect(checkEnvelope(envelope)).toEqual({ ok: true, envelope });
    expect(verifyEnvelope(envelope, envelope.publicKey)).toEqual({ ok: true, envelope });
    // The same object after a trip through JSON, which is how it actually travels.
    expect(verifyEnvelope(JSON.parse(JSON.stringify(envelope)), envelope.publicKey).ok).toBe(true);
    const other = publicKeyText(freshKey());
    const wrong = verifyEnvelope(envelope, other);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain("different key");
  });

  test("WebCrypto verifies what this module signs", async () => {
    const envelope = signEnvelope({ kind: "mind.test", rows: [{ a: 1 }] }, freshKey());
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKeyBytes(envelope.publicKey)!), { name: "Ed25519" }, false, ["verify"]);
    const signature = new Uint8Array(Buffer.from(envelope.signature, "base64url"));
    expect(await crypto.subtle.verify({ name: "Ed25519" }, key, signature, canonicalBytes(envelope.payload))).toBe(true);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, key, signature, canonicalBytes({ ...envelope.payload, extra: 1 }))).toBe(false);
  });

  test("this module verifies what WebCrypto signs, and refuses it once changed", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
    const payload = { kind: "mind.test", made: "by webcrypto", n: 7 };
    const signature = Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, canonicalBytes(payload)));
    const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url");
    const envelope = { v: 1, algorithm: "ed25519", publicKey, fingerprint: fingerprintOf(publicKey), payload, signature: signature.toString("base64url") };
    expect(verifyEnvelope(envelope, publicKey).ok).toBe(true);
    expect(checkEnvelope({ ...envelope, payload: { ...payload, n: 8 } }).ok).toBe(false);
  });

  test("signing refuses a public key, another algorithm's key, and a payload with no kind or no canonical form", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    expect(() => signEnvelope({ kind: "x" }, publicKey)).toThrow(CanonicalError);
    expect(() => signEnvelope({ kind: "x" }, generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey)).toThrow(CanonicalError);
    expect(() => signEnvelope({ kind: "" }, privateKey)).toThrow(CanonicalError);
    expect(() => signEnvelope({ n: 1 } as never, privateKey)).toThrow(CanonicalError);
    expect(() => signEnvelope({ kind: "x", n: 0.5 }, privateKey)).toThrow(CanonicalError);
  });
});

describe("verify rejects, and never throws", () => {
  const good: SignedEnvelope = signEnvelope({ kind: "mind.test", n: 1, s: "text" }, rfcKey());

  const reasonOf = (input: unknown, key?: string) => {
    const verified = key === undefined ? checkEnvelope(input) : verifyEnvelope(input, key);
    expect(verified.ok).toBe(false);
    return verified.ok ? "" : verified.reason;
  };

  test("a tampered payload, a swapped signature, a swapped key", () => {
    expect(reasonOf({ ...good, payload: { ...good.payload, n: 2 } })).toContain("does not match");
    expect(reasonOf({ ...good, payload: { ...good.payload, extra: true } })).toContain("does not match");
    const other = signEnvelope({ kind: "mind.test", n: 2, s: "text" }, rfcKey());
    expect(reasonOf({ ...good, signature: other.signature })).toContain("does not match");
    // Another key's public half, with its own fingerprint so only the signature can catch it.
    const stranger = publicKeyText(freshKey());
    expect(reasonOf({ ...good, publicKey: stranger, fingerprint: fingerprintOf(stranger) })).toContain("does not match");
    expect(reasonOf({ ...good, signature: Buffer.concat([Buffer.from(good.signature, "base64url").subarray(0, 32), Buffer.alloc(32)]).toString("base64url") })).toContain("does not match");
  });

  test("unknown algorithms and versions, and envelopes with fields missing or added", () => {
    expect(reasonOf({ ...good, algorithm: "Ed25519" })).toContain("unknown algorithm");
    expect(reasonOf({ ...good, algorithm: "rsa-sha256" })).toContain("unknown algorithm");
    expect(reasonOf({ ...good, v: 2 })).toContain("unknown envelope version");
    const { signature: _dropped, ...missing } = good;
    expect(reasonOf(missing)).toContain("exactly the fields");
    expect(reasonOf({ ...good, note: "unsigned words" })).toContain("exactly the fields");
  });

  test("malformed keys, fingerprints, signatures and payloads", () => {
    expect(reasonOf({ ...good, publicKey: "short" })).toContain("publicKey");
    expect(reasonOf({ ...good, fingerprint: "0000000000000000" })).toContain("fingerprint");
    expect(reasonOf({ ...good, signature: `${good.signature}=` })).toContain("signature");
    expect(reasonOf({ ...good, signature: 7 })).toContain("signature");
    expect(reasonOf({ ...good, payload: "text" })).toContain("payload");
    expect(reasonOf({ ...good, payload: { n: 1 } })).toContain("payload");
    expect(reasonOf({ ...good, payload: { kind: "x", n: 1.5 } })).toContain("malformed");
    expect(reasonOf(good, "not-a-key")).toContain("not 32 bytes");
    // The weaker question never answers the stronger one: a consistent envelope under another key is refused.
    expect(reasonOf(good, publicKeyText(freshKey()))).toContain("different key");
  });

  test("whatever arrives — including a cycle, a throwing getter and a hostile proxy — comes back ok: false", () => {
    const cycle: Record<string, unknown> = { kind: "x" };
    cycle["self"] = cycle;
    const getter = { ...good, payload: { kind: "x", get boom(): never { throw new Error("boom"); } } };
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("no keys for you"); } });
    const inputs: unknown[] = [null, undefined, 42, "text", true, [], [good], {}, { ...good, payload: cycle }, getter, proxy];
    for (const input of inputs) {
      let verified;
      expect(() => (verified = checkEnvelope(input))).not.toThrow();
      expect(verified!.ok).toBe(false);
      expect(() => (verified = verifyEnvelope(input, good.publicKey))).not.toThrow();
      expect(verified!.ok).toBe(false);
    }
  });
});

/**
 * The vectors verify must refuse (security review, M1) — for the marketplace's verifier as much as for this one.
 * Each is a 32-byte key encoding or a signature, in hex; the payload is the fixed vector's.
 */
const REFUSED_KEYS: readonly (readonly [string, string])[] = [
  ["the identity point (order 1)", "0100000000000000000000000000000000000000000000000000000000000000"],
  ["the identity with its sign bit set", "0100000000000000000000000000000000000000000000000000000000000080"],
  ["y = 0 (order 4)", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["y = 0, sign bit set (order 4)", "0000000000000000000000000000000000000000000000000000000000000080"],
  ["an order-8 point", "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"],
  ["an order-8 point, sign bit set", "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85"],
  ["the other order-8 point", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"],
  ["the other order-8 point, sign bit set", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa"],
  ["y = p − 1 (order 2)", "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"],
  ["y = p, a non-canonical 0", "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"],
  ["y = p + 1, a non-canonical 1", "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"],
  ["y = p + 2, non-canonical", "efffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"],
  ["y = 2^255 − 1, non-canonical", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"],
];

/** The forgery: the identity as the key, and R = identity, S = 0 — true for every payload under plain Ed25519. */
const IDENTITY = "0100000000000000000000000000000000000000000000000000000000000000";
const FORGED_SIGNATURE = `${IDENTITY}${"00".repeat(32)}`;
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64url");
/** L, the group order, little-endian — added to a valid S it gives the same point and a non-canonical S. */
const L_HEX = "edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010";

function forged(keyHex: string, signatureHex: string): Record<string, unknown> {
  const publicKey = b64(keyHex);
  return {
    v: 1,
    algorithm: "ed25519",
    publicKey,
    fingerprint: new Bun.CryptoHasher("sha256").update(Buffer.from(keyHex, "hex")).digest("hex").slice(0, 16),
    payload: VECTOR_PAYLOAD,
    signature: b64(signatureHex),
  };
}

function addLittleEndian(aHex: string, bHex: string): string {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  const out = Buffer.alloc(32);
  let carry = 0;
  for (let i = 0; i < 32; i++) {
    const sum = a[i]! + b[i]! + carry;
    out[i] = sum & 0xff;
    carry = sum >> 8;
  }
  return out.toString("hex");
}

describe("M1 — keys and signatures anyone could make are refused", () => {
  test("the forgery is real against the library underneath: identity key, R = identity, S = 0 verifies any payload", () => {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(IDENTITY, "hex")]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    for (const payload of [VECTOR_PAYLOAD, { kind: "anything", n: 1 }]) {
      expect(nodeVerify(null, canonicalBytes(payload), key, Buffer.from(FORGED_SIGNATURE, "hex"))).toBe(true);
    }
    // …and refused here, as the envelope's key and as a pinned one.
    const envelope = forged(IDENTITY, FORGED_SIGNATURE);
    const checked = checkEnvelope(envelope);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain("small order");
    const pinned = verifyEnvelope(envelope, b64(IDENTITY));
    expect(pinned.ok).toBe(false);
    if (!pinned.ok) expect(pinned.reason).toContain("not usable");
  });

  test("every small-order point and non-canonical encoding is refused as a key, in an envelope and pinned", () => {
    for (const [name, hex] of REFUSED_KEYS) {
      expect(publicKeyProblem(b64(hex)), name).toBeDefined();
      expect(publicKeyBytes(b64(hex)), name).toBeUndefined();
      expect(checkEnvelope(forged(hex, FORGED_SIGNATURE)).ok, name).toBe(false);
      expect(verifyEnvelope(signEnvelope(VECTOR_PAYLOAD, rfcKey()), b64(hex)).ok, name).toBe(false);
    }
    // The order-2 point verifies about half of all payloads under plain Ed25519; here, none.
    expect(publicKeyProblem(b64("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"))).toContain("small order");
    expect(publicKeyProblem(b64("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"))).toContain("non-canonical");
  });

  test("an honest key passes whichever its sign bit, and the checks do not reach past the first 32 bytes", () => {
    let seen = new Set<number>();
    for (let i = 0; i < 64 && seen.size < 2; i++) {
      const text = publicKeyText(freshKey());
      expect(publicKeyProblem(text)).toBeUndefined();
      seen = seen.add(Buffer.from(text, "base64url")[31]! >> 7);
    }
    expect(seen.size).toBe(2);
    expect(isSmallOrder(new Uint8Array(31))).toBe(false);
  });

  test("a signature whose S is not below L, or whose R has small order, is refused", () => {
    const envelope = signEnvelope(VECTOR_PAYLOAD, rfcKey());
    const signature = Buffer.from(envelope.signature, "base64url").toString("hex");
    const r = signature.slice(0, 64);
    const bigS = addLittleEndian(signature.slice(64), L_HEX);
    const malleable = { ...envelope, signature: b64(`${r}${bigS}`) };
    const refused = checkEnvelope(malleable);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("S is not below");

    const smallR = checkEnvelope({ ...envelope, signature: b64(`${IDENTITY}${signature.slice(64)}`) });
    expect(smallR.ok).toBe(false);
    if (!smallR.ok) expect(smallR.reason).toContain("R is a point of small order");
  });
});

