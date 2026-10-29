/** S21.5 — adoption and undo: built, and shut until a proof record names this engine. The proof here is a test fixture; the real one is S21.7's. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adoptRun, undoLast, type AdoptEnv } from "../../../src/soul/tune/adopt.ts";
import { CONTROLS, PROOF_FILE, PROOF_SCHEMA, sealProof, type Control, type EngineIdentity } from "../../../src/soul/tune/proof.ts";
import { readTuneRun, runTune } from "../../../src/soul/tune/round.ts";
import { VERSION } from "../../../src/version.ts";
import { GIT_ENV, contextOf, fakeDeps, g, makeFixture, proposal, repoState, tasksOf, withRules, type Fixture } from "../../support/tune-fixture.ts";

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});

const ENGINE: EngineIdentity = { version: VERSION, gitSha: "a".repeat(40), sourceSha256: "c".repeat(64) };
const all = (v: boolean) => Object.fromEntries(CONTROLS.map((c) => [c, v])) as Record<Control, boolean>;

/** A fixture with a finished round whose INV wins, and an AdoptEnv over it. */
async function adoptable(brake = { on: false }) {
  const f = await makeFixture();
  fixtures.push(f);
  const out = await runTune(contextOf(f), fakeDeps(f, tasksOf(), { proposer: (d) => (d === "INV" ? proposal(withRules(f, "t1", "h1", "h2")) : proposal(withRules(f, "h1"))) }).deps, false);
  if (out.kind !== "done") throw new Error(JSON.stringify(out));
  const env: AdoptEnv = { subject: f.subject, soulDir: f.soulDir, runsDir: f.runs, stateRoot: f.state, env: GIT_ENV, engine: ENGINE, stopped: async () => brake.on, now: () => new Date("2026-10-20T08:00:00Z") };
  const prove = (over: Record<string, unknown> = {}) => writeFile(join(f.runs, PROOF_FILE), JSON.stringify(sealProof({ schema: PROOF_SCHEMA, engine: ENGINE, controls: all(true), twins: all(true), evidence: Object.fromEntries(CONTROLS.map((c) => [c, "fixture"])) as Record<Control, string>, provedAt: "2026-10-20T00:00:00Z", ...over })));
  return { f, env, record: out.record, prove, runId: out.record.runId };
}

describe("the gate (no valid proof)", () => {
  test("adopt refuses without a proof record, and nothing changes", async () => {
    const a = await adoptable();
    const before = await repoState(a.f);
    const out = await adoptRun(a.env, a.runId);
    expect(out).toEqual({ ok: false, reason: `the tuner has not been proved (S21.7): there is no proof record at ${join(a.f.runs, PROOF_FILE)}` });
    expect(await repoState(a.f)).toBe(before);
    expect((await readTuneRun(a.f.runs, a.runId) as { record: { adopted: unknown } }).record.adopted).toBeNull();
  });

  test("a proof edited by hand (a failed control flipped to true) keeps adopt shut", async () => {
    const a = await adoptable();
    await a.prove({ controls: { ...all(true), good: false } });
    const sealed = JSON.parse(await readFile(join(a.f.runs, PROOF_FILE), "utf8"));
    await writeFile(join(a.f.runs, PROOF_FILE), JSON.stringify({ ...sealed, controls: all(true) }));
    const before = await repoState(a.f);
    expect((await adoptRun(a.env, a.runId) as { reason: string }).reason).toContain("does not match its own digest");
    expect(await repoState(a.f)).toBe(before);
  });
});

describe("adopt, with a proof fixture", () => {
  test("a commit authored by the agent, carrying the run id, the shas and the held-out numbers; the working tree follows; the record says so", async () => {
    const a = await adoptable();
    await a.prove();
    const out = await adoptRun(a.env, a.runId);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const commit = (out as { commit: string }).commit;
    expect(await g(a.f.agent, "rev-parse", "HEAD")).toBe(commit);
    expect(await g(a.f.agent, "rev-parse", "HEAD^")).toBe(a.f.head);
    // The agent is the author and the committer: never the owner whose git config is in force.
    expect(await g(a.f.agent, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe("Example Keeper (Mind agent) <example@agents.mind.invalid>|Example Keeper (Mind agent) <example@agents.mind.invalid>");
    const message = await g(a.f.agent, "log", "-1", "--format=%B");
    const inv = a.record.candidates[0]!;
    expect(message).toContain(`tune: adopt INV candidate of ${a.runId}`);
    expect(message).toContain(`Mind-Tune-Run: ${a.runId}`);
    expect(message).toContain(`Mind-Tune-Base: ${a.f.head}`);
    expect(message).toContain(`Mind-Tune-Candidate: ${inv.commit}`);
    expect(message).toContain(`Held-out pass rate ${inv.heldout!.base}% -> ${inv.heldout!.candidate}% over 6 task(s)`);
    // Only role.md changed; the working tree and the index are on the new commit, clean.
    expect(await g(a.f.agent, "diff", "--name-only", "HEAD^", "HEAD")).toBe("soul/role.md");
    expect(await g(a.f.agent, "status", "--porcelain")).toBe("");
    expect(await readFile(join(a.f.soulDir, "role.md"), "utf8")).toContain("RULE-t1 RULE-h1 RULE-h2");
    expect(await g(a.f.agent, "rev-parse", "HEAD^{tree}")).toBe(await g(a.f.agent, "rev-parse", `${inv.commit}^{tree}`));
    const notice = (out.ok ? out.notice : []).join("\n");
    expect(notice).toContain(`the INV candidate of ${a.runId}, commit ${commit.slice(0, 8)}`);
    expect(notice).toContain("not by you");
    expect(notice).toContain("mind soul tune undo");
    const rec = (await readTuneRun(a.f.runs, a.runId) as { record: { adopted: { commit: string; branch: string } } }).record;
    expect(rec.adopted).toMatchObject({ commit, branch: inv.branch });
    // Adopted once.
    expect((await adoptRun(a.env, a.runId) as { reason: string }).reason).toContain("was adopted already");
  });

  test("refusals: the brake, a moved HEAD, a soul with edits, a candidate branch that changed, a run with no winner, no such run", async () => {
    const brake = { on: true };
    const a = await adoptable(brake);
    await a.prove();
    expect((await adoptRun(a.env, a.runId) as { reason: string }).reason).toContain("the brake is on");
    brake.on = false;
    await writeFile(join(a.f.soulDir, "role.md"), `${a.f.baseRole}\nhand edit\n`);
    expect((await adoptRun(a.env, a.runId) as { reason: string }).reason).toContain("edits that are not committed");
    await g(a.f.agent, "commit", "-qam", "the owner moves on");
    expect((await adoptRun(a.env, a.runId) as { reason: string }).reason).toContain("the agent has moved on since the round");
    expect((await adoptRun(a.env, "tn-20260101T000000Z-aaaa") as { reason: string }).reason).toContain("no readable tune run");

    const b = await adoptable();
    await b.prove();
    const branch = b.record.candidates[0]!.branch!;
    await g(b.f.agent, "update-ref", `refs/heads/${branch}`, b.f.head);
    expect((await adoptRun(b.env, b.runId) as { reason: string }).reason).toContain("is gone or no longer names");
    await g(b.f.agent, "update-ref", "-d", `refs/heads/${branch}`);
    expect((await adoptRun(b.env, b.runId) as { reason: string }).reason).toContain("is gone or no longer names");

    const c = await makeFixture();
    fixtures.push(c);
    const none = await runTune(contextOf(c), fakeDeps(c, tasksOf()).deps, false);
    if (none.kind !== "done") throw new Error("round");
    await writeFile(join(c.runs, PROOF_FILE), await readFile(join(b.f.runs, PROOF_FILE)));
    expect((await adoptRun({ ...b.env, subject: c.subject, soulDir: c.soulDir, runsDir: c.runs, stateRoot: c.state }, none.record.runId) as { reason: string }).reason).toContain("has no winner");
  });
});

describe("undo", () => {
  test("a revert of the last tune commit, authored by the agent; the working tree follows; a second undo finds nothing", async () => {
    const a = await adoptable();
    await a.prove();
    const adopted = (await adoptRun(a.env, a.runId) as { commit: string }).commit;
    const out = await undoLast(a.env);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    const commit = (out as { commit: string }).commit;
    expect(await g(a.f.agent, "rev-parse", "HEAD^")).toBe(adopted);
    expect(await g(a.f.agent, "rev-parse", "HEAD^{tree}")).toBe(await g(a.f.agent, "rev-parse", `${a.f.head}^{tree}`));
    expect(await g(a.f.agent, "log", "-1", "--format=%an")).toBe("Example Keeper (Mind agent)");
    expect(await g(a.f.agent, "log", "-1", "--format=%B")).toContain(`Mind-Tune-Undo: ${adopted}`);
    expect(await readFile(join(a.f.soulDir, "role.md"), "utf8")).toBe(a.f.baseRole);
    expect(await g(a.f.agent, "status", "--porcelain")).toBe("");
    expect(commit).not.toBe(adopted);
    expect((await undoLast(a.env) as { reason: string }).reason).toContain("no tune commit to undo");
  });

  test("refuses with the brake on, with edits, when role.md has moved on since, and when there is nothing to undo", async () => {
    const brake = { on: false };
    const a = await adoptable(brake);
    expect((await undoLast(a.env) as { reason: string }).reason).toContain("no tune commit to undo");
    await a.prove();
    await adoptRun(a.env, a.runId);
    brake.on = true;
    expect((await undoLast(a.env) as { reason: string }).reason).toContain("the brake is on");
    brake.on = false;
    await writeFile(join(a.f.soulDir, "role.md"), "dirty");
    expect((await undoLast(a.env) as { reason: string }).reason).toContain("edits that are not committed");
    await g(a.f.agent, "checkout", "-q", "--", ".");
    await writeFile(join(a.f.soulDir, "role.md"), `${await readFile(join(a.f.soulDir, "role.md"), "utf8")}\nlater edit\n`);
    await g(a.f.agent, "commit", "-qam", "a later edit of role.md");
    expect((await undoLast(a.env) as { reason: string }).reason).toContain("has changed since the tune commit");
  });
});
