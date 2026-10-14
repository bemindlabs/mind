/**
 * A bot, as far as an adapter can tell, on a loopback port the kernel picks (p5 step 2).
 *
 * No test of the bot bridge calls a real vendor: every adapter is pointed at one of these. It listens on
 * `127.0.0.1` only and refuses to be configured otherwise, keeps a record of every request (what an adapter put on
 * the wire is the thing the conformance suite asks about), and fails on demand, so an adapter's error paths run.
 *
 * What a given vendor's API looks like is the adapter's business, and so is the fake's: `routes` replaces the
 * default `GET /poll` and `POST /send` per adapter, which is how a Grok adapter later gets a fake that speaks its
 * shape without this file learning it.
 */

export interface FakeBotRequest {
  readonly method: string;
  readonly path: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** How the next requests fail. `ok` is the default; the others hold until changed. */
export type FakeBotMode = "ok" | "status-500" | "status-401" | "malformed" | "hang";

/** `inbox` is the fake's own, so a route can hand out what a test queued in the shape its vendor uses. */
export type FakeBotRoute = (request: FakeBotRequest, inbox: unknown[]) => Response | Promise<Response>;

export interface FakeBot {
  /** `http://127.0.0.1:<port>` — an adapter's `endpointOrigin`. */
  readonly origin: string;
  /** Every request seen, in order, whether or not it was answered. */
  readonly requests: FakeBotRequest[];
  /** What the next `GET /poll` hands back, once. Whatever shape the default route reads. */
  readonly inbox: unknown[];
  mode: FakeBotMode;
  stop(): Promise<void>;
}

export interface FakeBotOptions {
  /** When set, a request without `Authorization: Bearer <token>` is answered 401. */
  readonly token?: string;
  /** Replaces a default route: the key is `"<METHOD> <path>"`. */
  readonly routes?: Readonly<Record<string, FakeBotRoute>>;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

export function startFakeBot(options: FakeBotOptions = {}): FakeBot {
  const requests: FakeBotRequest[] = [];
  const inbox: unknown[] = [];
  const state = { mode: "ok" as FakeBotMode };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const seen: FakeBotRequest = { method: req.method, path: url.pathname, headers, body: await req.text() };
      requests.push(seen);

      if (state.mode === "hang") return await new Promise<Response>(() => undefined);
      if (state.mode === "status-500") return new Response("broken", { status: 500 });
      if (state.mode === "status-401") return new Response("no", { status: 401 });
      if (state.mode === "malformed") return new Response("{ not json", { status: 200, headers: JSON_HEADERS });
      if (options.token !== undefined && headers["authorization"] !== `Bearer ${options.token}`) {
        return new Response("no", { status: 401 });
      }

      const route = options.routes?.[`${req.method} ${url.pathname}`];
      if (route !== undefined) return route(seen, inbox);
      if (req.method === "GET" && url.pathname === "/poll") {
        return new Response(JSON.stringify({ messages: inbox.splice(0) }), { headers: JSON_HEADERS });
      }
      if (req.method === "POST" && url.pathname === "/send") {
        return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    inbox,
    get mode() {
      return state.mode;
    },
    set mode(value: FakeBotMode) {
      state.mode = value;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
