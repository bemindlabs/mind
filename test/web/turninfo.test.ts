/**
 * The local/cloud rule a turn is labelled by (S12.4).
 *
 * The rule is one line — `ollama`, or an id ending in `-local` — and it is
 * exactly the line the owner reads as "this turn ran on my machine" vs "this
 * turn left my machine". A rule that short is cheap to keep; the cost of
 * getting it wrong is a badge that lies about I-6's whole question, so every
 * class of id the registry knows is pinned here, including the ids S12.1 adds
 * for the LiteLLM chain before that work has merged.
 */

import { describe, expect, test } from "bun:test";
import { isLocalBackend } from "../../src/web/turninfo.ts";

describe("isLocalBackend — the rule behind the local/cloud badge", () => {
  test("ollama runs on this machine", () => {
    expect(isLocalBackend("ollama")).toBe(true);
  });

  test("the S12.1 local chain ids run on this machine", () => {
    for (const id of ["claude-local", "grok-local"]) {
      expect(isLocalBackend(id), id).toBe(true);
    }
  });

  test("any other id is a cloud backend — the vendor CLIs and everything else", () => {
    for (const id of ["claude", "codex", "grok", "kimi", "gemini", "copilot", "ollama-cloud", "local", "claude-locally"]) {
      expect(isLocalBackend(id), id).toBe(false);
    }
  });
});
