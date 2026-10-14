/**
 * S2.1 AC5 — a `NativeExec` fits `ExecBackend` as the trait stands (D-002).
 *
 * Nothing in `src/` runs inference in-process yet, and D-002 says it should not
 * until there is a measured need. What this file proves is the other half of
 * that decision: the day it arrives, it arrives as one more `ExecBackend` — no
 * method changes shape, and the fallback chain, the recorder and the
 * restraint all take it as they take every other backend. `tsc` compiling this
 * file (the project's `include` has `test`) is half the proof; running it
 * through the chain is the other half.
 */

import { describe, expect, test } from "bun:test";
import type { Availability, ExecBackend, TurnRequest, TurnResult } from "../../src/exec/backend.ts";
import { FallbackExec } from "../../src/exec/fallback.ts";
import { probeRestraint } from "../../src/exec/restraint.ts";
import { subjectId } from "../../src/types.ts";

/** The stub. Every member is what `ExecBackend` already asks for, and nothing more. */
class NativeExec implements ExecBackend {
  readonly id = "native";
  readonly display = "in-process model (stub)";
  readonly kind = "native" as const;
  readonly identityStrength = "system" as const;
  received: TurnRequest[] = [];

  async available(): Promise<Availability> {
    return { ok: true, detail: "stub: nothing is loaded" };
  }

  async run(request: TurnRequest): Promise<TurnResult> {
    this.received.push(request);
    const raw = request.system === undefined ? "no identity" : "identity carried";
    return {
      backend: this.id,
      text: raw,
      confidence: "confirmed",
      evidence: { source: this.id, prompt: request.prompt, raw },
      identityStrength: request.system === undefined ? "none" : "system",
    };
  }
}

/** A backend that is never there, to show the stub is reached by fallback. */
const absent: ExecBackend = {
  id: "absent",
  display: "absent",
  kind: "cli",
  identityStrength: "user",
  available: async () => ({ ok: false, detail: "not installed" }),
  run: async (request) => ({
    backend: "absent",
    text: "",
    confidence: "silent",
    evidence: { source: "absent", prompt: request.prompt, raw: "" },
    identityStrength: "none",
  }),
};

describe("S2.1 AC5 — NativeExec against the trait as it is", () => {
  test("it is an ExecBackend, and the chain falls through to it with the system field intact", async () => {
    const native = new NativeExec();
    const chain = new FallbackExec([absent, native]);
    const result = await chain.run({
      subject: subjectId("example"),
      prompt: "hello",
      system: "# identity",
      restraint: probeRestraint(),
    });

    expect(result.confidence).toBe("confirmed");
    expect(result.text).toBe("identity carried");
    expect(native.received.length).toBe(1);
    expect(native.received[0]!.system).toBe("# identity");
    expect(native.kind).toBe("native");
  });

  test("its readiness check answers without running a turn", async () => {
    const native = new NativeExec();
    expect((await native.available()).ok).toBe(true);
    expect(native.received).toEqual([]);
  });
});
