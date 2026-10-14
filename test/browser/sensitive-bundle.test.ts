/**
 * The container's copy of D-153's sensitive-actions list (`docker/browser/sensitive.cjs`) is exactly
 * `src/decide/sensitive.ts`, bundled. The browser layer inside the container holds every action the list
 * flags; a stale copy would be a second, older list.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { classifyAction } from "../../src/decide/sensitive.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const BUNDLE = resolve(ROOT, "docker", "browser", "sensitive.cjs");
const HEADER_LINES = 4;

describe("docker/browser/sensitive.cjs", () => {
  test("is src/decide/sensitive.ts bundled, under its header", async () => {
    const built = await Bun.build({ entrypoints: [resolve(ROOT, "src", "decide", "sensitive.ts")], format: "cjs", target: "node" });
    expect(built.success).toBe(true);
    const expected = await built.outputs[0]!.text();
    const committed = await Bun.file(BUNDLE).text();
    const lines = committed.split("\n");
    expect(lines[0]).toStartWith("// GENERATED from src/decide/sensitive.ts");
    expect(lines.slice(HEADER_LINES).join("\n"), "regenerate docker/browser/sensitive.cjs (see its header)").toBe(expected);
  });

  test("and answers as the engine does", async () => {
    const bundled = (await import(BUNDLE)) as { classifyAction: typeof classifyAction };
    for (const action of [
      { kind: "type", origin: "https://x.example", valueClass: "password" as const, role: "textbox", text: "Password" },
      { kind: "click", origin: "https://x.example", role: "button", text: "Pay now" },
      { kind: "type", origin: "https://x.example", valueClass: "search" as const, role: "searchbox", text: "Search" },
      { kind: "teleport", origin: "https://x.example" },
    ]) {
      expect(bundled.classifyAction(action)).toEqual(classifyAction(action));
    }
  });
});
