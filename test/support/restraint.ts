/**
 * A {@link Restraint} for tests, built the way the program builds one.
 *
 * Deliberately **not** `{} as Restraint`: `test/decide/restraint.test.ts` has an
 * AST gate that refuses that cast everywhere but `src/exec/restraint.ts`, and a
 * test helper that exempted itself would have written the bypass it is there to
 * prevent. Everything here goes through `effectiveDial` and `restrain`, so a
 * test asking for level 2 gets level 2 by the same arithmetic a turn does —
 * including the minimum, which is why every category is set together.
 */

import { restrain, type Restraint } from "../../src/exec/restraint.ts";
import { effectiveDial } from "../../src/decide/effective.ts";
import type { Level, ReachLevel } from "../../src/decide/autonomy.ts";

/**
 * Every category at `level`, run through the real decision.
 *
 * `reach` is capped at 2 by its own type, so level 3 here produces an acting
 * level of 2 — which is the truth about level 3 and not a limitation of the
 * helper: `min(write, run, reach)` can never exceed what reach is allowed to be.
 */
export function atLevel(level: Level): Restraint {
  return restrain(
    effectiveDial({
      stored: {
        read: level,
        write: level,
        run: level,
        reach: Math.min(level, 2) as ReachLevel,
        operate: 0,
        setBy: null,
        setAt: null,
      },
      source: "file",
      envValue: undefined,
      stopped: false,
      // A 3 here stands for one a person confirmed at a terminal (D-042);
      // without this every 3 would be held at 2 and level 3 untestable.
      confirmedThree: ["read", "write", "run"],
    }),
  );
}

/** The default: the vendor's read-only flag goes on, which is what Mind has always done. */
export const RESTRAINED: Restraint = atLevel(1);

/** The loosened one: no read-only flag at all. Used only where that is the point. */
export const LOOSENED: Restraint = atLevel(2);

/**
 * Every category at `level`, `operate` included (D-153) — the restraint a turn handed a browser runs under.
 * {@link atLevel} keeps `operate` at 0, which is what every turn that is not about a browser has.
 */
export function operating(level: Level): Restraint {
  return restrain(
    effectiveDial({
      stored: {
        read: level,
        write: level,
        run: level,
        reach: Math.min(level, 2) as ReachLevel,
        operate: level,
        setBy: null,
        setAt: null,
      },
      source: "file",
      envValue: undefined,
      stopped: false,
      confirmedThree: ["read", "write", "run", "operate"],
    }),
  );
}
