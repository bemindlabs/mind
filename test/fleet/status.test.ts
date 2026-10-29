import { describe, expect, test } from "bun:test";
import { memoryHealth } from "../../src/exec/health.ts";
import { fleetView, restBackend, spentOf, stopBot, wakeBackend, type FleetIo } from "../../src/fleet/status.ts";
import type { Bot } from "../../src/fleet/roster.ts";
import type { LedgerEntry } from "../../src/ledger/entry.ts";
import type { TaskRecord } from "../../src/task/store.ts";
import { aTask } from "../task/fixture.ts";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const HOUR = 3_600_000;
const alive = () => ({ startTicks: 1 });
const BOTS: readonly Bot[] = [
  { id: "ada", subject: "fleet-ada", home: "claude", spares: ["codex"], scope: "machine", dir: "/agents/ada" },
  { id: "bo", subject: "fleet-bo", home: "codex", spares: ["claude"], scope: "worktree" },
];

function line(backend: string, usd: number | null, at = "2026-10-27T09:00:00.000Z"): LedgerEntry {
  return { v: 1, kind: "turn", id: "i", turn: "t", at, subject: "fleet-ada", backend, model: null, content: "full", prompt: "SECRET PROMPT", prompt_bytes: 1, text: "SECRET ANSWER", text_bytes: 1, confidence: "confirmed", exit: 0, duration_ms: 1, cost: usd === null ? null : { usd_micros: usd } as never, identity: "system", soul_sha: null } as LedgerEntry;
}

function io(overrides: Partial<FleetIo> = {}, tasks: Record<string, TaskRecord[]> = {}, ledger: Record<string, LedgerEntry[]> = {}): FleetIo {
  return {
    tasks: async (subject) => tasks[subject] ?? [],
    ledger: async (subject) => ledger[subject] ?? [],
    reach: async (id) => (id === "codex" ? { ok: false, reason: "not logged in" } : { ok: true }),
    stopTask: async () => ({ ok: true }),
    liveness: alive,
    ...overrides,
  };
}

const running = (id: string, overrides: Partial<TaskRecord> = {}) =>
  aTask({ id, status: "running", generation: 1, runner: { pid: 1, start: 1, since: "2026-10-27T09:00:00.000Z" }, createdAt: "2026-10-27T09:00:00.000Z", ...overrides });

describe("the fleet view (S22.9)", () => {
  test("one row per bot: home, spares, status, the task it is on and the backend that answered last", async () => {
    const task = running("t-00000001", { steps: [{ n: 1, kind: "step", startedAt: "a", finishedAt: "b", turnId: "x", backend: "codex", exit: 0, outcome: "ok", summary: "SECRET SUMMARY", done: false, tokens: 1, ms: 1, waitedMs: 0 }] });
    const view = await fleetView(BOTS, io({}, { "fleet-ada": [task] }), memoryHealth(), NOW);
    const ada = view.bots[0]!;
    expect(ada).toMatchObject({ id: "ada", home: "claude", spares: ["codex"], status: "working", using: "codex", canStop: true });
    expect(ada.task).toEqual({ id: "t-00000001", status: "running", steps: 1 });
    expect(view.bots[1]).toMatchObject({ id: "bo", status: "idle", task: null, canStop: false });
  });

  test("handoffs include only the requested fields for every task", async () => {
    const handoff = { repo: "/repo", branch: "mind/one", base: "main", gate: "SECRET GATE", at: "now", diffStat: " a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)", untracked: ["SECRET FILE"], mergeCommand: "git -C /repo merge --ff-only mind/one" };
    const tasks = [aTask({ id: "t-00000001", status: "done", goal: "SECRET GOAL", handoff }), aTask({ id: "t-00000002", status: "done", handoff: { ...handoff, branch: "mind/two", diffStat: "" } }), aTask({ id: "t-00000003", status: "done" })];
    const view = await fleetView(BOTS, io({}, { "fleet-ada": tasks }), memoryHealth(), NOW);
    expect(view.bots[0]!.handoffs).toEqual([
      { id: "t-00000001", branch: "mind/one", base: "main", changedFiles: 1, diffStat: handoff.diffStat, mergeCommand: handoff.mergeCommand },
      { id: "t-00000002", branch: "mind/two", base: "main", changedFiles: 0, diffStat: "", mergeCommand: handoff.mergeCommand },
    ]);
    expect(view.bots[1]!.handoffs).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  test("a bot whose whole chain rests is resting; a parked task is parked", async () => {
    const health = memoryHealth();
    health.rest("claude", NOW + HOUR, NOW);
    health.rest("codex", NOW + 2 * HOUR, NOW);
    const view = await fleetView(BOTS, io(), health, NOW);
    expect(view.bots.map((b) => b.status)).toEqual(["resting", "resting"]);
    const parked = aTask({ id: "t-00000002", status: "parked", createdAt: "2026-10-27T08:00:00.000Z" });
    const free = await fleetView(BOTS, io({}, { "fleet-ada": [parked] }), memoryHealth(), NOW);
    expect(free.bots[0]!.status).toBe("parked");
  });

  test("the backend table: reachable or not and why, how long it rests and whether by hand, and whom it serves", async () => {
    const health = memoryHealth();
    health.record("claude", { kind: "exhausted", until: NOW + HOUR, reason: "session limit reached" }, NOW);
    health.rest("codex", NOW + 30 * 60_000, NOW);
    const view = await fleetView(BOTS, io(), health, NOW);
    expect(view.backends.map((b) => b.id)).toEqual(["claude", "codex"]);
    const claude = view.backends[0]!;
    expect(claude).toMatchObject({ reach: "ok", rest: { kind: "exhausted", reason: "session limit reached", byHand: false }, bots: ["ada", "bo"] });
    expect(view.backends[1]).toMatchObject({ reach: "no", reachReason: "not logged in", rest: { reason: "rested by hand", byHand: true } });
  });

  test("a backend the engine cannot reach-check is `unknown`, never `ok`", async () => {
    const view = await fleetView(BOTS, io({ reach: async () => undefined }), memoryHealth(), NOW);
    expect(view.backends.every((b) => b.reach === "unknown")).toBe(true);
  });

  test("spending is counted from the ledger: turns, cloud turns, priced and unpriced, and no word of any line is in the view", async () => {
    const lines = [line("claude", 1200), line("codex", null), line("ollama", null, "2026-10-27T09:30:00.000Z")];
    expect(spentOf(lines)).toEqual({ turns: 3, cloudTurns: 2, costUsdMicros: 1200, unpriced: 1, lastAt: "2026-10-27T09:30:00.000Z" });
    const view = await fleetView(BOTS, io({}, {}, { "fleet-ada": lines }), memoryHealth(), NOW);
    const text = JSON.stringify(view);
    expect(text).not.toContain("SECRET");
    expect(view.bots[0]!.spent.cloudTurns).toBe(2);
  });
});

describe("what a person may do from the page", () => {
  test("rest a backend of this fleet, for a whole number of minutes up to a day; anything else is refused", () => {
    const health = memoryHealth();
    expect(restBackend(BOTS, health, "claude", 60, NOW).ok).toBe(true);
    expect(health.coolingUntil("claude", NOW)?.reason).toBe("rested by hand");
    for (const bad of [0, -1, 1.5, 1441, "60", null, undefined]) expect(restBackend(BOTS, health, "codex", bad, NOW).ok, String(bad)).toBe(false);
    expect(restBackend(BOTS, health, "gemini", 60, NOW)).toMatchObject({ ok: false });
    expect(restBackend(BOTS, health, "../x", 60, NOW)).toMatchObject({ ok: false });
    expect(health.coolingUntil("codex", NOW)).toBeUndefined();
  });

  test("wake clears a rest at once, earned or by hand, and says when there was nothing to clear", () => {
    const health = memoryHealth();
    health.record("claude", { kind: "exhausted", until: NOW + HOUR, reason: "usage limit reached" }, NOW);
    expect(wakeBackend(BOTS, health, "claude")).toMatchObject({ ok: true, message: "claude is called back" });
    expect(health.coolingUntil("claude", NOW)).toBeUndefined();
    expect(wakeBackend(BOTS, health, "claude")).toMatchObject({ ok: true, message: "claude was not resting" });
    expect(wakeBackend(BOTS, health, "unknown")).toMatchObject({ ok: false });
  });

  test("stop a bot asks each of its unfinished tasks to stop and leaves the finished ones", async () => {
    const asked: string[] = [];
    const tasks = { "fleet-ada": [running("t-00000010"), running("t-00000011"), aTask({ id: "t-00000012", status: "done" })] };
    const result = await stopBot(BOTS, io({ stopTask: async (_bot, id) => (asked.push(id), { ok: true }) }, tasks), "ada", NOW);
    expect(result).toMatchObject({ ok: true, tasks: ["t-00000010", "t-00000011"] });
    expect(asked.sort()).toEqual(["t-00000010", "t-00000011"]);
  });

  test("a bot with no dir in the roster, a failed stop, and a bot that is not in the fleet are said, not hidden", async () => {
    expect(await stopBot(BOTS, io(), "bo", NOW)).toMatchObject({ ok: false });
    expect(await stopBot(BOTS, io(), "nobody", NOW)).toMatchObject({ ok: false });
    const failing = await stopBot(BOTS, io({ stopTask: async () => ({ ok: false }) }, { "fleet-ada": [running("t-00000020")] }), "ada", NOW);
    expect(failing).toMatchObject({ ok: false });
  });
});

describe("the measured table on the fleet view (S22.14 AC4)", () => {
  test("rows come with their n, pooled across the roster's bots, and no word of any task is in them", async () => {
    const measure = (backend: string, status: "done" | "failed", task: string) => ({ v: 1 as const, task, subject: "x", at: "2026-10-28T00:00:00.000Z", kind: "bugfix", status, backend, model: "m", steps: [], turns: 2, tokens: 5, tokensUnknown: 0, activeMs: 1, review: null });
    const view = await fleetView(BOTS, io({ measures: async (subject) => (subject === "fleet-ada" ? [measure("claude", "done", "t-00000001"), measure("claude", "failed", "t-00000002")] : [measure("claude", "done", "t-00000003")]) }), memoryHealth(), NOW);
    expect(view.dispatch).toHaveLength(1);
    expect(view.dispatch[0]).toMatchObject({ backend: "claude", kind: "bugfix", n: 3, done: 2 });
    expect((await fleetView(BOTS, io(), memoryHealth(), NOW)).dispatch).toEqual([]);
  });
});
