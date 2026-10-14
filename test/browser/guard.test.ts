/**
 * The door in front of Playwright MCP (`docker/browser/guard.mjs`), run here on
 * Bun against a stand-in server: no token, no browser; a tool outside SERVED
 * never reaches the server; `tools/list` shows only what is served; typed
 * values never reach the action log.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

interface GuardModule {
  SERVED: Set<string>;
  LOOK: Set<string>;
  servedAt(operate: unknown): Set<string>;
  urlProblem(raw: unknown): string | undefined;
  callProblem(call: { name: string; arguments?: Record<string, unknown> }, served?: Set<string>): string | undefined;
  authorized(header: unknown, token: unknown): boolean;
  toolCalls(body: unknown): { id: unknown; name: string; arguments: unknown }[];
  redacted(value: unknown): unknown;
  filterToolList(text: string): string;
  startGuard(options: { token: string; upstream: { host: string; port: number }; port?: number; host?: string; operate?: number }): Promise<{
    address(): { port: number };
    close(): void;
  }>;
}

const GUARD_PATH = resolve(import.meta.dir, "..", "..", "docker", "browser", "guard.mjs");
const TOKEN = "ef".repeat(32);
let guard: GuardModule;
let server: { address(): { port: number }; close(): void };
let upstream: ReturnType<typeof Bun.serve>;
const reached: { body: string; authorization: string | null; host: string | null }[] = [];
let logged = "";
const originalWrite = process.stdout.write.bind(process.stdout);

const LIST = {
  jsonrpc: "2.0",
  id: 2,
  result: { tools: [{ name: "browser_navigate" }, { name: "browser_run_code_unsafe" }, { name: "browser_evaluate" }, { name: "browser_snapshot" }] },
};

beforeAll(async () => {
  guard = (await import(GUARD_PATH)) as GuardModule;
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.text();
      reached.push({ body, authorization: request.headers.get("authorization"), host: request.headers.get("host") });
      if (body.includes('"tools/list"')) {
        // Playwright MCP answers in SSE when the client accepts it.
        return new Response(`event: message\ndata: ${JSON.stringify(LIST)}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), { headers: { "content-type": "application/json" } });
    },
  });
  process.stdout.write = ((chunk: string | Uint8Array) => {
    logged += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  server = await guard.startGuard({ token: TOKEN, upstream: { host: "127.0.0.1", port: upstream.port! }, port: 0, host: "127.0.0.1", operate: 2 });
});

afterAll(async () => {
  process.stdout.write = originalWrite;
  server.close();
  await upstream.stop(true);
});

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:30730", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });

describe("the guard, on the wire", () => {
  test("no token, a wrong token, or a token without Bearer: 401, and nothing reaches the server", async () => {
    const before = reached.length;
    expect((await post(call("browser_navigate"), {})).status).toBe(401);
    expect((await post(call("browser_navigate"), { authorization: `Bearer ${"00".repeat(32)}` })).status).toBe(401);
    expect((await post(call("browser_navigate"), { authorization: TOKEN })).status).toBe(401);
    expect(reached.length).toBe(before);
    expect(logged).toContain('"event":"refused","reason":"no or wrong token"');
  });

  test("a served tool goes through, without the token and with the Host it was sent with", async () => {
    const response = await post(call("browser_navigate", { url: "https://example.com/" }));
    expect(response.status).toBe(200);
    const last = reached.at(-1)!;
    expect(JSON.parse(last.body).params.name).toBe("browser_navigate");
    expect(last.authorization).toBeNull();
    expect(last.host).toBe("127.0.0.1:30730");
  });

  test("run-code, evaluate and file tools are refused before the server — alone or inside a batch", async () => {
    for (const name of ["browser_run_code_unsafe", "browser_evaluate", "browser_file_upload", "browser_drop", "browser_some_new_tool"]) {
      const before = reached.length;
      const answer = (await (await post(call(name, { code: "process.env" }))).json()) as { error: { message: string }; id: unknown };
      expect(answer.error.message).toContain(`${name} is not served`);
      expect(answer.id).toBe(7);
      expect(reached.length).toBe(before);
    }
    const before = reached.length;
    const batch = (await (await post([call("browser_snapshot"), call("browser_run_code_unsafe")])).json()) as { error: { message: string } };
    expect(batch.error.message).toContain("browser_run_code_unsafe is not served");
    expect(reached.length).toBe(before);
  });

  test("tools/list shows only what is served", async () => {
    const text = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).text();
    const data = JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
    expect(data.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["browser_navigate", "browser_snapshot"]);
  });

  test("typed values never reach the action log", async () => {
    await post(call("browser_type", { target: "e5", text: "hunter2-SECRET", submit: true }));
    await post(call("browser_fill_form", { fields: [{ name: "pw", value: "other-SECRET" }] }));
    expect(logged).not.toContain("SECRET");
    expect(logged).toContain('"text":"[typed, 14 chars]"');
    expect(logged).toContain('"value":"[typed, 12 chars]"');
  });

  test("a body that is not JSON is refused, a huge one too, and a dead server is a 502", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post("x".repeat(1024 * 1024 + 10))).status).toBe(413);
    const lonely = await guard.startGuard({ token: TOKEN, upstream: { host: "127.0.0.1", port: 1 }, port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(`http://127.0.0.1:${lonely.address().port}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(call("browser_snapshot")),
      });
      expect(response.status).toBe(502);
    } finally {
      lonely.close();
    }
  });
});

describe("URLs and levels (re-review of PR #19)", () => {
  test("javascript:, data: and file: URLs are refused before the server; http(s) and about:blank pass", async () => {
    for (const url of ["javascript:document.title='x'", "JavaScript:alert(1)", " javascript:1", "data:text/html,<b>x</b>", "file:///etc/passwd", "chrome://settings", "nonsense", 42]) {
      const before = reached.length;
      const answer = (await (await post(call("browser_navigate", { url }))).json()) as { error?: { message: string } };
      expect(answer.error?.message, String(url)).toContain("browser_navigate refused");
      expect(reached.length).toBe(before);
    }
    const tab = (await (await post(call("browser_tabs", { action: "new", url: "javascript:1" }))).json()) as { error?: { message: string } };
    expect(tab.error?.message).toContain("browser_tabs refused");
    for (const url of ["https://example.com/a?b=1", "http://host.docker.internal:30790/", "about:blank"]) {
      expect(guard.urlProblem(url)).toBeUndefined();
    }
    // A tab listed or selected carries no url, and is not asked for one.
    expect(guard.callProblem({ name: "browser_tabs", arguments: { action: "list" } })).toBeUndefined();
  });

  test("URLs reach the action log as their origin only; a refused scheme as its kind and length", async () => {
    await post(call("browser_navigate", { url: "https://example.com/reset?token=SECRET-in-a-query" }));
    await post(call("browser_navigate", { url: "javascript:f.pw.value='SECRET-in-js'" }));
    expect(logged).not.toContain("SECRET-in");
    expect(logged).toContain('"url":"https://example.com/…"');
    expect(logged).toContain('"url":"[javascript: url,');
    expect(guard.redacted({ url: "not a url" })).toEqual({ url: "[url, 9 chars]" });
  });

  test("operate 1 serves the look tools only; tools/list and calls agree", async () => {
    expect(guard.servedAt(1)).toBe(guard.LOOK);
    expect(guard.servedAt(2)).toBe(guard.SERVED);
    expect(guard.servedAt(3)).toBe(guard.SERVED);
    expect(guard.servedAt(undefined)).toBe(guard.LOOK);
    const looking = await guard.startGuard({ token: TOKEN, upstream: { host: "127.0.0.1", port: upstream.port! }, port: 0, host: "127.0.0.1", operate: 1 });
    try {
      const at = (body: unknown) =>
        fetch(`http://127.0.0.1:${looking.address().port}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const before = reached.length;
      const click = (await (await at(call("browser_click", { target: "e1" }))).json()) as { error: { message: string } };
      expect(click.error.message).toContain("browser_click is not served");
      expect(reached.length).toBe(before);
      expect((await at(call("browser_snapshot"))).status).toBe(200);
      const text = await (await at({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).text();
      const data = JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
      expect(data.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["browser_navigate", "browser_snapshot"]);
    } finally {
      looking.close();
    }
  });
});

describe("the pieces", () => {
  test("authorized: constant-time, exact, and never for a short token", () => {
    expect(guard.authorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(guard.authorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(guard.authorized(undefined, TOKEN)).toBe(false);
    expect(guard.authorized("Bearer short", "short")).toBe(false);
  });

  test("toolCalls, redacted and filterToolList on their own", () => {
    expect(guard.toolCalls({ method: "initialize" })).toEqual([]);
    expect(guard.toolCalls({ id: 1, method: "tools/call", params: {} })).toEqual([{ id: 1, name: "", arguments: {} }]);
    expect(guard.redacted({ key: "a", nested: [{ values: ["x", "yz"] }], element: "u" })).toEqual({
      key: "[typed, 1 chars]",
      nested: [{ values: "[typed, 10 chars]" }],
      element: "u",
    });
    expect(JSON.parse(guard.filterToolList(JSON.stringify(LIST))).result.tools).toHaveLength(2);
    expect(JSON.parse(guard.filterToolList(JSON.stringify([LIST])))[0].result.tools).toHaveLength(2);
    expect(guard.filterToolList("event: x\ndata: not json\n")).toBe("event: x\ndata: not json\n");
  });
});
