/**
 * S8.1 — the Agent Card, from the soul and only from `role.md` (D-016).
 *
 * AC1: built from the soul, never by hand — the same soul gives the same card,
 * and the card moves when the soul does. AC2: it says it is an AI, and nothing
 * from `person.md` — voice, principles, the name of whoever the identity
 * inherits from — is anywhere in it. AC3, a real A2A client reading it, is
 * `card.interop.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { A2A_PROTOCOL_VERSION, AGENT_KEY_EXTENSION, AI_DISCLOSURE, CARD_TAG, agentCard, DEFAULT_A2A_URL } from "../../src/a2a/card.ts";
import { generateKeyPairSync } from "node:crypto";
import { fingerprintOf, publicKeyText } from "../../src/identity/sign.ts";
import { loadSoul } from "../../src/soul/load.ts";
import { subjectId } from "../../src/types.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "soul-inherits");

async function soul() {
  const loaded = await loadSoul(FIXTURE, subjectId("ledger-aide"));
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return loaded.soul;
}

describe("S8.1 — the card", () => {
  test("AC1: the A2A 1.0.0 fields, filled from role.md", async () => {
    const s = await soul();
    const card = agentCard(s);
    expect(card.name).toBe("Ledger Aide");
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    expect(card.url).toBe(DEFAULT_A2A_URL);
    expect(card.skills[0]!.description).toContain(s.role.scope.does);
    expect(card.version).toMatch(/^[0-9a-f]{12}$/);
    expect(agentCard(s, "http://127.0.0.1:30701").url).toBe("http://127.0.0.1:30701");
  });

  test("AC1: same soul, same card; a changed soul, a changed version", async () => {
    const s = await soul();
    expect(agentCard(s)).toEqual(agentCard(s));
    const changed = { ...s, role: { ...s.role, role: `${s.role.role} and payroll` } };
    expect(agentCard(changed).version).not.toBe(agentCard(s).version);
  });

  test("AC2: it says it is an AI, in the description and in a tag", async () => {
    const card = agentCard(await soul());
    expect(card.description.startsWith(AI_DISCLOSURE)).toBe(true);
    expect(card.skills.every((skill) => skill.tags.includes("ai-agent"))).toBe(true);
  });

  test("the product tag on the card is `mind`", async () => {
    expect(CARD_TAG).toBe("mind");
    const card = agentCard(await soul());
    for (const skill of card.skills) expect(skill.tags).toEqual(["ai-agent", "mind"]);
  });

  test("AC2: nothing from person.md is in it — not a trait, not a principle, not the source person", async () => {
    const s = await soul();
    const json = JSON.stringify(agentCard(s));
    const personal = [
      ...s.person.tone,
      s.person.addresses_user_as,
      ...s.person.refers_to_self_as,
      ...s.person.principles,
      ...s.person.inherits_from,
      ...s.person.inherits_from.flatMap((name) => name.split(" ")),
    ].filter((word) => word.length >= 4);
    expect(personal.length).toBeGreaterThan(3);
    for (const word of personal) expect(json, word).not.toContain(word);
    // Nor the role's own body, which is free prose and not a public listing.
    expect(json).not.toContain("Reconcile the bank feed");
  });
});

describe("S15.8 — the card announces the agent's public key, and says so when there is none (D-108)", () => {
  test("no key: the extension is there with nulls, and says nothing it reports is signed", async () => {
    const card = agentCard(await soul());
    const one = (uri: string) => ({
      uri,
      description: expect.stringContaining("no usable signing key") as unknown as string,
      required: false as const,
      params: { algorithm: null, publicKey: null, fingerprint: null },
    });
    expect(AGENT_KEY_EXTENSION).toBe("urn:mind:agent-key:v1");
    expect(card.capabilities.extensions).toEqual([one(AGENT_KEY_EXTENSION)]);
  });

  test("a key: its algorithm, public key and fingerprint — never the private half, and the version does not move", async () => {
    const s = await soul();
    const { privateKey } = generateKeyPairSync("ed25519");
    const publicKey = publicKeyText(privateKey);
    const card = agentCard(s, DEFAULT_A2A_URL, { algorithm: "ed25519", publicKey, fingerprint: fingerprintOf(publicKey) });
    expect(card.capabilities.extensions).toHaveLength(1);
    const [extension] = card.capabilities.extensions;
    expect(extension!.uri).toBe(AGENT_KEY_EXTENSION);
    expect(extension!.required).toBe(false);
    expect(extension!.params).toEqual({ algorithm: "ed25519", publicKey, fingerprint: fingerprintOf(publicKey) });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const json = JSON.stringify(card);
    for (const line of pem.split("\n").filter((l) => l !== "" && !l.startsWith("-----"))) expect(json).not.toContain(line);
    expect(json).not.toContain("PRIVATE");
    // The key is who signs; the version is what the soul says. One does not move the other.
    expect(card.version).toBe(agentCard(s).version);
    // Still the A2A fields a client reads, untouched beside it.
    expect(card.capabilities.streaming).toBe(false);
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
  });
});
