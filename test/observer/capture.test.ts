/**
 * The hook adapter and the store: what a live event becomes, and where it goes.
 *
 * The assertions that matter most here are absences, and each one is paired
 * with proof that something really was written — an empty store also satisfies
 * "the prompt text is not in the store".
 *
 * - **No text, anywhere.** The payload carries `prompt` and `tool_response`.
 *   Both are one field access away and neither is read. The test writes a
 *   distinctive string into each and then greps the whole tree.
 * - **A hook cannot create its directory.** `appendRecord` must fail after a
 *   purge rather than rebuilding the tree, because a hook that rebuilds it has
 *   resumed capture without anybody agreeing to it a second time (I-4).
 * - **One subject's actions never appear under another's** (I-3).
 *
 * Every payload below is invented and shaped like the ones claude 2.1.278
 * sends; the field names were read off that binary (`docs/cli-matrix.md`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRecord,
  capturedKeys,
  captureDir,
  ensureCaptureDir,
  readCaptured,
  RECORD_MAX_BYTES,
} from "../../src/observer/capture-store.ts";
import {
  claudeHook,
  claudeHookSnippet,
  CLAUDE_HOOK_EVENTS,
  hookEvent,
  hookSession,
  nextSessionState,
} from "../../src/observer/adapters/claude-hook.ts";
import { NO_SESSION, type SessionState } from "../../src/observer/origin.ts";
import { readInto, textLines } from "../../src/observer/reader.ts";
import { CAPTURE_VERSION, type CaptureRecord } from "../../src/observer/record.ts";
import { announceCapture, ensureObserverDir } from "../../src/observer/store.ts";
import { subjectId } from "../../src/types.ts";

const AT = "2026-09-21T10:00:00.000Z";
const WHEN = new Date(AT);

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-capture-"));
  scratch.push(dir);
  return dir;
}

/** A capture directory for one subject, created the only way there is. */
async function observerFor(home: string, subject: string): Promise<string> {
  const created = await ensureObserverDir(
    { home, env: { XDG_DATA_HOME: join(home, "data") } },
    subjectId(subject),
    announceCapture(() => undefined),
  );
  if (!created.ok) throw new Error(created.reason);
  await ensureCaptureDir(created.path);
  return created.path;
}

function payload(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "s-1",
    transcript_path: "/synthetic/transcript.jsonl",
    cwd: "/synthetic/project",
    permission_mode: "default",
    hook_event_name: event,
    ...extra,
  });
}

/** Run one payload through the whole pipe and return what it produced. */
async function capture(text: string, session: SessionState = NO_SESSION): Promise<CaptureRecord[]> {
  const kept: CaptureRecord[] = [];
  await readInto(textLines(text), claudeHook({ at: AT, session }), (r) => void kept.push(r));
  return kept;
}

/** Every file under a directory whose bytes contain `needle`. */
async function grepTree(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ((await Bun.file(path).text()).includes(needle)) hits.push(path);
    }
  };
  await walk(dir);
  return hits;
}

describe("the hook adapter", () => {
  test("a prompt is recorded as having happened, and not a word of it is kept", async () => {
    const records = await capture(
      payload("UserPromptSubmit", { prompt: "CANARY-the-thing-I-typed", source: "user" }),
    );

    expect(records.length).toBe(1);
    const [record] = records;
    expect(record?.kind).toBe("prompt");
    expect(record?.origin).toBe("owner-prompted");
    expect(record?.tool).toBe("");
    expect(record?.target).toBe("");
    expect(record?.evidence.humanTurnsInSession).toBe(1);
    // Not the text, not its length, not a hash of it.
    expect(JSON.stringify(record)).not.toContain("CANARY");
  });

  test("a tool that worked, with the file path relative to the project", async () => {
    const records = await capture(
      payload("PostToolUse", {
        tool_name: "Edit",
        tool_use_id: "t-1",
        tool_input: { file_path: "/synthetic/project/src/a.ts", old_string: "CANARY-old" },
        tool_response: { filePath: "/synthetic/project/src/a.ts", output: "CANARY-output" },
      }),
      { promptSource: "user", permissionMode: "default", humanTurns: 1, lastPromptAt: AT },
    );

    expect(records.length).toBe(1);
    const [record] = records;
    expect(record?.kind).toBe("file-edit");
    expect(record?.tool).toBe("Edit");
    expect(record?.target).toBe("src/a.ts");
    expect(record?.outcome).toBe("ok");
    expect(record?.key).toBe("claude:tool:t-1");
    expect(record?.origin).toBe("owner-prompted");
    // The tool's own arguments and its output are both one field access away.
    expect(JSON.stringify(record)).not.toContain("CANARY");
  });

  test("a tool that failed fires a different event, and is recorded as failed", async () => {
    // This is the whole reason the snippet asks for three events rather than
    // two. Measured on claude 2.1.278: a failing tool does not fire
    // PostToolUse at all, so a reader that asked only for it would record a
    // world in which nothing the owner does ever fails.
    const records = await capture(
      payload("PostToolUseFailure", {
        tool_name: "Bash",
        tool_use_id: "t-2",
        tool_input: { command: "git push origin main" },
        error: "CANARY-the-error-text",
      }),
    );

    expect(records.length).toBe(1);
    expect(records[0]?.outcome).toBe("failed");
    expect(records[0]?.kind).toBe("command");
    expect(records[0]?.target).toBe("git push");
    expect(JSON.stringify(records[0])).not.toContain("CANARY");
  });

  test("a subagent's work is the fleet's, whoever typed the prompt", async () => {
    const records = await capture(
      payload("PostToolUse", {
        tool_name: "Read",
        tool_use_id: "t-3",
        tool_input: { file_path: "/synthetic/project/x.ts" },
        agent_id: "sub-1",
        agent_type: "general-purpose",
      }),
      { promptSource: "user", permissionMode: "default", humanTurns: 4, lastPromptAt: AT },
    );
    expect(records[0]?.origin).toBe("subagent");
  });

  test("an event nobody asked for is skipped under its own name", async () => {
    const kept: CaptureRecord[] = [];
    const report = await readInto(
      textLines(payload("PreToolUse", { tool_name: "Bash", tool_use_id: "t-4", tool_input: {} })),
      claudeHook({ at: AT, session: NO_SESSION }),
      (r) => void kept.push(r),
    );
    expect(kept).toEqual([]);
    expect(report.skipped["event:PreToolUse"]).toBe(1);
  });

  test("payloads missing what a record needs are skipped, each under its own reason", async () => {
    const cases: readonly [string, string][] = [
      [JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t" }), "no-session"],
      [payload("PostToolUse", { tool_use_id: "t" }), "no-tool"],
      [payload("PostToolUse", { tool_name: "Bash" }), "no-tool-id"],
      [JSON.stringify({ session_id: "s" }), "no-event"],
      ["[]", "not-an-object"],
    ];
    for (const [text, reason] of cases) {
      const report = await readInto(
        textLines(text),
        claudeHook({ at: AT, session: NO_SESSION }),
        () => undefined,
      );
      expect(report.skipped[reason], text).toBe(1);
    }
  });

  test("the session helpers find what the CLI needs before it can adapt anything", () => {
    const text = payload("UserPromptSubmit", { prompt: "x", source: "sdk" });
    expect(hookSession(JSON.parse(text))).toBe("s-1");
    expect(hookEvent(JSON.parse(text))).toBe("UserPromptSubmit");

    const next = nextSessionState(JSON.parse(text), NO_SESSION, AT);
    expect(next?.promptSource).toBe("sdk");
    expect(next?.humanTurns).toBe(1);
    expect(next?.lastPromptAt).toBe(AT);

    // A tool event changes nothing, so nothing is rewritten.
    const tool = payload("PostToolUse", { tool_name: "Read", tool_use_id: "t", tool_input: {} });
    expect(nextSessionState(JSON.parse(tool), NO_SESSION, AT)).toBeUndefined();
  });

  test("the snippet asks for the three events this file reads, and no others", () => {
    const snippet = JSON.parse(claudeHookSnippet("mind observe capture --subject example")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(snippet.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    expect(CLAUDE_HOOK_EVENTS).toContain("PostToolUseFailure");
    expect(CLAUDE_HOOK_EVENTS).not.toContain("PreToolUse");
    expect(JSON.stringify(snippet)).toContain("mind observe capture --subject example");
  });
});

describe("the store", () => {
  test("a record written is a record read back", async () => {
    const home = await sandbox();
    const dir = await observerFor(home, "example");

    for (const record of await capture(
      payload("PostToolUse", {
        tool_name: "Bash",
        tool_use_id: "t-1",
        tool_input: { command: "npm test" },
      }),
    )) {
      expect((await appendRecord(dir, record, WHEN)).ok).toBe(true);
    }

    const back = await readCaptured(dir);
    expect(back.report.records).toBe(1);
    expect(back.report.files.map((p) => p.endsWith("2026-09.jsonl"))).toEqual([true]);
  });

  test("the same key twice on disk is one action, not two", async () => {
    const home = await sandbox();
    const dir = await observerFor(home, "example");

    const [record] = await capture(
      payload("PostToolUse", { tool_name: "Read", tool_use_id: "t-1", tool_input: {} }),
    );
    expect(record).toBeDefined();
    if (record === undefined) return;

    // Twice, as a replayed transcript or a re-run seed would.
    await appendRecord(dir, record, WHEN);
    await appendRecord(dir, record, WHEN);

    const back = await readCaptured(dir);
    expect(back.report.lines).toBe(2);
    expect(back.report.records).toBe(1);
    expect(back.report.duplicates).toBe(1);
    expect((await capturedKeys(dir)).size).toBe(1);
  });

  test("an unreadable line is counted and the rest still read (AC2 on the way back)", async () => {
    const home = await sandbox();
    const dir = await observerFor(home, "example");
    const [record] = await capture(
      payload("PostToolUse", { tool_name: "Read", tool_use_id: "t-1", tool_input: {} }),
    );
    if (record === undefined) return;
    await appendRecord(dir, record, WHEN);
    await Bun.write(join(captureDir(dir), "2026-08.jsonl"), "{half a line\n");

    const back = await readCaptured(dir);
    expect(back.report.records).toBe(1);
    expect(back.report.skipped["unparsable"]).toBe(1);
  });

  test("I-3 — one subject's actions never appear under another's", async () => {
    const home = await sandbox();
    const a = await observerFor(home, "alpha");
    const b = await observerFor(home, "beta");
    expect(a).not.toBe(b);

    const [record] = await capture(
      payload("PostToolUse", {
        tool_name: "Edit",
        tool_use_id: "t-1",
        tool_input: { file_path: "/synthetic/project/alpha-only.ts" },
      }),
    );
    if (record === undefined) return;
    await appendRecord(a, record, WHEN);

    expect((await readCaptured(a)).report.records).toBe(1);
    // The control is the line above: without it, a zero here would also be
    // what a store that wrote nothing at all produces.
    expect((await readCaptured(b)).report.records).toBe(0);
    expect(await grepTree(b, "alpha-only")).toEqual([]);
  });

  test("after a purge, a hook writes nothing and rebuilds nothing", async () => {
    const home = await sandbox();
    const dir = await observerFor(home, "example");

    const [record] = await capture(
      payload("PostToolUse", { tool_name: "Read", tool_use_id: "t-1", tool_input: {} }),
    );
    if (record === undefined) return;
    expect((await appendRecord(dir, record, WHEN)).ok).toBe(true);

    await rm(dir, { recursive: true, force: true });

    const after = await appendRecord(dir, record, WHEN);
    expect(after.ok).toBe(false);
    expect(await Bun.file(join(captureDir(dir), "2026-09.jsonl")).exists()).toBe(false);
    // And the directory itself is still gone: nothing here calls mkdir.
    expect(await readdir(dir).then(() => true, () => false)).toBe(false);
  });

  test("a record over the cap is refused rather than written torn", async () => {
    const home = await sandbox();
    const dir = await observerFor(home, "example");

    const huge: CaptureRecord = {
      v: CAPTURE_VERSION,
      key: "claude:tool:huge",
      at: AT,
      vendor: "claude",
      session: "s-1",
      // Nothing built by an adapter can reach this size; a record that does is
      // something upstream having started to carry content.
      project: "/synthetic/".padEnd(RECORD_MAX_BYTES + 100, "x"),
      kind: "tool",
      tool: "Read",
      target: "",
      outcome: "ok",
      source: "hook",
      origin: "unknown",
      evidence: { promptSource: null, permissionMode: null, subagent: false, humanTurnsInSession: 0 },
    };

    const outcome = await appendRecord(dir, huge, WHEN);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("cap");
    expect((await readCaptured(dir)).report.records).toBe(0);
  });

  test("an empty store is empty, not an error", async () => {
    const home = await sandbox();
    const dir = await observerFor(home, "example");
    const back = await readCaptured(dir);
    expect(back.report.records).toBe(0);
    expect(back.report.files).toEqual([]);
    expect((await capturedKeys(dir)).size).toBe(0);
  });
});
