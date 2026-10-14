/**
 * The Agent Card — what another agent learns about this one before talking
 * to it (S8.1, A2A 1.0.0, D-016).
 *
 * Built from the soul, never written by hand (AC1), and built from **half** of
 * it: `role.md` only. `person.md` is personal traits and, since D-046, the
 * name of whoever the identity inherits from — none of it goes on a card that
 * anyone who can reach the URL may read (AC2, I-6). The card says the agent is
 * an AI in its description and in a skill tag (I-5), because a peer reading
 * only one of them should not miss it.
 *
 * Nothing here serves the card — `mind a2a serve` does (S8.2) — and nothing
 * here reads a disk: this module only computes the JSON.
 *
 * ## The agent's public key (S15.8, D-108)
 *
 * The card announces the agent's own ed25519 public key, the one that signs its
 * usage reports, as an A2A extension in `capabilities.extensions` — the place
 * A2A gives a card for what the protocol does not define, so a client that
 * does not know the extension still reads the rest of the card. The key comes
 * in as an argument, read by the caller and never made by it: serving or
 * printing a card creates nothing. With no usable key the extension is still
 * there and says so, with nulls, because a card that simply lacked it would
 * read the same as one from before keys existed.
 */

import { renderSoul } from "../soul/render.ts";
import { sha256 } from "../soul/block.ts";
import type { Soul } from "../soul/schema.ts";

/** The protocol version Mind speaks — the same pin bwoc-a2a has. */
export const A2A_PROTOCOL_VERSION = "1.0.0";

/** Where the card is served, relative to the agent's base URL. */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

/** The loopback default in Mind's port block (D-005: 30700–30799). */
export const DEFAULT_A2A_URL = "http://127.0.0.1:30700";

/** The extension that carries the agent's public key (S15.8). A URN: it names the format, and is not a page to fetch. */
export const AGENT_KEY_EXTENSION = "urn:mind:agent-key:v1";

/** The tag on the card's one skill. It goes to every peer that fetches the card, and a market may index tags. */
export const CARD_TAG = "mind";

/** The public half of the agent's key, as a card announces it. Never the private half. */
export interface CardKey {
  readonly algorithm: "ed25519";
  /** 32 raw bytes, base64url. */
  readonly publicKey: string;
  /** 16 hex of SHA-256 over the raw key — for a person to compare, not to pin. */
  readonly fingerprint: string;
}

/** A2A's AgentExtension, as this card fills it. */
export interface AgentKeyExtension {
  readonly uri: string;
  readonly description: string;
  readonly required: false;
  readonly params:
    | { readonly algorithm: "ed25519"; readonly publicKey: string; readonly fingerprint: string }
    | { readonly algorithm: null; readonly publicKey: null; readonly fingerprint: null };
}

/** A2A 1.0.0 AgentCard, the subset Mind fills. */
export interface AgentCard {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly version: string;
  readonly protocolVersion: string;
  readonly capabilities: {
    readonly streaming: boolean;
    readonly pushNotifications: boolean;
    readonly extensions: readonly AgentKeyExtension[];
  };
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly { readonly id: string; readonly name: string; readonly description: string; readonly tags: readonly string[] }[];
}

/** The sentence every card carries (I-5). */
export const AI_DISCLOSURE = "An AI agent, not a person.";

/**
 * Compute the card. Pure.
 *
 * `version` is the first 12 hex of the rendered soul's sha256: a peer can see
 * the identity changed without being told what it holds. It does not move with
 * the key: the key is who signs, the version is what the soul says.
 *
 * @param key The agent's public key as the caller read it, or null when there
 *   is none it may use — which the card then says.
 */
export function agentCard(soul: Soul, url: string = DEFAULT_A2A_URL, key: CardKey | null = null): AgentCard {
  const role = soul.role;
  return {
    name: role.name,
    description: `${AI_DISCLOSURE} ${role.role}`,
    url,
    version: sha256(renderSoul(soul)).slice(0, 12),
    protocolVersion: A2A_PROTOCOL_VERSION,
    capabilities: { streaming: false, pushNotifications: false, extensions: [keyExtension(key)] },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "role",
        name: role.role,
        description: `Does: ${role.scope.does}. Does not: ${role.scope.does_not}.`,
        tags: ["ai-agent", CARD_TAG],
      },
    ],
  };
}

/** The extension, with the key or with nulls — never absent, so "no key" is said rather than implied. */
export function keyExtension(key: CardKey | null): AgentKeyExtension {
  if (key === null) {
    return {
      uri: AGENT_KEY_EXTENSION,
      description: "This agent has no usable signing key yet, so nothing it reports is signed.",
      required: false,
      params: { algorithm: null, publicKey: null, fingerprint: null },
    };
  }
  return {
    uri: AGENT_KEY_EXTENSION,
    description:
      "This agent's own ed25519 public key. It signs the agent's usage reports; check one with " +
      "`mind usage verify <file> --key <publicKey>`.",
    required: false,
    params: { algorithm: key.algorithm, publicKey: key.publicKey, fingerprint: key.fingerprint },
  };
}
