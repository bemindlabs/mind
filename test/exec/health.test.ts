/**
 * S22.2 (D-197) — the health book: how long a backend rests, and that the rest outlives the process.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_REPROBE_MS, BACKOFF_MS, fileHealth, healthPath, holdFor, memoryHealth } from "../../src/exec/health.ts";
import type { LimitSignal } from "../../src/exec/limit.ts";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const MIN = 60_000;
const exhausted = (until?: number): LimitSignal => ({
  kind: "exhausted",
  reason: "no quota",
  ...(until === undefined ? {} : { until }),
});

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "mind-health-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("holdFor", () => {
  test("a transient signal earns no hold", () => {
    expect(holdFor(undefined, { kind: "transient", reason: "busy or rate limited" }, NOW)).toBeUndefined();
  });

  test("the vendor's own reset time is used as given", () => {
    expect(holdFor(undefined, exhausted(NOW + 7 * MIN), NOW)?.until).toBe(NOW + 7 * MIN);
  });

  test("with no reset time the rest climbs the ladder and stays on its last step", () => {
    let entry = holdFor(undefined, exhausted(), NOW);
    expect(entry?.until).toBe(NOW + (BACKOFF_MS[0] as number));
    entry = holdFor(entry, exhausted(), entry?.until ?? 0);
    expect(entry?.strikes).toBe(2);
    expect(entry?.until).toBe((BACKOFF_MS[0] as number) + NOW + (BACKOFF_MS[1] as number));
    for (let i = 0; i < 4; i += 1) entry = holdFor(entry, exhausted(), entry?.until ?? 0);
    const last = holdFor(entry, exhausted(), entry?.until ?? 0);
    expect((last?.until ?? 0) - (entry?.until ?? 0)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1] as number);
  });

  test("a strike older than a day is forgotten", () => {
    const old = holdFor(undefined, exhausted(), NOW);
    const later = NOW + 3 * 86_400_000;
    expect(holdFor(old, exhausted(), later)?.strikes).toBe(1);
  });

  test("a lost login is held only for the re-probe interval, not for as long as it would take to heal", () => {
    const entry = holdFor(undefined, { kind: "auth", reason: "login needed" }, NOW);
    expect(entry?.kind).toBe("auth");
    expect(entry?.until).toBe(NOW + AUTH_REPROBE_MS);
  });
});

describe("memoryHealth", () => {
  test("a rest ends at its time, and a backend never noted is free", () => {
    const health = memoryHealth();
    health.record("claude", exhausted(NOW + 5 * MIN), NOW);
    expect(health.coolingUntil("claude", NOW + MIN)?.reason).toBe("no quota");
    expect(health.coolingUntil("claude", NOW + 5 * MIN)).toBeUndefined();
    expect(health.coolingUntil("codex", NOW)).toBeUndefined();
  });

  test("a transient signal changes nothing", () => {
    const health = memoryHealth();
    health.record("claude", { kind: "transient", reason: "busy or rate limited" }, NOW);
    expect(health.coolingUntil("claude", NOW)).toBeUndefined();
  });
});

describe("fileHealth", () => {
  test("a rest noted by one process is seen by the next", () => {
    const path = join(scratch(), "state", "health.json");
    fileHealth(path).record("claude", exhausted(NOW + 5 * MIN), NOW);
    expect(fileHealth(path).coolingUntil("claude", NOW)?.until).toBe(NOW + 5 * MIN);
  });

  test("the file is the owner's alone and holds no prompt, answer or key", () => {
    const dir = scratch();
    const path = join(dir, "state", "health.json");
    fileHealth(path).record("claude", exhausted(NOW + 5 * MIN), NOW);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    const body: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys((body as { backends: object }).backends)).toEqual(["claude"]);
    expect(Object.keys((body as { backends: { claude: object } }).backends.claude).sort()).toEqual(["kind", "reason", "strikes", "until"]);
  });

  test("a missing, corrupt or foreign file reads as an empty book", () => {
    const dir = scratch();
    const path = join(dir, "health.json");
    expect(fileHealth(path).coolingUntil("claude", NOW)).toBeUndefined();
    for (const body of ["not json", "null", '{"backends":null}', '{"backends":{"claude":{"kind":"nope"}}}']) {
      writeFileSync(path, body);
      expect(fileHealth(path).coolingUntil("claude", NOW)).toBeUndefined();
    }
  });

  test("entries long past their end are dropped on the next write", () => {
    const path = join(scratch(), "health.json");
    const health = fileHealth(path);
    health.record("claude", exhausted(NOW + MIN), NOW);
    health.record("codex", exhausted(NOW + 3 * 86_400_000 + MIN), NOW + 3 * 86_400_000);
    const body = JSON.parse(readFileSync(path, "utf8")) as { backends: Record<string, unknown> };
    expect(Object.keys(body.backends)).toEqual(["codex"]);
  });

  test("a place it cannot write is silent: the turn goes on", () => {
    const dir = scratch();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    const path = join(locked, "inner", "health.json");
    expect(() => fileHealth(path).record("claude", exhausted(NOW + MIN), NOW)).not.toThrow();
    expect(existsSync(path)).toBe(false);
    chmodSync(locked, 0o700);
  });

  test("it lives under the state root, with the ledger", () => {
    expect(healthPath("/home/x", { XDG_STATE_HOME: "/var/state" })).toBe("/var/state/mind/health.json");
    expect(healthPath("/home/x", {})).toBe("/home/x/.local/state/mind/health.json");
  });
});

describe("a rest by hand, and calling a backend back (S22.9)", () => {
  const NOW = 1_000_000_000_000;
  const HOUR = 3_600_000;

  test("rests a backend with the fixed phrase, never longer than a day, never shorter than one already in force", () => {
    const health = memoryHealth();
    health.rest("claude", NOW + HOUR, NOW);
    expect(health.coolingUntil("claude", NOW)).toMatchObject({ kind: "exhausted", reason: "rested by hand", until: NOW + HOUR });
    health.rest("claude", NOW + HOUR / 2, NOW);
    expect(health.coolingUntil("claude", NOW)?.until).toBe(NOW + HOUR);
    health.rest("codex", NOW + 25 * HOUR, NOW);
    health.rest("grok", NOW - 1, NOW);
    expect(health.coolingUntil("codex", NOW)).toBeUndefined();
    expect(health.coolingUntil("grok", NOW)).toBeUndefined();
  });

  test("waking forgets the strikes too: the next real signal starts at the first step of the ladder", () => {
    const health = memoryHealth();
    health.record("claude", { kind: "exhausted", reason: "usage limit reached" }, NOW);
    health.record("claude", { kind: "exhausted", reason: "usage limit reached" }, NOW + 16 * 60_000);
    expect(health.wake("claude")).toBe(true);
    expect(health.wake("claude")).toBe(false);
    health.record("claude", { kind: "exhausted", reason: "usage limit reached" }, NOW + 17 * 60_000);
    expect(health.coolingUntil("claude", NOW + 17 * 60_000)?.until).toBe(NOW + 17 * 60_000 + 15 * 60_000);
  });

  test("on disk it survives a new process, wakes in the file, and lists what rests", () => {
    const path = join(scratch(), "health.json");
    fileHealth(path).rest("claude", Date.now() + HOUR, Date.now());
    expect(fileHealth(path).coolingUntil("claude", Date.now())?.reason).toBe("rested by hand");
    expect([...fileHealth(path).resting(Date.now()).keys()]).toEqual(["claude"]);
    expect(fileHealth(path).wake("claude")).toBe(true);
    expect(fileHealth(path).coolingUntil("claude", Date.now())).toBeUndefined();
    expect(fileHealth(path).resting(Date.now()).size).toBe(0);
  });
});
