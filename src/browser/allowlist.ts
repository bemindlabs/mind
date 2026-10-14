/**
 * The origins a browser task may reach (D-151) — parsed once, here, into the
 * exact form the container's egress proxy compares against
 * (`docker/browser/proxy.mjs`).
 *
 * An origin is a scheme, a host and a port, and nothing else: no path, no
 * query, no credentials, no wildcard. The proxy decides at the level of a TCP
 * destination (`CONNECT host:port`, or the host and port of a plain-http
 * request), so anything finer than an origin would be a promise the fence
 * cannot keep — `https://example.com/safe/` would let `/unsafe/` through just
 * the same. A wildcard (`*.example.com`) is refused for the same reason the
 * dial's level 2 names its origins: what is allowed should be readable as a
 * list.
 *
 * The default port is written out (`https://example.com:443`), so the proxy
 * never has to know which ports are default and `http://h` and `http://h:80`
 * are one entry.
 */

/** One allowed origin, normalised. */
export interface Origin {
  readonly scheme: "http" | "https";
  /** Lower case; an IPv6 literal keeps its brackets. Punycode for a non-ASCII name. */
  readonly host: string;
  readonly port: number;
  /** `scheme://host:port` — the string the proxy compares. */
  readonly text: string;
}

export type OriginParse =
  | { readonly ok: true; readonly origin: Origin }
  | { readonly ok: false; readonly reason: string };

export type AllowlistParse =
  | { readonly ok: true; readonly origins: readonly Origin[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/** More than this and it is not an allowlist any more. */
export const MAX_ORIGINS = 32;

const HOST_NAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;

/** Parse one origin as a person would type it. */
export function parseOrigin(input: string): OriginParse {
  const raw = input.trim();
  const quoted = JSON.stringify(input);
  if (raw === "") return { ok: false, reason: "an empty origin" };
  if (raw.includes("*")) {
    return { ok: false, reason: `${quoted}: wildcards are not allowed — name each origin` };
  }
  if (!/^https?:\/\//i.test(raw)) {
    return { ok: false, reason: `${quoted}: an origin starts with http:// or https://` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `${quoted}: not a URL` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: `${quoted}: credentials do not belong in an origin` };
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "" || /[?#]/.test(raw)) {
    return {
      ok: false,
      reason: `${quoted}: an origin has no path, query or fragment — the fence decides by host and port`,
    };
  }
  const scheme = url.protocol === "https:" ? "https" : "http";
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".")) return { ok: false, reason: `${quoted}: a host name ends without a dot` };
  if (!IPV6_LITERAL.test(host) && !HOST_NAME.test(host)) {
    return { ok: false, reason: `${quoted}: ${JSON.stringify(host)} is not a host name` };
  }
  const port = url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, reason: `${quoted}: the port is out of range` };
  }
  return { ok: true, origin: { scheme, host, port, text: `${scheme}://${host}:${port}` } };
}

/** Parse the whole list: every error, not just the first; duplicates folded. */
export function parseAllowlist(inputs: readonly string[]): AllowlistParse {
  const errors: string[] = [];
  const origins: Origin[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    // `--allow a,b` and `--allow a --allow b` say the same thing.
    for (const part of input.split(",")) {
      if (part.trim() === "" && input.includes(",")) continue;
      const parsed = parseOrigin(part);
      if (!parsed.ok) {
        errors.push(parsed.reason);
        continue;
      }
      if (seen.has(parsed.origin.text)) continue;
      seen.add(parsed.origin.text);
      origins.push(parsed.origin);
    }
  }
  if (errors.length === 0 && origins.length === 0) {
    errors.push("no origin to allow — a browser task names at least one (--allow https://example.com)");
  }
  if (origins.length > MAX_ORIGINS) {
    errors.push(`${origins.length} origins — at most ${MAX_ORIGINS}; a task that needs more is more than one task`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, origins };
}

/** The value of `MIND_ALLOW` in the container: the normalised origins, comma-separated. */
export function allowEnv(origins: readonly Origin[]): string {
  return origins.map((origin) => origin.text).join(",");
}
