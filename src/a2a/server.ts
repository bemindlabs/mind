/**
 * S8.2 — the receiving side of A2A, and S8.1's card served (D-063).
 *
 * Off unless `mind a2a serve` runs (S8.3 AC5): there is no other way this
 * agent listens. On loopback unless a host is named. What arrives is refused
 * unless it carries the bearer token of a peer a person allowed (S8.4); what
 * is accepted is written to the ledger and then to the agent's inbox — it is
 * never run. A message from another agent is something the owner reads, and an
 * agent that acted on whatever arrived would be an agent anyone could steer.
 *
 * Nothing a caller sends can make this listener hold more than a fixed amount
 * (A2A-01): the caller is identified from the headers before its body is read,
 * the body is read only up to {@link MAX_BODY_BYTES}, the ids remembered for
 * de-duplication are bounded, and one allowed peer has a rate and a count.
 *
 * The second file allowed `Bun.serve`, beside the web page's (D-060).
 */

import { MAX_BODY_BYTES, RPC, ackFor, parseInbound, rpcError, rpcResult, type Inbound } from "./message.ts";
import { peerForBearer, type Peer } from "./peers.ts";

/** A2A 1.0.0's well-known path for the Agent Card. */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

export interface A2ADeps {
  readonly agentName: string;
  readonly card: () => Promise<unknown>;
  readonly peers: () => Promise<readonly Peer[]>;
  /** Ledger first, then the inbox. Throws if either cannot be written; the sender is then told. */
  readonly deliver: (peer: Peer, message: Inbound) => Promise<void>;
  /** Told of a call nobody allowed, with no content, so the owner can see who knocked. */
  readonly refused?: (reason: string) => void;
}

const json = (value: unknown, status = 200, headers?: Record<string, string>) => Response.json(value, { status, ...(headers === undefined ? {} : { headers }) });

/**
 * What one running listener will hold and take, so that nothing a peer sends can grow it without end (A2A-01).
 * The defaults are generous for a person's agent talking to a few others and small for a flood.
 */
export interface A2ALimits {
  /** Message ids remembered so a retry is acked, not delivered twice. The oldest is forgotten first. */
  readonly seenMax: number;
  /** Calls one allowed peer may make in a minute, answered or not. */
  readonly perMinute: number;
  /**
   * Messages one allowed peer may have delivered into the ledger and inbox in any 24 hours. A message counts from the
   * moment its delivery begins, so a burst in flight is counted too, and a delivery that fails is given back. It is a
   * window, not a lifetime: a listener that runs for weeks does not lock out a peer that was chatty on day one.
   */
  readonly perDay: number;
  /** The clock, in milliseconds; a test passes its own. */
  readonly now: () => number;
}

export const DEFAULT_LIMITS: A2ALimits = Object.freeze({ seenMax: 4096, perMinute: 60, perDay: 1000, now: () => Date.now() });

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The body as text, or `undefined` once it is longer than `max` bytes: reading stops there, the rest is never pulled. */
async function readBounded(req: Request, max: number): Promise<string | undefined> {
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function a2aHandler(deps: A2ADeps, given: Partial<A2ALimits> = {}) {
  const limits: A2ALimits = { ...DEFAULT_LIMITS, ...given };
  // Insertion order is age: a Set hands back the oldest key first, which is the one dropped at the bound.
  const seen = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const calls = new Map<string, number[]>();
  // Per peer, when each delivery of the last day began, oldest first. At most `perDay` long, and only for allowed peers.
  const taken = new Map<string, number[]>();
  const remember = (key: string) => {
    seen.delete(key);
    seen.add(key);
    while (seen.size > limits.seenMax) seen.delete(seen.values().next().value as string);
  };
  /** A peer past its minute's calls is told to wait; the list never holds more than the limit. */
  const tooFast = (peer: string): boolean => {
    const now = limits.now();
    const recent = (calls.get(peer) ?? []).filter((at) => now - at < MINUTE_MS);
    if (recent.length >= limits.perMinute) {
      calls.set(peer, recent);
      return true;
    }
    calls.set(peer, [...recent, now]);
    return false;
  };
  /** One of the peer's deliveries for the day, taken now; or how many seconds until one is free. */
  const reserve = (peer: string): { readonly slot: number } | { readonly wait: number } => {
    const now = limits.now();
    const recent = (taken.get(peer) ?? []).filter((at) => now - at < DAY_MS);
    if (recent.length >= limits.perDay) {
      taken.set(peer, recent);
      return { wait: Math.max(1, Math.ceil((recent[0]! + DAY_MS - now) / 1000)) };
    }
    taken.set(peer, [...recent, now]);
    return { slot: now };
  };
  /** A delivery that did not happen does not count against the peer. */
  const giveBack = (peer: string, slot: number) => {
    const list = taken.get(peer);
    const at = list?.indexOf(slot) ?? -1;
    if (list !== undefined && at !== -1) list.splice(at, 1);
  };
  const tooMany = (waitSeconds = 60) => json(rpcError(null, RPC.tooMany, "too many messages from you for now — slow down and try again later"), 429, { "retry-after": String(waitSeconds) });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === AGENT_CARD_PATH) return json(await deps.card());
    if (req.method !== "POST" || url.pathname !== "/") return json(rpcError(null, RPC.invalidRequest, "not found"), 404);

    // Who is asking comes from the headers alone, before one byte of the body is read: an unknown caller is answered
    // from what it already sent, and a body it streams is never pulled.
    const peer = peerForBearer(await deps.peers(), req.headers.get("authorization"));
    if (peer === undefined) {
      deps.refused?.("a call without the token of an allowed peer");
      return json(rpcError(null, RPC.unauthorized, "unknown peer — the owner of this agent has not allowed you"), 401);
    }
    if (tooFast(peer.name)) return tooMany();

    // A declared length over the cap is refused unread; a body with no length (chunked) is read only up to the cap.
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_BYTES) return json(rpcError(null, RPC.invalidRequest, "too large"), 413);
    const raw = await readBounded(req, MAX_BODY_BYTES);
    if (raw === undefined) return json(rpcError(null, RPC.invalidRequest, "too large"), 413);

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(rpcError(null, RPC.parse, "not JSON"));
    }
    const parsed = parseInbound(body);
    if (!parsed.ok) return json(rpcError(parsed.id, parsed.code, parsed.error));

    const key = `${peer.name}\u0000${parsed.message.messageId}`;
    if (!seen.has(key)) {
      // The same id arriving twice at once waits for the first one's outcome: delivered once, and a failure is
      // a failure for both, so the sender's retry is not lost to an ack that meant nothing.
      let pending = inFlight.get(key);
      if (pending === undefined) {
        const taking = reserve(peer.name);
        if ("wait" in taking) return tooMany(taking.wait);
        // Async so that a `deliver` that throws before it returns a promise gives the slot back too.
        const deliver = async () => deps.deliver(peer, parsed.message);
        pending = deliver().then(
          () => remember(key),
          (error: unknown) => {
            giveBack(peer.name, taking.slot);
            throw error;
          },
        );
        inFlight.set(key, pending);
        pending.then(
          () => inFlight.delete(key),
          () => inFlight.delete(key),
        );
      }
      try {
        await pending;
      } catch (error) {
        return json(rpcError(parsed.message.id, -32603, `not delivered: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    return json(rpcResult(parsed.message.id, ackFor(parsed.message, deps.agentName)));
  };
}

export function startA2A(
  deps: A2ADeps,
  options: { readonly port: number; readonly hostname?: string; readonly limits?: Partial<A2ALimits> },
): { readonly url: string; readonly stop: () => void } {
  const hostname = options.hostname ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: options.port,
    fetch: a2aHandler(deps, options.limits),
    // The runtime refuses a body over the cap itself, chunked or not, before the handler is asked (A2A-01).
    maxRequestBodySize: MAX_BODY_BYTES,
    // An uncaught error is a bare JSON-RPC error: no stack, no path (the web server's rule, D-060).
    error: () => json(rpcError(null, -32603, "something went wrong on this computer"), 500),
    development: false,
  });
  const port = server.port ?? options.port;
  return { url: `http://${hostname}:${port}/`, stop: () => server.stop(true) };
}
