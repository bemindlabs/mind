import { describe, expect, test } from "bun:test";
import { memoryHealth } from "../../src/exec/health.ts";
import { backendReadiness } from "../../src/task/backend-ready.ts";
import { chainRest, namedChain } from "../../src/task/rest.ts";
import { aTask } from "./fixture.ts";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const HOUR = 3_600_000;

function resting(...entries: readonly [string, number][]) {
  const health = memoryHealth();
  for (const [id, until] of entries) health.record(id, { kind: "exhausted", until, reason: "session limit reached" }, NOW);
  return health;
}

describe("a task whose backends are all resting (S22.10)", () => {
  test("is held, with the time the first one is back, when every backend of its named chain rests", () => {
    const state = chainRest({ backend: "claude,codex" }, resting(["claude", NOW + 5 * HOUR], ["codex", NOW + 2 * HOUR]), NOW);
    expect(state?.retryAt).toBe(NOW + 2 * HOUR);
    expect(state?.reason).toContain("claude: session limit reached");
    expect(state?.reason).toContain("codex: session limit reached");
  });

  test("is not held while any one backend of the chain is free: the turn's own fallback skips the resting ones", () => {
    expect(chainRest({ backend: "claude,codex" }, resting(["claude", NOW + HOUR]), NOW)).toBeUndefined();
  });

  test("is never held on the usual chain, which ends in a model on this machine and has no name", () => {
    expect(namedChain({ backend: null })).toEqual([]);
    expect(chainRest({ backend: null }, resting(["claude", NOW + HOUR], ["codex", NOW + HOUR]), NOW)).toBeUndefined();
  });

  test("a rest that has ended holds nothing", () => {
    expect(chainRest({ backend: "claude" }, resting(["claude", NOW + HOUR]), NOW + 2 * HOUR)).toBeUndefined();
  });

  test("the reason is built from the fixed phrases, never from text a backend printed", () => {
    const health = memoryHealth();
    health.record("claude", { kind: "exhausted", until: NOW + HOUR, reason: "session limit reached" }, NOW);
    expect(chainRest({ backend: "claude" }, health, NOW)?.reason).toBe(
      `every backend of its chain is resting — claude: session limit reached (until ${new Date(NOW + HOUR).toISOString()})`,
    );
  });

  test("backendReadiness says not ready with retryAt for a resting chain, and ready for any other task", async () => {
    const ready = backendReadiness({}, undefined, { health: resting(["claude", NOW + HOUR]), now: () => NOW });
    const held = await ready(aTask({ backend: "claude" }));
    expect(held.ready).toBe(false);
    if (!held.ready) expect(held.retryAt).toBe(NOW + HOUR);
    expect(await ready(aTask({ backend: "codex" }))).toEqual({ ready: true });
    expect(await ready(aTask({ backend: null }))).toEqual({ ready: true });
    // Without a book of resting backends, as before S22.10: ready.
    expect(await backendReadiness({})(aTask({ backend: "claude" }))).toEqual({ ready: true });
  });
});
