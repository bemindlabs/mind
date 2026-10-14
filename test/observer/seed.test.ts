/**
 * The one-off import: the two joins it has to do, and the two piles it has to
 * refuse.
 *
 * Every test here has a control, because each of these criteria has a shape
 * that passes while doing nothing:
 *
 * - **AC8, the cross-file join.** grok's outcome for a call is in a different
 *   *file* from the call — SP-1 found all 565 of its `tool_completed` records
 *   matched a call elsewhere in the directory. So the test seeds with both
 *   files and expects `ok`, then removes the second file and expects `unknown`.
 *   Without the second half, a reader that never joined anything would pass.
 * - **AC7, duplicates.** claude replays records into resumed sessions; 5.3% of
 *   them appear twice. The test puts the same record in two files and expects
 *   one action, then puts two different records in two files and expects two.
 * - **The fleet's work is not the owner's.** 44% of claude's sessions and 80%
 *   of grok's have nobody in them. Skipped and counted — with a control that a
 *   session someone typed in really is kept.
 *
 * Every fixture is written by this file and is entirely invented (ADR 0001 §4).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturedKeys, ensureCaptureDir, readCaptured } from "../../src/observer/capture-store.ts";
import { BACKFILL_NOTE, loadSeeds, saveSeeds, seedVendor, transcriptFiles } from "../../src/observer/seed.ts";
import { announceCapture, ensureObserverDir } from "../../src/observer/store.ts";
import { subjectId } from "../../src/types.ts";
import type { CaptureRecord } from "../../src/observer/record.ts";

const NOW = new Date("2026-09-21T10:00:00.000Z");
const SUBJECT = subjectId("example");

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-seed-"));
  scratch.push(dir);
  return dir;
}

async function observerIn(home: string): Promise<string> {
  const created = await ensureObserverDir(
    { home, env: { XDG_DATA_HOME: join(home, "data") } },
    SUBJECT,
    announceCapture(() => undefined),
  );
  if (!created.ok) throw new Error(created.reason);
  await ensureCaptureDir(created.path);
  return created.path;
}

async function writeLines(path: string, records: readonly unknown[]): Promise<void> {
  await Bun.write(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** A claude transcript record a person typed. */
function typed(uuid: string, session: string, at: string): unknown {
  return {
    uuid,
    sessionId: session,
    timestamp: at,
    cwd: "/synthetic/project",
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "CANARY-what-I-asked-for" }] },
  };
}

/** A claude transcript record holding one tool call. */
function called(uuid: string, session: string, at: string, id: string, name: string, input: unknown): unknown {
  return {
    uuid,
    sessionId: session,
    timestamp: at,
    cwd: "/synthetic/project",
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  };
}

/** A claude transcript record answering a tool call. */
function answered(uuid: string, session: string, at: string, id: string, isError: boolean): unknown {
  return {
    uuid,
    sessionId: session,
    timestamp: at,
    cwd: "/synthetic/project",
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "CANARY-output" }],
    },
  };
}

/** Seed one vendor into a fresh observer directory and hand back what landed. */
async function seedInto(
  root: string,
  vendor: "claude" | "grok",
): Promise<{ dir: string; records: readonly CaptureRecord[]; result: Awaited<ReturnType<typeof seedVendor>> }> {
  const home = await sandbox();
  const dir = await observerIn(home);
  const result = await seedVendor({
    observerPath: dir,
    vendor,
    root,
    now: NOW,
    seen: await capturedKeys(dir),
    repeat: false,
  });
  const back = await readCaptured(dir);
  // The records themselves are `Personal<T>` and stay boxed; what a test needs
  // is the report plus the on-disk lines, read back here rather than unwrapped.
  const lines = await Promise.all(
    back.report.files.map(async (path) => (await Bun.file(path).text()).split("\n")),
  );
  const records = lines
    .flat()
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CaptureRecord);
  return { dir, records, result };
}

describe("claude — the duplicate that would invent a preference (AC7)", () => {
  test("the same record in two files is one action", async () => {
    const root = await sandbox();
    const one = typed("u-1", "s-1", "2026-09-20T09:00:00.000Z");
    const two = called("u-2", "s-1", "2026-09-20T09:00:01.000Z", "t-1", "Write", {
      file_path: "/synthetic/project/a.ts",
    });
    // A resumed session replays what came before — this is that, exactly.
    await writeLines(join(root, "a.jsonl"), [one, two]);
    await writeLines(join(root, "b.jsonl"), [one, two, typed("u-3", "s-1", "2026-09-20T10:00:00.000Z")]);

    const { records, result } = await seedInto(root, "claude");

    expect(result.report.duplicates).toBe(2);
    expect(records.length).toBe(3);
    expect(records.filter((r) => r.key === "claude:tool:t-1").length).toBe(1);
  });

  test("the control: two different records in two files are two actions", async () => {
    const root = await sandbox();
    await writeLines(join(root, "a.jsonl"), [
      typed("u-1", "s-1", "2026-09-20T09:00:00.000Z"),
      called("u-2", "s-1", "2026-09-20T09:00:01.000Z", "t-1", "Write", { file_path: "/x/a.ts" }),
    ]);
    await writeLines(join(root, "b.jsonl"), [
      typed("u-3", "s-1", "2026-09-20T11:00:00.000Z"),
      called("u-4", "s-1", "2026-09-20T11:00:01.000Z", "t-2", "Write", { file_path: "/x/b.ts" }),
    ]);

    const { records, result } = await seedInto(root, "claude");
    expect(result.report.duplicates).toBe(0);
    expect(records.filter((r) => r.kind === "file-edit").length).toBe(2);
  });
});

describe("claude — the outcome, and what is never carried across", () => {
  test("a call answered later in the file gets its outcome", async () => {
    const root = await sandbox();
    await writeLines(join(root, "a.jsonl"), [
      typed("u-1", "s-1", "2026-09-20T09:00:00.000Z"),
      called("u-2", "s-1", "2026-09-20T09:00:01.000Z", "t-ok", "Bash", { command: "npm test" }),
      answered("u-3", "s-1", "2026-09-20T09:00:02.000Z", "t-ok", false),
      called("u-4", "s-1", "2026-09-20T09:00:03.000Z", "t-bad", "Bash", { command: "npm run broken" }),
      answered("u-5", "s-1", "2026-09-20T09:00:04.000Z", "t-bad", true),
      called("u-6", "s-1", "2026-09-20T09:00:05.000Z", "t-none", "Read", { file_path: "/x/c.ts" }),
    ]);

    const { dir, records } = await seedInto(root, "claude");
    const by = (key: string) => records.find((r) => r.key === key);

    expect(by("claude:tool:t-ok")?.outcome).toBe("ok");
    expect(by("claude:tool:t-bad")?.outcome).toBe("failed");
    // Never answered, so nobody said. `unknown` is not `ok`.
    expect(by("claude:tool:t-none")?.outcome).toBe("unknown");

    // The prompt text and the tool output are both in the fixture; neither is
    // in the store. The control is that the store is not empty.
    expect(records.length).toBeGreaterThan(3);
    const text = (await Bun.file((await readCaptured(dir)).report.files[0] ?? "").text());
    expect(text).not.toContain("CANARY");
  });

  test("a seeded record is `source: seed` and `origin: unknown`, always", async () => {
    const root = await sandbox();
    await writeLines(join(root, "a.jsonl"), [
      typed("u-1", "s-1", "2026-09-20T09:00:00.000Z"),
      called("u-2", "s-1", "2026-09-20T09:00:01.000Z", "t-1", "Bash", { command: "git commit -m x" }),
    ]);

    const { records } = await seedInto(root, "claude");
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.source).toBe("seed");
      // The evidence that would decide this is not in the file, and a session
      // with a human in it does not make one action the owner's.
      expect(record.origin).toBe("unknown");
      expect(record.evidence.humanTurnsInSession).toBeGreaterThan(0);
    }
    expect(records.find((r) => r.kind === "command")?.target).toBe("git commit");
  });
});

describe("claude — whose behaviour is this", () => {
  test("a session nobody typed in is skipped and counted", async () => {
    const root = await sandbox();
    await writeLines(join(root, "fleet.jsonl"), [
      called("u-1", "fleet-1", "2026-09-20T09:00:00.000Z", "t-1", "Write", { file_path: "/x/a.ts" }),
      called("u-2", "fleet-1", "2026-09-20T09:00:01.000Z", "t-2", "Bash", { command: "npm test" }),
    ]);

    const { records, result } = await seedInto(root, "claude");
    expect(records).toEqual([]);
    expect(result.report.skipped["no-human-session"]).toBe(2);
  });

  test("the control: the same records in a session someone typed in are kept", async () => {
    const root = await sandbox();
    await writeLines(join(root, "mine.jsonl"), [
      typed("u-0", "mine-1", "2026-09-20T08:59:00.000Z"),
      called("u-1", "mine-1", "2026-09-20T09:00:00.000Z", "t-1", "Write", { file_path: "/x/a.ts" }),
      called("u-2", "mine-1", "2026-09-20T09:00:01.000Z", "t-2", "Bash", { command: "npm test" }),
    ]);

    const { records, result } = await seedInto(root, "claude");
    expect(records.length).toBe(3);
    expect(result.report.skipped["no-human-session"]).toBeUndefined();
  });

  test("sub-agent, meta and compact records are skipped under their own names", async () => {
    const root = await sandbox();
    await writeLines(join(root, "a.jsonl"), [
      typed("u-0", "s-1", "2026-09-20T08:00:00.000Z"),
      { ...(called("u-1", "s-1", "2026-09-20T09:00:00.000Z", "t-1", "Read", {}) as object), isSidechain: true },
      { ...(called("u-2", "s-1", "2026-09-20T09:00:01.000Z", "t-2", "Read", {}) as object), isMeta: true },
      {
        ...(called("u-3", "s-1", "2026-09-20T09:00:02.000Z", "t-3", "Read", {}) as object),
        isCompactSummary: true,
      },
    ]);

    const { records, result } = await seedInto(root, "claude");
    expect(records.map((r) => r.key)).toEqual(["claude:prompt:u-0"]);
    expect(result.report.skipped["sidechain"]).toBe(1);
    expect(result.report.skipped["meta"]).toBe(1);
    expect(result.report.skipped["compact-summary"]).toBe(1);
  });
});

describe("grok — the join across files (AC8)", () => {
  /** Two files: the call in one, the answer in the other. */
  async function grokFixture(withAnswer: boolean): Promise<string> {
    const root = await sandbox();
    await writeLines(join(root, "sess-a.jsonl"), [
      { type: "user", role: "user", content: "CANARY-what-I-asked", timestamp: "2026-09-20T09:00:00.000Z" },
      {
        type: "tool_call",
        timestamp: "2026-09-20T09:00:01.000Z",
        cwd: "/synthetic/project",
        name: "run_terminal_cmd",
        tool_call_id: "g-1",
        arguments: { command: "pnpm build --prod" },
      },
    ]);
    if (withAnswer) {
      await writeLines(join(root, "sess-b.jsonl"), [
        { type: "tool_completed", tool_call_id: "g-1", outcome: "success", timestamp: "2026-09-20T09:00:09.000Z" },
      ]);
    }
    return root;
  }

  test("the outcome is found in the next file along", async () => {
    const { records } = await seedInto(await grokFixture(true), "grok");
    const call = records.find((r) => r.key === "grok:tool:g-1");
    expect(call).toBeDefined();
    expect(call?.outcome).toBe("ok");
    expect(call?.kind).toBe("command");
    expect(call?.target).toBe("pnpm build");
    expect(call?.vendor).toBe("grok");
  });

  test("the control: take the second file away and the same call is `unknown`", async () => {
    // A reader that opened one file at a time would report this on *both*
    // runs, which is why the first test alone would not prove the join.
    const { records } = await seedInto(await grokFixture(false), "grok");
    const call = records.find((r) => r.key === "grok:tool:g-1");
    expect(call).toBeDefined();
    expect(call?.outcome).toBe("unknown");
  });

  test("a grok session with nobody in it is skipped — 80% of them, measured", async () => {
    const root = await sandbox();
    await writeLines(join(root, "sess-a.jsonl"), [
      {
        type: "tool_call",
        timestamp: "2026-09-20T09:00:01.000Z",
        name: "read_file",
        tool_call_id: "g-2",
        arguments: { path: "/x/a.ts" },
      },
    ]);
    const { records, result } = await seedInto(root, "grok");
    expect(records).toEqual([]);
    expect(result.report.skipped["no-human-session"]).toBe(1);
  });
});

describe("what a seed reads, and what it refuses to read", () => {
  test("only .jsonl — the .json sidecars beside them are not transcripts", async () => {
    const root = await sandbox();
    await Bun.write(join(root, "a.jsonl"), "{}\n");
    await Bun.write(join(root, "index.json"), '{"sessions": []}\n');
    await Bun.write(join(root, "nested", "b.jsonl"), "{}\n");
    await Bun.write(join(root, "node_modules", "c.jsonl"), "{}\n");

    const found = await transcriptFiles(root);
    expect(found.length).toBe(2);
    expect(found.some((p) => p.endsWith("index.json"))).toBe(false);
    expect(found.some((p) => p.includes("node_modules"))).toBe(false);
  });

  test("a directory that is not there is no files, not an exception", async () => {
    expect(await transcriptFiles(join(await sandbox(), "nowhere"))).toEqual([]);
  });

  test("one bad line in ten does not end the run (AC2, AC3)", async () => {
    const root = await sandbox();
    const lines: string[] = [JSON.stringify(typed("u-0", "s-1", "2026-09-20T08:00:00.000Z"))];
    for (let index = 1; index < 10; index += 1) {
      lines.push(
        index === 4
          ? '{"uuid": "broken"'
          : JSON.stringify(
              called("u-" + index, "s-1", "2026-09-20T09:00:00.000Z", `t-${index}`, "Read", {}),
            ),
      );
    }
    await Bun.write(join(root, "a.jsonl"), lines.join("\n") + "\n");

    const { records, result } = await seedInto(root, "claude");
    expect(result.report.lines).toBe(10);
    expect(result.report.pct).toBe(90);
    expect(result.report.skipped["unparsable"]).toBe(1);
    expect(records.length).toBe(9);
  });
});

describe("a seed after a capture adds only what is new", () => {
  test("the hook and the seed mint the same key, so the week is not counted twice", async () => {
    const home = await sandbox();
    const dir = await observerIn(home);
    const root = await sandbox();

    await writeLines(join(root, "a.jsonl"), [
      typed("u-0", "s-1", "2026-09-20T08:00:00.000Z"),
      called("u-1", "s-1", "2026-09-20T09:00:00.000Z", "t-1", "Write", { file_path: "/x/a.ts" }),
    ]);

    const first = await seedVendor({
      observerPath: dir,
      vendor: "claude",
      root,
      now: NOW,
      seen: await capturedKeys(dir),
      repeat: false,
    });
    expect(first.written).toBe(2);

    // The same directory again — what a timer would do.
    const second = await seedVendor({
      observerPath: dir,
      vendor: "claude",
      root,
      now: NOW,
      seen: await capturedKeys(dir),
      repeat: true,
    });
    expect(second.written).toBe(0);
    expect(second.report.duplicates).toBe(2);
    expect((await readCaptured(dir)).report.records).toBe(2);
  });
});

describe("the seed ledger, and the word for doing it twice", () => {
  test("it round-trips, and a missing or broken file is `nothing seeded`", async () => {
    const home = await sandbox();
    const dir = await observerIn(home);

    expect(await loadSeeds(dir)).toEqual({});
    await saveSeeds(dir, { claude: { at: NOW.toISOString(), root: "/synthetic/claude", records: 7 } });
    expect((await loadSeeds(dir)).claude?.records).toBe(7);
    expect((await loadSeeds(dir)).grok).toBeUndefined();

    await Bun.write(join(dir, "seeds.json"), "{not json");
    expect(await loadSeeds(dir)).toEqual({});
  });

  test("the note names what a repeat really is", () => {
    expect(BACKFILL_NOTE).toContain("backfill");
    expect(BACKFILL_NOTE).toContain("D-024");
    expect(BACKFILL_NOTE).toContain("capture hook");
  });
});
