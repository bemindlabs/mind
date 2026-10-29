/**
 * S22.2 (D-197) — the classifier, fed the shapes S22.1 found in the vendors' own logs
 * (`notes/2026-10-27_s22-1-quota-signals.md`), with times, ids and URLs taken out.
 */

import { describe, expect, test } from "bun:test";
import { classifyLimit, MAX_HOLD_MS } from "../../src/exec/limit.ts";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const seconds = (ms: number): number => Math.floor(ms / 1000);

describe("classifyLimit", () => {
  test("claude: a session limit, with the reset the transcript carries as epoch seconds", () => {
    const raw = `You've hit your session limit · resets 3pm (Asia/Bangkok) {"status":"rejected","resetsAt":${seconds(NOW + 3_600_000)},"rateLimitType":"five_hour"}`;
    expect(classifyLimit(raw, NOW)).toEqual({
      kind: "exhausted",
      window: "session",
      until: NOW + 3_600_000 - ((NOW + 3_600_000) % 1000),
      reason: "session limit reached",
    });
  });

  test("claude: a weekly limit with only the words has no time, and says which allowance it was", () => {
    expect(classifyLimit("You've hit your weekly limit · resets Oct 31, 9am (Asia/Bangkok)", NOW)).toEqual({
      kind: "exhausted",
      window: "weekly",
      reason: "weekly limit reached",
    });
  });

  test("codex: two windows in one failure, the earliest reset wins", () => {
    const raw =
      `You've hit your usage limit. {"primary":{"used_percent":100,"resets_at":${seconds(NOW + 4 * 3_600_000)}},` +
      `"secondary":{"used_percent":21,"resets_at":${seconds(NOW + 6 * 86_400_000)}}}`;
    const signal = classifyLimit(raw, NOW);
    expect(signal?.kind).toBe("exhausted");
    expect(signal?.until).toBe(seconds(NOW + 4 * 3_600_000) * 1000);
  });

  test("a reset in the past, or further off than the cap, is not a hold", () => {
    expect(classifyLimit(`hit your usage limit "resets_at": ${seconds(NOW - 60_000)}`, NOW)?.until).toBeUndefined();
    expect(classifyLimit(`hit your usage limit "resets_at": ${seconds(NOW + MAX_HOLD_MS + 86_400_000)}`, NOW)?.until).toBeUndefined();
  });

  test("a reset in milliseconds is read as milliseconds", () => {
    const at = NOW + 90_000;
    expect(classifyLimit(`hit your usage limit resetsAt: ${at}`, NOW)?.until).toBe(at);
  });

  test("gemini and copilot name the quota and give no time", () => {
    expect(classifyLimit("RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade", NOW)).toEqual({
      kind: "exhausted",
      reason: "quota reached",
    });
    expect(classifyLimit('{"error":{"message":"You have no quota","code":"quota_exceeded"}}', NOW)).toEqual({
      kind: "exhausted",
      reason: "no quota",
    });
  });

  test("a lost login is its own class, and wins over a 429 in the same text", () => {
    expect(classifyLimit('{"error":"authentication_failed","apiErrorStatus":429}', NOW)).toEqual({
      kind: "auth",
      reason: "login needed",
    });
  });

  test("a busy moment is transient", () => {
    for (const raw of ['"apiErrorIsTransient": true', "service overloaded", "HTTP 429", "rate limited, retry", "temporarily unavailable"]) {
      expect(classifyLimit(raw, NOW)?.kind).toBe("transient");
    }
  });

  test("an ordinary failure says nothing about the allowance", () => {
    expect(classifyLimit("exit 1: could not read the file", NOW)).toBeUndefined();
    expect(classifyLimit("", NOW)).toBeUndefined();
  });

  test("the reason is a fixed phrase, never a slice of what was printed", () => {
    const secret = "my-prompt-with-a-sentinel-9f3a";
    const signal = classifyLimit(`${secret} quota exceeded ${secret}`, NOW);
    expect(signal?.reason).toBe("quota reached");
    expect(JSON.stringify(signal)).not.toContain(secret);
  });
});
