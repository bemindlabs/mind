import { describe, expect, test } from "bun:test";
import {
  CLOUD_BACKENDS,
  cloudMembers,
  cloudOnlyProblem,
  cloudOnlyRequested,
  isCloudBackend,
} from "../../src/exec/cloud-only.ts";
import { PHASE_A_BACKENDS } from "../../src/exec/index.ts";
import { LOCAL_BACKENDS } from "../../src/exec/local-cli.ts";

describe("the cloud allowlist", () => {
  test("holds no local backend: not ollama, not a local CLI, not a `-cloud` model name", () => {
    for (const id of ["ollama", ...LOCAL_BACKENDS, "ollama-cloud", "qwen3-coder:480b-cloud", ""]) {
      expect(isCloudBackend(id), id).toBe(false);
    }
  });

  test("matches exactly: a prefix or a different case is not on it", () => {
    expect(isCloudBackend("claude")).toBe(true);
    expect(isCloudBackend("claude-local")).toBe(false);
    expect(isCloudBackend("Claude")).toBe(false);
    expect(isCloudBackend("claude ")).toBe(false);
  });

  test("every id in it is a plain name, so no pattern can widen it", () => {
    for (const id of CLOUD_BACKENDS) expect(id).toMatch(/^[a-z]+$/);
  });
});

describe("cloudOnlyProblem", () => {
  test("a chain of cloud backends has none", () => {
    expect(cloudOnlyProblem(["claude", "codex", "glm"])).toBeUndefined();
  });

  test("names each backend that is not cloud", () => {
    const one = cloudOnlyProblem(["claude", "ollama"]);
    expect(one).toContain("ollama is not one");
    const two = cloudOnlyProblem(["ollama", "claude-local"]);
    expect(two).toContain("ollama, claude-local are not one");
  });

  test("an empty chain is a problem, so nothing refills it from a default", () => {
    expect(cloudOnlyProblem([])).toContain("no backend");
  });
});

describe("cloudMembers", () => {
  test("the usual chain loses ollama and keeps the order", () => {
    expect(cloudMembers(PHASE_A_BACKENDS)).toEqual(["claude", "codex"]);
  });
});

describe("cloudOnlyRequested", () => {
  test("the flag or MIND_CLOUD_ONLY=1/true turns it on; nothing else does", () => {
    expect(cloudOnlyRequested(true, undefined)).toBe(true);
    expect(cloudOnlyRequested(false, "1")).toBe(true);
    expect(cloudOnlyRequested(false, "true")).toBe(true);
    for (const off of [undefined, "", "0", "false", "yes"]) expect(cloudOnlyRequested(false, off)).toBe(false);
  });
});
