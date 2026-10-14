/**
 * What every bot adapter must do, run once per adapter against the fake bot server (p5 step 1–2, S9.1 AC4).
 *
 * `botConformance("name", { make, inbox })` registers the cases in the calling test file. An adapter that cannot
 * pass them is not to be registered: `checkBotAdapter` holds what can be seen without a call, and this holds what
 * cannot — that an adapter never throws, that every failure is an empty poll or a failed send, and that what it
 * puts on the wire is the chat id and the text it was handed, with the token in one header and nowhere else.
 *
 * It also takes `fetch` away from the adapter for anything but its own origin, so an adapter that quietly calls a
 * second host fails here instead of in production.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry, tokenFileProblem, type BotAdapter } from "../../src/connectors/bot.ts";
import type { ChatMessage } from "../../src/connectors/chat.ts";
import { startFakeBot, type FakeBot, type FakeBotOptions } from "./fake-bot-server.ts";

const TOKEN = "tok-conformance-0000-secret";
const MESSAGE: ChatMessage = { platform: "x", chatId: "chat-7", userId: "user-9", messageId: "m-1", text: "hello bot" };
const REPLY = "an answer that was screened";

export interface BotConformanceCase {
  /** Build the adapter under test, pointed at the fake and the token file. */
  readonly make: (target: { readonly origin: string; readonly tokenFile: string }) => BotAdapter;
  /** What the fake's inbox holds for one incoming message, in the shape this adapter's vendor would send. */
  readonly inbox: (message: ChatMessage) => unknown;
  /** Replaces the fake's default routes, for an adapter whose vendor has another shape. */
  readonly fake?: Omit<FakeBotOptions, "token">;
}

function stringValues(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, into);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) stringValues(item, into);
  return into;
}

export function botConformance(name: string, spec: BotConformanceCase): void {
  describe(`bot conformance — ${name}`, () => {
    let fake: FakeBot;
    let dir: string;
    let adapter: BotAdapter;
    let urls: string[];
    const realFetch = globalThis.fetch;

    beforeEach(async () => {
      fake = startFakeBot({ ...spec.fake, token: TOKEN });
      dir = await mkdtemp(join(tmpdir(), "mind-bot-conformance-"));
      const tokenFile = join(dir, "bot.token");
      await writeFile(tokenFile, `${TOKEN}\n`);
      await chmod(tokenFile, 0o600);
      adapter = spec.make({ origin: fake.origin, tokenFile });
      urls = [];
      // Every request goes to the adapter's own origin or the test fails; the real fetch does the work after that.
      globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        if (!url.startsWith(`${adapter.endpointOrigin}/`)) throw new Error(`a call to ${url}, which is not ${adapter.endpointOrigin}`);
        return realFetch(input, init);
      }) as typeof fetch;
    });

    afterEach(async () => {
      globalThis.fetch = realFetch;
      await fake.stop();
      await rm(dir, { recursive: true, force: true });
    });

    test("it is registrable, loopback, and does not start a conversation", () => {
      expect(new BotRegistry().register(adapter)).toEqual({ ok: true });
      expect(adapter.endpointOrigin).toBe(fake.origin);
      expect(adapter.capabilities.initiates).toBe(false);
    });

    test("its token file is the private file it was given", async () => {
      expect(await tokenFileProblem(adapter.tokenFile)).toBeUndefined();
    });

    test("poll hands back what the bot had, as this platform's messages, once", async () => {
      fake.inbox.push(spec.inbox(MESSAGE));
      const first = await adapter.poll();
      expect(first.error).toBeUndefined();
      expect(first.messages).toEqual([{ ...MESSAGE, platform: adapter.platform }]);
      expect(await adapter.poll()).toEqual({ messages: [] });
    });

    for (const mode of ["status-500", "status-401", "malformed"] as const) {
      test(`poll against a bot that answers ${mode} is an empty poll and a reason, not a throw`, async () => {
        fake.mode = mode;
        const result = await adapter.poll();
        expect(result.messages).toEqual([]);
        expect(typeof result.error).toBe("string");
        expect(result.error).not.toContain(TOKEN);
      });

      test(`send to a bot that answers ${mode} is a failed send with a reason, not a throw`, async () => {
        fake.mode = mode;
        const result = await adapter.send(MESSAGE.chatId, REPLY);
        // `malformed` is a 200 with a bad body: a send may count that as sent, but never as an exception.
        if (!result.ok) {
          expect(result.reason).not.toContain(TOKEN);
          expect(result.reason).not.toContain(REPLY);
        }
        if (mode !== "malformed") expect(result.ok).toBe(false);
      });
    }

    test("a bot that never answers does not hold poll or send past their timeout", async () => {
      fake.mode = "hang";
      const started = performance.now();
      const polled = await adapter.poll();
      const sent = await adapter.send(MESSAGE.chatId, REPLY);
      expect(polled.messages).toEqual([]);
      expect(typeof polled.error).toBe("string");
      expect(sent.ok).toBe(false);
      expect(performance.now() - started).toBeLessThan(5000);
    }, 10_000);

    test("a bot that is not there is an empty poll and a failed send", async () => {
      await fake.stop();
      const polled = await adapter.poll();
      const sent = await adapter.send(MESSAGE.chatId, REPLY);
      expect(polled.messages).toEqual([]);
      expect(typeof polled.error).toBe("string");
      expect(sent.ok).toBe(false);
      if (!sent.ok) expect(sent.reason).not.toContain(REPLY);
    });

    test("send puts the chat id and the text on the wire, and nothing else, and the token in one header only", async () => {
      expect(await adapter.send(MESSAGE.chatId, REPLY)).toEqual({ ok: true });
      const sends = fake.requests.filter((request) => request.method === "POST");
      expect(sends.length).toBe(1);
      const request = sends[0]!;
      const body = JSON.parse(request.body) as unknown;
      const values = stringValues(body);
      expect(values).toContain(MESSAGE.chatId);
      expect(values).toContain(REPLY);
      for (const value of values) expect([MESSAGE.chatId, REPLY], `an extra string on the wire: ${value}`).toContain(value);
      expect(request.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
      expect(request.body).not.toContain(TOKEN);
      expect(request.path).not.toContain(TOKEN);
      for (const [key, value] of Object.entries(request.headers)) {
        if (key !== "authorization") expect(value, `header ${key}`).not.toContain(TOKEN);
      }
    });

    test("poll does not put the token anywhere but the header either", async () => {
      await adapter.poll();
      for (const request of fake.requests) {
        expect(request.path).not.toContain(TOKEN);
        expect(request.body).not.toContain(TOKEN);
      }
      for (const url of urls) expect(url).not.toContain(TOKEN);
    });

    test("it never calls a host other than its own origin", async () => {
      fake.inbox.push(spec.inbox(MESSAGE));
      await adapter.poll();
      await adapter.send(MESSAGE.chatId, REPLY);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url.startsWith(`${fake.origin}/`)).toBe(true);
    });
  });
}
