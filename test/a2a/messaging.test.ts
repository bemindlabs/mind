/** E8 (D-063): peers, messages and the listener — allowlist only, ledger first, nothing run. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ackFor, answerText, messageEntry, parseInbound, RPC, sendRequest, sendToPeer } from "../../src/a2a/message.ts";
import { a2aDirFor, allowPhrase, findPeer, newToken, peerForBearer, peerProblem, readPeers, writePeers, type Peer } from "../../src/a2a/peers.ts";
import { a2aHandler, AGENT_CARD_PATH, startA2A, type A2ADeps } from "../../src/a2a/server.ts";
import { parseLine, formatLine } from "../../src/ledger/entry.ts";
import { subjectId } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "mind-a2a-"));
  scratch.push(d);
  return d;
};

const peer = (name: string, token = newToken()): Peer => ({ name, endpoint: "http://127.0.0.1:9/", inboundToken: token, outboundToken: null, addedBy: "t", addedAt: "2026-09-24T00:00:00Z" });
const rpc = (text: string, messageId = "m1", extra: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "SendMessage",
  params: { message: { role: "ROLE_USER", parts: [{ text }], messageId, ...extra } },
});

describe("peers (S8.4)", () => {
  test("names and endpoints are checked; a user or password in the URL is refused", () => {
    expect(peerProblem("bob", "http://127.0.0.1:1/")).toBeUndefined();
    expect(peerProblem("Bob", "http://x/")).toContain("lower-case");
    expect(peerProblem("bob", "ftp://x/")).toContain("http or https");
    expect(peerProblem("bob", "http://u:p@x/")).toContain("user or password");
    expect(peerProblem("bob", "nope")).toContain("not a URL");
    expect(allowPhrase("bob")).toBe("allow bob");
  });

  test("the file round-trips at 0600, short tokens are dropped, and a missing file is no peers", async () => {
    const home = await temp();
    const dir = a2aDirFor({ home, env: { XDG_STATE_HOME: join(home, "state") } }, subjectId("example"));
    expect(dir).toBe(join(home, "state", "mind", "a2a", "example"));
    expect(await readPeers(dir)).toEqual([]);
    const bob = peer("bob");
    await writePeers(dir, [bob, { ...peer("weak"), inboundToken: "short" }]);
    expect((await stat(join(dir, "peers.json"))).mode & 0o777).toBe(0o600);
    expect((await readPeers(dir)).map((p) => p.name)).toEqual(["bob"]);
    expect(findPeer(await readPeers(dir), "bob")?.inboundToken).toBe(bob.inboundToken);
  });

  test("a bearer finds its peer; anything else finds nobody", () => {
    const bob = peer("bob");
    const peers = [bob, peer("carol")];
    expect(peerForBearer(peers, `Bearer ${bob.inboundToken}`)?.name).toBe("bob");
    expect(peerForBearer(peers, `bearer ${bob.inboundToken}`)?.name).toBe("bob");
    expect(peerForBearer(peers, null)).toBeUndefined();
    expect(peerForBearer(peers, `Bearer ${bob.inboundToken.slice(1)}`)).toBeUndefined();
    expect(peerForBearer(peers, `Basic ${bob.inboundToken}`)).toBeUndefined();
    expect(newToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("messages (S8.2)", () => {
  test("a SendMessage is read; a wrong version, method or shape is said", () => {
    const ok = parseInbound(rpc("hello", "m1", { contextId: "c1" }));
    expect(ok).toEqual({ ok: true, message: { id: 7, messageId: "m1", contextId: "c1", text: "hello", nonText: false } });
    expect(parseInbound({ ...rpc("x"), jsonrpc: "1.0" })).toMatchObject({ ok: false, code: RPC.invalidRequest });
    expect(parseInbound({ ...rpc("x"), method: "GetTask" })).toMatchObject({ ok: false, code: RPC.methodNotFound });
    expect(parseInbound({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} })).toMatchObject({ ok: false, code: RPC.invalidParams });
    expect(parseInbound(null)).toMatchObject({ ok: false });
    const mixed = parseInbound({ ...rpc("t"), params: { message: { role: "ROLE_USER", messageId: "m", parts: [{ text: "a" }, { file: { uri: "x" } }] } } });
    expect(mixed.ok && mixed.message.nonText).toBe(true);
  });

  test("ack and request have bwoc's shape; an answer is read from a Message or a Task", () => {
    expect(ackFor({ id: 1, messageId: "m1", contextId: null, text: "", nonText: false }, "Keeper")).toMatchObject({ role: "ROLE_AGENT", messageId: "ack-m1" });
    expect(sendRequest("hi", "m9")).toEqual({ jsonrpc: "2.0", id: "m9", method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "hi" }], messageId: "m9" } } });
    expect(answerText({ result: { parts: [{ text: "got it" }] } })).toEqual({ ok: true, text: "got it" });
    expect(answerText({ result: { status: { message: { parts: [{ text: "working" }] } } } })).toEqual({ ok: true, text: "working" });
    expect(answerText({ error: { message: "nope" } })).toEqual({ ok: false, reason: "nope" });
    expect(answerText({})).toEqual({ ok: false, reason: "the peer's answer had no result" });
  });

  test("a message's ledger line names the direction and the peer, and is a line the ledger reads back", () => {
    const entry = messageEntry({ subject: subjectId("example"), direction: "in", peer: "bob", messageId: "m1", text: "hi", at: new Date("2026-09-24T00:00:00Z"), content: "full" });
    expect(entry.backend).toBe("a2a:in:bob");
    expect(parseLine(formatLine(entry)).ok).toBe(true);
    const withheld = messageEntry({ subject: subjectId("example"), direction: "out", peer: "bob", messageId: "m2", text: "secret", at: new Date(), content: "withheld" });
    expect(withheld.prompt).toBeNull();
    expect(parseLine(formatLine(withheld)).ok).toBe(true);
  });

  test("sending: the bearer only when the peer gave one; a refusal or no answer is a reason", async () => {
    let auth: string | null = "unset";
    const ok = await sendToPeer({ ...peer("bob"), outboundToken: "out" }, "hi", "m1", async (_u, init) => {
      auth = new Headers(init.headers).get("authorization");
      return Response.json({ jsonrpc: "2.0", id: "m1", result: { parts: [{ text: "delivered" }] } });
    });
    expect(ok).toEqual({ ok: true, answer: "delivered" });
    expect(auth).toBe("Bearer out");
    await sendToPeer(peer("bob"), "hi", "m1", async (_u, init) => {
      auth = new Headers(init.headers).get("authorization");
      return Response.json({ result: { parts: [] } });
    });
    expect(auth).toBeNull();
    expect(await sendToPeer(peer("bob"), "hi", "m", async () => new Response("", { status: 503 }))).toEqual({ ok: false, reason: "bob answered HTTP 503" });
    expect((await sendToPeer(peer("bob"), "hi", "m", async () => { throw new Error("offline"); })).ok).toBe(false);
  });
});

describe("the listener", () => {
  const bob = peer("bob");
  function deps(delivered: string[], refused: string[] = [], fail = false): A2ADeps {
    return {
      agentName: "Keeper",
      card: async () => ({ name: "Keeper" }),
      peers: async () => [bob],
      deliver: async (p, m) => {
        if (fail) throw new Error("disk full");
        delivered.push(`${p.name}:${m.text}`);
      },
      refused: (r) => refused.push(r),
    };
  }
  const post = (body: unknown, token?: string) =>
    new Request("http://127.0.0.1/", { method: "POST", body: JSON.stringify(body), headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

  test("the card is public; everything else needs an allowed peer's token", async () => {
    const delivered: string[] = [];
    const refused: string[] = [];
    const h = a2aHandler(deps(delivered, refused));
    expect(await (await h(new Request(`http://127.0.0.1${AGENT_CARD_PATH}`))).json()).toEqual({ name: "Keeper" });
    const denied = await h(post(rpc("hi")));
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { error: { code: number } }).error.code).toBe(RPC.unauthorized);
    expect(refused).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  test("an allowed peer's message is delivered once and acked; a retry of the same id is acked, not delivered twice", async () => {
    const delivered: string[] = [];
    const h = a2aHandler(deps(delivered));
    const first = (await (await h(post(rpc("hello"), bob.inboundToken))).json()) as { result: { messageId: string } };
    expect(first.result.messageId).toBe("ack-m1");
    await h(post(rpc("hello"), bob.inboundToken));
    expect(delivered).toEqual(["bob:hello"]);
  });

  test("a failed delivery is an error to the sender, never an ack; bad JSON, big bodies and other paths are refused", async () => {
    const h = a2aHandler(deps([], [], true));
    const out = (await (await h(post(rpc("x"), bob.inboundToken))).json()) as { error: { message: string } };
    expect(out.error.message).toContain("not delivered: disk full");
    const ok = a2aHandler(deps([]));
    expect(((await (await ok(new Request("http://127.0.0.1/", { method: "POST", body: "{", headers: { authorization: `Bearer ${bob.inboundToken}` } }))).json()) as { error: { code: number } }).error.code).toBe(RPC.parse);
    expect((await ok(new Request("http://127.0.0.1/", { method: "POST", body: "x".repeat(70_000), headers: { authorization: `Bearer ${bob.inboundToken}` } }))).status).toBe(413);
    expect((await ok(new Request("http://127.0.0.1/elsewhere"))).status).toBe(404);
    expect(((await (await ok(post({ jsonrpc: "2.0", id: 1, method: "GetTask" }, bob.inboundToken))).json()) as { error: { code: number } }).error.code).toBe(RPC.methodNotFound);
  });

  test("it listens on loopback by default", async () => {
    const s = startA2A(deps([]), { port: 0 });
    try {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const res = await fetch(`${s.url.replace(/\/$/, "")}${AGENT_CARD_PATH}`);
      expect(res.status).toBe(200);
    } finally {
      s.stop();
    }
  });
});
