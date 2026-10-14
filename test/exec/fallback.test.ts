/**
 * The fallback chain, tested without forking anything (S2.1 AC4).
 *
 * The CLI-level test for AC6 spawns a real `mind turn` against real stubs,
 * which is the right test for "does this work end to end" and the wrong one
 * for "what does the chain do when the second backend exits 0 empty" — a
 * subprocess does not appear in the coverage report, and arranging six
 * different miss shapes through the filesystem is slower and less exact than
 * saying so in a fake. So the fakes here are the seam AC4 asks for, and the
 * fakes are also what let the last case below exist at all: a chain where
 * every member misses, asserted to invent nothing.
 */

import { describe, expect, test } from "bun:test";
import type { Availability, ExecBackend, TurnRequest, TurnResult } from "../../src/exec/backend.ts";
import { fallbackTrail, FallbackExec } from "../../src/exec/fallback.ts";
import { subjectId, type Confidence, type Usage } from "../../src/types.ts";
import { RESTRAINED } from "../support/restraint.ts";

interface FakeOptions {
  readonly id: string;
  /** false means `available()` says no, so `run` must never be called. */
  readonly ready?: boolean;
  readonly detail?: string;
  readonly confidence?: Confidence;
  readonly text?: string;
  readonly identityStrength?: ExecBackend["identityStrength"];
  readonly usage?: Usage;
}

/** A backend that does exactly what the test says and records what it saw. */
function fake(options: FakeOptions): ExecBackend & { readonly seen: TurnRequest[] } {
  const seen: TurnRequest[] = [];
  const ready = options.ready ?? true;
  const confidence = options.confidence ?? "confirmed";
  return {
    seen,
    id: options.id,
    display: `Fake ${options.id}`,
    kind: "cli",
    identityStrength: options.identityStrength ?? "system",
    available(): Promise<Availability> {
      return Promise.resolve({ ok: ready, detail: options.detail ?? `${options.id}: fake` });
    },
    run(request: TurnRequest): Promise<TurnResult> {
      seen.push(request);
      return Promise.resolve({
        backend: options.id,
        text: options.text ?? `${options.id} answered`,
        confidence,
        identityStrength: options.identityStrength ?? "system",
        evidence: {
          source: options.id,
          prompt: request.prompt,
          raw: `raw from ${options.id}`,
          ...(options.usage === undefined ? {} : { usage: options.usage }),
        },
      });
    },
  };
}

const REQUEST: TurnRequest = {
  subject: subjectId("example"),
  prompt: "what is the capital of nowhere",
  system: "# Example Keeper\n\nsoul text",
  restraint: RESTRAINED,
};

describe("FallbackExec", () => {
  test("the first backend answers, and nothing is added to its evidence", async () => {
    const first = fake({ id: "first" });
    const second = fake({ id: "second" });

    const result = await new FallbackExec([first, second]).run(REQUEST);

    expect(result.backend).toBe("first");
    expect(result.text).toBe("first answered");
    // No trail, because there were no misses. A chain that always prefixed
    // something would make "it worked on the first try" unreadable.
    expect(result.evidence.raw).toBe("raw from first");
    expect(fallbackTrail(result.evidence.raw)).toBeUndefined();
    expect(second.seen.length).toBe(0);
  });

  test("the counts that come up the chain are the answering backend's, alone", async () => {
    // A chain is not a backend and does not have a bill. Summing what the
    // silent attempt spent into what the answering one spent would add two
    // vendors' tokenizers together and report the result as one number.
    const silent = fake({
      id: "claude",
      confidence: "silent",
      text: "",
      usage: { status: "reported", input: 7, output: 0, total: null },
    });
    const answered = fake({
      id: "ollama",
      usage: { status: "reported", input: 15, output: 24, total: null },
    });

    const result = await new FallbackExec([silent, answered]).run(REQUEST);

    expect(result.evidence.usage).toEqual({
      status: "reported",
      input: 15,
      output: 24,
      total: null,
    });
    // The miss is still on the record, where the ledger's own line for
    // `claude` holds the 7 it spent saying nothing.
    expect(fallbackTrail(result.evidence.raw)).toBe("claude: silent");
  });

  test("a chain where everything missed reports the last attempt's counts, and invents none", async () => {
    const withCounts = fake({
      id: "claude",
      confidence: "silent",
      text: "",
      usage: { status: "reported", input: 7, output: 0, total: null },
    });
    const missed = await new FallbackExec([withCounts]).run(REQUEST);
    expect(missed.evidence.usage).toEqual({ status: "reported", input: 7, output: 0, total: null });

    // And a chain that reached nothing at all says nothing rather than zero:
    // no backend was handed the prompt, so there is no turn to account for.
    const none = await new FallbackExec([fake({ id: "claude", ready: false })]).run(REQUEST);
    expect(none.evidence.usage).toBeUndefined();
  });

  test("an unavailable backend is skipped, named, and never run", async () => {
    const off = fake({ id: "claude", ready: false, detail: "claude: not on PATH" });
    const local = fake({ id: "ollama" });

    const result = await new FallbackExec([off, local]).run(REQUEST);

    expect(result.backend).toBe("ollama");
    // The whole of AC6 in one assertion: the vendor was *tried* and found
    // missing, which is a different report from having been left out.
    expect(fallbackTrail(result.evidence.raw)).toBe("claude: unavailable (claude: not on PATH)");
    expect(off.seen.length).toBe(0);
  });

  test("a backend that exits 0 with nothing is a miss — the case `||` cannot see", async () => {
    const quiet = fake({ id: "claude", confidence: "silent", text: "" });
    const local = fake({ id: "ollama" });

    const result = await new FallbackExec([quiet, local]).run(REQUEST);

    expect(result.backend).toBe("ollama");
    expect(result.text).toBe("ollama answered");
    expect(fallbackTrail(result.evidence.raw)).toBe("claude: silent");
    expect(quiet.seen.length).toBe(1);
  });

  test("a backend that failed the task is also a miss", async () => {
    // Named `judge` rather than after a real vendor on purpose. No backend
    // Mind ships returns `failed` — `cli-exec.ts` and `ollama-exec.ts` both
    // can only say `confirmed` or `silent`, because neither knows what was
    // asked. But `FallbackExec` takes any `ExecBackend`, including one that
    // wraps a caller which *can* judge content, so the chain still has to
    // count `failed` as a miss. A fake wearing a shipped vendor's id would
    // have quietly recorded a behaviour that vendor does not have.
    const broken = fake({ id: "judge", confidence: "failed", text: "could not" });
    const local = fake({ id: "ollama" });

    const result = await new FallbackExec([broken, local]).run(REQUEST);

    expect(result.backend).toBe("ollama");
    expect(fallbackTrail(result.evidence.raw)).toBe("judge: failed");
  });

  test("`partial` counts as an answer — the chain does not judge content", async () => {
    const hedged = fake({ id: "claude", confidence: "partial", text: "probably nowhere" });
    const local = fake({ id: "ollama" });

    const result = await new FallbackExec([hedged, local]).run(REQUEST);

    expect(result.backend).toBe("claude");
    expect(result.confidence).toBe("partial");
    expect(local.seen.length).toBe(0);
  });

  test("when everything misses, the trail is complete and no answer is invented", async () => {
    const off = fake({ id: "claude", ready: false, detail: "claude: not on PATH" });
    const quiet = fake({ id: "codex", confidence: "silent", text: "" });
    // `judge`, for the reason above. This fake used to be `ollama` returning
    // `failed` with "no model given" — a shape the real `OllamaExec` no longer
    // produces, so the test was pinning a behaviour that had moved on.
    const broken = fake({ id: "judge", confidence: "failed", text: "could not" });

    const result = await new FallbackExec([off, quiet, broken]).run(REQUEST);

    expect(result.confidence).toBe("failed");
    expect(fallbackTrail(result.evidence.raw)).toBe(
      "all 3 backend(s) missed · claude: unavailable (claude: not on PATH) · codex: silent · judge: failed",
    );
    // The last real attempt is kept whole underneath the trail, so a human can
    // see the concrete failure rather than only Mind's summary of it.
    expect(result.evidence.raw).toContain("raw from judge");
    expect(result.backend).toBe("claude→codex→judge");
  });

  test("when nothing was even reachable, the result is silence with the reasons", async () => {
    const off = fake({ id: "claude", ready: false, detail: "claude: not on PATH" });
    const alsoOff = fake({ id: "codex", ready: false, detail: "codex: not on PATH" });

    const result = await new FallbackExec([off, alsoOff]).run(REQUEST);

    // Silence, not failure: nothing ran, so nothing can be said to have failed.
    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
    expect(result.identityStrength).toBe("none");
    expect(fallbackTrail(result.evidence.raw)).toBe(
      "all 2 backend(s) missed · claude: unavailable (claude: not on PATH) · codex: unavailable (codex: not on PATH)",
    );
  });

  test("the request reaches every backend unchanged — subject and system included", async () => {
    const quiet = fake({ id: "claude", confidence: "silent", text: "" });
    const local = fake({ id: "ollama" });

    await new FallbackExec([quiet, local]).run(REQUEST);

    // I-3: a chain may re-route a turn, but it may not rewrite whose turn it
    // is, and it may not hand the second backend a different identity.
    for (const member of [quiet, local]) {
      expect(member.seen.length).toBe(1);
      expect(member.seen[0]).toEqual(REQUEST);
    }
  });

  test("a request that names a model is refused before any step runs — it would reach every backend (D-142)", async () => {
    // One request goes to every step. A model on it would hand `qwen3:8b` to claude and price a line as a model
    // the step never ran; each step's model is bound to that step when it is built.
    const claude = fake({ id: "claude" });
    const local = fake({ id: "ollama" });
    const result = await new FallbackExec([claude, local]).run({ ...REQUEST, model: "qwen3:8b" });
    expect(result.confidence).toBe("silent");
    expect(result.text).toBe("");
    expect(result.evidence.raw).toContain("refused");
    expect(result.evidence.raw).toContain("would reach all 2 backend(s)");
    expect(claude.seen).toEqual([]);
    expect(local.seen).toEqual([]);
  });

  test("an empty chain is a programmer error, not a silent no-op", () => {
    expect(() => new FallbackExec([])).toThrow("at least one backend");
  });

  test("the reported id and display name the whole route that was configured", async () => {
    const chain = new FallbackExec([fake({ id: "claude" }), fake({ id: "ollama" })]);
    expect(chain.id).toBe("claude→ollama");
    expect(chain.display).toBe("Fake claude → Fake ollama");
    expect(new FallbackExec([fake({ id: "a" })], "named").id).toBe("named");

    // Availability reports every member either way, so "1 of 3 reachable" is
    // legible rather than collapsing to a boolean.
    const mixed = new FallbackExec([
      fake({ id: "claude", ready: false, detail: "not on PATH" }),
      fake({ id: "ollama", detail: "2 model(s)" }),
    ]);
    const availability = await mixed.available();
    expect(availability.ok).toBe(true);
    expect(availability.detail).toBe("claude: not on PATH · ollama: 2 model(s)");
  });

  test("identityStrength is the strongest the chain can offer, not the first", async () => {
    const weak = fake({ id: "codex", identityStrength: "user" });
    const strong = fake({ id: "ollama", identityStrength: "system" });
    expect(new FallbackExec([weak, strong]).identityStrength).toBe("system");
    expect(new FallbackExec([fake({ id: "x", identityStrength: "none" })]).identityStrength).toBe(
      "none",
    );
    await Promise.resolve();
  });
});

describe("fallbackTrail", () => {
  test("reads back only what the fallback wrote", () => {
    expect(fallbackTrail("plain output from a model")).toBeUndefined();
    expect(fallbackTrail("[fallback] claude: silent\n---\nthe answer")).toBe("claude: silent");
    expect(fallbackTrail("[fallback] all 1 backend(s) missed · ollama: failed")).toBe(
      "all 1 backend(s) missed · ollama: failed",
    );
  });
});
