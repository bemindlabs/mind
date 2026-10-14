/**
 * D-163 / Q4-D2 option A: a turn on a backend that is not kernel-fenced is held at write 1 and run 1.
 *
 * What is pinned here: every vendor CLI is capped and the two local ones are not; the answer comes from the
 * backend's own `appliesFence` (not a list of names); a backend that says nothing is capped; and the cap is
 * a reduction — it can never raise a level.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROPOSAL_FENCE } from "../../src/decide/agent-proposal.ts";
import { effectiveDial } from "../../src/decide/effective.ts";
import type { Level, ReachLevel } from "../../src/decide/autonomy.ts";
import type { ExecBackend, TurnRequest, TurnResult } from "../../src/exec/backend.ts";
import { CappedExec, HELD_AT_ONE_TASK, capLine, capRequest, capSurvey, runsFenced } from "../../src/exec/cap.ts";
import { CliExec } from "../../src/exec/cli-exec.ts";
import { LOCAL_BACKENDS, localCliBackend } from "../../src/exec/local-cli.ts";
import { VENDORS } from "../../src/exec/registry.ts";
import { capRestraint, restrain, UNFENCED_CAP_LEVEL } from "../../src/exec/restraint.ts";
import { subjectId } from "../../src/types.ts";
import { atLevel, LOOSENED, RESTRAINED } from "../support/restraint.ts";

const SUBJECT = subjectId("example");

function request(restraint = LOOSENED, extra: Partial<TurnRequest> = {}): TurnRequest {
  return { subject: SUBJECT, prompt: "hello", restraint, ...extra };
}

/** A backend invented for this test. It says nothing about a fence, as a new backend would not. */
class NewBackend implements ExecBackend {
  readonly id = "brand-new";
  readonly display = "Brand new";
  readonly kind = "cli" as const;
  readonly identityStrength = "none" as const;
  seen: TurnRequest | undefined;
  async available() {
    return { ok: true, detail: "fake" };
  }
  async run(req: TurnRequest): Promise<TurnResult> {
    this.seen = req;
    return { backend: this.id, text: "ok", confidence: "confirmed", identityStrength: "none", evidence: { source: this.id, prompt: req.prompt, raw: "" } };
  }
}

/** The same, but able to prove its own fence. */
class ProvenFence extends NewBackend {
  appliesFence(req: TurnRequest): boolean {
    return req.fence !== undefined;
  }
}

describe("which backends are capped — asked of the backend, per request", () => {
  test("every vendor CLI is capped at the loosened dial, and the cap is write 1 / run 1 (act 1)", () => {
    for (const spec of VENDORS) {
      const asked = capRequest(new CliExec(spec), request());
      expect(asked.note).toBeDefined();
      expect(asked.request.restraint.loosened).toBe(false);
      expect(asked.request.restraint.act).toBe(UNFENCED_CAP_LEVEL);
      expect(asked.request.restraint.unfenced).toBe(false);
      expect(asked.note).toContain(spec.id);
    }
  });

  test("the local CLIs, which run inside the D-118 fence, keep the dial — the request is untouched", () => {
    for (const id of LOCAL_BACKENDS) {
      const req = request();
      const asked = capRequest(localCliBackend(id), req);
      expect(asked.note).toBeUndefined();
      expect(asked.request).toBe(req);
      expect(runsFenced(localCliBackend(id), req)).toBe(true);
    }
  });

  test("a vendor CLI is fenced exactly when the request carries the fence its run() applies", () => {
    const cli = new CliExec(VENDORS[0]!);
    expect(cli.appliesFence(request())).toBe(false);
    expect(cli.appliesFence(request(LOOSENED, { fence: { writable: [], tcpPorts: [] } }))).toBe(true);
  });

  test("a new backend that says nothing is capped by default (fail closed)", () => {
    const fake = new NewBackend();
    const asked = capRequest(fake, request());
    expect(asked.note).toBeDefined();
    expect(asked.request.restraint.loosened).toBe(false);
  });

  test("a backend that proves its fence keeps the dial", () => {
    const fake = new ProvenFence();
    const req = request(LOOSENED, { fence: { writable: [], tcpPorts: [] } });
    expect(capRequest(fake, req).note).toBeUndefined();
    expect(capRequest(fake, request()).note).toBeDefined();
  });

  test("an invented backend that merely claims a fence by name is not believed: the answer is per request", () => {
    class Liar extends NewBackend {
      readonly id2 = "claude-local";
    }
    expect(capRequest(new Liar(), request()).note).toBeDefined();
  });
});

describe("the wrapper", () => {
  test("hands the inner backend the lowered restraint, says so out loud, and marks the result", async () => {
    const inner = new NewBackend();
    const said: string[] = [];
    const result = await new CappedExec(inner, (line) => said.push(line)).run(request());
    expect(inner.seen?.restraint.loosened).toBe(false);
    expect(inner.seen?.restraint.act).toBe(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("held at write 1 and run 1");
    expect(said[0]).toContain("temporary");
    expect(said[0]).toContain("D-163");
    expect(result.capped).toBe(said[0]!);
  });

  test("a held turn is told it is at level 1: the propose instruction is added once, and only when capped", async () => {
    const inner = new NewBackend();
    await new CappedExec(inner, undefined, "PROPOSE").run(request(LOOSENED, { system: "soul" }));
    expect(inner.seen?.system).toBe("soul\n\nPROPOSE");
    await new CappedExec(inner, undefined, "PROPOSE").run(request(LOOSENED, { system: "soul\n\nPROPOSE" }));
    expect(inner.seen?.system).toBe("soul\n\nPROPOSE");
    await new CappedExec(inner, undefined, "PROPOSE").run(request(LOOSENED));
    expect(inner.seen?.system).toBe("PROPOSE");
    await new CappedExec(inner, undefined, "PROPOSE").run(request(RESTRAINED, { system: "soul" }));
    expect(inner.seen?.system).toBe("soul");
  });

  test("a capped task step is told it is read only, and to say what it could not do instead of reporting done", async () => {
    const inner = new NewBackend();
    await new CappedExec(inner, undefined, HELD_AT_ONE_TASK).run(request(LOOSENED, { system: "step" }));
    expect(inner.seen?.system).toContain("could NOT do");
    expect(inner.seen?.system).toContain('"done": false');
    // A task step is never shown how to file a proposal.
    expect(inner.seen?.system).not.toContain(PROPOSAL_FENCE);
  });

  test("a backend with no tools is capped without a word: nothing said, nothing marked, nothing added to the prompt", async () => {
    const inner = new NewBackend();
    const said: string[] = [];
    const result = await new CappedExec(inner, (line) => said.push(line), "PROPOSE", true).run(request(LOOSENED, { system: "soul" }));
    expect(inner.seen?.restraint.loosened).toBe(false);
    expect(inner.seen?.system).toBe("soul");
    expect(said).toEqual([]);
    expect(result.capped).toBeUndefined();
  });

  test("a turn that was not loosened passes through as the very same request, unmarked", async () => {
    const inner = new NewBackend();
    const req = request(RESTRAINED);
    const result = await new CappedExec(inner).run(req);
    expect(inner.seen).toBe(req);
    expect(result.capped).toBeUndefined();
  });

  test("a fenced backend behind the wrapper is not capped", async () => {
    const inner = new ProvenFence();
    const req = request(LOOSENED, { fence: { writable: [], tcpPorts: [] } });
    const result = await new CappedExec(inner).run(req);
    expect(inner.seen).toBe(req);
    expect(result.capped).toBeUndefined();
  });

  test("it carries the wrapped backend's identity and fence answer", () => {
    const inner = new ProvenFence();
    const wrapped = new CappedExec(inner);
    expect([wrapped.id, wrapped.display, wrapped.kind, wrapped.identityStrength]).toEqual([inner.id, inner.display, inner.kind, inner.identityStrength]);
    expect(wrapped.appliesFence(request())).toBe(false);
  });

  test("the turn path wraps every backend it builds in CappedExec (nothing is handed to a recorder bare)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "bin", "commands", "turn.ts"), "utf8");
    expect(source).toContain("new CappedExec(raw");
    expect(source).toContain("new RecordingExec(guarded");
    expect(source).not.toContain("new RecordingExec(raw");
  });
});

describe("the cap never raises a level", () => {
  const levels: Level[] = [0, 1, 2, 3];
  test("for every combination of write, run and reach: act never goes up, and a turn that was not loosened is the same object", () => {
    for (const write of levels) {
      for (const run of levels) {
        for (const reach of [0, 1, 2] as ReachLevel[]) {
          const restraint = restrain(
            effectiveDial({
              stored: { read: 1, write, run, reach, operate: 0, setBy: null, setAt: null },
              source: "file",
              envValue: undefined,
              stopped: false,
              confirmedThree: ["write", "run"],
            }),
          );
          const capped = capRestraint(restraint);
          expect(capped.act).toBeLessThanOrEqual(restraint.act);
          expect(capped.operate).toBe(restraint.operate);
          expect(capped.loosened).toBe(false);
          expect(capped.unfenced).toBe(false);
          if (!restraint.loosened) expect(capped).toBe(restraint);
          // Capping twice is capping once.
          expect(capRestraint(capped)).toBe(capped);
        }
      }
    }
  });

  test("level 0 stays 0 and level 1 stays 1", () => {
    expect(capRestraint(atLevel(0)).act).toBe(0);
    expect(capRestraint(atLevel(1)).act).toBe(1);
  });

  test("level 3 (unfenced) is lowered all the way, not to 2", () => {
    const three = atLevel(3);
    expect(three.unfenced).toBe(true);
    const capped = capRestraint(three);
    expect(capped.act).toBe(1);
    expect(capped.unfenced).toBe(false);
  });
});

describe("what the cloud vendors are handed once capped", () => {
  test("the argv of a capped loosened turn is the argv of a level-1 turn, for every vendor", () => {
    for (const spec of VENDORS) {
      const argvAt = (restraint: TurnRequest["restraint"]) => spec.headlessArgv({ prompt: "p", restraint });
      expect(argvAt(capRestraint(LOOSENED))).toEqual(argvAt(RESTRAINED));
    }
  });
});

describe("doctor's survey", () => {
  const build = (id: string): ExecBackend => (id === "brand-new" ? new NewBackend() : id === "claude-local" || id === "grok-local" ? localCliBackend(id) : new CliExec(VENDORS.find((v) => v.id === id)!));
  test("lists the capped and the fenced, and nothing when the dial is not loosened", () => {
    const ids = ["claude", "codex", "brand-new", "claude-local"];
    const loosened = capSurvey(ids, LOOSENED, build, SUBJECT);
    expect(loosened.capped).toEqual(["claude", "codex", "brand-new"]);
    expect(loosened.fenced).toEqual(["claude-local"]);
    expect(capSurvey(ids, RESTRAINED, build, SUBJECT)).toEqual({ capped: [], fenced: [] });
    expect(capLine(capSurvey(ids, RESTRAINED, build, SUBJECT))).toBeUndefined();
    expect(capLine(loosened)).toBe("capped at write/run 1 (not kernel-fenced, D-163): claude, codex, brand-new · keep the dial (fenced): claude-local");
    expect(capLine({ capped: [], fenced: ["claude-local"] })).toContain("capped at write/run 1 (not kernel-fenced, D-163): none");
  });
});
