/**
 * A signed key proof, pinned for the platform's registration check (D-141 §1).
 *
 * `test/fixtures/key-proof-v1.json` is exactly what `mind key prove --json` prints for the market, listing
 * and nonce below at the fixed instant below, signed with RFC 8032's test-1 key (its public key is
 * `test/fixtures/key-proof-v1.key`, the same key as the usage-report vectors). Ed25519 is deterministic, so
 * this test rebuilds the proof and requires the same bytes: a change to the payload, the canonical JSON or the
 * envelope cannot pass quietly — it has to change the fixture, which the platform then sees.
 *
 * The platform ports the file and holds its own verifier to what this one does: valid for exactly this key,
 * market, listing and nonce; refused for any other of them, for a changed byte, and for a respelled number,
 * whose signature still verifies because the canonical bytes are unchanged.
 *
 * To regenerate after a deliberate change: `MIND_WRITE_VECTOR=1 bun test test/identity/proof-vector.test.ts`,
 * then say in the PR what changed, because the platform's copy has to change with it.
 */

import { describe, expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import { join, resolve } from "node:path";
import { KEY_PROOF_KIND, keyProofPayload, verifyKeyProof } from "../../src/identity/proof.ts";
import { signEnvelope, verifyEnvelope } from "../../src/identity/sign.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const PROOF = join(ROOT, "test", "fixtures", "key-proof-v1.json");
const KEY = join(ROOT, "test", "fixtures", "key-proof-v1.key");

/** RFC 8032 §7.1, TEST 1 — the seed `sign.test.ts` and `report-vector.test.ts` pin. */
const RFC_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_PUBLIC = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const rfcKey = () =>
  createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(RFC_SEED, "hex")]), format: "der", type: "pkcs8" });

/** The challenge: bytes 0x00…0x1f as the platform would send them, base64url without padding. */
const NONCE = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url");
const TARGET = { market: "https://market.example", listing: "ts-reviewer", nonce: NONCE };
const AT = new Date("2026-09-28T12:00:00.000Z");

/** As `key prove --json` prints it: the envelope, one compact line. */
const build = () => `${JSON.stringify(signEnvelope(keyProofPayload(TARGET, AT), rfcKey()))}\n`;

describe("the pinned key proof (for the platform's registration check)", () => {
  test("this build makes exactly the committed bytes, and they verify for exactly this key, market, listing and nonce", async () => {
    const made = build();
    if (process.env["MIND_WRITE_VECTOR"] === "1") {
      await Bun.write(PROOF, made);
      await Bun.write(KEY, `${RFC_PUBLIC}\n`);
    }
    const text = await Bun.file(PROOF).text();
    expect(made).toBe(text);
    const key = (await Bun.file(KEY).text()).trim();
    expect(key).toBe(RFC_PUBLIC);
    expect(NONCE).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    const checked = verifyKeyProof(text, key, TARGET);
    if (!checked.ok) throw new Error(checked.reason);
    expect(checked.payload).toEqual({ kind: KEY_PROOF_KIND, v: 1, market: TARGET.market, listing: TARGET.listing, nonce: NONCE, at: "2026-09-28T12:00:00.000Z" });
    expect(text.split("\n")).toHaveLength(2);
    // The payload's members in the order the command writes them; the signature is over their canonical order.
    expect(text).toContain(`"payload":{"kind":"mind.key-proof","v":1,"market":"https://market.example","listing":"ts-reviewer","nonce":"${NONCE}","at":"2026-09-28T12:00:00.000Z"}`);
  });

  test("any other market, listing, nonce or key is refused — and so is a respelled number whose signature still checks", async () => {
    const text = await Bun.file(PROOF).text();
    const refusedFor = (why: string, result: ReturnType<typeof verifyKeyProof>) => {
      expect(result.ok, why).toBe(false);
      return result.ok ? "" : result.reason;
    };
    expect(refusedFor("market", verifyKeyProof(text, RFC_PUBLIC, { ...TARGET, market: "https://other.example" }))).toContain("another market");
    expect(refusedFor("listing", verifyKeyProof(text, RFC_PUBLIC, { ...TARGET, listing: "ts-reviewer-2" }))).toContain("another listing");
    expect(refusedFor("nonce", verifyKeyProof(text, RFC_PUBLIC, { ...TARGET, nonce: "A".repeat(43) }))).toContain("another nonce");
    const stranger = signEnvelope(keyProofPayload(TARGET, AT), createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" }));
    expect(refusedFor("key", verifyKeyProof(text, stranger.publicKey, TARGET))).toContain("different key");
    expect(refusedFor("changed", verifyKeyProof(text.replace('"listing":"ts-reviewer"', '"listing":"ts-reviewer-2"'), RFC_PUBLIC, { ...TARGET, listing: "ts-reviewer-2" }))).toContain("signature does not match");

    const respelled = text.replace('"v":1,"market"', '"v":1.0,"market"');
    expect(respelled).not.toBe(text);
    expect(verifyEnvelope(JSON.parse(respelled), RFC_PUBLIC).ok).toBe(true);
    expect(refusedFor("respelled", verifyKeyProof(respelled, RFC_PUBLIC, TARGET))).toContain("fraction or an exponent");
  });
});

describe("what the engine emits is the fixture, byte for byte", () => {
  test("the payload and the signed bytes equal key-proof-v1.json, whose kind is mind.key-proof", async () => {
    const text = await Bun.file(PROOF).text();
    const fixture = JSON.parse(text) as { payload: { kind: string } };
    expect(fixture.payload.kind).toBe("mind.key-proof");
    expect(keyProofPayload(TARGET, AT)).toEqual(fixture.payload as ReturnType<typeof keyProofPayload>);
    expect(build()).toBe(text);
  });
});
