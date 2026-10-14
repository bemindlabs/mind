import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  alive,
  createTask,
  isFinal,
  isTaskId,
  listTasks,
  newTaskId,
  openStep,
  readTask,
  replaceFile,
  requestStop,
  shownStatus,
  stopRequested,
  taskDirIn,
  TASK_SCHEMA,
  tasksDir,
  thisProcess,
  writeTask,
} from "../../src/task/store.ts";
import { aTask, cleanup, SUBJECT, tempHome } from "./fixture.ts";

const scratch: string[] = [];
afterEach(() => cleanup(scratch));

describe("the task store (D-154)", () => {
  test("ids are t- and eight hex, and nothing else reaches a path", () => {
    for (let i = 0; i < 20; i++) expect(isTaskId(newTaskId())).toBe(true);
    for (const bad of ["t-0000abc", "t-0000abcg", "../t-0000abcd", "t-0000ABCD", "x-0000abcd", ""]) expect(isTaskId(bad)).toBe(false);
    expect(() => taskDirIn("/tasks", "../../etc")).toThrow("not a task id");
  });

  test("tasks live in the personal directory, outside git", async () => {
    const box = await tempHome(scratch);
    const dir = await tasksDir({ home: box.home, env: box.env }, SUBJECT);
    expect(dir).toEqual({ ok: true, path: box.tasks });
  });

  test("a task in a git repository is refused, like any personal data", async () => {
    const box = await tempHome(scratch);
    await mkdir(join(box.home, "data", ".git"), { recursive: true });
    const dir = await tasksDir({ home: box.home, env: box.env }, SUBJECT);
    expect(dir.ok).toBe(false);
  });

  test("created once, private, read back, listed newest first", async () => {
    const box = await tempHome(scratch);
    const path = await createTask(box.tasks, aTask());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(box.tasks, "t-0000abcd"))).mode & 0o777).toBe(0o700);
    await expect(createTask(box.tasks, aTask())).rejects.toThrow();
    await createTask(box.tasks, aTask({ id: "t-0000abce", createdAt: "2026-10-05T11:00:00.000Z" }));
    const read = await readTask(box.tasks, SUBJECT, "t-0000abcd");
    expect(read.ok && read.record.goal).toBe("find the answer");
    const listed = await listTasks(box.tasks, SUBJECT);
    expect(listed.records.map((r) => r.id)).toEqual(["t-0000abce", "t-0000abcd"]);
    expect(listed.unreadable).toEqual([]);
  });

  test("a record is written under the current id", async () => {
    const box = await tempHome(scratch);
    expect(TASK_SCHEMA).toBe("mind/task@1");
    await createTask(box.tasks, aTask());
    expect(JSON.parse(await readFile(join(box.tasks, "t-0000abcd", "task.json"), "utf8")).schema).toBe(TASK_SCHEMA);
    const listed = await listTasks(box.tasks, SUBJECT);
    expect(listed.records.map((r) => r.id)).toEqual(["t-0000abcd"]);
    expect(listed.unreadable).toEqual([]);
  });

  test("a record under another schema id is not read", async () => {
    const box = await tempHome(scratch);
    await mkdir(join(box.tasks, "t-0000abce"), { recursive: true });
    await writeFile(join(box.tasks, "t-0000abce", "task.json"), JSON.stringify(aTask({ id: "t-0000abce", schema: "other/task@1" as typeof TASK_SCHEMA })));
    expect((await readTask(box.tasks, SUBJECT, "t-0000abce")).ok).toBe(false);
  });

  test("what is not a record is said, never thrown", async () => {
    const box = await tempHome(scratch);
    expect(await listTasks(box.tasks, SUBJECT)).toEqual({ records: [], unreadable: [] });
    await createTask(box.tasks, aTask());
    expect((await readTask(box.tasks, SUBJECT, "../x")).ok).toBe(false);
    expect(await readTask(box.tasks, SUBJECT, "t-11111111")).toMatchObject({ ok: false, missing: true });
    await mkdir(join(box.tasks, "t-22222222"));
    await writeFile(join(box.tasks, "t-22222222", "task.json"), "{nope");
    await mkdir(join(box.tasks, "t-33333333"));
    await writeFile(join(box.tasks, "t-33333333", "task.json"), JSON.stringify({ schema: "other" }));
    await mkdir(join(box.tasks, "t-44444444"));
    await writeFile(join(box.tasks, "t-44444444", "task.json"), JSON.stringify(aTask()));
    const listed = await listTasks(box.tasks, SUBJECT);
    expect(listed.records.map((r) => r.id)).toEqual(["t-0000abcd"]);
    expect(listed.unreadable).toHaveLength(3);
    expect(listed.unreadable.join(" ")).toContain("names another task");
  });

  test("a rewrite replaces the file whole and never makes a directory an erase removed", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask());
    await writeTask(box.tasks, aTask({ status: "running" }));
    const read = await readTask(box.tasks, SUBJECT, "t-0000abcd");
    expect(read.ok && read.record.status).toBe("running");
    await rm(box.tasks, { recursive: true });
    await expect(writeTask(box.tasks, aTask())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(replaceFile(join(box.tasks, "x"), "y")).rejects.toThrow();
  });

  test("a stop request is a file the runner looks for", async () => {
    const box = await tempHome(scratch);
    await createTask(box.tasks, aTask());
    const dir = taskDirIn(box.tasks, "t-0000abcd");
    expect(await stopRequested(dir)).toBe(false);
    await requestStop(dir, "test", new Date("2026-10-05T12:00:00Z"));
    expect(await stopRequested(dir)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, "stop"), "utf8"))).toEqual({ by: "test", at: "2026-10-05T12:00:00.000Z" });
  });

  test("a runner is alive only as the same pid started at the same moment; a dead one shows as interrupted", () => {
    const stat = (pid: number) => (pid === 7 ? { startTicks: 100 } : null);
    expect(alive(null, stat)).toBe(false);
    expect(alive({ pid: 7, start: 100 }, stat)).toBe(true);
    expect(alive({ pid: 7, start: null }, stat)).toBe(true);
    expect(alive({ pid: 7, start: 99 }, stat)).toBe(false);
    expect(alive({ pid: 8, start: 100 }, stat)).toBe(false);
    const running = aTask({ status: "running", runner: { pid: 7, start: 100, since: "x" } });
    expect(shownStatus(running, stat)).toBe("running");
    expect(shownStatus({ ...running, runner: { pid: 7, start: 1, since: "x" } }, stat)).toBe("interrupted");
    expect(shownStatus(aTask({ status: "done" }), stat)).toBe("done");
    // Made a moment ago and not yet claimed by its runner: starting. An hour later with none: interrupted.
    const fresh = aTask({ createdAt: new Date(1_000_000).toISOString() });
    expect(shownStatus(fresh, stat, 1_000_000 + 1000)).toBe("planning");
    expect(shownStatus(fresh, stat, 1_000_000 + 3_600_000)).toBe("interrupted");
    expect(isFinal("budget")).toBe(true);
    expect(isFinal("waiting")).toBe(false);
    expect(thisProcess().pid).toBe(process.pid);
  });

  test("the open step is the last one, while it has no end", () => {
    const step = { n: 1, kind: "step" as const, startedAt: "a", finishedAt: null, turnId: null, backend: null, exit: null, outcome: null, summary: "", done: false, tokens: null, ms: null, waitedMs: 0 };
    expect(openStep(aTask())).toBeUndefined();
    expect(openStep(aTask({ steps: [step] }))).toEqual(step);
    expect(openStep(aTask({ steps: [{ ...step, finishedAt: "b" }] }))).toBeUndefined();
  });
});
