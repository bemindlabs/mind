/** S21.5 through the binary: `mind soul tune` against a stub model, in a real repository. No real model turn. */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barePath, BUN } from "../support/bare-path.ts";
import { BODY_CLOSE, BODY_OPEN } from "../../src/soul/tune/prompts.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");

const scratch: string[] = [];
const servers: { stop: (force: boolean) => void }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

const SET = `+++
schema = "mind/evals@2"

[t1]
kind = "ports"
ask = "Question t1?"
expect = ["ok-t1"]
reject = ["bad-t1"]

[t5]
kind = "ports"
ask = "Question t5?"
expect = ["ok-t5"]
reject = ["bad-t5"]

${["h1", "h2", "h3", "h4", "h5", "h6"].map((id) => `[${id}]\nkind = "ports"\nask = "Question ${id}?"\nexpect = ["ok-${id}"]\nreject = ["bad-${id}"]\nsplit = "heldout"\n`).join("\n")}
+++
`;

/** The stub agent: `ok-<id>` exactly when the soul in the request holds RULE-<id>; the proposer adds three rules to INV and keeps the base for DOM. */
async function setup(script: { onProposer?: () => Promise<void>; reflection?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "mind-tune-cli-"));
  scratch.push(home);
  const agent = join(home, "agent");
  await cp(SOUL, join(agent, "soul"), { recursive: true });
  const rolePath = join(agent, "soul", "role.md");
  await writeFile(rolePath, `${await readFile(rolePath, "utf8")}\nKnown: RULE-t5 RULE-h3\n`);
  await writeFile(join(agent, "evals.md"), SET);
  await writeFile(join(agent, ".gitignore"), "/.mind/\n");
  const baseRole = await readFile(rolePath, "utf8");
  const baseBody = baseRole.slice(baseRole.indexOf("\n+++\n") + 5);
  const asked: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/api/tags") return Response.json({ models: [{ name: "stub" }] });
      const raw = await req.text();
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      const q = body.messages.at(-1)?.content ?? "";
      asked.push(q);
      if (q.startsWith("# MISSION: what each edit did")) return Response.json({ message: { content: script.reflection ?? "<verdicts>\nrow: 1\npassage: the added line\ncandidates: INV\nchange: adds three rules\nobserved: t1 passes now\nverdict: confounded\n</verdicts>\nNO_LESSON" } });
      if (q.startsWith("# MISSION")) {
        await script.onProposer?.();
        const inv = q.split("\n")[0]!.endsWith("(INV)");
        return Response.json({ message: { content: inv ? `${BODY_OPEN}\n${baseBody.trim()}\nAdded: RULE-t1 RULE-h1 RULE-h2\n${BODY_CLOSE}\n<notes>\nanswers t1\n</notes>` : "KEEP_BASE\n<notes>\nnothing to add\n</notes>" } });
      }
      const id = /Question (\w+)\?/.exec(q)?.[1] ?? "";
      return Response.json({ message: { content: raw.includes(`RULE-${id}`) ? `ok-${id}` : "nope" } });
    },
  });
  servers.push(server);
  await symlink(Bun.which("git")!, join(await barePath(home), "git"));
  const env = { HOME: home, PATH: await barePath(home), XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), OLLAMA_HOST: `http://127.0.0.1:${server.port}`, MIND_QDRANT_URL: "http://127.0.0.1:9", MIND_NO_UPDATE_CHECK: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Owner", GIT_AUTHOR_EMAIL: "o@o", GIT_COMMITTER_NAME: "Owner", GIT_COMMITTER_EMAIL: "o@o" };
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  const g = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: agent, stdout: "pipe", stderr: "pipe", env });
    const out = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
    return out.trim();
  };
  await g("init", "-q");
  await g("add", "-A");
  await g("commit", "-q", "-m", "the soul");
  const tune = ["soul", "tune", agent, "--subject", "example", "--backend", "ollama", "--model", "stub"];
  return { home, agent, asked, run, g, tune, runs: join(home, "data", "mind", "example", "personal", "evals"), state: join(home, "state", "mind") };
}

describe("mind soul tune", () => {
  test("a full round: base, two proposals, a probe, a verdict; branches, a 0600 record, the cost; adopt shut; nothing else touched", async () => {
    const t = await setup();
    const before = [await t.g("rev-parse", "HEAD"), await t.g("status", "--porcelain"), await readFile(join(t.agent, "soul", "role.md"), "utf8")];
    const out = await t.run(t.tune);
    expect(out.code, out.stderr).toBe(0);
    // 16 base turns, the INV and DOM proposers, 16 probe turns for the one candidate, the reflection.
    expect(t.asked).toHaveLength(35);
    expect(t.asked.filter((q) => q.startsWith("# MISSION: a new body"))).toHaveLength(2);
    expect(t.asked.filter((q) => q.startsWith("# MISSION: what each edit did"))).toHaveLength(1);
    const missions = t.asked.filter((q) => q.startsWith("# MISSION: a new body")).join("\n");
    // The reflection holds held-out as numbers only (a train answer may hold its own phrase, as in the proposer's).
    const reflection = t.asked.find((q) => q.startsWith("# MISSION: what each edit did"))!;
    for (const secret of ["Question h1?", "ok-h1", "bad-t1", "bad-h1", "unhurried", "friend"]) expect(reflection).not.toContain(secret);
    expect(reflection).toContain("Held-out: 6 tasks, pass rate 50%");
    expect(missions).toContain("Question t1?");
    for (const secret of ["ok-t1", "bad-t1", "Question h1?", "ok-h1", "unhurried", "friend"]) expect(missions).not.toContain(secret);
    expect(out.stdout).toMatch(/INV — tune\/tn-\d{8}T\d{6}Z-[0-9a-f]{4}-inv/);
    expect(out.stdout).toMatch(/h1 +soul +heldout +fail→pass/);
    expect(out.stdout).toContain("verdict: adopt INV");
    expect(out.stdout).toContain("+Added: RULE-t1 RULE-h1 RULE-h2");
    expect(out.stdout).toMatch(/DOM — KEEP_BASE/);
    expect(out.stdout).toMatch(/cost: 35 turn\(s\) in the ledger/);
    // Nothing but a branch: HEAD, the tree, the file.
    expect([await t.g("rev-parse", "HEAD"), await t.g("status", "--porcelain"), await readFile(join(t.agent, "soul", "role.md"), "utf8")]).toEqual(before);
    const branches = (await t.g("branch", "--list", "tune/*", "--format=%(refname:short)")).split("\n");
    expect(branches).toHaveLength(1);
    expect(await t.g("diff", "--name-only", "HEAD", branches[0]!)).toBe("soul/role.md");
    // The record, outside git, private, linking the runs and the branch.
    const files = (await readdir(t.runs)).filter((f) => f.startsWith("tn-"));
    expect(files).toHaveLength(1);
    expect((await stat(join(t.runs, files[0]!))).mode & 0o777).toBe(0o600);
    const rec = JSON.parse(await readFile(join(t.runs, files[0]!), "utf8")) as { schema: string; base: { runId: string }; candidates: { branch: string | null; runId: string | null }[]; verdict: { winner: string } };
    expect(rec).toMatchObject({ schema: "mind/tune-run@1", verdict: { winner: "INV" } });
    expect(rec.candidates[0]!.branch).toBe(branches[0]!);
    expect((await readdir(t.runs)).sort()).toEqual(expect.arrayContaining([`${rec.base.runId}.json`, `${rec.candidates[0]!.runId}.json`, files[0]!]));
    // The proposer's turns are in the ledger like any other, and their prompt files are gone.
    expect((await t.run(["ledger", "show", "--subject", "example", "--content"])).stdout).toContain("# MISSION");
    expect(await readdir(join(t.state, "scratch", "tune")).catch(() => [])).toEqual([]);
    // The runs listing is not confused by the tune record.
    const listed = await t.run(["eval", "runs", "--subject", "example"]);
    expect(listed.stderr).not.toContain("not an eval run record");
    // Adopt is shut: no proof record.
    const adopt = await t.run(["soul", "tune", "adopt", rec.verdict.winner === "INV" ? files[0]!.replace(".json", "") : "x", t.agent, "--subject", "example"]);
    expect(adopt.code).toBe(1);
    expect(adopt.stderr).toContain("the tuner has not been proved (S21.7)");
    expect(await t.g("rev-parse", "HEAD")).toBe(before[0]!);
  }, 300_000);

  test("a reflection's lesson is a proposal: listed by `lessons`, never written to the agent; accept and reject refuse without a terminal (S21.6)", async () => {
    const reflection = "<verdicts>\nrow: 1\npassage: the added line\ncandidates: INV\nchange: adds three rules\nobserved: t1 passes now\nverdict: helped\n</verdicts>\n<lesson>\ncue: A question about restarting a service after a deploy\nlesson: Check the unit before restarting it.\nevidence: rows 1: t1 passed once the check was named\n</lesson>";
    const t = await setup({ reflection });
    const before = [await t.g("rev-parse", "HEAD"), await t.g("status", "--porcelain")];
    const out = await t.run([...t.tune, "--repeat", "2"]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain("proposed lesson — cue: A question about restarting a service after a deploy");
    const id = /(tn-\d{8}T\d{6}Z-[0-9a-f]{4})/.exec(out.stdout)![1]!;
    const rec = JSON.parse(await readFile(join(t.runs, `${id}.json`), "utf8")) as { reflection: { status: string; lesson: { cue: string } } };
    expect(rec.reflection).toMatchObject({ status: "done", lesson: { cue: "A question about restarting a service after a deploy" } });
    const listed = await t.run(["soul", "tune", "lessons", "--subject", "example"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(id);
    expect(listed.stdout).toContain("lesson    Check the unit before restarting it.");
    expect(listed.stdout).toContain("row 1  helped");
    // Nothing is written by proposing or listing; and without a terminal neither accept nor reject does anything.
    for (const args of [["accept", id, t.agent], ["reject", id]]) {
      const refused = await t.run(["soul", "tune", "lessons", ...args, "--subject", "example"]);
      expect(refused.code, args.join(" ")).toBe(1);
      expect(refused.stderr).toContain("needs a terminal");
    }
    expect(await Bun.file(join(t.agent, "lessons.md")).exists()).toBe(false);
    expect(await Bun.file(join(t.runs, "lessons-decisions.json")).exists()).toBe(false);
    expect([await t.g("rev-parse", "HEAD"), await t.g("status", "--porcelain")]).toEqual(before);
    for (const args of [["lessons"], ["lessons", "accept", id, "--subject", "example"], ["lessons", "reject", "--subject", "example"], ["lessons", "a", "b", "--subject", "example"]]) {
      expect((await t.run(["soul", "tune", ...args])).code, args.join(" ")).toBe(2);
    }
  }, 300_000);

  test("--dry-run: both missions and the leak check, no model call, nothing written", async () => {
    const t = await setup();
    const out = await t.run([...t.tune, "--dry-run"]);
    expect(out.code, out.stderr).toBe(0);
    expect(t.asked).toEqual([]);
    expect(out.stdout).toContain("=== INV mission");
    expect(out.stdout).toContain("=== DOM mission");
    expect(out.stdout).toContain("leak guard: passed");
    expect(out.stdout).toContain("illustrative");
    expect(await t.g("branch", "--list", "tune/*")).toBe("");
    expect(await readdir(t.runs).catch(() => [])).toEqual([]);
  }, 60_000);

  test("refusals: usage, no task set, a dirty soul, no held-out task, the brake", async () => {
    const t = await setup();
    for (const args of [["soul", "tune"], ["soul", "tune", t.agent], ["soul", "tune", t.agent, "--subject", "Bad Id"], [...t.tune, "--repeat", "0"], ["soul", "tune", "adopt", "--subject", "example"], ["soul", "tune", "undo", "--subject", "example"]]) {
      expect((await t.run(args)).code, args.join(" ")).toBe(2);
    }
    expect((await t.run(["soul", "tune", join(t.home, "nowhere"), "--subject", "example"])).code).toBe(1);
    await writeFile(join(t.agent, "soul", "role.md"), `${await readFile(join(t.agent, "soul", "role.md"), "utf8")}\nedit\n`);
    const dirty = await t.run(t.tune);
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toContain("edits that are not committed");
    await t.g("checkout", "-q", "--", ".");
    await writeFile(join(t.agent, "evals.md"), SET.replaceAll('split = "heldout"', ""));
    const none = await t.run(t.tune);
    expect(none.stderr).toContain("no held-out task");
    await writeFile(join(t.agent, "evals.md"), SET);
    await Bun.write(join(t.state, "STOP"), "");
    const stopped = await t.run(t.tune);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain("the brake is on");
    expect(t.asked).toEqual([]);
    const undo = await t.run(["soul", "tune", "undo", t.agent, "--subject", "example"]);
    expect(undo.code).toBe(1);
    expect(undo.stderr).toContain("the brake is on");
  }, 120_000);

  test("the brake set while the proposer works: the round ends, and no branch, record or commit is left", async () => {
    let state = "";
    const t = await setup({ onProposer: async () => { await Bun.write(join(state, "STOP"), ""); } });
    state = t.state;
    const head = await t.g("rev-parse", "HEAD");
    const out = await t.run(t.tune);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("the brake is on");
    expect(out.stderr).toContain("No branch, commit or tune record was left");
    expect(await t.g("branch", "--list", "tune/*")).toBe("");
    expect(await t.g("rev-parse", "HEAD")).toBe(head);
    expect((await readdir(t.runs).catch(() => [])).filter((f) => f.startsWith("tn-"))).toEqual([]);
  }, 120_000);

  test("--selftest and proof: no proof, a selftest that writes none without a subject, the proof, adopt opening on a real round, and a hand-edited proof shut again (S21.7)", async () => {
    const t = await setup();
    const proofFile = join(t.runs, "tuner-proof.json");
    const none = await t.run(["soul", "tune", "proof", "--subject", "example"]);
    expect(none.code).toBe(1);
    expect(none.stdout).toContain("NONE VALID");
    expect(none.stdout).toContain("there is no proof record");
    // Without a subject the controls run and report; nothing is written; the throwaway is gone.
    const bare = await t.run(["soul", "tune", "--selftest"]);
    expect(bare.code, bare.stderr).toBe(0);
    expect(bare.stdout).toContain("ALL as required: 4/4 controls passed, 4/4 twins caught.");
    expect(bare.stdout).toContain("No --subject: nothing written");
    expect(await Bun.file(proofFile).exists()).toBe(false);
    expect(await readdir(join(t.state, "scratch", "tune")).catch(() => [])).toEqual([]);
    expect(t.asked).toEqual([]);
    // With one: the proof, private, and valid for this build.
    const made = await t.run(["soul", "tune", "--selftest", "--subject", "example"]);
    expect(made.code, made.stderr).toBe(0);
    expect(made.stdout).toContain("Proof written to");
    expect((await stat(proofFile)).mode & 0o777).toBe(0o600);
    const shown = await t.run(["soul", "tune", "proof", "--subject", "example"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("VALID");
    expect(shown.stdout).toContain("adopt is open");
    // Adopt now works on a real round: a commit by the agent, and the owner told.
    const head = await t.g("rev-parse", "HEAD");
    const round = await t.run(t.tune);
    expect(round.code, round.stderr).toBe(0);
    const record = (await readdir(t.runs)).find((f) => f.startsWith("tn-"))!;
    const adopted = await t.run(["soul", "tune", "adopt", record.replace(".json", ""), t.agent, "--subject", "example"]);
    expect(adopted.code, adopted.stderr).toBe(0);
    expect(adopted.stdout).toContain("Mind adopted a tuned role.md");
    expect(await t.g("log", "-1", "--format=%an <%ae>")).toBe("Example Keeper (Mind agent) <example@agents.mind.invalid>");
    expect(await t.g("rev-parse", "HEAD^")).toBe(head);
    // Edited by hand, it no longer validates.
    const edited = JSON.parse(await readFile(proofFile, "utf8")) as { provedAt: string };
    await writeFile(proofFile, JSON.stringify({ ...edited, provedAt: "2030-01-01T00:00:00.000Z" }));
    const forged = await t.run(["soul", "tune", "proof", "--subject", "example"]);
    expect(forged.code).toBe(1);
    expect(forged.stdout).toContain("does not match its own digest");
    // Usage.
    expect((await t.run(["soul", "tune", "--selftest", "extra"])).stderr).toContain("usage: mind soul tune --selftest");
    expect((await t.run(["soul", "tune", "proof"])).stderr).toContain("usage: mind soul tune proof --subject <id>");
  }, 300_000);
});
