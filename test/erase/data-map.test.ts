/**
 * S7.1 — the data map is `erase`'s own plan, and nothing Mind keeps for a
 * subject is missing from it (D-050).
 *
 * Every directory the engine resolves from a SubjectId under the state or the
 * data root is listed here with the function that resolves it, and each must
 * appear among the trees `planErase` would remove. A new place that erase
 * does not know is the failure: it is how D-042's confirmations sat outside
 * every erase until this file was written.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmationsDirFor } from "../../src/decide/confirm.ts";
import { runsDirFor } from "../../src/decide/runs.ts";
import { triggersDirFor } from "../../src/decide/triggers.ts";
import { a2aDirFor } from "../../src/a2a/peers.ts";
import { chatDirFor } from "../../src/connectors/users.ts";
import { pushDirFor } from "../../src/web/push-dir.ts";
import { identityDirFor } from "../../src/identity/dir.ts";
import { basisDirFor } from "../../src/consent/basis.ts";
import { browserDirFor } from "../../src/browser/paths.ts";
import { dataMap, subjectTrees } from "../../src/erase/map.ts";
import { planErase } from "../../src/erase/plan.ts";
import { backupTree } from "../../src/erase/soul.ts";
import { personalDir } from "../../src/guard/personal.ts";
import { botsDirFor } from "../../src/connectors/bot-consent.ts";
import { ledgerDir } from "../../src/ledger/store.ts";
import { collectionFor } from "../../src/memory/collection.ts";
import { ragDirFor } from "../../src/memory/marker.ts";
import { subjectId } from "../../src/types.ts";
import { LOCAL_BACKENDS } from "../../src/exec/local-cli.ts";
import { localCliHomeDir } from "../../src/erase/local-cli-homes.ts";

const SUBJECT = subjectId("example");

describe("S7.1 — every place Mind keeps a subject's data is in the erase plan", () => {
  test("the resolvers, and the trees", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-data-map-"));
    try {
      const env = { home, env: { XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), MIND_QDRANT_URL: "http://127.0.0.1:9" }, now: () => new Date() };
      const personal = await personalDir(env, SUBJECT);
      const places: Record<string, string> = {
        "backups (soul apply)": backupTree(env, SUBJECT),
        "level-3 confirmations (D-042)": confirmationsDirFor(env, SUBJECT),
        "run records (S5.4)": runsDirFor(env, SUBJECT),
        "browser task records and their MCP config (D-151)": browserDirFor(env, SUBJECT),
        "trigger fire times (S5.3)": triggersDirFor(env, SUBJECT),
        "A2A peers (D-063)": a2aDirFor(env, SUBJECT),
        "chat allowlist (D-066)": chatDirFor(env, SUBJECT),
        "bot approvals (S9 AC5)": botsDirFor(env, SUBJECT),
        "push handles (D-130)": pushDirFor(env, SUBJECT),
        "basis records (D-077)": basisDirFor(env, SUBJECT),
        "rag marker (D-038)": ragDirFor(env.home, env.env, SUBJECT),
        "personal directory (capture, proposals, egress)": personal.path,
        "the agent's signing key (S15.8, D-108)": identityDirFor(env, SUBJECT),
      };
      const plan = await planErase(env, {
        subject: SUBJECT,
        agentDir: null,
        scope: "all",
        by: "the data map test",
        needles: [],
        instructionFiles: [],
        soulName: null,
        personalValues: [],
      });
      const trees = plan.trees.map((tree) => tree.plan.dir);
      for (const [name, dir] of Object.entries(places)) expect(trees, name).toContain(dir);
      // The ledger is planned as lines, not as a tree.
      expect(plan.ledger.dir).toBe(ledgerDir({ ...env }, SUBJECT));
      // And the vector collection by name.
      expect(plan.vector.collection).toBe(collectionFor(SUBJECT));
      // Nothing else resolves under the roots that this list does not name.
      expect(trees.length).toBe(Object.keys(places).length);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

/**
 * S13.1 — the map is one list with two readers: erase removes what it names,
 * `deploy plan` moves what it names. These hold the two to the same entries,
 * so a place added for one is a place the other knows.
 */
describe("the data map is one list, and erase and deploy read the same one", () => {
  test("erase's trees are the map's trees, in its order, with or without an agent, whole or --personal", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-data-map-"));
    try {
      const env = { home, env: { XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), MIND_QDRANT_URL: "http://127.0.0.1:9" }, now: () => new Date() };
      // It has to exist: erase asks git about it, and a spawn into a missing cwd fails.
      const agent = join(home, "agent");
      await mkdir(agent, { recursive: true });
      for (const [agentDir, scope] of [[null, "all"], [agent, "all"], [agent, "personal"]] as const) {
        const plan = await planErase(env, {
          subject: SUBJECT,
          agentDir,
          scope,
          by: "the data map test",
          needles: [],
          instructionFiles: [],
          soulName: null,
          personalValues: [],
        });
        const map = subjectTrees(env, SUBJECT, agentDir, scope === "all");
        expect(plan.trees.map((tree) => [tree.place, tree.label, tree.plan.dir])).toEqual(
          map.map((tree) => [tree.place, tree.label, tree.dir]),
        );
      }

      const plan = await planErase(env, {
        subject: SUBJECT, agentDir: agent, scope: "all", by: "t", needles: [], instructionFiles: [], soulName: null, personalValues: [],
      });
      const map = dataMap(env, SUBJECT, agent);
      expect(map.trees.map((tree) => tree.dir)).toEqual(plan.trees.map((tree) => tree.plan.dir));
      expect(map.ledger.dir).toBe(plan.ledger.dir);
      expect(map.collection.name).toBe(plan.vector.collection);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("every entry says how it travels, and why when it does not simply go", () => {
    const map = dataMap({ home: "/h", env: {} }, SUBJECT, "/a");
    const all = [...map.trees, map.ledger];
    expect(new Set(all.map((tree) => tree.key)).size).toBe(all.length);
    for (const entry of [...all, map.collection, map.blocks]) {
      const travel = entry.travel;
      if (travel.kind === "rebuilt") expect(travel.how.length).toBeGreaterThan(40);
      if (travel.kind === "stays") expect(travel.why.length).toBeGreaterThan(40);
    }
    expect(Object.fromEntries(all.map((tree) => [tree.key, tree.travel.kind]))).toEqual({
      soul: "in-git",
      derived: "rebuilt",
      backups: "stays",
      confirmations: "stays",
      "rag-marker": "rebuilt",
      runs: "stays",
      browser: "stays",
      triggers: "stays",
      a2a: "copied",
      chat: "copied",
      bots: "copied",
      push: "copied",
      basis: "copied",
      personal: "copied",
      identity: "copied",
      ledger: "copied",
    });
    // Pure: the same roots, the same paths — no filesystem asked. `/h` exists nowhere.
    expect(map.trees.find((tree) => tree.key === "personal")!.dir).toBe(join("/h", ".local", "share", "mind", SUBJECT, "personal"));
    // Beside personal/, not inside it (D-138), and counted under the soul place: it is the agent's identity.
    const identity = map.trees.find((tree) => tree.key === "identity")!;
    expect(identity.dir).toBe(join("/h", ".local", "share", "mind", SUBJECT, "identity"));
    expect(identity.place).toBe("soul");
  });
});

/**
 * S7.1 for the local backends: their homes hold the vendor CLI's transcripts of whoever ran a turn there, and are
 * not keyed by subject — so they are the map's `shared` entries, and erase's dry run lists the ones a subject used.
 * `test/erase/local-cli.test.ts` runs a real `LocalCliExec` turn into them; this one holds the list itself.
 */
describe("S7.1 — the local backends' homes are in the map, and in the dry run of a subject that used them", () => {
  test("one entry per backend, resolved by the one rule, and listed by the plan once a turn is on the ledger", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-data-map-"));
    try {
      const env = { home, env: { XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), MIND_QDRANT_URL: "http://127.0.0.1:9" }, now: () => new Date() };
      const map = dataMap(env, SUBJECT, null);
      expect(map.shared.map((tree) => tree.backend)).toEqual([...LOCAL_BACKENDS]);
      expect(map.shared.map((tree) => tree.dir)).toEqual(LOCAL_BACKENDS.map((id) => localCliHomeDir(env, id)));

      for (const tree of map.shared) {
        await mkdir(join(tree.dir, ".claude", "projects"), { recursive: true });
        await Bun.write(join(tree.dir, ".claude", "projects", "session.jsonl"), "a transcript\n");
      }
      const ledger = join(home, "state", "mind", "ledger", SUBJECT);
      await mkdir(ledger, { recursive: true });
      await Bun.write(
        join(ledger, "2026-10.jsonl"),
        LOCAL_BACKENDS.map((backend) => JSON.stringify({ subject: SUBJECT, backend })).join("\n") + "\n",
      );

      const plan = await planErase(env, {
        subject: SUBJECT, agentDir: null, scope: "all", by: "t", needles: [], instructionFiles: [], soulName: null, personalValues: [],
      });
      const trees = plan.trees.map((tree) => tree.plan.dir);
      for (const tree of map.shared) expect(trees, tree.key).toContain(tree.dir);
      expect(plan.localCli.map((entry) => entry.handling)).toEqual(["removed-whole", "removed-whole"]);
      // The subject's own trees are still the map's, in its order, and the homes follow them.
      expect(trees).toEqual([...subjectTrees(env, SUBJECT, null, true).map((tree) => tree.dir), ...map.shared.map((tree) => tree.dir)]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
