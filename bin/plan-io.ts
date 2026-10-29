/**
 * What a ranking needs, read from this machine for the subjects it is told to: their measure files, the resting book and
 * whether a backend is reachable. Shared by `mind dispatch` and `mind task new --backend auto` — a command may not import
 * another, so the one thing both need lives here. It reads no ledger (D-022).
 */

import { dirname } from "node:path";
import { fileHealth, healthPath } from "../src/exec/health.ts";
import { backend as backendFor } from "../src/exec/index.ts";
import { readMeasures } from "../src/dispatch/measure.ts";
import type { PlanIo } from "../src/dispatch/plan.ts";
import { tasksDir } from "../src/task/store.ts";
import { subjectId } from "../src/types.ts";
import { dialEnv } from "./dial.ts";

/** The facts a ranking needs, read from this machine: the named subjects' measure files and ledgers, the resting book, reach. */
export function planIo(): PlanIo {
  const env = dialEnv();
  const health = fileHealth(healthPath(env.home, env.env));
  return {
    measures: async (subject) => {
      const tasks = await tasksDir(env, subjectId(subject));
      return tasks.ok ? readMeasures(dirname(tasks.path)) : [];
    },
    unusable: async (id) => {
      const rest = health.coolingUntil(id, Date.now());
      if (rest !== undefined) return `resting until ${new Date(rest.until).toISOString()}`;
      try {
        return (await backendFor(id).available()).ok ? undefined : "not reachable here";
      } catch {
        return "not available here";
      }
    },
  };
}

