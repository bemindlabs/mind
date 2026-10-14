/** A2A-01 (security review 2026-10-13): the listener holds a bounded amount, whatever a caller streams at it. */

import { describe, expect, test } from "bun:test";
import { MAX_BODY_BYTES, RPC, sendToPeer } from "../../src/a2a/message.ts";
import { newToken, type Peer } from "../../src/a2a/peers.ts";
import { a2aHandler, startA2A, type A2ADeps } from "../../src/a2a/server.ts";

const bob: Peer = { name: "bob", endpoint: "http://127.0.0.1:9/", inboundToken: newToken(), outboundToken: null, addedBy: "t", addedAt: "2026-10-13T00:00:00Z" };
const rpc = (text: string, messageId = "m1") => ({
  jsonrpc: "2.0",
  id: 7,
  method: "SendMessage",
  params: { message: { role: "ROLE_USER", parts: [{ text }], messageId } },
});
const auth = { authorization: `Bearer ${bob.inboundToken}` };

function deps(delivered: string[], over: Partial<A2ADeps> = {}): A2ADeps {
  return {
    agentName: "Keeper",
    card: async () => ({ name: "Keeper" }),
    peers: async () => [bob],
    deliver: async (p, m) => {
      delivered.push(`${p.name}:${m.messageId}`);
    },
    ...over,
  };
}

/** A request body that streams `chunks` pieces of `size` bytes and counts how many were pulled, with no Content-Length. */
function streamed(chunks: number, size: number, headers: Record<string, string> = {}) {
  const pulled = { chunks: 0 };
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) return controller.close();
      sent += 1;
      pulled.chunks += 1;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  const request = new Request("http://127.0.0.1/", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { request, pulled };
}

describe("a body is not read before the caller is known, and never past the cap", () => {
  test("a caller with no token is answered 401 and its streamed body is not pulled at all", async () => {
    const delivered: string[] = [];
    const refused: string[] = [];
    const h = a2aHandler(deps(delivered, { refused: (r) => refused.push(r) }));
    const { request, pulled } = streamed(1000, 1024);
    const res = await h(request);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(RPC.unauthorized);
    // A stream reads one chunk ahead by itself; a handler that read the body would have pulled all 1000.
    expect(pulled.chunks).toBeLessThanOrEqual(1);
    expect(refused).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  test("a wrong token is treated the same, and a huge declared length does not turn the answer into a 413", async () => {
    const h = a2aHandler(deps([]));
    const wrong = new Request("http://127.0.0.1/", { method: "POST", body: "x", headers: { authorization: "Bearer nope", "content-length": String(10 * MAX_BODY_BYTES) } });
    expect((await h(wrong)).status).toBe(401);
  });

  test("an allowed peer's chunked body over the cap is refused 413 after about the cap, not after a megabyte", async () => {
    const delivered: string[] = [];
    const h = a2aHandler(deps(delivered));
    const { request, pulled } = streamed(1024, 1024, auth); // 1 MiB offered, no Content-Length
    const res = await h(request);
    expect(res.status).toBe(413);
    // 64 KiB is 64 chunks of 1 KiB; one more is what tips it over. A little slack for the stream's own read-ahead.
    expect(pulled.chunks).toBeLessThanOrEqual(MAX_BODY_BYTES / 1024 + 8);
    expect(delivered).toEqual([]);
  });

  test("a declared length over the cap is refused unread, and a body exactly at the cap still goes through", async () => {
    const delivered: string[] = [];
    const h = a2aHandler(deps(delivered));
    const { request, pulled } = streamed(10, 1024, { ...auth, "content-length": String(MAX_BODY_BYTES + 1) });
    expect((await h(request)).status).toBe(413);
    expect(pulled.chunks).toBeLessThanOrEqual(1);
    const text = JSON.stringify(rpc("x"));
    const padding = " ".repeat(MAX_BODY_BYTES - new TextEncoder().encode(text).length);
    const exact = await h(new Request("http://127.0.0.1/", { method: "POST", body: text + padding, headers: auth }));
    expect(exact.status).toBe(200);
    expect(delivered).toEqual(["bob:m1"]);
  });

  test("through a real listener: a chunked 1 MiB body gets 401 or 413 and nothing is delivered", async () => {
    const delivered: string[] = [];
    const s = startA2A(deps(delivered), { port: 0 });
    try {
      const post = async (headers: Record<string, string>) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < 1024; i += 1) controller.enqueue(new Uint8Array(1024).fill(0x61));
            controller.close();
          },
        });
        try {
          return (await fetch(s.url, { method: "POST", body, headers, duplex: "half" } as RequestInit)).status;
        } catch {
          // The listener may close the connection on an oversize body; that is a refusal too.
          return 0;
        }
      };
      expect([0, 401, 413]).toContain(await post({}));
      expect([0, 413]).toContain(await post(auth));
      expect(delivered).toEqual([]);
      // And the listener is still answering afterwards.
      const ok = await fetch(s.url, { method: "POST", body: JSON.stringify(rpc("hello")), headers: auth });
      expect(ok.status).toBe(200);
      expect(delivered).toEqual(["bob:m1"]);
    } finally {
      s.stop();
    }
  });

  test("an error inside the listener is a bare JSON-RPC error, with nothing of the machine in it", async () => {
    const s = startA2A(deps([], { card: async () => { throw new Error("boom at /home/someone/secret"); } }), { port: 0 });
    try {
      const res = await fetch(`${s.url}.well-known/agent-card.json`);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("boom");
      expect(text).not.toContain("/home");
      expect((JSON.parse(text) as { error: { code: number } }).error.code).toBe(-32603);
    } finally {
      s.stop();
    }
  });
});

describe("what the listener remembers and accepts is bounded", () => {
  const post = (messageId: string) => new Request("http://127.0.0.1/", { method: "POST", body: JSON.stringify(rpc("t", messageId)), headers: auth });

  test("the ids remembered for de-duplication stop at the bound, the oldest forgotten first", async () => {
    const delivered: string[] = [];
    const h = a2aHandler(deps(delivered), { seenMax: 3 });
    for (const id of ["a", "b", "c", "d"]) await h(post(id)); // a is pushed out by d
    await h(post("d")); // still remembered: acked, not delivered again
    await h(post("a")); // forgotten: delivered again, and that is the price of a bound
    expect(delivered).toEqual(["bob:a", "bob:b", "bob:c", "bob:d", "bob:a"]);
  });

  test("the same id arriving twice at once is delivered once, and both senders get the ack", async () => {
    const delivered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = a2aHandler(
      deps(delivered, {
        deliver: async (p, m) => {
          await gate;
          delivered.push(`${p.name}:${m.messageId}`);
        },
      }),
    );
    const both = Promise.all([h(post("same")), h(post("same"))]);
    await Bun.sleep(10);
    release();
    const [one, two] = await both;
    expect(delivered).toEqual(["bob:same"]);
    for (const res of [one, two]) expect(((await res.json()) as { result: { messageId: string } }).result.messageId).toBe("ack-same");
  });

  test("a delivery that fails at once for two callers is an error to both, and a later retry is delivered", async () => {
    const delivered: string[] = [];
    let fail = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = a2aHandler(
      deps(delivered, {
        deliver: async (p, m) => {
          await gate;
          if (fail) throw new Error("disk full");
          delivered.push(`${p.name}:${m.messageId}`);
        },
      }),
    );
    const both = Promise.all([h(post("x")), h(post("x"))]);
    await Bun.sleep(10);
    release();
    for (const res of await both) expect(((await res.json()) as { error: { message: string } }).error.message).toContain("not delivered: disk full");
    fail = false;
    expect(((await (await h(post("x"))).json()) as { result?: unknown }).result).toBeDefined();
    expect(delivered).toEqual(["bob:x"]);
  });

  test("one peer's calls are limited per minute, answered 429, and it may call again once the minute has passed", async () => {
    let now = 1_000_000;
    const delivered: string[] = [];
    const h = a2aHandler(deps(delivered), { perMinute: 3, now: () => now });
    const statuses: number[] = [];
    for (const id of ["1", "2", "3", "4", "5"]) statuses.push((await h(post(id))).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const slow = await h(post("6"));
    expect(slow.headers.get("retry-after")).toBe("60");
    expect(((await slow.json()) as { error: { code: number } }).error.code).toBe(RPC.tooMany);
    now += 61_000;
    expect((await h(post("7"))).status).toBe(200);
    expect(delivered).toEqual(["bob:1", "bob:2", "bob:3", "bob:7"]);
  });

  test("a caller without a token cannot use up a peer's calls", async () => {
    const h = a2aHandler(deps([]), { perMinute: 2 });
    for (let i = 0; i < 10; i += 1) expect((await h(new Request("http://127.0.0.1/", { method: "POST", body: "{}" }))).status).toBe(401);
    expect((await h(post("1"))).status).toBe(200);
  });

  test("one peer can have only so many messages delivered in a day; a retry of one already delivered is still acked", async () => {
    const delivered: string[] = [];
    const h = a2aHandler(deps(delivered), { perDay: 2, perMinute: 1000 });
    expect([(await h(post("a"))).status, (await h(post("b"))).status, (await h(post("c"))).status]).toEqual([200, 200, 429]);
    expect((await h(post("a"))).status).toBe(200);
    expect(delivered).toEqual(["bob:a", "bob:b"]);
  });

  test("the day's count is a window, not a lifetime: a peer that was chatty yesterday may send again, and is told when", async () => {
    const HOUR = 3_600_000;
    let now = 5_000_000_000;
    const delivered: string[] = [];
    const h = a2aHandler(deps(delivered), { perDay: 2, perMinute: 1000, now: () => now });
    expect((await h(post("a"))).status).toBe(200);
    now += 2 * HOUR;
    expect((await h(post("b"))).status).toBe(200);
    now += HOUR;
    const full = await h(post("c"));
    expect(full.status).toBe(429);
    // The oldest delivery began 3 hours ago, so a place frees in 21 hours; the sender is told that, not a flat minute.
    expect(full.headers.get("retry-after")).toBe(String(21 * 3600));
    const body = (await full.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(RPC.tooMany);
    // The words promise nothing the listener does not do: reading the inbox does not free a place.
    expect(body.error.message).not.toContain("inbox");
    now += 21 * HOUR;
    expect((await h(post("c"))).status).toBe(200); // a is a day old: its place is free
    expect((await h(post("d"))).status).toBe(429); // b is not
    now += 2 * HOUR;
    expect((await h(post("d"))).status).toBe(200);
    expect(delivered).toEqual(["bob:a", "bob:b", "bob:c", "bob:d"]);
  });

  test("messages still being delivered count: a burst in flight cannot overshoot the cap", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = a2aHandler(
      deps([], {
        deliver: async (_p, m) => {
          started.push(m.messageId);
          await gate;
        },
      }),
      { perDay: 2, perMinute: 1000 },
    );
    const burst = Promise.all(["a", "b", "c", "d", "e"].map((id) => h(post(id))));
    await Bun.sleep(20);
    // Two began; the other three were refused while those two had not finished.
    expect(started).toEqual(["a", "b"]);
    release();
    expect((await burst).map((r) => r.status)).toEqual([200, 200, 429, 429, 429]);
  });

  test("a delivery that fails gives its place back, whether it rejects or throws before it returns", async () => {
    const delivered: string[] = [];
    let how: "reject" | "throw" | "ok" = "reject";
    const h = a2aHandler(
      deps(delivered, {
        deliver: ((p: Peer, m: { messageId: string }) => {
          if (how === "throw") throw new Error("broke at once");
          if (how === "reject") return Promise.reject(new Error("disk full"));
          delivered.push(`${p.name}:${m.messageId}`);
          return Promise.resolve();
        }) as A2ADeps["deliver"],
      }),
      { perDay: 1, perMinute: 1000 },
    );
    expect(((await (await h(post("a"))).json()) as { error: { message: string } }).error.message).toContain("not delivered: disk full");
    how = "throw";
    expect(((await (await h(post("b"))).json()) as { error: { message: string } }).error.message).toContain("not delivered: broke at once");
    how = "ok";
    expect((await h(post("c"))).status).toBe(200); // the only place was never used
    expect((await h(post("d"))).status).toBe(429);
    expect(delivered).toEqual(["bob:c"]);
  });
});

describe("EEA-14: a peer's answer is never followed to another host", () => {
  test("sendToPeer asks the runtime not to follow a redirect", async () => {
    let asked: RequestInit["redirect"];
    await sendToPeer(bob, "hi", "m1", async (_url, init) => {
      asked = init.redirect;
      return Response.json({ result: { parts: [] } });
    });
    expect(asked).toBe("error");
  });

  test("a 307 from the allowed endpoint does not carry the message, or the token, to the host it names", async () => {
    const hits: { readonly auth: string | null; readonly body: string }[] = [];
    const elsewhere = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        hits.push({ auth: req.headers.get("authorization"), body: await req.text() });
        return Response.json({ result: { parts: [{ text: "got it" }] } });
      },
    });
    const allowed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${elsewhere.port}/`, 307) });
    try {
      const peer: Peer = { ...bob, endpoint: `http://127.0.0.1:${allowed.port}/`, outboundToken: "secret-outbound" };
      const result = await sendToPeer(peer, "private words", "m1");
      expect(result.ok).toBe(false);
      expect(hits).toEqual([]);
    } finally {
      await allowed.stop(true);
      await elsewhere.stop(true);
    }
  });
});
