/**
 * S18.1 — what a task's runner does when it is sent SIGTERM (how systemd stops its unit, and how `kill` ends it).
 *
 * The decision is whether a stop was asked. If one was (`task stop`, `mind stop`, the brake), the runner answers
 * as it always has: it stops, closes the task `stopped`. If none was — the user's manager going down at a reboot,
 * `systemctl --user stop mind-task-<id>` by hand — the runner leaves the task for `task resume`: the step's turn
 * is ended the same way, the step is closed as interrupted, and nothing is claimed about the goal.
 *
 * Two ways out if the runner cannot get there by itself: a second SIGTERM, and {@link TERM_HARD_EXIT_MS} after
 * the first, force the process to exit. Under systemd the unit's own `TimeoutStopSec` (60 s) sends SIGKILL first;
 * this is for a runner that is not in a unit.
 *
 * Pure of processes, so that both branches are unit-tested: what is asked of the world is injected.
 */

import { LEFT_EXIT_CODE } from "./unit.ts";

/** A little over the unit's `TimeoutStopSec`. */
export const TERM_HARD_EXIT_MS = 65_000;

export interface TermDeps {
  /** Was a stop asked: the task's `stop` file, or the brake. */
  readonly stopAsked: () => Promise<boolean>;
  /** End the step's turn, if one runs. */
  readonly endTurn: () => Promise<void>;
  /** Force the process out. */
  readonly exit: (code: number) => void;
  readonly hardExitMs?: number;
}

export interface TermState {
  readonly onTerm: () => void;
  readonly stopping: () => boolean;
  readonly leaving: () => boolean;
  /** Cancel the hard-exit timer: the runner has ended by itself. */
  readonly dispose: () => void;
}

export function termHandler(deps: TermDeps): TermState {
  let stopping = false;
  let leaving = false;
  let signalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    onTerm: () => {
      if (signalled) {
        // A second SIGTERM: somebody who asked twice is not going to wait for the first.
        deps.exit(LEFT_EXIT_CODE);
        return;
      }
      signalled = true;
      timer = setTimeout(() => deps.exit(LEFT_EXIT_CODE), deps.hardExitMs ?? TERM_HARD_EXIT_MS);
      timer.unref?.();
      void (async () => {
        if (await deps.stopAsked().catch(() => false)) stopping = true;
        else leaving = true;
        await deps.endTurn().catch(() => undefined);
      })();
    },
    stopping: () => stopping,
    leaving: () => leaving,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
