/** S21.1 (D-189) — repeated eval runs, recorded with the soul version that answered, outside git; S21.2 — the split in a run. */

import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_HELDOUT, report, type EvalTask } from "../../src/soul/evals.ts";
import {
  attemptLine,
  EVAL_RUN_SCHEMA,
  EVAL_RUN_SCHEMA_V1,
  evalRunRecord,
  evalRunsDir,
  formatEvalRuns,
  isRunId,
  listEvalRuns,
  MAX_REPEAT,
  newRunId,
  parseRepeat,
  readEvalRun,
  repeatedReport,
  reportLines,
  runAttempts,
  sha256,
  soulContentSha,
  soulFiles,
  soulShort,
  soulVersion,
  splitLines,
  splitRates,
  writeEvalRun,
  type Ask,
  type EvalRunRecord,
} from "../../src/soul/eval-runs.ts";
import { subjectId } from "../../src/types.ts";

const SOUL = join(import.meta.dir, "..", "fixtures", "soul-valid");

const scratch: string[] = [];
afterEach(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mind-eval-runs-"));
  scratch.push(d);
  return d;
}

const task = (id: string, kind: string, expectPhrase: string): EvalTask => ({ id, kind, ask: `ask ${id}`, expect: [expectPhrase], reject: ["wrong"], source: "", split: "train" });
const TASKS: readonly EvalTask[] = [task("port", "ports", "10410"), task("disk", "incidents", "disk full"), task("flip", "incidents", "yes")];

/** A scripted engine: `port` always right, `disk` always wrong, `flip` right on odd attempts only. */
const scripted: Ask = async (t, mode, attempt) => {
  const answer = t.id === "port" ? "It is 10410." : t.id === "disk" ? "no idea" : attempt % 2 === 1 ? "yes" : "wrong";
  return { answer, route: `stub · ${mode}` };
};

async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(child.stderr).text()}`);
}

function record(over: Partial<EvalRunRecord>, rows = [] as EvalRunRecord["results"]): EvalRunRecord {
  return {
    schema: EVAL_RUN_SCHEMA,
    runId: newRunId(new Date("2026-10-19T08:00:00Z")),
    startedAt: "2026-10-19T08:00:00.000Z",
    finishedAt: "2026-10-19T08:01:00.000Z",
    subject: "example",
    soul: { gitTree: "1a2b3c4d5e6f", dirty: false, contentSha256: "9f".repeat(32), files: ["role.md"] },
    evalsSha256: sha256("set"),
    backend: "ollama",
    model: "stub",
    recallChars: 4000,
    repeat: 1,
    modes: ["soul", "soul+rag"],
    tasks: ["port"],
    split: "all",
    keptAnswers: false,
    results: rows,
    report: repeatedReport([TASKS[0]!], rows, 1),
    ...over,
  };
}

describe("--repeat", () => {
  test("absent is 1; 1..10 whole numbers only", () => {
    expect(parseRepeat(undefined)).toEqual({ ok: true, value: 1 });
    expect(parseRepeat("3")).toEqual({ ok: true, value: 3 });
    expect(parseRepeat(String(MAX_REPEAT))).toEqual({ ok: true, value: 10 });
    for (const bad of ["0", "11", "1.5", "", "two", "-1"]) expect(parseRepeat(bad).ok, bad).toBe(false);
  });

  test("each task × mode k times; a pass rate per task, and flaky named", async () => {
    const seen: string[] = [];
    const rows = await runAttempts(TASKS, 3, scripted, false, (row, i) => seen.push(`${i}:${row.task}:${row.mode}:${row.attempt}`));
    expect(rows).toHaveLength(TASKS.length * 2 * 3);
    expect(seen.slice(0, 3)).toEqual(["0:port:soul:1", "0:port:soul:2", "0:port:soul:3"]);
    expect(rows.every((r) => r.answer === undefined)).toBe(true);
    const r = repeatedReport(TASKS, rows, 3);
    expect(r.repeat).toBe(3);
    // port 3/3 + disk 0/3 + flip 2/3 = 5 of 9 per mode.
    expect(r.byMode).toEqual([
      { mode: "soul", passed: 1.67, percent: 55.6 },
      { mode: "soul+rag", passed: 1.67, percent: 55.6 },
    ]);
    const flip = r.byTask.find((t) => t.task === "flip" && t.mode === "soul")!;
    expect(flip).toEqual({ task: "flip", kind: "incidents", mode: "soul", passes: 2, attempts: 3, rate: 0.667, verdict: "flaky" });
    expect(r.byTask.find((t) => t.task === "port")!.verdict).toBe("stable pass");
    expect(r.byTask.find((t) => t.task === "disk")!.verdict).toBe("stable fail");
    expect(r.flaky).toBe(2);
    expect(r.byKind.find((k) => k.kind === "incidents")!.percent["soul"]).toBe(33.3);
    expect(r.notYet).toEqual(["incidents"]);
  });

  test("k = 1 means what the report always meant", async () => {
    const rows = await runAttempts(TASKS, 1, scripted, true);
    expect(rows.map((r) => r.answer)).toEqual(["It is 10410.", "It is 10410.", "no idea", "no idea", "yes", "yes"]);
    const r = repeatedReport(TASKS, rows, 1);
    const plain = report(TASKS, rows);
    expect(r.byMode).toEqual(plain.byMode);
    expect(r.byKind).toEqual(plain.byKind);
    expect(r.byMode[0]).toEqual({ mode: "soul", passed: 2, percent: 66.7 });
    expect(r.flaky).toBe(0);
    expect(repeatedReport(TASKS, [], 1).byTask[0]!.verdict).toBe("stable fail");
  });
});

describe("the soul version", () => {
  test("outside git: a content hash only, stable, and changed by any byte", async () => {
    const home = await temp();
    const soul = join(home, "agent", "soul");
    await cp(SOUL, soul, { recursive: true });
    await mkdir(join(soul, "notes"));
    await writeFile(join(soul, "notes", "x.md"), "x");
    expect(await soulFiles(soul)).toEqual(["notes/x.md", "person.md", "role.md"]);
    const a = await soulVersion(soul);
    expect(a).toEqual({ gitTree: null, dirty: null, contentSha256: a.contentSha256, files: ["notes/x.md", "person.md", "role.md"] });
    expect(a.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await soulVersion(soul)).contentSha256).toBe(a.contentSha256);
    await writeFile(join(soul, "notes", "x.md"), "y");
    expect((await soulVersion(soul)).contentSha256).not.toBe(a.contentSha256);
    expect(soulShort(a)).toBe(`sha ${a.contentSha256.slice(0, 8)}`);
  });

  test("no git on the machine reads as outside git", async () => {
    const soul = join(await temp(), "soul");
    await cp(SOUL, soul, { recursive: true });
    const path = process.env["PATH"];
    process.env["PATH"] = soul;
    try {
      expect(await soulVersion(soul)).toMatchObject({ gitTree: null, dirty: null });
    } finally {
      process.env["PATH"] = path;
    }
  });

  test("beside other files: only the named soul files are the soul", async () => {
    const dir = await temp();
    await cp(SOUL, dir, { recursive: true });
    await writeFile(join(dir, "evals.md"), "not the soul");
    await writeFile(join(dir, "autonomy.md"), "levels");
    expect(await soulFiles(dir)).toEqual(["autonomy.md", "person.md", "role.md"]);
    expect(await soulContentSha(dir, [])).toBe(sha256(""));
  });

  test("in git: the tree at HEAD, and dirty on a change, an untracked file, or no commit yet", async () => {
    const agent = join(await temp(), "agent");
    const soul = join(agent, "soul");
    await cp(SOUL, soul, { recursive: true });
    await git(agent, "init", "-q");
    const uncommitted = await soulVersion(soul);
    expect(uncommitted.gitTree).toBeNull();
    expect(uncommitted.dirty).toBe(true);
    expect(soulShort(uncommitted)).toBe(`sha ${uncommitted.contentSha256.slice(0, 8)}*`);
    await git(agent, "add", "-A");
    await git(agent, "commit", "-q", "-m", "soul");
    const clean = await soulVersion(soul);
    expect(clean.gitTree).toMatch(/^[0-9a-f]{40,64}$/);
    expect(clean.dirty).toBe(false);
    expect(clean.contentSha256).toBe(uncommitted.contentSha256);
    expect(soulShort(clean)).toBe(`tree ${clean.gitTree!.slice(0, 8)}`);
    // A change outside soul/ does not make the soul dirty.
    await writeFile(join(agent, "memory.md"), "elsewhere");
    expect((await soulVersion(soul)).dirty).toBe(false);
    await writeFile(join(soul, "lessons.md"), "new");
    expect((await soulVersion(soul)).dirty).toBe(true);
    await rm(join(soul, "lessons.md"));
    await writeFile(join(soul, "role.md"), (await Bun.file(join(soul, "role.md")).text()) + "\nmore\n");
    const edited = await soulVersion(soul);
    expect(edited).toMatchObject({ gitTree: clean.gitTree, dirty: true });
    expect(soulShort(edited)).toBe(`tree ${clean.gitTree!.slice(0, 8)}*`);
    expect(edited.contentSha256).not.toBe(clean.contentSha256);
  });

  test("in git, soul files beside other files: the named files decide dirty", async () => {
    const dir = await temp();
    await cp(SOUL, dir, { recursive: true });
    await git(dir, "init", "-q");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "soul");
    await writeFile(join(dir, "other.md"), "not soul");
    expect((await soulVersion(dir)).dirty).toBe(false);
    await writeFile(join(dir, "triggers.md"), "new soul file");
    expect((await soulVersion(dir)).dirty).toBe(true);
  });
});

describe("the record", () => {
  test("lives in personal/evals/, 0700 and 0600, written whole", async () => {
    const home = await temp();
    const env = { home, env: { XDG_DATA_HOME: join(home, "data") } };
    const dir = await evalRunsDir(env, subjectId("example"));
    if (!dir.ok) throw new Error(dir.reason);
    expect(dir.path).toBe(join(home, "data", "mind", "example", "personal", "evals"));
    const rows = await runAttempts([TASKS[0]!], 1, scripted, false);
    const run = record({}, rows);
    const path = await writeEvalRun(dir.path, run);
    expect(path).toBe(join(dir.path, `${run.runId}.json`));
    expect((await stat(dir.path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir.path, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir.path)).toEqual([`${run.runId}.json`]);
    const back = JSON.parse(await Bun.file(path).text()) as EvalRunRecord;
    expect(back).toEqual(run);
    expect(back.results[0]).toEqual({ task: "port", kind: "ports", mode: "soul", attempt: 1, split: "train", pass: true, missing: [], rejected: [], route: "stub · soul" });
    await expect(writeEvalRun(dir.path, { ...run, runId: "../escape" })).rejects.toThrow("not an eval run id");
  });

  test("refused inside a git checkout", async () => {
    const home = await temp();
    await git(home, "init", "-q");
    const dir = await evalRunsDir({ home, env: { XDG_DATA_HOME: join(home, "data") } }, subjectId("example"));
    expect(dir.ok).toBe(false);
    if (!dir.ok) expect(dir.reason).toContain("inside the git repository");
  });

  test("run ids sort by time and are checked", () => {
    const id = newRunId(new Date("2026-10-19T08:09:10.123Z"));
    expect(id).toMatch(/^ev-20261019T080910Z-[0-9a-f]{4}$/);
    expect(isRunId(id)).toBe(true);
    expect(isRunId("ev-x")).toBe(false);
  });

  test("eval runs: newest first, unreadable files named, nothing when there is no directory", async () => {
    const dir = join(await temp(), "evals");
    expect(await listEvalRuns(dir)).toEqual({ runs: [], unreadable: [] });
    const rows = await runAttempts(TASKS, 2, scripted, false);
    const older = record({ runId: "ev-20261018T080000Z-aaaa", startedAt: "2026-10-18T08:00:00.000Z" });
    const newer = record({
      runId: "ev-20261019T090000Z-bbbb",
      startedAt: "2026-10-19T09:00:00.000Z",
      repeat: 2,
      tasks: TASKS.map((t) => t.id),
      soul: { gitTree: null, dirty: null, contentSha256: "ab".repeat(32), files: [] },
      backend: null,
      model: null,
      results: rows,
      report: repeatedReport(TASKS, rows, 2),
    });
    const sameTime = record({ runId: "ev-20261018T080000Z-cccc", startedAt: "2026-10-18T08:00:00.000Z", soul: { gitTree: "77".repeat(20), dirty: true, contentSha256: "cd".repeat(32), files: [] } });
    for (const r of [older, newer, sameTime]) await writeEvalRun(dir, r);
    await writeFile(join(dir, "broken.json"), "{");
    await writeFile(join(dir, "other.json"), JSON.stringify({ schema: "something/else" }));
    await writeFile(join(dir, "notes.txt"), "ignored");
    const listed = await listEvalRuns(dir);
    expect(listed.runs.map((r) => r.runId)).toEqual(["ev-20261019T090000Z-bbbb", "ev-20261018T080000Z-cccc", "ev-20261018T080000Z-aaaa"]);
    expect(listed.unreadable).toEqual(["broken.json", "other.json"]);
    const lines = formatEvalRuns(listed.runs);
    expect(lines[0]).toBe(`ev-20261019T090000Z-bbbb  2026-10-19 09:00  sha abababab    default/default       soul 50%  soul+rag 50%  ×2  3 task(s) · 2 flaky`);
    expect(lines[1]).toContain("tree 77777777*");
    expect(lines[2]).toBe(`ev-20261018T080000Z-aaaa  2026-10-18 08:00  tree 1a2b3c4d   ollama/stub           soul 0%  soul+rag 0%  ×1  1 task(s)`);
  });
});

describe("what the command prints and keeps", () => {
  const plain = { bold: (x: string) => `*${x}*`, dim: (x: string) => `~${x}~` };
  const soul = { gitTree: "abcdef0123", dirty: true, contentSha256: "12".repeat(32), files: ["role.md"] };

  test("the record carries the soul, the set's hash, the options and every attempt", async () => {
    const rows = await runAttempts(TASKS, 2, scripted, false);
    const r = repeatedReport(TASKS, rows, 2);
    const rec = evalRunRecord({ startedAt: new Date("2026-10-19T08:00:00Z"), subject: "example", soul, setText: "the set", backend: "", model: "stub", recallChars: 4000, tasks: TASKS, keptAnswers: false, results: rows, report: r }, new Date("2026-10-19T08:05:00Z"));
    expect(rec).toMatchObject({ schema: EVAL_RUN_SCHEMA, startedAt: "2026-10-19T08:00:00.000Z", finishedAt: "2026-10-19T08:05:00.000Z", subject: "example", soul, evalsSha256: sha256("the set"), backend: null, model: "stub", recallChars: 4000, repeat: 2, modes: ["soul", "soul+rag"], tasks: ["port", "disk", "flip"], keptAnswers: false });
    expect(rec.runId).toMatch(/^ev-20261019T080000Z-/);
    expect(rec.results).toHaveLength(12);
    expect(evalRunRecord({ ...rec, startedAt: new Date(), setText: "", backend: undefined, model: undefined, tasks: [], report: r }).model).toBeNull();
  });

  test("progress lines: #n only when repeated, and why a fail failed", async () => {
    const [pass] = await runAttempts([TASKS[0]!], 1, scripted, false);
    expect(attemptLine(pass!, 0, 3, 1)).toBe("  1/3 port [soul] pass · stub");
    const fail = { ...pass!, pass: false, missing: ["10410"], rejected: ["wrong"], attempt: 2 };
    expect(attemptLine(fail, 1, 3, 2)).toBe('  2/3 port [soul] #2 fail — missing "10410" — said "wrong" · stub');
  });

  test("the report: unchanged at k = 1, a per-task block when repeated, and where it was kept", async () => {
    const once = reportLines("Example", repeatedReport(TASKS, await runAttempts(TASKS, 1, scripted, false), 1), { recorded: null, soul, keptAnswers: false }, plain);
    expect(once[0]).toBe("*\nExample — 3 task(s)*");
    expect(once).toContain("  soul             2/3  66.7%");
    expect(once.some((l) => l.includes("by task"))).toBe(false);
    expect(once.at(-1)).toBe("~Not recorded (--no-record).~");
    const rows = await runAttempts(TASKS, 2, scripted, false);
    const twice = reportLines("Example", repeatedReport(TASKS, rows, 2), { recorded: "/x/ev.json", soul, keptAnswers: true }, plain);
    expect(twice[0]).toBe("*\nExample — 3 task(s), each 2 times*");
    expect(twice).toContain("*\nby task (2 attempts each) — 2 flaky*");
    expect(twice.some((l) => /flip\s+soul\s+1\/2  flaky/.test(l))).toBe(true);
    expect(twice.at(-1)).toBe("~Recorded as /x/ev.json (soul tree abcdef01*, answers kept).~");
    const allPass = reportLines("E", repeatedReport([TASKS[0]!], await runAttempts([TASKS[0]!], 1, scripted, false), 1), { recorded: "/y", soul, keptAnswers: false }, plain);
    expect(allPass).toContain("\nEvery kind of work passes at least half its tasks in some configuration.");
    expect(allPass.at(-1)).toContain("answers not kept");
  });
});

describe("the split in a run (S21.2)", () => {
  const plain = { bold: (x: string) => `*${x}*`, dim: (x: string) => `~${x}~` };
  const SPLIT_TASKS: readonly EvalTask[] = [TASKS[0]!, { ...TASKS[1]!, split: "heldout" }, { ...TASKS[2]!, split: "heldout" }];

  test("rows carry the split; the report gives each side, always both", async () => {
    const rows = await runAttempts(SPLIT_TASKS, 2, scripted, false);
    expect(rows.filter((r) => r.split === "heldout")).toHaveLength(8);
    const r = repeatedReport(SPLIT_TASKS, rows, 2);
    // train: port 4/4. heldout: disk 0/4 + flip 2/4 = 2/8 per mode... per mode 1/4.
    expect(r.bySplit).toEqual([
      { split: "train", tasks: 1, byMode: [{ mode: "soul", percent: 100 }, { mode: "soul+rag", percent: 100 }], percent: 100 },
      { split: "heldout", tasks: 2, byMode: [{ mode: "soul", percent: 25 }, { mode: "soul+rag", percent: 25 }], percent: 25 },
    ]);
    expect(splitRates([])).toEqual([
      { split: "train", tasks: 0, byMode: [{ mode: "soul", percent: 0 }, { mode: "soul+rag", percent: 0 }], percent: 0 },
      { split: "heldout", tasks: 0, byMode: [{ mode: "soul", percent: 0 }, { mode: "soul+rag", percent: 0 }], percent: 0 },
    ]);
  });

  test("the report says held-out is what a decision is judged on, and when it is too small or absent", async () => {
    const rows = await runAttempts(SPLIT_TASKS, 1, scripted, false);
    const lines = splitLines(repeatedReport(SPLIT_TASKS, rows, 1).bySplit, plain);
    expect(lines[0]).toBe("*\nby split*");
    expect(lines[1]).toMatch(/^ {2}train\s+1 task\(s\) {3}soul 100% {3}soul\+rag 100% {3}both 100%$/);
    expect(lines).toContain("~Held-out numbers are what a tuning decision is judged on; train numbers are what a tuner may look at.~");
    expect(lines.at(-1)).toBe(`*Held-out is 2 task(s): too small to judge a tuning decision (at least ${MIN_HELDOUT}).*`);
    const none = splitLines(splitRates(rows.filter((r) => r.split === "train")), plain);
    expect(none[2]).toContain("heldout      0 task(s)   —");
    expect(none.at(-1)).toContain("No held-out tasks in this run: it cannot judge a tuning decision.");
    const six = Array.from({ length: MIN_HELDOUT }, (_, i): EvalTask => ({ ...TASKS[0]!, id: `h${i}`, split: "heldout" }));
    const enough = splitLines(splitRates(await runAttempts(six, 1, async () => ({ answer: "10410", route: "r" }), false)), plain);
    expect(enough.at(-1)).toContain("Held-out numbers are what");
    // The full report carries the block.
    expect(reportLines("E", repeatedReport(SPLIT_TASKS, rows, 1), { recorded: null, soul: { gitTree: null, dirty: null, contentSha256: "0".repeat(64), files: [] }, keptAnswers: false }, plain)).toContain("*\nby split*");
  });

  test("an @1 record still reads: every task train, no --split; the list shows held-out and compare when there are any", async () => {
    const dir = join(await temp(), "evals");
    const rows = await runAttempts([TASKS[0]!], 1, scripted, false);
    const v1 = { ...record({ runId: "ev-20261017T080000Z-0001", startedAt: "2026-10-17T08:00:00.000Z" }, rows.map(({ split: _, ...r }) => r as EvalRunRecord["results"][number])), schema: EVAL_RUN_SCHEMA_V1 } as Record<string, unknown>;
    delete v1["split"];
    delete (v1["report"] as Record<string, unknown>)["bySplit"];
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "ev-20261017T080000Z-0001.json"), JSON.stringify(v1));
    const back = await readEvalRun(dir, "ev-20261017T080000Z-0001");
    if (!back.ok) throw new Error(back.reason);
    expect(back.run.split).toBe("all");
    expect(back.run.results[0]!.split).toBe("train");
    expect(back.run.report.bySplit[0]).toMatchObject({ split: "train", tasks: 1, percent: 100 });
    expect((await listEvalRuns(dir)).runs[0]!.results[0]!.split).toBe("train");

    const splitRows = await runAttempts(SPLIT_TASKS, 1, scripted, false);
    const v2 = record({ runId: "ev-20261019T080000Z-0002", tasks: SPLIT_TASKS.map((x) => x.id), results: splitRows, report: repeatedReport(SPLIT_TASKS, splitRows, 1), compare: { id: "cmp-20261019T080000Z-abcd", role: "candidate", ref: "HEAD~1", commit: "f".repeat(40) } });
    await writeEvalRun(dir, v2);
    expect((await readEvalRun(dir, v2.runId)).ok).toBe(true);
    const [line] = formatEvalRuns([v2]);
    expect(line).toEndWith("3 task(s) · heldout 2 at 50% · cmp-20261019T080000Z-abcd candidate");

    for (const [id, needle] of [["nope", "is not an eval run id"], ["ev-20261019T080000Z-ffff", "no readable run"]] as const) {
      const r = await readEvalRun(dir, id);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(needle);
    }
    await writeFile(join(dir, "ev-20261019T080000Z-eeee.json"), JSON.stringify({ schema: "x" }));
    const notRecord = await readEvalRun(dir, "ev-20261019T080000Z-eeee");
    expect(notRecord.ok).toBe(false);
  });

  test("the record keeps the --split it ran with, all by default", async () => {
    const rows = await runAttempts(SPLIT_TASKS, 1, scripted, false);
    const base = { startedAt: new Date(), subject: "example", soul: { gitTree: null, dirty: null, contentSha256: "0".repeat(64), files: [] }, setText: "s", backend: undefined, model: undefined, recallChars: 0, tasks: SPLIT_TASKS, keptAnswers: false, results: rows, report: repeatedReport(SPLIT_TASKS, rows, 1) };
    expect(evalRunRecord(base).split).toBe("all");
    expect(evalRunRecord(base)).not.toHaveProperty("compare");
    expect(evalRunRecord({ ...base, split: "heldout" }).split).toBe("heldout");
  });
});
