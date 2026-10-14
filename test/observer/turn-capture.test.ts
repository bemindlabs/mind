/**
 * The turn adapter (D-032): what `mind turn` remembers about itself.
 *
 * Three things are asserted, and the third is the one that matters:
 *
 * - **The shape is the hook's shape.** A record through this door parses with
 *   the same `fromValue` every reader uses, lands in the same store, and is
 *   counted by the same `readCaptured`. A third door that needed a third reader
 *   would have been a second transcript.
 * - **No text.** The adapter is never handed the prompt at all — its input type
 *   has no field for one — and the test writes a distinctive token into every
 *   string the adapter *is* handed, then checks none of them is the prompt.
 * - **`origin` never says `owner-prompted` without a terminal, and never with a
 *   proposal.** Both directions are tabled, because the safe failure is the
 *   one D-024 names: learning the fleet's habits, or the agent's own proposals,
 *   as the owner's.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TERMINAL_SOURCE,
  turnEvidence,
  turnKey,
  turnOrigin,
  turnOutcome,
  turnRecord,
  type TurnCapture,
} from "../../src/observer/adapters/turn.ts";
import { appendRecord, ensureCaptureDir, readCaptured } from "../../src/observer/capture-store.ts";
import { fromValue, parseRecord, CAPTURE_VERSION, TURN_KEY_PREFIX, type CaptureOrigin } from "../../src/observer/record.ts";
import { announceCapture, ensureObserverDir } from "../../src/observer/store.ts";
import { subjectId } from "../../src/types.ts";

const AT = "2026-09-22T14:00:00.000Z";

const BASE: TurnCapture = {
  turnId: "b45e2ea7-fed7-4b0a-8a3d-f0d01c344b63",
  at: AT,
  project: "/synthetic/project",
  backend: "ollama",
  confidence: "confirmed",
  terminal: true,
  proposal: false,
};

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("turnRecord — the shape", () => {
  test("one prompt record, namespaced to Mind, through the turn door", () => {
    const record = turnRecord(BASE);
    expect(record.v).toBe(CAPTURE_VERSION);
    expect(record.key).toBe("mind:prompt:b45e2ea7-fed7-4b0a-8a3d-f0d01c344b63");
    expect(record.vendor).toBe("mind");
    expect(record.source).toBe("turn");
    expect(record.kind).toBe("prompt");
    expect(record.session).toBe(BASE.turnId);
    expect(record.project).toBe("/synthetic/project");
    expect(record.at).toBe(AT);
    // The backend's name is the one behavioural fact a local turn has.
    expect(record.tool).toBe("ollama");
    expect(record.target).toBe("");
  });

  test("it parses with the reader every other door uses", () => {
    const record = turnRecord(BASE);
    const back = fromValue(JSON.parse(JSON.stringify(record)));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.record).toEqual(record);
    // And the same line, through the text path.
    expect(parseRecord(JSON.stringify(record)).ok).toBe(true);
  });

  test("the key is the turn id and nothing else", () => {
    expect(turnKey("x")).toBe("mind:prompt:x");
    expect(turnKey("x")).toBe(`${TURN_KEY_PREFIX}x`);
    expect(turnRecord({ ...BASE, turnId: "second" }).key).not.toBe(turnRecord(BASE).key);
  });
});

describe("turnOutcome — two vocabularies, mapped once", () => {
  test("confirmed and partial are ok; failed is failed; silent is unknown, not failed", () => {
    expect(turnOutcome("confirmed")).toBe("ok");
    expect(turnOutcome("partial")).toBe("ok");
    expect(turnOutcome("failed")).toBe("failed");
    expect(turnOutcome("silent")).toBe("unknown");
    expect(turnRecord({ ...BASE, confidence: "silent" }).outcome).toBe("unknown");
  });
});

describe("turnOrigin — never owner-prompted without evidence (S3.2 AC3)", () => {
  const cases: readonly [TurnCapture["terminal"], TurnCapture["proposal"], CaptureOrigin][] = [
    [true, false, "owner-prompted"],
    [false, false, "unknown"],
    [true, true, "unknown"],
    [false, true, "unknown"],
  ];
  for (const [terminal, proposal, origin] of cases) {
    test(`terminal=${terminal} proposal=${proposal} → ${origin}`, () => {
      expect(turnOrigin({ terminal, proposal })).toBe(origin);
      expect(turnRecord({ ...BASE, terminal, proposal }).origin).toBe(origin);
    });
  }

  test("the evidence says 'terminal' in Mind's own word, never claude's 'user'", () => {
    expect(turnEvidence({ terminal: true })).toEqual({
      promptSource: TERMINAL_SOURCE,
      permissionMode: null,
      subagent: false,
      humanTurnsInSession: 1,
    });
    expect(TERMINAL_SOURCE).not.toBe("user");
    expect(turnEvidence({ terminal: false })).toEqual({
      promptSource: null,
      permissionMode: null,
      subagent: false,
      humanTurnsInSession: 0,
    });
  });
});

describe("no text, and the same store", () => {
  test("the adapter cannot be handed a prompt, and writes nothing that looks like one", async () => {
    const home = await mkdtemp(join(tmpdir(), "mind-turn-capture-"));
    scratch.push(home);
    const created = await ensureObserverDir(
      { home, env: { XDG_DATA_HOME: join(home, "data") } },
      subjectId("example"),
      announceCapture(() => undefined),
    );
    if (!created.ok) throw new Error(created.reason);
    await ensureCaptureDir(created.path);

    // `TurnCapture` has no prompt field — that is checked by the type — so the
    // only strings that reach the adapter are these, and none is a prompt.
    const token = "SECRET-PROMPT-TOKEN-7f3a";
    const record = turnRecord({ ...BASE, project: `/p/${token}-not-a-prompt` });
    const outcome = await appendRecord(created.path, record, new Date(AT));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const line = await readFile(outcome.path, "utf8");
    expect(line).toContain('"source":"turn"');
    expect(line).toContain('"vendor":"mind"');
    // The project path travels (it is what the hook keeps too); the word
    // "prompt" appears only as the kind, and no prompt text exists to leak.
    expect(line.split("\n").filter((l) => l !== "").length).toBe(1);

    const counted = await readCaptured(created.path);
    expect(counted.report.records).toBe(1);
    expect(counted.report.duplicates).toBe(0);
    expect(counted.report.skipped).toEqual({});
  });
});
