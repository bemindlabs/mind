/**
 * D-151 — the container's egress proxy (`docker/browser/proxy.mjs`), run here
 * on Bun against real sockets: an allowed origin goes through, anything else is
 * refused with 403 and logged, and a public name that resolves to a private
 * address is refused even when the name is allowed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { resolve } from "node:path";

type Lookup = (host: string, options: unknown) => Promise<{ address: string; family: number }[]>;
interface ProxyModule {
  parseAllowEnv(value: string | undefined): Set<string>;
  isPrivateAddress(address: string): boolean;
  decide(
    allowed: Set<string>,
    schemes: string[],
    host: string,
    port: number,
    lookup?: Lookup,
  ): Promise<{ ok: boolean; origin: string; address?: string; reason?: string }>;
  startProxy(options: { allowed: Set<string>; port?: number; host?: string; resolve?: Lookup }): Promise<{
    address(): { port: number };
    close(): void;
  }>;
}

const PROXY_PATH = resolve(import.meta.dir, "..", "..", "docker", "browser", "proxy.mjs");
let proxy: ProxyModule;
let upstream: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let server: { address(): { port: number }; close(): void };
let logged = "";
const originalWrite = process.stdout.write.bind(process.stdout);
const hits: string[] = [];

/** A resolver that sends every name to loopback — which is how the test servers are reached. */
const toLoopback: Lookup = async () => [{ address: "127.0.0.1", family: 4 }];

beforeAll(async () => {
  proxy = (await import(PROXY_PATH)) as ProxyModule;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => { hits.push(`allowed ${new URL(request.url).pathname}`); return new Response("<h1>allowed page</h1>"); } });
  other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits.push("other"); return new Response("secret"); } });
  // The proxy logs one JSON line per decision on stdout; collect it.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    logged += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  server = await proxy.startProxy({
    allowed: proxy.parseAllowEnv(`http://127.0.0.1:${upstream.port},http://host.docker.internal:${upstream.port}`),
    port: 0,
    resolve: toLoopback,
  });
});

afterAll(async () => {
  process.stdout.write = originalWrite;
  server.close();
  await upstream.stop(true);
  await other.stop(true);
});

/** One raw request through the proxy; the whole response as text. */
function raw(request: string): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(server.address().port, "127.0.0.1", () => socket.write(request));
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (text.includes("\r\n\r\n") && request.startsWith("CONNECT") && !text.startsWith("HTTP/1.1 200")) socket.end();
    });
    socket.on("end", () => done(text));
    socket.on("error", fail);
    setTimeout(() => {
      socket.destroy();
      done(text);
    }, 2_000);
  });
}

describe("the proxy, on the wire", () => {
  test("an allowed http origin is fetched and logged as allowed", async () => {
    const response = await raw(`GET http://127.0.0.1:${upstream.port}/page HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nConnection: close\r\n\r\n`);
    expect(response).toStartWith("HTTP/1.1 200");
    expect(response).toContain("allowed page");
    expect(hits).toContain("allowed /page");
    expect(logged).toContain(`"decision":"allow","origin":"http://127.0.0.1:${upstream.port}"`);
  });

  test("an origin not on the list is refused with 403, never reaches the server, and is logged", async () => {
    const before = hits.filter((hit) => hit === "other").length;
    const response = await raw(`GET http://127.0.0.1:${other.port}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    expect(response).toStartWith("HTTP/1.1 403");
    expect(response).toContain("not an allowed origin");
    const tunnel = await raw(`CONNECT 127.0.0.1:${other.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(tunnel).toStartWith("HTTP/1.1 403");
    expect(hits.filter((hit) => hit === "other").length).toBe(before);
    expect(logged).toContain(`"decision":"deny","origin":"http://127.0.0.1:${other.port}"`);
    // A refused tunnel could have been http or https: its line names the host and port only.
    expect(logged).toContain(`"decision":"deny","origin":"127.0.0.1:${other.port}"`);
  });

  test("CONNECT to an allowed origin opens a tunnel to it", async () => {
    const response = await raw(
      `CONNECT host.docker.internal:${upstream.port} HTTP/1.1\r\nHost: x\r\n\r\nGET /tunnel HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    );
    expect(response).toStartWith("HTTP/1.1 200 Connection Established");
    expect(response).toContain("allowed page");
    expect(hits).toContain("allowed /tunnel");
  });

  test("malformed requests are refused, not forwarded", async () => {
    expect(await raw("GET /relative HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")).toStartWith("HTTP/1.1 400");
    expect(await raw("CONNECT nonsense HTTP/1.1\r\nHost: x\r\n\r\n")).toStartWith("HTTP/1.1 400");
  });
});

describe("decide", () => {
  const allowed = new Set(["https://example.com:443", "http://host.docker.internal:30790", "http://[2001:db8::1]:80", "http://192.0.2.7:80"]);

  test("an allowed public name resolving to a private address is refused (DNS rebinding)", async () => {
    const verdict = await proxy.decide(allowed, ["https"], "example.com", 443, toLoopback);
    expect(verdict).toMatchObject({ ok: false, reason: "resolves to a private address (127.0.0.1)" });
    const publicAnswer: Lookup = async () => [{ address: "93.184.215.14", family: 4 }];
    expect(await proxy.decide(allowed, ["https"], "EXAMPLE.com", 443, publicAnswer)).toMatchObject({ ok: true, address: "93.184.215.14" });
  });

  test("host.docker.internal and IP literals are explicit, so they may be private", async () => {
    const gateway: Lookup = async () => [{ address: "172.17.0.1", family: 4 }];
    expect(await proxy.decide(allowed, ["http"], "host.docker.internal", 30790, gateway)).toMatchObject({ ok: true, address: "172.17.0.1" });
    expect(await proxy.decide(allowed, ["http"], "192.0.2.7", 80)).toMatchObject({ ok: true, address: "192.0.2.7" });
    expect(await proxy.decide(allowed, ["http"], "[2001:DB8::1]", 80)).toMatchObject({ ok: true, address: "2001:db8::1" });
  });

  test("a name that does not resolve is refused", async () => {
    const nothing: Lookup = async () => [];
    const failing: Lookup = async () => {
      throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
    };
    expect(await proxy.decide(allowed, ["https"], "example.com", 443, nothing)).toMatchObject({ ok: false, reason: "does not resolve" });
    expect(await proxy.decide(allowed, ["https"], "example.com", 443, failing)).toMatchObject({ ok: false, reason: "does not resolve (ENOTFOUND)" });
  });

  test("private ranges, the tailnet's CGNAT among them", () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.17.0.1", "192.168.0.5", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(proxy.isPrivateAddress(address)).toBe(true);
    }
    for (const address of ["93.184.215.14", "1.1.1.1", "100.128.0.1", "172.32.0.1", "2606:4700::1111"]) {
      expect(proxy.isPrivateAddress(address)).toBe(false);
    }
  });

  test("the allow list only takes the normalised form Mind writes", () => {
    expect([...proxy.parseAllowEnv(" https://example.com:443 ,,http://[::1]:80")]).toEqual(["https://example.com:443", "http://[::1]:80"]);
    expect(proxy.parseAllowEnv(undefined).size).toBe(0);
    expect(() => proxy.parseAllowEnv("https://example.com")).toThrow("not a normalised origin");
    expect(() => proxy.parseAllowEnv("https://*.example.com:443")).toThrow();
  });
});
