/**
 * S8.4 — who this agent may talk to (D-063).
 *
 * An allowlist, never a denylist: a peer that is not on it is refused both
 * ways. A peer is added only by a person typing a phrase at a terminal — the
 * same shape as level 3 (D-042) — so an agent acting on its own cannot widen
 * its own reach (AC2, D-015, I-6). What a vendor CLI running as the owner's
 * uid could still do is write this file directly; the same caveat as the
 * level-3 record, and the same answer: a separate uid is outside Mind.
 *
 * Each peer carries a token *we* issue. A peer calling in presents it as a
 * bearer; that is how an inbound message is tied to a peer at all, because
 * A2A's P1 exchange carries no identity of its own. A peer's own token for
 * calling *it* is optional and kept beside it.
 */

import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateRoot } from "../state.ts";
import type { SubjectId } from "../types.ts";

export const A2A_DIR = "a2a";
export const PEERS_FILE = "peers.json";

/** Names read the same in a URL, a shell and a log line. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface Peer {
  readonly name: string;
  /** Where to send to: the peer's A2A JSON-RPC endpoint. */
  readonly endpoint: string;
  /** What the peer must present to send to us. Issued here, shown once. */
  readonly inboundToken: string;
  /** What we present when sending to the peer, if it asked for one. */
  readonly outboundToken: string | null;
  readonly addedBy: string;
  readonly addedAt: string;
}

/** This subject's A2A state. `erase` removes the directory whole. */
export function a2aDirFor(
  env: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
  subject: SubjectId,
): string {
  return join(stateRoot(env.home, env.env), A2A_DIR, subject);
}

export function peersPath(a2aDir: string): string {
  return join(a2aDir, PEERS_FILE);
}

/** The phrase a person types to allow a peer. */
export function allowPhrase(name: string): string {
  return `allow ${name}`;
}

/** Why this peer cannot be added as given, or `undefined`. */
export function peerProblem(name: string, endpoint: string): string | undefined {
  if (!NAME.test(name)) return `a peer name is lower-case letters, digits and "-" — ${JSON.stringify(name)} is not`;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `${JSON.stringify(endpoint)} is not a URL`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "the endpoint must be http or https";
  if (url.username !== "" || url.password !== "") return "the endpoint must not carry a user or password — put a token in --send-token-file";
  return undefined;
}

export async function readPeers(a2aDir: string): Promise<readonly Peer[]> {
  try {
    const raw = JSON.parse(await readFile(peersPath(a2aDir), "utf8")) as { peers?: unknown };
    if (!Array.isArray(raw.peers)) return [];
    return raw.peers.filter(
      (p): p is Peer =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as Peer).name === "string" &&
        typeof (p as Peer).endpoint === "string" &&
        typeof (p as Peer).inboundToken === "string" &&
        (p as Peer).inboundToken.length >= 32,
    );
  } catch {
    return [];
  }
}

export async function writePeers(a2aDir: string, peers: readonly Peer[]): Promise<void> {
  await mkdir(a2aDir, { recursive: true, mode: 0o700 });
  const path = peersPath(a2aDir);
  const temp = `${path}.${process.pid}`;
  await writeFile(temp, `${JSON.stringify({ peers }, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** A fresh inbound token: 32 random bytes, hex. */
export function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

/** The peer whose inbound token this bearer is, compared in constant time. */
export function peerForBearer(peers: readonly Peer[], authorization: string | null): Peer | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (match === null) return undefined;
  const given = Buffer.from(match[1]!);
  return peers.find((peer) => {
    const expected = Buffer.from(peer.inboundToken);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

export function findPeer(peers: readonly Peer[], name: string): Peer | undefined {
  return peers.find((peer) => peer.name === name);
}
