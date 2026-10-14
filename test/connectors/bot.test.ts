/**
 * p5 step 1 — the bot interface and its registry. Only what can be seen without calling a bot: a bad adapter is
 * not registered, and registering one starts nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRegistry, checkBotAdapter, originProblem, tokenFileProblem, type BotAdapter } from "../../src/connectors/bot.ts";

/** An adapter that records every call. Holding it in a registry must leave both counts at zero. */
function stub(overrides: Partial<Record<keyof BotAdapter, unknown>> = {}): BotAdapter & { calls: string[] } {
  const calls: string[] = [];
  const base = {
    botId: "stub-bot",
    platform: "stub-bot",
    endpointOrigin: "http://127.0.0.1:41999",
    tokenFile: "/tmp/mind-test/stub-bot.token",
    capabilities: { initiates: false as const, maxTextBytes: 2000 },
    calls,
    async poll() {
      calls.push("poll");
      return { messages: [] };
    },
    async send() {
      calls.push("send");
      return { ok: true as const };
    },
  };
  return { ...base, ...overrides } as BotAdapter & { calls: string[] };
}

describe("an adapter that may be registered", () => {
  test("is checked without a call, and registering starts nothing (off by default)", () => {
    const adapter = stub();
    const registry = new BotRegistry();
    expect(checkBotAdapter(adapter)).toEqual([]);
    expect(registry.register(adapter)).toEqual({ ok: true });
    expect(registry.get("stub-bot")).toBe(adapter);
    expect(registry.ids()).toEqual(["stub-bot"]);
    expect(adapter.calls).toEqual([]);
  });

  test("https on any host is an origin, and so is loopback over http, in either spelling", () => {
    for (const origin of ["https://bot.example.com", "https://bot.example.com:8443", "http://127.0.0.1:1", "http://[::1]:2", "http://localhost:3"]) {
      expect(originProblem(origin), origin).toBeUndefined();
    }
  });

  test("ids come back in the order they were registered", () => {
    const registry = new BotRegistry();
    for (const id of ["zeta", "alpha", "mid"]) expect(registry.register(stub({ botId: id, platform: id })).ok).toBe(true);
    expect(registry.ids()).toEqual(["zeta", "alpha", "mid"]);
    expect(registry.get("nope")).toBeUndefined();
  });
});

describe("an adapter that may not", () => {
  const bad: readonly (readonly [string, Partial<Record<keyof BotAdapter, unknown>>, RegExp])[] = [
    ["an id with capitals", { botId: "Grok", platform: "Grok" }, /botId must match/],
    ["an id that is too short", { botId: "a", platform: "a" }, /botId must match/],
    ["an id with a slash", { botId: "a/b", platform: "a/b" }, /botId must match/],
    ["a platform that is not the id", { platform: "other-bot" }, /platform .* must be the botId/],
    ["plain http off loopback", { endpointOrigin: "http://bot.example.com" }, /https, or http on a loopback/],
    ["an origin with a path", { endpointOrigin: "https://bot.example.com/v1" }, /origin only/],
    ["an origin with a trailing slash", { endpointOrigin: "https://bot.example.com/" }, /origin only/],
    ["an origin with a query", { endpointOrigin: "https://bot.example.com?x=1" }, /origin only/],
    ["an origin with credentials", { endpointOrigin: "https://user:pw@bot.example.com" }, /credentials/],
    ["an origin that is not a URL", { endpointOrigin: "not a url" }, /not a URL/],
    ["a relative token file", { tokenFile: "token" }, /absolute path/],
    ["a bot that may start a conversation", { capabilities: { initiates: true, maxTextBytes: 10 } }, /initiates must be false/],
    ["a zero text limit", { capabilities: { initiates: false, maxTextBytes: 0 } }, /positive integer/],
    ["a fractional text limit", { capabilities: { initiates: false, maxTextBytes: 1.5 } }, /positive integer/],
    ["no send", { send: undefined }, /poll and send must be functions/],
  ];
  for (const [name, overrides, problem] of bad) {
    test(`${name} is refused with the reason, and nothing is held`, () => {
      const registry = new BotRegistry();
      const adapter = stub(overrides);
      const result = registry.register(adapter);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.join("\n")).toMatch(problem);
      expect(registry.ids()).toEqual([]);
      expect(adapter.calls).toEqual([]);
    });
  }

  test("a second adapter with the same id is refused and the first stays", () => {
    const registry = new BotRegistry();
    const first = stub();
    registry.register(first);
    const second = registry.register(stub());
    expect(second).toMatchObject({ ok: false });
    expect(registry.get("stub-bot")).toBe(first);
  });
});

describe("the token file", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("is fine at mode 600, and refused when missing, a directory, or readable by anyone else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mind-bot-token-"));
    scratch.push(dir);
    const file = join(dir, "bot.token");
    await writeFile(file, "x");
    await chmod(file, 0o600);
    expect(await tokenFileProblem(file)).toBeUndefined();
    await chmod(file, 0o640);
    expect(await tokenFileProblem(file)).toContain("must be mode 600 (it is 640)");
    await chmod(file, 0o604);
    expect(await tokenFileProblem(file)).toContain("must be mode 600");
    expect(await tokenFileProblem(join(dir, "missing"))).toContain("cannot be read");
    expect(await tokenFileProblem(dir)).toContain("not a regular file");
  });
});
