/** p5 step 4 — consent per bot: the typed phrase, stored per bot, and what it does and does not enable. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry, type BotAdapter } from "../../src/connectors/bot.ts";
import {
  botConsentPath,
  botConsentPhrase,
  botsDirFor,
  grantBot,
  isBotApproved,
  readBotConsent,
  revokeBot,
  servableBots,
  writeBotConsent,
  type BotConsent,
} from "../../src/connectors/bot-consent.ts";
import { subjectId } from "../../src/types.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

const NOW = new Date("2026-10-12T10:00:00Z");
const NONE: BotConsent = { approvals: [] };

function bot(botId: string, origin = "http://127.0.0.1:41001"): BotAdapter {
  return {
    botId,
    platform: botId,
    endpointOrigin: origin,
    tokenFile: `/tmp/mind-test/${botId}.token`,
    capabilities: { initiates: false, maxTextBytes: 100 },
    poll: async () => ({ messages: [] }),
    send: async () => ({ ok: true }),
  };
}

const granted = (consent: BotConsent, adapter: BotAdapter): BotConsent => {
  const result = grantBot(consent, adapter, botConsentPhrase(adapter.botId, adapter.endpointOrigin), "owner", NOW);
  if (!result.ok) throw new Error(result.reason);
  return result.consent;
};

describe("the phrase", () => {
  test("names the bot and its address", () => {
    expect(botConsentPhrase("grok-bot", "https://bot.example")).toBe("serve bot grok-bot at https://bot.example");
  });

  test("the exact phrase grants, with who and when; surrounding whitespace on the line is allowed", () => {
    const a = bot("bot-a");
    const result = grantBot(NONE, a, `  ${botConsentPhrase("bot-a", a.endpointOrigin)}\n`, "owner", NOW);
    expect(result).toEqual({
      ok: true,
      consent: { approvals: [{ botId: "bot-a", endpointOrigin: a.endpointOrigin, approvedBy: "owner", approvedAt: "2026-10-12T10:00:00.000Z" }] },
    });
  });

  test("a near miss, an empty line, a yes, another bot's phrase or another address's phrase grants nothing", () => {
    const a = bot("bot-a");
    const phrase = botConsentPhrase("bot-a", a.endpointOrigin);
    for (const typed of ["", "yes", "y", phrase.toUpperCase(), `${phrase} please`, phrase.replace("serve", "run"), botConsentPhrase("bot-b", a.endpointOrigin), botConsentPhrase("bot-a", "http://127.0.0.1:41002")]) {
      const result = grantBot(NONE, a, typed, "owner", NOW);
      expect(result.ok, JSON.stringify(typed)).toBe(false);
      if (!result.ok) expect(result.reason).toContain(phrase);
    }
  });
});

describe("one bot's approval is only that bot's", () => {
  test("bot A approved does not enable bot B", () => {
    const [a, b] = [bot("bot-a"), bot("bot-b")];
    const consent = granted(NONE, a);
    expect(isBotApproved(consent, a)).toBe(true);
    expect(isBotApproved(consent, b)).toBe(false);
  });

  test("both approved, then A revoked: B stays; revoking an unknown bot changes nothing", () => {
    const [a, b] = [bot("bot-a"), bot("bot-b")];
    const both = granted(granted(NONE, a), b);
    const afterRevoke = revokeBot(both, "bot-a");
    expect(isBotApproved(afterRevoke, a)).toBe(false);
    expect(isBotApproved(afterRevoke, b)).toBe(true);
    expect(revokeBot(both, "nobody")).toEqual(both);
  });

  test("the same bot at another address is not approved; approving the new address replaces the old, never doubles", () => {
    const here = bot("bot-a", "http://127.0.0.1:41001");
    const there = bot("bot-a", "http://127.0.0.1:41002");
    const consent = granted(NONE, here);
    expect(isBotApproved(consent, there)).toBe(false);
    const moved = granted(consent, there);
    expect(moved.approvals.length).toBe(1);
    expect(isBotApproved(moved, there)).toBe(true);
    expect(isBotApproved(moved, here)).toBe(false);
  });
});

describe("the record", () => {
  test("written 600 in a 700 directory under the state root, read back; a missing or broken file is nobody", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-bot-consent-"));
    scratch.push(home);
    const dir = botsDirFor({ home, env: { XDG_STATE_HOME: join(home, "state") } }, subjectId("example"));
    expect(dir).toContain(join("state", "mind", "bots", "example"));
    expect(await readBotConsent(dir)).toEqual(NONE);
    const consent = granted(NONE, bot("bot-a"));
    await writeBotConsent(dir, consent);
    expect(((await stat(botConsentPath(dir))).mode & 0o777).toString(8)).toBe("600");
    expect(((await stat(dir)).mode & 0o777).toString(8)).toBe("700");
    expect(await readBotConsent(dir)).toEqual(consent);
    await writeFile(botConsentPath(dir), "{not json");
    expect(await readBotConsent(dir)).toEqual(NONE);
    await writeFile(botConsentPath(dir), JSON.stringify({ approvals: [{ botId: "bot-a" }, 7, null] }));
    expect(await readBotConsent(dir)).toEqual(NONE);
    await writeFile(botConsentPath(dir), JSON.stringify({ approvals: "bot-a" }));
    expect(await readBotConsent(dir)).toEqual(NONE);
  });
});

describe("what may be served", () => {
  const JUDGE = { MIND_EGRESS_JUDGE: "llama-local" };

  function registry(...adapters: BotAdapter[]): BotRegistry {
    const r = new BotRegistry();
    for (const adapter of adapters) expect(r.register(adapter)).toEqual({ ok: true });
    return r;
  }

  test("nothing is served by default, and each refusal says what to type", () => {
    const a = bot("bot-a");
    const result = servableBots(registry(a), NONE, JUDGE);
    expect(result.serve).toEqual([]);
    expect(result.refused).toEqual([{ botId: "bot-a", reason: `not approved: ${botConsentPhrase("bot-a", a.endpointOrigin)}` }]);
  });

  test("an approved bot is served when the local judge is set; its neighbour that is not approved is not", () => {
    const [a, b] = [bot("bot-a"), bot("bot-b")];
    const result = servableBots(registry(a, b), granted(NONE, a), JUDGE);
    expect(result.serve).toEqual([a]);
    expect(result.refused.map((r) => r.botId)).toEqual(["bot-b"]);
  });

  test("an approved bot is still not served without the local judge", () => {
    const a = bot("bot-a");
    const result = servableBots(registry(a), granted(NONE, a), {});
    expect(result.serve).toEqual([]);
    expect(result.refused[0]!.reason).toContain("MIND_EGRESS_JUDGE");
  });

  test("a bot whose address changed after approval is refused, and the reason says so", () => {
    const old = bot("bot-a", "http://127.0.0.1:41001");
    const result = servableBots(registry(bot("bot-a", "http://127.0.0.1:41002")), granted(NONE, old), JUDGE);
    expect(result.serve).toEqual([]);
    expect(result.refused[0]!.reason).toContain("address changed");
    expect(result.refused[0]!.reason).toContain("http://127.0.0.1:41001");
  });

  test("deciding calls no bot", () => {
    let calls = 0;
    const a: BotAdapter = { ...bot("bot-a"), poll: async () => (calls++, { messages: [] }), send: async () => (calls++, { ok: true }) };
    servableBots(registry(a), granted(NONE, a), JUDGE);
    expect(calls).toBe(0);
  });
});
