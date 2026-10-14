/**
 * p5 step 2 — the conformance suite, run on the reference adapter against the fake bot server, plus the fake's
 * own behavior and the tripwire that keeps a real vendor out of the bridge's files.
 */

import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatMessage } from "../../src/connectors/chat.ts";
import { botConformance } from "../support/bot-conformance.ts";
import { startFakeBot } from "../support/fake-bot-server.ts";
import { loopbackBot } from "../support/loopback-bot.ts";

/** Every adapter registered anywhere has a run here. A new one is a new line, and a missing line is a failing test. */
botConformance("loopback-bot (the reference adapter)", {
  make: ({ origin, tokenFile }) => loopbackBot({ origin, tokenFile }),
  inbox: (message: ChatMessage) => ({ chat: message.chatId, from: message.userId, id: message.messageId, text: message.text }),
});

describe("the fake bot server", () => {
  test("listens on 127.0.0.1 only, records what it was sent, and answers 401 without the token", async () => {
    const fake = startFakeBot({ token: "t0k" });
    try {
      expect(fake.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const denied = await fetch(`${fake.origin}/poll`);
      expect(denied.status).toBe(401);
      fake.inbox.push({ n: 1 });
      const ok = await fetch(`${fake.origin}/poll`, { headers: { authorization: "Bearer t0k" } });
      expect(await ok.json()).toEqual({ messages: [{ n: 1 }] });
      expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /poll", "GET /poll"]);
      expect(fake.requests[1]!.headers["authorization"]).toBe("Bearer t0k");
    } finally {
      await fake.stop();
    }
  });

  test("a route replaces a default one, per adapter", async () => {
    const fake = startFakeBot({ routes: { "POST /v1/say": () => new Response(JSON.stringify({ said: true })) } });
    try {
      const res = await fetch(`${fake.origin}/v1/say`, { method: "POST", body: "{}" });
      expect(await res.json()).toEqual({ said: true });
      expect((await fetch(`${fake.origin}/send`, { method: "POST", body: "{}" })).status).toBe(200);
      expect((await fetch(`${fake.origin}/elsewhere`)).status).toBe(404);
    } finally {
      await fake.stop();
    }
  });

  test("it can be made to fail, and stops", async () => {
    const fake = startFakeBot();
    fake.mode = "status-500";
    expect((await fetch(`${fake.origin}/poll`)).status).toBe(500);
    fake.mode = "malformed";
    await expect((await fetch(`${fake.origin}/poll`)).json()).rejects.toThrow();
    await fake.stop();
    await expect(fetch(`${fake.origin}/poll`)).rejects.toThrow();
  });
});

describe("no vendor in the bridge", () => {
  /** A quoted URL that is not loopback. Comments are taken out first, so prose may name a vendor and code may not. */
  const QUOTED_REMOTE_URL = /["'`]https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])[^"'`\s]*/;
  const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("the bridge's own files and its test support hold no URL but loopback", async () => {
    const root = resolve(import.meta.dir, "..", "..");
    const files = [
      ...(await readdir(join(root, "src", "connectors"))).filter((name) => /^(bot|bot-.+|grokbot|dot|muse)\.ts$/.test(name)).map((name) => join(root, "src", "connectors", name)),
      join(root, "test", "support", "fake-bot-server.ts"),
      join(root, "test", "support", "loopback-bot.ts"),
      join(root, "test", "support", "bot-conformance.ts"),
    ];
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      expect(strip(await readFile(file, "utf8")), file).not.toMatch(QUOTED_REMOTE_URL);
    }
  });

  test("the control: the scanner does see a vendor URL where one is quoted", () => {
    expect(strip('const u = "https://api.vendor.example/v1";')).toMatch(QUOTED_REMOTE_URL);
    expect(strip('// see https://api.vendor.example/v1\nconst u = "http://127.0.0.1:5";')).not.toMatch(QUOTED_REMOTE_URL);
  });
});
