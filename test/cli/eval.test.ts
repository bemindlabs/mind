/** S6.5 through the binary (D-073): each task twice, graded from the answer, reported by kind; S21.2 the split; S21.3 compare. */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barePath, BUN } from "../support/bare-path.ts";
import { appendEntry } from "../../src/soul/lessons.ts";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "mind.ts");
const SOUL = join(ROOT, "test", "fixtures", "soul-valid");

const scratch: string[] = [];
const servers: { stop: (force: boolean) => void }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

/** An evals file under the given schema id. */
const evalSet = (schema: string) => `+++
schema = "${schema}"

[port]
kind = "ports"
ask = "Which port does the queue use?"
expect = ["10410"]

[incident]
kind = "incidents"
ask = "What broke on Tuesday?"
expect = ["disk full"]
reject = ["no idea"]
+++
`;

const SET = evalSet("mind/evals@1");

/** `marker`: the incident is answered right, and the port wrong, only by a soul whose text holds DISK-RULE. `hold`: requests wait while it is true. */
async function setup(flaky = false, script: { marker?: boolean; hold?: { on: boolean } } = {}) {
  const home = await mkdtemp(join(tmpdir(), "mind-eval-"));
  scratch.push(home);
  const agent = join(home, "agent");
  await cp(SOUL, join(agent, "soul"), { recursive: true });
  await writeFile(join(agent, "evals.md"), SET);
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
      while (script.hold?.on === true) await Bun.sleep(20);
      if (script.marker === true) {
        const marked = raw.includes("DISK-RULE");
        return Response.json({ message: { content: q.includes("queue") ? (marked ? "I forget." : "It is 10410.") : marked ? "The disk full alarm." : "no idea, sorry" } });
      }
      // The incident is answered right every other time it is asked: a flaky task for --repeat.
      const incidents = asked.filter((a) => a.includes("Tuesday")).length;
      return Response.json({ message: { content: q.includes("queue") ? "It listens on **10410**." : flaky && incidents % 2 === 1 ? "The disk full alarm." : "no idea, sorry" } });
    },
  });
  servers.push(server);
  // A dead Qdrant: `memory index` below must never write into the machine's real one.
  const env = { HOME: home, PATH: await barePath(home), XDG_STATE_HOME: join(home, "state"), XDG_DATA_HOME: join(home, "data"), OLLAMA_HOST: `http://127.0.0.1:${server.port}`, MIND_QDRANT_URL: "http://127.0.0.1:9", MIND_NO_UPDATE_CHECK: "1" };
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn([BUN, "run", BIN, ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    await child.exited;
    return { code: child.exitCode ?? -1, stdout, stderr };
  };
  return { home, agent, asked, run, runs: join(home, "data", "mind", "example", "personal", "evals"), scratch: join(home, "state", "mind", "scratch", "eval-compare"), env };
}

describe("mind eval", () => {
  test("every task in both configurations, graded from the answer, with the kinds it cannot do yet", async () => {
    const t = await setup();
    const out = await t.run(["eval", t.agent, "--subject", "example", "--backend", "ollama", "--model", "stub"]);
    expect(out.code, out.stderr).toBe(0);
    expect(t.asked).toHaveLength(4);
    expect(out.stdout).toContain("2 task(s) — S6.5 AC1 asks for at least 20");
    expect(out.stdout).toMatch(/soul\s+1\/2\s+50%/);
    expect(out.stdout).toContain("soul+rag+fine-tune");
    expect(out.stdout).toContain("Not yet replaceable (under half, in the best configuration): incidents");
    expect(out.stdout).toContain('missing "disk full"');
    const json = await t.run(["eval", t.agent, "--subject", "example", "--backend", "ollama", "--model", "stub", "--only", "port", "--json"]);
    const parsed = JSON.parse(json.stdout) as { report: { total: number; notYet: string[] }; results: { mode: string; pass: boolean }[] };
    expect(parsed.report.total).toBe(1);
    expect(parsed.results.map((r) => [r.mode, r.pass])).toEqual([["soul", true], ["soul+rag", true]]);
    // Recorded by default, outside the agent's directory, without the answers.
    const files = (await readdir(t.runs)).sort();
    expect(files).toHaveLength(2);
    const rec = JSON.parse(await Bun.file(join(t.runs, files[0]!)).text()) as { schema: string; repeat: number; soul: { gitTree: null; dirty: null; contentSha256: string }; results: Record<string, unknown>[]; backend: string };
    expect(rec).toMatchObject({ schema: "mind/eval-run@2", repeat: 1, backend: "ollama", soul: { gitTree: null, dirty: null } });
    expect(rec.results[0]).not.toHaveProperty("answer");
    expect(out.stdout).toContain(`Recorded as ${t.runs}/`);
    // The turns are in the ledger like any other.
    expect((await t.run(["ledger", "show", "--subject", "example", "--content"])).stdout).toContain("Which port does the queue use?");
  }, 120_000);

  test("no set, a broken set, and wrong usage", async () => {
    const t = await setup();
    await rm(join(t.agent, "evals.md"));
    expect((await t.run(["eval", t.agent, "--subject", "example"])).code).toBe(1);
    await writeFile(join(t.agent, "evals.md"), '+++\nschema = "nope"\n+++\n');
    expect((await t.run(["eval", t.agent, "--subject", "example"])).stderr).toContain("schema must be");
    await writeFile(join(t.agent, "evals.md"), SET);
    for (const args of [["eval"], ["eval", t.agent], ["eval", t.agent, "--subject", "example", "--only", "missing"]]) {
      expect((await t.run(args)).code, args.join(" ")).toBe(2);
    }
  }, 60_000);

  test("--recall-only asks no model: is the answer in what recall would attach?", async () => {
    const t = await setup();
    await Bun.write(join(t.agent, "memory", "queue.md"), "# Queue\n\nThe queue listens on port 10410 since the move.\n");
    const idx = await t.run(["memory", "index", t.agent, "--subject", "example"]);
    expect(idx.code, idx.stderr).toBe(0);
    const out = await t.run(["eval", t.agent, "--subject", "example", "--recall-only"]);
    expect(out.code, out.stderr).toBe(0);
    expect(t.asked).toEqual([]);
    expect(out.stdout).toMatch(/hit\s+port/);
    expect(out.stdout).toMatch(/MISS incident\s+.*missing "disk full"/);
    expect(out.stdout).toContain("recall attached the answer for 1/2 (50%) — no model asked");
    const json = JSON.parse((await t.run(["eval", t.agent, "--subject", "example", "--recall-only", "--json"])).stdout) as { hits: number };
    expect(json.hits).toBe(1);
    expect((await t.run(["eval", t.agent, "--subject", "example", "--recall-chars", "-1"])).code).toBe(2);
  }, 60_000);

  test("--recall-only names a lesson pulled from lessons.md as a lesson, with its cue (S21.6, T7)", async () => {
    const t = await setup();
    await Bun.write(join(t.agent, "memory", "queue.md"), "# Queue\n\nThe queue listens on port 10410 since the move.\n");
    const lesson = appendEntry(null, { cue: "A question about what broke on a given day", lesson: "Look at the disk first: a disk full alarm is the usual cause.", evidence: "rows 1: the incident task passed once the disk was named", run: "tn-20261020T101500Z-ab12", date: "2026-10-20", soul: "a".repeat(40) });
    await Bun.write(join(t.agent, "lessons.md"), lesson);
    const idx = await t.run(["memory", "index", t.agent, "--subject", "example"]);
    expect(idx.code, idx.stderr).toBe(0);
    const out = await t.run(["eval", t.agent, "--subject", "example", "--recall-only"]);
    expect(out.code, out.stderr).toBe(0);
    expect(t.asked).toEqual([]);
    // The lesson carries "disk full": the incident task is now answered by recall, and the output says by which lesson.
    expect(out.stdout).toMatch(/hit\s+incident/);
    expect(out.stdout).toContain('lesson pulled: "A question about what broke on a given day" (tn-20261020T101500Z-ab12)');
    expect(out.stdout).toContain("1 task(s) had a lesson from lessons.md attached (T7)");
    const json = JSON.parse((await t.run(["eval", t.agent, "--subject", "example", "--recall-only", "--json"])).stdout) as { rows: { task: string; lessons: { cue: string; run: string }[] }[] };
    expect(json.rows.find((r) => r.task === "incident")!.lessons).toEqual([{ cue: "A question about what broke on a given day", run: "tn-20261020T101500Z-ab12" }]);
    expect(json.rows.find((r) => r.task === "port")!.lessons).toEqual([]);
  }, 60_000);

  test("--repeat, the record, --keep-answers, --no-record and eval runs", async () => {
    const t = await setup(true);
    const base = ["eval", t.agent, "--subject", "example", "--backend", "ollama", "--model", "stub"];
    const out = await t.run([...base, "--repeat", "2", "--keep-answers"]);
    expect(out.code, out.stderr).toBe(0);
    expect(t.asked).toHaveLength(8);
    expect(out.stdout).toContain("2 task(s), each 2 times");
    expect(out.stdout).toMatch(/soul\s+1\.5\/2\s+75%/);
    expect(out.stdout).toMatch(/incident\s+soul\s+1\/2\s+flaky/);
    expect(out.stdout).toMatch(/port\s+soul\+rag\s+2\/2\s+stable pass/);
    expect(out.stdout).toContain("answers kept");
    const [file] = await readdir(t.runs);
    expect((await stat(t.runs)).mode & 0o777).toBe(0o700);
    expect((await stat(join(t.runs, file!))).mode & 0o777).toBe(0o600);
    const rec = JSON.parse(await Bun.file(join(t.runs, file!)).text()) as { repeat: number; keptAnswers: boolean; results: { answer?: string; attempt: number }[]; report: { flaky: number } };
    expect(rec.repeat).toBe(2);
    expect(rec.keptAnswers).toBe(true);
    expect(rec.results.map((r) => r.attempt)).toEqual([1, 2, 1, 2, 1, 2, 1, 2]);
    expect(rec.results[0]!.answer).toContain("10410");
    expect(rec.report.flaky).toBe(2);

    const none = await t.run([...base, "--only", "port", "--no-record", "--json"]);
    expect(none.code, none.stderr).toBe(0);
    expect((JSON.parse(none.stdout) as { record: null }).record).toBeNull();
    expect(await readdir(t.runs)).toHaveLength(1);

    const listed = await t.run(["eval", "runs", "--subject", "example"]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/^ev-\d{8}T\d{6}Z-[0-9a-f]{4}  \d{4}-\d\d-\d\d \d\d:\d\d  sha [0-9a-f]{8}\s+ollama\/stub\s+soul 75%  soul\+rag 75%  ×2  2 task\(s\) · 2 flaky$/m);
    const listedJson = JSON.parse((await t.run(["eval", "runs", t.agent, "--subject", "example", "--json"])).stdout) as { runs: Record<string, unknown>[] };
    expect(listedJson.runs).toHaveLength(1);
    expect(listedJson.runs[0]).not.toHaveProperty("results");
    expect((await t.run(["eval", "runs", "--subject", "other"])).stdout).toContain("No eval runs recorded for other");
    for (const args of [[...base, "--repeat", "0"], [...base, "--repeat", "11"], ["eval", "runs"], ["eval", "runs", "a", "b", "--subject", "example"]]) {
      expect((await t.run(args)).code, args.join(" ")).toBe(2);
    }
  }, 120_000);

  test("--split runs one side; the report gives both and flags a small held-out set", async () => {
    const t = await setup();
    await writeFile(join(t.agent, "evals.md"), evalSet("mind/evals@2").replace('reject = ["no idea"]', 'reject = ["no idea"]\nsplit = "heldout"'));
    const base = ["eval", t.agent, "--subject", "example", "--backend", "ollama", "--model", "stub"];
    const out = await t.run([...base, "--split", "heldout"]);
    expect(out.code, out.stderr).toBe(0);
    expect(t.asked).toHaveLength(2);
    expect(t.asked.every((q) => q.includes("Tuesday"))).toBe(true);
    expect(out.stdout).toMatch(/train\s+0 task\(s\)\s+—/);
    expect(out.stdout).toMatch(/heldout\s+1 task\(s\)\s+soul 0%/);
    expect(out.stdout).toContain("Held-out is 1 task(s): too small to judge a tuning decision (at least 6).");
    const [file] = await readdir(t.runs);
    const rec = JSON.parse(await Bun.file(join(t.runs, file!)).text()) as { schema: string; split: string; results: { split: string }[] };
    expect(rec.schema).toBe("mind/eval-run@2");
    expect(rec.split).toBe("heldout");
    expect(rec.results.map((r) => r.split)).toEqual(["heldout", "heldout"]);
    const train = await t.run([...base, "--split", "train", "--no-record"]);
    expect(train.stdout).toContain("No held-out tasks in this run");
    for (const args of [[...base, "--split", "test"], [...base, "--split", "heldout", "--only", "port"]]) {
      expect((await t.run(args)).code, args.join(" ")).toBe(2);
    }
  }, 120_000);

  test("eval split proposes a stratified held-out set and writes it only on --write", async () => {
    const t = await setup();
    const shown = await t.run(["eval", "split", t.agent, "--subject", "example", "--heldout", "1", "--seed", "a"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('1 of 2 task(s) held out, stratified by kind, seed "a":');
    expect(shown.stdout).toContain("Not written.");
    expect(await Bun.file(join(t.agent, "evals.md")).text()).toBe(SET);
    expect((await t.run(["eval", "split", t.agent, "--subject", "example", "--heldout", "1", "--seed", "a"])).stdout).toBe(shown.stdout);
    const wrote = await t.run(["eval", "split", t.agent, "--subject", "example", "--heldout", "1", "--seed", "a", "--write"]);
    expect(wrote.code, wrote.stderr).toBe(0);
    expect(wrote.stdout).toContain("Mind does not commit it");
    const text = await Bun.file(join(t.agent, "evals.md")).text();
    expect(text).toContain('schema = "mind/evals@2"');
    expect(text.match(/split = "heldout"/g)).toHaveLength(1);
    for (const args of [["eval", "split", t.agent, "--subject", "example", "--heldout", "2"], ["eval", "split", t.agent, "--subject", "example"], ["eval", "split", "--subject", "example"], ["eval", "split", t.agent, "--subject", "Bad Id", "--heldout", "1"]]) {
      expect((await t.run(args)).code, args.join(" ")).toBe(2);
    }
    expect((await t.run(["eval", "split", join(t.home, "nowhere"), "--subject", "example", "--heldout", "1"])).code).toBe(1);
    await writeFile(join(t.agent, "evals.md"), '+++\nschema = "nope"\n+++\n');
    expect((await t.run(["eval", "split", t.agent, "--subject", "example", "--heldout", "1"])).code).toBe(1);
    await writeFile(join(t.agent, "evals.md"), '+++\nschema = "mind/evals@2"\na = { ask = "a?", expect = ["x"] }\nb = { ask = "b?", expect = ["x"] }\n+++\n');
    const refused = await t.run(["eval", "split", t.agent, "--subject", "example", "--heldout", "1", "--write"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("by hand");
  }, 60_000);

  /** An agent repository: HEAD~1's soul holds DISK-RULE, HEAD's (the working tree) does not; the incident is held out. */
  async function compareRepo(script: { hold?: { on: boolean } } = {}) {
    const t = await setup(false, { marker: true, ...script });
    await symlink(Bun.which("git")!, join(await barePath(t.home), "git"));
    await writeFile(join(t.agent, "evals.md"), evalSet("mind/evals@2").replace('reject = ["no idea"]', 'reject = ["no idea"]\nsplit = "heldout"'));
    const role = join(t.agent, "soul", "role.md");
    const plain = await Bun.file(role).text();
    const g = async (...args: string[]) => {
      const child = Bun.spawn(["git", ...args], { cwd: t.agent, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      const out = await new Response(child.stdout).text();
      if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
      return out.trim();
    };
    await g("init", "-q");
    await writeFile(role, `${plain}\n## Disks\n\nDISK-RULE: name the disk full alarm.\n`);
    await g("add", "-A");
    await g("commit", "-q", "-m", "soul with the disk rule");
    await writeFile(role, plain);
    await g("commit", "-q", "-am", "soul without it");
    return { ...t, g };
  }

  test("--compare: base (working tree) and candidate (the ref) on the same tasks, both recorded, the T6 verdict printed, nothing changed", async () => {
    const t = await compareRepo();
    const before = await t.g("status", "--porcelain", "--ignored");
    const out = await t.run(["eval", t.agent, "--subject", "example", "--backend", "ollama", "--model", "stub", "--compare", "HEAD~1"]);
    expect(out.code, out.stderr).toBe(0);
    expect(t.asked).toHaveLength(8);
    expect(out.stdout).toMatch(/cmp-\d{8}T\d{6}Z-[0-9a-f]{4} — 2 task\(s\) × 2 modes, base ×1, candidate ×1/);
    expect(out.stdout).toMatch(/candidate {2}tree [0-9a-f]{8} +HEAD~1 = [0-9a-f]{8}/);
    expect(out.stdout).toMatch(/train +1 task\(s\) +100% +0% +-100/);
    expect(out.stdout).toMatch(/heldout +1 task\(s\) +0% +100% +\+100/);
    expect(out.stdout).toMatch(/port +soul +train +pass→fail/);
    expect(out.stdout).toMatch(/incident +soul\+rag +heldout +fail→pass/);
    expect(out.stdout).toContain("T6 verdict: adopt — held-out pass rate rose 0% → 100% and no held-out task flipped pass→fail");
    expect(out.stdout).toContain("Held-out is 1 task(s): too small to judge a tuning decision (at least 6).");
    expect(out.stdout).toContain("Nothing was changed");
    // Both recorded, linked; the candidate's soul is the ref's tree; the repository and the soul are as they were.
    const files = (await readdir(t.runs)).sort();
    expect(files).toHaveLength(2);
    const recs = await Promise.all(files.map(async (f) => JSON.parse(await Bun.file(join(t.runs, f)).text()) as { runId: string; compare: { id: string; role: string; ref: string; commit: string }; soul: { gitTree: string; dirty: boolean } }));
    const byRole = Object.fromEntries(recs.map((r) => [r.compare.role, r]));
    expect(byRole["base"]!.compare.id).toBe(byRole["candidate"]!.compare.id);
    expect(byRole["candidate"]!.compare).toMatchObject({ ref: "HEAD~1", commit: await t.g("rev-parse", "HEAD~1") });
    expect(byRole["candidate"]!.soul).toMatchObject({ gitTree: await t.g("rev-parse", "HEAD~1:soul"), dirty: false });
    expect(byRole["base"]!.soul).toMatchObject({ gitTree: await t.g("rev-parse", "HEAD:soul"), dirty: false });
    expect(await t.g("status", "--porcelain", "--ignored")).toBe(before);
    expect(await Bun.file(join(t.agent, "soul", "role.md")).text()).not.toContain("DISK-RULE");
    expect(await readdir(t.scratch)).toEqual([]);

    // The same two records, compared again without asking anything; reversed, the held-out loss keeps the base.
    const [a, b] = [byRole["base"]!.runId, byRole["candidate"]!.runId];
    const again = await t.run(["eval", "--compare-runs", a, b, "--subject", "example"]);
    expect(again.code, again.stderr).toBe(0);
    expect(t.asked).toHaveLength(8);
    expect(again.stdout).toContain("T6 verdict: adopt");
    const back = await t.run(["eval", "--compare-runs", b, a, "--subject", "example", "--json"]);
    const parsed = JSON.parse(back.stdout) as { selection: { verdict: string; reason: string } };
    expect(parsed.selection).toMatchObject({ verdict: "keep-base", reason: "held-out incident [soul] pass→fail, incident [soul+rag] pass→fail" });
    const listed = await t.run(["eval", "runs", "--subject", "example"]);
    expect(listed.stdout).toContain(`${byRole["base"]!.compare.id} base`);

    // A run over a different task set is refused, saying so.
    await writeFile(join(t.agent, "evals.md"), evalSet("mind/evals@2"));
    const other = await t.run(["eval", t.agent, "--subject", "example", "--backend", "ollama", "--model", "stub", "--json"]);
    const c = (JSON.parse(other.stdout) as { record: string }).record.split("/").at(-1)!.replace(".json", "");
    const refused = await t.run(["eval", "--compare-runs", a, c, "--subject", "example"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`will not compare ${a} with ${c}: the two runs answered different task sets (evalsSha256`);
  }, 180_000);

  test("--compare refusals, and --json", async () => {
    const t = await compareRepo();
    const base = ["eval", t.agent, "--subject", "example", "--backend", "ollama", "--model", "stub"];
    for (const args of [[...base, "--compare", "HEAD~1", "--no-record"], [...base, "--compare", "HEAD~1", "--recall-only"], [...base, "--compare"], ["eval", "--compare-runs", "a"], ["eval", "--compare-runs", "a", "b"], ["eval", "--compare-runs", "a", "b", "--subject", "Bad Id"], ["eval", "--compare-runs", "a", "b", "x", "y", "--subject", "example"]]) {
      expect((await t.run(args)).code, args.join(" ")).toBe(2);
    }
    const noRef = await t.run([...base, "--compare", "nope"]);
    expect(noRef.code).toBe(1);
    expect(noRef.stderr).toContain('no commit "nope"');
    // A ref whose soul does not load: the issues, exit 1, nothing asked, nothing left behind.
    const role = join(t.agent, "soul", "role.md");
    const good = await Bun.file(role).text();
    await writeFile(role, "not a soul");
    await t.g("commit", "-q", "-am", "broken soul");
    await writeFile(role, good);
    const broken = await t.run([...base, "--compare", "HEAD"]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain("the soul at HEAD does not load");
    expect(t.asked).toHaveLength(0);
    expect(await readdir(t.scratch)).toEqual([]);
    const missing = await t.run(["eval", "--compare-runs", "ev-20261019T080000Z-aaaa", "ev-20261019T080000Z-bbbb", "--subject", "example"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no readable run ev-20261019T080000Z-aaaa");
    const json = await t.run([...base, "--compare", "HEAD~2", "--only", "incident", "--json"]);
    expect(json.code, json.stderr).toBe(0);
    const parsed = JSON.parse(json.stdout) as { selection: { verdict: string }; compare: { rows: unknown[] }; base: { record: string }; candidate: { record: string } };
    expect(parsed.selection.verdict).toBe("adopt");
    expect(parsed.compare.rows).toHaveLength(2);
    expect(parsed.candidate.record).toContain(t.runs);
  }, 180_000);

  test("Ctrl-C during --compare: the candidate soul is removed and the command exits 130", async () => {
    const hold = { on: true };
    const t = await compareRepo({ hold });
    const child = Bun.spawn([BUN, "run", BIN, "eval", t.agent, "--subject", "example", "--backend", "ollama", "--model", "stub", "--compare", "HEAD~1"], { cwd: ROOT, env: t.env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    for (let i = 0; i < 400 && t.asked.length === 0; i++) await Bun.sleep(25);
    expect(t.asked.length).toBeGreaterThan(0);
    expect(await readdir(t.scratch)).toHaveLength(1);
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    hold.on = false;
    expect(await readdir(t.scratch)).toEqual([]);
  }, 60_000);
});

describe("mind eval code (S22.12 AC3)", () => {
  const SET_DIR = join(ROOT, "evals", "code");

  test("the shipped set loads, a bot that answers but edits nothing is still red, and the table carries n", async () => {
    const t = await setup();
    const out = await t.run(["eval", "code", t.agent, "--subject", "example", "--set", SET_DIR, "--backend", "ollama", "--model", "stub", "--only", "fix-sum"]);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr).toContain("leaves this machine");
    // A stub that only talks changes nothing in the copy: the gate it was handed is still red, and that is counted.
    expect(out.stdout).toMatch(/ollama.*: 0\/1 green \(0%\)/);
    expect(out.stdout).toContain("not a ranking");
    const json = await t.run(["eval", "code", t.agent, "--subject", "example", "--set", SET_DIR, "--backend", "ollama", "--only", "fix-sum", "--json"]);
    const parsed = JSON.parse(json.stdout) as { schema: string; rows: { task: string; outcome: string; changed: string[] }[] };
    expect(parsed.schema).toBe("mind/code-eval-run@1");
    expect(parsed.rows.map((r) => r.task)).toEqual(["fix-sum"]);
  });

  test("a missing --set or --backend is a usage error, and a set with a bad task writes nothing", async () => {
    const t = await setup();
    expect((await t.run(["eval", "code", t.agent, "--subject", "example", "--backend", "ollama"])).code).toBe(2);
    const bad = join(t.home, "bad");
    await mkdir(join(bad, "oops", "repo"), { recursive: true });
    await writeFile(join(bad, "oops", "task.toml"), 'schema = "mind/code-eval@1"\nask = "x"\ngate = "bun test"\n');
    const out = await t.run(["eval", "code", t.agent, "--subject", "example", "--set", bad, "--backend", "ollama"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("argv array");
  });
});
