/**
 * S18.1 — the runner's SIGTERM handler, both branches: with a stop asked the runner stops; with none it leaves the
 * task for resume. (Inverting that was not caught while it lived in the spawn-only `bin/commands/task.ts`.)
 */

import { describe, expect, test } from "bun:test";
import { LEFT_EXIT_CODE } from "../../src/task/unit.ts";
import { TERM_HARD_EXIT_MS, termHandler } from "../../src/task/term.ts";

function setup(asked: boolean | "throws", hardExitMs?: number) {
  const calls = { ended: 0, exits: [] as number[] };
  const state = termHandler({
    stopAsked: async () => {
      if (asked === "throws") throw new Error("unreadable");
      return asked;
    },
    endTurn: async () => {
      calls.ended += 1;
    },
    exit: (code) => calls.exits.push(code),
    ...(hardExitMs === undefined ? {} : { hardExitMs }),
  });
  return { state, calls };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("the runner's SIGTERM", () => {
  test("a stop was asked: stopping, not leaving; the step's turn is ended", async () => {
    const { state, calls } = setup(true);
    expect([state.stopping(), state.leaving()]).toEqual([false, false]);
    state.onTerm();
    await settled();
    expect([state.stopping(), state.leaving()]).toEqual([true, false]);
    expect(calls.ended).toBe(1);
    state.dispose();
  });

  test("no stop asked (the manager going down, `systemctl --user stop` by hand): leaving, not stopping; the turn is ended too", async () => {
    const { state, calls } = setup(false);
    state.onTerm();
    await settled();
    expect([state.stopping(), state.leaving()]).toEqual([false, true]);
    expect(calls.ended).toBe(1);
    state.dispose();
  });

  test("a stop request that cannot be read counts as none: leaving, and the turn is still ended", async () => {
    const { state, calls } = setup("throws");
    state.onTerm();
    await settled();
    expect([state.stopping(), state.leaving()]).toEqual([false, true]);
    expect(calls.ended).toBe(1);
    state.dispose();
  });

  test("a second SIGTERM forces the exit, with the left-for-resume code; the first does not", async () => {
    const { state, calls } = setup(false);
    state.onTerm();
    await settled();
    expect(calls.exits).toEqual([]);
    state.onTerm();
    expect(calls.exits).toEqual([LEFT_EXIT_CODE]);
    state.dispose();
  });

  test("after the hard-exit time the exit is forced; disposed before it, never", async () => {
    const late = setup(false, 40);
    late.state.onTerm();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(late.calls.exits).toEqual([LEFT_EXIT_CODE]);
    const done = setup(false, 40);
    done.state.onTerm();
    done.state.dispose();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(done.calls.exits).toEqual([]);
    // Without a signal, dispose is harmless.
    setup(true).state.dispose();
    // A little more than the unit's own 60 s, so that systemd's SIGKILL comes first inside a unit.
    expect(TERM_HARD_EXIT_MS).toBeGreaterThan(60_000);
  });
});
