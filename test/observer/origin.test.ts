/**
 * "Who set this going?" — the field D-024 moved a whole epic for, and the one
 * place this code is most likely to flatter its owner.
 *
 * The failure worth testing for is not a crash. It is `unknown` quietly
 * becoming `owner-prompted`, because that version of the bug produces a
 * plausible-looking pile of records in which the fleet's habits are the
 * owner's. `S3.2 AC3` exists to prevent exactly that, so most of this file is
 * assertions that a missing or unfamiliar signal stays `unknown`.
 *
 * The prompt-source words below were read off the installed claude binary; see
 * `docs/cli-matrix.md` and the header of `src/observer/adapters/claude-hook.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveOrigin,
  ensureSessionsDir,
  loadSessionState,
  NO_SESSION,
  saveSessionState,
  SESSIONS_DIR,
  sessionStatePath,
} from "../../src/observer/origin.ts";
import { NO_EVIDENCE, type CaptureEvidence } from "../../src/observer/record.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mind-origin-"));
  scratch.push(dir);
  return dir;
}

function evidence(parts: Partial<CaptureEvidence>): CaptureEvidence {
  return { ...NO_EVIDENCE, ...parts };
}

describe("deriveOrigin", () => {
  test("the vendor's own word for a person at the keyboard", () => {
    expect(deriveOrigin(evidence({ promptSource: "user" }))).toBe("owner-prompted");
  });

  test("every machine word claude 2.1.278 can send is `unattended`", () => {
    for (const source of ["sdk", "system", "loop_wakeup", "schedule_wakeup", "poll_event"]) {
      expect(deriveOrigin(evidence({ promptSource: source })), source).toBe("unattended");
    }
  });

  test("a subagent is the fleet, whatever the session started as", () => {
    expect(deriveOrigin(evidence({ promptSource: "user", subagent: true }))).toBe("subagent");
  });

  test("no word at all is `unknown`, and is never folded into the owner", () => {
    expect(deriveOrigin(NO_EVIDENCE)).toBe("unknown");
    // The vendor's schema says the field may be absent while it rolls out, so
    // this is the *common* case on some releases, not a corner.
    expect(deriveOrigin(evidence({ permissionMode: "default" }))).toBe("unknown");
  });

  test("a word from a future release is `unknown`, not a guess in the owner's favour", () => {
    expect(deriveOrigin(evidence({ promptSource: "voice" }))).toBe("unknown");
    expect(deriveOrigin(evidence({ promptSource: "USER" }))).toBe("unknown");
  });

  test("a session with human turns does not make one action the owner's", () => {
    // The thing the transcripts *could* have told us, and deliberately not what
    // this field means. "Somebody typed in this session" is a session fact; the
    // agent proposing something ten tool calls later is not the owner's doing.
    expect(deriveOrigin(evidence({ humanTurnsInSession: 12 }))).toBe("unknown");
  });
});

describe("session state — one process per hook firing", () => {
  test("it round-trips, and a missing file is `nothing is known`", async () => {
    const dir = await sandbox();
    await ensureSessionsDir(dir);
    const path = sessionStatePath(dir, "sess-1");

    expect(await loadSessionState(path)).toEqual(NO_SESSION);

    await saveSessionState(path, {
      promptSource: "user",
      permissionMode: "default",
      humanTurns: 3,
      lastPromptAt: "2026-09-21T10:00:00.000Z",
    });
    const read = await loadSessionState(path);
    expect(read.promptSource).toBe("user");
    expect(read.humanTurns).toBe(3);
  });

  test("a torn file degrades to `unknown`, not to a wrong answer", async () => {
    const dir = await sandbox();
    await ensureSessionsDir(dir);
    const path = sessionStatePath(dir, "sess-1");
    await Bun.write(path, '{"promptSource": "us');

    const read = await loadSessionState(path);
    expect(read).toEqual(NO_SESSION);
    expect(deriveOrigin({ ...NO_EVIDENCE, promptSource: read.promptSource })).toBe("unknown");
  });

  test("a file holding the wrong shape is also `nothing is known`", async () => {
    const dir = await sandbox();
    await ensureSessionsDir(dir);
    const path = sessionStatePath(dir, "sess-1");

    for (const content of ["[]", '"a string"', "null", '{"humanTurns": -4}']) {
      await Bun.write(path, content);
      const read = await loadSessionState(path);
      expect(read.promptSource).toBe(null);
      expect(read.humanTurns).toBe(0);
    }
  });

  test("the file is named by a hash, so a session id cannot become a path", async () => {
    const dir = await sandbox();
    const nasty = sessionStatePath(dir, "../../../etc/passwd");
    expect(nasty.startsWith(join(dir, SESSIONS_DIR))).toBe(true);
    expect(nasty).not.toContain("..");
    expect(nasty).not.toContain("passwd");

    // Two different ids, two different files; the same id twice, the same file.
    expect(sessionStatePath(dir, "a")).not.toBe(sessionStatePath(dir, "b"));
    expect(sessionStatePath(dir, "a")).toBe(sessionStatePath(dir, "a"));
  });

  test("saving creates no directory — a hook must never rebuild a purged tree", async () => {
    const dir = await sandbox();
    await ensureSessionsDir(dir);
    const path = sessionStatePath(dir, "sess-1");
    await saveSessionState(path, { ...NO_SESSION, humanTurns: 1 });
    expect(await Bun.file(path).exists()).toBe(true);

    // The purge, in miniature.
    await rm(join(dir, SESSIONS_DIR), { recursive: true, force: true });

    // The control for the assertion below: without it, "the directory is gone"
    // would also be what a save that silently did nothing produces.
    let threw = false;
    await saveSessionState(path, { ...NO_SESSION, humanTurns: 2 }).catch(() => {
      threw = true;
    });
    expect(threw).toBe(true);
    expect(await Bun.file(path).exists()).toBe(false);
  });
});
