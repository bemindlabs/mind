/**
 * The key proof and the report's binding, below the CLI (S15.4 step one, D-141): the shapes a market, a listing,
 * a job and a nonce must have, the payload a proof signs, and every way a proof or a binding is refused.
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  checkKeyProof,
  KEY_PROOF_KIND,
  keyProofPayload,
  nonceProblem,
  proofProblem,
  targetProblem,
  verifyKeyProof,
} from "../../src/identity/proof.ts";
import { bindingMismatch, bindingProblem, reportProblem, usagePayload } from "../../src/identity/report.ts";
import { isJobId, isListingSlug, marketOriginProblem } from "../../src/identity/shapes.ts";
import { signEnvelope } from "../../src/identity/sign.ts";

const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const TARGET = { market: "https://market.example", listing: "ts-reviewer", nonce: NONCE };
const AT = new Date("2026-09-28T12:00:00.000Z");
const key = generateKeyPairSync("ed25519").privateKey;

describe("a market is named by its origin, written the one way (D-141)", () => {
  test.each([
    ["https://market.example"],
    ["https://market.example:8443"],
    ["https://127.0.0.1"],
    ["https://[::1]:8443"],
    ["https://xn--bcher-kva.example"],
    ["http://127.0.0.1"],
    ["http://127.0.0.1:30710"],
    ["http://localhost"],
    ["http://localhost:30710"],
  ])("%s is an origin", (origin) => {
    expect(marketOriginProblem(origin)).toBeUndefined();
  });

  test.each([
    ["", "is empty"],
    [7, "is empty"],
    [`https://${"a".repeat(300)}.example`, "longer than 300"],
    ["market.example", "not a URL"],
    ["http://market.example", "not https"],
    ["http://[::1]", "not https"],
    ["http://localhost.", "not https"],
    ["ftp://market.example", "not https"],
    ["data:text/plain,x", "not https"],
    ["https://owner@market.example", "user name or password"],
    ["https://owner:pw@market.example", "user name or password"],
    ["https://@market.example", "user name or password"],
    ["https://market.example?a=1", "query or a fragment"],
    ["https://market.example?", "query or a fragment"],
    ["https://market.example#top", "query or a fragment"],
    ["https://market.example/market", "has a path"],
    ["https://market.example/", "ends in /, which an origin does not — write https://market.example"],
    ["https://market.example.", "ends its host in a dot"],
    ["https://Market.Example", "write https://market.example"],
    ["HTTPS://market.example", "write https://market.example"],
    ["https://bücher.example", "write https://xn--bcher-kva.example"],
    ["https://market.example:443", "write https://market.example"],
    ["http://localhost:80", "write http://localhost"],
    ["https://m%61rket.example", "write https://market.example"],
    [" https://market.example", "write https://market.example"],
  ])("%p is refused: %s", (value, because) => {
    expect(marketOriginProblem(value)).toContain(because);
  });

  test("a listing is the platform's slug, and a job id a plain id", () => {
    for (const slug of ["ts-reviewer", "abc", "a-b", "a--b", "0x1", "a".repeat(40)]) expect(isListingSlug(slug), slug).toBe(true);
    for (const slug of ["ab", "a".repeat(41), "-ab", "ab-", "TS-reviewer", "ts_reviewer", "ts reviewer", "tš-x", 7]) expect(isListingSlug(slug), String(slug)).toBe(false);
    for (const job of ["job_01", "0f8fad5b-d9cb-469f-a165-70867728950e", "j", "a:b.c", "J".repeat(128)]) expect(isJobId(job), job).toBe(true);
    for (const job of ["", "_job", "job 1", "job/1", "J".repeat(129), "job‮1", null]) expect(isJobId(job), String(job)).toBe(false);
  });
});

describe("a nonce is 32 bytes of base64url, one spelling", () => {
  test("43 characters that decode to 32 bytes and encode back to themselves", () => {
    expect(nonceProblem(NONCE)).toBeUndefined();
    expect(nonceProblem("A".repeat(43))).toBeUndefined();
    expect(nonceProblem("-".repeat(42) + "A")).toBeUndefined();
    // The last character carries two spare bits, which must be zero: `B` sets one.
    expect(nonceProblem(`${"A".repeat(42)}B`)).toContain("one spelling");
    for (const bad of [NONCE.slice(1), `${NONCE}A`, `${NONCE.slice(0, 42)}=`, `${NONCE.slice(0, 42)}+`, `${NONCE.slice(0, 42)}/`, "", 32]) {
      expect(nonceProblem(bad), String(bad)).toContain("32 bytes of base64url");
    }
  });
});

describe("the proof's payload", () => {
  test("is exactly {kind, v, market, listing, nonce, at}, the instant from the caller's clock", () => {
    expect(keyProofPayload(TARGET, AT)).toEqual({ kind: KEY_PROOF_KIND, v: 1, market: TARGET.market, listing: TARGET.listing, nonce: NONCE, at: "2026-09-28T12:00:00.000Z" });
    expect(proofProblem(keyProofPayload(TARGET, AT))).toBeUndefined();
  });

  test("a target with a problem is said by field, and never signed", () => {
    expect(targetProblem(TARGET)).toBeUndefined();
    expect(targetProblem({ ...TARGET, market: "https://market.example/" })).toStartWith("market ends in /");
    expect(targetProblem({ ...TARGET, listing: "TS" })).toStartWith("listing is not a slug");
    expect(targetProblem({ ...TARGET, nonce: "short" })).toStartWith("nonce is not 32 bytes");
    expect(() => keyProofPayload({ ...TARGET, listing: "TS" }, AT)).toThrow("a key proof cannot name this: listing");
  });

  test.each([
    ["not an object", [], "not an object"],
    ["another kind", { kind: "mind.usage-report" }, `not ${KEY_PROOF_KIND}`],
    ["another version", { v: 2 }, "version 2 is not 1"],
    ["a field more", { extra: 1 }, "exactly the fields at, kind, listing, market, nonce, v"],
    ["a field fewer", { at: undefined }, "exactly the fields"],
    ["a market that is not a string", { market: 7 }, "not all strings"],
    ["a market with a path", { market: "https://market.example/x" }, "market has a path"],
    ["a listing that is not a slug", { listing: "a" }, "listing is not a slug"],
    ["a nonce of the wrong length", { nonce: "AAAA" }, "nonce is not 32 bytes"],
    ["an instant that is not one", { at: "today\u001b[8m" }, "at is not an ISO-8601"],
  ])("refuses %s", (_name, change, because) => {
    const payload = Array.isArray(change) ? change : JSON.parse(JSON.stringify({ ...keyProofPayload(TARGET, AT), ...change }));
    expect(proofProblem(payload)).toContain(because);
  });
});

describe("the kind", () => {
  test("a proof of the mind kind is a proof, and signs and verifies as one", () => {
    expect(KEY_PROOF_KIND).toBe("mind.key-proof");
    const payload = keyProofPayload(TARGET, AT);
    expect(payload.kind).toBe("mind.key-proof");
    expect(proofProblem(payload)).toBeUndefined();
    const text = JSON.stringify(signEnvelope(payload, key));
    const publicKey = (JSON.parse(text) as { publicKey: string }).publicKey;
    expect(verifyKeyProof(text, publicKey, TARGET).ok).toBe(true);
  });

  test("the kind with a version it never had is refused", () => {
    expect(proofProblem({ ...keyProofPayload(TARGET, AT), v: 2 })).toContain("version 2 is not 1");
  });

  test("a refusal prints the kind", () => {
    expect(proofProblem({ ...keyProofPayload(TARGET, AT), kind: "other.kind" })).toContain(`not ${KEY_PROOF_KIND}`);
  });
});

describe("checking a proof", () => {
  const text = JSON.stringify(signEnvelope(keyProofPayload(TARGET, AT), key));
  const publicKey = (JSON.parse(text) as { publicKey: string }).publicKey;

  test("valid only for this key, this market, this listing and this nonce", () => {
    expect(verifyKeyProof(text, publicKey, TARGET).ok).toBe(true);
    const reason = (result: ReturnType<typeof verifyKeyProof>) => (result.ok ? "valid" : result.reason);
    expect(reason(verifyKeyProof(text, publicKey, { ...TARGET, market: "http://localhost:30710" }))).toBe(
      "it proves the key for another market: https://market.example, not http://localhost:30710",
    );
    expect(reason(verifyKeyProof(text, publicKey, { ...TARGET, listing: "other" }))).toContain("another listing");
    expect(reason(verifyKeyProof(text, publicKey, { ...TARGET, nonce: "A".repeat(43) }))).toContain("another nonce");
    expect(reason(verifyKeyProof(text, "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", TARGET))).toContain("different key");
    expect(reason(verifyKeyProof(text, "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", TARGET))).toContain("key to check against is not usable");
  });

  test("consistent is not valid: the weaker check still refuses what is not a proof", () => {
    expect(checkKeyProof(text).ok).toBe(true);
    const reason = (result: ReturnType<typeof checkKeyProof>) => (result.ok ? "valid" : result.reason);
    expect(reason(checkKeyProof("{"))).toContain("not JSON a signature can be checked over");
    expect(reason(checkKeyProof(text.replace('"v":1,"market"', '"v":1.0,"market"')))).toContain("fraction or an exponent");
    expect(reason(checkKeyProof(text.replace('"listing":', '"listing":"x","listing":')))).toContain("duplicate member name");
    expect(reason(checkKeyProof(text.replace("ts-reviewer", "ts-reviewez")))).toContain("signature does not match");
    const report = JSON.stringify(signEnvelope(usagePayload([], {}, AT).payload, key));
    expect(reason(checkKeyProof(report))).toContain("not a key proof this version reads: the payload is of kind");
    const bad = JSON.stringify(signEnvelope({ ...keyProofPayload(TARGET, AT), market: "https://market.example/" }, key));
    expect(reason(checkKeyProof(bad))).toContain("market ends in /");
  });
});

describe("a report's binding (D-141 §2)", () => {
  const binding = { market: "https://market.example", listing: "ts-reviewer", job: null };

  test("null, or exactly {market, listing, job} in their shapes", () => {
    expect(bindingProblem(null)).toBeUndefined();
    expect(bindingProblem(binding)).toBeUndefined();
    expect(bindingProblem({ ...binding, job: "job_01" })).toBeUndefined();
    expect(bindingProblem(undefined)).toContain("not null or exactly {job, listing, market}");
    expect(bindingProblem([])).toContain("not null or exactly");
    expect(bindingProblem({ market: binding.market, listing: binding.listing })).toContain("not null or exactly");
    expect(bindingProblem({ ...binding, extra: 1 })).toContain("not null or exactly");
    expect(bindingProblem({ ...binding, market: "https://market.example/" })).toContain("binding.market ends in /");
    expect(bindingProblem({ ...binding, listing: "TS" })).toContain("binding.listing is not a listing's slug");
    expect(bindingProblem({ ...binding, job: "job 1\u001b" })).toContain("binding.job is not a job's id or null");
    expect(bindingProblem({ ...binding, job: 7 })).toContain("binding.job");
  });

  test("is signed with the rows, copied by name, and a bad one is never made", () => {
    const given = { ...binding, job: "job_01", note: "not copied" } as unknown as typeof binding;
    expect(() => usagePayload([], {}, AT, given)).toThrow("a report cannot be bound so");
    const { payload } = usagePayload([], {}, AT, { ...binding, job: "job_01" });
    expect(payload.binding).toEqual({ ...binding, job: "job_01" });
    expect(Object.keys(payload)).toEqual(["kind", "v", "generated_at", "since", "until", "binding", "rows"]);
    expect(() => usagePayload([], {}, AT, { ...binding, market: "http://market.example" })).toThrow("not https");
  });

  test("a report must carry it — null or not — and a reader holds it to its shape", () => {
    const { payload } = usagePayload([], {}, AT, binding);
    expect(reportProblem(payload)).toBeUndefined();
    const { binding: _gone, ...without } = payload;
    expect(reportProblem(without)).toContain("exactly the fields binding, generated_at, kind, rows, since, until, v");
    expect(reportProblem({ ...payload, binding: { ...binding, listing: "Bad" } })).toContain("binding.listing");
  });

  test("pinned to a market and listing: both must match, and a report bound to nothing never does", () => {
    const pins = { market: binding.market, listing: binding.listing };
    expect(bindingMismatch(binding, pins)).toBeUndefined();
    expect(bindingMismatch({ ...binding, job: "job_01" }, pins)).toBeUndefined();
    expect(bindingMismatch(null, pins)).toContain("bound to no market");
    expect(bindingMismatch(binding, { ...pins, market: "https://other.example" })).toBe("it is bound to another market: https://market.example, not https://other.example");
    expect(bindingMismatch(binding, { ...pins, listing: "other" })).toBe("it is bound to another listing: ts-reviewer, not other");
  });
});
