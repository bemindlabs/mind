// The egress allowlist proxy of the per-task browser container (D-151).
//
// Chromium is started with `--proxy-server` pointing here, and the container's
// own firewall (entrypoint.sh) drops every outbound packet that is not from
// this process's group or to loopback. So this file is the only way out, and
// what it lets through is the task's allowlist and nothing else:
//
// - `CONNECT host:port` (https, wss — and ws, which Chromium also tunnels) is
//   allowed only when `https://host:port` or `http://host:port` is an allowed
//   origin;
// - a plain `GET http://host:port/…` (http, ws) only when `http://host:port`
//   is an allowed origin;
// - a host name (not an IP literal, not `host.docker.internal`) that resolves
//   to a private, loopback, link-local, CGNAT (tailnet) or multicast address is
//   refused even when its name is allowed — that is how a public name could be
//   pointed at this server's own services (DNS rebinding). The proxy connects
//   to the address it checked, never resolving twice.
//
// What it does not see, said plainly:
// - a CONNECT tunnel is judged by its `host:port` alone. Inside the TLS the
//   browser could name another site (SNI, Host) served from the same address —
//   a CDN fronting several names is the real case — and the proxy cannot tell;
//   the allowlist holds at the level of "which address and port", not "which
//   site on it";
// - a name with several addresses is connected to at the first one resolved
//   (the one that was checked), never re-resolved; every address is checked for
//   the private-range rule;
// - an upstream that does not connect in CONNECT_TIMEOUT_MS, or sits idle for
//   IDLE_TIMEOUT_MS, is cut.
//
// Every decision is one JSON line on stdout ({at, decision, origin, reason?}),
// which the entrypoint appends to `/out/egress.jsonl`.
//
// No dependencies: Node's `http`, `net` and `dns` only, and it runs unchanged on
// Bun, which is how the repository's tests exercise it (test/browser/proxy.test.ts).

import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** `MIND_ALLOW`: comma-separated origins, already normalised by mind (src/browser/allowlist.ts). */
export function parseAllowEnv(value) {
  const allowed = new Set();
  for (const raw of (value ?? "").split(",")) {
    const origin = raw.trim();
    if (origin === "") continue;
    const match = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\]):([0-9]{1,5})$/.exec(origin);
    if (match === null) throw new Error(`not a normalised origin: ${JSON.stringify(origin)}`);
    allowed.add(origin);
  }
  return allowed;
}

/** A host given as written in the allowlist: lower case, IPv6 in brackets. */
function hostKey(host) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return isIP(bare) === 6 ? `[${bare}]` : bare;
}

/** Addresses no public name may resolve to. */
export function isPrivateAddress(address) {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT, which is where a tailnet lives
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

export const CONNECT_TIMEOUT_MS = 15_000;
export const IDLE_TIMEOUT_MS = 5 * 60_000;

/** Names the allowlist may point at a private address on purpose. */
const EXPLICITLY_LOCAL = new Set(["host.docker.internal"]);

/**
 * Decide one destination. Returns `{ ok: true, address }` with the address to
 * connect to, or `{ ok: false, reason }`.
 */
export async function decide(allowed, schemes, host, port, resolve = lookup) {
  const key = hostKey(host);
  const candidates = schemes.map((scheme) => `${scheme}://${key}:${port}`);
  const origin = candidates.find((candidate) => allowed.has(candidate));
  // A refused tunnel could have been either scheme, so its log names only the host and port.
  if (origin === undefined) {
    return { ok: false, origin: candidates.length === 1 ? candidates[0] : `${key}:${port}`, reason: "not an allowed origin" };
  }
  const bare = key.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) return { ok: true, origin, address: bare };
  let addresses;
  try {
    addresses = await resolve(bare, { all: true, verbatim: true });
  } catch (error) {
    return { ok: false, origin, reason: `does not resolve (${error?.code ?? "error"})` };
  }
  if (addresses.length === 0) return { ok: false, origin, reason: "does not resolve" };
  if (!EXPLICITLY_LOCAL.has(bare)) {
    const inside = addresses.find((entry) => isPrivateAddress(entry.address));
    if (inside !== undefined) {
      return { ok: false, origin, reason: `resolves to a private address (${inside.address})` };
    }
  }
  return { ok: true, origin, address: addresses[0].address };
}

function log(line) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
}

/** Start the proxy. Resolves with the listening server. */
export function startProxy({ allowed, port = 3128, host = "127.0.0.1", resolve = lookup }) {
  const server = createServer(async (req, res) => {
    // A plain-http request through a proxy carries an absolute URL.
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end("mind egress proxy: absolute http:// URL required\n");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end("mind egress proxy: only http:// is proxied without CONNECT\n");
      return;
    }
    const port = url.port === "" ? 80 : Number(url.port);
    const verdict = await decide(allowed, ["http"], url.hostname, port, resolve);
    log({ decision: verdict.ok ? "allow" : "deny", origin: verdict.origin, ...(verdict.ok ? {} : { reason: verdict.reason }) });
    if (!verdict.ok) {
      res.writeHead(403, { "content-type": "text/plain" }).end(`mind egress proxy: ${verdict.origin} refused: ${verdict.reason}\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = httpRequest(
      { host: verdict.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false, timeout: CONNECT_TIMEOUT_MS },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502).end(`mind egress proxy: upstream error ${error.code ?? ""}\n`);
      else res.destroy();
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req, socket, head) => {
    const match = /^(\[[0-9a-fA-F:]+\]|[^:]+):([0-9]{1,5})$/.exec(req.url ?? "");
    if (match === null) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const port = Number(match[2]);
    const verdict = await decide(allowed, ["https", "http"], match[1], port, resolve);
    log({ decision: verdict.ok ? "allow" : "deny", origin: verdict.origin, ...(verdict.ok ? {} : { reason: verdict.reason }) });
    if (!verdict.ok) {
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nmind egress proxy: ${verdict.origin} refused: ${verdict.reason}\n`);
      return;
    }
    const upstream = connect({ port, host: verdict.address, timeout: CONNECT_TIMEOUT_MS }, () => {
      upstream.setTimeout(IDLE_TIMEOUT_MS);
      socket.setTimeout(IDLE_TIMEOUT_MS, () => {
        upstream.destroy();
        socket.destroy();
      });
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("timeout", () => {
      upstream.destroy();
      if (socket.writable) socket.end("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
    });
    upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    socket.on("error", () => upstream.destroy());
  });

  return new Promise((done) => server.listen(port, host, () => done(server)));
}

// Run as a program: `node proxy.mjs` with MIND_ALLOW and MIND_PROXY_PORT.
if (import.meta.main ?? process.argv[1]?.endsWith("proxy.mjs")) {
  const allowed = parseAllowEnv(process.env.MIND_ALLOW);
  const port = Number(process.env.MIND_PROXY_PORT ?? "3128");
  const server = await startProxy({ allowed, port });
  log({ decision: "start", origin: `http://127.0.0.1:${server.address().port}`, allowed: [...allowed] });
}
