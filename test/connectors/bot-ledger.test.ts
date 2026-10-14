/**
 * p5 step 6 — every message in and out of a bot is in the ledger before it is sent, and a ledger that cannot be
 * written means nothing is sent; erase takes each bot's state.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotAdapter } from "../../src/connectors/bot.ts";
import { botConsentPhrase, type BotConsent, botsDirFor, grantBot, isBotApproved, readBotConsent, writeBotConsent } from "../../src/connectors/bot-consent.ts";
import { guardBot } from "../../src/connectors/bot-guard.ts";
import { botRecord, clearBot } from "../../src/connectors/bot-ledger.ts";
import { handleMessage, type ChatDeps, type ChatMessage } from "../../src/connectors/chat.ts";
import { append, query } from "../../src/ledger/store.ts";
import { subjectId } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

const SUBJECT = subjectId("example");
const NOW = new Date("2026-10-12T10:00:00Z");

function adapter(botId: string, events: string[]): BotAdapter {
  return {
    botId,
    platform: botId,
    endpointOrigin: "http://127.0.0.1:41001",
    tokenFile: "/tmp/mind-test/x.token",
    capabilities: { initiates: false, maxTextBytes: 500 },
    poll: async () => ({ messages: [{ platform: botId, chatId: "c1", userId: "u1", messageId: "m1", text: "what is on today?" }] }),
    send: async (chatId, text) => (events.push(`adapter.send:${chatId}:${text}`), { ok: true }),
  };
}

function deps(bot: ReturnType<typeof guardBot>, events: string[], record: ChatDeps["record"]): ChatDeps {
  return {
    agentName: "Mind",
    allowed: async () => true,
    firstContact: async () => false,
    contacted: async () => undefined,
    record: async (direction, message, text, content) => {
      events.push(`record.${direction}`);
      await record(direction, message, text, content);
    },
    turn: async () => (events.push("turn"), { ok: true, text: "Nothing today." }),
    screen: async () => [],
    onBlocked: async () => undefined,
    send: (chatId, text) => bot.send(chatId, text),
  };
}

const guard = (a: BotAdapter) => guardBot(a, { screen: async () => [], onBlocked: async () => undefined });

describe("the ledger comes first", () => {
  test("a message in and its answer out are both in the ledger, under the bot's id, and the out line precedes the send", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-bot-ledger-"));
    scratch.push(home);
    const env = { home, env: { XDG_STATE_HOME: join(home, "state") }, now: () => NOW };
    const events: string[] = [];
    const a = adapter("bot-a", events);
    const bot = guard(a);
    const record = botRecord((entry) => append(env, entry), SUBJECT, () => NOW);
    const [message] = (await bot.poll()).messages;
    expect((await handleMessage(message!, deps(bot, events, record))).kind).toBe("answered");
    expect(events.map((e) => e.split(":")[0])).toEqual(["record.in", "turn", "record.out", "adapter.send"]);
    const lines = (await query(env, SUBJECT)).entries;
    expect(lines.map((l) => l.backend)).toEqual(["chat:bot-a:in:u1", "chat:bot-a:out:u1"]);
    expect(lines[0]!.prompt).toBe("what is on today?");
    expect(lines[1]!.prompt).toBe("Nothing today.");
  });

  test("a ledger that cannot write the answer's line: nothing reaches the bot", async () => {
    const events: string[] = [];
    const bot = guard(adapter("bot-a", events));
    const failing = botRecord(async (entry) => {
      if (entry.backend.includes(":out:")) throw new Error("disk full");
    }, SUBJECT, () => NOW);
    const [message] = (await bot.poll()).messages;
    await expect(handleMessage(message!, deps(bot, events, failing))).rejects.toThrow("disk full");
    expect(events).toEqual(["record.in", "turn", "record.out"]);
    expect(events.some((e) => e.startsWith("adapter.send"))).toBe(false);
  });

  test("a ledger that cannot write the incoming line: the bot's words are not even given to a turn", async () => {
    const events: string[] = [];
    const bot = guard(adapter("bot-a", events));
    const failing = botRecord(async () => {
      throw new Error("read-only");
    }, SUBJECT, () => NOW);
    const [message] = (await bot.poll()).messages;
    await expect(handleMessage(message!, deps(bot, events, failing))).rejects.toThrow("read-only");
    expect(events).toEqual(["record.in"]);
  });

  test("bot A's lines are not bot B's", async () => {
    const lines: string[] = [];
    const record = botRecord(async (entry) => void lines.push(entry.backend), SUBJECT, () => NOW);
    const msg = (platform: string): ChatMessage => ({ platform, chatId: "c", userId: "u", messageId: "m", text: "t" });
    await record("in", msg("bot-a"), "t", "full");
    await record("in", msg("bot-b"), "t", "full");
    expect(lines).toEqual(["chat:bot-a:in:u", "chat:bot-b:in:u"]);
  });
});

describe("a bot's state goes with erase", () => {
  test("clearBot takes one bot's approval and leaves the others; nothing to clear says so", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-bot-clear-"));
    scratch.push(home);
    const dir = botsDirFor({ home, env: { XDG_STATE_HOME: join(home, "state") } }, SUBJECT);
    const [a, b] = [adapter("bot-a", []), adapter("bot-b", [])];
    let consent: BotConsent = { approvals: [] };
    for (const x of [a, b]) {
      const g = grantBot(consent, x, botConsentPhrase(x.botId, x.endpointOrigin), "owner", NOW);
      if (!g.ok) throw new Error(g.reason);
      consent = g.consent;
    }
    await writeBotConsent(dir, consent);
    expect(await clearBot(dir, "bot-a")).toBe(true);
    const back = await readBotConsent(dir);
    expect(isBotApproved(back, a)).toBe(false);
    expect(isBotApproved(back, b)).toBe(true);
    expect(await clearBot(dir, "bot-a")).toBe(false);
  });
});
