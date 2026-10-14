/** The Telegram adapter (S9.1, D-066): the Bot API's shapes, against a fake fetch. */

import { describe, expect, test } from "bun:test";
import { TELEGRAM_API, TELEGRAM_MAX_TEXT, TelegramConnector, telegramBase, toMessages } from "../../src/connectors/telegram.ts";

const update = (id: number, over: Record<string, unknown> = {}) => ({
  update_id: id,
  message: { message_id: id * 10, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text: `m${id}`, ...over },
});

describe("telegramBase", () => {
  test("the real API unless an https or loopback override is given", () => {
    expect(telegramBase(undefined)).toBe(TELEGRAM_API);
    expect(telegramBase("")).toBe(TELEGRAM_API);
    expect(telegramBase("http://127.0.0.1:9/")).toBe("http://127.0.0.1:9");
    expect(telegramBase("https://tg.example")).toBe("https://tg.example");
    expect(telegramBase("http://evil.example")).toBe(TELEGRAM_API);
    expect(telegramBase("not a url")).toBe(TELEGRAM_API);
  });
});

describe("toMessages", () => {
  test("private text from a person; groups, bots, stickers and junk are skipped, but still advance the offset", () => {
    const read = toMessages({
      ok: true,
      result: [
        update(5),
        update(6, { chat: { id: -9, type: "group" } }),
        update(7, { from: { id: 3, is_bot: true } }),
        update(8, { text: undefined, sticker: {} }),
        { update_id: 9, edited_message: {} },
      ],
    });
    expect(read.messages).toEqual([{ platform: "telegram", chatId: "42", userId: "42", messageId: "50", text: "m5" }]);
    expect(read.next).toBe(10);
    expect(toMessages(null)).toEqual({ messages: [], next: undefined });
    expect(toMessages({ ok: false })).toEqual({ messages: [], next: undefined });
  });
});

describe("TelegramConnector", () => {
  test("polls with the offset it was given, then the next one", async () => {
    const urls: string[] = [];
    const offsets: number[] = [];
    const fake = async (url: string) => {
      urls.push(url);
      return Response.json({ ok: true, result: [update(3)] });
    };
    const c = new TelegramConnector("1:tok", { base: "http://127.0.0.1:1", fetch: fake, pollSeconds: 0, offset: 2, onOffset: (o) => offsets.push(o) });
    expect((await c.poll()).messages).toHaveLength(1);
    await c.poll();
    expect(urls[0]).toStartWith("http://127.0.0.1:1/bot1:tok/getUpdates?");
    expect(urls[0]).toContain("offset=2");
    expect(urls[1]).toContain("offset=4");
    expect(offsets).toEqual([4, 4]);
  });

  test("a failure is an empty poll with a reason, never a throw", async () => {
    const down = new TelegramConnector("1:tok", { fetch: async () => new Response("", { status: 502 }) });
    expect(await down.poll()).toEqual({ messages: [], error: "Telegram answered 502" });
    const gone = new TelegramConnector("1:tok", { fetch: async () => { throw new Error("ECONNREFUSED"); } });
    expect((await gone.poll()).error).toBe("ECONNREFUSED");
  });

  test("sends to the chat, cut to Telegram's limit", async () => {
    let body: { chat_id: string; text: string } | undefined;
    const c = new TelegramConnector("1:tok", {
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ ok: true });
      },
    });
    expect(await c.send("42", "x".repeat(TELEGRAM_MAX_TEXT + 10))).toEqual({ ok: true });
    expect(body!.chat_id).toBe("42");
    expect(body!.text).toHaveLength(TELEGRAM_MAX_TEXT);
    const refused = new TelegramConnector("1:tok", { fetch: async () => new Response("", { status: 403 }) });
    expect(await refused.send("42", "x")).toEqual({ ok: false, reason: "Telegram answered 403" });
    const gone = new TelegramConnector("1:tok", { fetch: async () => { throw new Error("down"); } });
    expect(await gone.send("42", "x")).toEqual({ ok: false, reason: "down" });
  });
});
